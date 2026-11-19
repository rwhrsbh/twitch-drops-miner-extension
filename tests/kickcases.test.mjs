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
  // HTML с кодом 200: так отвечает заглушка WAF вместо JSON.
  if (out && typeof out === "object" && out.empty) return new Response(null, { status: out.status ?? 204 });
  if (out && typeof out === "object" && typeof out.html === "string") {
    return new Response(out.html, { status: out.status ?? 200, headers: { "Content-Type": "text/html" } });
  }
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

test("tick: выключенный тумблер не опрашивает Kick", async () => {
  reset();
  store.local.kickCases = { enabled: false };
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(calls.length, 0, "ни одного запроса за выключенной функцией");
  assert.deepEqual(state.accounts, {});
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
  // Аккаунт браузера — сохранённый вход k1 (режим never остальным не даёт кейсов).
  cookie = "tok1";
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
  assert.equal(state.accounts.k1.served, true);
  assert.equal(state.accounts.k2.served, false, "второй аккаунт не обслуживается");
  assert.ok(!calls.some((call) => call.init.headers?.Authorization === "Bearer tok2"), "чужой аккаунт не трогали");
});

test("переключатель и проход одновременно не открывают кейс дважды", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "rare" } } }
    : { data: [{ ...sunset, status: "claimable" }] });
  await Promise.all([
    cases.setKickCasesEnabled(true),
    cases.kickCasesTick({ force: true }),
  ]);
  await cases.kickCasesTick({ force: true });
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 1, "один клейм");
  assert.equal((store.local.history || []).length, 1, "одна запись в истории");
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
  // Живая кука браузера — отдельный человек: логин проверяется, чтобы не смешать его с сохранённым.
  net["kick.com/api/v1/user"] = { username: "browser" };
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
  assert.match(state.accounts["live:browser"].items[0].rarity, /common|mythic/);
  const history = store.local.history || [];
  assert.equal(history.filter((item) => item.account === "second" && item.name.includes("mythic")).length, 1);
  assert.ok(history.some((item) => item.account !== "second"), "история аккаунта браузера тоже есть");
});

test("кнопка «Открыть» не открывает кейс чужого аккаунта", async () => {
  reset();
  // Состояние с готовым кейсом уже есть, а аккаунт, к которому относилась строка, пропал.
  store.local.kickCases = {
    enabled: true,
    accounts: { current: { login: "me", items: [{ ...sunset, status: "claimable", key: cases.caseKey(sunset) }] } },
  };
  const state = await cases.openKickCase(sunset.id, "нет-такого-аккаунта");
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 0, "клейма не было");
  assert.equal(state.accounts.current.items[0].status, "claimable");
  assert.equal(state.notice, "account-gone", "попап скажет, что аккаунт пропал");
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

test("200 с HTML вместо JSON — отказ, а не открытый кейс", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { html: "<html>Just a moment...</html>", status: 200 }
    : { data: [{ ...sunset, status: "claimable" }] });
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(Object.keys(state.accounts.current.failed).length, 1);
  assert.match(state.accounts.current.claimError, /not json/);
  assert.equal((store.local.history || []).length, 0);
});

test("живая кука и устаревший active не клеймят один аккаунт дважды", async () => {
  reset();
  // В браузере — сохранённый вход B, а active остался на A.
  cookie = "tokB";
  store.local.kick = { user: "bob", enabled: true };
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }, { id: "B", login: "bob" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { A: [{ name: "session_token", value: "tokA" }], B: [{ name: "session_token", value: "tokB" }] },
    twitch: {},
  };
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "rare" } } }
    : { data: [{ ...sunset, status: "claimable" }] });
  await cases.kickCasesTick({ force: true });
  const claims = calls.filter((call) => call.url.includes("/claim"));
  assert.equal(claims.filter((call) => call.init.headers.Authorization === "Bearer tokB").length, 1, "вход B клеймит один раз");
  assert.ok(!claims.some((call) => call.init.headers.Authorization === "Bearer abc|def"), "кука браузера не подменяет B");
  const history = store.local.history || [];
  assert.equal(history.filter((item) => item.account === "bob").length, 1, "одна запись на живой аккаунт");
  assert.equal(history.filter((item) => item.account === "alice").length, 1, "A открыл только свой кейс");
});

test("устаревший kick.user не превращается в двойной клейм", async () => {
  reset();
  // В состоянии остался прежний ник, а живая кука — сохранённый вход bob.
  cookie = "tokB";
  store.local.kick = { user: "alice", enabled: true };
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }, { id: "B", login: "bob" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { A: [{ name: "session_token", value: "tokA" }], B: [{ name: "session_token", value: "tokB" }] },
    twitch: {},
  };
  net["kick.com/api/v1/user"] = { username: "bob" };
  // Кейс A ещё не набран: клеймить должен только живой вход.
  net["gamification/challenges"] = (init, url) => {
    if (String(url).includes("/claim")) return { data: { winner: { rarity: "rare" } } };
    const foreign = String(init.headers?.Authorization || "").includes("tokA");
    return { data: [{ ...sunset, id: foreign ? "a-case" : sunset.id, status: foreign ? "in_progress" : "claimable" }] };
  };
  await cases.kickCasesTick({ force: true });
  const claims = calls.filter((call) => call.url.includes("/claim"));
  assert.equal(claims.filter((call) => call.init.headers.Authorization === "Bearer tokB").length, 1);
  assert.ok(!claims.some((call) => call.init.headers.Authorization === "Bearer abc|def"));
  const history = store.local.history || [];
  assert.equal(history.filter((item) => item.account === "bob").length, 1);
  assert.equal(history.filter((item) => item.account === "alice").length, 0, "прежний ник в историю не попал");
});

test("логин незнакомой живой куки спрашивается один раз", async () => {
  reset();
  // Такого входа в списке нет: владельца может назвать только /user.
  cookie = "liveC";
  store.local.kick = { user: "alice", enabled: true };
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }, { id: "B", login: "bob" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { A: [{ name: "session_token", value: "tokA" }], B: [{ name: "session_token", value: "tokB" }] },
    twitch: {},
  };
  // Первый ответ — bob, второй (если бы он был) — отказ.
  let asked = 0;
  net["kick.com/api/v1/user"] = () => {
    asked += 1;
    return asked === 1 ? { username: "bob" } : { status: 500, body: {} };
  };
  // Клеймит только живой аккаунт: у сохранённого A кейс ещё не набран.
  net["gamification/challenges"] = (init, url) => {
    if (String(url).includes("/claim")) return { data: { winner: { rarity: "rare" } } };
    const foreign = String(init.headers?.Authorization || "").includes("tokA");
    return { data: [{ ...sunset, id: foreign ? "a-case" : sunset.id, status: foreign ? "in_progress" : "claimable" }] };
  };
  await cases.kickCasesTick({ force: true });
  assert.equal(asked, 1, "один запрос логина");
  const history = store.local.history || [];
  assert.equal(history.filter((item) => item.account === "bob").length, 1, "клейм записан на живой аккаунт");
  assert.equal(history.filter((item) => item.account === "alice").length, 0, "чужое имя в историю не попало");
});

test("истёкший аккаунт сохраняет отметки и помечается необслуживаемым", async () => {
  reset();
  store.local.accounts = {
    kick: { active: "k1", list: [{ id: "k1", login: "one" }, { id: "k2", login: "two", expired: true }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { k1: [{ name: "session_token", value: "tok1" }], k2: [{ name: "session_token", value: "tok2" }] },
    twitch: {},
  };
  store.local.kickCases = { enabled: true, accounts: { k2: { login: "two", items: [], opened: { "x|1": { at: 1 } }, failed: {}, checkedAt: 1 } } };
  const state = await cases.kickCasesTick({ force: true });
  assert.ok(state.accounts.k2, "отметки истёкшего остались");
  assert.equal(state.accounts.k2.served, false);
  assert.equal(state.accounts.k2.opened["x|1"].at, 1);
});

test("ключ кейса считается по периоду: неделя и месяц", () => {
  const weekly = { id: "w", recurrence: "weekly" };
  const monday = new Date("2026-11-16T12:00:00Z");
  const tuesday = new Date("2026-11-17T12:00:00Z");
  const nextWeek = new Date("2026-11-24T12:00:00Z");
  assert.equal(cases.caseKey(weekly, monday), cases.caseKey(weekly, tuesday), "та же неделя");
  assert.notEqual(cases.caseKey(weekly, tuesday), cases.caseKey(weekly, nextWeek), "следующая неделя");
  const monthly = { id: "m", recurrence: "monthly" };
  assert.equal(cases.caseKey(monthly, monday), cases.caseKey(monthly, new Date("2026-11-30T23:00:00Z")));
  assert.notEqual(cases.caseKey(monthly, monday), cases.caseKey(monthly, new Date("2026-12-01T00:00:00Z")));
  const daily = { id: "d", recurrence: "daily" };
  assert.notEqual(cases.caseKey(daily, monday), cases.caseKey(daily, tuesday));
});

test("204 с пустым телом — успешный клейм", async () => {
  reset();
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { empty: true, status: 204 }
    : { data: [{ ...sunset, status: "claimable" }] });
  const state = await cases.kickCasesTick({ force: true });
  assert.deepEqual(Object.keys(state.accounts.current.failed), []);
  assert.equal(state.accounts.current.items[0].status, "claimed");
});

test("режим «только вручную»: сохранённый аккаунт помечен необслуживаемым", async () => {
  reset();
  // Живая кука — сохранённый вход k1: он и есть аккаунт браузера.
  cookie = "tok1";
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
  assert.equal(state.accounts.k1.served, true);
  assert.equal(state.accounts.k2.served, false, "попап его не предложит");
  const after = await cases.openKickCase(sunset.id, "k2");
  assert.equal(after.notice, "not-served");
});

test("режим «только вручную» не стирает отметки сохранённых аккаунтов", async () => {
  reset();
  cookie = "tok1";
  store.local.accounts = {
    kick: { active: "k1", list: [{ id: "k1", login: "one" }, { id: "k2", login: "two" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "never", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { k1: [{ name: "session_token", value: "tok1" }], k2: [{ name: "session_token", value: "tok2" }] },
    twitch: {},
  };
  store.local.kickCases = { enabled: true, accounts: { k2: { login: "two", items: [], opened: { "x|1": { at: 1 } }, failed: {}, checkedAt: 1 } } };
  const state = await cases.kickCasesTick({ force: true });
  assert.ok(state.accounts.k2, "отметки сохранённого аккаунта остались");
  assert.equal(state.accounts.k2.opened["x|1"].at, 1);
});

test("отметка блокирует повторный клейм, пока окно то же", async () => {
  reset();
  const row = { ...sunset, status: "claimable" };
  store.local.kickCases = {
    enabled: true,
    accounts: { current: { login: "me", items: [row], opened: { [cases.caseKey(row)]: { at: Date.now() - 11 * 60 * 1000, rarity: "rare" } }, failed: {}, checkedAt: 0 } },
  };
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "epic" } } }
    : { data: [row] });
  await cases.kickCasesTick({ force: true });
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 0, "второй POST не нужен");
});

test("свежая отметка не даёт открыть кейс повторно", async () => {
  reset();
  const row = { ...sunset, status: "claimable" };
  store.local.kickCases = {
    enabled: true,
    accounts: { current: { login: "me", items: [row], opened: { [cases.caseKey(row)]: { at: Date.now(), rarity: "rare" } }, failed: {}, checkedAt: 0 } },
  };
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim") ? { data: { winner: { rarity: "epic" } } } : { data: [row] });
  await cases.kickCasesTick({ force: true });
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 0, "задержка сервера не превращается в двойной клейм");
});

test("отказ /user не приписывает живой вход сохранённому аккаунту", async () => {
  reset();
  // В браузере — сохранённый вход B, проверка логина падает, а в состоянии лежит чужой ник.
  cookie = "tokB";
  store.local.kick = { user: "alice", enabled: true };
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }, { id: "B", login: "bob" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { A: [{ name: "session_token", value: "tokA" }], B: [{ name: "session_token", value: "tokB" }] },
    twitch: {},
  };
  net["kick.com/api/v1/user"] = { status: 500, body: {} };
  // Кейс A ещё не набран: второй клейм был бы двойным.
  net["gamification/challenges"] = (init, url) => {
    if (String(url).includes("/claim")) return { data: { winner: { rarity: "rare" } } };
    const foreign = String(init.headers?.Authorization || "").includes("tokA");
    return { data: [{ ...sunset, id: foreign ? "a-case" : sunset.id, status: foreign ? "in_progress" : "claimable" }] };
  };
  await cases.kickCasesTick({ force: true });
  const claims = calls.filter((call) => call.url.includes("/claim"));
  assert.equal(claims.length, 1, "один клейм на один аккаунт");
  assert.equal(claims[0].init.headers.Authorization, "Bearer tokB");
  const history = store.local.history || [];
  assert.deepEqual(history.map((item) => item.account), ["bob"], "чужой ник в историю не попал");
});

test("живой вход без записи не занимает место активного аккаунта", async () => {
  reset();
  cookie = "tokC";
  store.local.kick = { user: "carol", enabled: true };
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = { kick: { A: [{ name: "session_token", value: "tokA" }] }, twitch: {} };
  net["kick.com/api/v1/user"] = { username: "carol" };
  net["gamification/challenges"] = (init, url) => {
    if (String(url).includes("/claim")) return { data: { winner: { rarity: "common" } } };
    const foreign = String(init.headers?.Authorization || "").includes("tokA");
    return { data: [{ ...sunset, id: foreign ? "a-case" : "carol-case", name: foreign ? "A Case" : "Carol Case", status: foreign ? "in_progress" : "claimable" }] };
  };
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(state.accounts.A.login, "alice", "чужой кейс не приписан активному A");
  assert.equal(state.accounts.A.items[0].id, "a-case");
  assert.equal(state.accounts["live:carol"].items[0].id, "carol-case");
  assert.equal(state.liveId, "live:carol");
  const claims = calls.filter((call) => call.url.includes("/claim"));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].init.headers.Authorization, "Bearer tokC");
});

test("смена куки обновляет liveId, даже когда отметки свежие", async () => {
  reset();
  cookie = "tokB";
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }, { id: "B", login: "bob" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { A: [{ name: "session_token", value: "tokA" }], B: [{ name: "session_token", value: "tokB" }] },
    twitch: {},
  };
  const now = Date.now();
  // Прошлый проход считал живым A; в браузере уже сохранённый вход B.
  store.local.kickCases = {
    enabled: true,
    liveId: "A",
    accounts: {
      A: { login: "alice", items: [], opened: {}, failed: {}, checkedAt: now, served: true },
      B: { login: "bob", items: [], opened: {}, failed: {}, checkedAt: now, served: true },
    },
  };
  net["gamification/challenges"] = { data: [] };
  const state = await cases.kickCasesTick();
  assert.equal(state.liveId, "B");
  assert.ok(state.liveIdAt > 0, "момент записи liveId сохранён");
  assert.ok(calls.length > 0, "проход был, хотя отметки свежие");
});

test("убранный аккаунт не оставляет кейсов, истёкший — остаётся без обслуживания", async () => {
  reset();
  store.local.accounts = {
    kick: { active: "k1", list: [{ id: "k1", login: "one" }, { id: "k2", login: "two", expired: true }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = { kick: { k1: [{ name: "session_token", value: "tok1" }] }, twitch: {} };
  store.local.kickCases = { enabled: true, accounts: { k9: { login: "gone", items: [], opened: {}, failed: {}, checkedAt: 1 } } };
  net["gamification/challenges"] = { data: [] };
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(state.accounts.k9, undefined, "аккаунта больше нет в списке");
  assert.equal(state.accounts.k2.served, false);
  assert.equal(state.accounts.k2.items.length, 0);
});

test("caseRows: недельный кейс получает ключ по неделе", () => {
  const rows = cases.caseRows({ data: [{ id: "w", name: "Weekly", recurrence: "weekly", condition: { progress: 1, threshold: 5, type: "watch_time_minutes" } }] });
  assert.match(rows[0].key, /^w\|week:\d{4}-W\d{2}$/);
});

test("неопознанный живой токен не открывает кейсы", async () => {
  reset();
  // Токен в браузере не сохранён, а Kick не сказал, чей он: клеймить нельзя — вдруг это
  // сохранённый вход с обновлённым токеном, тогда тот же человек открыл бы кейс дважды.
  cookie = "tokX";
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = { kick: { A: [{ name: "session_token", value: "tokA" }] }, twitch: {} };
  net["kick.com/api/v1/user"] = { status: 500, body: {} };
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "rare" } } }
    : { data: [{ ...sunset, status: "claimable" }] });
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(state.accounts.current.served, false);
  assert.equal(state.accounts.current.unverified, true);
  assert.deepEqual(state.accounts.current.items, []);
  const claims = calls.filter((call) => call.url.includes("/claim"));
  assert.deepEqual(claims.map((call) => call.init.headers.Authorization), ["Bearer tokA"], "клеймит только опознанный вход");
  assert.deepEqual((store.local.history || []).map((item) => item.account), ["alice"]);
});

test("два сохранённых входа с одним логином не открывают кейс дважды", async () => {
  reset();
  cookie = "tokA";
  store.local.accounts = {
    kick: { active: "A", list: [{ id: "A", login: "alice" }, { id: "D", login: "Alice" }] },
    twitch: { active: "", list: [] },
    rotate: { mode: "all", limit: 1 },
  };
  store.local.accountCookies = {
    kick: { A: [{ name: "session_token", value: "tokA" }], D: [{ name: "session_token", value: "tokD" }] },
    twitch: {},
  };
  net["gamification/challenges"] = (init, url) => (String(url).includes("/claim")
    ? { data: { winner: { rarity: "rare" } } }
    : { data: [{ ...sunset, status: "claimable" }] });
  const state = await cases.kickCasesTick({ force: true });
  assert.equal(state.accounts.A.served, true);
  assert.equal(state.accounts.D.served, false, "дубль того же человека не обслуживается");
  assert.equal(calls.filter((call) => call.url.includes("/claim")).length, 1);
});

test("переключатель сохраняется", async () => {
  reset();
  const off = await cases.setKickCasesEnabled(false);
  assert.equal(off.enabled, false);
  assert.equal((await cases.readKickCases()).enabled, false);
  const on = await cases.setKickCasesEnabled(true);
  assert.equal(on.enabled, true);
});