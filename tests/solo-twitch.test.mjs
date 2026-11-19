// node --experimental-test-module-mocks --test tests/solo-twitch.test.mjs — настоящий lib/miner.js с
// подменённым сетевым слоем lib/client.js: приоритет соло-режима, клейм чужих дропов, память игры.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const calls = [];
let summaries = [];
let inventory = [];
let streamGame = { id: "111", name: "Rust" };

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
