// node --test tests/  — lib/points.js (клейм бонусов раз в 5 минут, без «просмотра») и sendWatch из lib/client.js.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const claims = [];
// Что уходило в сеть: плейлисты (просмотр), minute-watched, HEAD сегментов, запросы баланса, вкладки.
const watched = [];
const pings = [];
const heads = [];
const asked = [];
const opened = [];
// login -> { live, balance, claim }
let channels = {};

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
  storage: { local: area(() => store.local), session: area(() => store.session) },
  cookies: { get: async ({ name }) => (name === "auth-token" ? { value: "tok" } : name === "unique_id" ? { value: "dev" } : null) },
  tabs: {
    query: async () => [],
    create: async (options) => { opened.push(options.url); return { id: 1 }; },
    remove: async (id) => { opened.push(`closed ${id}`); },
    // 99 — номер, который после перезапуска браузера достался чужой вкладке.
    get: async (id) => ({ id, status: "complete", url: id === 99 ? "https://example.com/" : "https://www.twitch.tv/somebody" }),
    update: async () => ({}),
    onUpdated: { addListener() {}, removeListener() {} },
  },
  scripting: { executeScript: async () => [{ result: null }] },
};

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (target.includes("oauth2/validate")) return json({ user_id: "1", login: "alice", client_id: "cid" });
  if (target.includes("usher.ttvnw.net")) {
    const login = /hls\/([^.]+)\.m3u8/.exec(target)[1];
    return new Response(`#EXTM3U\nhttps://video.ttvnw.net/high/${login}.m3u8\nhttps://video.ttvnw.net/low/${login}.m3u8\n`);
  }
  if (target.includes("video.ttvnw.net") && target.endsWith(".m3u8")) {
    const login = /\/(\w+)\.m3u8/.exec(target)[1];
    assert.ok(target.includes("/low/"), "самое лёгкое качество");
    if (!channels[login]?.live) return new Response("", { status: 404 });
    watched.push(login);
    return new Response(`#EXTM3U\nhttps://video.ttvnw.net/seg/${login}/1.ts\nhttps://video.ttvnw.net/seg/${login}/2.ts\n`);
  }
  if (target.includes("video.ttvnw.net/seg/")) {
    heads.push(init.method);
    return new Response(null, { status: 200 });
  }
  if (target.includes("spade")) {
    pings.push(target);
    return new Response(null, { status: 204 });
  }
  if (target.includes("gql.twitch.tv")) {
    const body = JSON.parse(init.body);
    const vars = body.variables || {};
    if (body.operationName === "VideoPlayerStreamInfoOverlayChannel") {
      const info = channels[vars.channel];
      const user = info?.live
        ? { id: `id-${vars.channel}`, login: vars.channel, stream: { id: `b-${vars.channel}` }, broadcastSettings: { game: { id: "g", name: "Game" } } }
        : { id: "x", login: vars.channel, stream: null };
      return json({ data: { user } });
    }
    if (body.operationName === "PlaybackAccessToken") {
      return json({ data: { streamPlaybackAccessToken: { value: `t-${vars.login}`, signature: "sig" } } });
    }
    if (body.operationName === "ChannelPointsContext") {
      asked.push(vars.channelLogin);
      const info = channels[vars.channelLogin];
      const mine = { balance: info.balance, availableClaim: info.claim ? { id: info.claim } : null };
      return json({ data: { community: { id: `id-${vars.channelLogin}`, channel: { communityPointsSettings: { isEnabled: true }, self: { communityPoints: mine } } } } });
    }
    if (body.operationName === "ClaimCommunityPoints") {
      claims.push(vars.input);
      const info = Object.values(channels).find((item) => item.claim === vars.input.claimID);
      info.balance += 50;
      info.claim = "";
      return json({ data: { claimCommunityPoints: { claim: { pointsEarnedTotal: 50 }, currentPoints: info.balance, error: null } } });
    }
  }
  return json({}, 404);
};

const points = await import("../lib/points.js");
// Баллы Twitch в сборке отключены флагом; здесь проверяется сам код, поэтому он включён.
const { FEATURES } = await import("../lib/constants.js");
FEATURES.twitchPoints = true;
const client = await import("../lib/client.js");
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
// Сдвиг времени, чтобы «прошло пять минут».
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const minutes = (count) => { shift += count * 60 * 1000; };

function reset() {
  store.local = { state: { enabled: true, watching: null }, points: { enabled: true } };
  store.session = {};
  for (const list of [claims, watched, pings, heads, asked, opened]) list.length = 0;
  channels = {};
}
const add = (logins) => points.replacePoints(logins.map((login) => ({ login, id: `id-${login}`, name: login.toUpperCase(), image: "" })));

test("drops watch without video: lowest-quality playlist, HEAD on every segment, nothing downloaded", async () => {
  reset();
  channels = { one: { live: true } };
  const auth = { token: "tok", userId: "1", deviceId: "dev" };
  const stream = { login: "one", channelId: "id-one", broadcastId: "b-one" };
  assert.equal(await client.sendWatch(auth, stream), true);
  assert.deepEqual(watched, ["one"]);
  assert.deepEqual(heads, ["HEAD", "HEAD"]);
  channels.one.live = false;                                 // эфир кончился: плейлист отдаёт 404
  assert.equal(await client.sendWatch(auth, stream), false);
});

test("no channels picked: nothing is requested", async () => {
  reset();
  await points.pointsTick();
  assert.equal(asked.length, 0);
});

test("bonus on a picked live channel is claimed and logged; nothing is watched, no tab is opened", async () => {
  reset();
  channels = { one: { live: true, balance: 100, claim: "c-1" }, two: { live: false, balance: 5 }, other: { live: true, balance: 9, claim: "c-x" } };
  await add(["one", "two"]);
  const state = await points.pointsTick();
  assert.deepEqual(claims, [{ channelID: "id-one", claimID: "c-1" }]);      // other не выбран: его бонус не трогаем
  assert.equal(state.status.one.balance, 150);
  assert.equal(state.status.one.lastGain, 50);
  assert.equal(state.status.one.live, true);
  assert.equal(state.status.two.live, false);
  assert.equal(state.status.two.balance, 5);                 // баланс офлайн-канала читаем один раз
  // Главное: баллы не мешают дропам. Ни плейлистов, ни minute-watched, ни вкладок.
  assert.deepEqual(watched, []);
  assert.deepEqual(pings, []);
  assert.deepEqual(heads, []);
  assert.deepEqual(opened, []);
  const history = store.local.history;
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].kind, history[0].platform, history[0].account, history[0].name, history[0].game], ["points", "twitch", "alice", "+50", "ONE"]);
});

test("checks run once in five minutes, not every minute", async () => {
  reset();
  channels = { a: { live: true, balance: 10 } };
  await add(["a"]);
  await points.pointsTick();
  assert.deepEqual(asked, ["a"]);
  minutes(1); await points.pointsTick();
  minutes(1); await points.pointsTick();
  minutes(2); await points.pointsTick();
  assert.deepEqual(asked, ["a"]);                            // 4 минуты: ещё рано
  channels.a.claim = "c-a";
  minutes(1.1);
  const state = await points.pointsTick();                   // пять минут прошло
  assert.deepEqual(asked, ["a", "a"]);
  assert.equal(claims.length, 1);
  assert.equal(state.status.a.balance, 60);
});

test("every picked channel is checked, no limit of two", async () => {
  reset();
  channels = { a: { live: true, balance: 1, claim: "c-a" }, b: { live: true, balance: 2, claim: "c-b" }, c: { live: true, balance: 3, claim: "c-c" } };
  await add(["a", "b", "c"]);
  await points.pointsTick();
  assert.deepEqual(claims.map((item) => item.claimID), ["c-a", "c-b", "c-c"]);
});

test("offline channel with a known balance is not asked again", async () => {
  reset();
  channels = { a: { live: false, balance: 7 } };
  await add(["a"]);
  await points.pointsTick();
  assert.deepEqual(asked, ["a"]);
  minutes(6);
  await points.pointsTick();
  assert.deepEqual(asked, ["a"]);
  channels.a.live = true;
  minutes(6);
  await points.pointsTick();
  assert.deepEqual(asked, ["a", "a"]);
});

test("changing the list checks at once; miner or points switched off: nothing is sent", async () => {
  reset();
  channels = { a: { live: true, balance: 1, claim: "c-a" }, b: { live: true, balance: 2 } };
  await add(["a"]);
  await points.pointsTick();
  await points.setPointsChannels([{ login: "a", id: "id-a", name: "A" }, { login: "b", id: "id-b", name: "B" }]);
  await pause();
  let state = await points.readPoints();
  assert.deepEqual(Object.keys(state.status), ["a", "b"]);   // новый канал проверен сразу
  await points.setPointsChannels([{ login: "b", id: "id-b", name: "B" }]);
  await pause();
  state = await points.readPoints();
  assert.deepEqual(Object.keys(state.status), ["b"]);        // убранный канал выпал из статусов
  await points.setPointsEnabled(false);
  await pause();
  asked.length = 0;
  minutes(6);
  await points.pointsTick();
  await points.setPointsEnabled(true);
  await pause();
  asked.length = 0;
  store.local.state.enabled = false;
  minutes(6);
  await points.pointsTick();
  assert.deepEqual(asked, []);
});

test("player tabs left by the unreleased build are closed once", async () => {
  reset();
  store.local.pointsTabs = { a: 41, b: 42 };
  await points.pointsTick();
  assert.deepEqual(opened, ["closed 41", "closed 42"]);
  assert.equal(store.local.pointsTabs, undefined);
});

test("points are off by default: nothing is requested until the user turns them on", async () => {
  reset();
  delete store.local.points;
  channels = { a: { live: true, balance: 1, claim: "c-a" } };
  await add(["a"]);
  await points.pointsTick();
  assert.equal((await points.readPoints()).enabled, false);
  assert.deepEqual(asked, []);
  assert.deepEqual(claims, []);
  await points.setPointsEnabled(true);
  await pause();
  assert.deepEqual(claims.map((item) => item.claimID), ["c-a"]);
});

test("the channel a drop is farmed on is checked too, without being in the list", async () => {
  reset();
  channels = { picked: { live: true, balance: 5 }, dropchan: { live: true, balance: 40, claim: "c-d" } };
  await add(["picked"]);
  store.local.state.watching = { login: "DropChan", channelId: "id-dropchan" };
  let state = await points.pointsTick();
  assert.deepEqual(asked, ["picked", "dropchan"]);
  assert.deepEqual(claims, [{ channelID: "id-dropchan", claimID: "c-d" }]);
  assert.equal(state.status.dropchan.drop, true);
  assert.equal(state.status.dropchan.balance, 90);
  assert.equal(state.status.picked.drop, false);
  assert.equal(store.local.history[0].game, "DropChan");
  assert.deepEqual(state.channels.map((channel) => channel.login), ["picked"]);   // в список пользователя не попадает
  assert.deepEqual(watched, []);                             // и никакого «просмотра» ради баллов
  // Дроп перешёл на другой канал: проверяем его сразу, прежний выпадает.
  channels.next = { live: true, balance: 3 };
  store.local.state.watching = { login: "next", channelId: "id-next" };
  minutes(1);
  state = await points.pointsTick();
  assert.deepEqual(Object.keys(state.status), ["picked", "next"]);
  // Дроп не фармится: остаются только выбранные каналы.
  store.local.state.watching = null;
  minutes(6);
  state = await points.pointsTick();
  assert.deepEqual(Object.keys(state.status), ["picked"]);
});

test("no picked channels: the drop channel alone is still checked", async () => {
  reset();
  channels = { dropchan: { live: true, balance: 7, claim: "c-d" } };
  store.local.state.watching = { login: "dropchan", channelId: "id-dropchan" };
  const state = await points.pointsTick();
  assert.equal(claims.length, 1);
  assert.equal(state.status.dropchan.balance, 57);
});

test("игра, добавленная по названию, выбирается сама, когда у неё появляется кампания", async () => {
  const { wishedGames } = await import("../lib/miner.js");
  const summaries = [
    { game: { id: "10", name: "Rust" } },
    { game: { id: "10", name: "Rust" } },
    { game: { id: "20", name: "Skull and Bones" } },
    { game: { id: "30", name: "Dota 2" } },
  ];
  assert.deepEqual(wishedGames([" rust ", "SKULL AND BONES", "Нет такой"], summaries, ["20"]), ["10"]);
  assert.deepEqual(wishedGames([], summaries, []), []);
  assert.deepEqual(wishedGames(["Dota 2"], [], []), []);
});

test("баллы Twitch отключены флагом: ничего не запрашивается, старые вкладки закрываются", async () => {
  reset();
  FEATURES.twitchPoints = false;
  try {
    channels = { one: { live: true, balance: 10, claim: "c1" } };
    await add(["one"]);
    store.local.pointsTabs = { one: 7 };
    await points.pointsTick();
    assert.deepEqual(asked, []);
    assert.deepEqual(claims, []);
    assert.deepEqual(opened, ["closed 7"]);
  } finally {
    FEATURES.twitchPoints = true;
  }
});

test("старый номер вкладки достался чужой вкладке: её не закрываем", async () => {
  opened.length = 0;
  store.local.pointsTabs = { one: 99 };
  await points.pointsTick();
  assert.equal(store.local.pointsTabs, undefined);
  assert.ok(!opened.includes("closed 99"));
});
