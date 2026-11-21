// node --experimental-test-module-mocks --test tests/solo-twitch.test.mjs — настоящий lib/miner.js с
// подменённым сетевым слоем lib/client.js: приоритет соло-режима, клейм чужих дропов, память игры.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const calls = [];
let summaries = [];
let inventory = [];
let streamGame = { id: "111", name: "Rust" };
let rewardAnswer = false;

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        if (key == null) return { ...store.local };
        const keys = Array.isArray(key) ? key : [key];
        return structuredClone(Object.fromEntries(keys.filter((name) => name in store.local).map((name) => [name, store.local[name]])));
      },
      set: async (value) => Object.assign(store.local, structuredClone(value)),
      remove: async (key) => { delete store.local[key]; },
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  action: {
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async () => {},
    setTitle: async () => {},
  },
  tabs: { query: async () => [] },
  scripting: { executeScript: async () => [] },
};

const campaign = (id, game, drops) => ({
  id, name: `${game.name} drops`, status: "ACTIVE", linked: true, linkUrl: "",
  startsAt: 0, endsAt: Date.now() + 86400000, image: "",
  game: { id: game.id, name: game.name, slug: game.slug, image: "" },
  channels: [], drops: drops.map((drop) => ({ ...drop, campaignId: id, campaignName: `${game.name} drops`, game })),
});

const drop = (id, name, required, current) => ({
  id, name, image: "", campaignImage: "", benefits: [name], benefitIds: [],
  required, current, claimed: false, claimId: `claim-${id}`, preconditionIds: [], subs: 0,
  startsAt: 0, endsAt: 0, channels: [], linked: true, linkUrl: "",
});

const rust = { id: "111", name: "Rust", slug: "rust" };
const dota = { id: "222", name: "Dota 2", slug: "dota-2" };

function clientMock() {
  return {
    CONNECT_URL: "https://twitch.tv/drops/campaigns",
    INVENTORY_URL: "https://twitch.tv/drops/inventory",
    listCampaigns: async () => summaries,
    hydrateCampaigns: async (_auth, chosen) => chosen,
    applyInventory: async () => {},
    claimDrop: async (_auth, drop) => {
      calls.push({ what: "claimDrop", id: drop.id, campaign: drop.campaignId });
      return "claimed";
    },
    // Reward-сундуки в соло не участвуют, но lib/miner.js импортирует claimReward.
    claimReward: async (_auth, drop, opts) => { calls.push({ what: "claimReward", id: drop.id, auto: opts?.auto }); return rewardAnswer; },
    currentDrop: async () => null,
    discoverSpadeUrl: async () => "https://spade.twitch.tv/track",
    readInventory: async () => inventory,
    gameDirectory: async (_auth, slug) => {
      calls.push({ what: "directory", slug });
      return [{ login: "alice", channelId: "1", broadcastId: "b1", viewers: 10, game: rust }];
    },
    gameSlug: (game) => game?.slug || String(game?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    getStream: async (_auth, login) => ({ login, channelId: "1", broadcastId: "b1", viewers: 10, title: "", game: streamGame }),
    channelCampaignIds: async () => new Set(["c1"]),
    channelHasDrops: async () => true,
    readAuth: async () => ({ userId: "1", login: "me", token: "tok", plain: false }),
    resetSession: async () => {},
    sameGame: (left, right) => Boolean(left && right && (String(left.id) === String(right.id) || String(left.name).toLowerCase() === String(right.name).toLowerCase())),
    sendMinuteWatched: async () => ({ ok: true, status: 200, via: "playlist" }),
    sendWatch: async () => true,
  };
}

async function boot(t, settings) {
  calls.length = 0;
  rewardAnswer = false;
  store.local = { settings, state: { enabled: true, lang: "ru" } };
  t.mock.module("../lib/client.js", { namedExports: clientMock() });
  t.mock.module("../lib/accounts.js", { namedExports: { noteCampaignDone: async () => {} } });
  const miner = await import(`../lib/miner.js?test=${Date.now()}@${Math.random()}`);
  return miner;
}

test("solo: дроп игры в приоритете, остальные игры не читаются", async (t) => {
  summaries = [
    campaign("c1", rust, [drop("r1", "Skin", 60, 10)]),
    campaign("c2", dota, [drop("d1", "Ward", 30, 5)]),
  ];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  const state = await miner.tick("test");
  assert.equal(state.watching.solo, true);
  assert.equal(state.watching.dropId, "r1");
  assert.equal(state.watching.login, "alice");
  assert.deepEqual(state.queue.map((row) => row.game), ["Rust"]);
  assert.ok(!calls.some((call) => call.what === "directory" && call.slug === "dota-2"), "чужая игра не фармится");
});

test("solo: у игры нет кампаний — берём сохранённые имя и slug, эфир находится", async (t) => {
  summaries = [campaign("c2", dota, [drop("d1", "Ward", 30, 5)])];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  // Прошлый проход запомнил игру; текущий её уже не видит в summaries.
  store.local.state = {
    enabled: true, lang: "ru", soloGameId: "111", soloGameName: "Rust", soloGameSlug: "rust", queue: [],
  };
  const state = await miner.tick("test");
  assert.equal(state.watching.solo, true);
  assert.equal(state.watching.game, "Rust", "не сырой id");
  assert.ok(calls.some((call) => call.what === "directory" && call.slug === "rust"), "каталог запрошен по slug");
});

test("solo: смена аккаунта не теряет выбранную игру", async (t) => {
  summaries = [];
  const miner = await boot(t, { soloTwitch: "111" });
  store.local.state = {
    enabled: true, lang: "ru", soloGameId: "111", soloGameName: "Rust", soloGameSlug: "rust", queue: [],
  };
  await miner.resetForAccount([]);
  // resetForAccount ничего не возвращает: смотрим, что записалось в состояние.
  assert.equal(store.local.state.soloGameName, "Rust");
  assert.equal(store.local.state.soloGameSlug, "rust");
});

test("solo: клик по дропу другой игры объясняет, почему он не берётся", async (t) => {
  summaries = [];
  const miner = await boot(t, { soloTwitch: "111" });
  store.local.state = {
    enabled: true, lang: "ru", soloGameName: "Rust",
    queue: [{ id: "d9", name: "Ward", game: "Dota 2", gameId: "222", required: 30, current: 5, claimed: false }],
  };
  const state = await miner.watchDrop("d9");
  assert.match(state.message, /soloIgnored/, "пользователь видит, почему клик не сработал");
  assert.equal(state.preferDropId, undefined, "выбор не поставлен");
});

test("solo: готовый дроп другой игры забирается, хоть и не смотрится", async (t) => {
  summaries = [
    campaign("c1", rust, [drop("r1", "Skin", 60, 10)]),
    campaign("c2", dota, [drop("d1", "Ward", 30, 30)]),
  ];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  store.local.state = {
    enabled: true, lang: "ru",
    queue: [{
      id: "d1", name: "Ward", game: "Dota 2", gameId: "222", campaignId: "c2", campaignName: "Dota 2 drops",
      required: 30, current: 30, claimed: false, claimId: "claim-d1", benefits: ["Ward"], image: "",
    }],
  };
  const state = await miner.tick("test");
  const claim = calls.find((call) => call.what === "claimDrop" && call.id === "d1");
  assert.ok(claim, "готовый дроп другой игры ушёл в клейм");
  assert.equal(state.watching.dropId, "r1");
  const history = store.local.history || [];
  assert.ok(history.some((item) => item.name === "Ward"), "клейм попал в историю");
  assert.ok(!state.queue.some((row) => row.id === "d1"), "забранный уходит из очереди");
});

test("solo: готовый сундук другой игры идёт через claimReward, а не claimDrop", async (t) => {
  summaries = [
    campaign("c1", rust, [drop("r1", "Skin", 60, 10)]),
    campaign("rw", dota, [drop("g1", "Chest", 60, 60)]),
  ];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  store.local.state = {
    enabled: true, lang: "ru",
    queue: [{
      id: "g1", name: "Chest", game: "Dota 2", gameId: "222", campaignId: "rw", campaignName: "Reward",
      required: 60, current: 60, claimed: false, claimId: "", benefits: ["Chest"], image: "",
      kind: "reward", status: "CLAIMABLE", repeatableTimes: 6, grantCount: 0,
    }],
  };
  await miner.tick("test");
  const reward = calls.find((call) => call.what === "claimReward" && call.id === "g1");
  assert.ok(reward, "сундук ушёл в claimReward");
  assert.equal(reward.auto, false, "без настройки автовыбор выключен");
  assert.ok(!calls.some((call) => call.what === "claimDrop" && call.id === "g1"), "claimDrop для сундука не зовётся");
});

test("solo: автовыбор награды из сундука передаётся в claimReward", async (t) => {
  summaries = [
    campaign("c1", rust, [drop("r1", "Skin", 60, 10)]),
    campaign("rw", dota, [drop("g1", "Chest", 60, 60)]),
  ];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111", autoRewardChoice: true });
  store.local.state = {
    enabled: true, lang: "ru",
    queue: [{
      id: "g1", name: "Chest", game: "Dota 2", gameId: "222", campaignId: "rw", campaignName: "Reward",
      required: 60, current: 60, claimed: false, claimId: "", benefits: ["Chest"], image: "",
      kind: "reward", status: "CLAIMABLE", repeatableTimes: 6, grantCount: 0,
    }],
  };
  await miner.tick("test");
  const reward = calls.find((call) => call.what === "claimReward" && call.id === "g1");
  assert.ok(reward, "сундук ушёл в claimReward");
  assert.equal(reward.auto, true, "включённая настройка доходит до claimReward");
});

test("solo: значок другой игры не клеймится как обычный дроп", async (t) => {
  summaries = [
    campaign("c1", rust, [drop("r1", "Skin", 60, 10)]),
    campaign("bd", dota, [drop("b1", "Badge", 15, 15)]),
  ];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  store.local.state = {
    enabled: true, lang: "ru",
    queue: [{
      id: "b1", name: "Badge", game: "Dota 2", gameId: "222", campaignId: "bd", campaignName: "Badges",
      required: 15, current: 15, claimed: false, claimId: "", benefits: ["Badge"], image: "", badge: true,
    }],
  };
  await miner.tick("test");
  assert.ok(!calls.some((call) => call.what === "claimDrop" && call.id === "b1"), "claimDrop для значка не зовётся");
  assert.ok(Object.keys(store.local.badgeDrops || {}).some((key) => key.endsWith(":b1")), "значок отмечен выданным");
});

test("solo: сундук с выбором награды попадает в подсказку попапа и в журнал один раз", async (t) => {
  summaries = [
    campaign("c1", rust, [drop("r1", "Skin", 60, 10)]),
    campaign("rw", dota, [drop("g1", "Chest", 60, 60)]),
  ];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  rewardAnswer = "choice";
  const row = {
    id: "g1", name: "Chest", game: "Dota 2", gameId: "222", campaignId: "rw", campaignName: "Reward",
    required: 60, current: 60, claimed: false, claimId: "", benefits: ["Chest"], image: "",
    kind: "reward", status: "CLAIMABLE", repeatableTimes: 6, grantCount: 0,
  };
  store.local.state = { enabled: true, lang: "ru", queue: [row] };
  const first = await miner.tick("test");
  assert.deepEqual(first.rewardChoice.map((item) => item.id), ["g1"]);
  const lines = (state) => (state.log || []).filter((line) => /rewardChoiceLog/.test(line.text)).length;
  assert.equal(lines(first), 1);
  store.local.state = { ...store.local.state, queue: [row] };
  const second = await miner.tick("test");
  assert.equal(lines(second), 1, "повторный проход не дублирует строку журнала");
  rewardAnswer = "claimed";
  store.local.state = { ...store.local.state, queue: [row] };
  const third = await miner.tick("test");
  assert.deepEqual(third.rewardChoice, [], "выбор сделан — подсказка пропадает");
});

test("solo: значковая кампания со ссылкой на twitch.tv и игра во второй категории reward-кампании", async (t) => {
  const miner = await boot(t, { soloTwitch: "111" });
  const self = { id: "b", linked: false, selfLink: true, game: { id: "111" } };
  const other = { id: "x", linked: false, selfLink: false, game: { id: "111" } };
  const multi = { id: "m", kind: "reward", linked: true, game: { id: "999" }, games: [{ id: "999" }, { id: "111" }] };
  assert.deepEqual(miner.soloCampaigns([self, other, multi], "111").map((item) => item.id), ["b", "m"]);
});

test("solo: кампания со ссылкой на twitch.tv, непривязанная у основного, всё равно идёт в каталог другим аккаунтам", async (t) => {
  const self = { ...campaign("sl", rust, [drop("s1", "Gear", 60, 0)]), linked: false, selfLink: true };
  summaries = [self];
  inventory = [];
  streamGame = rust;
  const miner = await boot(t, { soloTwitch: "111" });
  miner.wantSideGames(["111"], true);
  const state = await miner.tick("test");
  assert.ok(!state.queue.some((row) => row.id === "s1"), "основной её не фармит: не привязана");
  assert.ok(miner.readCatalog().campaigns.some((item) => item.id === "sl"), "но в каталоге для других аккаунтов она есть");
});

test("general drops: the first game has no streams — the miner moves on to the next game", async (t) => {
  // Clover (PAYDAY 3) без эфиров стоял первым, и майнер вставал в no-channel, хотя у OSRS эфиры были.
  const payday = { id: "333", name: "PAYDAY 3", slug: "payday-3" };
  const osrs = { id: "444", name: "Old School RuneScape", slug: "old-school-runescape" };
  calls.length = 0;
  t.mock.module("../lib/client.js", { namedExports: {
    ...clientMock(),
    gameDirectory: async (_auth, slug) => {
      calls.push({ what: "directory", slug });
      return slug === "old-school-runescape" ? [{ login: "osrsguy", channelId: "9", broadcastId: "b9", viewers: 5, game: osrs }] : [];
    },
    getStream: async (_auth, login) => (login === "osrsguy"
      ? { login, channelId: "9", broadcastId: "b9", viewers: 5, title: "", game: osrs } : null),
  } });
  t.mock.module("../lib/accounts.js", { namedExports: { noteCampaignDone: async () => {} } });
  store.local = { settings: {}, state: { enabled: true } };
  const miner = await import(`../lib/miner.js?general=${Date.now()}`);
  const campaigns = [
    campaign("cl", payday, [drop("clover", "Clover", 30, 0)]),
    campaign("rs", osrs, [drop("bones", "Bones", 60, 0)]),
  ];
  const target = await miner.chooseTarget({ userId: "1", login: "me" }, campaigns, Date.now(), {});
  assert.equal(target.drop?.id, "bones", "следующая игра с эфиром");
  assert.equal(target.stream?.login, "osrsguy");
  // Игру без эфиров следующий проход не опрашивает заново (5 минут).
  calls.length = 0;
  await miner.chooseTarget({ userId: "1", login: "me" }, campaigns, Date.now(), {});
  assert.ok(!calls.some((call) => call.slug === "payday-3"), "PAYDAY 3 пропущен до истечения паузы");
});
