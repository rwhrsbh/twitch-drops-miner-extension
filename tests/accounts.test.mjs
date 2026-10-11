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
    query: async () => [{ id: 9 }],
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
  assert.ok(reloaded.length > 0);
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
