// node --test tests/solo.test.mjs — непрерывный фарм одной игры: Twitch (выбор кампаний) и Kick (сокет).
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const calls = [];
const sockets = [];
let net = {};
let cookie = "abc%7Cdef";

globalThis.chrome = {
  runtime: { id: "extid" },
  cookies: { get: async () => (cookie ? { value: cookie } : null) },
  storage: {
    local: {
      get: async (k) => (typeof k === "string" ? { [k]: store.local[k] } : { ...store.local }),
      set: async (o) => Object.assign(store.local, o),
      remove: async (k) => delete store.local[k],
    },
    session: {
      get: async (k) => ({ [k]: store.session[k] }),
      set: async (o) => Object.assign(store.session, o),
      remove: async (k) => delete store.session[k],
    },
  },
  tabs: {
    create: async () => ({ id: 7 }),
    query: async () => [{ id: 3, url: "https://kick.com/x" }],
    update: async () => {},
    remove: async () => {},
    get: async () => ({ id: 7, url: "https://kick.com/old" }),
  },
  scripting: { executeScript: async () => [{ result: "" }] },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
};
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
  const out = typeof value === "function" ? value(init, String(url)) : value;
  return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200 });
};

const settingsLib = await import("../lib/settings.js");
const kick = await import("../lib/kick.js");
const miner = await import("../lib/miner.js");

const campaign = (o = {}) => ({
  id: "c1", name: "Rust Drops", status: "active", category: { id: 13, name: "Rust" },
  channels: [], rewards: [{ id: "r1", name: "Skin", required_units: 120, progress: 0.5, claimed: false }], ...o,
});

function resetKick() {
  store.local = { settings: { soloKick: "Rust" } };
  store.session = {};
  calls.length = 0;
  sockets.length = 0;
  cookie = "abc%7Cdef";
  kick.stopWatch();
  kick.resetClientToken();
  net = {
    "viewer/v1/token": { data: { token: "viewer1" } },
    "kick.com/api/v1/user": { username: "me" },
    "drops/campaigns": { data: [campaign()] },
    "drops/progress": { data: [] },
    // Как у живого Kick: список эфиров отдаёт UUID трансляции, числовой id есть только в карточке.
    "livestreams": { data: { livestreams: [{ id: "01a0-uuid-stream", channel: { id: 5, slug: "streamer" } }] } },
    "api/v2/channels/": { id: 5, livestream: { id: 99, categories: [{ id: 13 }], viewer_count: 10 } },
  };
}

test("settings: soloGame нормализует, isSolo сравнивает id и название", () => {
  const settings = { soloTwitch: " 509263 ", soloKick: "Rust" };
  assert.equal(settingsLib.soloGame(settings, "twitch"), "509263");
  assert.equal(settingsLib.soloGame(settings, "kick"), "Rust");
  assert.equal(settingsLib.soloGame({}, "twitch"), "");
  assert.equal(settingsLib.isSolo(settings, "twitch", { id: "509263", name: "Rust" }), true);
  assert.equal(settingsLib.isSolo(settings, "twitch", { id: "1", name: "Minecraft" }), false);
  assert.equal(settingsLib.isSolo(settings, "kick", "Rust"), true);
  assert.equal(settingsLib.isSolo(settings, "kick", "Minecraft"), false);
  assert.equal(settingsLib.isSolo({}, "kick", "Rust"), false);
});

test("settings: выключение соло очищает поле, а не оставляет слово «off»", async () => {
  store.local = {};
  await settingsLib.writeSettings({ soloTwitch: " 42 " });
  assert.equal((await settingsLib.readSettings()).soloTwitch, "42");
  await settingsLib.writeSettings({ soloTwitch: "" });
  assert.equal((await settingsLib.readSettings()).soloTwitch, "");
});

test("miner: соло-кампании — только привязанные кампании этой игры", () => {
  const summaries = [
    { id: "a", linked: true, game: { id: "509263", name: "Rust" } },
    { id: "b", linked: false, game: { id: "509263", name: "Rust" } },
    { id: "c", linked: true, game: { id: "27471", name: "Minecraft" } },
  ];
  assert.deepEqual(miner.soloCampaigns(summaries, "509263").map((campaign) => campaign.id), ["a"]);
  assert.deepEqual(miner.soloCampaigns(summaries, ""), []);
  assert.deepEqual(miner.soloCampaigns(null, "509263"), []);
});

test("kick solo: фармится только выбранная игра, вторая кампания не смотрится", async () => {
  resetKick();
  net["drops/campaigns"] = { data: [
    campaign({ id: "c1", name: "Minecraft Drops", category: { id: 16, name: "Minecraft" }, rewards: [{ id: "r9", name: "Skin", required_units: 10, progress: 0, claimed: false }] }),
    campaign({ id: "c2", name: "Rust Drops", category: { id: 13, name: "Rust" }, rewards: [{ id: "r1", name: "Skin", required_units: 120, progress: 0.5, claimed: false }] }),
  ] };
  net["livestreams"] = (init, url) => ({ data: { livestreams: [{ id: String(url).includes("16") ? 77 : 99, channel: { id: 5, slug: String(url).includes("16") ? "mine" : "streamer" } }] } });
  const state = await kick.kickTick();
  assert.equal(state.watching.login, "streamer");
  assert.deepEqual(state.queue.map((row) => row.game), ["Rust"]);
  assert.ok(!calls.some((call) => call.url.includes("category_id=16")));
  kick.stopWatch();
});

test("kick solo: без кампании смотрим любой эфир игры по запомненной категории", async () => {
  resetKick();
  net["drops/campaigns"] = { data: [] };
  store.local.kick = { enabled: true, soloCategory: 13, soloGame: "Rust" };
  const state = await kick.kickTick();
  assert.equal(state.phase, "watching");
  assert.equal(state.watching.solo, true);
  assert.equal(state.watching.login, "streamer");
  assert.equal(state.watching.required, 0);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /viewer\/v1\/connect/);
  assert.equal(state.soloCategory, 13);
  kick.stopWatch();
});

test("kick solo: в сокет уходит числовой livestream id из карточки, а не UUID из списка", async () => {
  resetKick();
  net["drops/campaigns"] = { data: [] };
  store.local.kick = { enabled: true, soloCategory: 13, soloGame: "Rust" };
  await kick.kickTick();
  assert.equal(sockets.length, 1);
  sockets[0].onopen();
  const watch = sockets[0].sent.find((message) => message.type === "user_event");
  assert.equal(watch.data.message.livestream_id, 99, "числовой id из карточки");
  assert.equal(watch.data.message.channel_id, 5);
  kick.stopWatch();
});

test("kick solo: дроп игры без живого канала — смотрим кейс на любом эфире", async () => {
  resetKick();
  // В категории игры пусто, а «любой эфир» найти можно.
  net["livestreams"] = (init, url) => (String(url).includes("category_id")
    ? { data: { livestreams: [] } }
    : { data: { livestreams: [{ id: "01a0-uuid", channel: { id: 5, slug: "streamer" } }] } });
  net["api/v2/channels/"] = { id: 5, livestream: { id: 99, categories: [{ id: 1 }], viewer_count: 10 } };
  store.local.kickCases = { enabled: true, accounts: { current: { items: [
    { name: "Sunset Reward Case", status: "in_progress", progress: 40, threshold: 180 },
  ] } } };
  const state = await kick.kickTick();
  assert.equal(state.watching.case, true);
  assert.equal(state.watching.login, "streamer");
  assert.equal(sockets.length, 1);
  kick.stopWatch();
});

test("kick solo: без категории и без кампаний — честно «нет канала»", async () => {
  resetKick();
  net["drops/campaigns"] = { data: [] };
  const state = await kick.kickTick();
  assert.equal(state.phase, "no-channel");
  assert.equal(state.watching, null);
  assert.equal(sockets.length, 0);
});
