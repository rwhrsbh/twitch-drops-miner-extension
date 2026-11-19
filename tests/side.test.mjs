// node --test tests/  — параллельный фарм остальных аккаунтов: lib/kickside.js (целиком) и каркас lib/side.js.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const sockets = [];
const claims = [];
const asked = [];
// Bearer -> { progress: { rewardId: { progress, claimed } }, points: { slug: n } }
let users = {};
// slug -> { id, stream, category, live }
let channels = {};
let twitchUsers = {};

const area = (bag) => ({
  get: async (key) => {
    if (key == null) return { ...bag() };
    const keys = Array.isArray(key) ? key : [key];
    // Как в настоящем хранилище: наружу отдаётся копия, а не сам объект.
    return structuredClone(Object.fromEntries(keys.filter((name) => name in bag()).map((name) => [name, bag()[name]])));
  },
  set: async (value) => Object.assign(bag(), structuredClone(value)),
  remove: async (key) => { delete bag()[key]; },
});

globalThis.chrome = {
  runtime: { id: "ext" },
  storage: { local: area(() => store.local), session: area(() => store.session) },
  cookies: { get: async () => null, getAll: async () => [], remove: async () => {}, set: async () => {} },
  tabs: { query: async () => [], create: async () => ({ id: 1 }), remove: async () => {}, reload: async () => {} },
  windows: { create: async () => ({ id: 1 }), remove: async () => {} },
  scripting: { executeScript: async () => [{ result: null }] },
  declarativeNetRequest: { updateDynamicRules: async () => {}, updateSessionRules: async () => {} },
};

class FakeSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;

const CAMPAIGNS = [
  {
    id: "camp1", name: "Rust drops", status: "active", category: { id: 5, name: "Rust", image_url: "" }, connect_url: "",
    channels: [], rewards: [{ id: "r1", name: "Skin", required_units: 60 }, { id: "r2", name: "Door", required_units: 120 }],
  },
  {
    id: "camp2", name: "Dota drops", status: "active", category: { id: 9, name: "Dota 2", image_url: "" }, connect_url: "",
    channels: [], rewards: [{ id: "d1", name: "Ward", required_units: 30 }],
  },
];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const bearer = String(init.headers?.Authorization || "").replace("Bearer ", "");
  if (target.includes("oauth2/validate")) {
    const user = twitchUsers[String(init.headers?.Authorization || "").replace("OAuth ", "")];
    return json(user || {}, user ? 200 : 401);
  }
  if (target.includes("/viewer/v1/token")) return users[bearer] ? json({ data: { token: `viewer-${bearer}-${sockets.length}` } }) : json({}, 401);
  if (target.includes("/drops/campaigns")) return users[bearer] ? json({ data: CAMPAIGNS }) : json({}, 401);
  if (target.includes("/drops/progress")) {
    const mine = users[bearer]?.progress || {};
    return json({ data: [{ rewards: Object.entries(mine).map(([id, value]) => ({ id, ...value })) }] });
  }
  if (target.includes("/drops/claim")) {
    const body = JSON.parse(init.body);
    claims.push(`${bearer}:${body.reward_id}`);
    return json({ message: "Success" });
  }
  if (target.includes("/gamification/challenges")) return json({ data: [] });
  const anyLive = /livestreams\?limit=\d+&sort=viewer_count_desc$/.test(target);
  if (anyLive) {
    const rows = Object.entries(channels).filter(([, row]) => row.live);
    return json({ data: { livestreams: rows.map(([slug, row]) => ({ id: row.stream, channel: { slug, id: row.id } })) } });
  }
  const list = /livestreams\?.*category_id=(\d+)/.exec(target);
  if (list) {
    const rows = Object.entries(channels).filter(([, row]) => row.live && row.category === Number(list[1]));
    return json({ data: { livestreams: rows.map(([slug, row]) => ({ id: row.stream, channel: { slug, id: row.id } })) } });
  }
  const points = /\/api\/v2\/channels\/([^/]+)\/points$/.exec(target);
  if (points) {
    asked.push(`${bearer}:${points[1]}`);
    return json({ data: { points: users[bearer]?.points?.[points[1]] ?? 0 } });
  }
  const card = /\/api\/v2\/channels\/([^/]+)$/.exec(target);
  if (card) {
    const row = channels[card[1]];
    if (!row) return json({}, 404);
    return json({ id: row.id, slug: card[1], user: { username: card[1] }, livestream: row.live ? { id: row.stream, categories: [{ id: row.category }], viewer_count: 5 } : null });
  }
  return json({}, 404);
};

// Баллы Kick выключены флагом; код оставлен, поэтому тесты проверяют его с включённым флагом.
const { FEATURES } = await import("../lib/constants.js");
FEATURES.kickPoints = true;
const kickSide = await import("../lib/kickside.js");
const side = await import("../lib/side.js");
const miner = await import("../lib/miner.js");
const history = await import("../lib/history.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const kickAccount = (id, login, token, extra = {}) => ({
  id, login, cookies: [{ name: "session_token", value: encodeURIComponent(token) }], picked: ["Rust"], points: [], ...extra,
});

async function reset() {
  kickSide.resetKickSide();
  side.resetSide();
  sockets.length = 0;
  claims.length = 0;
  asked.length = 0;
  users = { "1|a": { progress: {}, points: {} }, "2|b": { progress: { r1: { progress: 0.5 } }, points: { rusty: 40 } }, "3|c": { progress: {}, points: {} } };
  channels = {
    rusty: { id: 11, stream: 101, category: 5, live: true },
    rusty2: { id: 12, stream: 102, category: 5, live: true },
    chat: { id: 13, stream: 103, category: 1, live: true },
    dota: { id: 14, stream: 104, category: 9, live: true },
  };
  twitchUsers = {};
  store.session = {};
  store.local = {
    settings: { autoAll: false, blacklist: [], picked: [] },
    points: { enabled: false },
    kick: { enabled: true, user: "main" },
    state: { enabled: true },
    accounts: {
      twitch: { active: "", list: [], done: 0 },
      kick: { active: "1", done: 0, list: [kickAccount("1", "main", "1|a"), kickAccount("2", "second", "2|b")] },
      rotate: { mode: "all", limit: 1 },
      warned: true,
    },
  };
  await history.clearHistory();
}

test("kick: второй аккаунт фармит параллельно по своему токену, активный не трогается", async () => {
  await reset();
  const out = await kickSide.kickSideTick();
  await settle();
  assert.deepEqual(Object.keys(out), ["2"], "только неактивный аккаунт");
  assert.equal(out["2"].phase, "watching");
  assert.equal(out["2"].watching.dropId, "r1");
  assert.equal(out["2"].watching.current, 30, "прогресс свой, а не активного аккаунта");
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /viewer-2%7Cb/, "сокет открыт токеном зрителя этого аккаунта");
  assert.deepEqual(sockets[0].sent[1].data.message, { name: "tracking.user.watch.livestream", channel_id: 11, livestream_id: 101 });
  assert.equal(out["2"].queue.length, 2, "очередь аккаунта для вкладки Kick");
});

test("kick: повторный проход держит тот же сокет", async () => {
  await reset();
  await kickSide.kickSideTick();
  await kickSide.kickSideTick();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);
});

test("kick: у каждого аккаунта свой выбор игр", async () => {
  await reset();
  store.local.accounts.kick.list.push(kickAccount("3", "third", "3|c", { picked: ["Dota 2"] }));
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.game, "Rust");
  assert.equal(out["3"].watching.game, "Dota 2");
  assert.equal(out["3"].watching.login, "dota");
  assert.equal(sockets.length, 2);
});

test("kick: готовый дроп забирается токеном своего аккаунта и пишется в историю с его ником", async () => {
  await reset();
  users["2|b"].progress = { r1: { progress: 1 } };
  const out = await kickSide.kickSideTick();
  assert.deepEqual(claims, ["2|b:r1"]);
  assert.equal(out["2"].watching.dropId, "r2", "после клейма фармится следующий дроп");
  const rows = await history.readHistory();
  assert.equal(rows[0].account, "second");
  assert.equal(rows[0].platform, "kick");
});

test("kick: пока идёт дроп, каналы баллов не смотрятся; без дропа смотрятся", async () => {
  await reset();
  store.local.points = { enabled: true };
  store.local.accounts.kick.list[1].points = [{ login: "chat", name: "chat" }];
  let out = await kickSide.kickSideTick();
  assert.equal(sockets.length, 1, "только сокет дропа");
  assert.equal(out["2"].points.status.rusty.drop, true);
  assert.equal(out["2"].points.status.rusty.balance, 40);
  assert.equal(out["2"].points.status.chat.watching, false);
  assert.ok(asked.every((item) => item.startsWith("2|b:")), "баланс читается токеном этого аккаунта");
  // Дропы кончились: канал баллов можно смотреть.
  users["2|b"].progress = { r1: { progress: 1, claimed: true }, r2: { progress: 1, claimed: true } };
  out = await kickSide.kickSideTick();
  assert.equal(out["2"].phase, "all-claimed");
  assert.equal(sockets[0].closed, true, "сокет дропа закрыт");
  assert.equal(sockets.length, 2);
  assert.equal(out["2"].points.status.chat.watching, true);
});

test("kick: выбранный кликом дроп фармится первым", async () => {
  await reset();
  await kickSide.kickSideTick();
  store.local.kickSide["2"].preferDropId = "r2";
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.dropId, "r2");
});

test("kick: мёртвая сессия не роняет остальных и закрывает свои сокеты", async () => {
  await reset();
  store.local.accounts.kick.list.push(kickAccount("3", "third", "3|c"));
  await kickSide.kickSideTick();
  assert.equal(sockets.length, 2);
  delete users["3|c"];
  const out = await kickSide.kickSideTick();
  assert.equal(out["3"].phase, "need-login");
  assert.equal(out["2"].phase, "watching");
  assert.equal(sockets.filter((item) => item.closed).length, 1);
});

test("kick: другой режим, выключенный майнер, удалённый или истёкший аккаунт — сокеты закрыты", async () => {
  for (const change of [
    () => { store.local.accounts.rotate.mode = "campaigns"; },
    () => { store.local.kick.enabled = false; },
    () => { store.local.accounts.kick.list.pop(); },
    () => { store.local.accounts.kick.list[1].expired = true; },
    () => { store.local.accounts.kick.active = "2"; },
  ]) {
    await reset();
    await kickSide.kickSideTick();
    assert.equal(sockets.length, 1);
    change();
    const out = await kickSide.kickSideTick();
    assert.equal(sockets[0].closed, true);
    assert.equal(out["2"], undefined);
  }
});

const twitchAccount = (id, login, token, extra = {}) => ({
  id, login, cookies: [{ name: "auth-token", value: token }, { name: "unique_id", value: `dev-${id}` }], whitelist: ["g1"], points: [], ...extra,
});

async function twitchReset() {
  await reset();
  twitchUsers = { tokA: { user_id: "1", login: "alice" }, tokB: { user_id: "2", login: "bob" } };
  store.local.accounts.twitch = { active: "1", done: 0, list: [twitchAccount("1", "alice", "tokA"), twitchAccount("2", "bob", "tokB")] };
}

test("twitch: без каталога основного майнера второй аккаунт ждёт, а не дёргает активный", async () => {
  await twitchReset();
  const result = await side.sideTick();
  assert.deepEqual(result, {}, "переключать аккаунт не просит");
  assert.equal(store.local.side["2"].phase, "waiting");
  assert.equal(store.local.side["1"], undefined, "активным аккаунтом занимается основной майнер");
});

test("twitch: мёртвый токен, не выбранные игры, выключенный режим", async () => {
  await twitchReset();
  delete twitchUsers.tokB;
  await side.sideTick();
  assert.equal(store.local.side["2"].phase, "need-login");

  await twitchReset();
  store.local.accounts.twitch.list[1].whitelist = [];
  await side.sideTick();
  assert.equal(store.local.side["2"].phase, "pick-game");

  for (const change of [
    () => { store.local.accounts.rotate.mode = "never"; },
    () => { store.local.state.enabled = false; },
    () => { store.local.accounts.twitch.list[1].expired = true; },
  ]) {
    await twitchReset();
    await side.sideTick();
    change();
    await side.sideTick();
    assert.deepEqual(store.local.side, {});
  }
});

test("twitch: клик по дропу в очереди второго аккаунта сохраняется за ним", async () => {
  await twitchReset();
  await side.sideTick();
  await side.watchSideDrop("2", "drop9");
  assert.equal(store.local.side["2"].preferDropId, "drop9");
  await side.sideTick();
  assert.equal(store.local.side["2"].preferDropId, "drop9", "выбор переживает следующий проход");
  assert.deepEqual(Object.keys(await side.watchSideDrop("nope", "x")), ["2"], "чужой id ничего не создаёт");
});

test("kick: нечего фармить, но у аккаунта есть кейс — смотрит любой эфир", async () => {
  await reset();
  users["2|b"].progress = { r1: { progress: 1, claimed: true }, r2: { progress: 1, claimed: true } };
  store.local.kickCases = { enabled: true, accounts: { "2": { items: [
    { name: "Sunset Reward Case", status: "in_progress", progress: 40, threshold: 180 },
  ] } } };
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].phase, "watching");
  assert.equal(out["2"].watching.case, true);
  assert.equal(out["2"].watching.name, "Sunset Reward Case");
  assert.equal(out["2"].watching.required, 180);
  assert.equal(sockets.length, 1);
  // Второй проход: канал в эфире, кейсу всё ещё нужны минуты — тот же сокет, а не новый.
  await kickSide.kickSideTick();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);
});

test("kick: аккаунт без выбранных игр всё равно смотрит ради кейса", async () => {
  await reset();
  store.local.accounts.kick.list[1].picked = [];
  store.local.settings.autoAll = false;
  users["2|b"].progress = { r1: { progress: 1, claimed: true }, r2: { progress: 1, claimed: true } };
  store.local.kickCases = { enabled: true, accounts: { "2": { items: [
    { name: "Sunset Reward Case", status: "in_progress", progress: 40, threshold: 180 },
  ] } } };
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.case, true, "кейс важнее пустого выбора игр");
  assert.equal(sockets.length, 1);
});

test("kick: появившийся дроп важнее кейс-эфира у побочного аккаунта", async () => {
  await reset();
  users["2|b"].progress = { r1: { progress: 1, claimed: true }, r2: { progress: 1, claimed: true } };
  store.local.kickCases = { enabled: true, accounts: { "2": { items: [
    { name: "Sunset Reward Case", status: "in_progress", progress: 40, threshold: 180 },
  ] } } };
  let out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.case, true);
  // Дроп снова доступен и канал в эфире: кейс-эфир уступает.
  users["2|b"].progress = {};
  out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.dropId, "r1");
  assert.ok(!out["2"].watching.case);
});

test("kick: появившийся дроп важнее соло-эфира у побочного аккаунта", async () => {
  await reset();
  store.local.settings.soloKick = "Apex";
  store.local.kick = { enabled: true, user: "main", soloGame: "Apex", soloCategory: 1 };
  let out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.solo, true, "эфир ради соло-игры");
  // У выбранной игры появилась кампания и живой канал.
  store.local.settings.soloKick = "Rust";
  out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.dropId, "r1");
});

test("kick: кейса нет и фармить нечего — сокет закрыт", async () => {
  await reset();
  users["2|b"].progress = { r1: { progress: 1, claimed: true }, r2: { progress: 1, claimed: true } };
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].phase, "all-claimed");
  assert.equal(sockets.length, 0);
});

test("kick solo: параллельный аккаунт фармит выбранную игру, его собственный выбор не в счёт", async () => {
  await reset();
  store.local.settings.soloKick = "Rust";
  // У аккаунта выбран Dota, но соло-настройка сильнее: фармится Rust.
  store.local.accounts.kick.list[1].picked = ["Dota 2"];
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching.game, "Rust");
  assert.equal(out["2"].watching.login, "rusty");
  assert.ok(out["2"].queue.every((row) => row.game === "Rust"), "очередь только из этой игры");
});

test("kick solo: без кампаний смотрим любой эфир игры по категории основного майнера", async () => {
  await reset();
  store.local.settings.soloKick = "Apex";
  store.local.kick = { enabled: true, user: "main", soloGame: "Apex", soloCategory: 1 };
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].phase, "watching");
  assert.equal(out["2"].watching.solo, true);
  assert.equal(out["2"].watching.login, "chat", "канал из категории игры");
  assert.equal(sockets.length, 1);
});

test("kick solo: соло-сокет не перезапускается каждую минуту", async () => {
  await reset();
  store.local.settings.soloKick = "Apex";
  store.local.kick = { enabled: true, user: "main", soloGame: "Apex", soloCategory: 1 };
  await kickSide.kickSideTick();
  await kickSide.kickSideTick();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);
});

// Заглушка GraphQL: инвентарь пуст, канал alice в эфире в игре g1.
function twitchGql() {
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("gql.twitch.tv")) {
      const payload = JSON.parse(init.body || "{}");
      const operation = (Array.isArray(payload) ? payload[0] : payload)?.operationName;
      const json = (body) => new Response(JSON.stringify(body), { status: 200 });
      if (operation === "Inventory") return json({ data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } });
      if (operation === "VideoPlayerStreamInfoOverlayChannel") {
        return json({ data: { user: { login: "alice", id: "1", stream: { id: "s1" }, broadcastSettings: { game: { id: "g1", displayName: "Rust" } } } } });
      }
      return json({ data: {} });
    }
    return inner(url, init);
  };
  return () => { globalThis.fetch = inner; };
}

test("twitch solo: устаревший каталог не останавливает параллельный аккаунт", async () => {
  await twitchReset();
  store.local.settings.soloTwitch = "g1";
  store.local.soloHint = { gameId: "g1", name: "Rust", login: "alice", kind: "any", at: Date.now() };
  // Каталог старше 10 минут: раньше это давало «waiting» и аккаунт стоял.
  miner.seedCatalog([], Date.now() - 11 * 60 * 1000);
  const restore = twitchGql();
  try {
    await side.sideTick();
    assert.notEqual(store.local.side["2"].phase, "waiting");
    assert.equal(store.local.side["2"].watching.solo, true);
    assert.equal(store.local.side["2"].watching.login, "alice");
  } finally {
    restore();
  }
});

test("twitch solo: второй аккаунт держит канал, который нашёл основной майнер", async () => {
  await twitchReset();
  store.local.settings.soloTwitch = "g1";
  store.local.soloHint = { gameId: "g1", name: "Rust", login: "alice", kind: "drops", at: Date.now() };
  miner.seedCatalog([{
    id: "c1", name: "Rust drops", linked: true, game: { id: "g1", name: "Rust", slug: "rust", image: "" }, channels: [],
    drops: [{
      id: "d1", name: "Skin", benefits: ["Skin"], benefitIds: [], required: 60, current: 60, claimed: true,
      channels: [], preconditionIds: [], campaignId: "c1", campaignName: "Rust drops", game: { id: "g1", name: "Rust" },
    }],
  }]);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("gql.twitch.tv")) {
      const payload = JSON.parse(init.body || "{}");
      const operation = (Array.isArray(payload) ? payload[0] : payload)?.operationName;
      const json = (body) => new Response(JSON.stringify(body), { status: 200 });
      if (operation === "Inventory") return json({ data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } });
      if (operation === "VideoPlayerStreamInfoOverlayChannel") {
        return json({ data: { user: { login: "alice", id: "1", stream: { id: "s1" }, broadcastSettings: { game: { id: "g1", displayName: "Rust" } } } } });
      }
      return json({ data: {} });
    }
    return inner(url, init);
  };
  try {
    const result = await side.sideTick();
    assert.deepEqual(result, {}, "аккаунт менять не просит");
    const slot = store.local.side["2"];
    assert.equal(slot.watching.solo, true, "минуты идут не за дропом, а за игрой");
    assert.equal(slot.watching.login, "alice");
    assert.equal(slot.watching.gameId, "g1");
    assert.equal(slot.queue.length, 1, "очередь игры в попапе");
  } finally {
    globalThis.fetch = inner;
  }
});

// ---- Находки ревью ----

const baseFetch = globalThis.fetch;
const sent = [];
let onCampaigns = null;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  sent.push({ target, bearer: String(init.headers?.Authorization || "").replace("Bearer ", ""), credentials: init.credentials });
  if (target.includes("/drops/campaigns") && onCampaigns) {
    const hook = onCampaigns;
    onCampaigns = null;
    await hook();
  }
  return baseFetch(url, init);
};

test("kick: запросы чужого аккаунта идут без кук браузера", async () => {
  await reset();
  sent.length = 0;
  store.local.points = { enabled: true };
  await kickSide.kickSideTick();
  const mine = sent.filter((item) => item.bearer === "2|b");
  assert.ok(mine.length >= 4, "кампании, прогресс, токен зрителя, баланс");
  assert.deepEqual([...new Set(mine.map((item) => item.credentials))], ["omit"]);
});

test("kick: чужой аккаунт ходит за эфирами без кук браузера", async () => {
  await reset();
  users["2|b"].progress = { r1: { progress: 1, claimed: true }, r2: { progress: 1, claimed: true } };
  store.local.kickCases = { enabled: true, accounts: { "2": { items: [
    { name: "Sunset Reward Case", status: "in_progress", progress: 40, threshold: 180 },
  ] } } };
  sent.length = 0;
  await kickSide.kickSideTick();
  // Второй проход проверяет «канал ещё в эфире» — это тоже карточка чужого аккаунта.
  await kickSide.kickSideTick();
  const streams = sent.filter((item) => /livestreams|api\/v2\/channels/.test(item.target));
  assert.ok(streams.length > 1, "список эфиров и карточки запрошены несколько раз");
  assert.deepEqual([...new Set(streams.map((item) => item.credentials))], ["omit"]);
});

test("kick: клик по дропу посреди прохода не теряется", async () => {
  await reset();
  await kickSide.kickSideTick();
  onCampaigns = () => kickSide.watchKickSideDrop("2", "r2");
  await kickSide.kickSideTick();
  assert.equal(store.local.kickSide["2"].preferDropId, "r2", "выбор пережил запись прохода");
  await settle();
  await kickSide.kickSideTick();
  assert.equal(store.local.kickSide["2"].watching.dropId, "r2");
});

test("kick: список игр Twitch на параллельный аккаунт Kick не влияет", async () => {
  await reset();
  store.local.accounts.kick.list[1].picked = [];
  store.local.state = { enabled: true, whitelist: ["77"], games: [{ id: "77", name: "Dota 2" }] };
  const out = await kickSide.kickSideTick();
  assert.equal(out["2"].watching, null);
});

test("баллы kick: Kick не ответил про канал, а дроп начался — сокет баллов всё равно закрыт", async () => {
  await reset();
  const points = await import("../lib/kickpoints.js");
  const { createWatchers } = await import("../lib/kicksocket.js");
  const pool = createWatchers();
  const ctx = (dropLogin, previous) => ({
    token: "2|b", viewer: async () => "v", channels: [{ login: "chat", name: "chat" }], dropLogin, previous, prefix: "x:", account: "second", own: false,
  });
  const free = await points.pointsPass(ctx(""), pool);
  assert.deepEqual(pool.keys(), ["x:chat"]);
  // Карточка канала перестала читаться (WAF): без дропа сокет сохраняется, с дропом закрывается.
  const real = channels.chat;
  delete channels.chat;
  const failing = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith("/channels/chat") ? new Response("{}", { status: 403 }) : failing(url, init));
  try {
    await points.pointsPass(ctx("", free), pool);
    assert.deepEqual(pool.keys(), ["x:chat"], "без дропа сокет не трогаем");
    await points.pointsPass(ctx("rusty", free), pool);
    assert.deepEqual(pool.keys(), [], "идёт дроп: сокет баллов закрыт");
  } finally {
    globalThis.fetch = failing;
    channels.chat = real;
  }
});

test("twitch: активный аккаунт умер — активным становится первый рабочий", async () => {
  await twitchReset();
  store.local.accounts.twitch.list[0].expired = true;
  // Три минуты ждём: пользователь мог выйти, чтобы войти заново руками.
  assert.deepEqual(await side.sideTick(), {});
  assert.deepEqual(await side.sideTick(), {});
  store.session.sideOrphan = Date.now() - 4 * 60 * 1000;
  assert.deepEqual(await side.sideTick(), { switchTo: "2" });
  // Активный вернулся: отсчёт сброшен.
  await twitchReset();
  store.session.sideOrphan = Date.now() - 4 * 60 * 1000;
  await side.sideTick();
  assert.equal(store.session.sideOrphan, undefined);
  // Активного нет вовсе (его удалили, а следующий не подхватился).
  await twitchReset();
  store.local.accounts.twitch.active = "";
  store.session.sideOrphan = Date.now() - 4 * 60 * 1000;
  const result = await side.sideTick();
  assert.ok(["1", "2"].includes(result.switchTo));
});

test("twitch: смена ради клейма не чаще раза в 10 минут и по очереди", async () => {
  await twitchReset();
  const t0 = 1_000_000_000_000;
  assert.equal(await side.choosePromotion([], t0), "");
  assert.equal(await side.choosePromotion(["a", "b"], t0), "a");
  assert.equal(await side.choosePromotion(["a", "b"], t0 + 60_000), "", "через минуту никого не меняем");
  assert.equal(await side.choosePromotion(["a", "b"], t0 + 9 * 60_000), "", "и через девять минут тоже");
  assert.equal(await side.choosePromotion(["a", "b"], t0 + 11 * 60_000), "b", "следующим идёт тот, кого ещё не делали активным");
  assert.equal(await side.choosePromotion(["a", "b"], t0 + 22 * 60_000), "a");
  assert.equal(await side.choosePromotion(["b"], t0 + 23 * 60_000, true), "b", "активного нет: ждать нечего");
});

test("название, ставшее выбранной игрой, уходит из ожидающих", async () => {
  const miner = await import("../lib/miner.js");
  const games = [{ id: "7", name: "Alpha" }, { id: "8", name: "Beta" }];
  assert.deepEqual(miner.unmetWishes(["alpha", "Beta", "Gamma"], games, ["7"]), ["Beta", "Gamma"]);
  assert.deepEqual(miner.unmetWishes(["Alpha"], [{ game: { id: "7", name: "Alpha" } }], ["7"]), []);
});
