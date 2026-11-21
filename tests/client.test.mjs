// node --test tests/  — lib/client.js: запросы, которые Twitch меняет без предупреждения.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const area = (bag) => ({
  get: async (key) => Object.fromEntries((Array.isArray(key) ? key : [key])
    .filter((name) => name in bag()).map((name) => [name, structuredClone(bag()[name])])),
  set: async (value) => Object.assign(bag(), structuredClone(value)),
  remove: async (key) => { delete bag()[key]; },
});
globalThis.chrome = {
  storage: { local: area(() => store.local), session: area(() => store.session) },
  tabs: { get: async (id) => (closedTabs.has(id) ? Promise.reject(new Error("No tab")) : { id }) },
};
const closedTabs = new Set();

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

test("badge campaigns: a twitch.tv self link needs no external account", async () => {
  const saved = globalThis.fetch;
  accepts = "id";
  const campaign = (link, type) => ({
    id: "c1",
    name: "Jordan x Space Jam",
    status: "ACTIVE",
    accountLinkURL: link,
    self: { isAccountConnected: false },
    game: { id: "1867279146", displayName: "Grand Theft Auto VI" },
    timeBasedDrops: [{
      id: "d1",
      name: "Jordan x Space Jam",
      requiredMinutesWatched: 15,
      benefitEdges: [{ benefit: { name: "Jordan x Space Jam TCSD", distributionType: type } }],
    }],
  });
  const hydrate = async (raw) => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { user: { id: "42", dropCampaign: raw } } }));
    return (await client.hydrateCampaigns(auth, [{ id: "c1" }]))[0];
  };
  try {
    const badge = await hydrate(campaign("https://www.twitch.tv/", "BADGE"));
    assert.equal(badge.linked, true);
    // Значок Twitch выдаёт сам: майнеру нужно знать, что клеймить его нечем (lib/miner.js).
    assert.equal(badge.drops[0].badge, true);
    assert.equal((await hydrate(campaign("https://www.twitch.tv", "BADGE"))).linked, true);
    const external = await hydrate(campaign("https://wargaming.net/personal/", "DIRECT_ENTITLEMENT"));
    assert.equal(external.linked, false);
    assert.equal(external.drops[0].badge, false);
    assert.equal((await hydrate(campaign("https://www.twitch.tv/", "DIRECT_ENTITLEMENT"))).linked, false);
  } finally {
    globalThis.fetch = saved;
  }
});

const rewardSummary = {
  id: "rc1",
  name: "GTAVI Launch Celebration",
  status: "ACTIVE",
  startsAt: "2026-11-18T11:00:00Z",
  endsAt: "2026-12-01T07:59:59.999Z",
  externalURL: "https://twitch.tv/gta",
  rewards: [{ id: "r0", name: "Chest", thumbnailURL: "https://img/campaign.png" }],
};

function rewardDetails(status = "IN_PROGRESS", minutes = 12, grantCount = 0) {
  return {
    id: "rc1",
    name: "GTAVI Launch Celebration",
    status: "ACTIVE",
    startAt: "2026-11-18T11:00:00Z",
    endAt: "2026-12-01T07:59:59.999Z",
    game: null,
    rewardGroups: [
      {
        id: "g1",
        rewards: [{ id: "r1", name: "GTA DVD Chest", thumbnailURL: "https://img/dvd.png" }],
        progressCriteria: {
          requirementType: "WATCH",
          requirements: { minutesWatched: 60, subs: null, turboSubs: null },
          isRepeatable: true,
          repeatableConfig: { repeatableTimes: 6, resetIntervalSeconds: 86400 },
          categories: [{ id: "1867279146", displayName: "Grand Theft Auto VI" }],
        },
        self: {
          status,
          currentMinutesWatched: minutes,
          currentSubs: 0,
          grantCount,
          nextEligibleAt: null,
          currentWindow: { startedAt: "2026-11-19T17:13:01Z", expiresAt: "2026-11-20T17:13:01Z" },
        },
      },
      {
        id: "g2",
        rewards: [{ id: "r2", name: "GTA Sub Emote Chest", thumbnailURL: "https://img/sub.png" }],
        progressCriteria: {
          requirementType: "WATCH",
          requirements: { minutesWatched: null, subs: 1, turboSubs: null },
          isRepeatable: false,
          repeatableConfig: null,
          categories: [{ id: "1867279146", displayName: "Grand Theft Auto VI" }],
        },
        self: { status: "LOCKED", currentMinutesWatched: 0, currentSubs: 0, grantCount: 0 },
      },
    ],
  };
}

test("reward campaigns: listed from their own root field, the watched category becomes the game", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    if (body.query?.includes("rewardCampaignsAvailableToUser")) {
      return new Response(JSON.stringify({ data: { rewardCampaignsAvailableToUser: [rewardSummary] } }));
    }
    if (body.query?.includes("RewardCampaignProgress")) {
      return new Response(JSON.stringify({ data: { dropsCampaign: rewardDetails() } }));
    }
    return new Response('{"data":{}}');
  };
  try {
    const campaigns = await client.listCampaigns(auth);
    assert.equal(campaigns.length, 1);
    const campaign = campaigns[0];
    assert.equal(campaign.kind, "reward");
    assert.equal(campaign.game.id, "1867279146");
    assert.equal(campaign.game.name, "Grand Theft Auto VI");
    assert.equal(campaign.game.slug, "grand-theft-auto-vi");
    // Группа за подписку в фарм не идёт: минут там нет.
    assert.equal(campaign.drops.length, 1);
    const drop = campaign.drops[0];
    assert.equal(drop.kind, "reward");
    assert.equal(drop.required, 60);
    assert.equal(drop.current, 12);
    assert.equal(drop.repeatableTimes, 6);
    assert.equal(drop.claimed, false);
    // Детали уже разобраны: hydrate не ходит за ними второй раз.
    const hydrated = await client.hydrateCampaigns(auth, campaigns);
    assert.equal(hydrated.length, 1);
    assert.equal(hydrated[0].drops[0].id, "g1");
  } finally {
    globalThis.fetch = saved;
  }
});

test("reward chest: opened only when Twitch returns a set of options", async () => {
  const saved = globalThis.fetch;
  const sent = [];
  let options = null;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    if (body.query?.includes("DropsRewardOptions")) {
      return new Response(JSON.stringify({ data: { dropsRewardOptions: options } }));
    }
    if (body.query?.includes("SelectDropsRewardOption")) {
      sent.push(JSON.parse(JSON.stringify(body.variables)));
      return new Response(JSON.stringify({ data: { selectDropsRewardOption: { code: { rewardID: "r1", rewardCampaignID: "rc1" }, error: null } } }));
    }
    return new Response('{"data":{}}');
  };
  try {
    const drop = { id: "g1", campaignId: "rc1" };
    // Минуты набраны, но Twitch ещё не открыл сундук — именно этот ответ и приходит до CLAIMABLE.
    assert.equal(await client.claimReward(auth, drop), "wait");
    assert.equal(sent.length, 0);
    options = {
      id: "set1",
      options: [
        { id: "o1", name: "Bronze", isAvailable: false },
        { id: "o2", name: "Gold", isAvailable: true },
      ],
    };
    // Один доступный вариант: выбирать не из чего — берём без автовыбора.
    assert.equal(await client.claimReward(auth, drop), "claimed");
    assert.deepEqual(sent, [{ input: { optionSetID: "set1", optionID: "o2" } }]);
    // Два доступных варианта: без автовыбора не выбираем, с автовыбором берём первый.
    sent.length = 0;
    options = {
      id: "set2",
      options: [
        { id: "o1", name: "Bronze", isAvailable: true },
        { id: "o2", name: "Gold", isAvailable: true },
      ],
    };
    assert.equal(await client.claimReward(auth, drop), "choice");
    assert.equal(sent.length, 0);
    assert.equal(await client.claimReward(auth, drop, { auto: true }), "claimed");
    assert.deepEqual(sent, [{ input: { optionSetID: "set2", optionID: "o1" } }]);
  } finally {
    globalThis.fetch = saved;
  }
});


test("reward chests: a single chest is done when Twitch says claimed, a repeatable one only after every grant", async () => {
  const saved = globalThis.fetch;
  const raw = (groups) => ({
    id: "rc2",
    name: "Chests",
    status: "ACTIVE",
    startAt: "2026-11-18T11:00:00Z",
    endAt: "2026-12-01T07:59:59.999Z",
    rewardGroups: groups,
  });
  const group = (id, repeatable, times, status, grantCount) => ({
    id,
    rewards: [{ id: "r" + id, name: id, thumbnailURL: "" }],
    progressCriteria: {
      requirementType: "WATCH",
      requirements: { minutesWatched: 10, subs: null, turboSubs: null },
      isRepeatable: repeatable,
      repeatableConfig: repeatable ? { repeatableTimes: times, resetIntervalSeconds: 86400 } : null,
      categories: [{ id: "1", displayName: "Game" }],
    },
    self: { status, currentMinutesWatched: 10, grantCount, nextEligibleAt: null, currentWindow: null },
  });
  const details = raw([
    group("single", false, 0, "CLAIMED", 0),
    group("partial", true, 3, "CLAIMED", 1),
    group("finished", true, 2, "CLAIMED", 2),
  ]);
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    if (body.query?.includes("rewardCampaignsAvailableToUser")) {
      return new Response(JSON.stringify({ data: { rewardCampaignsAvailableToUser: [rewardSummary] } }));
    }
    return new Response(JSON.stringify({ data: { dropsCampaign: details } }));
  };
  try {
    const campaigns = await client.listCampaigns(auth);
    const byId = new Map(campaigns[0].drops.map((drop) => [drop.id, drop]));
    assert.equal(byId.get("single").claimed, true);
    assert.equal(byId.get("partial").claimed, false);
    assert.equal(byId.get("finished").claimed, true);
  } finally {
    globalThis.fetch = saved;
  }
});

test("repeatable chest finished for today's window (60/60, grantCount 1, IN_PROGRESS) is closed until the window ends", async () => {
  const saved = globalThis.fetch;
  const group = (id, windowEnd, minutes, grants) => ({
    id,
    rewards: [{ id: "r" + id, name: id, thumbnailURL: "", distributionType: "POOL" }],
    progressCriteria: {
      requirementType: "WATCH",
      requirements: { minutesWatched: 60 },
      isRepeatable: true,
      repeatableConfig: { repeatableTimes: 6, resetIntervalSeconds: 86400 },
      categories: [{ id: "1", displayName: "Game" }],
    },
    self: {
      status: "IN_PROGRESS", currentMinutesWatched: minutes, grantCount: grants, nextEligibleAt: null,
      currentWindow: windowEnd ? { startedAt: "2026-11-19T17:13:01Z", expiresAt: windowEnd } : null,
    },
  });
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();
  const details = {
    id: "rc3", name: "GTA", status: "ACTIVE", startAt: "2026-11-18T11:00:00Z", endAt: "2099-12-01T07:59:59.999Z",
    rewardGroups: [
      group("doneToday", future, 60, 1),
      group("windowOver", past, 60, 1),
      group("notGrantedYet", future, 60, 0),
      group("halfway", future, 30, 1),
    ],
  };
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    if (body.query?.includes("rewardCampaignsAvailableToUser")) {
      return new Response(JSON.stringify({ data: { rewardCampaignsAvailableToUser: [rewardSummary] } }));
    }
    return new Response(JSON.stringify({ data: { dropsCampaign: details } }));
  };
  try {
    const campaigns = await client.listCampaigns(auth);
    const byId = new Map(campaigns[0].drops.map((drop) => [drop.id, drop]));
    assert.equal(byId.get("doneToday").claimed, true);
    assert.equal(byId.get("windowOver").claimed, false);
    assert.equal(byId.get("notGrantedYet").claimed, false);
    assert.equal(byId.get("halfway").claimed, false);
  } finally {
    globalThis.fetch = saved;
  }
});

test("side account: chest progress comes from its own request, and stays unknown when Twitch refuses it", async () => {
  const saved = globalThis.fetch;
  const row = () => ({
    id: "c1", kind: "reward", name: "GTA", game: { id: "1867279146", name: "Grand Theft Auto VI" },
    drops: [{ id: "g1", kind: "reward", required: 60, current: 0, claimed: false, badge: false, status: "", grantCount: 0, startsAt: 0, windowEndsAt: 0, unknown: true }],
  });
  const details = {
    id: "c1", name: "GTA", status: "ACTIVE", startAt: "2026-11-18T11:00:00Z", endAt: "2099-12-01T07:59:59.999Z",
    game: null,
    rewardGroups: [{
      id: "g1",
      rewards: [{ id: "r1", name: "GTA DVD Chest", thumbnailURL: "", distributionType: "POOL" }],
      progressCriteria: {
        requirementType: "WATCH", requirements: { minutesWatched: 60 }, isRepeatable: true,
        repeatableConfig: { repeatableTimes: 6, resetIntervalSeconds: 86400 }, categories: [{ id: "1867279146", displayName: "Grand Theft Auto VI" }],
      },
      self: { status: "IN_PROGRESS", currentMinutesWatched: 25, grantCount: 0, nextEligibleAt: null, currentWindow: null },
    }],
  };
  const side = { ...auth, plain: true };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { dropsCampaign: details } }));
    const own = [row()];
    await client.applyRewardProgress(side, own);
    assert.equal(own[0].drops[0].current, 25);
    assert.equal(own[0].drops[0].unknown, false);
    assert.equal(own[0].drops[0].claimed, false);

    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ message: "failed integrity check" }] }));
    const refused = [row()];
    await client.applyRewardProgress(side, refused);
    assert.equal(refused[0].drops[0].unknown, true);
    assert.equal(refused[0].drops[0].current, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test("tab accounts: simultaneous loads keep every tab; a load during a cookie swap is unknown", async () => {
  const { noteTabLoad, tabAccounts, forgetTab, UNKNOWN_TAB } = client;
  store.local.accounts = { twitch: { active: "1" } };
  await Promise.all([1, 2, 3, 4, 5].map((id) => noteTabLoad(id, "https://www.twitch.tv/x")));
  assert.deepEqual(Object.keys(await tabAccounts([1, 2, 3, 4, 5])).length, 5, "ни одна запись не потеряна");
  store.session.accountSwitching = Date.now();
  await noteTabLoad(6, "https://www.twitch.tv/y");
  delete store.session.accountSwitching;
  assert.equal((await tabAccounts([6]))[6], UNKNOWN_TAB);
  await noteTabLoad(7, "https://kick.com/z");
  assert.deepEqual(await tabAccounts([7]), {}, "не Twitch — не учитываем");
  await Promise.all([forgetTab(1), forgetTab(2), noteTabLoad(8, "https://twitch.tv/")]);
  assert.deepEqual(Object.keys(await tabAccounts([1, 2, 8])), ["8"]);
});

test("tab accounts: a tab closed while its record was written does not leave the record behind", async () => {
  const { noteTabLoad, tabAccounts } = client;
  store.local.accounts = { twitch: { active: "1" } };
  closedTabs.add(41);
  await noteTabLoad(41, "https://www.twitch.tv/x");
  assert.deepEqual(await tabAccounts([41]), {});
  closedTabs.delete(41);
});

test("integrity from a tab: an expired or almost expired token is not used", () => {
  const now = 1_800_000_000_000;
  assert.equal(client.integrityAlive({ "integrity-expiration": String(now + 10 * 60e3) }, now), true);
  assert.equal(client.integrityAlive({ "integrity-expiration": String(now + 30e3) }, now), false, "меньше минуты — не берём");
  assert.equal(client.integrityAlive({ "integrity-expiration": String(now - 1) }, now), false, "протух");
  assert.equal(client.integrityAlive({ "integrity-expiration": String((now + 10 * 60e3) / 1000) }, now), true, "срок в секундах");
  assert.equal(client.integrityAlive({}, now), true, "срока нет — как раньше");
});
