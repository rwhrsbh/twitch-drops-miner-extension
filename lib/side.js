// Одновременный фарм остальных аккаунтов Twitch (режим «Все сразу»).
//
// Активный аккаунт — тот, под которым залогинен браузер: им занимается основной майнер (lib/miner.js).
// Остальным аккаунтам куки браузера не нужны: все запросы Twitch идут с токеном в заголовке, поэтому
// каждый из них фармит параллельно по своему сохранённому токену. Integrity-заголовки берутся из вкладки
// Twitch и привязаны к аккаунту браузера, поэтому здесь запросы идут без них.
//
// Список кампаний без integrity Twitch не отдаёт, поэтому состав кампаний берётся из каталога основного
// майнера (кампании от аккаунта не зависят), а свой прогресс аккаунт читает из инвентаря.
//
// Клейм дропа без integrity Twitch отклоняет. Тогда аккаунт просит сделать его активным: расширение
// подменяет куки, основной майнер получает integrity уже для него и забирает дроп, а прежний активный
// продолжает фармить здесь. Просит только ради клейма и не чаще раза в 10 минут на всех, чтобы аккаунты
// не менялись местами без конца; пока ждёт, продолжает набирать минуты следующего дропа.
import {
  applyInventory,
  applyRewardProgress,
  authFromToken,
  currentDrop,
  getStream,
  sendMinuteWatched,
  sendWatch,
} from "./client.js";
import { buildQueue, chooseTarget, claimReady, readCatalog, unmetWishes, wantSideGames, watchingOf, wishedGames } from "./miner.js";
import { readAccounts, setSelection } from "./accounts.js";
import { promotable, readBlocks } from "./home.js";
import { claimKey } from "./keys.js";
import { isBlocked, readSettings, soloGame } from "./settings.js";

const KEY = "side";
const AUTH_TTL = 10 * 60 * 1000;
const CAMPAIGN_TTL = 2 * 60 * 1000;
const CATALOG_MAX_AGE = 10 * 60 * 1000;
const PROMOTE_GAP = 10 * 60 * 1000;
const STALL_MS = 10 * 60 * 1000;
const BENCH_MS = 30 * 60 * 1000;
const TICK_STALE = 4 * 60 * 1000;
const PICK_HOLD = 5 * 60 * 1000;
const ORPHAN_GRACE = 3 * 60 * 1000;
// id аккаунта -> { auth, authAt, campaigns, at, stream, stall, strikes, bench, skip, claimHold, pickHold, needIds, choice }
const memory = new Map();
// Что из этого должно пережить остановку фонового скрипта (он засыпает между проходами): без этого
// сторож никогда не досчитал бы до 10 минут, а паузы после отказа сбрасывались бы.
// needIds и choice живут вместе с claimHold: после перезапуска воркера пауза держится, и причина тоже.
const GUARD = ["stream", "stall", "strikes", "bench", "claimHold", "pickHold", "needIds", "choice"];

function guardOf(id) {
  const slot = memory.get(id);
  return slot ? Object.fromEntries(GUARD.filter((key) => slot[key] != null).map((key) => [key, slot[key]])) : undefined;
}

// Свой X-Device-Id для аккаунта, у которого кука unique_id не сохранилась: общий id связал бы аккаунты.
async function ownDevice(id) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`drops-device:${id}`)));
  return [...bytes].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
let tickingAt = 0;

export async function readSide() {
  return (await chrome.storage.local.get(KEY))[KEY] || {};
}

async function clear() {
  wantSideGames([], false);
  memory.clear();
  if (Object.keys(await readSide()).length) await chrome.storage.local.set({ [KEY]: {} });
  return {};
}

function saved(account, name) {
  return (account.cookies || []).find((item) => item.name === name)?.value || "";
}

function others(data) {
  return data.twitch.list.filter((item) => item.id !== data.twitch.active && !item.expired);
}

// До прохода основного майнера: какие игры выбраны у остальных аккаунтов. Без этого после перезапуска
// фонового скрипта каталог первый проход собирался бы без их кампаний.
// Игры, добавленные аккаунту по названию, пока кампании не было: как только Twitch показал игру с таким
// названием (список игр ведёт основной майнер), она попадает в список аккаунта.
async function resolveWishes(rest) {
  const games = (await chrome.storage.local.get("state")).state?.games || [];
  if (!games.length) return false;
  let changed = false;
  for (const account of rest) {
    if (!account.wishes?.length) continue;
    const found = wishedGames(account.wishes, games.map((game) => ({ game })), account.whitelist);
    const whitelist = [...(account.whitelist || []).map(String), ...found];
    const wishes = unmetWishes(account.wishes, games, whitelist);
    if (!found.length && wishes.length === account.wishes.length) continue;
    await setSelection("twitch", account.id, { whitelist, wishes });
    changed = true;
  }
  return changed;
}

// Игры для каталога: выбор аккаунтов плюс соло-игра — она фармится у всех, даже если не выбрана.
async function catalogGames(rest) {
  const ids = rest.flatMap((item) => item.whitelist || []);
  const solo = soloGame(await readSettings(), "twitch");
  return solo ? [...ids, solo] : ids;
}

export async function primeSide() {
  let data = await readAccounts();
  if (data.rotate.mode === "all" && (await resolveWishes(others(data)).catch(() => false))) data = await readAccounts();
  const rest = others(data);
  if (data.rotate.mode === "all" && rest.length) wantSideGames(await catalogGames(rest), true);
}

// Канал, который основной майнер нашёл для соло-игры. Живёт в storage: фоновый скрипт засыпает.
async function readSoloHint() {
  const { soloHint } = await chrome.storage.local.get("soloHint");
  if (!soloHint || !soloHint.login) return null;
  return Date.now() - (soloHint.at || 0) < 30 * 60 * 1000 ? soloHint : null;
}

// Минуты дропа не растут 10 минут: сначала другой канал, потом кампания откладывается на полчаса
// (игра не привязана к этому аккаунту, недоступна в регионе и т. п.).
function watchdog(slot, campaigns, watching, now) {
  slot.bench = Object.fromEntries(Object.entries(slot.bench || {}).filter(([, until]) => until > now));
  slot.skip = "";
  if (!watching) {
    slot.stall = null;
    return;
  }
  const drop = campaigns.flatMap((campaign) => campaign.drops).find((item) => item.id === watching.dropId);
  if (!drop) {
    slot.stall = null;
    return;
  }
  const units = campaigns.filter((campaign) => campaign.id === drop.campaignId)
    .flatMap((campaign) => campaign.drops)
    .reduce((sum, item) => sum + (item.claimed ? item.required : item.current || 0), 0);
  if (!slot.stall || slot.stall.dropId !== drop.id || units > slot.stall.units) {
    if (slot.stall?.dropId === drop.id) slot.strikes = 0;
    slot.stall = { dropId: drop.id, units, since: now };
    return;
  }
  if (now - slot.stall.since < STALL_MS) return;
  slot.stall = { ...slot.stall, since: now };
  slot.strikes = (slot.strikes || 0) + 1;
  if (slot.strikes >= 2) {
    slot.bench[drop.campaignId] = now + BENCH_MS;
    slot.strikes = 0;
  } else {
    slot.skip = watching.login;
  }
}

async function farm(account, settings, previous, lang) {
  const now = Date.now();
  const slot = memory.get(account.id) || { ...(previous?.guard || {}) };
  memory.set(account.id, slot);
  // preferDropId — дроп, который пользователь выбрал кликом в очереди этого аккаунта.
  const base = { login: account.login, watching: null, updatedAt: now, preferDropId: previous?.preferDropId || "" };
  if (!slot.auth || now - slot.authAt > AUTH_TTL) {
    slot.auth = await authFromToken(saved(account, "auth-token"), saved(account, "unique_id") || (await ownDevice(account.id)));
    slot.authAt = now;
  }
  const auth = slot.auth;
  if (!auth) return { ...base, phase: "need-login" };

  const whitelist = (account.whitelist || []).map(String);
  // Непрерывный фарм одной игры: выбор игр и автомайнинг аккаунта больше ничего не решают.
  const solo = soloGame(settings, "twitch");
  if (!solo && !settings.autoAll && !whitelist.length) return { ...base, phase: "pick-game" };
  const catalog = readCatalog();
  const freshCatalog = Boolean(catalog.at) && now - catalog.at <= CATALOG_MAX_AGE;
  if (!freshCatalog && !solo) {
    // Каталога ещё нет (фоновый скрипт только что перезапустился): минуту показываем прежнее.
    if (!catalog.at && previous?.watching && now - (previous.updatedAt || 0) < 3 * 60 * 1000) return previous;
    return { ...base, phase: "waiting" };
  }
  // Соло-режим живёт подсказкой канала от основного майнера, каталог ему не нужен.
  if (!freshCatalog) slot.campaigns = [];
  if (freshCatalog && (!slot.campaigns || now - slot.at > CAMPAIGN_TTL || (slot.catalogAt !== catalog.at && now - slot.at > 60000))) {
    const picked = (campaign) => whitelist.includes(String(campaign.game.id));
    const soloKey = solo.toLowerCase();
    const pool = catalog.campaigns.filter((campaign) => {
      // У reward-кампании категорий бывает несколько: соло-игра может быть не первой.
      if (soloKey) return [campaign.game, ...(campaign.games || [])].some((game) => String(game?.id || "").toLowerCase() === soloKey);
      return settings.autoAll
        ? picked(campaign) || (campaign.linked && !isBlocked(settings, campaign.game.name))
        : picked(campaign);
    });
    // Привязку игры к этому аккаунту без integrity не узнать: выбранные игры считаем привязанными.
    // Если это не так, минуты не пойдут и сторож ниже отложит кампанию.
    const campaigns = structuredClone(pool).map((campaign) => (picked(campaign) ? { ...campaign, linked: true } : campaign));
    await applyInventory(auth, campaigns);
    await applyRewardProgress(auth, campaigns);
    // Сундук, чей прогресс Twitch не отдал этому аккаунту, не фармим вслепую (минуты не видны, сторож
    // потратил бы 20 минут): остаётся только у активного аккаунта.
    for (const campaign of campaigns) campaign.drops = campaign.drops.filter((drop) => !drop.unknown);
    slot.campaigns = campaigns.filter((campaign) => campaign.drops.length);
    slot.at = now;
    slot.catalogAt = catalog.at;
  }
  const campaigns = slot.campaigns || [];

  // Готовый дроп без integrity не забрать: просим сделать аккаунт активным, а пока фармим дальше.
  // Отклонённый клейм не повторяем каждую минуту: до смены аккаунта он будет отклонён снова.
  let needsMain = (slot.claimHold || 0) > now;
  if (!needsMain) {
    // Свой токен прохода: защита отметки своего клейма не должна зависеть от прохода основного майнера.
    const earned = await claimReady(auth, campaigns, lang, { pass: `side:${account.id}:${now}` });
    // После клейма состав дропов меняется: в следующий раз кампании читаются заново.
    if (earned.claimed.length) slot.at = 0;
    // Сундук с выбором награды: выбирает человек в инвентаре Twitch этого аккаунта, integrity тут не поможет.
    slot.choice = earned.choice || [];
    needsMain = earned.failed.some((text) => /integrity/i.test(text));
    if (needsMain) slot.claimHold = now + PROMOTE_GAP;
  }
  // Ради каких дропов нужен браузер: по ним lib/home.js не даёт поднимать аккаунт снова, если в прошлый
  // раз они так и не забрались. Считаем на каждом проходе и во время паузы (без запросов к Twitch):
  // созревший новый дроп должен снять блок сразу, а не через 10 минут.
  const choiceIds = new Set((slot.choice || []).map((row) => row.id));
  slot.needIds = needsMain
    ? campaigns.flatMap((campaign) => campaign.drops)
      .filter((drop) => !drop.claimed && drop.required > 0 && drop.current >= drop.required && !choiceIds.has(drop.id)
        && (drop.kind !== "reward" || drop.status === "CLAIMABLE"))
      .map((drop) => claimKey(drop))
    : [];
  base.needIds = slot.needIds;
  base.rewardChoice = slot.choice || [];

  watchdog(slot, campaigns, previous?.watching, now);
  const pick = () => chooseTarget(auth, campaigns, now, {
    login: slot.skip ? "" : previous?.watching?.login || "",
    dropId: slot.skip ? "" : previous?.stickDropId || "",
    preferDropId: previous?.preferDropId || "",
    excludeLogin: slot.skip || "",
    scanCursor: previous?.scanCursor || 0,
    priorityGames: whitelist,
    bench: slot.bench,
  });
  // Поиск канала упёрся в integrity (каталог игры): это не повод менять аккаунт. Держим прежний канал
  // и пять минут не ищем заново, чтобы не слать отклоняемый запрос каждую минуту.
  const held = async () => {
    if (previous?.watching && slot.stream) {
      const ping = await sendMinuteWatched(auth, slot.stream, "");
      return { ...previous, updatedAt: now, needsMain, needIds: base.needIds, rewardChoice: base.rewardChoice, phase: ping.ok ? "watching" : "error", lastPing: ping.ok ? { at: Date.now(), ok: true } : previous.lastPing || null };
    }
    return { ...base, needsMain, phase: needsMain ? "needs-main" : "no-channel" };
  };
  if ((slot.pickHold || 0) > now) return held();
  let target;
  try {
    target = await pick();
  } catch (error) {
    if (!/integrity/i.test(String(error?.message || error))) throw error;
    slot.pickHold = now + PICK_HOLD;
    return held();
  }
  // Очередь этого аккаунта: её показывает вкладка Twitch, когда в попапе выбран этот аккаунт.
  base.queue = buildQueue(campaigns, target.online || {});
  base.needsMain = needsMain;
  const drop = target.drop;
  const idle = needsMain ? "needs-main" : null;
  if (!drop) {
    // Соло: дропов игры нет — держим канал, который нашёл основной майнер (он фармит ту же игру).
    // Каталог игры без integrity этому аккаунту не посмотреть, а канал в эфире проверить можно.
    if (solo) {
      const hint = await readSoloHint();
      const login = (hint && String(hint.gameId) === String(solo) ? hint.login : "") || previous?.watching?.login || "";
      const stream = login ? await getStream(auth, login).catch(() => null) : null;
      const inGame = stream && String(stream.game?.id || "") === String(solo);
      if (inGame) {
        slot.stream = stream;
        const ping = await sendMinuteWatched(auth, stream, "");
        return {
          ...base,
          phase: ping.ok ? "watching" : "error",
          watching: {
            solo: true,
            kind: hint?.kind || "any",
            dropId: "",
            name: hint?.name || "",
            game: hint?.name || "",
            gameId: String(solo),
            login: stream.login,
            current: 0,
            required: 0,
            image: "",
            campaignImage: "",
          },
          lastPing: ping.ok ? { at: Date.now(), ok: true } : previous?.lastPing || null,
        };
      }
    }
    slot.stream = null;
    if (solo) return { ...base, phase: idle || "no-channel" };
    return { ...base, phase: idle || (campaigns.length ? "all-claimed" : "no-campaign") };
  }
  const stream = target.stream;
  if (!stream) {
    slot.stream = null;
    return { ...base, phase: idle || "no-channel", stickDropId: drop.id, scanCursor: target.scanCursor || 0 };
  }

  slot.stream = stream;
  const ping = await sendMinuteWatched(auth, stream, "");
  try {
    const progress = await currentDrop(auth, stream.channelId);
    const tracked = progress?.dropId
      ? campaigns.flatMap((campaign) => campaign.drops).find((item) => item.id === progress.dropId)
      : null;
    if (tracked) tracked.current = progress.current;
    else if (progress && !progress.dropId) drop.current = progress.current;
  } catch {
    // Минуты остаются теми, что Twitch отдал в кампаниях.
  }
  return {
    ...base,
    phase: ping.ok ? "watching" : "error",
    watching: watchingOf(drop, stream),
    lastPing: ping.ok ? { at: Date.now(), ok: true } : previous?.lastPing || null,
    stickDropId: drop.id,
    scanCursor: target.scanCursor || 0,
  };
}

// Кого сделать активным. Не чаще раза в 10 минут на всех; из нескольких ждущих первым идёт тот,
// кого дольше не делали активным. urgent — активного аккаунта нет вовсе, ждать нечего.
export async function choosePromotion(waiting, now = Date.now(), urgent = false) {
  if (!waiting.length) return "";
  const { sidePromo = {} } = await chrome.storage.session.get("sidePromo");
  if (!urgent && now - (sidePromo.at || 0) < PROMOTE_GAP) return "";
  const stamps = sidePromo.by || {};
  const id = [...waiting].sort((left, right) => (stamps[left] || 0) - (stamps[right] || 0))[0];
  await chrome.storage.session.set({ sidePromo: { at: now, by: { ...stamps, [id]: now } } });
  return id;
}

// Вызывается раз в минуту после прохода основного майнера.
// Возвращает { switchTo: id }, если какой-то аккаунт пора сделать активным.
export async function sideTick() {
  if (tickingAt && Date.now() - tickingAt < TICK_STALE) return {};
  tickingAt = Date.now();
  try {
    const data = await readAccounts();
    const state = (await chrome.storage.local.get("state")).state || {};
    const rest = others(data);
    if (data.rotate.mode !== "all" || state.enabled === false || !rest.length) {
      await clear();
      return {};
    }
    // Активный аккаунт вышел или его сессия умерла: без него нет каталога кампаний, и встали бы все.
    // Активным становится первый рабочий из сохранённых.
    // Не сразу: пользователь мог выйти на сайте, чтобы войти заново руками, и подмена кук сбила бы ему вход.
    const active = data.twitch.list.find((item) => item.id === data.twitch.active);
    const { sideOrphan = 0 } = await chrome.storage.session.get("sideOrphan");
    if (!active || active.expired) {
      const now = Date.now();
      if (!sideOrphan) await chrome.storage.session.set({ sideOrphan: now });
      if (!sideOrphan || now - sideOrphan < ORPHAN_GRACE) return {};
      const id = await choosePromotion([rest[0].id], now, true);
      return id ? { switchTo: id } : {};
    }
    if (sideOrphan) await chrome.storage.session.remove("sideOrphan");
    // Кампании выбранных здесь игр основной майнер добавит в каталог (соло-игра — тоже).
    wantSideGames(await catalogGames(rest), true);
    const settings = await readSettings();
    const previous = await readSide();
    const next = {};
    for (const account of rest) {
      try {
        next[account.id] = { ...(await farm(account, settings, previous[account.id], state.lang)), guard: guardOf(account.id) };
      } catch (error) {
        next[account.id] = {
          login: account.login,
          watching: null,
          updatedAt: Date.now(),
          preferDropId: previous[account.id]?.preferDropId || "",
          phase: "error",
          message: String(error?.message || error).slice(0, 120),
          guard: guardOf(account.id),
        };
      }
    }
    for (const id of [...memory.keys()]) if (!next[id]) memory.delete(id);
    // Клик по дропу мог прийти, пока шёл проход: его выбор не теряем.
    const latest = await readSide();
    for (const id of Object.keys(next)) {
      if (latest[id] && latest[id].preferDropId !== previous[id]?.preferDropId) {
        next[id].preferDropId = latest[id].preferDropId || "";
        if (next[id].preferDropId) next[id].stickDropId = next[id].preferDropId;
      }
    }
    await chrome.storage.local.set({ [KEY]: next });
    // Аккаунт, чьи дропы не забрались и в прошлый раз, ждёт нового готового дропа (lib/home.js).
    const blocks = await readBlocks();
    const id = await choosePromotion(Object.keys(next).filter((key) => promotable(key, next[key], blocks)));
    return id ? { switchTo: id } : {};
  } finally {
    tickingAt = 0;
  }
}

// Клик по дропу в очереди параллельного аккаунта: фармить именно его.
export async function watchSideDrop(id, dropId) {
  const all = await readSide();
  if (!all[id]) return all;
  all[id] = { ...all[id], preferDropId: dropId, stickDropId: dropId };
  await chrome.storage.local.set({ [KEY]: all });
  return all;
}

// Между минутными проходами: ещё один заход на плейлист, как у основного майнера.
export async function sideWatch() {
  for (const slot of memory.values()) {
    if (slot.auth && slot.stream) await sendWatch(slot.auth, slot.stream).catch(() => false);
  }
}

// Для тестов.
export function resetSide() {
  memory.clear();
  tickingAt = 0;
}
