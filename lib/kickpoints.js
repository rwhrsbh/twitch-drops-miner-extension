// Баллы каналов Kick. Только для каналов, которые пользователь добавил сам.
//
// В отличие от Twitch, Kick начисляет баллы за тот же «просмотр» по WebSocket, которым фармятся дропы
// (channel_handshake + tracking.user.watch.livestream), видео для этого не нужно. Способ и адреса взяты из
// atalaydenknalbant/twitch-kick-points-miner. Поэтому здесь расширение держит по сокету на канал
// (не больше двух сразу, как в том майнере), раз в 5 минут читает баланс и раз в полчаса забирает
// ежедневные награды. Канал, где сейчас идёт дроп, баллы получает и так; пока дроп фармится,
// выбранные каналы ждут, чтобы второй просмотр не мешал дропу.
// Включается тем же переключателем «Собирать баллы каналов», что и баллы Twitch.
// pointsPass — один проход для одного аккаунта: им пользуется и активный аккаунт (здесь),
// и аккаунты, фармящие параллельно (lib/kickside.js).
import { FEATURES } from "./constants.js";
import { addHistory } from "./history.js";
import { kickAuth, kickCard, kickHeaders, kickWatchingLogin } from "./kick.js";
import { createWatchers } from "./kicksocket.js";
import { readPoints } from "./points.js";

const KEY = "kickPoints";
const SITE = "https://kick.com";
const WEB = "https://web.kick.com/api/v1";
const CHECK_MS = 5 * 60 * 1000;
const DAILY_MS = 30 * 60 * 1000;
const MAX_WATCH = 2;
const TICK_STALE = 3 * 60 * 1000;
const watchers = createWatchers();
let tickingAt = 0;
// Растёт при смене аккаунта: проход прежнего аккаунта не должен записать свои балансы новому.
let epoch = 0;

function defaults() {
  return { channels: [], status: {}, checkedAt: 0, dailyAt: 0, daily: {}, updatedAt: 0 };
}

export async function readKickPoints() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...defaults(), ...(stored[KEY] || {}) };
}

async function save(patch) {
  const fresh = await readKickPoints();
  const next = { ...fresh, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function cleanKickChannels(channels) {
  const seen = new Map();
  for (const channel of channels || []) {
    const login = String(channel?.login || "").trim().toLowerCase();
    if (!login) continue;
    seen.set(login, { login, id: String(channel.id || ""), name: channel.name || login, image: channel.image || "" });
  }
  return [...seen.values()];
}

export async function setKickPointsChannels(channels) {
  const next = await save({ channels: cleanKickChannels(channels), checkedAt: 0 });
  kickPointsTick();
  return next;
}

// Список каналов и статусы целиком (смена аккаунта): сокеты прежнего аккаунта закрываются.
export async function replaceKickPoints(channels) {
  epoch += 1;
  stopKickPoints();
  return save({ channels: cleanKickChannels(channels), status: {}, checkedAt: 0, dailyAt: 0, daily: {}, dropLogin: "" });
}

export async function searchKickChannels(query) {
  const text = String(query || "").trim();
  if (!text) return [];
  const items = new Map();
  try {
    const response = await fetch(`${SITE}/api/search?searched_word=${encodeURIComponent(text)}`, { headers: { Accept: "application/json" } });
    const body = response.ok ? await response.json() : null;
    for (const row of body?.channels || []) {
      if (!row?.slug || row.is_banned) continue;
      items.set(row.slug.toLowerCase(), {
        login: row.slug.toLowerCase(),
        id: String(row.id || ""),
        name: row.user?.username || row.slug,
        image: row.user?.profilePic || row.user?.profile_pic || "",
        live: Boolean(row.isLive ?? row.is_live),
      });
    }
  } catch {
    // Поиск Kick недоступен: ниже пробуем точный ник.
  }
  const slug = text.toLowerCase().replace(/\s+/g, "");
  if (!items.has(slug) && /^[a-z0-9_-]{2,40}$/.test(slug)) {
    const card = await kickCard(slug);
    if (card && card.channelId) {
      items.set(slug, { login: slug, id: String(card.channelId), name: card.name || slug, image: card.image || "", live: Boolean(card.live) });
    }
  }
  // Точное совпадение ника первым, дальше каналы в эфире.
  return [...items.values()]
    .sort((left, right) => Number(right.login === slug) - Number(left.login === slug) || Number(right.live) - Number(left.live))
    .slice(0, 12);
}

export function stopKickPoints() {
  watchers.stopAll("main:");
}

async function balance(token, login, own) {
  const response = await fetch(`${SITE}/api/v2/channels/${encodeURIComponent(login)}/points`, {
    headers: kickHeaders(token),
    credentials: own ? "include" : "omit",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const value = body?.data?.points ?? body?.points;
  return Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null;
}

// Ежедневные награды Kick: забираем те, что уже можно забрать.
async function claimDaily(token, known, account, own) {
  const daily = { ...(known || {}) };
  const headers = { ...kickHeaders(token), "X-App-Platform": "web" };
  const credentials = own ? "include" : "omit";
  const response = await fetch(`${WEB}/gamification/challenges`, { headers, credentials, signal: AbortSignal.timeout(15000) });
  if (!response.ok) return daily;
  const body = await response.json();
  for (const item of Array.isArray(body?.data) ? body.data : []) {
    if (String(item?.status || "").toLowerCase() !== "claimable" || !item.id) continue;
    const key = `${item.id}|${item.window?.ends_at || ""}`;
    if (daily[key]) continue;
    const done = await fetch(`${WEB}/gamification/challenges/${encodeURIComponent(item.id)}/claim`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      credentials,
      signal: AbortSignal.timeout(15000),
      body: "{}",
    });
    if (!done.ok) continue;
    daily[key] = Date.now();
    // Награда — карточка случайной редкости; что выпало, Kick сообщает в ответе на клейм.
    const won = (await done.json().catch(() => null))?.data?.winner || item.winner || {};
    const title = item.name || item.title || "Daily Reward";
    await addHistory({
      kind: "drop",
      platform: "kick",
      account,
      name: won.rarity ? `${title} · ${won.rarity}` : title,
      game: "Kick",
      image: won.thumbnail_url || won.card_url || "",
    });
  }
  // Старые отметки не копим.
  const keys = Object.keys(daily).sort((left, right) => daily[left] - daily[right]);
  for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete daily[key];
  return daily;
}

// Один проход баллов для одного аккаунта.
// ctx: token — Bearer аккаунта; viewer() — свежий токен зрителя; channels — выбранные каналы;
// dropLogin — канал, который этот аккаунт уже смотрит ради дропа; previous — прошлый результат;
// prefix — ключи сокетов этого аккаунта; account — ник для истории;
// own — токен аккаунта браузера (тогда запросы идут с его куками), по умолчанию да.
export async function pointsPass(ctx, pool = watchers) {
  const own = ctx.own !== false;
  const previous = ctx.previous || {};
  const dropLogin = String(ctx.dropLogin || "").toLowerCase();
  const channels = ctx.channels || [];
  const list = [...channels];
  if (dropLogin && !list.some((channel) => channel.login === dropLogin)) {
    list.push({ login: dropLogin, id: "", name: dropLogin, image: "", drop: true });
  }
  const now = Date.now();
  const status = Object.fromEntries(list.map((channel) => [channel.login, { ...(previous.status?.[channel.login] || {}), drop: Boolean(channel.drop) }]));
  const cards = {};
  for (const channel of list) {
    const card = await kickCard(channel.login);
    cards[channel.login] = card;
    // null: Kick не ответил, прежний статус не трогаем.
    if (card) status[channel.login].live = Boolean(card.live);
  }

  // Пока аккаунт фармит дроп, другие каналы не смотрим: второй «просмотр» останавливает минуты дропа
  // (проверено вживую в октябре 2026), а баллы на канале дропа идут и так. Нет дропа — смотрим
  // первые два выбранных канала в эфире.
  const wanted = dropLogin ? [] : channels
    .filter((channel) => cards[channel.login]?.live)
    .slice(0, MAX_WATCH)
    .map((channel) => channel.login);
  const key = (login) => `${ctx.prefix}${login}`;
  for (const full of pool.keys().filter((item) => item.startsWith(ctx.prefix))) {
    const login = full.slice(ctx.prefix.length);
    // Идёт дроп: сокеты баллов закрываются все без исключений.
    // Иначе, если Kick не ответил про канал, сокет не трогаем: возможно, эфир идёт.
    const keep = !dropLogin && cards[login] === null && channels.some((channel) => channel.login === login);
    if (!wanted.includes(login) && !keep) pool.close(full);
  }
  for (const login of wanted) {
    if (pool.alive(key(login), cards[login].livestreamId)) continue;
    // У каждого сокета свой токен зрителя.
    const viewer = await ctx.viewer().catch(() => "");
    if (viewer) pool.open(key(login), viewer, { ...cards[login], login });
  }
  for (const channel of list) {
    status[channel.login].watching = channel.login === dropLogin || pool.has(key(channel.login));
  }

  const fresh = dropLogin !== (previous.dropLogin || "");
  let checkedAt = previous.checkedAt || 0;
  if (list.length && (fresh || now - checkedAt >= CHECK_MS)) {
    for (const channel of list) {
      const entry = status[channel.login];
      const value = await balance(ctx.token, channel.login, own).catch(() => null);
      if (value === null) continue;
      if (typeof entry.balance === "number" && value > entry.balance) {
        entry.lastGain = value - entry.balance;
        entry.gainAt = now;
        entry.gained = (entry.gained || 0) + entry.lastGain;
      }
      entry.balance = value;
    }
    checkedAt = now;
  }

  let daily = previous.daily || {};
  let dailyAt = previous.dailyAt || 0;
  if (now - dailyAt >= DAILY_MS) {
    daily = await claimDaily(ctx.token, daily, ctx.account, own).catch(() => daily);
    dailyAt = now;
  }
  return { status, checkedAt, dropLogin, daily, dailyAt };
}

// Вызывается каждую минуту после прохода майнера Kick.
export async function kickPointsTick() {
  if (tickingAt && Date.now() - tickingAt < TICK_STALE) return readKickPoints();
  tickingAt = Date.now();
  try {
    return await run();
  } catch {
    return readKickPoints();
  } finally {
    tickingAt = 0;
  }
}

async function run() {
  const mine = epoch;
  const state = await readKickPoints();
  const stored = await chrome.storage.local.get("kick");
  if (!FEATURES.kickPoints || !(await readPoints()).enabled || stored.kick?.enabled === false) {
    stopKickPoints();
    return state;
  }
  // Сокета может не быть (фоновый скрипт только что перезапустился, дроп смотрит запасная вкладка),
  // а дроп при этом фармится: тогда берём канал из сохранённого состояния майнера.
  const watched = stored.kick?.phase === "watching" ? stored.kick.watching?.login : "";
  const dropLogin = String(kickWatchingLogin() || watched || "").toLowerCase();
  if (!state.channels.length && !dropLogin && Date.now() - (state.dailyAt || 0) < DAILY_MS) {
    stopKickPoints();
    return state;
  }
  const auth = await kickAuth().catch(() => null);
  if (!auth) {
    stopKickPoints();
    return state;
  }
  const result = await pointsPass({
    token: auth.token,
    viewer: async () => (await kickAuth())?.viewer || "",
    channels: state.channels,
    dropLogin,
    previous: state,
    prefix: "main:",
    account: stored.kick?.user || "",
  });
  // Аккаунт сменили, пока шёл проход: его балансы и сокеты новому не принадлежат.
  if (mine !== epoch) {
    stopKickPoints();
    return readKickPoints();
  }
  return save(result);
}
