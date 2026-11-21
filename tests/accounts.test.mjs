// node --test tests/  — lib/accounts.js на подставных chrome.cookies / storage / windows.
import test from "node:test";
import assert from "node:assert/strict";

const store = { local: {}, session: {} };
let jar = [];
const windows = { created: [], removed: [] };
const reloaded = [];
// токен -> пользователь Twitch
const users = { tokA: { user_id: "1", login: "alice" }, tokB: { user_id: "2", login: "bob" }, tokC: { user_id: "3", login: "carol" } };

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
  cookies: {
    getAll: async ({ domain }) => jar.filter((item) => item.domain.endsWith(domain)).map((item) => ({ ...item })),
    get: async ({ url, name }) => jar.find((item) => item.name === name && url.includes(item.domain.replace(/^\./, ""))) || null,
    remove: async ({ url, name }) => { jar = jar.filter((item) => !(item.name === name && url.includes(item.domain.replace(/^\./, "")))); },
    set: async (details) => {
      const domain = details.domain || new URL(details.url).hostname;
      jar = jar.filter((item) => !(item.name === details.name && item.domain === domain));
      jar.push({ name: details.name, value: details.value, domain, hostOnly: !details.domain, path: details.path || "/", secure: true, httpOnly: false, sameSite: "no_restriction" });
    },
  },
  windows: {
    create: async (options) => {
      windows.created.push(options);
      const id = 50 + windows.created.length;
      windowTypes[id] = "popup";
      return { id, tabs: [{ id: 500 + windows.created.length }] };
    },
    remove: async (id) => { windows.removed.push(id); delete windowTypes[id]; },
    get: async (id) => {
      if (!(id in windowTypes)) throw new Error("No window");
      return { id, type: windowTypes[id] };
    },
  },
  tabs: {
    query: async () => [{ id: 9 }, { id: 10 }],
    reload: async (id) => { reloaded.push(id); },
    get: async (id) => ({ id, url: tabUrls[id] || "" }),
    update: async (id, patch) => { tabUrls[id] = patch.url; },
  },
  permissions: { contains: async () => googleAllowed },
  declarativeNetRequest: {
    updateSessionRules: async ({ addRules = [] }) => { chooserTabs = addRules[0]?.condition.tabIds || null; },
  },
};
// Окна и вкладки для проверки выбора аккаунта Google.
const windowTypes = {};
const tabUrls = {};
let googleAllowed = true;
let chooserTabs = null;
// токен -> пользователь Kick
const kickUsers = { kA: { id: 11, username: "kalice" }, kB: { id: 12, username: "kbob" } };
globalThis.fetch = async (url, init = {}) => {
  const header = String(init.headers?.Authorization || "");
  if (String(url).includes("kick.com")) {
    const user = kickUsers[header.replace("Bearer ", "")];
    return new Response(JSON.stringify(user || {}), { status: user ? 200 : 401 });
  }
  const user = users[header.replace("OAuth ", "")];
  return new Response(JSON.stringify(user || {}), { status: user ? 200 : 401 });
};
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 5), ...rest);

const accounts = await import("../lib/accounts.js");
const rotation = await import("../lib/rotation.js");

// Тесты ниже про смену по очереди; по умолчанию режим «все сразу».
async function byTurns() {
  await accounts.setRotation({ mode: "campaigns" });
}

function kickLogin(value) {
  jar = jar.filter((item) => !item.domain.endsWith("kick.com"));
  jar.push({ name: "session_token", value, domain: "kick.com", hostOnly: true, path: "/", secure: true, httpOnly: false, sameSite: "lax" });
}
const kickToken = () => jar.find((item) => item.name === "session_token")?.value || "";

function login(token) {
  jar = jar.filter((item) => !item.domain.endsWith("twitch.tv"));
  jar.push({ name: "auth-token", value: token, domain: ".twitch.tv", hostOnly: false, path: "/", secure: true, httpOnly: false, sameSite: "no_restriction" });
  jar.push({ name: "unique_id", value: `dev-${token}`, domain: ".twitch.tv", hostOnly: false, path: "/", secure: true, httpOnly: false, sameSite: "no_restriction" });
}
const token = () => jar.find((item) => item.name === "auth-token")?.value || "";

function reset() {
  store.local = {}; store.session = {}; jar = [];
  windows.created.length = 0; windows.removed.length = 0; reloaded.length = 0;
  for (const key of Object.keys(windowTypes)) delete windowTypes[key];
  for (const key of Object.keys(tabUrls)) delete tabUrls[key];
  googleAllowed = true; chooserTabs = null;
}

// Хуки как в background.js, только записывают, что применили.
function hooks() {
  const calls = [];
  return {
    calls,
    apply: async (platform, account) => {
      calls.push(["apply", platform, account?.login]);
      if (platform === "twitch") {
        store.local.state = { ...(store.local.state || {}), whitelist: account?.whitelist || [] };
        store.local.points = { channels: account?.points || [] };
      } else {
        store.local.settings = { ...(store.local.settings || {}), picked: account?.picked || [] };
      }
    },
    select: async (platform, account, patch) => { calls.push(["select", platform, account.login, patch]); },
  };
}

test("first session is remembered with the current selection", async () => {
  reset(); login("tokA");
  store.local.state = { whitelist: ["g1"] };
  store.local.points = { channels: [{ login: "streamer" }] };
  const data = await accounts.syncCurrent("twitch");
  assert.equal(data.twitch.active, "1");
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["alice"]);
  assert.deepEqual(data.twitch.list[0].whitelist, ["g1"]);
  assert.deepEqual(data.twitch.list[0].points, [{ login: "streamer" }]);
  assert.equal(accounts.publicAccounts(data).twitch.list[0].cookies, undefined);   // куки наружу не отдаём
});

test("add account: login window, cookies saved, browser returns to the previous account", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.startAdd("twitch", h);
  assert.equal(windows.created.length, 1);
  assert.match(windows.created[0].url, /twitch\.tv\/login/);
  assert.equal(token(), "");                       // на время входа сайт разлогинен
  assert.equal(await accounts.nextAccount("twitch", "nothing"), "");   // пока идёт вход, не переключаем
  login("tokB");                                   // пользователь вошёл в окне
  const done = await accounts.finishAdd(h);
  assert.equal(done.login, "bob");
  const data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["alice", "bob"]);
  assert.equal(data.twitch.active, "1");
  assert.equal(token(), "tokA");                   // вернулись к прежнему аккаунту
  assert.deepEqual(windows.removed, [51]);
});

test("add window: only tabs that loaded while it was open are reloaded afterwards", async () => {
  reset(); login("tokA");
  const h = hooks();
  const client = await import("../lib/client.js");
  await accounts.syncCurrent("twitch", h);
  // Вкладка 9 открыта до окна входа: живёт аккаунтом A.
  await client.noteTabLoad(9, "https://www.twitch.tv/a");
  await accounts.startAdd("twitch", h);
  // Пока окно открыто, пользователь открыл вкладку 10: куки общие, она грузится разлогиненной.
  await client.noteTabLoad(10, "https://www.twitch.tv/b");
  assert.equal((await client.tabAccounts([10]))[10], client.UNKNOWN_TAB);
  login("tokB");
  await accounts.finishAdd(h);
  assert.equal(token(), "tokA");
  assert.deepEqual(reloaded, [10], "перезагружена только вкладка, загруженная во время окна входа");
});

test("closing the login window without signing in restores the session", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  const { windowId } = await accounts.startAdd("twitch", h);
  await accounts.cancelAdd(windowId, h);
  assert.equal(token(), "tokA");
  assert.equal((await accounts.readAccounts()).twitch.list.length, 1);
});

async function two() {
  reset(); login("tokA");
  const h = hooks();
  store.local.state = { whitelist: ["gA"] };
  store.local.points = { channels: [{ login: "chanA" }] };
  await accounts.syncCurrent("twitch", h);
  await accounts.startAdd("twitch", h);
  login("tokB");
  await accounts.finishAdd(h);
  // Эти тесты про смену по очереди; по умолчанию у Twitch режим «все сразу».
  await accounts.setRotation({ mode: "campaigns" });
  h.calls.length = 0;
  return h;
}

test("switch swaps cookies and each account keeps its own games and channels", async () => {
  const h = await two();
  await accounts.setSelection("twitch", "2", { whitelist: ["gB"], points: [{ login: "chanB" }] }, h);
  assert.equal(h.calls.length, 0);                 // bob не активен: живое состояние не трогаем
  await accounts.switchTo("twitch", "2", h);
  assert.equal(token(), "tokB");
  assert.equal(jar.find((item) => item.name === "unique_id").value, "dev-tokB");
  assert.deepEqual(store.local.state.whitelist, ["gB"]);
  assert.deepEqual(store.local.points.channels, [{ login: "chanB" }]);
  store.local.state.whitelist = ["gB", "gB2"];     // правка у активного bob
  await accounts.switchTo("twitch", "1", h);
  assert.equal(token(), "tokA");
  assert.deepEqual(store.local.state.whitelist, ["gA"]);
  const data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.find((item) => item.id === "2").whitelist, ["gB", "gB2"]);   // выбор bob сохранён
});

test("selection change for the active account goes to the live state", async () => {
  const h = await two();
  await accounts.setSelection("twitch", "1", { whitelist: ["gA", "gX"] }, h);
  assert.deepEqual(h.calls[0].slice(0, 3), ["select", "twitch", "alice"]);
});

test("user re-logs in on the site: that account becomes active with its selection", async () => {
  const h = await two();
  await accounts.setSelection("twitch", "2", { whitelist: ["gB"] }, h);
  login("tokB");                                   // перелогинился сам
  const data = await accounts.syncCurrent("twitch", h);
  assert.equal(data.twitch.active, "2");
  assert.deepEqual(store.local.state.whitelist, ["gB"]);
  assert.deepEqual(data.twitch.list.find((item) => item.id === "1").whitelist, ["gA"]);
});

test("rotation: after N finished campaigns, or when nothing is left; idle accounts are skipped", async () => {
  await two();
  assert.equal(await accounts.nextAccount("twitch", "campaign"), "");      // ещё ни одной кампании
  await accounts.noteCampaignDone("twitch");
  assert.equal(await accounts.nextAccount("twitch", "campaign"), "2");     // лимит 1 по умолчанию
  await accounts.setRotation({ limit: 3 });
  assert.equal(await accounts.nextAccount("twitch", "campaign"), "");      // 1 из 3
  await accounts.setRotation({ mode: "done" });
  await accounts.noteCampaignDone("twitch");
  await accounts.noteCampaignDone("twitch");
  assert.equal(await accounts.nextAccount("twitch", "campaign"), "");      // в режиме «до конца» кампании не считаем
  assert.equal(await accounts.nextAccount("twitch", "nothing"), "2");      // нечего фармить -> следующий
  const h = hooks();
  await accounts.switchTo("twitch", "2", h);
  assert.equal(await accounts.nextAccount("twitch", "nothing"), "");       // alice отдыхает 30 мин, идти некуда
  await accounts.setRotation({ mode: "never" });
  assert.equal(await accounts.nextAccount("twitch", "nothing"), "");
});

test("one account: nothing to rotate; removal picks another active", async () => {
  reset(); login("tokA");
  await accounts.syncCurrent("twitch");
  assert.equal(await accounts.nextAccount("twitch", "nothing"), "");
  const h = await two();
  void h;
  const data = await accounts.removeAccount("twitch", "1");
  assert.equal(data.twitch.active, "2");
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["bob"]);
});

// ---- Смена по очереди после прохода майнера (lib/rotation.js) ----

test("rotation after a pass: nothing while farming; switches after a finished campaign", async () => {
  const h = await two();
  rotation.resetRotation();
  await accounts.setSelection("twitch", "2", { whitelist: ["gB"] }, h);
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "watching" }, h), "");
  assert.equal(token(), "tokA");
  await accounts.noteCampaignDone("twitch");                                // alice закрыла кампанию
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "watching" }, h), "2");
  assert.equal(token(), "tokB");                                            // браузер под bob
  assert.deepEqual(store.local.state.whitelist, ["gB"]);                    // и его игры
  assert.equal((await accounts.readAccounts()).twitch.done, 0);             // счётчик кампаний с нуля
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "watching" }, h), "");
});

test("rotation after a pass: idle account waits two passes, then the next one; nobody left -> stay", async () => {
  const h = await two();
  rotation.resetRotation();
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "all-claimed" }, h), "");   // первый простой
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "watching" }, h), "");      // простой прервался
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "no-channel" }, h), "");
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "no-channel" }, h), "2");   // второй подряд
  assert.equal(token(), "tokB");
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "all-claimed" }, h), "");
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "all-claimed" }, h), "");   // alice отдыхает: остаёмся
  assert.equal(token(), "tokB");
});

test("rotation after a pass: off when the miner is off, while adding an account, or in manual mode", async () => {
  const h = await two();
  rotation.resetRotation();
  await accounts.noteCampaignDone("twitch");
  assert.equal(await rotation.rotate("twitch", { enabled: false, phase: "idle" }, h), "");
  await accounts.startAdd("twitch", h);
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "watching" }, h), "");
  const { windowId } = (await chrome.storage.local.get("accountAdd")).accountAdd;
  await accounts.cancelAdd(windowId, h);
  await accounts.setRotation({ mode: "never" });
  assert.equal(await rotation.rotate("twitch", { enabled: true, phase: "watching" }, h), "");
  assert.equal(token(), "tokA");
});

// ---- Kick: тот же механизм на куке session_token ----

test("kick: add, switch with its own picked games, rotate", async () => {
  reset(); kickLogin("kA");
  rotation.resetRotation();
  const h = hooks();
  store.local.settings = { picked: ["Rust"] };
  let data = await accounts.syncCurrent("kick", h);
  assert.deepEqual(data.kick.list.map((item) => item.login), ["kalice"]);
  assert.deepEqual(data.kick.list[0].picked, ["Rust"]);
  await accounts.startAdd("kick", h);
  assert.match(windows.created[0].url, /kick\.com/);
  assert.equal(kickToken(), "");
  kickLogin("kB");
  assert.equal((await accounts.finishAdd(h)).login, "kbob");
  assert.equal(kickToken(), "kA");                                          // вернулись к прежнему
  await byTurns();
  await accounts.setSelection("kick", "12", { picked: ["Minecraft"] }, h);
  await accounts.switchTo("kick", "12", h);
  assert.equal(kickToken(), "kB");
  assert.deepEqual(store.local.settings.picked, ["Minecraft"]);
  assert.equal(jar.some((item) => item.domain.endsWith("twitch.tv")), false); // куки Twitch не трогаем
  await accounts.noteCampaignDone("kick");
  assert.equal(await rotation.rotate("kick", { enabled: true, phase: "watching" }, h), "11");
  assert.equal(kickToken(), "kA");
  assert.deepEqual(store.local.settings.picked, ["Rust"]);
});

test("twitch and kick accounts are independent", async () => {
  await two();
  kickLogin("kA");
  const h = hooks();
  await accounts.syncCurrent("kick", h);
  await accounts.switchTo("twitch", "2", h);
  assert.equal(token(), "tokB");
  assert.equal(kickToken(), "kA");
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.active, "2");
  assert.equal(data.kick.active, "11");
});

test("dead session: active account is marked as needing sign-in, cleared after a new sign-in", async () => {
  await two();
  const h = hooks();
  const alice = users.tokA;
  delete users.tokA;                                                         // пользователь нажал «Выйти» на сайте
  try {
    let data = await accounts.syncCurrent("twitch", h);
    assert.equal(data.twitch.list.find((item) => item.id === "1").expired, true);
    assert.equal(accounts.publicAccounts(data).twitch.list.find((item) => item.id === "1").expired, true);
    users.tokA2 = alice;
    login("tokA2");
    data = await accounts.syncCurrent("twitch", h);
    assert.equal(data.twitch.list.find((item) => item.id === "1").expired, false);
  } finally {
    users.tokA = alice;
    delete users.tokA2;
  }
});

test("dead session: switching to a dead account marks it and keeps the working one; rotation skips it", async () => {
  await two();
  const h = hooks();
  const bob = users.tokB;
  delete users.tokB;
  try {
    const data = await accounts.switchTo("twitch", "2", h);
    assert.equal(data.twitch.active, "1");
    assert.equal(token(), "tokA");
    assert.equal(data.twitch.list.find((item) => item.id === "2").expired, true);
    await accounts.noteCampaignDone("twitch");
    assert.equal(await accounts.nextAccount("twitch", "campaign"), "");
  } finally {
    users.tokB = bob;
  }
});

test("mode 'all': accounts farm in parallel, nobody is rotated", async () => {
  await two();
  await accounts.setRotation({ mode: "all" });
  await accounts.noteCampaignDone("twitch");
  assert.equal(await accounts.nextAccount("twitch", "campaign"), "");
  assert.equal(await accounts.nextAccount("twitch", "nothing"), "");
  assert.equal((await accounts.readAccounts()).rotate.mode, "all");
});

// ---- Находки ревью: удаление активного, окно входа, раздельное хранение кук ----

test("removing the active account signs the browser over to the next one and leaks nothing", async () => {
  const h = await two();
  await accounts.setSelection("twitch", "2", { whitelist: ["gB"] }, h);
  h.calls.length = 0;
  let data = await accounts.removeAccount("twitch", "1", h);
  assert.equal(token(), "tokB", "браузер перешёл на оставшийся аккаунт");
  assert.equal(data.twitch.active, "2");
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["bob"]);
  assert.ok(h.calls.some((call) => call.includes("bob") || call.includes("2")), `хук применил выбор bob: ${JSON.stringify(h.calls)}`);
  data = await accounts.syncCurrent("twitch", h);
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["bob"], "удалённый аккаунт не вернулся сам");
  assert.deepEqual(data.twitch.list[0].whitelist, ["gB"], "выбор bob не затёрт выбором удалённого");
});

test("removing the only account signs the site out, so it does not come back", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.removeAccount("twitch", "1", h);
  assert.equal(token(), "");
  const data = await accounts.syncCurrent("twitch", h);
  assert.deepEqual(data.twitch.list, []);
  assert.equal(data.twitch.active, "");
});

test("removing a non-active account touches neither cookies nor the active one", async () => {
  const h = await two();
  const data = await accounts.removeAccount("twitch", "2", h);
  assert.equal(token(), "tokA");
  assert.equal(data.twitch.active, "1");
  assert.deepEqual(h.calls, []);
});

test("add window for another platform gives the first platform its session back", async () => {
  const h = await two();
  await accounts.startAdd("twitch", h);
  assert.equal(token(), "");
  await accounts.startAdd("kick", h);
  assert.equal(token(), "tokA", "Twitch не остался разлогиненным");
  assert.equal(store.local.accountAdd.platform, "kick");
  assert.equal(windows.removed.length >= 1, true, "прежнее окно закрыто");
});

test("switching while an add window is open cancels the add instead of being undone", async () => {
  const h = await two();
  await accounts.startAdd("twitch", h);
  const data = await accounts.switchTo("twitch", "2", h);
  assert.equal(store.local.accountAdd, undefined);
  assert.equal(data.twitch.active, "2");
  assert.equal(token(), "tokB");
  assert.equal(data.twitch.list.length, 2);
  assert.equal(await accounts.finishAdd(h), null, "добавлять больше нечего");
  assert.equal((await accounts.readAccounts()).twitch.active, "2");
});

test("login window failed to open: the site keeps its session", async () => {
  const h = await two();
  const create = chrome.windows.create;
  chrome.windows.create = async () => { throw new Error("no window"); };
  try {
    await assert.rejects(accounts.startAdd("twitch", h));
    assert.equal(token(), "tokA");
    assert.equal(store.local.accountAdd, undefined);
  } finally {
    chrome.windows.create = create;
  }
});

test("cookies are stored apart from the account list the popup listens to", async () => {
  await two();
  assert.ok(store.local.accounts.twitch.list.every((item) => !("cookies" in item)));
  assert.ok(!JSON.stringify(store.local.accounts).includes("tokA"));
  assert.equal(store.local.accountCookies.twitch["1"].find((item) => item.name === "auth-token").value, "tokA");
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.list[1].cookies.find((item) => item.name === "auth-token").value, "tokB");
});

test("old storage format with inline cookies still reads", async () => {
  reset();
  store.local.accounts = { twitch: { active: "1", done: 0, list: [{ id: "1", login: "alice", cookies: [{ name: "auth-token", value: "tokA" }] }] } };
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.list[0].cookies[0].value, "tokA");
});

test("concurrent writers do not overwrite each other", async () => {
  const h = await two();
  await Promise.all([
    accounts.switchTo("twitch", "2", h),
    accounts.setSelection("twitch", "1", { whitelist: ["gX"] }, h),
    accounts.setRotation({ mode: "done" }),
    accounts.noteCampaignDone("kick"),
  ]);
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.active, "2");
  assert.deepEqual(data.twitch.list.find((item) => item.id === "1").whitelist, ["gX"]);
  assert.equal(data.rotate.mode, "done");
  assert.equal(data.kick.done, 1);
});

test("a check that lands between the cookie swap and the miner hook does not copy the old account's games", async () => {
  const h = await two();
  await accounts.setSelection("twitch", "2", { whitelist: ["gB"] }, h);
  // Хук как в жизни: живое состояние меняется не мгновенно.
  const slow = {
    apply: async (platform, account) => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      await h.apply(platform, account);
    },
    // Как в background.js: выбор активного аккаунта попадает в живое состояние майнера.
    select: async (platform, account, patch) => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      if (patch.whitelist) store.local.state = { ...(store.local.state || {}), whitelist: patch.whitelist };
    },
  };
  await Promise.all([
    accounts.switchTo("twitch", "2", slow),
    accounts.syncCurrent("twitch", slow),
    accounts.syncCurrent("twitch", slow),
  ]);
  let data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.find((item) => item.id === "2").whitelist, ["gB"], "у bob остался его выбор");
  assert.deepEqual(data.twitch.list.find((item) => item.id === "1").whitelist, ["gA"], "у alice остался её выбор");
  // И обратно, с выбором активного аккаунта, изменённым прямо перед сменой.
  await Promise.all([
    accounts.setSelection("twitch", "2", { whitelist: ["gB2"] }, slow),
    accounts.syncCurrent("twitch", slow),
    accounts.switchTo("twitch", "1", slow),
    accounts.syncCurrent("twitch", slow),
  ]);
  data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.find((item) => item.id === "2").whitelist, ["gB2"]);
  assert.deepEqual(data.twitch.list.find((item) => item.id === "1").whitelist, ["gA"]);
  assert.deepEqual(store.local.state.whitelist, ["gA"], "в живом состоянии выбор активного аккаунта");
});

test("known account signs in while nobody is active: its own games are applied, not wiped", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.setSelection("twitch", "1", { whitelist: ["g1"], wishes: ["Later"] }, h);
  // Активного не стало (так бывает после удаления активного аккаунта), живой выбор пуст.
  store.local.accounts.twitch.active = "";
  store.local.state = { whitelist: [] };
  h.calls.length = 0;
  await accounts.syncCurrent("twitch", h);
  assert.deepEqual(h.calls, [["apply", "twitch", "alice"]]);
  await accounts.syncCurrent("twitch", h);
  const mine = (await accounts.readAccounts()).twitch.list[0];
  assert.deepEqual(mine.whitelist, ["g1"]);
  assert.equal((await accounts.readAccounts()).twitch.active, "1");
});

test("a check during an open login window does not mark the account as signed out", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.startAdd("twitch", h);          // сайт разлогинен на время входа
  await accounts.syncCurrent("twitch", h);
  assert.ok(!(await accounts.readAccounts()).twitch.list[0].expired);
  // Автоматическая смена окно входа не закрывает; ручная закрывает.
  await accounts.switchTo("twitch", "1", h, true);
  assert.equal(await accounts.addPending(), true);
  await accounts.switchTo("twitch", "1", h);
  assert.equal(await accounts.addPending(), false);
});

test("google chooser: the login window and its opener-less popup are covered, other windows are not", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  const { windowId } = await accounts.startAdd("twitch", h);
  const first = chooserTabs.slice();
  assert.equal(first.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  // Twitch открывает Google отдельным всплывающим окном, у вкладки нет openerTabId.
  windowTypes[70] = "popup";
  tabUrls[701] = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";
  await accounts.noteAddTab({ id: 701, windowId: 70 });
  assert.deepEqual(chooserTabs, [...first, 701]);
  // Вкладка уже ушла на Google без выбора аккаунта: открываем тот же адрес с выбором.
  assert.match(tabUrls[701], /prompt=select_account/);
  // Обычная вкладка в обычном окне, окно другого расширения и неизвестное окно в правило не попадают.
  windowTypes[71] = "normal";
  await accounts.noteAddTab({ id: 711, windowId: 71 });
  windowTypes[72] = "popup";
  await accounts.noteAddTab({ id: 721, windowId: 72, pendingUrl: "chrome-extension://abc/popup.html" });
  await accounts.noteAddTab({ id: 731, windowId: 73 });
  assert.deepEqual(chooserTabs, [...first, 701]);
  // Вкладка, открытая из окна входа, попадает.
  await accounts.noteAddTab({ id: 741, windowId: 74, openerTabId: first[0] });
  assert.deepEqual(chooserTabs, [...first, 701, 741]);
  await accounts.cancelAdd(windowId, h);
  assert.equal(chooserTabs, null);
  // Входа нет: новые вкладки никуда не записываются.
  await accounts.noteAddTab({ id: 751, windowId: 70 });
  assert.equal(chooserTabs, null);
});

test("google chooser: without the permission nothing is installed or re-navigated", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  googleAllowed = false;
  const { windowId } = await accounts.startAdd("twitch", h);
  windowTypes[70] = "popup";
  tabUrls[701] = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";
  await accounts.noteAddTab({ id: 701, windowId: 70 });
  assert.equal(chooserTabs, null);
  assert.doesNotMatch(tabUrls[701], /prompt=/);
  await accounts.cancelAdd(windowId, h);
});

test("a failing miner hook does not cancel the next ones", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  login("tokB");
  await accounts.syncCurrent("twitch", h);
  let fail = true;
  const flaky = { ...h, apply: async (...args) => { if (fail) { fail = false; throw new Error("boom"); } return h.apply(...args); } };
  await accounts.switchTo("twitch", "1", flaky);
  // Хук упал, но очередь жива: неприменённый выбор применяется заново, затем идёт следующая смена.
  h.calls.length = 0;
  await accounts.switchTo("twitch", "2", flaky);
  assert.deepEqual(h.calls.filter((call) => call[0] === "apply"), [["apply", "twitch", "alice"], ["apply", "twitch", "bob"]]);
  assert.deepEqual(store.local.accountApply, { twitch: false });
  // Выбор активного аккаунта снова копируется из живого состояния (счётчик не застрял).
  store.local.state = { whitelist: ["zz"] };
  await accounts.syncCurrent("twitch", flaky);
  assert.deepEqual((await accounts.readAccounts()).twitch.list.find((item) => item.id === "2").whitelist, ["zz"]);
});

// ---- Второе ревью: обрывы посреди действия ----

test("browser restarted with the login window open: the previous session comes back, nobody is marked signed out", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.startAdd("twitch", h);
  assert.equal(token(), "");
  // Перезапуск: session очищен, окна больше нет, а журнал входа остался в local.
  store.session = {};
  for (const key of Object.keys(windowTypes)) delete windowTypes[key];
  await accounts.recover(h);
  assert.equal(token(), "tokA");
  assert.equal(await accounts.addPending(), false);
  await accounts.syncCurrent("twitch", h);
  const mine = (await accounts.readAccounts()).twitch;
  assert.equal(mine.active, "1");
  assert.equal(mine.list[0].expired, false);
});

test("worker stopped in the middle of a cookie swap: the target account's cookies are put back", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  login("tokB");
  await accounts.syncCurrent("twitch", h);
  // Куки уже стёрты, новые не записаны, журнал подмены остался.
  jar = [];
  store.local.accountSwap = { platform: "twitch", id: "1" };
  await accounts.syncCurrent("twitch", h);
  assert.equal(token(), "tokA");
  assert.equal(store.local.accountSwap, undefined);
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.active, "1");
  assert.ok(data.twitch.list.every((item) => !item.expired));
});

test("worker stopped before the account's games reached the miner: they are applied on the next check", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.setSelection("twitch", "1", { whitelist: ["mine"] }, h);
  // В живом состоянии остался чужой выбор, метка «не применено» стоит.
  store.local.state = { whitelist: ["foreign"] };
  store.local.accountApply = { twitch: true };
  h.calls.length = 0;
  await accounts.syncCurrent("twitch", h);
  assert.deepEqual(h.calls, [["apply", "twitch", "alice"]]);
  assert.deepEqual((await accounts.readAccounts()).twitch.list[0].whitelist, ["mine"]);
  assert.deepEqual(store.local.accountApply, { twitch: false });
});

test("first account added through the login window keeps the games picked before signing in", async () => {
  reset();
  const h = hooks();
  store.local.state = { whitelist: ["g9"] };
  await accounts.startAdd("twitch", h);
  login("tokA");
  await accounts.finishAdd(h);
  const mine = (await accounts.readAccounts()).twitch;
  assert.equal(mine.active, "1");
  assert.deepEqual(mine.list[0].whitelist, ["g9"]);
  assert.deepEqual(store.local.state.whitelist, ["g9"]);
});

test("games ticked while the login window is open are not lost, whether the add is cancelled or finished", async () => {
  for (const finish of [false, true]) {
    reset(); login("tokA");
    const h = hooks();
    await accounts.syncCurrent("twitch", h);
    const { windowId } = await accounts.startAdd("twitch", h);
    store.local.state = { whitelist: ["late"] };
    if (finish) {
      login("tokB");
      await accounts.finishAdd(h);
    } else {
      await accounts.cancelAdd(windowId, h);
    }
    assert.equal(token(), "tokA");
    const mine = (await accounts.readAccounts()).twitch;
    assert.deepEqual(mine.list.find((item) => item.id === "1").whitelist, ["late"]);
    assert.deepEqual(store.local.state.whitelist, ["late"]);
    if (finish) assert.deepEqual(mine.list.find((item) => item.id === "2").whitelist, []);
  }
});

test("changing the rotation mode resets the campaign counter; a failed step still lets the queue settle", async () => {
  const h = await two();
  await accounts.noteCampaignDone("twitch");
  await accounts.noteCampaignDone("twitch");
  assert.equal((await accounts.setRotation({ limit: 3 })).twitch.done, 2);
  assert.equal((await accounts.setRotation({ mode: "done" })).twitch.done, 0);
  // Окно входа не открылось уже после отложенного хука: счётчик не застревает, выбор снова копируется.
  kickLogin("kA");
  await accounts.syncCurrent("kick", h);
  await accounts.startAdd("kick", h);
  const create = chrome.windows.create;
  chrome.windows.create = async () => { throw new Error("no window"); };
  try {
    await assert.rejects(accounts.startAdd("twitch", h));
  } finally {
    chrome.windows.create = create;
  }
  store.local.settings = { picked: ["After"] };
  await accounts.syncCurrent("kick", h);
  const kick = (await accounts.readAccounts()).kick;
  assert.equal(kick.active, "11");
  assert.deepEqual(kick.list[0].picked, ["After"]);
});

test("removing an account first remembers the session the user signed in to by hand", async () => {
  const h = await two();
  login("tokC");
  await accounts.removeAccount("twitch", "1", h);
  const data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.map((item) => item.login).sort(), ["bob", "carol"]);
  assert.equal(data.twitch.active, "3");
  assert.equal(token(), "tokC");
});

// ---- Аккаунт браузера: возврат после смены ради integrity и выбор в попапе ----

async function three() {
  const h = await two();
  await accounts.startAdd("twitch", h);
  login("tokC");
  await accounts.finishAdd(h);
  await accounts.setRotation({ mode: "all" });
  h.calls.length = 0;
  return h;
}

test("browser account, auto: after a switch for integrity the oldest account comes back when the claim is done", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  const t0 = Date.now();
  // Боб ждал integrity: расширение увело браузер к нему.
  await accounts.switchTo("twitch", "2", h, true);
  let data = await accounts.readAccounts();
  assert.equal(data.twitch.active, "2");
  assert.equal(data.twitch.back.reason, "auto");
  assert.equal(accounts.homeId(data.twitch), "1", "авто — самый старый из добавленных");
  // Первые минуты браузер нужен основному майнеру: вкладка, токен, клейм.
  assert.equal(await home.homeTarget("twitch", t0 + 60 * 1000), "");
  // Дроп всё ещё ждёт клейма — держим, пока не выйдет предел.
  store.local.state = { phase: "claim-pending", queue: [] };
  assert.equal(await home.homeTarget("twitch", t0 + home.MIN_AWAY + 1000), "");
  assert.equal(await home.homeTarget("twitch", t0 + home.MAX_AWAY + 1000), "1", "дольше предела не держим");
  // Клейм прошёл — возвращаем сразу после минимальной паузы.
  store.local.state = { phase: "watching", queue: [{ id: "d", required: 10, current: 10, claimed: true }] };
  assert.equal(await home.homeTarget("twitch", t0 + home.MIN_AWAY + 1000), "1");
  // Другой аккаунт тоже ждёт integrity — сначала он.
  store.local.side = { 3: { needsMain: true } };
  assert.equal(await home.homeTarget("twitch", t0 + home.MIN_AWAY + 1000), "");
  delete store.local.side;
  await accounts.switchTo("twitch", "1", h, true);
  data = await accounts.readAccounts();
  assert.equal(token(), "tokA");
  assert.equal(data.twitch.back, null, "вернулись — возвращать больше некого");
  assert.equal(await home.homeTarget("twitch"), "");
});

test("browser account, chosen: picked in the popup goes to the browser at once; after an integrity switch it comes back", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  store.local.state = { phase: "watching", queue: [] };
  await accounts.setHome("twitch", "3");
  let data = await accounts.readAccounts();
  assert.equal(data.twitch.back.reason, "select");
  assert.equal(await home.homeTarget("twitch"), "3", "выбор применяется без паузы");
  // Пока другой аккаунт ждёт integrity, выбранный ждёт своей очереди.
  store.local.side = { 2: { needsMain: true } };
  assert.equal(await home.homeTarget("twitch"), "");
  delete store.local.side;
  await accounts.switchTo("twitch", "3", h, true);
  assert.equal(token(), "tokC");
  assert.equal((await accounts.readAccounts()).twitch.back, null);
  // Расширение увело браузер к бобу ради integrity — потом возвращается к выбранной Кэрол, а не к самому старому.
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal(await home.homeTarget("twitch", Date.now() + home.MIN_AWAY + 1000), "3");
  // Ручная смена — выбор пользователя: назад не тянем.
  await accounts.switchTo("twitch", "1", h);
  data = await accounts.readAccounts();
  assert.equal(data.twitch.back, null);
  assert.equal(await home.homeTarget("twitch", Date.now() + home.MAX_AWAY + 1000), "");
  // «Авто» само по себе ничего не переключает.
  await accounts.setHome("twitch", "");
  assert.equal((await accounts.readAccounts()).twitch.home, "");
  assert.equal(await home.homeTarget("twitch"), "");
});

test("browser account: only in 'all' mode, never to a signed-out account, removal falls back to auto", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  store.local.state = {};
  await accounts.setHome("twitch", "3");
  await accounts.setRotation({ mode: "campaigns" });
  assert.equal(await home.homeTarget("twitch"), "", "по очереди: браузер и есть фармящий аккаунт");
  await accounts.setRotation({ mode: "all" });
  const data = await accounts.readAccounts();
  data.twitch.list.find((item) => item.id === "3").expired = true;
  await chrome.storage.local.set({ accounts: { ...(await chrome.storage.local.get("accounts")).accounts, twitch: { ...data.twitch, list: data.twitch.list.map(({ cookies, ...rest }) => rest) } } });
  assert.equal(await home.homeTarget("twitch"), "", "выбранный разлогинен — другого без спроса не ставим");
  await accounts.removeAccount("twitch", "3", h);
  assert.equal((await accounts.readAccounts()).twitch.home, "");
});

test("browser account works the same for kick: a chosen account is put into the browser", async () => {
  reset(); kickLogin("kA");
  const h = hooks();
  const home = await import("../lib/home.js");
  await accounts.syncCurrent("kick", h);
  await accounts.startAdd("kick", h);
  kickLogin("kB");
  await accounts.finishAdd(h);
  assert.equal(kickToken(), "kA");
  await accounts.setHome("kick", "12");
  assert.equal(await home.homeTarget("kick"), "12");
  await accounts.switchTo("kick", "12", h, true);
  assert.equal(kickToken(), "kB");
  assert.equal((await accounts.readAccounts()).kick.back, null);
  assert.equal(accounts.publicAccounts(await accounts.readAccounts()).kick.homeId, "12");
});

test("browser account, auto: returns to the account that was in the browser, not to the oldest", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  store.local.state = { phase: "watching", queue: [] };
  // Пользователь сам держит в браузере Кэрол (не самую старую).
  await accounts.switchTo("twitch", "3", h);
  // Integrity понадобился самой старой Алисе: браузер уходит к ней и потом возвращается к Кэрол.
  await accounts.switchTo("twitch", "1", h, true);
  let data = await accounts.readAccounts();
  assert.equal(data.twitch.back.from, "3");
  assert.equal(await home.homeTarget("twitch", Date.now() + home.MIN_AWAY + 1000), "3");
  // Цепочка автосмен помнит исходный аккаунт.
  await accounts.switchTo("twitch", "2", h, true);
  data = await accounts.readAccounts();
  assert.equal(data.twitch.back.from, "3");
  await accounts.switchTo("twitch", "3", h, true);
  assert.equal((await accounts.readAccounts()).twitch.back, null);
  assert.equal(token(), "tokC");
});

test("auto switches leave the user's tabs alone; manual switches reload them", async () => {
  const h = await three();
  reloaded.length = 0;
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal(token(), "tokB");
  assert.deepEqual(reloaded, [], "вкладки пользователя не перезагружаются");
  await accounts.switchTo("twitch", "1", h);
  assert.ok(reloaded.length > 0, "ручная смена — перезагружаем, чтобы пользователь видел новый аккаунт");
});

test("choosing Auto drops a pending return to the old choice; changing the mode drops any pending return", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  store.local.state = {};
  await accounts.setHome("twitch", "3");
  assert.equal((await accounts.readAccounts()).twitch.back.reason, "select");
  await accounts.setHome("twitch", "");
  assert.equal((await accounts.readAccounts()).twitch.back, null, "«Авто» само ничего не переключает");
  assert.equal(await home.homeTarget("twitch"), "");
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal((await accounts.readAccounts()).twitch.back.reason, "auto");
  await accounts.setRotation({ mode: "campaigns" });
  await accounts.setRotation({ mode: "all" });
  assert.equal((await accounts.readAccounts()).twitch.back, null);
});

test("an account whose drop did not get claimed is not promoted again for the same drop", async () => {
  const home = await import("../lib/home.js");
  reset();
  store.local.state = { phase: "claim-pending", queue: [
    { id: "d1", required: 10, current: 10, claimed: false },
    { id: "r1", kind: "reward", status: "CLAIMABLE", required: 60, current: 60, claimed: false },
    { id: "c1", kind: "reward", status: "CLAIMABLE", required: 60, current: 60, claimed: false },
    { id: "w1", required: 10, current: 3, claimed: false },
  ], rewardChoice: [{ id: "c1" }] };
  assert.deepEqual(home.readyIds(store.local.state), ["d1", "r1"], "сундук с выбором и недобранный не в счёт");
  await home.blockAccount("2", home.readyIds(store.local.state));
  const blocks = await home.readBlocks();
  assert.equal(home.promotable("2", { needsMain: true, needIds: ["d1"] }, blocks), false, "тот же дроп — не поднимаем");
  assert.equal(home.promotable("2", { needsMain: true, needIds: ["d1", "d2"] }, blocks), true, "новый дроп — поднимаем, майнер заберёт оба");
  assert.equal(home.promotable("3", { needsMain: true, needIds: ["d1"] }, blocks), true, "блок у каждого аккаунта свой");
  assert.equal(home.promotable("2", { needsMain: false }, blocks), false);
  assert.equal(home.promotable("2", { needsMain: true, needIds: ["d1"] }, await home.readBlocks(Date.now() + 25 * 3600e3)), true, "блок живёт сутки");
});

// ---- Сценарий целиком: браузер на A, в расширение добавлены A, B, C ----

test("сценарий: A в браузере, добавлены A, B, C — авто и выбранный аккаунт браузера", async () => {
  const home = await import("../lib/home.js");
  reset();
  const h = hooks();
  store.local.state = { phase: "watching", queue: [] };   // готовых незабранных дропов нет
  const later = () => Date.now() + home.MIN_AWAY + 1000;    // прошло больше трёх минут
  const where = async () => (await accounts.readAccounts()).twitch.active;

  // Пользователь залогинен на сайте как A, расширение запоминает A.
  login("tokA");
  await accounts.syncCurrent("twitch", h);
  // Добавляет B, потом C: каждый раз окно входа, после него браузер возвращается на A.
  for (const next of ["tokB", "tokC"]) {
    await accounts.startAdd("twitch", h);
    login(next);
    await accounts.finishAdd(h);
  }
  const data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["alice", "bob", "carol"], "порядок добавления");
  assert.equal(data.rotate.mode, "all");
  assert.equal(token(), "tokA", "после добавления в браузере по-прежнему A");
  assert.equal(await where(), "1");
  assert.equal(data.twitch.home, "", "по умолчанию — авто");
  assert.equal(await home.homeTarget("twitch"), "", "пока никто не уводил браузер, авто ничего не делает");

  // ---- АВТО ----
  // B нужен integrity для клейма: расширение ставит B в браузер.
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal(token(), "tokB");
  assert.equal(await home.homeTarget("twitch"), "", "первые 3 минуты браузер нужен для клейма B");
  assert.equal(await home.homeTarget("twitch", later()), "1", "клейм прошёл — возвращаем A, на котором был браузер");
  // Пока браузер на B, integrity понадобился и C: уходим на C, но помним, что вернуть надо A.
  await accounts.switchTo("twitch", "3", h, true);
  assert.equal(token(), "tokC");
  assert.equal((await accounts.readAccounts()).twitch.back.from, "1");
  assert.equal(await home.homeTarget("twitch", later()), "1");
  await accounts.switchTo("twitch", "1", h, true);          // так делает returnHome в background.js
  assert.equal(token(), "tokA", "вернулись на A");
  assert.equal(await home.homeTarget("twitch", later()), "", "возвращать больше некого");

  // Пользователь сам переключился на C (клик в попапе): это его выбор, назад не тянем.
  await accounts.switchTo("twitch", "3", h);
  assert.equal(await home.homeTarget("twitch", later()), "");
  // Теперь integrity нужен B: после клейма авто вернёт C — там, где браузер был, а не самый старый A.
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal(await home.homeTarget("twitch", later()), "3");
  await accounts.switchTo("twitch", "3", h, true);
  assert.equal(token(), "tokC");

  // ---- ВЫБРАН КОНКРЕТНЫЙ: B ----
  // Браузер на C. Выбрали B — браузер свободен, ставим B сразу, без трёхминутной паузы.
  await accounts.setHome("twitch", "2");
  assert.equal(await home.homeTarget("twitch"), "2");
  // Но если в этот момент другой аккаунт ждёт integrity, B ждёт, пока браузер освободится.
  store.local.side = { 1: { needsMain: true, needIds: ["d1"] } };
  assert.equal(await home.homeTarget("twitch"), "", "занято: сначала клейм A");
  delete store.local.side;
  assert.equal(await home.homeTarget("twitch"), "2", "освободилось — ставим B");
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal(token(), "tokB");
  // A понадобился integrity: уходим на A, после клейма возвращаем выбранный B.
  await accounts.switchTo("twitch", "1", h, true);
  assert.equal(await home.homeTarget("twitch", later()), "2");
  await accounts.switchTo("twitch", "2", h, true);
  assert.equal(token(), "tokB");
  // Пользователь сам переключился на C: сразу не тянем назад...
  await accounts.switchTo("twitch", "3", h);
  assert.equal(await home.homeTarget("twitch", later()), "");
  // ...но после следующей смены ради клейма браузер возвращается к выбранному B, а не к C.
  await accounts.switchTo("twitch", "1", h, true);
  assert.equal(await home.homeTarget("twitch", later()), "2");

  // Переключили обратно на «авто», пока браузер ещё на A ради клейма: авто вернёт туда, где браузер был
  // до этой смены, — на C (туда пользователь переключился сам).
  await accounts.setHome("twitch", "");
  assert.equal(await home.homeTarget("twitch", later()), "3");
});

// ---- Находки второго ревью: блок, перезагрузка при выборе, from, проверка в очереди ----

test("block on return: only after a switch for a claim, by the drops it was taken for, with window keys", async () => {
  const home = await import("../lib/home.js");
  const back = (reason, need) => ({ active: "2", back: { reason, at: 1, from: "1", need } });
  // Майнер под B не успел построить очередь (пусто), но ради чего уводили — известно.
  assert.deepEqual(home.returnBlock(back("auto", { 2: ["d1"] }), { queue: [] }, "1"), { account: "2", ids: ["d1"] });
  // Дроп в очереди уже забран — его не блокируем.
  assert.equal(home.returnBlock(back("auto", { 2: ["d1"] }), { queue: [{ id: "d1", claimed: true }] }, "1"), null);
  // Возврат к выбранному в попапе — без блока: у аккаунта мог только что созреть дроп.
  assert.equal(home.returnBlock(back("select"), { queue: [{ id: "d1", required: 1, current: 1, claimed: false }] }, "1"), null);
  // Повторяемый сундук блокируется ключом окна: завтрашняя выдача блок не наследует.
  const chest = { id: "g1", kind: "reward", status: "CLAIMABLE", repeatableTimes: 6, windowEndsAt: 500, required: 60, current: 60, claimed: false };
  assert.deepEqual(home.readyIds({ queue: [chest] }), ["g1@500"]);
  const blocks = { 2: { at: Date.now(), ids: ["g1@500"] } };
  assert.equal(home.promotable("2", { needsMain: true, needIds: ["g1@500"] }, blocks), false);
  assert.equal(home.promotable("2", { needsMain: true, needIds: ["g1@900"] }, blocks), true, "новое окно — новая выдача");
  // Пауза держит needsMain, а ждать уже нечего — не поднимаем.
  assert.equal(home.promotable("2", { needsMain: true, needIds: [] }, {}), false);
  assert.equal(home.promotable("2", { needsMain: true }, {}), true, "состояние старой версии без needIds");
});

test("switch for a claim remembers which drops it was for; the in-queue check can cancel a return", async () => {
  const h = await three();
  await accounts.switchTo("twitch", "2", h, true, { need: ["d1", "d2"] });
  let data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.back.need, { 2: ["d1", "d2"] });
  // Цель перепроверяется внутри очереди: передумали — смены нет.
  await accounts.switchTo("twitch", "", h, true, { check: async () => false, target: () => "1" });
  assert.equal(token(), "tokB");
  await accounts.switchTo("twitch", "", h, true, { check: async () => true, target: () => "1" });
  assert.equal(token(), "tokA");
  data = await accounts.readAccounts();
  assert.equal(data.twitch.back, null);
});

test("an account chosen in the popup reloads the tabs; a return after a claim does not", async () => {
  const h = await three();
  reloaded.length = 0;
  await accounts.switchTo("twitch", "3", h, true, { reload: () => true });
  assert.ok(reloaded.length > 0, "выбор в попапе — вкладки перезагружаются");
  reloaded.length = 0;
  await accounts.switchTo("twitch", "2", h, true);
  assert.deepEqual(reloaded, []);
});

test("picking an account while the browser is away and then Auto again keeps 'return where it was'", async () => {
  const h = await three();
  await accounts.switchTo("twitch", "2", h, true);                 // увели с A ради клейма
  await accounts.setHome("twitch", "3");                            // выбрали C, браузер ещё занят
  assert.equal((await accounts.readAccounts()).twitch.back.from, "1");
  await accounts.setHome("twitch", "");                             // передумали: авто
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.back.reason, "auto");
  assert.equal(accounts.returnId(data.twitch), "1", "возвращаем A, а не остаёмся на B");
  // Выбранный аккаунт разлогинен — возвращаем туда, где браузер был.
  await accounts.setHome("twitch", "3");
  const dead = await accounts.readAccounts();
  dead.twitch.list.find((item) => item.id === "3").expired = true;
  assert.equal(accounts.returnId(dead.twitch), "1");
});

test("add window: first account or re-login into an expired one reloads every tab (they were signed out)", async () => {
  // Первый аккаунт: браузер разлогинен, вкладки тоже.
  reset();
  const h = hooks();
  const client = await import("../lib/client.js");
  await client.noteTabLoad(9, "https://www.twitch.tv/a");
  await accounts.startAdd("twitch", h);
  login("tokA");
  await accounts.finishAdd(h);
  assert.equal((await accounts.readAccounts()).twitch.active, "1");
  assert.deepEqual(reloaded.sort(), [10, 9].sort(), "все вкладки: и открытые до окна");
  // Сессия A умерла, пользователь входит в A заново через окно.
  const data = await accounts.readAccounts();
  data.twitch.list[0].expired = true;
  const stored = (await chrome.storage.local.get("accounts")).accounts;
  stored.twitch.list[0].expired = true;
  await chrome.storage.local.set({ accounts: stored });
  reloaded.length = 0;
  await accounts.startAdd("twitch", h);
  login("tokA");
  await accounts.finishAdd(h);
  assert.deepEqual(reloaded.sort(), [10, 9].sort(), "повторный вход в истёкший — тоже все");
});

test("add window: a tab that loads while the cookies are still the added account's is recorded as unknown", async () => {
  reset(); login("tokA");
  const h = hooks();
  const client = await import("../lib/client.js");
  await accounts.syncCurrent("twitch", h);
  await accounts.startAdd("twitch", h);
  login("tokB");
  // Пока finishAdd ждёт куки и подменяет их обратно, пользователь открыл вкладку 11.
  const finishing = accounts.finishAdd(h);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.noteTabLoad(11, "https://www.twitch.tv/c");
  await finishing;
  assert.equal((await client.tabAccounts([11]))[11], client.UNKNOWN_TAB, "не записана как A");
  assert.equal((await chrome.storage.session.get("accountSwitching")).accountSwitching, undefined, "метка снята");
});

// ---- Пятое ревью ----

test("tab record follows the auth-token cookie, not the active account that has not caught up yet", async () => {
  const h = await three();
  const client = await import("../lib/client.js");
  // Пользователь сам вошёл на сайте под Кэрол; сверка ещё не прошла — active всё ещё A.
  login("tokC");
  assert.equal((await accounts.readAccounts()).twitch.active, "1");
  await client.noteTabLoad(21, "https://www.twitch.tv/x");
  assert.equal((await client.tabAccounts([21]))[21], "3", "вкладка записана под Кэрол по куке");
  // Токен, которого нет среди сохранённых (новый вход), — неизвестно.
  login("tokZ");
  await client.noteTabLoad(22, "https://www.twitch.tv/y");
  assert.equal((await client.tabAccounts([22]))[22], client.UNKNOWN_TAB);
  login("tokA");
});

test("going back to 'All at once' with a chosen browser account puts it into the browser again", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  store.local.state = {};
  await accounts.setHome("twitch", "3");
  await accounts.setRotation({ mode: "campaigns" });
  assert.equal((await accounts.readAccounts()).twitch.back, null);
  await accounts.setRotation({ mode: "all" });
  assert.equal((await accounts.readAccounts()).twitch.back?.reason, "select");
  assert.equal(await home.homeTarget("twitch"), "3");
});

test("removing an account leaves no endless pending return", async () => {
  const h = await three();
  await accounts.switchTo("twitch", "2", h, true);                  // увели с A на B
  assert.equal((await accounts.readAccounts()).twitch.back.from, "1");
  await accounts.removeAccount("twitch", "2", h);                   // удалили B: браузер на A
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.active, "1");
  assert.equal(data.twitch.back, null, "возвращать некуда — back снят");
});

// ---- Шестое ревью ----

test("add finish fails after the new account is saved: the previous session comes back at once, the new account stays", async () => {
  reset(); login("tokA");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  await accounts.startAdd("twitch", h);
  login("tokB");
  let fail = true;
  const failing = { ...h, before: () => { if (fail) { fail = false; throw new Error("boom"); } } };
  await assert.rejects(accounts.finishAdd(failing));
  const data = await accounts.readAccounts();
  assert.deepEqual(data.twitch.list.map((item) => item.login), ["alice", "bob"], "новый аккаунт сохранён");
  assert.equal(token(), "tokA", "прежняя сессия возвращена сразу");
  assert.equal(data.twitch.active, "1");
  assert.equal((await chrome.storage.local.get("accountAdd")).accountAdd, undefined, "журнал окна снят — автосмены не стоят");
});

test("add with no live previous account: the window journal is gone before the new account is written", async () => {
  // Повторный вход в истёкший B под C: откат через recover подменил бы куки на мёртвые B.
  reset(); login("tokB");
  const h = hooks();
  await accounts.syncCurrent("twitch", h);
  // Сессия B умерла на сервере: сверка помечает её истёкшей.
  const saved = users.tokB;
  delete users.tokB;
  await accounts.syncCurrent("twitch", h);
  assert.equal((await accounts.readAccounts()).twitch.list[0].expired, true);
  await accounts.startAdd("twitch", h);
  login("tokC");
  const realSet = chrome.storage.local.set;
  let journalAtWrite = "unset";
  chrome.storage.local.set = async (value) => {
    if (value.accounts && journalAtWrite === "unset" && value.accounts.twitch?.active === "3") {
      journalAtWrite = Boolean((await chrome.storage.local.get("accountAdd")).accountAdd);
    }
    return realSet(value);
  };
  try {
    await accounts.finishAdd(h);
  } finally {
    chrome.storage.local.set = realSet;
    users.tokB = saved;
  }
  assert.equal(journalAtWrite, false, "журнала нет к моменту записи — recover не откатит к мёртвому B");
  assert.equal((await accounts.readAccounts()).twitch.active, "3");
});

test("first run with no saved accounts: tabs get no record and stay usable for integrity", async () => {
  reset(); login("tokA");
  const client = await import("../lib/client.js");
  await client.noteTabLoad(31, "https://www.twitch.tv/x");
  assert.deepEqual(await client.tabAccounts([31]), {}, "не «неизвестно» навсегда");
});

test("removing the chosen browser account while its return waits does not pull the browser to the oldest", async () => {
  const h = await three();
  const home = await import("../lib/home.js");
  store.local.state = {};
  await accounts.switchTo("twitch", "3", h);                         // браузер на C (вручную)
  await accounts.setHome("twitch", "2");                             // выбрали B, возврат ждёт
  await accounts.removeAccount("twitch", "2", h);                    // удалили B
  const data = await accounts.readAccounts();
  assert.equal(data.twitch.back, null);
  assert.equal(await home.homeTarget("twitch"), "", "на самый старый A без спроса не уводим");
});
