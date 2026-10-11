// node --test tests/  — lib/remote.js: самопочинка хэшей persisted-query.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {} };
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in store.local ? { [key]: structuredClone(store.local[key]) } : {}),
      set: async (value) => Object.assign(store.local, structuredClone(value)),
    },
  },
};

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

// Какие хэши Twitch «знает», и что лежит в двух источниках.
let alive = new Set();
let config = "";
let upstream = "";
let down = false;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const address = String(url);
  calls.push(address);
  if (address.includes("gql.twitch.tv")) {
    if (down) throw new Error("Failed to fetch");
    const hash = JSON.parse(init.body).extensions.persistedQuery.sha256Hash;
    return new Response(alive.has(hash) ? '{"data":{"currentUser":null}}' : '{"errors":[{"message":"PersistedQueryNotFound"}]}');
  }
  if (address.includes("config.json")) return new Response(config, { status: config ? 200 : 404 });
  return new Response(upstream, { status: upstream ? 200 : 404 });
};

const constants = await import("../lib/constants.js");
const remote = await import("../lib/remote.js");
const original = constants.gqlHashes();

function reset() {
  store.local = {};
  constants.setGqlHashes(original);
  alive = new Set(Object.values(original));
  config = "";
  upstream = "";
  down = false;
  calls.length = 0;
}

test("parseUpstream reads operation names and hashes from constants.py", () => {
  const text = `"Inventory": GQLPersistedQuery(\n        "Inventory",\n        "${A}",\n        variables={}),\n"X": GQLPersistedQuery("Other", "short")`;
  assert.deepEqual(remote.parseUpstream(text), { Inventory: A });
});

test("parseConfig keeps only 64-hex strings", () => {
  assert.deepEqual(remote.parseConfig({ hashes: { Inventory: A, Bad: "<script>", Short: "abc" } }), { Inventory: A });
});

test("setGqlHashes ignores unknown operations and bad values", () => {
  reset();
  constants.setGqlHashes({ Inventory: "zz", Unknown: A });
  assert.deepEqual(constants.gqlHashes(), original);
  constants.setGqlHashes({ Inventory: A });
  assert.equal(constants.qInventory().extensions.persistedQuery.sha256Hash, A);
  reset();
});

test("all hashes alive: nothing changes", async () => {
  reset();
  upstream = `GQLPersistedQuery("Inventory", "${A}")`;
  alive.add(A);
  const state = await remote.refreshHashes(true);
  assert.deepEqual(state.hashes, {});
  assert.deepEqual(state.broken, []);
  assert.deepEqual(constants.gqlHashes(), original);
});

test("dead hash is replaced by a working one from upstream and survives a restart", async () => {
  reset();
  alive.delete(original.Inventory);
  alive.add(A);
  upstream = `GQLPersistedQuery("Inventory", "${A}")`;
  const state = await remote.refreshHashes(true);
  assert.deepEqual(state.hashes, { Inventory: A });
  assert.equal(constants.gqlHashes().Inventory, A);
  assert.equal(store.local.remote.hashes.Inventory, A);
  // Перезапуск фонового скрипта: в коде снова старый хэш, сохранённый применяется из хранилища.
  constants.setGqlHashes(original);
  assert.deepEqual(remote.parseConfig(store.local.remote), { Inventory: A });
  // Обновление расширения: находка прежней версии не перекрывает хэши новой.
  store.local.remote.version = "0.0.1";
  alive.add(original.Inventory);
  const state2 = await remote.refreshHashes(true);
  assert.deepEqual(state2.hashes, {});
});

test("dead hash, upstream candidate is dead too: reported as broken, nothing applied", async () => {
  reset();
  alive.delete(original.Inventory);
  upstream = `GQLPersistedQuery("Inventory", "${A}")`;
  const state = await remote.refreshHashes(true);
  assert.deepEqual(state.broken, ["Inventory"]);
  assert.equal(constants.gqlHashes().Inventory, original.Inventory);
});

test("own config goes before upstream, and no source replaces a live hash", async () => {
  reset();
  alive.add(B).add(C);
  config = JSON.stringify({ hashes: { Inventory: B } });
  upstream = `GQLPersistedQuery("Inventory", "${C}")`;
  // Хэш жив: чужой живой хэш (например, перепутанный в конфиге) его не заменяет.
  assert.deepEqual((await remote.refreshHashes(true)).hashes, {});
  reset();
  alive.add(B).add(C);
  alive.delete(original.Inventory);
  config = JSON.stringify({ hashes: { Inventory: B } });
  upstream = `GQLPersistedQuery("Inventory", "${C}")`;
  assert.equal((await remote.refreshHashes(true)).hashes.Inventory, B);
});

test("operations of switched-off features are not probed; a hash that stays broken is retried less often", async () => {
  reset();
  alive.delete(original.ChannelPointsContext);
  alive.delete(original.Inventory);
  const state = await remote.refreshHashes(true);
  assert.deepEqual(state.broken, ["Inventory"]);
  assert.equal(state.fails, 1);
  const first = calls.length;
  // Вторая неудачная попытка — не раньше чем через 20 минут.
  store.local.remote.triedAt = Date.now() - 11 * 60 * 1000;
  await remote.refreshHashes(true);
  assert.equal(calls.length, first);
  store.local.remote.triedAt = Date.now() - 21 * 60 * 1000;
  await remote.refreshHashes(true);
  assert.ok(calls.length > first);
});

test("Twitch unreachable: nothing is replaced and nothing is called broken", async () => {
  reset();
  down = true;
  upstream = `GQLPersistedQuery("Inventory", "${A}")`;
  const state = await remote.refreshHashes(true);
  assert.deepEqual(state.hashes, {});
  assert.deepEqual(state.broken, []);
});

test("rate limits: once a day on schedule, once in 10 minutes when urgent", async () => {
  reset();
  await remote.refreshHashes(false);
  const first = calls.length;
  assert.ok(first > 0);
  store.local.remote.triedAt = Date.now() - 11 * 60 * 1000;
  await remote.refreshHashes(false);
  assert.equal(calls.length, first, "scheduled check waits a day");
  await remote.refreshHashes(true);
  assert.ok(calls.length > first, "urgent check runs after 10 minutes");
  const second = calls.length;
  await remote.refreshHashes(true);
  assert.equal(calls.length, second, "and not again within 10 minutes");
});
