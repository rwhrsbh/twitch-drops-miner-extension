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
  assert.deepEqual(out, { claimed: ["Jordan x Space Jam TCSD (Grand Theft Auto VI)"], failed: [], choice: [] });
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
  assert.deepEqual(second, { claimed: [], failed: [], choice: [] });
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
  assert.deepEqual(out, { claimed: ["Haunter (Pokemon Evolutions)"], failed: [], choice: [], changed: true });
  assert.equal(row.claimed, true);
  assert.equal(calls, 0);

  // Повторно тот же значок уже не клеймится: отметка майнера живёт в badgeDrops.
  // changed остаётся true, чтобы проход сохранил обновлённую строку очереди.
  const again = { ...row, claimed: false };
  const second = await miner.claimQueueExtras(auth, [again], "en");
  assert.deepEqual(second, { claimed: [], failed: [], choice: [], changed: true });
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

test("repeatable chest marked as a stuck badge on day 1 is farmed again in the next window", async () => {
  // GTA DVD Chest (POOL, 6 дней): Twitch не успел перевести группу в CLAIMABLE, минут 61.
  // Раньше отметка значка (60 дней) по голому id закрывала группу на все оставшиеся дни.
  const day = (windowEndsAt, current) => ({
    id: "c9", name: "GTA", game: { id: "g9", name: "GTA VI" },
    drops: [{
      id: "chest", kind: "reward", name: "DVD Chest", benefits: ["DVD Chest"], image: "",
      required: 60, current, claimed: false, badge: current >= 61, status: "IN_PROGRESS",
      grantCount: 0, repeatableTimes: 6, windowEndsAt, campaignId: "c9",
    }],
  });
  const first = day(1000, 61);
  await miner.claimReady(auth, [first], "en");
  assert.equal(first.drops[0].claimed, true);
  const sameWindow = day(1000, 61);
  const repeat = await miner.claimReady(auth, [sameWindow], "en");
  assert.equal(sameWindow.drops[0].claimed, true, "в том же окне повторно не отмечается");
  assert.deepEqual(repeat.claimed, [], "и в историю второй раз не пишется");
  const nextWindow = day(2000, 0);
  await miner.claimReady(auth, [nextWindow], "en");
  assert.equal(nextWindow.drops[0].claimed, false, "новое окно — сундук снова фармится");
  assert.equal(nextWindow.drops[0].current, 0);
});

test("one-time badge keeps the long memory by its plain id", () => {
  assert.equal(miner.claimKey({ id: "d1", badge: true }), "d1");
  assert.equal(miner.claimKey({ id: "r1", kind: "reward", repeatableTimes: 1 }), "r1");
  assert.equal(miner.claimKey({ id: "r2", kind: "reward", repeatableTimes: 6, windowEndsAt: 5 }), "r2@5");
  const at = Date.parse("2026-11-21T10:00:00Z");
  assert.equal(miner.claimKey({ id: "r3", kind: "reward", repeatableTimes: 6 }, at), `r3@h${Math.floor(at / (6 * 3600e3))}`);
});

test("repeatable chest without a window: a live mark does not hide a fresh window from Twitch", async () => {
  // Окна Twitch не отдал: ключ — шестичасовой отрезок. Если внутри него Twitch уже показывает
  // новый прогресс (минуты с нуля), отметка не должна выдавать группу за выданную.
  const chest = (current) => ({
    id: "c10", name: "GTA", game: { id: "g10", name: "GTA VI" },
    drops: [{
      id: "nowin", kind: "reward", name: "Chest", benefits: ["Chest"], image: "",
      required: 60, current, claimed: false, badge: current >= 61, status: "IN_PROGRESS",
      grantCount: 0, repeatableTimes: 6, windowEndsAt: 0, campaignId: "c10",
    }],
  });
  const realNow = Date.now;
  const slice = 6 * 3600e3;
  const start = Math.floor(realNow() / slice) * slice + 1000;
  try {
    Date.now = () => start;
    await miner.claimReady(auth, [chest(61)], "en");
    // Через 20 минут Twitch показывает сброс (новый день): минуты с нуля.
    Date.now = () => start + 20 * 60e3;
    const fresh = chest(5);
    await miner.claimReady(auth, [fresh], "en");
    assert.equal(fresh.drops[0].claimed, false);
    assert.equal(fresh.drops[0].current, 5);
    // Потом снова норма — это новая выдача: отмечается и пишется в историю.
    Date.now = () => start + 90 * 60e3;
    const next = chest(61);
    const again = await miner.claimReady(auth, [next], "en");
    assert.equal(next.drops[0].claimed, true);
    assert.deepEqual(again.claimed, ["Chest (GTA VI)"], "новая выдача после сброса — в историю");
    // А та же выдача, застрявшая на норме, второй раз не пишется.
    const stuck = chest(61);
    const third = await miner.claimReady(auth, [stuck], "en");
    assert.equal(stuck.drops[0].claimed, true, "застрявшая на норме группа остаётся отмеченной");
    assert.deepEqual(third.claimed, [], "без второй записи в истории");
  } finally {
    Date.now = realNow;
  }
});

test("a chest just claimed in this pass keeps its mark when claimReady runs again in the same pass", async () => {
  // После своего клейма повторяемый сундук в памяти обнулён (current 0). Второй вызов в том же
  // проходе не должен принять это за сброс у Twitch и стереть отметку.
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body || "{}");
    if (/DropsRewardOptions/.test(body.query || "")) {
      return new Response(JSON.stringify({ data: { dropsRewardOptions: { id: "set", options: [{ id: "o1", isAvailable: true }] } } }));
    }
    if (/SelectDropsRewardOption/.test(body.query || "")) {
      return new Response(JSON.stringify({ data: { selectDropsRewardOption: { code: { rewardID: "r" }, error: null } } }));
    }
    return new Response('{"data":{}}');
  };
  try {
    const camp = {
      id: "c13", name: "GTA", game: { id: "g13", name: "GTA VI" },
      drops: [{
        id: "own13", kind: "reward", name: "Own", benefits: ["Own"], image: "", required: 2, current: 2, claimed: false,
        badge: false, status: "CLAIMABLE", grantCount: 0, repeatableTimes: 6, windowEndsAt: 0, campaignId: "c13",
      }],
    };
    const first = await miner.claimReady(auth, [camp], "en");
    assert.deepEqual(first.claimed, ["Own (GTA VI)"]);
    assert.equal(camp.drops[0].current, 0, "в памяти сундук обнулён");
    const key = `${auth.userId}:${miner.claimKey(camp.drops[0])}`;
    // Второй вызов в том же проходе на тех же объектах.
    await miner.claimReady(auth, [camp], "en");
    assert.ok(key in (store.local.claimedDrops || {}), "отметка своего клейма не стёрта");
  } finally {
    globalThis.fetch = saved;
  }
});

test("a short repeatable chest is not kept closed by an old mark once Twitch shows the reset", async () => {
  // Отметка от прошлого прохода (не этого): Twitch показывает сброс — стираем сразу, без ожидания.
  const key = `${auth.userId}:short14@h${Math.floor(Date.now() / (6 * 3600e3))}`;
  store.local.claimedDrops = { ...(store.local.claimedDrops || {}), [key]: Date.now() };
  const camp = (current) => ({
    id: "c14", name: "G", game: { id: "g14", name: "G" },
    drops: [{
      id: "short14", kind: "reward", name: "Short", benefits: ["Short"], image: "", required: 2, current, claimed: false,
      badge: false, status: "IN_PROGRESS", grantCount: 1, repeatableTimes: 6, windowEndsAt: 0, campaignId: "c14",
    }],
  });
  await miner.claimReady(auth, [camp(1)], "en");
  assert.ok(!(key in store.local.claimedDrops), "сброс у Twitch — отметка прошлой выдачи стёрта");
  const ready = camp(2);
  await miner.claimReady(auth, [ready], "en");
  assert.equal(ready.drops[0].claimed, false, "набранный снова сундук не считается забранным");
});



test("main miner claims every ready drop of a promoted account, the old stuck one and the new one", async () => {
  const before = calls;
  const camp = {
    id: "c11", name: "Rust", game: { id: "g11", name: "Rust" },
    drops: ["old", "new"].map((id) => ({
      id, name: id, benefits: [id], image: "", required: 10, current: 10, claimed: false, claimId: `i-${id}`, campaignId: "c11",
    })),
  };
  const out = await miner.claimReady(auth, [camp], "en");
  assert.equal(calls - before, 2, "клейм ушёл по обоим дропам");
  assert.equal(out.failed.length + out.claimed.length, 2);
});

test("stuck repeatable group without a window: next 6-hour slice does not write the history again", async () => {
  const history = await import("../lib/history.js");
  const realNow = Date.now;
  const slice = 6 * 3600e3;
  const start = Math.floor(realNow() / slice) * slice + 1000;
  const chest = () => ({
    id: "c12", name: "GTA", game: { id: "g12", name: "GTA VI" },
    drops: [{
      id: "stuck12", kind: "reward", name: "Ball", benefits: ["Ball"], image: "", required: 60, current: 61, claimed: false,
      badge: true, status: "IN_PROGRESS", grantCount: 0, repeatableTimes: 6, windowEndsAt: 0, campaignId: "c12",
    }],
  });
  try {
    Date.now = () => start;
    const first = await miner.claimReady(auth, [chest()], "en");
    assert.deepEqual(first.claimed, ["Ball (GTA VI)"]);
    const count = (await history.readHistory()).filter((row) => row.name === "Ball").length;
    Date.now = () => start + slice;
    const next = chest();
    const second = await miner.claimReady(auth, [next], "en");
    assert.equal(next.drops[0].claimed, true, "отметка продлена");
    assert.deepEqual(second.claimed, [], "уже забранное в историю второй раз не пишется");
    assert.equal((await history.readHistory()).filter((row) => row.name === "Ball").length, count);
  } finally {
    Date.now = realNow;
  }
});
