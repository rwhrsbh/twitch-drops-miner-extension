import {
  CONNECT_URL,
  GQL_URL,
  INVENTORY_URL,
  VALIDATE_URL,
  WEB_CLIENT_ID,
  qAvailableDrops,
  qCampaignDetails,
  qCampaigns,
  qChannelPoints,
  qClaimDrop,
  qClaimPoints,
  qCurrentDrop,
  qGameDirectory,
  qGetStreamInfo,
  qInventory,
  qPlaybackToken,
  qSearchChannels,
  qRewardCampaign,
  qRewardCampaigns,
  qRewardOptions,
  qSelectRewardOption,
  gqlHashes,
} from "./constants.js";
import { loadHashes, noteDeadHash } from "./remote.js";

const SPADE_PATTERN = /"spade_?url":\s*"(https:\/\/[^"]+)"/i;
const SETTINGS_PATTERN = /src="(https:\/\/[^"']+\/config\/settings\.[0-9a-f]{32}\.js)"/i;

function randomId(length) {
  const alphabet = "0123456789abcdef";
  let value = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value;
}

async function cookie(name) {
  const found = await chrome.cookies.get({ url: "https://www.twitch.tv/", name });
  return found?.value || "";
}

async function deviceId() {
  const existing = await cookie("unique_id");
  if (existing) return existing;
  const stored = await chrome.storage.local.get("deviceId");
  if (stored.deviceId) return stored.deviceId;
  const created = randomId(32);
  await chrome.storage.local.set({ deviceId: created });
  return created;
}

export async function readAuth() {
  const token = await cookie("auth-token");
  if (!token) return null;
  const response = await fetch(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!response.ok) return null;
  const body = await response.json();
  if (!body?.user_id || !body?.login) return null;
  return {
    token,
    login: body.login,
    userId: String(body.user_id),
    clientId: body.client_id || WEB_CLIENT_ID,
    expiresIn: Number(body.expires_in) || 0,
    deviceId: await deviceId(),
  };
}

// Аккаунт, под которым браузер не залогинен (lib/side.js): работает только по токену.
// plain: integrity-заголовки из вкладки привязаны к аккаунту браузера, сюда их подставлять нельзя.
export async function authFromToken(token, device) {
  if (!token) return null;
  const response = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const body = await response.json();
  if (!body?.user_id || !body?.login) return null;
  return {
    token,
    login: body.login,
    userId: String(body.user_id),
    clientId: body.client_id || WEB_CLIENT_ID,
    expiresIn: Number(body.expires_in) || 0,
    deviceId: device || (await deviceId()),
    plain: true,
  };
}

function gqlHeaders(auth) {
  return {
    Accept: "*/*",
    Authorization: `OAuth ${auth.token}`,
    "Client-Id": auth.clientId || WEB_CLIENT_ID,
    "Content-Type": "application/json",
    "X-Device-Id": auth.deviceId,
  };
}


function waitUntilComplete(tabId) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, 15000);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(finish);
  });
}


function parseGqlBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GQL вернул не JSON: ${text.slice(0, 180)}`);
  }
  if (Array.isArray(body)) body = body[0];
  if (body?.error) {
    throw new Error(`${body.error}: ${body.message || ""}`.trim());
  }
  const errors = body?.errors;
  if (errors?.length && !body?.data) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  return body;
}

function looksLikeIntegrityBlock(text) {
  return /client-integrity|integrity check|failed integrity|kasada/i.test(text);
}

function gqlFailure(operation, text) {
  try {
    const body = JSON.parse(text);
    const message = body?.errors?.[0]?.message || body?.message || body?.error;
    if (message) return `GQL ${operation}: ${message}`;
  } catch {
    // Тело не JSON.
  }
  if (/failed to fetch|network|timeout|aborted/i.test(text)) {
    return `GQL ${operation}: Twitch не ответил, повтор через минуту`;
  }
  return `GQL ${operation}: ${String(text || "").slice(0, 160)}`;
}

let capturedHeaders = null;

function applyCaptured(headers, captured) {
  if (!captured) return headers;
  if (captured["client-integrity"]) headers["Client-Integrity"] = captured["client-integrity"];
  if (captured["client-session-id"]) headers["Client-Session-Id"] = captured["client-session-id"];
  if (captured["client-version"]) headers["Client-Version"] = captured["client-version"];
  if (captured["x-device-id"]) headers["X-Device-Id"] = captured["x-device-id"];
  return headers;
}

// Зависшая вкладка Twitch не отвечает на executeScript вообще, и без таймаута весь майнер ждал бы её вечно.
function withDeadline(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: вкладка не ответила за ${ms / 1000} с`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function readCapturedHeaders(tabId) {
  const [injected] = await withDeadline(chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => window.__dropsMinerHeaders || null,
  }), 4000, "executeScript");
  return injected?.result || null;
}

async function helperTabId() {
  const stored = await chrome.storage.session.get("helperTabId");
  return stored.helperTabId || 0;
}

async function closeHelperTab() {
  const tabId = await helperTabId();
  if (!tabId) return;
  await chrome.storage.session.remove("helperTabId");
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Вкладку уже закрыли.
  }
}

// Под каким аккаунтом Twitch загружена каждая вкладка. Автосмена аккаунта (lib/accounts.js) вкладки
// пользователя не перезагружает: страница живёт сессией прежнего аккаунта, и её integrity чужой.
// Каждая вкладка — свой ключ: общий объект с read-modify-write терял записи, когда вкладки грузятся разом.
const TAB_KEY = "tabAcc:";
// Вкладка начала грузиться посреди подмены кук: под кем она — неизвестно, integrity из неё не берём.
export const UNKNOWN_TAB = "?";
// Метку ставит lib/accounts.js на время подмены кук Twitch.
const SWITCHING = "accountSwitching";

async function activeTwitchId() {
  const { accounts } = await chrome.storage.local.get("accounts");
  return String(accounts?.twitch?.active || "");
}

export async function noteTabLoad(tabId, url) {
  if (!tabId || !/^https:\/\/(www\.)?twitch\.tv\//.test(String(url || ""))) return;
  const { [SWITCHING]: switching } = await chrome.storage.session.get(SWITCHING);
  // Метка смены старше минуты — осталась от оборванного воркера, на неё не смотрим.
  const busy = switching && Date.now() - switching < 60 * 1000;
  await chrome.storage.session.set({ [TAB_KEY + tabId]: busy ? UNKNOWN_TAB : await activeTwitchId() });
}

export async function forgetTab(tabId) {
  await chrome.storage.session.remove(TAB_KEY + tabId);
}

// Вкладку заменили (предзагрузка страницы): новая живёт той же сессией, что старая.
export async function replaceTab(addedId, removedId) {
  const key = TAB_KEY + removedId;
  const { [key]: value } = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  if (value) await chrome.storage.session.set({ [TAB_KEY + addedId]: value });
}

// Под каким аккаунтом загружены вкладки: { tabId: accountId | "?" }. Неизвестных в ответе нет.
export async function tabAccounts(ids) {
  if (!ids.length) return {};
  const stored = await chrome.storage.session.get(ids.map((id) => TAB_KEY + id));
  return Object.fromEntries(ids.filter((id) => stored[TAB_KEY + id]).map((id) => [id, stored[TAB_KEY + id]]));
}

// После возврата домой: вкладки, загруженные под другим аккаунтом (их открыли, пока браузер был уведён),
// перезагружаются, чтобы пользователь не действовал от чужого имени. Вкладки своего аккаунта не трогаем.
export async function reloadForeignTabs(activeId) {
  const own = await helperTabId();
  const tabs = await chrome.tabs.query({ url: ["https://www.twitch.tv/*", "https://twitch.tv/*"] });
  const loadedAs = await tabAccounts(tabs.map((tab) => tab.id).filter(Boolean));
  const foreign = tabs.filter((tab) => tab.id && tab.id !== own && loadedAs[tab.id] && loadedAs[tab.id] !== String(activeId));
  await Promise.all(foreign.map((tab) => chrome.tabs.reload(tab.id).catch(() => null)));
  return foreign.length;
}

async function userTwitchTab() {
  const own = await helperTabId();
  const tabs = await chrome.tabs.query({ url: ["https://www.twitch.tv/*", "https://twitch.tv/*"] });
  const loadedAs = await tabAccounts(tabs.map((tab) => tab.id).filter(Boolean));
  const { accounts } = await chrome.storage.local.get("accounts");
  const active = String(accounts?.twitch?.active || "");
  // Браузер уведён расширением на другой аккаунт: вкладка, о которой ничего не известно (например,
  // после обновления расширения учёт пуст), скорее всего прежнего аккаунта — её не берём.
  const away = accounts?.twitch?.back?.reason === "auto";
  const mine = (tab) => {
    const as = loadedAs[tab.id];
    if (!as) return !away;
    return as !== UNKNOWN_TAB && (!active || as === active);
  };
  const usable = tabs.filter((tab) => tab.id && tab.id !== own && !tab.discarded && tab.status === "complete"
    && !tab.url?.includes("/login") && mine(tab));
  return usable.find((tab) => tab.url?.includes("/drops")) || usable[0] || null;
}

let helperChain = Promise.resolve();

// Временная вкладка Twitch: открывается без фокуса и со звуком выключенным, закрывается сразу после работы.
// Вызовы идут по очереди, чтобы один не закрыл вкладку, которую ещё читает другой.
function withHelperTab(work) {
  const run = helperChain.then(() => useHelperTab(work));
  helperChain = run.catch(() => {});
  return run;
}

async function useHelperTab(work) {
  await closeHelperTab();
  const tab = await chrome.tabs.create({ url: INVENTORY_URL, active: false, pinned: true });
  await chrome.storage.session.set({ helperTabId: tab.id });
  try {
    await chrome.tabs.update(tab.id, { muted: true });
    await waitUntilComplete(tab.id);
    return await work(tab.id);
  } finally {
    await closeHelperTab();
  }
}

async function pollIntegrity(tabId, previous, tries) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    let headers = null;
    try {
      headers = await readCapturedHeaders(tabId);
    } catch {
      headers = null;
    }
    const token = headers?.["client-integrity"];
    if (token && token !== previous) return headers;
    if (attempt + 1 < tries) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

// Поколение сессии: растёт при каждом resetSession (смена аккаунта). Захват, начатый до смены,
// иначе сохранил бы заголовки прежнего аккаунта уже для нового.
let sessionGen = 0;

async function storeCaptured(headers, gen = sessionGen) {
  if (gen !== sessionGen) return;
  headers = { ...headers, capturedAt: headers.capturedAt || Date.now() };
  capturedHeaders = headers;
  await chrome.storage.session.set({ capturedHeaders: headers });
}

const USER_TAB_RETRY = 60000;
let userTabMissAt = 0;

async function cachedHeaders() {
  if (capturedHeaders?.["client-integrity"]) return capturedHeaders;
  const stored = await chrome.storage.session.get("capturedHeaders");
  if (stored.capturedHeaders?.["client-integrity"]) {
    capturedHeaders = stored.capturedHeaders;
    return capturedHeaders;
  }
  if (Date.now() - userTabMissAt < USER_TAB_RETRY) return null;
  const gen = sessionGen;
  const tab = await userTwitchTab();
  const headers = tab ? await pollIntegrity(tab.id, "", 1) : null;
  if (gen !== sessionGen) return null;
  if (headers) await storeCaptured(headers, gen);
  else userTabMissAt = Date.now();
  return headers;
}

async function dropCaptured() {
  capturedHeaders = null;
  await chrome.storage.session.remove("capturedHeaders");
}

const INTEGRITY_RELOAD_GAP = 45000;
let integrityReloadAt = 0;
let integrityReload = null;

function readFreshIntegrity(previous) {
  if (integrityReload) return integrityReload;
  if (Date.now() - integrityReloadAt < INTEGRITY_RELOAD_GAP) {
    const current = capturedHeaders?.["client-integrity"];
    return Promise.resolve(current && current !== previous ? capturedHeaders : null);
  }
  integrityReloadAt = Date.now();
  integrityReload = fetchFreshIntegrity(previous).finally(() => {
    integrityReload = null;
  });
  return integrityReload;
}

async function noteIntegrity(event) {
  const { integrityEvents = [] } = await chrome.storage.local.get("integrityEvents");
  await chrome.storage.local.set({ integrityEvents: [event, ...integrityEvents].slice(0, 30) });
}

async function fetchFreshIntegrity(previous) {
  const old = capturedHeaders;
  const gen = sessionGen;
  await dropCaptured();
  const headers = await withHelperTab((tabId) => pollIntegrity(tabId, previous, 30));
  if (gen !== sessionGen) return null;
  if (headers) await storeCaptured(headers, gen);
  await noteIntegrity({
    at: Date.now(),
    reason: previous ? "rejected" : "missing",
    oldAgeMin: old?.capturedAt ? Math.round((Date.now() - old.capturedAt) / 60000) : null,
    oldExpiration: Number(old?.["integrity-expiration"]) || null,
    newExpiration: Number(headers?.["integrity-expiration"]) || null,
    ok: Boolean(headers),
  });
  return headers;
}



async function gqlOnce(auth, payload, captured) {
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: applyCaptured(gqlHeaders(auth), captured),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  return { status: response.status, text };
}


function gqlOk(result) {
  return result && result.status >= 200 && result.status < 300 && !looksLikeIntegrityBlock(result.text);
}

async function gqlTry(auth, payload) {
  let lastError = null;
  const cached = auth.plain ? null : await cachedHeaders().catch(() => null);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await gqlOnce(auth, payload, attempt === 0 ? cached : null);
      if (result.status !== 0) return result;
      lastError = new Error(result.text || "пустой ответ");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
  }
  throw lastError || new Error("Failed to fetch");
}

// Хэш в готовом запросе мог устареть: фоновый скрипт только что проснулся и ещё не загрузил
// сохранённые хэши, или хэш починили, пока запрос ждал своей очереди.
async function stamp(payload) {
  await loadHashes();
  const hash = gqlHashes()[payload?.operationName];
  const query = payload?.extensions?.persistedQuery;
  if (hash && query) query.sha256Hash = hash;
}

async function runGql(auth, payload, name) {
  let result;
  try {
    result = await gqlTry(auth, payload);
  } catch (error) {
    throw new Error(gqlFailure(name, error?.message || String(error)));
  }
  // Twitch сменил хэш запроса: рабочий найдётся сам (lib/remote.js), следующий проход пойдёт уже с ним.
  if (/PersistedQueryNotFound/.test(result.text || "")) noteDeadHash();
  if (gqlOk(result)) return parseGqlBody(result.text);
  if (!looksLikeIntegrityBlock(result.text)) {
    throw new Error(gqlFailure(name, result.text));
  }
  if (auth.plain) throw new Error(`integrity: ${name}`);
  const captured = await readFreshIntegrity(capturedHeaders?.["client-integrity"] || "");
  if (!captured?.["client-integrity"]) {
    throw new Error(gqlFailure(name, result.text));
  }
  try {
    result = await gqlOnce(auth, payload, captured);
  } catch (error) {
    throw new Error(gqlFailure(name, error?.message || String(error)));
  }
  if (!gqlOk(result)) {
    await dropCaptured();
    throw new Error(gqlFailure(name, result.text));
  }
  return parseGqlBody(result.text);
}

export async function gql(auth, payload) {
  await stamp(payload);
  return runGql(auth, payload, payload.operationName);
}

// Сырой запрос: у новых полей Twitch нет persisted-хэша, но текст запроса он принимает как есть.
export async function gqlRaw(auth, payload) {
  // Имя операции берём из текста запроса: иначе в ошибке стояло бы безликое «raw».
  const name = payload.operationName || /^\s*(?:query|mutation)\s+(\w+)/.exec(payload.query || "")?.[1] || "raw";
  return runGql(auth, payload, name);
}

async function gqlPlain(auth, payload) {
  await stamp(payload);
  const result = await gqlOnce(auth, payload, null);
  if (!gqlOk(result)) throw new Error(gqlFailure(payload.operationName, result.text));
  return parseGqlBody(result.text);
}

// Смена аккаунта: integrity-заголовки и Spade привязаны к прежней сессии.
export async function resetSession() {
  sessionGen += 1;
  await dropCaptured();
  userTabMissAt = 0;
  integrityReloadAt = 0;
}

// Баллы канала: баланс и бонус, который можно забрать прямо сейчас (появляется, пока смотришь эфир).
export async function channelPoints(auth, login) {
  const body = await gqlPlain(auth, qChannelPoints(login));
  const channel = body?.data?.community?.channel;
  const mine = channel?.self?.communityPoints;
  if (!mine) return null;
  return {
    channelId: String(body.data.community.id || ""),
    enabled: channel.communityPointsSettings?.isEnabled !== false,
    balance: Number(mine.balance) || 0,
    claimId: mine.availableClaim?.id || "",
  };
}

export async function claimPoints(auth, channelId, claimId) {
  const body = await gql(auth, qClaimPoints(channelId, claimId));
  const result = body?.data?.claimCommunityPoints;
  if (result?.error) throw new Error(result.error.code || "claim rejected");
  return {
    balance: Number(result?.currentPoints) || 0,
    gained: Number(result?.claim?.pointsEarnedTotal) || 0,
  };
}

export async function searchChannels(auth, query) {
  const body = await gqlPlain(auth, qSearchChannels(query));
  const edges = body?.data?.searchFor?.channels?.edges || [];
  return edges.map((edge) => edge?.item).filter((item) => item?.login).slice(0, 12).map((item) => ({
    id: String(item.id || ""),
    login: item.login,
    name: item.displayName || item.login,
    image: item.profileImageURL || "",
    live: Boolean(item.stream?.id),
    followers: Number(item.followers?.totalCount) || 0,
  }));
}

export async function getStream(auth, login) {
  const body = await gqlPlain(auth, qGetStreamInfo(login));
  const user = body?.data?.user;
  if (!user?.stream) return null;
  const game = user.broadcastSettings?.game || null;
  return {
    login: user.login || login,
    channelId: String(user.id),
    broadcastId: String(user.stream.id),
    viewers: user.stream.viewersCount || 0,
    title: user.broadcastSettings?.title || "",
    game: game
      ? {
          id: String(game.id || ""),
          name: game.displayName || game.name || "",
        }
      : null,
  };
}

function benefitNames(drop) {
  return (drop.benefitEdges || [])
    .map((edge) => edge?.benefit?.name)
    .filter(Boolean);
}

function firstUrl(values) {
  return values.find((value) => typeof value === "string" && /^https?:\/\//.test(value)) || "";
}

function benefitImage(drop) {
  return firstUrl((drop.benefitEdges || []).flatMap((edge) => {
    const benefit = edge?.benefit || {};
    return [benefit.imageAssetURL, benefit.imageURL, benefit.defaultImage?.url, edge?.imageAssetURL];
  }));
}

function mapDrop(campaign, drop) {
  const self = drop.self || {};
  return {
    id: drop.id,
    name: drop.name || benefitNames(drop)[0] || "Drop",
    image: benefitImage(drop),
    campaignImage: campaign.image || "",
    benefits: benefitNames(drop),
    benefitIds: (drop.benefitEdges || []).map((edge) => edge?.benefit?.id).filter(Boolean),
    required: Number(drop.requiredMinutesWatched) || 0,
    current: self.isClaimed
      ? Number(drop.requiredMinutesWatched) || 0
      : Number(self.currentMinutesWatched) || 0,
    claimed: Boolean(self.isClaimed),
    claimId: self.dropInstanceID || "",
    preconditionIds: (drop.preconditionDrops || []).map((item) => item.id).filter(Boolean),
    // У дропа своё окно времени внутри кампании: вне его минуты не засчитываются.
    subs: Number(drop.requiredSubs) || 0,
    startsAt: Date.parse(drop.startAt) || 0,
    endsAt: Date.parse(drop.endAt) || 0,
    campaignId: campaign.id,
    campaignName: campaign.name,
    game: campaign.game,
    channels: campaign.channels,
    linked: campaign.linked,
    linkUrl: campaign.linkUrl,
    // Значок чата Twitch выдаёт сам, как только минуты набраны: кнопки «Забрать» у него нет,
    // а isClaimed в деталях кампании остаётся false. Такой дроп отмечает майнер (lib/miner.js).
    badge: badgeOnly([drop]),
  };
}

// Twitch отдаёт isAccountConnected: false у кампаний, которым привязка не нужна вообще:
// у них accountLinkURL — сама twitch.tv, а награда — значок чата (distributionType BADGE).
// Так приходят «Jordan x Space Jam», значки Payday 3 и OSRS. Без этого правила майнер
// считал их непривязанными и не фармил (lib/miner.js: все !campaign.linked пропускаются).
function selfServedLink(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)twitch\.tv$/i.test(parsed.hostname) && (parsed.pathname === "/" || parsed.pathname === "");
  } catch {
    return false;
  }
}

function badgeOnly(drops) {
  const types = (drops || []).flatMap((drop) => (drop.benefitEdges || [])
    .map((edge) => edge?.benefit?.distributionType)
    .filter(Boolean));
  return types.length > 0 && types.every((type) => type === "BADGE");
}

function mapCampaign(raw) {
  const allowed = raw.allow || {};
  const channels = (allowed.channels || []).map((channel) => ({
    id: String(channel.id || ""),
    login: channel.name || channel.login || "",
  })).filter((channel) => channel.login);
  const game = raw.game || {};
  const drops = raw.timeBasedDrops || [];
  // Значок чата приходит на сам Twitch-аккаунт: привязка к внешнему сервису не нужна,
  // даже если Twitch пишет isAccountConnected: false.
  const linked = Boolean(raw.self?.isAccountConnected)
    || (selfServedLink(raw.accountLinkURL) && badgeOnly(drops));
  return {
    id: raw.id,
    name: raw.name || "",
    status: raw.status || "",
    linked,
    // Ссылка привязки — сам twitch.tv: в сводке ViewerDropsDashboard дропов нет, и значковая
    // кампания выглядит непривязанной. По этому флагу майнер всё равно загрузит её детали.
    selfLink: selfServedLink(raw.accountLinkURL),
    linkUrl: raw.accountLinkURL || CONNECT_URL,
    startsAt: Date.parse(raw.startAt) || 0,
    endsAt: Date.parse(raw.endAt) || 0,
    image: firstUrl([raw.imageURL, raw.image?.url]),
    game: {
      id: String(game.id || ""),
      name: game.displayName || game.name || "",
      slug: game.slug || "",
      image: firstUrl([game.boxArtURL, game.avatarURL])
        || (game.id ? `https://static-cdn.jtvnw.net/ttv-boxart/${game.id}-144x192.jpg` : ""),
    },
    channels: allowed.isEnabled === false ? [] : channels,
    drops,
  };
}

// Reward-кампания: вместо timeBasedDrops — группы наград, у каждой своё условие и свой прогресс.
// Категория трансляции (GTA VI) лежит в progressCriteria.categories, а campaign.game — служебная
// «Special Events», по ней канал не найти.
function rewardCategories(raw) {
  const groups = raw?.rewardGroups || [];
  const seen = new Set();
  const games = [];
  for (const category of groups.flatMap((group) => group?.progressCriteria?.categories || [])) {
    if (!category?.id || seen.has(String(category.id))) continue;
    seen.add(String(category.id));
    const name = category.displayName || "";
    games.push({
      id: String(category.id),
      name,
      slug: gameSlug({ name }),
      image: `https://static-cdn.jtvnw.net/ttv-boxart/${category.id}-144x192.jpg`,
    });
  }
  return games;
}

function mapRewardGroup(campaign, group) {
  const criteria = group?.progressCriteria || {};
  if (criteria.requirementType !== "WATCH") return null;
  const required = Number(criteria.requirements?.minutesWatched) || 0;
  if (required <= 0) return null;
  const self = group.self || {};
  const status = self.status || "";
  const repeatable = Boolean(criteria.isRepeatable);
  const repeatableTimes = repeatable ? Math.max(1, Number(criteria.repeatableConfig?.repeatableTimes) || 1) : 1;
  const grantCount = Number(self.grantCount) || 0;
  const reward = (group.rewards || [])[0] || {};
  const nextAt = Date.parse(self.nextEligibleAt) || 0;
  const windowEnd = Date.parse(self.currentWindow?.expiresAt) || 0;
  // Сундук повторяемый: забранный сегодня — ещё не закрыт, пока не кончились дни.
  // Одиночный (isRepeatable=false) закрыт после первой же выдачи, даже если grantCount ещё 0.
  // Повторяемый сундук GTA: минуты набраны, награда за это окно выдана (grantCount > 0), а статус
  // остаётся IN_PROGRESS и счётчик стоит на норме. До конца окна он закрыт, потом вернётся сам.
  const windowDone = repeatable && status === "IN_PROGRESS" && grantCount >= 1
    && windowEnd > Date.now() && (Number(self.currentMinutesWatched) || 0) >= required;
  const done = windowDone || (status === "CLAIMED" && (!repeatable || grantCount >= repeatableTimes));
  const ready = status === "CLAIMABLE";
  return {
    id: group.id,
    kind: "reward",
    // Значок чата Twitch выдаёт сам, статус группы CLAIMABLE не наступает (Pokemon Evolutions).
    // POOL (Pokemon Night Out Poke Ball) тоже не доходит до CLAIMABLE; но пока Twitch
    // предлагает забрать (CLAIMABLE, сундук GTA), остаётся обычный путь claimReward.
    // Лишняя минута сверх нормы: Twitch успевает перевести настоящий сундук в CLAIMABLE.
    badge: (reward.distributionType === "BADGE"
      || (reward.distributionType === "POOL" && status !== "CLAIMABLE"))
      && (Number(self.currentMinutesWatched) || 0) >= required + 1,
    name: reward.name || "Drop",
    image: reward.thumbnailURL || "",
    campaignImage: campaign.image || "",
    benefits: reward.name ? [reward.name] : [],
    benefitIds: [],
    required,
    current: ready ? required : Number(self.currentMinutesWatched) || 0,
    claimed: done,
    claimId: "",
    preconditionIds: [],
    subs: 0,
    // Следующий сундук откроется только после сброса окна: до него минуты не идут.
    startsAt: !done && nextAt > Date.now() ? nextAt : 0,
    endsAt: 0,
    campaignId: campaign.id,
    campaignName: campaign.name,
    game: campaign.game,
    // У одной кампании бывает несколько категорий (покемоны): годится любой из них.
    games: campaign.games?.length ? campaign.games : [campaign.game],
    channels: [],
    linked: true,
    status,
    grantCount,
    repeatableTimes,
    windowEndsAt: windowEnd,
  };
}

function mapRewardCampaign(summary, raw) {
  const campaign = {
    id: raw?.id || summary.id,
    name: raw?.name || summary.name || "",
    image: (raw?.rewards || [])[0]?.thumbnailURL || (summary.rewards || [])[0]?.thumbnailURL || "",
  };
  const games = rewardCategories(raw);
  const game = games[0];
  if (!game) return null;
  campaign.game = game;
  campaign.games = games;
  const drops = (raw?.rewardGroups || []).map((group) => mapRewardGroup(campaign, group)).filter(Boolean);
  if (!drops.length) return null;
  return {
    id: campaign.id,
    kind: "reward",
    name: campaign.name,
    status: raw?.status || summary.status || "",
    linked: true,
    linkUrl: summary.externalURL || CONNECT_URL,
    startsAt: Date.parse(raw?.startAt) || Date.parse(summary.startsAt) || 0,
    endsAt: Date.parse(raw?.endAt) || Date.parse(summary.endsAt) || 0,
    image: drops.find((drop) => drop.image)?.image || campaign.image || "",
    game,
    games,
    channels: [],
    drops,
  };
}

export function gameSlug(game) {
  if (game?.slug) return String(game.slug);
  return String(game?.name || "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export async function listCampaigns(auth) {
  const dashboard = await gql(auth, qCampaigns());
  const regular = (dashboard?.data?.currentUser?.dropCampaigns || [])
    .map(mapCampaign)
    .filter((campaign) => campaign.status !== "EXPIRED" && campaign.game?.id);
  return [...regular, ...await rewardCampaigns(auth)];
}

// Reward-кампании лежат отдельным корневым полем, детали — по каждой. Отказ (например, у аккаунта
// без браузера нет integrity-токена) не должен ронять весь проход: просто остаёмся без них.
async function rewardCampaigns(auth) {
  let listed = [];
  try {
    const body = await gqlRaw(auth, qRewardCampaigns());
    listed = body?.data?.rewardCampaignsAvailableToUser || [];
  } catch {
    return [];
  }
  const detailed = [];
  const now = Date.now();
  for (const summary of listed) {
    if (!summary?.id) continue;
    // Список приходит шире страницы: там лежат и уже закрытые по датам кампании.
    const starts = Date.parse(summary.startsAt) || 0;
    const ends = Date.parse(summary.endsAt) || 0;
    if (starts && now < starts) continue;
    if (ends && now >= ends) continue;
    try {
      const body = await gqlRaw(auth, qRewardCampaign(summary.id));
      const campaign = mapRewardCampaign(summary, body?.data?.dropsCampaign);
      if (campaign) detailed.push(campaign);
    } catch {
      // одна кампания не должна стоить остальных
    }
  }
  return detailed;
}

// Свой прогресс по сундукам и значкам reward-кампаний для аккаунта без браузера (lib/side.js).
// В инвентаре Twitch их нет, их отдаёт отдельный запрос. Если Twitch без integrity его отклонит,
// строки остаются с unknown: true: прогресса нет, клеймить нечего, чужие данные не подставляются.
export async function applyRewardProgress(auth, campaigns) {
  for (const campaign of campaigns) {
    if (campaign.kind !== "reward") continue;
    let raw;
    try {
      raw = (await gqlRaw(auth, qRewardCampaign(campaign.id)))?.data?.dropsCampaign;
    } catch {
      continue;
    }
    const mine = mapRewardCampaign({ id: campaign.id, name: campaign.name }, raw);
    if (!mine) continue;
    const byId = new Map(mine.drops.map((drop) => [drop.id, drop]));
    for (const drop of campaign.drops) {
      const own = byId.get(drop.id);
      if (!own) continue;
      Object.assign(drop, {
        current: own.current,
        claimed: own.claimed,
        badge: own.badge,
        status: own.status,
        grantCount: own.grantCount,
        startsAt: own.startsAt,
        windowEndsAt: own.windowEndsAt,
        unknown: false,
      });
    }
  }
}

// Чем Twitch ищет пользователя в DropCampaignDetails: в октябре 2026 он перестал принимать логин
// (отвечает user: null) и ждёт числовой id. Если поменяет обратно, сработает второй вариант, и он запомнится.
let detailsKey = "userId";

async function campaignDetails(auth, id) {
  const keys = detailsKey === "userId" ? ["userId", "login"] : ["login", "userId"];
  for (const key of keys) {
    const response = await gql(auth, qCampaignDetails(String(auth[key] || ""), id));
    if (response?.data?.user) {
      detailsKey = key;
      return response.data.user.dropCampaign || null;
    }
  }
  return null;
}

export async function hydrateCampaigns(auth, campaigns, shouldStop) {
  const detailed = [];
  for (const summary of campaigns) {
    if (shouldStop?.()) break;
    // Reward-кампания пришла уже разобранной: у неё нет дропов, которые надо догружать.
    if (summary.kind === "reward") {
      detailed.push(summary);
      continue;
    }
    const raw = await campaignDetails(auth, summary.id);
    if (!raw) continue;
    const campaign = mapCampaign(raw);
    // Только дропы за просмотр: за подписку и прочие без минут майнером не набрать.
    campaign.drops = (campaign.drops || []).map((drop) => mapDrop(campaign, drop))
      .filter((drop) => drop.required > 0 && !drop.subs);
    if (!campaign.drops.length) continue;
    detailed.push(campaign);
  }
  return detailed;
}

export async function currentDrop(auth, channelId) {
  const body = await gqlPlain(auth, qCurrentDrop(channelId));
  const session = body?.data?.currentUser?.dropCurrentSession;
  if (!session) return null;
  return {
    dropId: session.dropID || session.dropId || "",
    current: Number(session.currentMinutesWatched) || 0,
  };
}

function claimResult(body) {
  const data = body?.data || {};
  const status = data.claimDropRewards?.status || data.claimDropReward?.status || "";
  if (status === "ELIGIBLE_FOR_ALL") return "claimed";
  if (status === "DROP_INSTANCE_ALREADY_CLAIMED") return "already";
  const message = (body?.errors || data.errors || []).map((error) => error.message).find(Boolean);
  if (message) throw new Error(message);
  return false;
}

export async function claimDrop(auth, drop) {
  const claimId = drop.claimId || `${auth.userId}#${drop.campaignId}#${drop.id}`;
  let captured = auth.plain ? null : await cachedHeaders().catch(() => null);
  let result = await gqlOnce(auth, qClaimDrop(claimId), captured);
  if (!gqlOk(result) && looksLikeIntegrityBlock(result.text)) {
    if (auth.plain) throw new Error("integrity: claim");
    captured = await readFreshIntegrity(captured?.["client-integrity"] || "");
    if (!captured?.["client-integrity"]) {
      throw new Error(gqlFailure("DropsPage_ClaimDropRewards", result.text));
    }
    result = await gqlOnce(auth, qClaimDrop(claimId), captured);
  }
  if (!gqlOk(result)) throw new Error(gqlFailure("DropsPage_ClaimDropRewards", result.text));
  return claimResult(parseGqlBody(result.text));
}

// auto — брать первый доступный вариант, когда Twitch предлагает выбор. Выключено:
// сундук открывается только если доступен ровно один вариант (выбирать не из чего).
export async function claimReward(auth, drop, { auto = false } = {}) {
  const body = await gqlRaw(auth, qRewardOptions(drop.campaignId, drop.id));
  const set = body?.data?.dropsRewardOptions;
  const options = set?.options || [];
  // Twitch открывает сундук не сразу по достижении минут: пока набора вариантов нет — ждём.
  if (!options.length) return "wait";
  const available = options.filter((item) => item.isAvailable !== false);
  if (!available.length) return "wait";
  if (available.length > 1 && !auto) return "choice";
  const option = available[0];
  const result = await gqlRaw(auth, qSelectRewardOption(set.id, option.id));
  const out = result?.data?.selectDropsRewardOption;
  if (out?.error?.code) throw new Error(out.error.code);
  return out?.code ? "claimed" : false;
}

export async function applyInventory(auth, campaigns) {
  // Инвентарь отдаётся без integrity-токена, как в readInventory; gql с обновлением токена только запасной путь.
  let body;
  try {
    body = await gqlPlain(auth, qInventory());
  } catch {
    body = await gql(auth, qInventory());
  }
  const inventory = body?.data?.currentUser?.inventory || {};
  const listed = inventory.dropCampaignsInProgress || [];
  const byId = new Map();
  for (const campaign of listed) {
    for (const drop of campaign.timeBasedDrops || []) {
      if (drop?.id) byId.set(drop.id, drop.self || {});
    }
  }
  // Полностью забранная кампания пропадает из dropCampaignsInProgress, выдачу видно только здесь.
  const awarded = new Map();
  for (const item of inventory.gameEventDrops || []) {
    if (item?.id) awarded.set(item.id, Date.parse(item.lastAwardedAt) || 0);
  }
  for (const campaign of campaigns) {
    for (const drop of campaign.drops) {
      const self = byId.get(drop.id);
      if (!self) {
        const ids = drop.benefitIds || [];
        const given = ids.length && ids.every((id) => awarded.has(id) && awarded.get(id) >= (campaign.startsAt || 0));
        if (given && !drop.claimed) {
          drop.claimed = true;
          drop.current = Math.max(drop.current, drop.required);
        }
        continue;
      }
      if (self.dropInstanceID) drop.claimId = self.dropInstanceID;
      if (self.isClaimed) {
        drop.claimed = true;
        drop.current = Math.max(drop.current, drop.required);
      } else if (Number.isFinite(Number(self.currentMinutesWatched))) {
        drop.current = Number(self.currentMinutesWatched);
      }
    }
  }
}

export async function readInventory(auth) {
  const body = await gqlPlain(auth, qInventory());
  const listed = body?.data?.currentUser?.inventory?.dropCampaignsInProgress || [];
  const rows = [];
  for (const campaign of listed) {
    const campaignImage = firstUrl([campaign.imageURL, campaign.image?.url]);
    for (const drop of campaign.timeBasedDrops || []) {
      const self = drop.self || {};
      rows.push({
        id: drop.id,
        name: drop.name || benefitNames(drop)[0] || "",
        benefit: benefitNames(drop)[0] || "",
        current: Number(self.currentMinutesWatched) || 0,
        required: Number(drop.requiredMinutesWatched) || 0,
        claimed: Boolean(self.isClaimed),
        claimId: self.dropInstanceID || "",
        image: benefitImage(drop),
        campaignImage,
        campaignId: campaign.id || "",
        campaignName: campaign.name || "",
        game: campaign.game?.displayName || campaign.game?.name || "",
      });
    }
  }
  return rows;
}

// Какие кампании прямо сейчас включены на канале. Канал может быть в эфире и в нужной игре,
// но без дропов (повтор, перерыв турнира): тогда минуты не идут.
export async function channelCampaignIds(auth, channelId) {
  const body = await gql(auth, qAvailableDrops(channelId));
  return new Set((body?.data?.channel?.viewerDropCampaigns || []).map((campaign) => campaign.id));
}

export async function channelHasDrops(auth, channelId) {
  const body = await gql(auth, qAvailableDrops(channelId));
  const campaigns = body?.data?.channel?.viewerDropCampaigns || [];
  return campaigns.length > 0;
}

export async function gameDirectory(auth, slug) {
  const body = await gql(auth, qGameDirectory(slug));
  const edges = body?.data?.game?.streams?.edges || [];
  return edges.map((edge) => edge.node).filter(Boolean).map((node) => ({
    login: node.broadcaster?.login || "",
    channelId: String(node.broadcaster?.id || ""),
    broadcastId: String(node.id || ""),
    viewers: node.viewersCount || 0,
    game: {
      id: String(node.game?.id || ""),
      name: node.game?.displayName || node.game?.name || "",
    },
  })).filter((channel) => channel.login && channel.channelId);
}

export function isoNow() {
  return new Date().toISOString();
}

export function watchPayload(auth, stream) {
  return [{
    event: "minute-watched",
    properties: {
      broadcast_id: String(stream.broadcastId),
      channel_id: String(stream.channelId),
      channel: stream.login,
      client_time: isoNow(),
      game: stream.game?.name || "",
      game_id: String(stream.game?.id || ""),
      hidden: false,
      is_live: true,
      live: true,
      logged_in: true,
      minutes_logged: 1,
      muted: false,
      user_id: Number(auth.userId),
    },
  }];
}

function findSpade(text) {
  const normalized = String(text || "").replace(/\\\//g, "/");
  return SPADE_PATTERN.exec(normalized)?.[1] || "";
}

export async function discoverSpadeUrl(login) {
  try {
    const page = await fetch(`https://www.twitch.tv/${encodeURIComponent(login)}`, {
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    const html = await page.text();
    const direct = findSpade(html);
    if (direct) return direct;
    const settingsUrl = SETTINGS_PATTERN.exec(html.replace(/\\\//g, "/"))?.[1];
    if (settingsUrl) {
      const settings = await fetch(settingsUrl);
      const nested = findSpade(await settings.text());
      if (nested) return nested;
    }
  } catch {
    // Ниже запасной адрес, которым до сих пор пользуется веб-плеер.
  }
  return "https://spade.twitch.tv/track";
}

async function postSpade(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    credentials: "omit",
  });
  return response.status;
}

async function postSpadeFromTab(url, body) {
  const tab = await userTwitchTab();
  if (tab) return postSpadeInTab(tab.id, url, body);
  return withHelperTab((tabId) => postSpadeInTab(tabId, url, body));
}

async function postSpadeInTab(tabId, url, body) {
  const [injected] = await withDeadline(chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, body],
    func: async (target, payload) => {
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload,
        credentials: "omit",
      });
      return response.status;
    },
  }), 8000, "spade");
  return Number(injected?.result) || 0;
}

// ---- Просмотр без видео ----
// С октября 2026 Twitch перестал засчитывать один только minute-watched на spade: минуты дропов встали.
// TwitchDropsMiner 9 октября перешёл на запросы к плейлисту потока (коммит "Change the mining method
// to playlist HEAD requests"), так же делает Twitch-Channel-Points-Miner-v2. Повторяем их способ:
// токен воспроизведения -> список качеств -> плейлист самого лёгкого качества -> HEAD на его сегменты.
// Само видео не скачивается и нигде не проигрывается.
const STREAM_URL_TTL = 10 * 60 * 1000;
const streamUrls = new Map();

async function streamUrl(auth, stream) {
  // Токен плеера выдаётся конкретному зрителю: у каждого аккаунта своя ссылка на тот же канал.
  const key = `${auth.userId}:${stream.login.toLowerCase()}`;
  const known = streamUrls.get(key);
  if (known && known.broadcastId === String(stream.broadcastId) && Date.now() - known.at < STREAM_URL_TTL) return known.url;
  const body = await gqlPlain(auth, qPlaybackToken(stream.login));
  const token = body?.data?.streamPlaybackAccessToken;
  if (!token?.value) return "";
  const query = new URLSearchParams({ sig: token.signature, token: token.value });
  const reply = await fetch(`https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(stream.login)}.m3u8?${query}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!reply.ok) return "";
  // Последняя ссылка в списке: обычно самое низкое качество.
  const url = (await reply.text()).trim().split("\n").filter((line) => line.startsWith("http")).pop() || "";
  if (url) streamUrls.set(key, { url, broadcastId: String(stream.broadcastId), at: Date.now() });
  return url;
}

// Один «просмотр»: плейлист и HEAD на каждый его сегмент. TDM шлёт так раз в ~20 секунд.
export async function sendWatch(auth, stream) {
  try {
    const url = await streamUrl(auth, stream);
    if (!url) return false;
    const playlist = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!playlist.ok) {
      // Эфир кончился или ссылка устарела: в следующий раз возьмём новую.
      streamUrls.delete(`${auth.userId}:${stream.login.toLowerCase()}`);
      return false;
    }
    const chunks = (await playlist.text()).trim().split("\n").filter((line) => line.startsWith("http"));
    if (!chunks.length) return false;
    const replies = await Promise.all(chunks.map((chunk) => (
      fetch(chunk, { method: "HEAD", signal: AbortSignal.timeout(8000) }).then((reply) => reply.status, () => 0)
    )));
    return replies.every((status) => status === 200);
  } catch {
    return false;
  }
}

export async function sendMinuteWatched(auth, stream, spadeUrl) {
  // Сначала запросы к плейлисту: теперь именно они двигают дроп. Прежний пинг на spade шлём следом,
  // как это делает майнер баллов.
  const watched = await sendWatch(auth, stream);
  // Пинг spade уходит с куками браузера, то есть от активного аккаунта: остальным он не нужен.
  if (auth.plain) return { ok: watched, status: watched ? 200 : 0, via: "playlist" };
  const ping = await sendSpade(auth, stream, spadeUrl).catch(() => ({ ok: false, status: 0, via: "worker" }));
  if (watched) return { ok: true, status: ping.ok ? ping.status : 200, via: "playlist" };
  return ping;
}

async function sendSpade(auth, stream, spadeUrl) {
  const json = JSON.stringify(watchPayload(auth, stream));
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = new URLSearchParams({ data: btoa(binary) }).toString();
  try {
    const status = await postSpade(spadeUrl, encoded);
    if (status >= 200 && status < 300) return { ok: true, status, via: "worker" };
  } catch {
    // Хост Spade мог смениться — повторяем из вкладки Twitch, без плеера.
  }
  const status = await postSpadeFromTab(spadeUrl, encoded);
  return { ok: status >= 200 && status < 300, status, via: "tab" };
}

export function sameGame(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id && String(left.id) === String(right.id)) return true;
  return (left.name || "").toLowerCase() === (right.name || "").toLowerCase();
}

export { CONNECT_URL, INVENTORY_URL };
