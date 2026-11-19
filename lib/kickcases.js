// Кейсы Kick: Daily Reward, Sunset Reward Case и прочие акции. Это не дропы и в списке дропов их нет:
// кейсы ведёт игровая подсистема Kick — GET /v1/gamification/challenges, открытие —
// POST /v1/gamification/challenges/{id}/claim. В ответе на клейм Kick присылает карточку
// (data.winner: rarity, card_url, thumbnail_url) и, если повезло меньше, consolation.
// Часы на кейс считает сам Kick по тем же минутам просмотра, которыми набираются дропы; отдельно
// «смотреть» для кейсов не нужно, поэтому открытие идёт фоном рядом с проходом майнера.
// Кейсы есть у каждого аккаунта, поэтому проход идёт по всем: аккаунт браузера — его живой кукой,
// остальные — сохранённым session_token без кук браузера (иначе запрос ушёл бы от активного аккаунта).
// Кому принадлежит живая кука, решает сам токен: если такой вход сохранён, это его аккаунт. Логин
// спрашивается только у незнакомого токена — по одному accounts.active владельца не угадать.
// В историю клеймов попадает только то, что открыл сам майнер.
// Проверено в браузере 19 ноября 2026: приходят Daily Reward (status claimed) и Sunset Reward Case
// (status in_progress, condition {progress 150, threshold 180, watch_time_minutes}), ответ на клейм
// {challenge_id, reveal_type, roulette, winner}; повторный клейм того же кейса отдаёт тот же winner.
import { readAccounts } from "./accounts.js";
import { addHistory } from "./history.js";
import { kickHeaders, kickUserName, loadClientToken } from "./kick.js";

const KEY = "kickCases";
const WEB = "https://web.kick.com/api/v1";
const CHECK_MS = 90 * 1000;
const RETRY_MS = 10 * 60 * 1000;

function defaults() {
  // enabled — открывать кейсы автоматически, как только Kick их отдаёт.
  // accounts: id аккаунта -> { login, items, opened, failed, checkedAt, error, served }.
  // liveId — аккаунт, который считается живым (проверен по куке), им пользуется kickCaseNeed.
  // liveStamp — отпечаток куки того прохода: по нему видно, что в браузере сменился аккаунт.
  return { enabled: true, accounts: {}, liveId: "", liveStamp: "", updatedAt: 0 };
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
// Номер недели ISO: у недельных кейсов без окна попытка одна на неделю, а не на сутки.
function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Ключ попытки: окно, если оно есть, иначе период кейса (день/неделя/месяц).
// Иначе одна вчерашняя отметка погасила бы ежедневную награду навсегда, а недельная открывалась бы каждый день.
export function caseKey(item, now = new Date()) {
  const ends = Number(item?.endsAt) || Date.parse(item?.window?.ends_at || "") || 0;
  if (ends) return `${item?.id || ""}|${ends}`;
  const span = String(item?.recurrence || "").toLowerCase();
  if (span === "weekly") return `${item?.id || ""}|week:${isoWeek(now)}`;
  if (span === "monthly") return `${item?.id || ""}|month:${now.toISOString().slice(0, 7)}`;
  return `${item?.id || ""}|day:${now.toISOString().slice(0, 10)}`;
}

// Отпечаток токена: сам токен в состоянии не храним, а смену входа видно и без сети.
function stamp(token) {
  let hash = 2166136261;
  for (const char of String(token || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
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
async function caseOwners(live = undefined) {
  const stored = (await chrome.storage.local.get("kick")).kick || {};
  // Майнер Kick выключен — не трогаем Kick вовсе, кейсы не исключение.
  if (stored.enabled === false) return [];
  const data = await readAccounts();
  const list = (data.kick.list || []).filter((item) => item && !item.expired && bearer(item));
  const active = data.kick.active || "";
  const mine = list.find((item) => item.id === active) || null;
  const token = live === undefined ? await cookieToken() : live;
  const owners = [];
  const seen = new Set();
  if (token) {
    // Владельца живой куки узнаём по самому токену: если этот вход сохранён, он уже есть в списке.
    // Логин спрашиваем только у незнакомого токена — и один раз, потому что от него зависит история.
    // По accounts.active владельца не угадываем: при рассинхроне это дало бы двойной клейм.
    let owner = list.find((item) => bearer(item) === token) || null;
    let login = owner?.login || "";
    if (!owner) {
      const verified = String(await kickUserName(token).catch(() => "")).trim();
      if (verified) {
        const checked = verified.toLowerCase();
        owner = list.find((item) => String(item.login || "").toLowerCase() === checked) || null;
        login = verified;
      }
    }
    // Незнакомый аккаунт: свой ключ по логину, а безымянный — «current». Прежний логин из state
    // (kick.user) сюда не подставляем: он бывает от прошлого входа и приписал бы клейм чужому.
    const id = owner?.id || (login ? `live:${login.toLowerCase()}` : "current");
    // Токен не сохранён и не опознан: чья это кука — неизвестно. Когда рядом есть сохранённые входы,
    // клеймить ею нельзя: если Kick выдал тот же вход новый session_token, сохранённая запись открыла бы
    // кейс ещё раз своим старым. Без сохранённых входов двойника быть не может — работаем как раньше.
    const unverified = !owner && !login && list.length > 0;
    owners.push({ id, login: login || owner?.login || "", token, own: true, unverified });
    seen.add(token);
  } else if (mine) {
    // Куки браузера нет, а сохранённая сессия этого аккаунта есть: работаем ею.
    owners.push({ id: mine.id, login: mine.login || "", token: bearer(mine), own: true });
    seen.add(bearer(mine));
  }
  // «Только вручную»: сохранённые аккаунты не трогаем, кейсы открывает лишь тот, что в браузере.
  if ((data.rotate?.mode || "all") === "never") return owners;
  const taken = new Set(owners.map((owner) => owner.id));
  // Один и тот же человек не должен сходить дважды: дубли в списке (тот же логин разными токенами)
  // иначе открыли бы один кейс два раза и написали две записи в историю.
  const logins = new Set(owners.map((owner) => String(owner.login || "").toLowerCase()).filter(Boolean));
  for (const account of list) {
    if (taken.has(account.id)) continue;
    const own = bearer(account);
    // Один и тот же токен не должен сходить дважды: живая кука может быть входом сохранённого.
    if (seen.has(own)) continue;
    const login = String(account.login || "").toLowerCase();
    if (login && logins.has(login)) continue;
    seen.add(own);
    if (login) logins.add(login);
    owners.push({ id: account.id, login: account.login || "", token: own, own: false });
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
  const text = await response.text().catch(() => "");
  // 204 или пустое тело — клейм принят, карточки просто нет.
  if (!text.trim()) return {};
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
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
  if (owner.unverified) {
    // Неопознанную куку не трогаем вовсе: ни списка, ни клейма. Отметки прежних проходов переживают
    // это и вернутся, когда тот же вход снова узнают по токену или логину.
    return {
      login: "", items: [], opened: previous.opened || {}, failed: previous.failed || {},
      checkedAt: now, error: "", claimError: "", served: false, unverified: true,
    };
  }
  const items = await list(owner);
  // «current» — общий ключ для безымянного входа: если в браузере уже другой человек, его вчерашние
  // отметки к новому аккаунту не относятся (та же минута другого аккаунта — не повод не открывать).
  const reused = owner.id === "current" && previous.login && owner.login
    && String(previous.login).toLowerCase() !== String(owner.login).toLowerCase();
  const opened = { ...(reused ? {} : previous.opened || {}) };
  const failed = { ...(reused ? {} : previous.failed || {}) };
  let claimError = "";
  if (state.enabled) {
    for (const row of items.filter((item) => isClaimable(item, now))) {
      // Ключ включает окно попытки (или день, если окна нет): новая попытка — новый ключ.
      // Пока ключ тот же, повторно не клеймим, даже если сервер ещё отдаёт claimable из-за задержки.
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
    checkedAt: now, error: "", claimError, served: true,
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
  const now = Date.now();
  const live = await cookieToken();
  // Отпечаток куки: смена аккаунта в браузере видна без единого запроса к Kick.
  const mark = live ? stamp(live) : "";
  // Кука не та, что в прошлом проходе, — liveId прежнего аккаунта устарел. Проходим заново, даже
  // если отметки свежие: иначе kickCaseNeed ещё 90 секунд брал бы кейс аккаунта, который уже вышел.
  const moved = Boolean(live) && mark !== String(state.liveStamp || "");
  // Без force, без смены входа и с готовыми отметками не ходим даже за логином активного аккаунта.
  if (!force && !moved) {
    const data = await readAccounts();
    const ids = [data.kick.active || "current", ...(data.kick.list || []).map((item) => String(item.id))];
    if (ids.every((id) => now - (state.accounts[id]?.checkedAt || 0) < CHECK_MS)) return state;
  }
  const owners = await caseOwners(live);
  const next = { ...state.accounts };
  let touched = false;
  for (const owner of owners) {
    const previous = state.accounts[owner.id] || {};
    if (!force && !moved && now - (previous.checkedAt || 0) < CHECK_MS) continue;
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
  // Все сохранённые, включая истёкшие: их отметки не стираем, иначе после повторного входа
  // вчерашняя награда открылась бы снова. Служат они или нет — решит флаг served.
  const known = new Set((data.kick.list || []).map((item) => String(item.id)));
  // Неопознанный живой вход не обслуживается: попап и openKickCase его не предлагают.
  const serving = new Set(owners.filter((owner) => !owner.unverified).map((owner) => owner.id));
  // current — синтетический ключ аккаунта без сохранённой записи: держим, только пока он в деле.
  // Неопознанный живой вход держим записью без обслуживания: попап скажет, что он не в деле,
  // вместо того чтобы молча его спрятать.
  const unsure = owners.some((owner) => owner.unverified);
  if (!serving.size || serving.has("current") || unsure) known.add("current");
  const logins = new Map((data.kick.list || []).map((item) => [String(item.id), item.login || ""]));
  for (const id of Object.keys(next)) {
    if (!known.has(id) && !serving.has(id)) {
      delete next[id];
      continue;
    }
    // Попап показывает только обслуживаемые аккаунты, остальные не предлагает открывать.
    next[id] = { ...next[id], served: serving.has(id) };
  }
  // Сохранённый, но не обслуживаемый аккаунт тоже заводим пустой записью: попап скажет,
  // что он не обслуживается, вместо того чтобы молча его не показывать.
  for (const id of known) {
    if (next[id]) continue;
    next[id] = { login: logins.get(id) || "", items: [], opened: {}, failed: {}, checkedAt: 0, error: "", served: false };
  }
  if (!touched) return state;
  // Кто сейчас живёт в браузере: по этому id kickCaseNeed выбирает кейс, не полагаясь на state.user.
  const liveOwner = owners.find((owner) => owner.own);
  // liveIdAt — когда живого владельца записали: по нему kickCaseNeed решает, чей логин свежее.
  return save({ accounts: next, notice: "", liveId: liveOwner?.id || "", liveIdAt: liveOwner ? now : 0, liveStamp: mark });
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
    // Аккаунт убрали, сменили или он сейчас не обслуживается (режим «только вручную»):
    // скажем об этом, а не молчим.
    const data = await readAccounts();
    const known = (data.kick.list || []).some((item) => String(item.id) === wanted);
    return save({ notice: known ? "not-served" : "account-gone" });
  }
  // Неопознанная живая кука: кнопка в попапе может относиться к прошлому проходу, а клеймить ею
  // нельзя — вдруг это сохранённый вход с обновлённым токеном.
  if (owner.unverified) return save({ notice: "unverified" });
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
