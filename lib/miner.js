import {
  CONNECT_URL,
  INVENTORY_URL,
  channelHasDrops,
  applyInventory,
  claimDrop,
  currentDrop,
  discoverSpadeUrl,
  readInventory,
  gameDirectory,
  gameSlug,
  getStream,
  hydrateCampaigns,
  listCampaigns,
  readAuth,
  sameGame,
  sendMinuteWatched,
} from "./client.js";
import { resolveLang, t } from "./i18n.js";

const MISS_LIMIT = 3;
let revision = 0;
let ticking = false;
let tickNumber = 0;
const TICK_STALE = 90000;
let tickStarted = 0;
let activeSeen = 0;

function defaultState() {
  return {
    enabled: true,
    phase: "idle",
    lang: "",
    message: "",
    updatedAt: 0,
    user: null,
    games: [],
    whitelist: [],
    watching: null,
    lastPing: null,
    queue: [],
    log: [],
    stickDropId: "",
    channels: {},
    spade: null,
    missCount: 0,
    linkUrl: CONNECT_URL,
  };
}

export async function readState() {
  const stored = await chrome.storage.local.get("state");
  return { ...defaultState(), ...(stored.state || {}) };
}

async function save(state, seen) {
  if (seen !== undefined && seen !== revision) return readState();
  const next = { ...state, updatedAt: Date.now() };
  await chrome.storage.local.set({ state: next });
  await paint(next);
  return next;
}

function pushLog(state, text) {
  const previous = (state.log || []).filter((line) => !/нет соединения/.test(line.text));
  return [{ at: Date.now(), text }, ...previous].slice(0, 40);
}

async function paint(state) {
  let text = "";
  let color = "#868e96";
  if (!state.enabled) {
    text = "";
  } else if (state.phase === "watching" && state.watching) {
    const left = Math.max(0, state.watching.required - state.watching.current);
    text = left >= 90 ? `${Math.ceil(left / 60)}h` : `${left}m`;
    if (text.length > 4) text = "ON";
    color = "#1f8a4c";
  } else if (state.phase === "need-login" || state.phase === "error") {
    text = "!";
    color = "#c92a2a";
  } else if (state.phase === "all-claimed") {
    text = "OK";
    color = "#1971c2";
  } else if (state.phase === "pick-game" || state.phase === "not-linked" || state.phase === "no-channel"
    || state.phase === "claim-pending") {
    text = "...";
    color = "#c47d12";
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  const title = state.watching
    ? `${state.watching.game} · ${state.watching.login}`
    : "Drops Miner";
  await chrome.action.setTitle({ title });
}

function activeCampaign(campaign, now) {
  if (campaign.status === "EXPIRED") return false;
  if (campaign.startsAt && now < campaign.startsAt) return false;
  if (campaign.endsAt && now >= campaign.endsAt) return false;
  return true;
}

function earnableDrops(campaigns, now) {
  const drops = [];
  for (const campaign of campaigns) {
    if (!campaign.linked || !activeCampaign(campaign, now)) continue;
    const claimed = new Set(campaign.drops.filter((drop) => drop.claimed).map((drop) => drop.id));
    for (const drop of campaign.drops) {
      if (drop.claimed || drop.required <= 0 || drop.current >= drop.required) continue;
      if (!drop.preconditionIds.every((id) => claimed.has(id))) continue;
      drops.push(drop);
    }
  }
  return drops;
}

function pickDrop(campaigns, stickDropId, now) {
  const drops = earnableDrops(campaigns, now);
  const stick = drops.find((drop) => drop.id === stickDropId);
  if (stick) return stick;
  drops.sort((left, right) => {
    const leftLeft = left.required - left.current;
    const rightLeft = right.required - right.current;
    if (leftLeft !== rightLeft) return leftLeft - rightLeft;
    return (right.channels.length > 0) - (left.channels.length > 0);
  });
  return drops[0] || null;
}

function gameRows(summaries, detailed, whitelist) {
  const selected = new Set(whitelist);
  const progress = new Map();
  for (const campaign of detailed) {
    const id = campaign.game.id;
    const row = progress.get(id) || { total: 0, left: 0 };
    for (const drop of campaign.drops) {
      if (drop.required <= 0) continue;
      row.total += 1;
      if (!drop.claimed) row.left += 1;
    }
    progress.set(id, row);
  }
  const games = new Map();
  for (const campaign of summaries) {
    const id = campaign.game.id;
    const row = games.get(id) || {
      id,
      name: campaign.game.name || t(undefined, "gameFallback"),
      slug: gameSlug(campaign.game),
      image: campaign.game.image || campaign.image || "",
      campaigns: 0,
      linked: false,
      endsAt: 0,
      total: 0,
      left: 0,
      selected: selected.has(id),
    };
    row.campaigns += 1;
    row.linked = row.linked || campaign.linked;
    row.endsAt = Math.max(row.endsAt, campaign.endsAt || 0);
    row.selected = selected.has(id);
    if (!row.image) row.image = campaign.game.image || campaign.image || "";
    const known = progress.get(id);
    if (known) {
      row.total = known.total;
      row.left = known.left;
    }
    games.set(id, row);
  }
  return [...games.values()].sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function buildQueue(campaigns, online = {}) {
  return campaigns.flatMap((campaign) => campaign.drops.map((drop) => ({
    id: drop.id,
    name: drop.benefits[0] || drop.name,
    game: campaign.game.name,
    gameId: campaign.game.id || "",
    required: drop.required,
    current: drop.current,
    image: itemArt(drop.image),
    campaignImage: campaignArt(drop.campaignImage || campaign.image),
    claimId: drop.claimId || "",
    campaignId: drop.campaignId || campaign.id,
    claimed: drop.claimed,
    streamer: drop.channels.length > 0,
    channels: drop.channels.map((channel) => {
      const key = channel.login.toLowerCase();
      return {
        login: channel.login,
        online: Object.prototype.hasOwnProperty.call(online, key) ? online[key] : null,
      };
    }),
    campaignName: campaign.name,
    linked: campaign.linked,
  })));
}

async function liveStream(auth, login, game) {
  const stream = await getStream(auth, login);
  if (!stream || !sameGame(stream.game, game)) return null;
  return stream;
}

function byRemaining(left, right) {
  return (left.required - left.current) - (right.required - right.current);
}

async function chooseTarget(auth, campaigns, now, memory) {
  const drops = earnableDrops(campaigns, now);
  const unique = drops.filter((drop) => drop.channels.length).sort((left, right) => {
    const leftStarted = left.current > 0 ? 0 : 1;
    const rightStarted = right.current > 0 ? 0 : 1;
    if (leftStarted !== rightStarted) return leftStarted - rightStarted;
    const leftPercent = left.required ? left.current / left.required : 0;
    const rightPercent = right.required ? right.current / right.required : 0;
    if (leftPercent !== rightPercent) return rightPercent - leftPercent;
    return left.required - right.required;
  });
  const general = drops.filter((drop) => !drop.channels.length).sort(byRemaining);
  const excluded = (memory.excludeLogin || "").toLowerCase();
  const currentLogin = (memory.login || "").toLowerCase();
  const online = {};
  const preferred = memory.preferDropId
    ? drops.find((drop) => drop.id === memory.preferDropId)
    : null;
  let leftOffline = false;
  if (preferred?.channels.length) {
    let fallback = null;
    for (const channel of preferred.channels) {
      const key = channel.login.toLowerCase();
      if (key === excluded) continue;
      const stream = await getStream(auth, channel.login);
      online[key] = Boolean(stream);
      if (!stream || !sameGame(stream.game, preferred.game)) continue;
      if (!fallback) fallback = stream;
    }
    if (fallback) return { drop: preferred, stream: fallback, reason: "pick", online };
    leftOffline = true;
  } else if (preferred) {
    const stream = await openGeneral(auth, preferred, memory, false);
    if (stream) return { drop: preferred, stream, reason: "pick", online };
    leftOffline = true;
  }

  for (const drop of unique) {
    let fallback = null;
    for (const channel of drop.channels) {
      const key = channel.login.toLowerCase();
      if (key === excluded) continue;
      const stream = await getStream(auth, channel.login);
      online[key] = Boolean(stream);
      if (!stream || !sameGame(stream.game, drop.game)) continue;
      if (key === currentLogin) return { drop, stream, reason: "stay", online };
      if (!fallback) fallback = { drop, stream, reason: leftOffline ? "offline" : "unique" };
    }
    if (fallback) return { ...fallback, online };
  }

  const generalDrop = general[0];
  if (!generalDrop) return { online };
  const stream = await openGeneral(auth, generalDrop, memory, memory.dropId === generalDrop.id);
  if (stream) {
    const reason = leftOffline ? "offline" : stream.login.toLowerCase() === currentLogin ? "stay" : "general";
    return { drop: generalDrop, stream, reason, online };
  }
  return { online };
}

async function openGeneral(auth, drop, memory, stay) {
  const excluded = (memory.excludeLogin || "").toLowerCase();
  const currentLogin = (memory.login || "").toLowerCase();
  if (stay && currentLogin) {
    const current = await liveStream(auth, memory.login, drop.game);
    if (current) return current;
  }
  if (!stay && currentLogin) {
    const current = await liveStream(auth, memory.login, drop.game);
    if (current) {
      try {
        if (await channelHasDrops(auth, current.channelId)) return current;
      } catch {
        // Этот канал не подтвердил дропы, ищем другой.
      }
    }
  }
  const directory = await gameDirectory(auth, gameSlug(drop.game));
  for (const candidate of directory.slice(0, 8)) {
    if (candidate.login.toLowerCase() === excluded) continue;
    let enabled = false;
    try {
      enabled = await channelHasDrops(auth, candidate.channelId);
    } catch {
      enabled = false;
    }
    if (!enabled) continue;
    const stream = await liveStream(auth, candidate.login, drop.game);
    if (stream) return stream;
  }
  return null;
}

const CLAIM_MEMORY = 6 * 60 * 60 * 1000;

async function recentClaims(userId) {
  const { claimedDrops = {} } = await chrome.storage.local.get("claimedDrops");
  const now = Date.now();
  const prefix = `${userId}:`;
  return new Set(Object.entries(claimedDrops)
    .filter(([key, at]) => key.startsWith(prefix) && now - at < CLAIM_MEMORY)
    .map(([key]) => key.slice(prefix.length)));
}

async function rememberClaim(userId, id) {
  const { claimedDrops = {} } = await chrome.storage.local.get("claimedDrops");
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(claimedDrops).filter(([, at]) => now - at < CLAIM_MEMORY));
  kept[`${userId}:${id}`] = now;
  await chrome.storage.local.set({ claimedDrops: kept });
}

async function claimReady(auth, campaigns, lang) {
  const claimed = [];
  const failed = [];
  const done = await recentClaims(auth.userId);
  for (const campaign of campaigns) {
    for (const drop of campaign.drops) {
      if (!drop.claimed && done.has(drop.id)) {
        drop.claimed = true;
        drop.current = Math.max(drop.current, drop.required);
      }
      const finished = drop.required > 0 && drop.current >= drop.required;
      if (drop.claimed || !finished) continue;
      const label = `${drop.benefits[0] || drop.name} (${campaign.game.name})`;
      try {
        const ok = await claimDrop(auth, drop);
        if (!ok) {
          failed.push(label);
          continue;
        }
        drop.claimed = true;
        drop.current = Math.max(drop.current, drop.required);
        await rememberClaim(auth.userId, drop.id);
        if (ok === "claimed") claimed.push(label);
      } catch (error) {
        failed.push(`${label}: ${error?.message || tr({ lang }, "claimFail")}`);
      }
    }
  }
  return { claimed, failed };
}

function watchingOf(drop, stream) {
  return {
    login: stream.login,
    channelId: stream.channelId,
    streamer: drop.channels.length > 0,
    name: drop.benefits[0] || drop.name,
    image: drop.image || "",
    campaignImage: drop.campaignImage || "",
    game: drop.game?.name || "",
    gameId: drop.game?.id || "",
    current: drop.current,
    required: drop.required,
    dropId: drop.id,
  };
}

export async function setLanguage(lang) {
  const state = await readState();
  return save({ ...state, lang: resolveLang(lang) });
}

export async function setEnabled(enabled) {
  const state = await readState();
  const editSeq = (state.editSeq || 0) + 1;
  if (!enabled) {
    revision += 1;
    return save({
      ...state,
      editSeq,
      enabled: false,
      phase: "idle",
      message: tr(state, "turnedOff"),
      watching: null,
      log: pushLog(state, tr(state, "minerOff")),
    });
  }
  await save({
    ...state,
    editSeq,
    enabled: true,
    log: pushLog(state, tr(state, "minerOn")),
  });
  revision += 1;
  return tick("toggle");
}

function channelLogin(channel) {
  return typeof channel === "string" ? channel : channel?.login || "";
}

function gameArt(url) {
  return /ttv-boxart|\/boxart\//i.test(String(url || ""));
}

function itemArt(url) {
  const value = String(url || "");
  if (!value.startsWith("https://") || gameArt(value) || /\/CAMPAIGN\//i.test(value)) return "";
  return value;
}

function campaignArt(url) {
  const value = String(url || "");
  if (!value.startsWith("https://") || gameArt(value) || /\/REWARD\//i.test(value)) return "";
  return value;
}

function tr(state, key, vars) {
  return t(state?.lang, key, vars);
}

function watchLine(state) {
  const item = state.watching;
  if (!item) return tr(state, "watchingIdle");
  const current = item.current || 0;
  const required = item.required || 0;
  const ratio = required ? Math.min(100, Math.round((current / required) * 100)) : 0;
  return tr(state, "watchLine", {
    game: item.game || "",
    name: item.name || "",
    login: item.login || tr(state, "channelWord"),
    current,
    required,
    ratio,
  });
}

function farmLogin(drop) {
  const channels = drop?.channels || [];
  const live = channels.find((channel) => channel?.online === true);
  if (live) return channelLogin(live);
  if (!channels.length) return "";
  const unknown = channels.find((channel) => typeof channel === "string" || channel?.online == null);
  return unknown ? channelLogin(unknown) : "";
}

function needsTime(drop) {
  return drop && !drop.claimed && drop.required > 0 && (drop.current || 0) < drop.required;
}

function onlineTarget(queue, avoidId) {
  const ranked = (queue || []).filter((drop) => needsTime(drop) && (drop.channels || []).some((channel) => channel?.online === true));
  ranked.sort((left, right) => (right.current > 0) - (left.current > 0)
    || ((right.current || 0) / (right.required || 1)) - ((left.current || 0) / (left.required || 1)));
  const drop = ranked.find((item) => item.id !== avoidId);
  const live = drop && (drop.channels || []).find((channel) => channel?.online === true);
  if (!drop || !live) return null;
  return { drop, login: channelLogin(live) };
}

function applyWatch(state, drop, login) {
  state.preferDropId = drop.id;
  state.stickDropId = drop.id;
  state.watching = {
    dropId: drop.id,
    name: drop.name,
    game: drop.game,
    gameId: drop.gameId || "",
    image: drop.image || "",
    campaignImage: drop.campaignImage || "",
    current: drop.current || 0,
    required: drop.required || 0,
    display: drop.current || 0,
    login,
    channelId: "",
    streamer: Boolean(drop.channels?.length),
  };
}

function retargetIfOffline(state) {
  const login = state.watching?.login || "";
  const key = login.toLowerCase();
  const current = (state.queue || []).find((drop) => drop.id === state.watching?.dropId);
  const allowed = !current || !(current.channels || []).length || (current.channels || []).some((channel) => (
    channelLogin(channel).toLowerCase() === key && channel?.online !== false
  ));
  if (!key || !allowed) {
    const picked = onlineTarget(state.queue, current?.id || "");
    if (!picked) return "";
    applyWatch(state, picked.drop, picked.login);
    return tr(state, "badChannel", { login: login || tr(state, "channelWord"), next: picked.login });
  }
  const offline = (state.queue || []).some((drop) => (drop.channels || []).some((channel) => (
    channelLogin(channel).toLowerCase() === key && channel?.online === false
  )));
  if (!offline) return "";
  const same = (current?.channels || []).find((channel) => (
    channel?.online === true && channelLogin(channel).toLowerCase() !== key
  ));
  if (same) {
    state.watching = { ...state.watching, login: channelLogin(same) };
    return tr(state, "wentOffline", { login, next: channelLogin(same) });
  }
  const open = (state.queue || [])
    .filter((drop) => !drop.claimed && (drop.channels || []).some((channel) => channel?.online === true))
    .sort((left, right) => (right.current > 0) - (left.current > 0) || (right.current / (right.required || 1)) - (left.current / (left.required || 1)));
  const drop = open.find((item) => item.id !== current?.id) || open[0];
  const live = drop && (drop.channels || []).find((channel) => (
    channel?.online === true && channelLogin(channel).toLowerCase() !== key
  ));
  if (!drop || !live) return "";
  state.preferDropId = drop.id;
  state.stickDropId = drop.id;
  state.watching = {
    ...(state.watching || {}),
    dropId: drop.id,
    name: drop.name,
    game: drop.game,
    gameId: drop.gameId || "",
    image: drop.image || "",
    campaignImage: drop.campaignImage || "",
    current: drop.current || 0,
    required: drop.required || 0,
    display: drop.current || 0,
    login: channelLogin(live),
    streamer: true,
  };
  return tr(state, "wentOffline", { login, next: channelLogin(live) });
}

export async function watchDrop(dropId) {
  const state = await readState();
  const drop = (state.queue || []).find((item) => item.id === dropId);
  let target = drop;
  const finished = drop && drop.required > 0 && (drop.current || 0) >= drop.required;
  let login = drop && !finished ? farmLogin(drop) : "";
  let note = drop ? tr(state, "farming", { name: drop.name }) : tr(state, "switching");
  if (drop && ((drop.channels || []).length && !login || finished)) {
    const picked = onlineTarget(state.queue, drop.id);
    const offlineName = channelLogin((drop.channels || []).find((channel) => channel?.online === false) || drop.channels[0]);
    if (picked) {
      target = picked.drop;
      login = picked.login;
      note = tr(state, "offlineWatch", { name: offlineName, next: login });
    }
  } else if (drop && !(drop.channels || []).length) {
    const previous = state.watching?.login || "";
    const previousOffline = (state.queue || []).some((item) => (item.channels || []).some((channel) => (
      channelLogin(channel).toLowerCase() === previous.toLowerCase() && channel?.online === false
    )));
    login = previous && !previousOffline ? previous : "";
  }
  const next = await save({
    ...state,
    editSeq: (state.editSeq || 0) + 1,
    preferDropId: target?.id || dropId,
    stickDropId: target?.id || dropId,
    lastPing: login && login !== state.watching?.login ? { at: 0, ok: false, status: 0 } : state.lastPing,
    watching: target ? {
      dropId: target.id,
      name: target.name,
      game: target.game,
      gameId: target.gameId || "",
      image: target.image || "",
      campaignImage: target.campaignImage || "",
      current: target.current || 0,
      required: target.required || 0,
      login,
      channelId: "",
      streamer: Boolean(target.channels?.length),
      display: target.current || 0,
    } : state.watching,
    log: pushLog(state, note),
  });
  revision += 1;
  tick("prefer");
  return next;
}

export async function setWhitelist(ids) {
  const state = await readState();
  const whitelist = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
  const names = new Set((state.games || []).filter((game) => whitelist.includes(game.id)).map((game) => game.name));
  const queue = (state.queue || []).filter((drop) => names.has(drop.game));
  const watchingKept = state.watching && names.has(state.watching.game);
  const next = await save({
    ...state,
    editSeq: (state.editSeq || 0) + 1,
    whitelist,
    games: (state.games || []).map((game) => ({ ...game, selected: whitelist.includes(game.id) })),
    queue,
    watching: watchingKept ? state.watching : null,
    stickDropId: watchingKept ? state.stickDropId : "",
    preferDropId: watchingKept ? state.preferDropId : "",
    log: pushLog(state, names.size ? tr(state, "gamesList", { names: [...names].join(", ") }) : tr(state, "gamesEmpty")),
  });
  revision += 1;
  tick("whitelist");
  return next;
}

async function pagePictures() {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://www.twitch.tv/*", "https://twitch.tv/*"] });
    const tab = tabs.find((item) => /\/drops/.test(item.url || "")) || tabs[0];
    if (!tab?.id) return [];
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [...document.images].flatMap((img) => {
        const src = img.currentSrc || img.src || "";
        if (!/quests-assets|drop-assets/i.test(src) || /boxart/i.test(src)) return [];
        let text = img.alt || "";
        let node = img.parentElement;
        for (let depth = 0; depth < 6 && node; depth += 1) {
          const chunk = (node.innerText || "").replace(/\s+/g, " ").trim();
          if (chunk.length > text.length && chunk.length < 220) text = `${img.alt || ""} ${chunk}`.trim();
          node = node.parentElement;
        }
        return [{ src, alt: img.alt || "", text: text.slice(0, 220) }];
      }).slice(0, 120),
    });
    return injected?.result || [];
  } catch {
    return [];
  }
}

function pictureTitle(picture) {
  const match = String(picture?.alt || "").match(/для\s+(.+)$/i);
  return match ? match[1].trim().toLowerCase() : "";
}

function applyPictures(queue, pictures) {
  const items = pictures || [];
  return (queue || []).map((drop) => {
    const name = (drop.name || "").toLowerCase();
    const campaignName = (drop.campaignName || "").toLowerCase();
    const reward = items.find((picture) => {
      if (!/\/REWARD\/|drop-assets/i.test(picture.src) || /\/CAMPAIGN\/|boxart/i.test(picture.src)) return false;
      const titled = pictureTitle(picture);
      if (titled && titled === name) return true;
      const text = `${picture.alt || ""} ${picture.text || ""}`.toLowerCase();
      return name.length > 3 && text.includes(name) && text.length < 200;
    });
    const camp = items.find((picture) => {
      if (!/\/CAMPAIGN\//i.test(picture.src)) return false;
      const text = `${picture.alt || ""} ${picture.text || ""}`.toLowerCase();
      return campaignName && text.includes(campaignName);
    });
    return {
      ...drop,
      image: itemArt(reward?.src) || itemArt(drop.image),
      campaignImage: campaignArt(camp?.src) || campaignArt(drop.campaignImage),
    };
  });
}

async function claimQueue(auth, state) {
  const claimed = [];
  const failed = [];
  let attempts = 0;
  let movedFrom = "";
  const done = await recentClaims(auth.userId);
  for (const drop of state.queue || []) {
    if (!drop.claimed && done.has(drop.id)) {
      drop.claimed = true;
      drop.current = Math.max(drop.current || 0, drop.required || 0);
    }
    if (attempts >= 3) break;
    if (drop.claimed) continue;
    const ready = drop.required > 0 && drop.current >= drop.required;
    if (!ready) continue;
    const label = `${drop.name}${drop.game ? ` (${drop.game})` : ""}`;
    attempts += 1;
    const watched = state.watching?.dropId === drop.id || state.watching?.name === drop.name;
    let ok = false;
    try {
      ok = await claimDrop(auth, drop);
      if (!ok) failed.push(label);
    } catch (error) {
      failed.push(`${label}: ${error?.message || tr(state, "claimFail")}`);
    }
    if (ok) {
      drop.claimed = true;
      drop.current = Math.max(drop.current || 0, drop.required || 0);
      await rememberClaim(auth.userId, drop.id);
      if (ok === "claimed") claimed.push(label);
    }
    if (watched) {
      state.watching = null;
      state.preferDropId = "";
      state.stickDropId = "";
      if (!ok) movedFrom = drop.name;
    }
  }
  return { claimed, failed, movedFrom };
}

function fillWatching(state) {
  if (state.watching?.login) return;
  const open = (state.queue || []).filter((drop) => needsTime(drop));
  open.sort((left, right) => (right.current > 0) - (left.current > 0)
    || ((right.current || 0) / (right.required || 1)) - ((left.current || 0) / (left.required || 1)));
  for (const drop of open) {
    const live = (drop.channels || []).find((channel) => channel?.online === true);
    if (!live) continue;
    state.preferDropId = drop.id;
    state.stickDropId = drop.id;
    state.watching = {
      dropId: drop.id,
      name: drop.name,
      game: drop.game,
      gameId: drop.gameId || "",
      image: drop.image || "",
      campaignImage: drop.campaignImage || "",
      current: drop.current || 0,
      required: drop.required || 0,
      display: drop.current || 0,
      login: channelLogin(live),
      streamer: true,
    };
    return;
  }
}

async function syncTwitchProgress(auth, state) {
  const rows = await readInventory(auth);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byName = new Map();
  for (const row of rows) {
    if (row.name) byName.set(row.name.toLowerCase(), row);
    if (row.benefit) byName.set(row.benefit.toLowerCase(), row);
  }
  state.queue = (state.queue || []).map((drop) => {
    const live = byId.get(drop.id) || byName.get((drop.name || "").toLowerCase());
    if (!live) return drop;
    return {
      ...drop,
      current: live.claimed ? Math.max(live.current, live.required || drop.required || 0) : live.current,
      required: live.required || drop.required,
      claimed: Boolean(live.claimed || drop.claimed),
      claimId: live.claimId || drop.claimId || "",
      campaignId: live.campaignId || drop.campaignId || "",
      campaignName: live.campaignName || drop.campaignName || "",
      image: itemArt(live.image) || itemArt(drop.image),
      campaignImage: campaignArt(live.campaignImage) || campaignArt(drop.campaignImage),
    };
  });
  if (state.watching) {
    const live = (state.queue || []).find((drop) => drop.id === state.watching.dropId || drop.name === state.watching.name);
    if (live) {
      state.watching = {
        ...state.watching,
        current: live.current,
        display: live.current,
        required: live.required || state.watching.required,
        image: live.image || "",
        campaignImage: live.campaignImage || "",
      };
    }
  }
  state.message = watchLine(state);
}

async function persist(draft) {
  const fresh = await readState();
  if ((fresh.editSeq || 0) > (draft.editSeq || 0)) return fresh;
  if (!fresh.enabled && draft.enabled !== false) return fresh;
  const whitelist = (fresh.whitelist || []).map(String);
  const names = new Set();
  for (const game of [...(fresh.games || []), ...(draft.games || [])]) {
    if (whitelist.includes(String(game.id))) names.add(game.name);
  }
  let queue = draft.queue || [];
  if (!whitelist.length) queue = [];
  else if (names.size) queue = queue.filter((drop) => names.has(drop.game));
  // Выбор пользователя посреди тика уже отсекает editSeq выше, поэтому здесь верим черновику.
  const prefer = draft.preferDropId ?? "";
  let watching = draft.watching ?? null;
  if (watching && names.size && !names.has(watching.game)) watching = null;
  const games = (draft.games?.length ? draft.games : fresh.games || []).map((game) => ({
    ...game,
    selected: whitelist.includes(String(game.id)),
  }));
  return save({
    ...draft,
    enabled: fresh.enabled,
    editSeq: fresh.editSeq || 0,
    whitelist,
    preferDropId: prefer,
    games,
    queue,
    watching,
  });
}

export async function tick(reason = "alarm") {
  if (ticking && Date.now() - tickStarted < TICK_STALE) return readState();
  const mine = ++tickNumber;
  ticking = true;
  tickStarted = Date.now();
  activeSeen = revision;
  const seen = activeSeen;
  try {
    return await runTick(reason);
  } catch (error) {
    if (activeSeen !== revision) return readState();
    const state = await readState();
    const message = error?.message || String(error);
    const needsLogin = /HTTP 401|unauthorized|invalid token/i.test(message);
    if (!needsLogin && state.watching) {
      return save({
        ...state,
        phase: "watching",
        message: watchLine(state),
        log: pushLog(state, /integrity|не ответил|Failed to fetch/i.test(message)
          ? tr(state, "catalogStale")
          : message.slice(0, 140)),
      });
    }
    return save({
      ...state,
      phase: needsLogin ? "need-login" : "error",
      message: needsLogin
        ? tr(state, "sessionExpired")
        : message,
      user: needsLogin ? null : state.user,
      watching: needsLogin ? null : state.watching,
      log: pushLog(state, message),
    });
  } finally {
    if (tickNumber === mine) ticking = false;
    if (revision !== seen) tick("follow");
  }
}

async function runTick() {
  const state = await readState();
  if (!state.enabled) return state;
  if (activeSeen !== revision) return readState();

  const auth = await readAuth();
  if (!auth) {
    return persist({
      ...state,
      phase: "need-login",
      message: tr(state, "needLogin"),
      user: null,
      watching: null,
      games: [],
      log: state.phase === "need-login" ? state.log : pushLog(state, tr(state, "noSession")),
    });
  }

  let knownOnline = {};
  if (/молчит|не ответил/i.test(state.message || "")) state.message = watchLine(state);
  try {
    await syncTwitchProgress(auth, state);
  } catch {
    state.log = pushLog(state, tr(state, "inventoryMiss"));
  }
  state.queue = applyPictures(state.queue, await Promise.race([
    pagePictures(),
    new Promise((resolve) => setTimeout(() => resolve([]), 4000)),
  ]));
  state.message = watchLine(state);
  await persist({ ...state, phase: state.watching ? "watching" : state.phase, message: state.message });
  if (activeSeen !== revision) return readState();
  if ((state.queue || []).length) {
    try {
      const logins = [];
      for (const drop of state.queue) {
        if (drop.claimed) continue;
        for (const channel of drop.channels || []) {
          const login = channelLogin(channel);
          if (login) logins.push(login);
        }
      }
      const unique = [...new Map(logins.map((login) => [login.toLowerCase(), login])).values()];
      const online = {};
      for (let index = 0; index < unique.length; index += 6) {
        const batch = unique.slice(index, index + 6);
        await Promise.all(batch.map(async (login) => {
          const key = login.toLowerCase();
          try {
            online[key] = Boolean(await getStream(auth, login));
          } catch {
            online[key] = null;
          }
        }));
      }
      state.queue = state.queue.map((drop) => ({
        ...drop,
        channels: (drop.channels || []).map((channel) => {
          const login = channelLogin(channel);
          const key = login.toLowerCase();
          const previous = typeof channel === "object" && (channel.online === true || channel.online === false)
            ? channel.online
            : null;
          const value = Object.prototype.hasOwnProperty.call(online, key) ? online[key] : null;
          return {
            login,
            online: value === null ? previous : value,
          };
        }),
      }));
      knownOnline = online;
      if (state.watching?.required && (state.watching.current || 0) >= state.watching.required) {
        state.watching = null;
        state.preferDropId = "";
        state.stickDropId = "";
      }
      state.queue = applyPictures(state.queue, await pagePictures());
      const switched = retargetIfOffline(state);
      if (switched) state.log = pushLog(state, switched);
      fillWatching(state);
      state.message = watchLine(state);
      await persist({ ...state, phase: state.watching ? "watching" : state.phase, message: state.message });
    } catch {
      // Статус сети догонится на следующем проходе.
    }
  }
  try {
    const earned = await claimQueue(auth, state);
    if (earned.claimed.length || earned.failed.length) {
      if (earned.claimed.length) state.log = pushLog(state, tr(state, "claimed", { names: earned.claimed.join(", ") }));
      if (earned.failed.length) state.log = pushLog(state, tr(state, "notClaimed", { names: earned.failed.join(", ") }));
      fillWatching(state);
      if (earned.movedFrom && state.watching) {
        state.log = pushLog(state, tr(state, "finishedMoved", {
          name: earned.movedFrom,
          next: state.watching.login || state.watching.name,
        }));
      }
      state.message = watchLine(state);
      await persist({ ...state, phase: state.watching ? "watching" : state.phase, message: state.message });
    }
  } catch {
    state.log = pushLog(state, tr(state, "claimRetry"));
  }
  if (activeSeen !== revision) return readState();

  let alreadyPinged = "";
  if (state.watching?.login && Date.now() - (state.lastPing?.at || 0) > 50000) {
    try {
      const stream = await getStream(auth, state.watching.login);
      if (stream) {
        const spadeUrl = state.spade?.login?.toLowerCase() === stream.login.toLowerCase()
          ? state.spade.url
          : await discoverSpadeUrl(stream.login);
        const ping = await sendMinuteWatched(auth, stream, spadeUrl);
        if (ping.ok) {
          alreadyPinged = stream.login.toLowerCase();
          try {
            const progress = await currentDrop(auth, stream.channelId);
            if (progress?.dropId) {
              state.queue = (state.queue || []).map((item) => (
                item.id === progress.dropId ? { ...item, current: progress.current } : item
              ));
              if (!state.watching || state.watching.dropId === progress.dropId) {
                const tracked = (state.queue || []).find((item) => item.id === progress.dropId);
                if (tracked && state.watching) {
                  state.watching = { ...state.watching, current: progress.current, display: progress.current, required: tracked.required || state.watching.required };
                }
              }
            }
          } catch {
            // Минуты остаются теми, что Twitch уже отдал в инвентаре.
          }
          state.message = watchLine(state);
          state.lastPing = { at: Date.now(), ok: true, status: ping.status, via: ping.via };
          state.spade = { login: stream.login, url: spadeUrl };
          state.log = pushLog(state, tr(state, "pingLog", { login: stream.login, status: ping.status }));
          await persist({ ...state, phase: "watching" });
        }
      }
    } catch {
      // Полный проход ниже всё равно выберет живой канал.
    }
  }

  if (activeSeen !== revision) return readState();
  const summaries = await listCampaigns(auth);
  const whitelist = (state.whitelist || []).map(String);
  const selected = new Set(whitelist);
  const chosen = summaries.filter((campaign) => selected.has(campaign.game.id));
  const campaigns = chosen.length
    ? await hydrateCampaigns(auth, chosen, () => activeSeen !== revision)
    : [];
  if (activeSeen !== revision) return readState();
  const games = gameRows(summaries, campaigns, whitelist);
  let log = state.log || [];
  const base = {
    ...state,
    log,
    user: { login: auth.login, id: auth.userId },
    games,
    whitelist,
  };

  if (!whitelist.length) {
    return persist({
      ...base,
      phase: "pick-game",
      message: games.length
        ? tr(state, "pickGames")
        : tr(state, "noCampaignsListed"),
      watching: null,
      queue: [],
      linkUrl: CONNECT_URL,
    });
  }

  if (!campaigns.length) {
    return persist({
      ...base,
      phase: "no-campaign",
      message: tr(state, "noCampaignsNow"),
      watching: null,
      queue: [],
      stickDropId: "",
    });
  }

  const now = Date.now();
  try {
    await applyInventory(auth, campaigns);
  } catch {
    // Кампании уже есть, инвентарь только уточняет, что можно забрать.
  }
  const firstClaim = await claimReady(auth, campaigns, state.lang);
  if (firstClaim.claimed.length) log = pushLog({ log }, tr(state, "claimed", { names: firstClaim.claimed.join(", ") }));
  if (firstClaim.failed.length) log = pushLog({ log }, tr(state, "notClaimed", { names: firstClaim.failed.join(", ") }));
  base.log = log;

  let missCount = state.missCount || 0;
  const channels = { ...(state.channels || {}) };
  let stickDropId = state.stickDropId;
  let excludeLogin = "";
  let preferDropId = state.preferDropId || "";
  const watchingKey = (state.watching?.login || "").toLowerCase();
  if (!excludeLogin && watchingKey && knownOnline[watchingKey] === false) {
    excludeLogin = state.watching.login;
    base.log = pushLog(base, tr(state, "offlineLooking", { login: state.watching.login }));
  }
  if (missCount >= MISS_LIMIT) {
    base.log = pushLog(base, tr(state, "progressStuck"));
    missCount = 0;
    stickDropId = "";
    preferDropId = "";
    excludeLogin = state.watching?.login || "";
  }
  base.preferDropId = preferDropId;

  if (activeSeen !== revision) return readState();
  const target = await chooseTarget(auth, campaigns, now, {
    login: excludeLogin ? "" : state.watching?.login,
    dropId: excludeLogin ? "" : stickDropId,
    preferDropId,
    excludeLogin,
    scanCursor: state.scanCursor || 0,
  });
  const queue = applyPictures(
    buildQueue(campaigns, { ...knownOnline, ...(target.online || {}) }),
    await pagePictures(),
  );
  const drop = target.drop || null;

  if (!drop) {
    const pendingUnlinked = campaigns.some((campaign) => (
      activeCampaign(campaign, now)
      && !campaign.linked
      && campaign.drops.some((item) => !item.claimed)
    ));
    if (pendingUnlinked) {
      const pending = campaigns.find((campaign) => !campaign.linked && activeCampaign(campaign, now));
      return persist({
        ...base,
        phase: "not-linked",
        message: tr(state, "notLinked", { name: pending?.game?.name || tr(state, "campaignWord") }),
        queue,
        watching: null,
        linkUrl: pending?.linkUrl || CONNECT_URL,
      });
    }
    const unclaimed = campaigns.flatMap((campaign) => (activeCampaign(campaign, now) && campaign.linked
      ? campaign.drops.filter((item) => !item.claimed && item.required > 0 && item.current >= item.required)
      : []));
    if (unclaimed.length) {
      return persist({
        ...base,
        phase: "claim-pending",
        message: tr(state, "claimPending", { names: unclaimed.map((item) => item.benefits[0] || item.name).join(", ") }),
        queue,
        watching: null,
        stickDropId: "",
      });
    }
    return persist({
      ...base,
      phase: "all-claimed",
      message: tr(state, "allClaimed"),
      queue,
      watching: null,
      stickDropId: "",
    });
  }

  const gameId = drop.game?.id || "";
  if (excludeLogin && channels[gameId]?.login?.toLowerCase() === excludeLogin.toLowerCase()) {
    delete channels[gameId];
  }
  const stream = target.stream;
  if (!stream) {
    const where = drop.channels.length
      ? tr(state, "channelsOffline", { name: drop.benefits[0] || drop.name, game: drop.game?.name || tr(state, "gameWord") })
      : tr(state, "noLiveChannel", { game: drop.game?.name || tr(state, "gameWord") });
    return persist({
      ...base,
      phase: "no-channel",
      message: where,
      queue,
      watching: null,
      stickDropId: drop.id,
      scanCursor: target.scanCursor || 0,
      channels,
      missCount,
    });
  }

  if (!drop.channels.length) {
    channels[gameId] = { login: stream.login, channelId: stream.channelId };
  }
  const previousLogin = state.watching?.login || "";
  if (previousLogin && previousLogin.toLowerCase() !== stream.login.toLowerCase()) {
    const note = target.reason === "unique"
      ? tr(state, "uniqueSwitch", { login: stream.login })
      : tr(state, "wentOffline", { login: previousLogin || tr(state, "channelWord"), next: stream.login });
    base.log = pushLog(base, note);
  }

  let spadeUrl = base.spade?.login?.toLowerCase() === stream.login.toLowerCase() ? base.spade.url : "";
  if (!spadeUrl) spadeUrl = await discoverSpadeUrl(stream.login);
  const reusedPing = alreadyPinged === stream.login.toLowerCase() && state.lastPing?.ok;
  let ping = reusedPing
    ? state.lastPing
    : await sendMinuteWatched(auth, stream, spadeUrl);
  if (!ping.ok) {
    spadeUrl = await discoverSpadeUrl(stream.login);
    ping = await sendMinuteWatched(auth, stream, spadeUrl);
  }

  let progressNote = "";
  let shown = drop;
  const sameChannel = state.watching?.login?.toLowerCase() === stream.login.toLowerCase();
  try {
    const progress = await currentDrop(auth, stream.channelId);
    if (progress) {
      const tracked = campaigns.flatMap((campaign) => campaign.drops)
        .find((item) => item.id === progress.dropId);
      // Twitch отдаёт один дроп сессии (часто общий с большим процентом), а показываем тот, ради которого выбран канал.
      if (progress.dropId && tracked) tracked.current = progress.current;
      else if (!progress.dropId) drop.current = progress.current;
      shown = drop;
      missCount = 0;
      progressNote = tr(state, "outOf", { current: shown.current, required: shown.required });
    } else if (sameChannel) {
      missCount += 1;
      progressNote = tr(state, "minutePending");
    } else {
      progressNote = tr(state, "firstMinute");
    }
  } catch (error) {
    progressNote = error?.message || tr(state, "progressUnread");
  }

  const earned = await claimReady(auth, campaigns, state.lang);
  if (earned.claimed.length) base.log = pushLog(base, tr(state, "claimed", { names: earned.claimed.join(", ") }));
  if (earned.failed.length) base.log = pushLog(base, tr(state, "notClaimed", { names: earned.failed.join(", ") }));

  const pingText = ping.ok
    ? tr(state, "pingLog", { login: stream.login, status: ping.status })
    : tr(state, "pingRejected", { login: stream.login, status: ping.status });
  const claimNote = earned.claimed.length ? tr(state, "claimedCount", { count: earned.claimed.length }) : "";
  return persist({
    ...base,
    phase: ping.ok ? "watching" : "error",
    message: ping.ok
      ? `${shown.game?.name || ""} · ${shown.benefits[0] || shown.name} · ${stream.login} · ${progressNote}${claimNote}`
      : tr(state, "spadeRejected", { status: ping.status }),
    queue: applyPictures(
      buildQueue(campaigns, { ...knownOnline, ...(target.online || {}) }),
      await pagePictures(),
    ),
    games: gameRows(summaries, campaigns, whitelist),
    watching: watchingOf(shown, stream),
    lastPing: { at: Date.now(), ok: ping.ok, status: ping.status, via: ping.via },
    stickDropId: drop.id,
    channels,
    spade: { login: stream.login, url: spadeUrl },
    missCount,
    log: reusedPing ? base.log : pushLog(base, pingText),
  });
}

export { CONNECT_URL, INVENTORY_URL };
