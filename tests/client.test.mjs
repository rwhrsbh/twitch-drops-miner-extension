// node --test tests/  — lib/client.js: запросы, которые Twitch меняет без предупреждения.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const area = (bag) => ({
  get: async (key) => (key in bag() ? { [key]: structuredClone(bag()[key]) } : {}),
  set: async (value) => Object.assign(bag(), structuredClone(value)),
  remove: async (key) => { delete bag()[key]; },
});
globalThis.chrome = { storage: { local: area(() => store.local), session: area(() => store.session) } };

// Twitch находит пользователя в DropCampaignDetails только по тому полю, что указано в accepts.
let accepts = "id";
const asked = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body);
  if (body.operationName !== "DropCampaignDetails") return new Response('{"data":{}}');
  asked.push(body.variables.channelLogin);
  const known = accepts === "id" ? "42" : "alice";
  if (body.variables.channelLogin !== known) return new Response('{"data":{"user":null}}');
  const campaign = {
    id: body.variables.dropID,
    name: "C",
    status: "ACTIVE",
    game: { id: "7", displayName: "Game" },
    self: { isAccountConnected: true },
    timeBasedDrops: [{ id: "d1", name: "Drop", requiredMinutesWatched: 60, benefitEdges: [] }],
  };
  return new Response(JSON.stringify({ data: { user: { id: "42", dropCampaign: campaign } } }));
};

const client = await import("../lib/client.js");
const auth = { token: "t", login: "alice", userId: "42", deviceId: "d", plain: true };

test("campaign details: asked by user id; a login-only Twitch still works and is remembered", async () => {
  asked.length = 0;
  assert.equal((await client.hydrateCampaigns(auth, [{ id: "c1" }])).length, 1);
  assert.deepEqual(asked, ["42"]);
  accepts = "login";
  asked.length = 0;
  assert.equal((await client.hydrateCampaigns(auth, [{ id: "c1" }, { id: "c2" }])).length, 2);
  assert.deepEqual(asked, ["42", "alice", "alice"], "после первого промаха сразу спрашивает логином");
});
