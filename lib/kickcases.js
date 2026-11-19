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
import { kickHeaders } from "./kick.js";

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
  const next = await save({ enabled: Boolean(enabled) });
  kickCasesTick({ force: true }).catch(() => {});
  return next;
}

// Те же заголовки, что у сайта: без X-App-Platform Kick отвечает 403.
export function casesHeaders(token) {
  return { ...kickHeaders(token), "X-App-Platform": "web" };
}

// Отметка попытки: у ежедневного кейса новая попытка каждый день, id при этом не меняется.
export function caseKey(item) {
  const ends = item?.endsAt || item?.window?.ends_at || "";
  return `${item?.id || ""}|${ends}`;
}

export function caseArt(winner) {
  const url = winner?.card_url || winner?.thumbnail_url || "";
  return /^https?:\/\//.test(String(url)) ? String(url) : "";
}

// Готов к открытию: Kick говорит claimable, либо минуты уже набраны, а клейма ещё не было.
export function isClaimable(row) {
  if (!row || row.claimedAt) return false;
  if (row.status === "claimed") return false;
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
  const data = await readAccounts();
  const list = (data.kick.list || []).filter((item) => item && !item.expired && bearer(item));
  const active = data.kick.active || "";
  const stored = (await chrome.storage.local.get("kick")).kick || {};
  const mine = list.find((item) => item.id === active) || null;
  const live = await cookieToken();
  const owners = [];
  if (live) {
    owners.push({ id: active || "current", login: mine?.login || stored.user || "", token: live, own: true });
  } else if (mine) {
    // Куки браузера нет, а сохранённая сессия этого аккаунта есть: работаем ею.
    owners.push({ id: mine.id, login: mine.login || "", token: bearer(mine), own: true });
  }
  const taken = new Set(owners.map((owner) => owner.id));
  for (const account of list) {
    if (taken.has(account.id)) continue;
    owners.push({ id: account.id, login: account.login || "", token: bearer(account), own: false });
  }
  return owners;
}

async function list(owner) {
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
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body?.data || null;
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

// Открыть один кейс: null — Kick клейм не принял.
async function open(owner, row, opened) {
  const data = await claim(owner, row.id).catch(() => null);
  if (!data) return null;
  // Утешительный приз приходит вместо карточки, когда ничего не выпало.
  const won = data.winner || data.consolation || null;
  await noteWon(row, opened, owner.login, won);
  return won;
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

// Один проход по одному аккаунту.
async function pass(state, owner, previous, now) {
  const items = await list(owner);
  const opened = { ...(previous.opened || {}) };
  const failed = { ...(previous.failed || {}) };
  let best = "";
  if (state.enabled) {
    for (const row of items.filter(isClaimable)) {
      // Неудачную попытку повторяем не чаще раза в 10 минут: Kick иногда отвечает, что ещё рано.
      if (opened[row.key] || now - (failed[row.key] || 0) < RETRY_MS) continue;
      const won = await open(owner, row, opened);
      if (!won) failed[row.key] = now;
      else if (won.rarity) best = `${row.name} · ${won.rarity}`;
    }
  }
  // Старые отметки не копим.
  const keys = Object.keys(failed).sort((left, right) => failed[left] - failed[right]);
  for (const key of keys.slice(0, Math.max(0, keys.length - 60))) delete failed[key];
  return { login: owner.login, items: marked(items, opened), opened, failed, checkedAt: now, error: "", best };
}

// Проход: по всем аккаунтам прочитать список кейсов и открыть всё готовое.
// Один аккаунт ходит не чаще раза в 90 секунд; force — сразу.
export async function kickCasesTick({ force = false } = {}) {
  const state = await readKickCases();
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
      next[owner.id] = { ...previous, login: owner.login, error: String(error?.message || error).slice(0, 120), checkedAt: now };
    }
  }
  // Аккаунт убрали — его кейсы не копим.
  for (const id of Object.keys(next)) if (!owners.some((owner) => owner.id === id)) delete next[id];
  if (!touched) return state;
  return save({ accounts: next });
}

// Открыть кейс по кнопке в попапе. account — id аккаунта, к которому относится строка.
export async function openKickCase(id, account = "") {
  const state = await readKickCases();
  const owners = await caseOwners();
  const owner = owners.find((item) => item.id === String(account || "")) || owners[0] || null;
  if (!owner) return state;
  const previous = state.accounts[owner.id] || {};
  const row = (previous.items || []).find((item) => item.id === String(id));
  if (!row) return state;
  const opened = { ...(previous.opened || {}) };
  await open(owner, row, opened).catch(() => null);
  const items = marked(await list(owner).catch(() => previous.items || []), opened);
  return save({
    accounts: { ...state.accounts, [owner.id]: { ...previous, login: owner.login, items, opened, error: "" } },
  });
}
