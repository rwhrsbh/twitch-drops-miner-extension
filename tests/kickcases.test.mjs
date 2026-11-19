// node --test tests/kickcases.test.mjs — кейсы Kick на подставных chrome/fetch.
// Формы ответов взяты из живого Kick 19 ноября 2026 (Daily Reward и Sunset Reward Case).
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
const calls = [];
let net = {};
let cookie = "abc%7Cdef";

globalThis.chrome = {
  runtime: { id: "extid" },
  cookies: { get: async () => (cookie ? { value: cookie } : null) },
  storage: {
    local: {
      get: async (k) => (typeof k === "string" ? { [k]: store.local[k] } : { ...store.local }),
      set: async (o) => Object.assign(store.local, o),
      remove: async (k) => delete store.local[k],
    },
    session: {
      get: async (k) => ({ [k]: store.session[k] }),
      set: async (o) => Object.assign(store.session, o),
      remove: async (k) => delete store.session[k],
    },
  },
  tabs: {
    create: async () => ({ id: 7 }),
    query: async () => [],
    update: async () => {},
    remove: async () => {},
    get: async () => ({ id: 7, url: "https://kick.com/old" }),
  },
  scripting: { executeScript: async () => [{ result: "" }] },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
};
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; }
  send() {}
  close() { this.readyState = 3; }
};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const hit = Object.entries(net).find(([key]) => String(url).includes(key));
  if (!hit) return new Response("{}", { status: 404 });
  const [, value] = hit;
  const out = typeof value === "function" ? value(init, String(url)) : value;
  return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200 });
};

const cases = await import("../lib/kickcases.js");
const kick = await import("../lib/kick.js");

const daily = {
  animations: { idle_url: "https://static.kick.com/rewards/daily-rewards/idle", unbox_url: "https://static.kick.com/rewards/daily-rewards/unbox" },
  claimed_at: "2026-11-19T02:32:06.392945Z",
  condition: { progress: 60, threshold: 60, type: "watch_time_minutes" },
  contributes_to_streak: true,
  description: "Claim your Daily Reward for a chance to win big! Exclusive prizes are up for grabs.",
  featured: false,
  id: "019f1234-3dc2-71f4-a53e-7c4055ce5b12",
  name: "Daily Reward",
  recurrence: "daily",
  status: "claimed",
  window: { ends_at: "2026-11-20T00:00:00Z", starts_at: "2026-11-19T00:00:00Z" },
  winner: { card_url: "https://ext.cdn.kick.com/chat/emotes/cards/widepeepoSmile_Rare_card_9a7439a0f4384e1895bea01fb3a333d7.png", id: "x", rarity: "rare", thumbnail_url: "https://ext.cdn.kick.com/chat/emotes/shields/widepeepoSmile_Rare_shield_534aa9679c7a493ea7a1189fe78e22af.png" },
};

const sunset = {
  animations: { idle_url: "https://static.kick.com/rewards/gta-vi-2611/idle", unbox_url: "https://static.kick.com/rewards/gta-vi-2611/unbox" },
  condition: { progress: 150, threshold: 180, type: "watch_time_minutes" },
  contributes_to_streak: false,
  description: "Watch any stream for 3 hours to unlock a case packed with free copies of GTA VI.",
  featured: true,
  id: "01a1c81b-e588-721b-9f82-95f7b5ce426b",
  name: "Sunset Reward Case",
  recurrence: "daily",
  status: "in_progress",
  terms_and_conditions_url: "https://about.kick.com/news-and-press/13-sunset-reward-case",
  window: { ends_at: "2026-11-20T00:00:00Z", starts_at: "2026-11-19T00:00:00Z" },
};

function reset() {
  store.local = {};
  store.session = {};
  calls.length = 0;
  cookie = "abc%7Cdef";
  net = {
    "viewer/v1/token": { data: { token: "viewer1" } },
    "gamification/challenges": { data: [daily, sunset] },
  };
}

test("caseRows: строки из живого ответа, минуты подрезаны порогом", () => {
  const rows = cases.caseRows({ data: [daily, sunset] });
  assert.equal(rows.length, 2);
  // Sunset — главный кейс акции, он идёт первым.
  assert.equal(rows[0].name, "Sunset Reward Case");
  assert.equal(rows[0].threshold, 180);
  assert.equal(rows[0].progress, 150);
  assert.equal(rows[0].featured, true);
  assert.equal(rows[0].type, "watch_time_minutes");
  assert.match(rows[0].termsUrl, /sunset-reward-case/);
  assert.equal(rows[1].name, "Daily Reward");
  assert.equal(rows[1].status, "claimed");
  assert.equal(rows[1].rarity, "rare");
  assert.match(rows[1].image, /widepeepoSmile_Rare_card/);
  // Ключ попытки — id и конец окна: завтра у того же кейса новый ключ.
  assert.equal(rows[0].key, "01a1c81b-e588-721b-9f82-95f7b5ce426b|" + Date.parse("2026-11-20T00:00:00Z"));
});

test("caseRows: прогресс не выходит за порог и мусор не ломает список", () => {
  const rows = cases.caseRows({ data: [null, { name: "no id" }, { ...sunset, condition: { progress: 999, threshold: 180 } }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].progress, 180);
  assert.deepEqual(cases.caseRows(null), []);
  assert.deepEqual(cases.caseRows({ data: "nope" }), []);
});

test("isClaimable: claimed не открываем, набранные минуты открываем", () => {
  assert.equal(cases.isClaimable({ status: "claimable", threshold: 60, progress: 60 }), true);
  assert.equal(cases.isClaimable({ status: "in_progress", threshold: 180, progress: 180 }), true);
  assert.equal(cases.isClaimable({ status: "in_progress", threshold: 180, progress: 150 }), false);
  assert.equal(cases.isClaimable({ status: "claimed", threshold: 60, progress: 60 }), false);
  assert.equal(cases.isClaimable({ status: "claimed", threshold: 60, progress: 60, claimedAt: 1 }), false);
});

test("tick: готовый кейс открывается, заголовки как у сайта, история пополняется", async () => {
  reset();
  const ready = { ...sunset, status: "claimable", condition: { progress: 180, threshold: 180, type: "watch_time_minutes" } };
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "legendary", card_url: "https://ext.cdn.kick.com/card.png" } } }
    : { data: [daily, ready] });
  store.local.kick = { user: "me" };

  const state = await cases.kickCasesTick({ force: true });
  const claim = calls.find((call) => call.url.includes("/claim"));
  assert.ok(claim, "клейм ушёл");
  assert.equal(claim.init.method, "POST");
  assert.equal(claim.init.headers.Authorization, "Bearer abc|def");
  assert.equal(claim.init.headers["X-App-Platform"], "web");
  assert.ok(claim.init.headers["X-Client-Token"].length >= 32);
  assert.match(claim.url, new RegExp(`${ready.id}/claim`));
  assert.equal(state.accounts.current.items.find((row) => row.id === ready.id).status, "claimed");
  assert.equal(state.accounts.current.items.find((row) => row.id === ready.id).rarity, "legendary");
  // В историю попадает только то, что открыл майнер: забранный до нас Daily Reward не записывается.
  const history = store.local.history || [];
  assert.equal(history.length, 1);
  const sunsetEntry = history[0];
  assert.equal(sunsetEntry.kind, "case");
  assert.equal(sunsetEntry.platform, "kick");
  assert.equal(sunsetEntry.name, "Sunset Reward Case · legendary");
});

test("tick: выключенное открытие только читает список", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim") ? { data: {} } : { data: [{ ...sunset, status: "claimable" }] });
  store.local.kickCases = { enabled: false };
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 0);
  assert.equal(state.accounts.current.items.length, 1);
  assert.equal(state.accounts.current.items[0].status, "claimable");
});

test("tick: неудачный клейм запоминается и не повторяется сразу", async () => {
  reset();
  // Настоящий отказ, а не пустой успешный ответ: иначе тест проверял бы не то.
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { status: 422, body: { message: "too early" } }
    : { data: [{ ...sunset, status: "claimable" }] });
  const first = await cases.kickCasesTick({ force: true });
  assert.equal(Object.keys(first.accounts.current.failed).length, 1);
  assert.match(first.accounts.current.claimError, /HTTP 422/);
  await cases.kickCasesTick({ force: true });
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 1);
});

test("клейм без карточки — успех, а не ошибка", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { challenge_id: sunset.id } }
    : { data: [{ ...sunset, status: "claimable" }] });
  const state = await cases.kickCasesTick({ force: true });
  assert.deepEqual(Object.keys(state.accounts.current.failed), []);
  assert.equal(state.accounts.current.items[0].status, "claimed");
  assert.equal((store.local.history || []).length, 1);
});

test("ключ без окна не запирает ежедневную награду навсегда", () => {
  assert.match(cases.caseKey({ id: "daily-1" }), /^daily-1\|day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(cases.caseKey({ id: "x", endsAt: 123 }), "x|123");
});

test("просроченный кейс не открываем, не-минутный не фармим", () => {
  assert.equal(cases.isClaimable({ status: "claimable", threshold: 60, progress: 60, endsAt: Date.now() - 1000 }), false);
  assert.equal(cases.needsMinutes({ status: "in_progress", threshold: 60, progress: 10, endsAt: Date.now() - 1000 }), false);
  assert.equal(cases.needsMinutes({ status: "in_progress", threshold: 60, progress: 10, type: "watch_streams" }), false);
  assert.equal(cases.needsMinutes({ status: "in_progress", threshold: 60, progress: 10 }), true);
});

test("выключенный Kick не трогает кейсы", async () => {
  reset();
  store.local.kick = { enabled: false, user: "me" };
  const state = await cases.kickCasesTick({ force: true });
  assert.deepEqual(state.accounts, {});
  assert.equal(calls.length, 0);
});

test("режим «только вручную»: кейсы только у аккаунта браузера", async () => {
  reset();
  store.local.accounts = {
    kick: { active: "k1", list: [{ id: "k1", login: "one" }, { id: "k2", login: "two" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "never", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { k1: [{ name: "session_token", value: "tok1" }], k2: [{ name: "session_token", value: "tok2" }] },
    twitch: {},
  };
  net["gamification/challenges"] = { data: [{ ...sunset, status: "in_progress" }] };
  const state = await cases.kickCasesTick({ force: true });
  assert.deepEqual(Object.keys(state.accounts), ["k1"]);
  assert.ok(!calls.some((call) => call.init.headers?.Authorization === "Bearer tok2"), "чужой аккаунт не трогали");
});

test("кнопка «Открыть» не клеймит уже открытый кейс", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "rare" } } }
    : { data: [{ ...sunset, status: "claimable" }] });
  await cases.kickCasesTick({ force: true });
  const before = calls.filter((call) => call.url.includes("/claim")).length;
  const state = await cases.openKickCase(sunset.id, "current");
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, before);
  assert.equal(state.accounts.current.items[0].status, "claimed");
});

test("tick: 90 секунд между проходами, force игнорирует паузу", async () => {
  reset();
  await cases.kickCasesTick({ force: true });
  const before = calls.length;
  await cases.kickCasesTick();
  assert.equal(calls.length, before);
  await cases.kickCasesTick({ force: true });
  assert.ok(calls.length > before);
});

test("tick: без входа в Kick — ошибка, список не трогаем", async () => {
  reset();
  cookie = "";
  const state = await cases.kickCasesTick({ force: true });
  assert.deepEqual(state.accounts, {});
});

test("кнопка «Открыть»: клейм по id из списка", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim") ? { data: { winner: { rarity: "epic" } } } : { data: [sunset] });
  await cases.kickCasesTick({ force: true });
  const before = calls.filter((call) => call.url.includes("/claim")).length;
  const state = await cases.openKickCase(sunset.id);
  const claim = calls.filter((call) => call.url.includes("/claim"));
  assert.equal(claim.length, before + 1);
  assert.equal(state.accounts.current.items[0].status, "claimed");
  assert.equal(state.accounts.current.items[0].rarity, "epic");
});

test("второй аккаунт открывает свои кейсы своим токеном и без кук браузера", async () => {
  reset();
  store.local.accounts = {
    kick: { active: "", list: [{ id: "k2", login: "second", expired: false }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = { kick: { k2: [{ name: "session_token", value: "tok2" }] }, twitch: {} };
  net["gamification/challenges"] = (init, url) => {
    const auth = String(init.headers.Authorization || "");
    if (String(url).includes("/claim")) {
      return { data: { winner: { rarity: auth.includes("tok2") ? "mythic" : "common" } } };
    }
    const id = auth.includes("tok2") ? "second-case" : "browser-case";
    return { data: [{ ...sunset, id, name: id, status: "claimable" }] };
  };
  const state = await cases.kickCasesTick({ force: true });
  const claims = calls.filter((call) => call.url.includes("/claim"));
  const foreign = claims.find((call) => call.init.headers.Authorization === "Bearer tok2");
  const browser = claims.find((call) => call.init.headers.Authorization === "Bearer abc|def");
  assert.ok(foreign, "чужой аккаунт клеймит своим токеном");
  assert.equal(foreign.init.credentials, "omit");
  assert.ok(browser, "аккаунт браузера клеймит живой кукой");
  assert.equal(browser.init.credentials, "include");
  assert.equal(state.accounts.k2.login, "second");
  assert.equal(state.accounts.k2.items[0].rarity, "mythic");
  assert.match(state.accounts.current.items[0].rarity, /common|mythic/);
  const history = store.local.history || [];
  assert.equal(history.filter((item) => item.account === "second" && item.name.includes("mythic")).length, 1);
  assert.ok(history.some((item) => item.account !== "second"), "история аккаунта браузера тоже есть");
});

test("кнопка «Открыть» не открывает кейс чужого аккаунта", async () => {
  reset();
  net["gamification/challenges"] = { data: [{ ...sunset, status: "claimable" }] };
  await cases.setKickCasesEnabled(false);
  await cases.kickCasesTick({ force: true });
  const before = calls.filter((call) => call.url.includes("/claim")).length;
  const state = await cases.openKickCase(sunset.id, "нет-такого-аккаунта");
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, before, "клейма не было");
  assert.equal(state.accounts.current.items[0].status, "claimable");
});

test("два прохода сразу не открывают кейс дважды", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "rare" } } }
    : { data: [{ ...sunset, status: "claimable" }] });
  await Promise.all([cases.kickCasesTick({ force: true }), cases.kickCasesTick({ force: true })]);
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 1);
  assert.equal((store.local.history || []).length, 1);
});

test("плоский ответ на клейм тоже понимаем", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { challenge_id: sunset.id, reveal_type: "instant", winner: { rarity: "mythic" } }
    : { data: [{ ...sunset, status: "claimable" }] });
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(state.accounts.current.items[0].rarity, "mythic");
  assert.equal((store.local.history || [])[0].name, "Sunset Reward Case · mythic");
});

test("401 не долбит Kick каждые 90 секунд", async () => {
  reset();
  net["gamification/challenges"] = { status: 401, body: { message: "unauthorized" } };
  const first = await cases.kickCasesTick({ force: true });
  assert.match(first.accounts.current.error, /HTTP 401/);
  assert.ok(first.accounts.current.checkedAt > Date.now() + 60 * 1000, "следующая попытка отложена на 10 минут");
  const before = calls.length;
  await cases.kickCasesTick();
  assert.equal(calls.length, before);
});

test("переключатель сохраняется", async () => {
  reset();
  const off = await cases.setKickCasesEnabled(false);
  assert.equal(off.enabled, false);
  assert.equal((await cases.readKickCases()).enabled, false);
  const on = await cases.setKickCasesEnabled(true);
  assert.equal(on.enabled, true);
});