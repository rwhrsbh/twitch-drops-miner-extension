// node --test tests/  — прогон lib/kick.js на подставных chrome/fetch/WebSocket.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const tabs = { created: [], removed: [], updated: [] };
const calls = [];
let cookie = "abc%7Cdef";
let net = {};
const sockets = [];

globalThis.chrome = {
  runtime: { id: "extid" },
  cookies: { get: async () => (cookie ? { value: cookie } : null) },
  storage: {
    local: {
      get: async (k) => (typeof k === "string" ? { [k]: store.local[k] } : { ...store.local }),
      set: async (o) => Object.assign(store.local, o),
    },
    session: {
      get: async (k) => ({ [k]: store.session[k] }),
      set: async (o) => Object.assign(store.session, o),
      remove: async (k) => delete store.session[k],
    },
  },
  tabs: {
    create: async (o) => { tabs.created.push(o); return { id: 7 }; },
    query: async () => tabs.list || [],
    update: async (id, o) => { tabs.updated.push([id, o]); },
    remove: async (id) => { tabs.removed.push(id); },
    get: async (id) => ({ id, url: "https://kick.com/old" }),
  },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
};
globalThis.__hookToken = "";
globalThis.chrome.scripting = { executeScript: async () => [{ result: globalThis.__hookToken }] };
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(x) { this.sent.push(JSON.parse(x)); }
  close() { this.readyState = 3; }
};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const hit = Object.entries(net).find(([key]) => String(url).includes(key));
  if (!hit) return new Response("{}", { status: 404 });
  const [, value] = hit;
  const out = typeof value === "function" ? value(init) : value;
  return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200 });
};

const kick = await import("../lib/kick.js");
const settings = await import("../lib/settings.js");

const campaign = (o = {}) => ({
  id: "c1", name: "Rust Drops", status: "active", category: { id: 13, name: "Rust" },
  channels: [], rewards: [{ id: "r1", name: "Skin", required_units: 120, progress: 0.5, claimed: false }], ...o,
});

async function settle() {
  await kick.kickSettled();
}

async function resetAsync() {
  await settle();
  reset();
}

function reset() {
  store.local = { settings: { autoAll: true, blacklist: [], picked: [] } }; store.session = {}; sockets.length = 0; calls.length = 0;
  tabs.created.length = tabs.removed.length = tabs.updated.length = 0;
  kick.stopWatch();
  kick.resetClientToken();
  tabs.list = [{ id: 3, url: "https://kick.com/x" }];
  globalThis.__hookToken = "";
  cookie = "abc%7Cdef";
  net = {
    "viewer/v1/token": { data: { token: "viewer1" } },
    "kick.com/api/v1/user": { username: "me" },
    "drops/campaigns": { data: [campaign()] },
    "drops/progress": { data: [] },
    "livestreams": { data: { livestreams: [{ id: 99, channel: { id: 5, slug: "streamer" } }] } },
  };
}

test("no cookie -> need-login", async () => {
  await resetAsync(); cookie = "";
  const s = await kick.kickTick();
  assert.equal(s.phase, "need-login");
});

test("starts WS, uses decoded Bearer first, sends handshake+watch on open", async () => {
  await resetAsync();
  const s = await kick.kickTick();
  assert.equal(s.phase, "watching");
  assert.equal(s.watching.login, "streamer");
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /viewer\/v1\/connect\?token=viewer1/);
  const tokenCall = calls.find((c) => c.url.includes("viewer/v1/token"));
  assert.equal(tokenCall.init.headers.Authorization, "Bearer abc|def");
  sockets[0].readyState = 1; sockets[0].onopen();
  assert.deepEqual(sockets[0].sent.map((m) => m.type), ["channel_handshake", "user_event"]);
  assert.equal(sockets[0].sent[1].data.message.livestream_id, 99);
  kick.stopWatch();
});

test("claims finished reward", async () => {
  await resetAsync();
  net["drops/progress"] = { data: [{ id: "c1", rewards: [{ id: "r1", progress: 1, claimed: false }] }] };
  net["drops/claim"] = { message: "Success" };
  const s = await kick.kickTick();
  const claim = calls.find((c) => c.url.includes("drops/claim"));
  assert.ok(claim);
  assert.deepEqual(JSON.parse(claim.init.body), { reward_id: "r1", campaign_id: "c1" });
  assert.match(s.log[0].text, /kickClaimed/);
  kick.stopWatch();
});

test("blacklist filters campaign", async () => {
  await resetAsync();
  await settings.writeSettings({ blacklist: ["rust"] });
  const s = await kick.kickTick();
  assert.equal(s.queue.length, 0);
  assert.equal(sockets.length, 0);
  assert.equal(s.phase, "all-claimed");
});

test("exclusive channel needs live channel, else no-channel", async () => {
  await resetAsync();
  net["drops/campaigns"] = { data: [campaign({ channels: [{ slug: "chan" }, { slug: "other" }] })] };
  net["api/v2/channels/chan"] = { id: 3, livestream: null };
  let s = await kick.kickTick();
  assert.equal(s.phase, "no-channel");
  assert.deepEqual(s.queue[0].live, []);
  kick.resetClientToken(); // сброс кэша карточек
  net["api/v2/channels/chan"] = { id: 3, livestream: { id: 8, categories: [{ id: 13 }], viewer_count: 5 } };
  s = await kick.kickTick();
  assert.equal(s.phase, "watching");
  assert.equal(s.watching.login, "chan");
  assert.deepEqual(s.queue[0].live, ["chan"]);
  kick.stopWatch();
});

test("exclusive channel found by its card even when missing from the category list; most viewers first", async () => {
  await resetAsync();
  net["drops/campaigns"] = { data: [campaign({ channels: [{ slug: "small" }, { slug: "serpias" }] })] };
  net["livestreams"] = { data: { livestreams: [], pagination: {} } };
  net["api/v2/channels/small"] = { id: 1, livestream: { id: 10, categories: [{ id: 13 }], viewer_count: 3 } };
  net["api/v2/channels/serpias"] = { id: 2, livestream: { id: 20, categories: [{ id: 13 }], viewer_count: 900 } };
  const s = await kick.kickTick();
  assert.deepEqual(s.queue[0].live, ["serpias", "small"]);
  assert.equal(s.watching.login, "serpias");
  kick.stopWatch();
});

test("expired/upcoming campaigns skipped", async () => {
  await resetAsync();
  net["drops/campaigns"] = { data: [campaign({ status: "expired" }), campaign({ id: "c2", starts_at: "2999-01-01T00:00:00Z" }), campaign({ id: "c3", ends_at: "2000-01-01T00:00:00Z" })] };
  const s = await kick.kickTick();
  assert.equal(s.queue.length, 0);
});

test("disabled -> idle, no socket", async () => {
  await resetAsync();
  await kick.setKickEnabled(false);
  await settle();
  const s = await kick.readKick();
  assert.equal(s.enabled, false);
  assert.equal(sockets.length, 0);
  assert.equal(s.phase, "idle");
});

test("WS failure -> pinned muted fallback tab, closed when WS healthy", async () => {
  await resetAsync();
  await kick.kickTick();
  sockets[0].onerror();            // сокет упал, не открывшись
  await kick.kickTick();           // рестарт + вкладка
  assert.equal(tabs.created.length, 1);
  assert.equal(tabs.created[0].pinned, true);
  assert.equal(tabs.created[0].active, false);
  assert.match(tabs.created[0].url, /kick\.com\/streamer/);
  const second = sockets.at(-1);
  second.readyState = 1; second.onopen();
  await kick.kickTick();           // сокет живой -> вкладка закрыта
  assert.deepEqual(tabs.removed, [7]);
  kick.stopWatch();
});

test("API 403 while watching keeps tab; 401 -> need-login and closes tab", async () => {
  await resetAsync();
  await kick.kickTick();
  net["viewer/v1/token"] = { status: 403, body: {} };
  // Сайт шлёт тот же токен: обновлять нечего, остаёмся на запасной вкладке.
  globalThis.__hookToken = "e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823";
  await kick.kickTick();
  assert.equal(tabs.created.filter((tab) => /streamer/.test(tab.url)).length, 1);
  net["viewer/v1/token"] = { status: 401, body: {} };
  const s = await kick.kickTick();
  assert.equal(s.phase, "need-login");
  assert.ok(tabs.removed.includes(7));
});

test("disabling mid-tick is not overwritten by stale state", async () => {
  await resetAsync();
  const orig = net["drops/progress"];
  net["drops/progress"] = () => { store.local.kick = { ...store.local.kick, enabled: false }; return orig; };
  const s = await kick.kickTick();
  assert.equal(s.enabled, false);
  assert.equal(s.phase, "idle");
  assert.equal(s.watching, null);
});

const two = () => ({ data: [
  campaign({ id: "cA", name: "A", category: { id: 1, name: "Alpha", image_url: "https://files.kick.com/a" }, rewards: [{ id: "a1", name: "A1", required_units: 100, image_url: "drops/reward-image/a1.png" }] }),
  campaign({ id: "cB", name: "B", category: { id: 2, name: "Beta", image_url: "https://files.kick.com/b" }, rewards: [{ id: "b1", name: "B1", required_units: 100 }] }),
] });

test("manual mode without picked games farms nothing", async () => {
  await resetAsync(); net["drops/campaigns"] = two();
  await settings.writeSettings({ autoAll: false });
  const s = await kick.kickTick();
  assert.equal(s.phase, "pick-game");
  assert.equal(s.queue.length, 0);
  assert.equal(sockets.length, 0);
  assert.deepEqual(s.games.map((g) => g.name), ["Alpha", "Beta"]);
});

test("manual mode farms only picked game", async () => {
  await resetAsync(); net["drops/campaigns"] = two();
  await settings.writeSettings({ autoAll: false, picked: ["beta"] });
  const s = await kick.kickTick();
  assert.deepEqual(s.queue.map((r) => r.game), ["Beta"]);
  assert.equal(s.watching.game, "Beta");
  kick.stopWatch();
});

test("twitch whitelist name counts as picked on Kick", async () => {
  await resetAsync(); net["drops/campaigns"] = two();
  await settings.writeSettings({ autoAll: false });
  store.local.state = { whitelist: ["77"], games: [{ id: "77", name: "Alpha" }] };
  const s = await kick.kickTick();
  assert.deepEqual(s.queue.map((r) => r.game), ["Alpha"]);
  kick.stopWatch();
});

test("auto mode: picked game goes first, others follow, blacklist wins", async () => {
  await resetAsync(); net["drops/campaigns"] = two();
  await settings.writeSettings({ picked: ["Beta"] });
  let s = await kick.kickTick();
  assert.equal(s.watching.game, "Beta");
  kick.stopWatch();
  await resetAsync(); net["drops/campaigns"] = two();
  await settings.writeSettings({ picked: ["Beta"], blacklist: ["beta"] });
  s = await kick.kickTick();
  assert.equal(s.watching.game, "Alpha");
  kick.stopWatch();
});

test("unlinked campaign is not farmed, flagged not-linked", async () => {
  await resetAsync();
  net["drops/campaigns"] = { data: [campaign({ connect_url: "https://link.me" })] };
  const s = await kick.kickTick();
  assert.equal(s.phase, "not-linked");
  assert.equal(s.linkUrl, "https://link.me");
  assert.equal(sockets.length, 0);
});

test("images: reward from ext.kick.com, campaign art from category", async () => {
  await resetAsync(); net["drops/campaigns"] = two();
  const s = await kick.kickTick();
  const a = s.queue.find((r) => r.id === "a1");
  assert.equal(a.image, "https://ext.kick.com/drops/reward-image/a1.png");
  assert.equal(a.campaignImage, "https://files.kick.com/a");
  kick.stopWatch();
});

test("click on a drop makes it the target; falls back when it is finished", async () => {
  await resetAsync(); net["drops/campaigns"] = two();
  let s = await kick.kickTick();
  assert.equal(s.watching.game, "Alpha");
  await kick.watchKickDrop("b1");
  await settle();
  s = await kick.readKick();
  assert.equal(s.watching.dropId, "b1");
  assert.equal(s.preferDropId, "b1");
  s = await kick.kickTick();
  assert.equal(s.watching.dropId, "b1");          // выбор держится
  net["drops/progress"] = { data: [{ id: "cB", rewards: [{ id: "b1", progress: 1, claimed: true }] }] };
  s = await kick.kickTick();
  assert.equal(s.preferDropId, "");               // забран, выбор снят
  assert.equal(s.watching.dropId, "a1");
  kick.stopWatch();
});

test("clicked drop without a live channel is ignored, normal queue continues", async () => {
  await resetAsync();
  net["drops/campaigns"] = { data: [campaign({ id: "cX", channels: [{ slug: "nobody" }], rewards: [{ id: "x1", name: "X", required_units: 60 }] }), ...two().data] };
  await kick.watchKickDrop("x1");
  await settle();
  const s = await kick.readKick();
  assert.notEqual(s.watching?.dropId, "x1");
  assert.ok(s.watching);
  kick.stopWatch();
});

test("watch event uses numeric livestream id from the channel card, not the UUID from the list", async () => {
  await resetAsync();
  net["livestreams"] = { data: { livestreams: [{ id: "01a0-uuid", channel: { id: 5, slug: "streamer" } }], pagination: {} } };
  net["api/v2/channels/streamer"] = { id: 5, livestream: { id: 777, is_live: true } };
  await kick.kickTick();
  const socket = sockets.at(-1);
  socket.readyState = 1; socket.onopen();
  const event = socket.sent.find((m) => m.type === "user_event");
  assert.equal(event.data.message.livestream_id, 777);
  kick.stopWatch();
});

test("client token refreshed from kick.com tab when Kick starts rejecting", async () => {
  await resetAsync();
  globalThis.__hookToken = "ab".repeat(32);
  net["viewer/v1/token"] = (init) => (init.headers["X-Client-Token"] === "ab".repeat(32)
    ? { data: { token: "viewer2" } }
    : { status: 403, body: {} });
  const s = await kick.kickTick();
  assert.equal(s.phase, "watching");
  assert.equal(store.local.kickClientToken, "ab".repeat(32));
  kick.stopWatch();
});

test("channel that switched category is dropped and another is picked", async () => {
  await resetAsync();
  net["drops/campaigns"] = { data: [campaign({ category: { id: 10, name: "Minecraft" } })] };
  net["livestreams"] = { data: { livestreams: [
    { id: "u1", channel: { id: 1, slug: "gone" } },
    { id: "u2", channel: { id: 2, slug: "good" } },
  ], pagination: {} } };
  net["api/v2/channels/gone"] = { id: 1, livestream: { id: 11, categories: [{ id: 8549 }] } };
  net["api/v2/channels/good"] = { id: 2, livestream: { id: 22, categories: [{ id: 10 }] } };
  let s = await kick.kickTick();
  assert.equal(s.watching.login, "good");          // gone в IRL, не берём
  const socket = sockets.at(-1); socket.readyState = 1;
  net["api/v2/channels/good"] = { id: 2, livestream: { id: 22, categories: [{ id: 8549 }] } };
  net["api/v2/channels/gone"] = { id: 1, livestream: { id: 11, categories: [{ id: 10 }] } };
  s = await kick.kickTick();
  assert.equal(s.watching.login, "gone");          // good ушёл в IRL, переключились
  assert.match(s.log[1].text, /kickLeftCategory/);
  kick.stopWatch();
});

test("stall guard: no progress for 8 min -> other channel; still stuck -> player tab; progress -> tab closed", async () => {
  await resetAsync();
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    net["drops/campaigns"] = { data: [campaign({ category: { id: 13, name: "Rust" } })] };
    net["livestreams"] = { data: { livestreams: [
      { id: "u1", channel: { id: 1, slug: "one" } },
      { id: "u2", channel: { id: 2, slug: "two" } },
    ], pagination: {} } };
    net["api/v2/channels/one"] = { id: 1, livestream: { id: 11, categories: [{ id: 13 }] } };
    net["api/v2/channels/two"] = { id: 2, livestream: { id: 22, categories: [{ id: 13 }] } };
    const open = () => { const socket = sockets.at(-1); socket.readyState = 1; socket.onopen(); };
    let s = await kick.kickTick(); open();
    assert.equal(s.watching.login, "one");
    shift += 9 * 60 * 1000;
    s = await kick.kickTick(); open();
    assert.equal(s.watching.login, "two");                 // сменили канал
    assert.match(s.log[1].text, /kickStalled/);
    assert.equal(tabs.created.length, 0);
    shift += 9 * 60 * 1000;
    s = await kick.kickTick(); open();
    assert.equal(s.watching.via, "tab");                   // опять стоит: вкладка с плеером
    assert.equal(tabs.created.length, 1);
    net["drops/progress"] = { data: [{ id: "c1", rewards: [{ id: "r1", progress: 0.9, claimed: false }] }] };
    s = await kick.kickTick();
    assert.ok(tabs.removed.includes(7));                   // минуты пошли: вкладку закрыли
    assert.equal(s.stall.strikes, 0);
  } finally {
    Date.now = realNow;
    kick.stopWatch();
  }
});
