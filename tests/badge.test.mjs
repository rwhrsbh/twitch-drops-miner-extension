// node --test tests/badge.test.mjs — значок чата Twitch: клейма нет, отметка майнера.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const area = (bag) => ({
  get: async (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in bag()) out[key] = structuredClone(bag()[key]);
    return out;
  },
  set: async (value) => Object.assign(bag(), structuredClone(value)),
  remove: async (key) => { delete bag()[key]; },
});
globalThis.chrome = { storage: { local: area(() => store.local), session: area(() => store.session) } };

let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return new Response('{"data":{}}');
};

const miner = await import("../lib/miner.js");
const history = await import("../lib/history.js");

const auth = { login: "alice", userId: "42" };
const campaign = () => ({
  id: "c1",
  name: "Jordan x Space Jam",
  game: { id: "g1", name: "Grand Theft Auto VI" },
  drops: [{
    id: "d1",
    name: "Jordan x Space Jam TCSD",
    benefits: ["Jordan x Space Jam TCSD"],
    image: "",
    required: 15,
    current: 15,
    claimed: false,
    badge: true,
    campaignId: "c1",
  }],
});

test("badge drop: the miner marks it itself, nothing is claimed over the network", async () => {
  const first = campaign();
  const out = await miner.claimReady(auth, [first], "en");
  assert.deepEqual(out, { claimed: ["Jordan x Space Jam TCSD (Grand Theft Auto VI)"], failed: [] });
  assert.equal(first.drops[0].claimed, true);
  assert.equal(calls, 0);
  const hist = await history.readHistory();
  assert.equal(hist[0].name, "Jordan x Space Jam TCSD");
  assert.equal(hist[0].platform, "twitch");
  assert.equal(hist[0].game, "Grand Theft Auto VI");

  // Детали кампании у значка навсегда говорят «не забран»; отметка майнера важнее,
  // иначе значок фармился бы заново каждый проход (проблема TwitchDropsMiner #916).
  const again = campaign();
  const second = await miner.claimReady(auth, [again], "en");
  assert.deepEqual(second, { claimed: [], failed: [] });
  assert.equal(again.drops[0].claimed, true);
  assert.equal(calls, 0);
});

test("normal tick: badge at 100% is claimed through claimQueueExtras", async () => {
  // Обычный проход раньше пропускал значки в claimQueue и не звал claimReady, поэтому
  // выфармленный значок висел в очереди со ста процентами до перезапуска расширения.
  const row = {
    id: "d2", name: "Haunter", game: "Pokemon Evolutions", gameId: "g2",
    required: 15, current: 15, claimed: false, badge: true, campaignId: "c2", image: "",
  };
  const out = await miner.claimQueueExtras(auth, [row], "en");
  assert.deepEqual(out, { claimed: ["Haunter (Pokemon Evolutions)"], failed: [], changed: true });
  assert.equal(row.claimed, true);
  assert.equal(calls, 0);

  // Повторно тот же значок уже не клеймится: отметка майнера живёт в badgeDrops.
  // changed остаётся true, чтобы проход сохранил обновлённую строку очереди.
  const again = { ...row, claimed: false };
  const second = await miner.claimQueueExtras(auth, [again], "en");
  assert.deepEqual(second, { claimed: [], failed: [], changed: true });
  assert.equal(again.claimed, true);
  assert.equal(calls, 0);
});

test("reward-group badge (BADGE, status stays IN_PROGRESS): done once minutes >= required", async () => {
  // Pokemon Evolutions: Twitch выдаёт значок сам и не переводит группу в CLAIMABLE.
  const base = {
    kind: "reward", badge: true, status: "IN_PROGRESS", game: "Pokemon Evolutions", gameId: "g3",
    required: 20, claimed: false, campaignId: "c3", image: "",
  };
  const exact = { ...base, id: "r1", name: "Gengar", current: 20 };
  const over = { ...base, id: "r2", name: "Haunter", current: 56 };
  const short = { ...base, id: "r3", name: "Pikachu", current: 19 };
  const out = await miner.claimQueueExtras(auth, [exact, over, short], "en");
  assert.deepEqual(out.claimed, ["Gengar (Pokemon Evolutions)", "Haunter (Pokemon Evolutions)"]);
  assert.equal(exact.claimed, true);
  assert.equal(over.claimed, true);
  assert.equal(short.claimed, false);
  assert.equal(calls, 0);
});

test("stale saved rows (badge false) of a stuck reward group are still closed by the tick", async () => {
  const base = {
    kind: "reward", badge: false, game: "Pokemon", gameId: "g4", required: 20, claimed: false,
    campaignId: "c4", image: "",
  };
  const stuck = { ...base, id: "s1", name: "Charizard", status: "IN_PROGRESS", current: 56 };
  const justDone = { ...base, id: "s2", name: "Venusaur", status: "IN_PROGRESS", current: 20 };
  const chest = { ...base, id: "s3", name: "GTA DVD Chest", status: "CLAIMABLE", current: 20 };
  await miner.claimQueueExtras(auth, [stuck, justDone, chest], "en");
  assert.equal(stuck.claimed, true);
  assert.equal(justDone.claimed, false, "на минуту больше нормы, ещё не раньше");
  assert.equal(chest.claimed, false, "настоящий сундук идёт через claimReward, а не как значок");
});
