// Несколько аккаунтов Twitch и Kick в одном профиле браузера.
// Вход остаётся обычным: пользователь логинится на сайте, а расширение запоминает куки сессии.
// Чтобы работать от другого аккаунта, куки сайта подменяются сохранёнными: браузер тоже окажется
// под этим аккаунтом, о чём попап предупреждает перед добавлением.
import { VALIDATE_URL } from "./constants.js";
import { reloadForeignTabs } from "./client.js";

const KEY = "accounts";
// Куки лежат отдельно от списка аккаунтов: попап следит за ключом accounts, и сессии до него не доходят.
const COOKIES = "accountCookies";
const IDLE_MS = 30 * 60 * 1000;
// Журналы незаконченных действий лежат в local, а не в session: фоновый скрипт и сам браузер могут
// остановиться посреди подмены кук или при открытом окне входа, и после запуска это надо довести до конца.
const ADD = "accountAdd";
// Метка «окно входа открыто в этом запуске браузера»: session очищается при перезапуске.
const ALIVE = "accountAddAlive";
const SWAP = "accountSwap";
const APPLY = "accountApply";

export const PLATFORMS = {
  twitch: {
    url: "https://www.twitch.tv/",
    domain: "twitch.tv",
    cookie: "auth-token",
    login: "https://www.twitch.tv/login",
    tabs: ["https://www.twitch.tv/*", "https://twitch.tv/*"],
  },
  kick: {
    url: "https://kick.com/",
    domain: "kick.com",
    cookie: "session_token",
    login: "https://kick.com/",
    tabs: ["https://kick.com/*"],
  },
};

function empty() {
  // home — аккаунт, который держим в браузере («» — авто: тот, что был до автосмены, иначе самый старый).
  // back — браузер ушёл с этого аккаунта и его надо вернуть: { at, reason, from }. reason "auto" — смену
  // затеяло расширение (аккаунту понадобился integrity), "select" — пользователь только что выбрал home.
  return {
    twitch: { active: "", list: [], done: 0, home: "", back: null },
    kick: { active: "", list: [], done: 0, home: "", back: null },
    // all — все аккаунты фармят одновременно; campaigns/done — по очереди; never — только вручную.
    rotate: { mode: "all", limit: 1 },
    warned: false,
  };
}

// Возвращает аккаунты вместе с их куками (для фона). В хранилище они лежат раздельно.
export async function readAccounts() {
  const all = await chrome.storage.local.get([KEY, COOKIES]);
  const stored = all[KEY] || {};
  const jar = all[COOKIES] || {};
  const base = empty();
  const side = (platform) => {
    const value = { ...base[platform], ...(stored[platform] || {}) };
    value.list = (value.list || []).map((item) => ({
      ...item,
      // item.cookies — запись старого формата, до разделения ключей.
      cookies: jar[platform]?.[item.id] || item.cookies || [],
    }));
    return value;
  };
  return { ...base, ...stored, twitch: side("twitch"), kick: side("kick"), rotate: { ...base.rotate, ...(stored.rotate || {}) } };
}

async function write(data) {
  const jar = { twitch: {}, kick: {} };
  const plain = { ...data };
  for (const platform of ["twitch", "kick"]) {
    plain[platform] = {
      ...data[platform],
      list: data[platform].list.map((item) => {
        const { cookies, ...rest } = item;
        jar[platform][item.id] = cookies || [];
        return rest;
      }),
    };
  }
  await chrome.storage.local.set({ [COOKIES]: jar, [KEY]: plain });
  return data;
}

// Все изменения аккаунтов идут строго по очереди: смена аккаунта держит данные несколько секунд
// (подмена кук, проверка сессии), и параллельная запись её бы затёрла.
// after — то, что нужно сделать после записи уже вне очереди (хуки майнеров сами пишут в аккаунты).
let chain = Promise.resolve();
function locked(work) {
  const after = [];
  const run = chain.then(() => work(after));
  chain = run.catch(() => {});
  // Каждый хук сам по себе: упавший не должен отменить следующие (иначе выбор нового аккаунта не применится).
  // Отложенное выполняется и когда сама работа упала: иначе счётчик settling застрял бы навсегда.
  const settle = async () => {
    for (const job of after) await job().catch(() => {});
  };
  return run.then(async (value) => {
    await settle();
    return value;
  }, async (error) => {
    await settle();
    throw error;
  });
}

// Хук майнера (подставить выбор аккаунта в живое состояние) выполняется уже вне очереди. Пока он не
// отработал, в живом состоянии лежит выбор ПРЕЖНЕГО аккаунта: в это время его нельзя считать выбором
// нового активного, иначе игры одного аккаунта запишутся другому.
const settling = { twitch: 0, kick: 0 };
function defer(after, platform, job) {
  settling[platform] += 1;
  after.push(async () => {
    try {
      await job();
    } finally {
      settling[platform] -= 1;
    }
  });
}

// Выбор аккаунта должен попасть в живое состояние майнера. Если фоновый скрипт остановится между записью
// и хуком, метка останется, и recover() применит выбор заново.
async function markApply(platform, on) {
  const marks = (await chrome.storage.local.get(APPLY))[APPLY] || {};
  if (Boolean(marks[platform]) === on) return;
  await chrome.storage.local.set({ [APPLY]: { ...marks, [platform]: on } });
}

async function deferApply(after, platform, hooks, entry) {
  await markApply(platform, true);
  defer(after, platform, async () => {
    await hooks?.apply?.(platform, entry);
    await markApply(platform, false);
  });
}

// Подмена кук сайта на куки аккаунта id. hooks.before сбрасывает то, что привязано к прежней сессии
// (integrity-заголовки), до того как на сайте окажется новый токен.
async function swap(platform, cookies, id, hooks) {
  await chrome.storage.local.set({ [SWAP]: { platform, id } });
  await hooks?.before?.(platform)?.catch?.(() => {});
  await clear(platform);
  await restore(cookies);
  await chrome.storage.local.remove(SWAP);
}

// Доводит до конца то, что оборвал перезапуск: подмену кук, окно входа, применение выбора.
async function recoverInner(hooks, after) {
  const stored = await chrome.storage.local.get([SWAP, ADD, APPLY]);
  const cut = stored[SWAP];
  if (cut) {
    await chrome.storage.local.remove(SWAP);
    const config = PLATFORMS[cut.platform];
    const target = config && (await readAccounts())[cut.platform].list.find((item) => item.id === cut.id);
    if (target && !(await chrome.cookies.get({ url: config.url, name: config.cookie }))?.value) await restore(target.cookies);
  }
  const job = stored[ADD];
  if (job) {
    let open = Boolean((await chrome.storage.session.get(ALIVE))[ALIVE]);
    if (open) open = await chrome.windows.get(job.windowId).then(Boolean, () => false);
    // Окна входа больше нет (браузер или расширение перезапустили): сайт получает прежнюю сессию обратно.
    if (!open) await abortAdd(job.platform, hooks, after, false);
  }
  for (const platform of Object.keys(PLATFORMS)) {
    if (!stored[APPLY]?.[platform] || settling[platform]) continue;
    const side = (await readAccounts())[platform];
    await deferApply(after, platform, hooks, side.list.find((item) => item.id === side.active) || null);
  }
}

export function recover(hooks) {
  return locked((after) => recoverInner(hooks, after));
}

// Как называть аккаунт в истории и подписях: ник, а если Kick его не отдал — id аккаунта
// (те же цифры, что попап показывает в чипах аккаунтов). Пустым имя не бывает.
export function accountLabel(account) {
  return String(account?.login || account?.id || "");
}

// Аккаунт, который сейчас в куках сайта (активный), или null.
export async function activeAccount(platform) {
  const side = (await readAccounts())[platform];
  return side?.list.find((item) => item.id === side.active) || null;
}

// Попапу куки не нужны: отдаём только то, что показывается.
export function publicAccounts(data) {
  const view = (side) => ({
    active: side.active,
    done: side.done || 0,
    home: side.home || "",
    homeId: homeId(side),
    returnId: returnId(side),
    back: side.back || null,
    list: side.list.map((item) => ({
      id: item.id,
      login: item.login,
      whitelist: item.whitelist || [],
      picked: item.picked || [],
      points: item.points || [],
      wishes: item.wishes || [],
      idleUntil: item.idleUntil || 0,
      expired: Boolean(item.expired),
    })),
  });
  return { twitch: view(data.twitch), kick: view(data.kick), rotate: data.rotate, warned: data.warned };
}

async function snapshot(platform) {
  const cookies = await chrome.cookies.getAll({ domain: PLATFORMS[platform].domain });
  return cookies.map((item) => ({
    name: item.name,
    value: item.value,
    domain: item.domain,
    hostOnly: item.hostOnly,
    path: item.path,
    secure: item.secure,
    httpOnly: item.httpOnly,
    sameSite: item.sameSite,
    expirationDate: item.expirationDate,
  }));
}

function cookieUrl(item) {
  return `http${item.secure ? "s" : ""}://${item.domain.replace(/^\./, "")}${item.path || "/"}`;
}

async function clear(platform) {
  const cookies = await chrome.cookies.getAll({ domain: PLATFORMS[platform].domain });
  await Promise.all(cookies.map((item) => chrome.cookies.remove({ url: cookieUrl(item), name: item.name }).catch(() => null)));
}

async function restore(cookies) {
  for (const item of cookies || []) {
    const details = {
      url: cookieUrl(item),
      name: item.name,
      value: item.value,
      path: item.path,
      secure: item.secure,
      httpOnly: item.httpOnly,
    };
    if (!item.hostOnly) details.domain = item.domain;
    if (item.sameSite && item.sameSite !== "unspecified") details.sameSite = item.sameSite;
    if (item.expirationDate) details.expirationDate = item.expirationDate;
    await chrome.cookies.set(details).catch(() => null);
  }
}

// Кто сейчас вошёл на сайте.
export async function identify(platform) {
  return (await probe(platform)).who;
}

// who — кто вошёл; dead — сайт точно разлогинен (куки нет или сервер отклонил сессию).
// Сбой сети — не «разлогинен»: тогда оба поля пустые.
async function probe(platform) {
  const config = PLATFORMS[platform];
  const found = await chrome.cookies.get({ url: config.url, name: config.cookie });
  if (!found?.value) return { who: null, dead: true };
  try {
    if (platform === "twitch") {
      const response = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${found.value}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return { who: null, dead: response.status === 401 };
      const body = await response.json();
      return body?.user_id ? { who: { id: String(body.user_id), login: body.login }, dead: false } : { who: null, dead: false };
    }
    let token = found.value;
    try {
      token = decodeURIComponent(token);
    } catch {
      // Значение уже без кодирования.
    }
    const response = await fetch("https://kick.com/api/v1/user", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { who: null, dead: response.status === 401 };
    const body = await response.json();
    const login = body?.username || body?.streamer_channel?.slug || "";
    // Kick на мёртвую сессию отвечает 200 с пустым объектом.
    return body?.id ? { who: { id: String(body.id), login }, dead: false } : { who: null, dead: true };
  } catch {
    return { who: null, dead: false };
  }
}

// Выбор игр и каналов баллов живёт в общем состоянии майнера; у каждого аккаунта своя копия.
async function liveSelection(platform) {
  const stored = await chrome.storage.local.get(["state", "settings", "points", "kickPoints"]);
  if (platform === "twitch") {
    return { whitelist: stored.state?.whitelist || [], points: stored.points?.channels || [], wishes: stored.settings?.wishes || [] };
  }
  return { picked: stored.settings?.picked || [], points: stored.kickPoints?.channels || [] };
}

function blank(who, cookies) {
  return { id: who.id, login: who.login, cookies, addedAt: Date.now(), whitelist: [], picked: [], points: [], wishes: [] };
}

// Запоминает текущую сессию сайта: новый аккаунт добавляется, у известного обновляются куки.
// Если пользователь сам перелогинился на сайте, активным становится этот аккаунт: hooks.apply
// подставит его выбор игр и каналов.
export function syncCurrent(platform, hooks) {
  return locked((after) => syncInner(platform, hooks, after));
}

async function syncInner(platform, hooks, after) {
  await recoverInner(hooks, after);
  // Пока открыто окно входа, сайт разлогинен нарочно: это не «сессия умерла», и запоминать нечего.
  if ((await pending())?.platform === platform) return readAccounts();
  const { who, dead } = await probe(platform);
  const data = await readAccounts();
  const side = data[platform];
  if (!who) {
    // Сессия активного аккаунта больше не действует (выход на сайте, истёк токен): помечаем, что нужен вход.
    const active = side.list.find((item) => item.id === side.active);
    if (dead && active && !active.expired) {
      active.expired = true;
      await write(data);
    }
    return data;
  }
  for (const item of side.list) if (item.id === who.id) item.expired = false;
  const cookies = await snapshot(platform);
  const previous = side.list.find((item) => item.id === side.active);
  if (previous && previous.id !== who.id) {
    // Выбор прежнего аккаунта пока лежит в живом состоянии: сохраняем его перед сменой.
    if (!settling[platform]) Object.assign(previous, await liveSelection(platform));
    side.active = who.id;
    side.done = 0;
    // Пользователь сам вошёл другим аккаунтом на сайте: это его выбор, назад не тянем.
    side.back = null;
    let entry = side.list.find((item) => item.id === who.id);
    if (entry) {
      entry.login = who.login || entry.login;
      entry.cookies = cookies;
    } else {
      entry = blank(who, cookies);
      side.list.push(entry);
    }
    await write(data);
    await deferApply(after, platform, hooks, entry);
    return data;
  }
  const known = side.list.find((item) => item.id === who.id);
  if (known) {
    known.login = who.login || known.login;
    known.cookies = cookies;
    if (side.active !== who.id) {
      // Активного не было (его удалили, сессия умерла), и пользователь вошёл известным аккаунтом:
      // в живом состоянии пусто, поэтому подставляем сохранённый выбор аккаунта, а не затираем его.
      side.active = who.id;
      side.done = 0;
      side.back = null;
      await write(data);
      await deferApply(after, platform, hooks, known);
      return data;
    }
    // Выбор берём из живого состояния, только если этот аккаунт и был активным.
    if (!settling[platform]) Object.assign(known, await liveSelection(platform));
  } else {
    // Первый аккаунт, или активного нет (его удалили): в живом состоянии лежит выбор этого пользователя.
    const adopt = !side.list.length || !side.active;
    side.list.push({ ...blank(who, cookies), ...(adopt ? await liveSelection(platform) : {}) });
  }
  if (!side.active || !side.list.some((item) => item.id === side.active)) side.active = who.id;
  return write(data);
}

// Метка «куки Twitch сейчас не того аккаунта, что active»: вкладки, загрузившиеся под ней, записываются
// как неизвестные (lib/client.js noteTabLoad). Ставится на время подмены кук и окна добавления.
async function markSwitching(platform, on) {
  if (platform !== "twitch") return;
  if (on) await chrome.storage.session.set({ accountSwitching: Date.now() });
  else await chrome.storage.session.remove("accountSwitching");
}

// После окна добавления аккаунта. Окно отдельное, но куки у профиля общие: пока оно открыто, сайт
// разлогинен для всех вкладок. Уже открытые вкладки Twitch держат прежний аккаунт в памяти страницы и
// перезагрузки не требуют; перезагружаем только загрузившиеся за это время (они записаны как «неизвестно»,
// lib/client.js). Вкладки Kick расширение не отслеживает — их, как раньше, перезагружаем все.
// whole — перезагрузить все вкладки: браузер был разлогинен или под умершей сессией этого же аккаунта
// (первый аккаунт, повторный вход в истёкший) — тогда разлогинены и вкладки, открытые до окна.
async function reloadAfterAdd(platform, activeId, whole = false) {
  // Куки уже нужного аккаунта: метку снимаем до перезагрузки, иначе вкладки снова запишутся «неизвестно».
  await markSwitching(platform, false);
  if (platform === "twitch" && !whole) await reloadForeignTabs(activeId).catch(() => null);
  else await reloadTabs(platform);
}

async function reloadTabs(platform) {
  const tabs = await chrome.tabs.query({ url: PLATFORMS[platform].tabs });
  await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id).catch(() => null)));
}

// hooks.apply(platform, account) кладёт выбор аккаунта в состояние майнера и сбрасывает его сессию.
// auto — смену затеяло само расширение: открытое окно входа она не трогает и просто не происходит.
// options.reload — перезагрузить вкладки и при auto: так ставится аккаунт, выбранный в попапе (пользователь
// ждёт увидеть его во вкладках). options.need — id дропов, ради которых браузер уводят (для блока в lib/home.js).
// options.check — последняя проверка уже внутри очереди: вернула false — смену не делаем.
// options.target — id цели, вычисленный в check (тогда id можно не передавать).
export function switchTo(platform, id, hooks, auto = false, options = {}) {
  return locked(async (after) => {
    if (auto && (await pending())?.platform === platform) return readAccounts();
    // Открыто окно входа для этой платформы: сначала закрываем его, иначе вход «завершится» этой сменой.
    await abortAdd(platform, hooks, after, false);
    await syncInner(platform, hooks, after);
    if (options.check && !(await options.check())) return readAccounts();
    // target/reload могут быть функциями: их значение известно только после check внутри очереди.
    const goal = typeof options.target === "function" ? options.target() : id;
    if (!goal) return readAccounts();
    const reload = typeof options.reload === "function" ? options.reload() : Boolean(options.reload);
    const from = (await readAccounts())[platform].active;
    const data = await switchInner(platform, goal, hooks, after, auto && !reload);
    return noteBack(data, platform, goal, auto, from, options.need);
  });
}

// После смены: дошли до аккаунта браузера — возвращать некого; ушли с него сами (auto) — запоминаем,
// чтобы вернуть, когда этот аккаунт больше не нужен; ручная смена — выбор пользователя, назад не тянем.
// from — аккаунт, на котором браузер был до первой автосмены: в «авто» возвращаем именно его,
// а не самый старый (пользователь мог сам держать в браузере другой аккаунт).
async function noteBack(data, platform, id, auto, from = "", need = []) {
  const side = data[platform];
  if (side.active !== id) return data;
  let back = side.back || null;
  // С какого аккаунта браузер увели первой автосменой. Помним и при выбранном доме: если потом
  // переключат на «авто», вернуть надо туда, где браузер был, а не на самый старый.
  const origin = back?.from || from || "";
  const target = returnId({ ...side, back: origin ? { ...(back || {}), from: origin } : back });
  if (id === target) back = null;
  // need — по аккаунту: блок ставится тому, с кого уходим (при возврате и при уходе дальше по цепочке).
  else if (auto) {
    back = {
      at: Date.now(), reason: "auto", from: origin,
      need: { ...(back?.need || {}), ...(need?.length ? { [id]: need.map(String) } : {}) },
    };
  } else back = null;
  if (JSON.stringify(back) === JSON.stringify(side.back || null)) return data;
  side.back = back;
  return write(data);
}

// Аккаунт, который держим в браузере: выбранный, а в режиме «авто» — самый старый из добавленных
// (список хранится в порядке добавления). Выбранный, чья сессия умерла, никуда не возвращает:
// подменять его на другой без спроса нельзя.
export function homeId(side) {
  const list = side?.list || [];
  if (side?.home) {
    const chosen = list.find((item) => item.id === side.home);
    return chosen && !chosen.expired ? chosen.id : "";
  }
  return list.find((item) => !item.expired)?.id || "";
}

// После удаления аккаунта: возвращать уже некуда (цель — сам активный) или активного нет — back снимаем.
// Иначе «вечный» back держал бы userTwitchTab в режиме «браузер уведён» и не давал брать неотмеченные вкладки.
function settleBack(data, platform) {
  const side = data[platform];
  if (side.back && (!side.active || returnId(side) === side.active || !returnId(side))) side.back = null;
  return data;
}

// Куда вернуть браузер: выбранный аккаунт; в «авто» — тот, с которого его увели (если он жив),
// иначе самый старый.
export function returnId(side) {
  const from = side?.back?.from;
  const known = from ? (side.list || []).find((item) => item.id === from) : null;
  const alive = known && !known.expired ? known.id : "";
  // Выбранный аккаунт разлогинен: возвращаем туда, где браузер был, а не оставляем на чужом.
  if (side?.home) return homeId(side) || alive;
  return alive || homeId(side);
}

// Выбор аккаунта браузера в попапе. Конкретный аккаунт возвращается сразу, как только браузер
// свободен (lib/home.js); «авто» ничего не переключает само по себе — только после смены ради integrity.
export function setHome(platform, id) {
  return locked(async () => {
    const data = await readAccounts();
    const side = data[platform];
    if (!side) return data;
    const wanted = String(id || "");
    side.home = side.list.some((item) => item.id === wanted) ? wanted : "";
    // from переносим: если пользователь передумает и выберет «авто», браузер вернётся туда, где был.
    const from = side.back?.from || "";
    // need — ради каких дропов уводили: блок при возврате (lib/home.js) не должен его потерять.
    const need = side.back?.need || {};
    if (side.home && side.home !== side.active) side.back = { at: Date.now(), reason: "select", from, need };
    else if (side.home) side.back = null;
    // «Авто» само ничего не переключает: ожидавший возврат к прежнему выбору снимаем. Но если до выбора
    // браузер был уведён расширением, возврат «туда, где был» остаётся.
    else if (side.back?.reason === "select") side.back = from && from !== side.active ? { at: side.back.at, reason: "auto", from, need } : null;
    return write(data);
  });
}

// auto — смену затеяло расширение: вкладки пользователя не перезагружаем. Они остаются под прежним
// аккаунтом, и integrity из них не берётся (lib/client.js помнит, под каким аккаунтом загружена вкладка).
async function switchInner(platform, id, hooks, after, auto = false) {
  const data = await readAccounts();
  const side = data[platform];
  const target = side.list.find((item) => item.id === id);
  if (!target) return data;
  if (side.active === id && (await identify(platform))?.id === id) return data;
  // Пока куки уже нового аккаунта, а active ещё прежний, загрузившаяся вкладка не знает, под кем она
  // (lib/client.js noteTabLoad): помечаем смену.
  await markSwitching(platform, true);
  let result;
  try {
    result = await switchCore(platform, id, hooks, after, auto, data, side, target);
  } finally {
    await markSwitching(platform, false);
  }
  // Перезагрузка — уже после снятия метки: иначе вкладки, начавшие грузиться под новым аккаунтом,
  // записались бы как «неизвестно».
  if (result.reload) await reloadTabs(platform);
  return result.data;
}

async function switchCore(platform, id, hooks, after, auto, data, side, target) {
  const previous = side.list.find((item) => item.id === side.active);
  await swap(platform, target.cookies, id, hooks);
  // Сохранённая сессия могла умереть (выход на сайте): аккаунт помечается, браузер возвращается к прежнему.
  const check = await probe(platform);
  if (check.dead || (check.who && check.who.id !== id)) {
    target.expired = true;
    if (previous && previous.id !== id && !previous.expired) await swap(platform, previous.cookies, previous.id, hooks);
    await write(data);
    return { data, reload: !auto };
  }
  target.expired = false;
  side.active = id;
  side.done = 0;
  await write(data);
  await deferApply(after, platform, hooks, target);
  return { data, reload: !auto };
}

// Удаление аккаунта. Если удаляют тот, под которым залогинен браузер, сайт разлогинивается (иначе аккаунт
// тут же вернулся бы в список сам), а браузер переходит на следующий рабочий аккаунт, если он есть.
export function removeAccount(platform, id, hooks) {
  return locked(async (after) => {
    await abortAdd(platform, hooks, after, false);
    // Пользователь мог перелогиниться на сайте после последней сверки: его сессию сначала запоминаем.
    await syncInner(platform, hooks, after);
    const data = await readAccounts();
    const side = data[platform];
    const wasActive = side.active === id;
    const live = wasActive || (await identify(platform))?.id === id;
    side.list = side.list.filter((item) => item.id !== id);
    // Убрали аккаунт браузера: дальше «авто», чужой аккаунт без спроса туда не ставим.
    if (side.home === id) side.home = "";
    if (!wasActive && !live) return write(settleBack(data, platform));
    if (live) await clear(platform);
    side.active = "";
    side.done = 0;
    const next = side.list.find((item) => !item.expired);
    if (next) {
      await restore(next.cookies);
      const check = await probe(platform);
      if (check.who?.id === next.id) side.active = next.id;
      else if (check.dead) {
        next.expired = true;
        await clear(platform);
      }
    }
    await write(settleBack(data, platform));
    const now = side.list.find((item) => item.id === side.active) || null;
    await deferApply(after, platform, hooks, now);
    await reloadTabs(platform);
    return data;
  });
}

export function setRotation(patch) {
  return locked(async () => {
    const data = await readAccounts();
    const mode = ["all", "campaigns", "done", "never"].includes(patch?.mode) ? patch.mode : data.rotate.mode;
    const limit = Math.min(50, Math.max(1, Math.round(Number(patch?.limit ?? data.rotate.limit)) || 1));
    // Счётчик закрытых кампаний относится к прежнему режиму: иначе смена случилась бы сразу.
    if (mode !== data.rotate.mode) {
      data.twitch.done = 0;
      data.kick.done = 0;
      // Ожидавший возврат относится к прежнему режиму: после возврата в «Все сразу» он увёл бы браузер.
      data.twitch.back = null;
      data.kick.back = null;
      // Вернулись в «Все сразу» с выбранным аккаунтом браузера, а в браузере другой: ставим выбранный, как
      // сразу после выбора в попапе. Иначе без back возврат не начался бы никогда.
      if (mode === "all") {
        for (const platform of ["twitch", "kick"]) {
          const side = data[platform];
          const home = homeId(side);
          if (side.home && home && home !== side.active) side.back = { at: Date.now(), reason: "select", from: "", need: {} };
        }
      }
    }
    data.rotate = { mode, limit };
    return write(data);
  });
}

export function setWarned() {
  return locked(async () => {
    const data = await readAccounts();
    data.warned = true;
    return write(data);
  });
}

// Выбор игр или каналов для аккаунта. Для активного меняется и живое состояние (hooks.select).
export function setSelection(platform, id, patch, hooks) {
  return locked(async (after) => {
    const data = await readAccounts();
    const side = data[platform];
    const target = side.list.find((item) => item.id === id);
    if (!target) return data;
    for (const key of ["whitelist", "picked", "points", "wishes"]) {
      if (Array.isArray(patch?.[key])) target[key] = patch[key];
    }
    await write(data);
    if (side.active === id) defer(after, platform, () => hooks?.select?.(platform, target, patch));
    return data;
  });
}

// ---- Добавление аккаунта ----
// Открывается отдельное окно входа. Пока оно открыто, сайт разлогинен; после входа куки сохраняются
// как новый аккаунт, а браузер возвращается к прежнему.

async function pending() {
  return (await chrome.storage.local.get(ADD))[ADD] || null;
}

// Закрывает незавершённое добавление и возвращает сайту прежнюю сессию.
// only — только для этой платформы ("" — для любой). keepCookies — куки не трогать (их сейчас заменят).
async function abortAdd(only, hooks, after, keepCookies) {
  const job = await pending();
  if (!job || (only && job.platform !== only)) return null;
  // Метку ставим всегда: и при keepCookies (startAdd открывает новое окно, куки уже стёрты, а журнала
  // нового окна ещё нет — метку снимет startAdd после его записи).
  await markSwitching(job.platform, true);
  await chrome.storage.local.remove(ADD);
  await chrome.storage.session.remove(ALIVE);
  await googleChooser(false);
  await chrome.windows.remove(job.windowId).catch(() => null);
  if (keepCookies) return job;
  const data = await readAccounts();
  const back = data[job.platform].list.find((item) => item.id === job.before);
  if (!back) await markSwitching(job.platform, false);
  if (back) {
    // Пока окно было открыто, сверка не шла: игры, отмеченные за это время, лежат только в живом состоянии.
    if (!settling[job.platform]) {
      Object.assign(back, await liveSelection(job.platform));
      await write(data);
    }
    await swap(job.platform, back.cookies, back.id, hooks);
    await deferApply(after, job.platform, hooks, back);
    await reloadAfterAdd(job.platform, back.id);
  }
  return job;
}

export function startAdd(platform, hooks) {
  return locked(async (after) => {
    // Прежнее окно входа, если его не закрыли: второе окно только путает. Если оно было для другой
    // платформы, та получает свою сессию обратно; для этой же куки всё равно сейчас очистятся.
    const old = await pending();
    const same = old?.platform === platform;
    if (old) await abortAdd("", hooks, after, same);
    if (!same) await syncInner(platform, hooks, after);
    const before = same ? old.before : (await readAccounts())[platform].active;
    // Куки стираются раньше, чем записан журнал окна: метка закрывает этот промежуток.
    await markSwitching(platform, true);
    await clear(platform);
    let created;
    try {
      created = await chrome.windows.create({ url: PLATFORMS[platform].login, type: "popup", width: 520, height: 760 });
    } catch (error) {
      // Окно не открылось: сайт не должен остаться разлогиненным.
      const back = (await readAccounts())[platform].list.find((item) => item.id === before);
      if (back) await restore(back.cookies);
      await markSwitching(platform, false);
      throw error;
    }
    const tabs = (created.tabs || []).map((tab) => tab.id).filter((id) => id != null);
    await chrome.storage.local.set({ [ADD]: { platform, windowId: created.id, before, at: Date.now(), tabs } });
    await markSwitching(platform, false);
    await chrome.storage.session.set({ [ALIVE]: true });
    await googleChooser(true, tabs);
    return { windowId: created.id };
  });
}

// Вход через Google (он есть и у Twitch, и у Kick): если в браузере уже есть аккаунт Google,
// он выбирается молча и войти вторым аккаунтом нельзя. Пока открыто окно добавления, просим Google показать выбор аккаунта
// (prompt=select_account), но только во вкладках этого окна: остальные сайты не затрагиваются.
// Работает, только если пользователь дал доступ к accounts.google.com.
const GOOGLE = "https://accounts.google.com/*";
const CHOOSER_RULE = 201;

async function googleChooser(on, tabIds = []) {
  try {
    const rules = chrome.declarativeNetRequest;
    if (!rules?.updateSessionRules) return;
    if (!on || !tabIds.length) {
      await rules.updateSessionRules({ removeRuleIds: [CHOOSER_RULE] });
      return;
    }
    if (!(await chrome.permissions?.contains?.({ origins: [GOOGLE] }))) return;
    await rules.updateSessionRules({
      removeRuleIds: [CHOOSER_RULE],
      addRules: [{
        id: CHOOSER_RULE,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: "prompt", value: "select_account" }] } } },
        },
        condition: { urlFilter: "||accounts.google.com/o/oauth2/", resourceTypes: ["main_frame"], tabIds },
      }],
    });
  } catch {
    // Без правила вход работает как раньше.
  }
}

// Вход через Google сайт открывает в новой вкладке или окне: она тоже относится к добавлению аккаунта.
export function noteAddTab(tab) {
  const seenAt = Date.now();
  return locked(async () => {
    const job = await pending();
    if (!job || tab?.id == null) return;
    const known = job.tabs || [];
    if (known.includes(tab.id)) return;
    if (tab.windowId !== job.windowId && !known.includes(tab.openerTabId) && !(seenAt > job.at && (await isPopup(tab)))) return;
    const tabs = [...known, tab.id];
    await chrome.storage.local.set({ [ADD]: { ...job, tabs } });
    await googleChooser(true, tabs);
    await chooserCatchUp(tab.id);
  });
}

// Twitch открывает Google отдельным всплывающим окном, и у его вкладки нет openerTabId.
// Пока идёт добавление аккаунта, новое всплывающее окно без родителя считаем его частью.
// Окна других расширений и окна, открытые до начала входа, сюда не попадают. Постороннее окно входа через
// Google, открытое в те же секунды, тоже получит выбор аккаунта: это безвредно.
async function isPopup(tab) {
  if (tab.openerTabId != null) return false;
  if (/^(chrome|edge|moz)-extension:|^chrome:|^edge:/.test(tab.pendingUrl || tab.url || "")) return false;
  try {
    return (await chrome.windows.get(tab.windowId))?.type === "popup";
  } catch {
    return false;
  }
}

// Окно могло уйти на Google раньше, чем правило узнало о его вкладке: тогда открываем тот же адрес с выбором аккаунта.
async function chooserCatchUp(tabId) {
  try {
    if (!(await chrome.permissions?.contains?.({ origins: [GOOGLE] }))) return;
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.pendingUrl || tab.url || "about:blank");
    if (url.hostname !== "accounts.google.com" || !url.pathname.startsWith("/o/oauth2/")) return;
    if (url.searchParams.get("prompt") === "select_account") return;
    url.searchParams.set("prompt", "select_account");
    await chrome.tabs.update(tabId, { url: url.href });
  } catch {
    // Вкладка уже закрыта или адрес не читается: вход идёт как обычно.
  }
}

// Сайт дописывает куки входа не мгновенно: первая проверка может прийти раньше, чем сессия готова.
async function identifySoon(platform) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const who = await identify(platform);
    if (who) return who;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

// Вызывается при изменении кук: вход в окне добавления завершён.
export async function finishAdd(hooks) {
  const job = await pending();
  if (!job) return null;
  // Ждём куки входа вне очереди: она нужна, чтобы вкладка Google сразу попала в правило выбора аккаунта.
  const who = await identifySoon(job.platform);
  if (!who) return null;
  return locked((after) => finishInner(hooks, after, job.platform));
}

async function finishInner(hooks, after, expected = "") {
  const job = await pending();
  // Пока ждали очереди, вход мог завершить другой вызов или окно сменилось на другую платформу.
  if (!job || (expected && job.platform !== expected)) return null;
  const who = await identify(job.platform);
  if (!who) return null;
  // До конца подмены куки — добавленного аккаунта: метка окна снимается, её место занимает метка смены.
  await markSwitching(job.platform, true);
  // Журнал окна снимаем в самом конце, после записи и подмены кук: если воркер упадёт посередине,
  // recover() вернёт прежний аккаунт, а не примет куки добавляемого за ручной вход (с потерей возврата домой).
  // ALIVE снимаем сразу: окно больше не «открыто в этом запуске», recover его закроет.
  await chrome.storage.session.remove(ALIVE);
  await googleChooser(false);
  // Сайту нужно время дописать остальные куки сессии.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const data = await readAccounts();
  const side = data[job.platform];
  const cookies = await snapshot(job.platform);
  // В живом состоянии всё ещё выбор того, кто был активным до окна входа (или пользователя без аккаунтов).
  const live = settling[job.platform] ? null : await liveSelection(job.platform);
  const back = side.list.find((item) => item.id === job.before);
  if (back && live) Object.assign(back, live);
  let entry = side.list.find((item) => item.id === who.id);
  if (entry) {
    entry.cookies = cookies;
    entry.login = who.login || entry.login;
    entry.expired = false;
  } else {
    // Первый аккаунт: игры, выбранные до входа, достаются ему, а не стираются.
    entry = { ...blank(who, cookies), ...(!back && live ? live : {}) };
    side.list.push(entry);
  }
  await chrome.windows.remove(job.windowId).catch(() => null);
  if (back && back.id !== who.id && !back.expired) {
    await swap(job.platform, back.cookies, back.id, hooks);
    side.active = back.id;
    await write(data);
    await deferApply(after, job.platform, hooks, back);
  } else {
    side.active = who.id;
    await write(data);
    await deferApply(after, job.platform, hooks, entry);
  }
  await chrome.storage.local.remove(ADD);
  // Прежнего живого аккаунта не было (первый вход, повторный вход в истёкший): разлогинены были все вкладки.
  await reloadAfterAdd(job.platform, side.active, !(back && back.id !== who.id && !back.expired));
  return { platform: job.platform, login: who.login };
}

// Окно закрыли без входа: возвращаем прежнюю сессию.
export function cancelAdd(windowId, hooks) {
  return locked(async (after) => {
    const job = await pending();
    if (!job || job.windowId !== windowId) return;
    // Окно закрыли руками сразу после входа: это не отмена, аккаунт сохраняем.
    if (await identify(job.platform)) {
      await finishInner(hooks, after);
      return;
    }
    await abortAdd(job.platform, hooks, after, false);
  });
}

export async function addPending() {
  return Boolean(await pending());
}

// Платформа, для которой сейчас открыто окно входа, или "".
export async function addingPlatform() {
  return (await pending())?.platform || "";
}

// ---- Смена по очереди ----

// Кампания у активного аккаунта дофармлена.
export function noteCampaignDone(platform) {
  return locked(async () => {
    const data = await readAccounts();
    data[platform].done = (data[platform].done || 0) + 1;
    await write(data);
  });
}

// reason: "campaign" — только что закрыта кампания; "nothing" — этому аккаунту сейчас нечего фармить.
// Возвращает id аккаунта, на который пора перейти, или "".
export function nextAccount(platform, reason) {
  return locked(async () => {
    const data = await readAccounts();
    const side = data[platform];
    // «Все сразу»: аккаунты фармят параллельно (lib/side.js, lib/kickside.js), очередь им не нужна.
    if (side.list.length < 2 || data.rotate.mode === "never" || data.rotate.mode === "all") return "";
    const mode = data.rotate.mode;
    if (await pending()) return "";
    const now = Date.now();
    const current = side.list.find((item) => item.id === side.active);
    if (reason === "nothing") {
      if (current) current.idleUntil = now + IDLE_MS;
    } else if (mode !== "campaigns" || (side.done || 0) < data.rotate.limit) {
      return "";
    }
    await write(data);
    const start = side.list.findIndex((item) => item.id === side.active);
    for (let step = 1; step < side.list.length; step += 1) {
      const candidate = side.list[(start + step) % side.list.length];
      if (!candidate.expired && (candidate.idleUntil || 0) <= now) return candidate.id;
    }
    return "";
  });
}
