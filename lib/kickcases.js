// Кейсы Kick: Daily Reward, Sunset Reward Case и прочие акции. Это не дропы и в списке дропов их нет:
// кейсы ведёт игровая подсистема Kick — GET /v1/gamification/challenges, открытие —
// POST /v1/gamification/challenges/{id}/claim. В ответе на клейм Kick присылает карточку
// (data.winner: rarity, card_url, thumbnail_url) и, если повезло меньше, consolation.
// Часы на кейс считает сам Kick по тем же минутам просмотра, которыми набираются дропы; отдельно
// «смотреть» для кейсов не нужно, поэтому открытие идёт фоном рядом с проходом майнера.
// Кейсы есть у каждого аккаунта, поэтому проход идёт по всем: аккаунт браузера — его живой кукой,
// остальные — сохранённым session_token без кук браузера (иначе запрос ушёл бы от активного аккаунта).
// В историю клеймов попадает только то, что открыл сам майнер.
// Проверено в браузере 19 ноября 2026: приходят Daily Reward (status claimed) и Sunset Reward Case
// (status in_progress, condition {progress 150, threshold 180, watch_time_minutes}), ответ на клейм
// {challenge_id, reveal_type, roulette, winner}; повторный клейм того же кейса отдаёт тот же winner.
import { readAccounts } from "./accounts.js";
import { addHistory } from "./history.js";
import { kickHeaders, loadClientToken } from "./kick.js";

const KEY = "kickCases";
const WEB = "https://web.kick.com/api/v1";
const CHECK_MS = 90 * 1000;
const RETRY_MS = 10 * 60 * 1000;

function defaults() {
  // enabled — открывать кейсы автоматически, как только Kick их отдаёт.
  // accounts: id аккаунта -> { login, items, opened, failed, checkedAt, error }.
  return { enabled: true, accounts: {}, updatedAt: 0 };
}

export async function readKickCases() {
  const stored = await chrome.storage.local.get(KEY);
  const value = { ...defaults(), ...(stored[KEY] || {}) };
  value.accounts = value.accounts && typeof value.accounts === "object" ? value.accounts : {};
  return value;
}

async function save(patch) {
  const fresh = await readKickCases();
  const next = { ...fresh, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function setKickCasesEnabled(enabled) {
  // Сам флаг пишем через очередь: иначе он затирал бы accounts, записанные параллельным проходом.
  const next = await serial(async () => save({ enabled: Boolean(enabled) }));
  // Принудительный проход — уже отдельной задачей в той же очереди. Вызвать tick() внутри serial нельзя:
  // он стартовал бы вне очереди и мог пойти параллельно с обычным проходом (двойной POST на клейм).
  kickCasesTick({ force: true }).catch(() => {});
  return next;
}

// Те же заголовки, что у сайта: без X-App-Platform Kick отвечает 403.
export function casesHeaders(token) {
  return { ...kickHeaders(token), "X-App-Platform": "web" };
}

// Отметка попытки: у ежедневного кейса новая попытка каждый день, id при этом не меняется.
export function caseKey(item) {
  const ends = Number(item?.endsAt) || Date.parse(item?.window?.ends_at || "") || 0;
  if (ends) return `${item?.id || ""}|${ends}`;
  // Окна нет: считаем попытку по дню. Иначе одна вчерашняя отметка погасила бы ежедневную награду навсегда.
  return `${item?.id || ""}|day:${new Date().toISOString().slice(0, 10)}`;
}

export function caseArt(winner) {
  const url = winner?.card_url || winner?.thumbnail_url || "";
  return /^https?:\/\//.test(String(url)) ? String(url) : "";
}

// Кейсу ещё нужны минуты: не забран, окно не кончилось, условие про минуты просмотра.
export function needsMinutes(row, now = Date.now()) {
  return Boolean(row && row.status !== "claimed" && !row.claimedAt
    && (!row.endsAt || row.endsAt > now)
    && (!row.type || row.type === "watch_time_minutes")
    && row.threshold > 0 && row.progress < row.threshold);
}

// Готов к открытию: Kick говорит claimable, либо минуты уже набраны, а клейма ещё не было.
// Просроченный кейс не открываем: Kick всё равно ответит отказом.
export function isClaimable(row, now = Date.now()) {
  if (!row || row.claimedAt) return false;
  if (row.status === "claimed") return false;
  if (row.endsAt && row.endsAt <= now) return false;
  if (row.status === "claimable") return true;
  return row.threshold > 0 && row.progress >= row.threshold;
}

// Ответ Kick -> строки для попапа. Ничего не открывает.
export function caseRows(body) {
  const rows = [];
  for (const item of Array.isArray(body?.data) ? body.data : []) {
    if (!item?.id) continue;
    const condition = item.condition || {};
    const threshold = Math.max(0, Number(condition.threshold) || 0);
    const raw = Math.max(0, Number(condition.progress) || 0);
    const progress = threshold ? Math.min(threshold, raw) : raw;
    const endsAt = Date.parse(item.window?.ends_at || "") || 0;
    const winner = item.winner || null;
    const row = {
      id: String(item.id),
      name: String(item.name || item.description || "Case"),
      description: String(item.description || ""),
      status: String(item.status || ""),
      recurrence: String(item.recurrence || ""),
      featured: Boolean(item.featured),
      type: String(condition.type || ""),
      threshold,
      progress,
      endsAt,
      rarity: winner?.rarity || "",
      image: caseArt(winner),
      claimedAt: Date.parse(item.claimed_at || "") || 0,
      termsUrl: /^https?:\/\//.test(String(item.terms_and_conditions_url || "")) ? String(item.terms_and_conditions_url) : "",
    };
    row.key = caseKey(row);
    rows.push(row);
  }
  // Сначала то, что можно открыть, потом главный кейс акции, дальше по названию.
  return rows.sort((left, right) => Number(isClaimable(right)) - Number(isClaimable(left))
    || Number(right.featured) - Number(left.featured)
    || left.name.localeCompare(right.name));
}

// ---- Кто чьими руками открывает ----

function bearer(account) {
  const raw = (account?.cookies || []).find((item) => item.name === "session_token")?.value || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Кука активного аккаунта. Читается из хранилища, без сетевых запросов: проход по кейсам
// не должен тратить лишний запрос только на то, чтобы узнать, чей аккаунт сейчас в браузере.
async function cookieToken() {
  const found = await chrome.cookies.get({ url: "https://kick.com/", name: "session_token" });
  const raw = found?.value || "";
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Аккаунт браузера — первым: у него живая кука. Остальные — сохранёнными токенами, без кук.
async function caseOwners() {
  const stored = (await chrome.storage.local.get("kick")).kick || {};
  // Майнер Kick выключен — не трогаем Kick вовсе, кейсы не исключение.
  if (stored.enabled === false) return [];
  const data = await readAccounts();
  const list = (data.kick.list || []).filter((item) => item && !item.expired && bearer(item));
  const active = data.kick.active || "";
  const mine = list.find((item) => item.id === active) || null;
  const live = await cookieToken();
  const owners = [];
  if (live) {
    // Владельца живой куки определяем по проверенному логину (kick.user), а не по accounts.active:
    // иначе при рассинхроне мы бы и заклеймили чужой аккаунт дважды — как активный и как сохранённый.
    const verified = String(stored.user || "").toLowerCase();
    const owner = verified
      ? list.find((item) => String(item.login || "").toLowerCase() === verified)
      : mine;
    owners.push({ id: owner?.id || active || "current", login: stored.user || owner?.login || "", token: live, own: true });
  } else if (mine) {
    // Куки браузера нет, а сохранённая сессия этого аккаунта есть: работаем ею.
    owners.push({ id: mine.id, login: mine.login || "", token: bearer(mine), own: true });
  }
  // «Только вручную»: сохранённые аккаунты не трогаем, кейсы открывает лишь тот, что в браузере.
  if ((data.rotate?.mode || "all") === "never") return owners;
  const taken = new Set(owners.map((owner) => owner.id));
  for (const account of list) {
    if (taken.has(account.id)) continue;
    owners.push({ id: account.id, login: account.login || "", token: bearer(account), own: false });
  }
  return owners;
}

async function list(owner) {
  // После перезапуска service worker токен живёт только в storage: без этого чтения уйдёт встроенный.
  await loadClientToken().catch(() => {});
  const response = await fetch(`${WEB}/gamification/challenges`, {
    headers: casesHeaders(owner.token),
    credentials: owner.own ? "include" : "omit",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return caseRows(await response.json());
}

async function claim(owner, id) {
  const response = await fetch(`${WEB}/gamification/challenges/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    headers: { ...casesHeaders(owner.token), "Content-Type": "application/json" },
    credentials: owner.own ? "include" : "omit",
    signal: AbortSignal.timeout(15000),
    body: "{}",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  // 200 с HTML (заглушка WAF, страница блокировки) — не клейм: без JSON это не ответ Kick.
  if (!body || typeof body !== "object") throw new Error(`HTTP ${response.status}: not json`);
  // Живой Kick отвечает {data: {...}}; плоскую форму тоже понимаем — на случай смены обёртки.
  if (body?.data) return body.data;
  if (body && typeof body === "object" && (body.winner || body.consolation || body.challenge_id)) return body;
  // Пустой, но успешный ответ: клейм принят, карточки просто нет.
  return {};
}

// Общий замок: проходы кейсов и ручные клеймы идут строго по очереди. Два прохода сразу видели бы
// одно и то же «можно открыть» и слали два POST, а ручной клейм затирался бы целым состоянием прохода.
let queue = Promise.resolve();

function serial(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

// Записать выпавшее в историю клеймов и запомнить, что кейс уже открыт.
async function noteWon(row, opened, account, won, at = Date.now()) {
  const rarity = String(won?.rarity || row.rarity || "");
  const art = caseArt(won) || row.image || "";
  opened[row.key] = { at, rarity, image: art };
  row.status = "claimed";
  row.claimedAt = at;
  row.rarity = rarity || row.rarity;
  if (art) row.image = art;
  await addHistory({
    kind: "case",
    platform: "kick",
    account,
    name: rarity ? `${row.name} · ${rarity}` : row.name,
    game: "Kick",
    image: art,
  });
}

// Открыть один кейс. Возвращает {ok, won} или {ok: false, error}: «клейм принят» и «карточка есть» —
// разные вещи, без карточки клейм всё равно успешен и в failed не попадает.
async function open(owner, row, opened) {
  let data;
  try {
    data = await claim(owner, row.id);
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 120) };
  }
  // Утешительный приз приходит вместо карточки, когда ничего не выпало.
  const won = data.winner || data.consolation || null;
  await noteWon(row, opened, owner.login, won);
  return { ok: true, won };
}

// Отметки открытых кейсов важнее того, что успел вернуть список: сервер иногда отдаёт статус
// прошлого прохода, и попап показывал бы «можно открыть» на уже открытом кейсе.
function marked(rows, opened) {
  return (rows || []).map((row) => {
    const mark = opened[row.key];
    if (!mark) return row;
    return {
      ...row,
      status: "claimed",
      claimedAt: mark.at || 0,
      rarity: row.rarity || mark.rarity || "",
      image: row.image || mark.image || "",
    };
  });
}

// Старые отметки не копим: ключ содержит конец окна и повториться не может.
function trimmed(marks) {
  const keys = Object.keys(marks).sort((left, right) => (marks[left]?.at || marks[left] || 0) - (marks[right]?.at || marks[right] || 0));
  const next = { ...marks };
  for (const key of keys.slice(0, Math.max(0, keys.length - 60))) delete next[key];
  return next;
}

// Один проход по одному аккаунту.
async function pass(state, owner, previous, now) {
  const items = await list(owner);
  const opened = { ...(previous.opened || {}) };
  const failed = { ...(previous.failed || {}) };
  let claimError = "";
  if (state.enabled) {
    for (const row of items.filter((item) => isClaimable(item, now))) {
      // Неудачную попытку повторяем не чаще раза в 10 минут: Kick иногда отвечает, что ещё рано.
      if (opened[row.key] || now - (failed[row.key] || 0) < RETRY_MS) continue;
      const done = await open(owner, row, opened);
      if (!done.ok) {
        failed[row.key] = now;
        claimError = done.error || "claim rejected";
      }
    }
  }
  return {
    login: owner.login, items: marked(items, opened), opened: trimmed(opened), failed: trimmed(failed),
    checkedAt: now, error: "", claimError,
  };
}

// Проход: по всем аккаунтам прочитать список кейсов и открыть всё готовое.
// Один аккаунт ходит не чаще раза в 90 секунд; force — сразу.
export function kickCasesTick(options) {
  return serial(() => tick(options));
}

async function tick({ force = false } = {}) {
  const state = await readKickCases();
  // Тумблер выключен — не опрашиваем Kick вовсе: иначе кейсы ходили бы в сеть за выключенной функцией.
  if (state.enabled === false) return state;
  const owners = await caseOwners();
  const now = Date.now();
  const next = { ...state.accounts };
  let touched = false;
  for (const owner of owners) {
    const previous = state.accounts[owner.id] || {};
    if (!force && now - (previous.checkedAt || 0) < CHECK_MS) continue;
    touched = true;
    try {
      next[owner.id] = await pass(state, owner, previous, now);
    } catch (error) {
      // Чужой аккаунт мог разлогиниться: его кейсы остаются прошлыми, в попапе видно ошибку.
      // На 401/403 не долбим каждые 90 секунд — следующая попытка через 10 минут.
      const text = String(error?.message || error);
      next[owner.id] = {
        ...previous,
        login: owner.login,
        error: text.slice(0, 120),
        checkedAt: /HTTP 40[13]/.test(text) ? now + RETRY_MS : now,
      };
    }
  }
  // Аккаунт убрали из списка — его кейсы не копим. Аккаунты, которых сейчас не трогаем (режим «только
  // вручную»), остаются со своими отметками, иначе открытая вчера награда открылась бы снова.
  const data = await readAccounts();
  const known = new Set((data.kick.list || []).map((item) => String(item.id)));
  known.add("current");
  for (const id of Object.keys(next)) if (!known.has(id)) delete next[id];
  if (!touched) return state;
  return save({ accounts: next, notice: "" });
}

// Открыть кейс по кнопке в попапе. account — id аккаунта, к которому относится строка.
export function openKickCase(id, account = "") {
  return serial(() => openCase(id, account));
}

async function openCase(id, account = "") {
  const state = await readKickCases();
  const owners = await caseOwners();
  const wanted = String(account || "");
  // Кнопка помнит свой аккаунт: подставлять чужой нельзя — кейс откроется не тому.
  const owner = wanted ? owners.find((item) => item.id === wanted) : (owners.length === 1 ? owners[0] : null);
  if (!owner) {
    // Аккаунт убрали или сменили, пока попап был открыт: скажем об этом, а не молчим.
    return save({ notice: "account-gone" });
  }
  const previous = state.accounts[owner.id] || {};
  const row = (previous.items || []).find((item) => item.id === String(id));
  if (!row) return state;
  const opened = { ...(previous.opened || {}) };
  // Уже открыт (авто-клейм или другое устройство): повторный POST дал бы вторую запись в истории.
  if (opened[row.key]) {
    const items = marked(await list(owner).catch(() => previous.items || []), opened);
    return save({ accounts: { ...state.accounts, [owner.id]: { ...previous, login: owner.login, items, opened: trimmed(opened) } } });
  }
  const done = await open(owner, row, opened);
  const items = marked(await list(owner).catch(() => previous.items || []), opened);
  return save({
    notice: "",
    accounts: {
      ...state.accounts,
      [owner.id]: {
        ...previous,
        login: owner.login,
        items,
        opened: trimmed(opened),
        error: "",
        claimError: done.ok ? "" : done.error || "claim rejected",
      },
    },
  });
}
