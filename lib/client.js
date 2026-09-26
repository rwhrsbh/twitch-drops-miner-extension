import {
  CONNECT_URL,
  GQL_URL,
  INVENTORY_URL,
  VALIDATE_URL,
  WEB_CLIENT_ID,
  qAvailableDrops,
  qCampaignDetails,
  qCampaigns,
  qClaimDrop,
  qCurrentDrop,
  qGameDirectory,
  qGetStreamInfo,
  qInventory,
} from "./constants.js";

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

async function readCapturedHeaders(tabId) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => window.__dropsMinerHeaders || null,
  });
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

async function userTwitchTab() {
  const own = await helperTabId();
  const tabs = await chrome.tabs.query({ url: ["https://www.twitch.tv/*", "https://twitch.tv/*"] });
  const usable = tabs.filter((tab) => tab.id && tab.id !== own && !tab.discarded && tab.status === "complete"
    && !tab.url?.includes("/login"));
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

async function storeCaptured(headers) {
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
  const tab = await userTwitchTab();
  const headers = tab ? await pollIntegrity(tab.id, "", 1) : null;
  if (headers) await storeCaptured(headers);
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
  await dropCaptured();
  const headers = await withHelperTab((tabId) => pollIntegrity(tabId, previous, 30));
  if (headers) await storeCaptured(headers);
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
  const cached = await cachedHeaders().catch(() => null);
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

export async function gql(auth, payload) {
  let result;
  try {
    result = await gqlTry(auth, payload);
  } catch (error) {
    throw new Error(gqlFailure(payload.operationName, error?.message || String(error)));
  }
  if (gqlOk(result)) return parseGqlBody(result.text);
  if (!looksLikeIntegrityBlock(result.text)) {
    throw new Error(gqlFailure(payload.operationName, result.text));
  }
  const captured = await readFreshIntegrity(capturedHeaders?.["client-integrity"] || "");
  if (!captured?.["client-integrity"]) {
    throw new Error(gqlFailure(payload.operationName, result.text));
  }
  try {
    result = await gqlOnce(auth, payload, captured);
  } catch (error) {
    throw new Error(gqlFailure(payload.operationName, error?.message || String(error)));
  }
  if (!gqlOk(result)) {
    await dropCaptured();
    throw new Error(gqlFailure(payload.operationName, result.text));
  }
  return parseGqlBody(result.text);
}

async function gqlPlain(auth, payload) {
  const result = await gqlOnce(auth, payload, null);
  if (!gqlOk(result)) throw new Error(gqlFailure(payload.operationName, result.text));
  return parseGqlBody(result.text);
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
    campaignId: campaign.id,
    campaignName: campaign.name,
    game: campaign.game,
    channels: campaign.channels,
    linked: campaign.linked,
    linkUrl: campaign.linkUrl,
  };
}

function mapCampaign(raw) {
  const allowed = raw.allow || {};
  const channels = (allowed.channels || []).map((channel) => ({
    id: String(channel.id || ""),
    login: channel.name || channel.login || "",
  })).filter((channel) => channel.login);
  const game = raw.game || {};
  return {
    id: raw.id,
    name: raw.name || "",
    status: raw.status || "",
    linked: Boolean(raw.self?.isAccountConnected),
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
    drops: raw.timeBasedDrops || [],
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
  return (dashboard?.data?.currentUser?.dropCampaigns || [])
    .map(mapCampaign)
    .filter((campaign) => campaign.status !== "EXPIRED" && campaign.game?.id);
}

export async function hydrateCampaigns(auth, campaigns, shouldStop) {
  const detailed = [];
  for (const summary of campaigns) {
    if (shouldStop?.()) break;
    const response = await gql(auth, qCampaignDetails(auth.login, summary.id));
    const raw = response?.data?.user?.dropCampaign;
    if (!raw) continue;
    const campaign = mapCampaign(raw);
    campaign.drops = (campaign.drops || []).map((drop) => mapDrop(campaign, drop));
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
  let captured = await cachedHeaders().catch(() => null);
  let result = await gqlOnce(auth, qClaimDrop(claimId), captured);
  if (!gqlOk(result) && looksLikeIntegrityBlock(result.text)) {
    captured = await readFreshIntegrity(captured?.["client-integrity"] || "");
    if (!captured?.["client-integrity"]) {
      throw new Error(gqlFailure("DropsPage_ClaimDropRewards", result.text));
    }
    result = await gqlOnce(auth, qClaimDrop(claimId), captured);
  }
  if (!gqlOk(result)) throw new Error(gqlFailure("DropsPage_ClaimDropRewards", result.text));
  return claimResult(parseGqlBody(result.text));
}

export async function applyInventory(auth, campaigns) {
  const body = await gql(auth, qInventory());
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
  const [injected] = await chrome.scripting.executeScript({
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
  });
  return Number(injected?.result) || 0;
}

export async function sendMinuteWatched(auth, stream, spadeUrl) {
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
