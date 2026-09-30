// Kick drops. Протокол по PBA4EVSKY/kickautodrops и JourneyDocker/GrubDrops:
// токен просмотра → WebSocket viewer/v1/connect → handshake/ping → user_event раз в минуту → claim.
// Сессия берётся из cookie session_token, которую Kick ставит после обычного входа в браузере.
import { mark } from "./i18n.js";
import { isBlocked, readSettings } from "./settings.js";

const WEB = "https://web.kick.com/api/v1";
const SITE = "https://kick.com";
// Публичный идентификатор веб-клиента Kick, одинаковый у всех. Если Kick его сменит,
// свежий берётся из запросов самого сайта (kick-hook.js) и хранится в storage.
const CLIENT_TOKEN = "e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823";
let clientToken = "";
const KEY = "kick";
const STALL_MS = 8 * 60 * 1000;

let session = null;
let timer = 0;
let ticking = false;
let again = false;
let running = Promise.resolve();

// Дождаться, пока закончатся все проходы (нужно тестам).
export async function kickSettled() {
  while (ticking || again) await running;
}

function defaults() {
  return {
    enabled: true,
    phase: "idle",
    user: "",
    message: "",
    watching: null,
    queue: [],
    log: [],
    updatedAt: 0,
  };
}

export async function readKick() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...defaults(), ...(stored[KEY] || {}) };
}

// Переключатель мог сработать посреди тика: берём его актуальное значение, а не то, что тик прочитал в начале.
async function save(state, { force = false } = {}) {
  const enabled = force ? state.enabled : (await readKick()).enabled;
  const fresh = force ? state : await readKick();
  const next = { ...state, enabled, preferDropId: state.preferDropId ?? fresh.preferDropId, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

function push(state, text) {
  return [{ at: Date.now(), text }, ...(state.log || [])].slice(0, 30);
}

// fetch из service worker уходит с Origin расширения; Kick и WebSocket его отбивают.
export async function installKickRules() {
  const condition = (types) => ({
    requestDomains: ["kick.com", "web.kick.com", "websockets.kick.com"],
    resourceTypes: types,
    initiatorDomains: [chrome.runtime.id],
  });
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [101, 102],
    addRules: [
      {
        id: 101,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: SITE },
            { header: "Referer", operation: "set", value: `${SITE}/` },
          ],
        },
        condition: condition(["xmlhttprequest", "websocket"]),
      },
    ],
  });
}

async function readToken() {
  const found = await chrome.cookies.get({ url: `${SITE}/`, name: "session_token" });
  const raw = found?.value || "";
  if (!raw) return [];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  // LurkLoot (jamezrin/lurkloot) шлёт Bearer уже декодированным.
  return decoded === raw ? [raw] : [decoded, raw];
}

function headers(token) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-Client-Token": clientToken || CLIENT_TOKEN,
  };
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: token ? headers(token) : { Accept: "application/json" },
    credentials: "include",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadClientToken() {
  if (clientToken) return;
  const stored = await chrome.storage.local.get("kickClientToken");
  clientToken = stored.kickClientToken || "";
}

async function readHookToken(tabId) {
  const [injected] = await Promise.race([
    chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => window.__dropsKickClientToken || "" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("tab timeout")), 4000)),
  ]);
  return injected?.result || "";
}

// Сессия есть, а Kick отвечает 401/403: возможно, сменился X-Client-Token. Берём его из вкладки kick.com,
// а если её нет, открываем закреплённую беззвучную и закрываем после. Не чаще раза в 10 минут.
let refreshAt = 0;

// Для тестов: сбросить запомненный токен и паузу между обновлениями.
export function resetClientToken() {
  refreshAt = 0;
  cardCache.clear();
  clientToken = "";
}
async function refreshClientToken() {
  if (Date.now() - refreshAt < 10 * 60 * 1000) return false;
  refreshAt = Date.now();
  let found = "";
  let opened = 0;
  try {
    const tabs = await chrome.tabs.query({ url: "https://kick.com/*" });
    for (const tab of tabs) {
      found = await readHookToken(tab.id).catch(() => "");
      if (found) break;
    }
    if (!found) {
      const tab = await chrome.tabs.create({ url: `${SITE}/drops/inventory`, active: false, pinned: true });
      opened = tab.id;
      await chrome.tabs.update(opened, { muted: true });
      for (let attempt = 0; attempt < 20 && !found; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        found = await readHookToken(opened).catch(() => "");
      }
    }
  } finally {
    if (opened) await chrome.tabs.remove(opened).catch(() => {});
  }
  if (!found || found === (clientToken || CLIENT_TOKEN)) return false;
  clientToken = found;
  await chrome.storage.local.set({ kickClientToken: found });
  return true;
}

async function workingToken(candidates) {
  await loadClientToken();
  try {
    return await viewerToken(candidates);
  } catch (error) {
    if (/HTTP 40[13]/.test(error.message) && await refreshClientToken().catch(() => false)) {
      return viewerToken(candidates);
    }
    throw error;
  }
}

async function viewerToken(candidates) {
  let last = "";
  for (const token of candidates) {
    try {
      const body = await getJson("https://websockets.kick.com/viewer/v1/token", token);
      const viewer = body?.data?.token;
      if (viewer) return { token, viewer };
    } catch (error) {
      last = error.message;
    }
  }
  throw new Error(last || "HTTP 401");
}

async function userName(token) {
  try {
    const body = await getJson(`${SITE}/api/v1/user`, token);
    return body?.username || body?.streamer_channel?.slug || "";
  } catch {
    return "";
  }
}

async function claim(token, campaignId, rewardId) {
  const response = await fetch(`${WEB}/drops/claim`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reward_id: rewardId, campaign_id: campaignId }),
  });
  if (!response.ok) return false;
  const body = await response.json().catch(() => ({}));
  return body?.message === "Success";
}

// Игры, выбранные вручную: свои для Kick плюс те, что отмечены в списке Twitch (по названию).
async function pickedGames(settings) {
  const names = new Set((settings.picked || []).map((name) => name.toLowerCase()));
  const stored = (await chrome.storage.local.get("state")).state || {};
  const chosen = new Set((stored.whitelist || []).map(String));
  for (const game of stored.games || []) {
    if (chosen.has(String(game.id)) && game.name) names.add(game.name.toLowerCase());
  }
  return names;
}

function gameList(rows) {
  const games = new Map();
  for (const row of rows) {
    if (row.claimed && !rows.some((item) => item.game === row.game && !item.claimed)) continue;
    const key = row.game.toLowerCase();
    const entry = games.get(key) || { name: row.game, image: row.campaignImage, linked: false, campaigns: new Set() };
    entry.linked = entry.linked || row.linked;
    entry.campaigns.add(row.campaignId);
    games.set(key, entry);
  }
  return [...games.values()]
    .map((game) => ({ name: game.name, image: game.image, linked: game.linked, campaigns: game.campaigns.size }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function rewardArt(path) {
  if (!path) return "";
  return /^https?:/.test(path) ? path : `https://ext.kick.com/${path.replace(/^\/+/, "")}`;
}

// Кампании + личный прогресс в один список наград.
function mergeQueue(campaigns, progress) {
  const mine = new Map();
  for (const campaign of progress || []) {
    for (const reward of campaign.rewards || []) mine.set(String(reward.id), reward);
  }
  const now = Date.now();
  const rows = [];
  for (const campaign of campaigns || []) {
    if (campaign.status === "expired") continue;
    const ends = Date.parse(campaign.ends_at || "");
    if (ends && ends < now) continue;
    const starts = Date.parse(campaign.starts_at || "");
    if (starts && starts > now) continue;
    const categoryId = campaign.category?.id;
    if (categoryId == null) continue;
    const channels = (campaign.channels || []).map((channel) => channel.slug).filter(Boolean);
    for (const reward of campaign.rewards || []) {
      const own = mine.get(String(reward.id)) || {};
      const fraction = Number(own.progress ?? reward.progress ?? 0);
      const required = Number(reward.required_units || 0);
      rows.push({
        id: String(reward.id),
        campaignId: campaign.id,
        campaign: campaign.name || "",
        name: reward.name || campaign.name || "",
        game: campaign.category?.name || "",
        categoryId,
        image: rewardArt(reward.image_url || reward.image),
        campaignImage: campaign.category?.image_url || "",
        // connect_url в ответе с токеном непустой, пока игровой аккаунт не привязан.
        linked: !campaign.connect_url,
        connectUrl: campaign.connect_url || "",
        url: campaign.url || "",
        channels,
        required,
        current: Math.min(required, Math.round(fraction * required)),
        progress: fraction,
        claimed: Boolean(own.claimed ?? reward.claimed),
      });
    }
  }
  return rows;
}

// Эфиры категории по убыванию зрителей, страницами по 100 (курсор after). wanted: какие каналы ищем; null: хватит первой страницы.
async function liveMap(categoryId, wanted = null, maxPages = 8) {
  const found = new Map();
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const url = `${WEB}/livestreams?limit=100&sort=viewer_count_desc&category_id=${categoryId}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
    const body = await getJson(url);
    for (const stream of body?.data?.livestreams || []) {
      const slug = stream.channel?.slug || stream.channel?.username;
      if (!slug || !stream.channel?.id) continue;
      found.set(slug, { channelId: stream.channel.id, livestreamId: stream.id, login: slug });
    }
    cursor = body?.data?.pagination?.next_cursor || "";
    if (!cursor || !wanted) break;
    if ([...wanted].every((slug) => found.has(slug))) break;
  }
  return found;
}

// Список эфиров отдаёт id трансляции как UUID, а событие просмотра Kick засчитывает только с числовым id.
// С UUID сокет живой, пинги идут, но минуты не растут. Числовые id берём из карточки канала, как LurkLoot.
// Карточка канала: числовые id для события просмотра и настоящая категория эфира.
// Список эфиров категории у Kick запаздывает и отдаёт каналы, которые уже стримят другое:
// тогда минуты уходят в чужую кампанию (так Minecraft стоял, а рос Daily Drop из IRL).
async function channelCard(login) {
  try {
    const body = await getJson(`${SITE}/api/v2/channels/${encodeURIComponent(login)}`);
    const live = body?.livestream;
    if (!live?.id || body?.id == null) return { live: false };
    const categories = [...(live.categories || []), ...(live.category ? [live.category] : [])].map((item) => item.id);
    return { live: true, channelId: body.id, livestreamId: live.id, categories, viewers: Number(live.viewer_count) || 0 };
  } catch {
    return null;
  }
}

// Карточки каналов с кэшем на 3 минуты: у эксклюзивной кампании бывает 100+ каналов.
const CARD_TTL = 3 * 60 * 1000;
const cardCache = new Map();
async function channelCards(slugs) {
  const out = new Map();
  const stale = [];
  for (const slug of slugs) {
    const hit = cardCache.get(slug);
    if (hit && Date.now() - hit.at < CARD_TTL) out.set(slug, hit.card);
    else stale.push(slug);
  }
  for (let index = 0; index < stale.length; index += 10) {
    await Promise.all(stale.slice(index, index + 10).map(async (slug) => {
      const card = await channelCard(slug);
      if (!card) return;
      cardCache.set(slug, { at: Date.now(), card });
      out.set(slug, card);
    }));
  }
  return out;
}

// Канал годится, если он в эфире и именно в категории дропа. null от карточки (сеть) не считаем отказом.
async function verify(live, categoryId) {
  const card = await channelCard(live.login);
  if (!card) return live;
  if (!card.live) return null;
  if (categoryId != null && card.categories.length && !card.categories.includes(categoryId)) return null;
  return { ...live, channelId: card.channelId, livestreamId: card.livestreamId };
}

// Только привязанные и неполученные; игры, выбранные вручную, идут раньше остальных, потом эксклюзивные и те, что ближе к финишу.
function order(rows, first = new Set()) {
  const tier = (row) => (first.has(row.game.toLowerCase()) ? 0 : 1);
  return rows
    .filter((row) => row.linked && !row.claimed && row.progress < 1)
    .sort((left, right) => (tier(left) - tier(right))
      || (Boolean(right.channels.length) - Boolean(left.channels.length))
      || (right.progress - left.progress));
}

// Кандидаты по порядку: у эксклюзивного дропа его каналы в эфире, у обычного верх списка эфиров категории.
function candidates(row, maps, limit = 6) {
  const live = maps.get(row.categoryId) || new Map();
  const slugs = row.channels.length ? (row.live || []).filter((name) => live.has(name)) : [...live.keys()];
  return slugs.slice(0, limit).map((slug) => live.get(slug));
}

async function firstVerified(row, maps, skip = "") {
  for (const live of candidates(row, maps)) {
    if (live.login === skip) continue;
    const checked = await verify(live, row.categoryId);
    if (checked) return checked;
  }
  return null;
}

async function pickTarget(rows, first, maps, skip) {
  for (const row of order(rows, first)) {
    const live = await firstVerified(row, maps, skip);
    if (live) return { row, live };
  }
  return null;
}

// Запасной путь: если WebSocket или API не работают (WAF, обрыв), стрим смотрит закреплённая беззвучная вкладка.
// Как только сокет снова живой, вкладка закрывается сама.
async function tabId() {
  const stored = await chrome.storage.session.get("kickTabId");
  return stored.kickTabId || 0;
}

export async function closeKickTab() {
  const id = await tabId();
  if (!id) return;
  await chrome.storage.session.remove("kickTabId");
  try {
    await chrome.tabs.remove(id);
  } catch {
    // Вкладку уже закрыли.
  }
}

async function ensureKickTab(login) {
  const url = `${SITE}/${encodeURIComponent(login)}`;
  const id = await tabId();
  if (id) {
    try {
      const tab = await chrome.tabs.get(id);
      if (!tab.url?.toLowerCase().startsWith(url.toLowerCase())) await chrome.tabs.update(id, { url });
      return;
    } catch {
      await chrome.storage.session.remove("kickTabId");
    }
  }
  const tab = await chrome.tabs.create({ url, active: false, pinned: true });
  await chrome.storage.session.set({ kickTabId: tab.id });
  await chrome.tabs.update(tab.id, { muted: true });
}

// Время последнего события просмотра: попап пишет «пинг N с назад», как у Twitch.
// Отдельный ключ, чтобы проход с устаревшим состоянием его не затирал.
function notePing(login) {
  chrome.storage.local.set({ kickPing: { at: Date.now(), login } }).catch(() => {});
}

export function stopWatch() {
  clearTimeout(timer);
  timer = 0;
  if (session?.ws) {
    session.ws.onclose = null;
    try {
      session.ws.close();
    } catch {
      // Сокет уже закрыт.
    }
  }
  session = null;
}

function startWatch(viewer, live) {
  stopWatch();
  const ws = new WebSocket(`wss://websockets.kick.com/viewer/v1/connect?token=${encodeURIComponent(viewer)}`);
  const mine = { ws, channelId: live.channelId, livestreamId: live.livestreamId, login: live.login, beat: 0, sentAt: Date.now(), dead: false, opened: false, failed: false };
  session = mine;
  const loop = () => {
    if (session !== mine || ws.readyState !== WebSocket.OPEN) return;
    mine.beat += 1;
    ws.send(JSON.stringify(mine.beat % 2 === 0
      ? { type: "ping" }
      : { type: "channel_handshake", data: { message: { channelId: mine.channelId } } }));
    if (Date.now() - mine.sentAt >= 60000 && mine.livestreamId) {
      mine.sentAt = Date.now();
      ws.send(JSON.stringify({
        type: "user_event",
        data: { message: { name: "tracking.user.watch.livestream", channel_id: mine.channelId, livestream_id: mine.livestreamId } },
      }));
      notePing(mine.login);
    }
    timer = setTimeout(loop, 13000 + Math.floor(Math.random() * 6000));
  };
  ws.onopen = () => {
    mine.opened = true;
    // Сразу заявляем просмотр, чтобы прогресс шёл без ожидания первой минуты.
    ws.send(JSON.stringify({ type: "channel_handshake", data: { message: { channelId: mine.channelId } } }));
    if (mine.livestreamId) {
      ws.send(JSON.stringify({
        type: "user_event",
        data: { message: { name: "tracking.user.watch.livestream", channel_id: mine.channelId, livestream_id: mine.livestreamId } },
      }));
      mine.sentAt = Date.now();
      notePing(mine.login);
    }
    timer = setTimeout(loop, 13000);
  };
  ws.onclose = () => {
    if (session === mine) {
      mine.dead = true;
      if (!mine.opened) mine.failed = true;
      clearTimeout(timer);
    }
  };
  ws.onerror = () => {
    mine.dead = true;
    if (!mine.opened) mine.failed = true;
  };
}

function alive(login) {
  return session && !session.dead && session.ws.readyState <= WebSocket.OPEN && session.login === login;
}

export async function kickTick() {
  // Изменение настроек посреди тика не теряется: после него сразу идёт ещё один проход.
  if (ticking) {
    again = true;
    return readKick();
  }
  ticking = true;
  let done;
  running = new Promise((resolve) => {
    done = resolve;
  });
  try {
    return await run();
  } catch (error) {
    const state = await readKick();
    const text = error?.message || String(error);
    const expired = /HTTP 401/.test(text);
    if (expired) {
      stopWatch();
      await closeKickTab();
    } else if (state.enabled && state.watching?.login) {
      // 403/WAF или сеть: пока API молчит, вкладка продолжает набирать время.
      await ensureKickTab(state.watching.login).catch(() => {});
    }
    return save({
      ...state,
      phase: expired ? "need-login" : "error",
      message: expired ? mark("kickNeedLogin") : text,
      watching: expired ? null : state.watching,
      log: push(state, text.slice(0, 120)),
    });
  } finally {
    ticking = false;
    done();
    if (again) {
      again = false;
      kickTick();
    }
  }
}

async function run() {
  const state = await readKick();
  if (!state.enabled) {
    stopWatch();
    await closeKickTab();
    return save({ ...state, phase: "idle", message: "", watching: null });
  }
  const candidates = await readToken();
  if (!candidates.length) {
    stopWatch();
    await closeKickTab();
    return save({ ...state, phase: "need-login", message: mark("kickNeedLogin"), user: "", watching: null, queue: [] });
  }
  const failedBefore = Boolean(session?.failed);
  const { token, viewer } = await workingToken(candidates);
  const user = state.user || await userName(token);

  const [campaigns, progress] = await Promise.all([
    getJson(`${WEB}/drops/campaigns`, token),
    getJson(`${WEB}/drops/progress`, token).catch(() => ({ data: [] })),
  ]);
  const settings = await readSettings();
  const everything = mergeQueue(campaigns?.data, progress?.data);
  const picked = await pickedGames(settings);
  const games = gameList(everything);
  // Без автомайнинга берём только выбранные игры; с ним всё, кроме чёрного списка.
  const rows = settings.autoAll
    ? everything.filter((row) => !isBlocked(settings, row.game))
    : everything.filter((row) => picked.has(row.game.toLowerCase()));

  let log = state.log;
  for (const row of everything.filter((item) => item.progress >= 1 && !item.claimed)) {
    if (await claim(token, row.campaignId, row.id).catch(() => false)) {
      row.claimed = true;
      log = push({ log }, mark("kickClaimed", { name: row.name }));
    }
  }

  // Обычные дропы: верх списка эфиров категории. Эксклюзивные: карточки их каналов напрямую,
  // потому что список категории у Kick неполный (serpias стримил Minecraft, но в список не попал).
  const maps = new Map();
  const general = new Set(rows.filter((row) => !row.claimed && !row.channels.length).map((row) => row.categoryId));
  for (const categoryId of general) {
    maps.set(categoryId, await liveMap(categoryId).catch(() => new Map()));
  }
  const exclusive = rows.filter((row) => row.linked && !row.claimed && row.progress < 1 && row.channels.length);
  const cards = await channelCards([...new Set(exclusive.flatMap((row) => row.channels))]);
  for (const row of exclusive) {
    const map = maps.get(row.categoryId) || new Map();
    for (const slug of row.channels) {
      const card = cards.get(slug);
      if (card?.live && (!card.categories.length || card.categories.includes(row.categoryId))) {
        map.set(slug, { channelId: card.channelId, livestreamId: card.livestreamId, login: slug, viewers: card.viewers });
      }
    }
    maps.set(row.categoryId, map);
  }
  for (const row of rows) {
    const live = maps.get(row.categoryId);
    row.live = live ? row.channels.filter((slug) => live.has(slug)) : [];
    // Больше зрителей раньше: такой эфир реже внезапно заканчивается.
    row.live.sort((left, right) => (live.get(right).viewers || 0) - (live.get(left).viewers || 0));
  }
  const open = order(rows, picked);
  // Выбор пользователя: клик по дропу в попапе. Держится, пока дроп можно набирать; иначе идёт обычная очередь.
  const preferId = (await readKick()).preferDropId || "";
  const preferRow = preferId ? open.find((row) => row.id === preferId) : null;
  const preferLive = preferRow && !(state.watching?.dropId === preferRow.id && alive(state.watching.login))
    ? await firstVerified(preferRow, maps)
    : null;
  const current = state.watching && open.find((row) => row.id === state.watching.dropId);
  let watching = null;
  const keep = (row) => ({
    ...state.watching,
    current: row.current,
    required: row.required,
    image: row.image,
    campaignImage: row.campaignImage,
  });
  const begin = async (row, live) => {
    startWatch(viewer, live);
    log = push({ log }, mark("kickWatching", { login: live.login }));
    return {
      dropId: row.id,
      name: row.name,
      game: row.game,
      login: live.login,
      current: row.current,
      required: row.required,
      exclusive: row.channels.length > 0,
      image: row.image,
      campaignImage: row.campaignImage,
    };
  };
  // Текущий канал перепроверяем каждый проход: стример мог сменить игру, а сокет при этом жив.
  let skip = "";
  // Сторож тишины: ошибок нет, а минуты на сервере не растут (так было с UUID вместо id и с каналом,
  // ушедшим в другую игру). 8 минут без роста: меняем канал. Опять стоит: подключаем вкладку с плеером.
  let stall = state.stall || null;
  let stalled = false;
  if (state.watching) {
    const row = rows.find((item) => item.id === state.watching.dropId);
    const units = row ? row.current : null;
    if (!stall || stall.dropId !== state.watching.dropId || (units != null && units > stall.units)) {
      stall = { dropId: state.watching.dropId, units: units ?? 0, since: Date.now(), strikes: 0 };
    } else if (Date.now() - stall.since >= STALL_MS) {
      stalled = true;
      stall = { ...stall, since: Date.now(), strikes: (stall.strikes || 0) + 1 };
      log = push({ log }, mark("kickStalled", { login: state.watching.login, n: Math.round(STALL_MS / 60000) }));
    }
  }
  const stillHere = async (row) => {
    if (!alive(state.watching?.login)) return false;
    if (stalled && (stall.strikes || 0) < 2) {
      skip = state.watching.login;
      stopWatch();
      return false;
    }
    const card = await channelCard(state.watching.login);
    const ok = !card || (card.live && (!card.categories.length || card.categories.includes(row.categoryId)));
    if (!ok) {
      skip = state.watching.login;
      log = push({ log }, mark("kickLeftCategory", { login: state.watching.login, game: row.game }));
      stopWatch();
    }
    return ok;
  };
  if (preferRow && state.watching?.dropId === preferRow.id && await stillHere(preferRow)) {
    watching = keep(preferRow);
  } else if (preferRow && preferLive) {
    watching = await begin(preferRow, preferLive);
  } else if (current && !preferRow && await stillHere(current)) {
    watching = keep(current);
  } else if (open.length) {
    const target = await pickTarget(rows, picked, maps, skip);
    if (target) watching = await begin(target.row, target.live);
    else stopWatch();
  } else {
    stopWatch();
  }
  // Дроп, который выбрали, набран или забран: выбор снимаем.
  const keepPrefer = preferRow ? preferId : "";

  if (!watching) {
    await closeKickTab();
  } else if (session?.opened && !session.dead) {
    await closeKickTab();
  } else if (failedBefore || session?.failed) {
    await ensureKickTab(watching.login).catch(() => {});
    watching = { ...watching, via: "tab" };
  }
  // Сменили канал, а минуты всё равно стоят: смотрим настоящим плеером во вкладке, пока не пойдут.
  if (watching && stall && stall.dropId === watching.dropId && (stall.strikes || 0) >= 2) {
    await ensureKickTab(watching.login).catch(() => {});
    watching = { ...watching, via: "tab" };
  } else if (watching && stall && (stall.strikes || 0) === 0 && session?.opened && !session.dead) {
    await closeKickTab();
  }
  if (!(await readKick()).enabled) {
    stopWatch();
    await closeKickTab();
    return save({ ...state, phase: "idle", message: "", watching: null });
  }
  const unlinked = rows.find((row) => !row.linked && !row.claimed);
  let phase = "all-claimed";
  let message = mark("kickAllDone");
  if (watching) {
    phase = "watching";
    message = "";
  } else if (!settings.autoAll && !picked.size) {
    phase = "pick-game";
    message = mark("kickPick");
  } else if (open.length) {
    phase = "no-channel";
    message = mark("kickNoLive");
  } else if (unlinked) {
    phase = "not-linked";
    message = mark("kickNotLinked", { name: unlinked.game });
  }
  return save({
    ...state, phase, message, user, watching, games, queue: rows, log, preferDropId: keepPrefer,
    // Отсчёт тишины начинается с первого прохода, где дроп смотрится.
    stall: !watching ? null
      : stall && stall.dropId === watching.dropId ? stall
        : { dropId: watching.dropId, units: watching.current || 0, since: Date.now(), strikes: 0 },
    linkUrl: unlinked?.connectUrl || `${SITE}/drops/campaigns`,
  });
}

// Клик по дропу Kick в попапе: фармить именно его, как выбор дропа у Twitch.
export async function watchKickDrop(id) {
  const state = await readKick();
  stopWatch();
  const row = (state.queue || []).find((item) => item.id === String(id));
  // Карточка сверху переключается сразу, а не после следующего прохода.
  const watching = row && row.linked && !row.claimed
    ? {
      dropId: row.id,
      name: row.name,
      game: row.game,
      login: row.channels.length ? (row.live || [])[0] || "" : state.watching?.login || "",
      current: row.current,
      required: row.required,
      exclusive: row.channels.length > 0,
      image: row.image,
      campaignImage: row.campaignImage,
    }
    : state.watching;
  const next = await save({ ...state, preferDropId: String(id || ""), watching });
  kickTick();
  return next;
}

export async function setKickEnabled(enabled) {
  const state = await readKick();
  if (!enabled) stopWatch();
  const next = await save({ ...state, enabled }, { force: true });
  kickTick();
  return next;
}
