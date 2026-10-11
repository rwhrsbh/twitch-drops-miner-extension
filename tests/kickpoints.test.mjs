// node --test tests/  — lib/kickpoints.js: баллы Kick за фоновый просмотр по WebSocket, баланс, ежедневные награды.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
// slug -> { live, id, stream, points }
let channels = {};
let challenges = [];
let loggedIn = true;
const claimed = [];
const sockets = [];

const area = (bag) => ({
  get: async (key) => {
    if (key == null) return { ...bag() };
    const keys = Array.isArray(key) ? key : [key];
    return Object.fromEntries(keys.filter((name) => name in bag()).map((name) => [name, bag()[name]]));
  },
  set: async (value) => Object.assign(bag(), structuredClone(value)),
  remove: async (key) => { delete bag()[key]; },
});

globalThis.chrome = {
  runtime: { id: "ext" },
  storage: { local: area(() => store.local), session: area(() => store.session) },
  cookies: { get: async ({ name }) => (loggedIn && name === "session_token" ? { value: "1%7Cabc" } : null) },
  tabs: { query: async () => [], create: async () => ({ id: 1 }), remove: async () => {} },
  scripting: { executeScript: async () => [{ result: null }] },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
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

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const auth = init.headers?.Authorization || "";
  if (target.includes("/viewer/v1/token")) return auth ? json({ data: { token: `viewer${sockets.length}` } }) : json({}, 401);
  if (target.includes("/gamification/challenges/")) {
    assert.equal(init.method, "POST");
    claimed.push(/challenges\/([^/]+)\/claim/.exec(target)[1]);
    return json({ data: { winner: { rarity: "rare", thumbnail_url: "https://pic/card.png" } } });
  }
  if (target.includes("/gamification/challenges")) {
    assert.equal(init.headers["X-App-Platform"], "web");
    return json({ data: challenges });
  }
  if (target.includes("/api/search")) {
    return json({ channels: [
      { id: 7, slug: "Alpha", isLive: false, user: { username: "Alpha", profilePic: "https://pic/a.png" } },
      { id: 8, slug: "alphalive", isLive: true, user: { username: "AlphaLive" } },
      { id: 9, slug: "banned", is_banned: true },
    ] });
  }
  const points = /\/api\/v2\/channels\/([^/]+)\/points$/.exec(target);
  if (points) {
    assert.equal(auth, "Bearer 1|abc");
    const row = channels[points[1]];
    return row ? json({ data: { points: row.points } }) : json({}, 404);
  }
  const card = /\/api\/v2\/channels\/([^/]+)$/.exec(target);
  if (card) {
    const row = channels[card[1]];
    if (!row) return json({}, 404);
    return json({ id: row.id, slug: card[1], user: { username: card[1].toUpperCase(), profile_pic: "" }, livestream: row.live ? { id: row.stream } : null });
  }
  return json({}, 404);
};

// Баллы Kick выключены флагом; код оставлен, поэтому тесты проверяют его с включённым флагом.
const { FEATURES } = await import("../lib/constants.js");
FEATURES.kickPoints = true;
const points = await import("../lib/kickpoints.js");
const history = await import("../lib/history.js");

async function reset() {
  points.stopKickPoints();
  store.local = { points: { enabled: true }, kick: { enabled: true, user: "me" } };
  sockets.length = 0;
  claimed.length = 0;
  challenges = [];
  loggedIn = true;
  channels = {
    one: { live: true, id: 11, stream: 101, points: 50 },
    two: { live: true, id: 12, stream: 102, points: 0 },
    three: { live: true, id: 13, stream: 103, points: 5 },
    off: { live: false, id: 14, stream: 0, points: 900 },
  };
}

const pick = (...names) => names.map((login) => ({ login, name: login }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
// Следующий проход снова читает баланс, не дожидаясь пяти минут.
async function due() {
  store.local.kickPoints = { ...store.local.kickPoints, checkedAt: 0 };
}

test("выключено: ни сокетов, ни запросов", async () => {
  await reset();
  store.local.points = { enabled: false };
  store.local.kickPoints = { channels: pick("one") };
  await points.kickPointsTick();
  assert.equal(sockets.length, 0);
});

test("смотрит не больше двух каналов в эфире и читает баланс", async () => {
  await reset();
  store.local.kickPoints = { channels: pick("off", "one", "two", "three") };
  const state = await points.kickPointsTick();
  await settle();
  assert.equal(sockets.length, 2);
  const first = sockets[0].sent;
  assert.deepEqual(first[0], { type: "channel_handshake", data: { message: { channelId: 11 } } });
  assert.deepEqual(first[1].data.message, { name: "tracking.user.watch.livestream", channel_id: 11, livestream_id: 101 });
  assert.notEqual(sockets[0].url, sockets[1].url, "у каждого сокета свой токен зрителя");
  assert.equal(state.status.one.watching, true);
  assert.equal(state.status.two.watching, true);
  assert.equal(state.status.three.watching, false);
  assert.equal(state.status.off.live, false);
  assert.equal(state.status.off.balance, 900);
  assert.equal(state.status.one.balance, 50);
});

test("повторный проход не открывает сокеты заново, прирост баланса считается", async () => {
  await reset();
  store.local.kickPoints = { channels: pick("one") };
  await points.kickPointsTick();
  channels.one.points = 70;
  await points.kickPointsTick();
  assert.equal((await points.readKickPoints()).status.one.balance, 50, "до пяти минут баланс не перечитывается");
  await due();
  const state = await points.kickPointsTick();
  assert.equal(sockets.length, 1);
  assert.equal(state.status.one.balance, 70);
  assert.equal(state.status.one.lastGain, 20);
  assert.equal(state.status.one.gained, 20);
});

test("канал ушёл из эфира: сокет закрыт, место занимает следующий", async () => {
  await reset();
  store.local.kickPoints = { channels: pick("one", "two", "three") };
  await points.kickPointsTick();
  channels.one.live = false;
  const state = await points.kickPointsTick();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 3);
  assert.equal(state.status.three.watching, true);
  assert.equal(state.status.one.watching, false);
});

test("новый эфир того же канала: сокет переоткрывается с новым id", async () => {
  await reset();
  store.local.kickPoints = { channels: pick("one") };
  await points.kickPointsTick();
  channels.one.stream = 555;
  await points.kickPointsTick();
  await settle();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets[1].sent[1].data.message.livestream_id, 555);
});

test("ежедневная награда забирается один раз и попадает в историю", async () => {
  await reset();
  await history.clearHistory();
  challenges = [
    { id: "c1", status: "claimable", name: "Daily Reward", window: { ends_at: "2026-10-11" } },
    { id: "c2", status: "in_progress" },
  ];
  await points.kickPointsTick();
  assert.deepEqual(claimed, ["c1"]);
  store.local.kickPoints = { ...store.local.kickPoints, dailyAt: 0 };
  await points.kickPointsTick();
  assert.deepEqual(claimed, ["c1"], "та же награда второй раз не запрашивается");
  const rows = await history.readHistory();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, "kick");
  assert.equal(rows[0].kind, "drop");
  assert.equal(rows[0].name, "Daily Reward · rare");
  assert.equal(rows[0].image, "https://pic/card.png");
  assert.equal(rows[0].account, "me");
});

test("нет входа в Kick: сокеты закрываются", async () => {
  await reset();
  store.local.kickPoints = { channels: pick("one") };
  await points.kickPointsTick();
  loggedIn = false;
  await points.kickPointsTick();
  assert.equal(sockets[0].closed, true);
});

test("смена аккаунта: сокеты прежнего закрыты, список и статусы заменены", async () => {
  await reset();
  store.local.kickPoints = { channels: pick("one") };
  await points.kickPointsTick();
  const next = await points.replaceKickPoints(pick("two"));
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(next.channels.map((item) => item.login), ["two"]);
  assert.deepEqual(next.status, {});
});

test("поиск: каналы из выдачи Kick, точный ник первым, потом эфир", async () => {
  await reset();
  const found = await points.searchKickChannels("Alpha");
  assert.deepEqual(found.map((item) => item.login), ["alpha", "alphalive"]);
  assert.equal(found[0].image, "https://pic/a.png");
  const exact = await points.searchKickChannels("one");
  assert.ok(exact.some((item) => item.login === "one" && item.id === "11" && item.live));
});

test("пока аккаунт фармит дроп, каналы баллов не смотрятся", async () => {
  await reset();
  const { createWatchers } = await import("../lib/kicksocket.js");
  const pool = createWatchers();
  const ctx = (dropLogin, previous) => ({
    token: "1|abc", viewer: async () => "v", channels: pick("one", "two"), dropLogin, previous, prefix: "acc:", account: "me",
  });
  const busy = await points.pointsPass(ctx("three"), pool);
  assert.deepEqual(pool.keys(), []);
  assert.equal(busy.status.three.watching, true);
  assert.equal(busy.status.one.watching, false);
  const free = await points.pointsPass(ctx("", busy), pool);
  assert.deepEqual(pool.keys(), ["acc:one", "acc:two"]);
  assert.equal(free.status.one.watching, true);
  // Дроп появился снова: сокеты баллов закрываются.
  await points.pointsPass(ctx("three", free), pool);
  assert.deepEqual(pool.keys(), []);
});

test("флаг выключен: баллы Kick не собираются и сокеты не открываются", async () => {
  await reset();
  await points.setKickPointsChannels([{ login: "alpha", id: "", name: "Alpha" }]);
  await points.kickPointsTick();
  points.stopKickPoints();
  sockets.length = 0;
  FEATURES.kickPoints = false;
  try {
    await points.kickPointsTick();
    assert.equal(sockets.length, 0);
  } finally {
    FEATURES.kickPoints = true;
  }
});
