// Одновременный фарм остальных аккаунтов Kick (режим «Все сразу»).
//
// Kick принимает запросы по Bearer-токену из заголовка, куки браузера ему не нужны: поэтому каждый
// сохранённый аккаунт фармит параллельно по своему токену. На аккаунт один сокет «просмотра» ради дропа
// и до двух сокетов на каналы баллов. Активным аккаунтом (под которым залогинен браузер) по-прежнему
// занимается lib/kick.js.
import { readAccounts } from "./accounts.js";
import { FEATURES } from "./constants.js";
import { addHistory } from "./history.js";
import { kickOpen, kickPlan, kickStillLive, kickTarget, kickViewer } from "./kick.js";
import { cleanKickChannels, pointsPass } from "./kickpoints.js";
import { createWatchers } from "./kicksocket.js";
import { readPoints } from "./points.js";
import { readSettings } from "./settings.js";

const KEY = "kickSide";
const STALL_MS = 8 * 60 * 1000;
const TICK_STALE = 4 * 60 * 1000;
const pings = new Map();
const watchers = createWatchers((key) => pings.set(key, Date.now()));
let tickingAt = 0;
// Клик по дропу пришёл посреди прохода: после него сразу идёт ещё один.
let again = false;

export async function readKickSide() {
  return (await chrome.storage.local.get(KEY))[KEY] || {};
}

async function clear() {
  watchers.stopAll();
  pings.clear();
  if (Object.keys(await readKickSide()).length) await chrome.storage.local.set({ [KEY]: {} });
  return {};
}

function bearer(account) {
  const raw = (account.cookies || []).find((item) => item.name === "session_token")?.value || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function farm(account, settings, previous, pointsOn) {
  const now = Date.now();
  const dropKey = `${account.id}:drop`;
  const pointsPrefix = `${account.id}:p:`;
  // preferDropId — дроп, который пользователь выбрал кликом в очереди этого аккаунта.
  const preferId = previous?.preferDropId || "";
  const base = { login: account.login, watching: null, queue: [], updatedAt: now, preferDropId: preferId };
  const token = bearer(account);
  if (!token) return { ...base, phase: "need-login" };
  const picked = new Set((account.picked || []).map((name) => String(name).toLowerCase()));

  let watching = null;
  let rows = [];
  let stall = null;
  let phase = "pick-game";
  if (settings.autoAll || picked.size) {
    const plan = await kickPlan(token, picked, settings);
    rows = plan.rows;
    for (const row of plan.claimed) {
      await addHistory({ kind: "drop", platform: "kick", account: account.login, name: row.name, game: row.game, image: row.image });
    }
    const open = kickOpen(rows, picked);
    const before = previous?.watching || null;
    const current = before && open.find((row) => row.id === before.dropId);
    // Минуты не растут 8 минут при живом сокете: меняем канал.
    let skip = "";
    stall = previous?.stall || null;
    if (current) {
      if (!stall || stall.dropId !== current.id || current.current > stall.units) {
        stall = { dropId: current.id, units: current.current, since: now };
      } else if (now - stall.since >= STALL_MS) {
        skip = before.login;
        stall = { ...stall, since: now };
      }
    }
    const socket = watchers.get(dropKey);
    const wanted = preferId && preferId !== before?.dropId && open.some((row) => row.id === preferId);
    if (current && !skip && !wanted && watchers.alive(dropKey) && socket.login === before.login
      && await kickStillLive(before.login, current.categoryId)) {
      watching = { ...before, current: current.current, required: current.required, image: current.image, campaignImage: current.campaignImage };
    } else {
      const target = open.length ? await kickTarget(rows, picked, plan.maps, skip, preferId) : null;
      if (target) {
        watchers.open(dropKey, await kickViewer(token), target.live);
        watching = {
          dropId: target.row.id,
          name: target.row.name,
          game: target.row.game,
          login: target.live.login,
          current: target.row.current,
          required: target.row.required,
          exclusive: target.row.channels.length > 0,
          image: target.row.image,
          campaignImage: target.row.campaignImage,
        };
        stall = { dropId: target.row.id, units: target.row.current, since: now };
      } else {
        watchers.close(dropKey);
      }
    }
    if (watching) phase = "watching";
    else if (open.length) phase = "no-channel";
    else if (rows.some((row) => !row.linked && !row.claimed)) phase = "not-linked";
    else phase = "all-claimed";
  } else {
    watchers.close(dropKey);
  }

  let points = null;
  if (pointsOn) {
    points = await pointsPass({
      token,
      viewer: () => kickViewer(token),
      channels: cleanKickChannels(account.points),
      dropLogin: watching?.login || "",
      previous: previous?.points || {},
      prefix: pointsPrefix,
      account: account.login,
      own: false,
    }, watchers).catch(() => previous?.points || null);
  } else {
    watchers.stopAll(pointsPrefix);
  }
  return { ...base, phase, watching, queue: rows, stall, points, lastPing: pings.get(dropKey) || 0 };
}

// Вызывается раз в минуту после прохода основного майнера Kick.
export async function kickSideTick() {
  if (tickingAt && Date.now() - tickingAt < TICK_STALE) return readKickSide();
  tickingAt = Date.now();
  try {
    const data = await readAccounts();
    const kick = (await chrome.storage.local.get("kick")).kick || {};
    const others = data.kick.list.filter((item) => item.id !== data.kick.active && !item.expired);
    if (data.rotate.mode !== "all" || kick.enabled === false || !data.kick.active || !others.length) return clear();
    const settings = await readSettings();
    const pointsOn = FEATURES.kickPoints && Boolean((await readPoints()).enabled);
    const previous = await readKickSide();
    const next = {};
    for (const account of others) {
      try {
        next[account.id] = await farm(account, settings, previous[account.id], pointsOn);
      } catch (error) {
        const text = String(error?.message || error);
        next[account.id] = {
          ...(previous[account.id] || {}),
          login: account.login,
          updatedAt: Date.now(),
          // 401/403: сохранённая сессия больше не действует.
          phase: /HTTP 40[13]/.test(text) ? "need-login" : "error",
          message: text.slice(0, 120),
        };
        if (next[account.id].phase === "need-login") {
          next[account.id].watching = null;
          watchers.stopAll(`${account.id}:`);
        }
      }
    }
    // Аккаунт убрали, сделали активным или его сессия умерла: его сокеты закрываем.
    for (const key of watchers.keys()) if (!next[key.split(":")[0]]) watchers.close(key);
    // Клик по дропу мог прийти, пока шёл проход: его выбор не теряем.
    const latest = await readKickSide();
    for (const id of Object.keys(next)) {
      if (latest[id] && latest[id].preferDropId !== previous[id]?.preferDropId) next[id].preferDropId = latest[id].preferDropId || "";
    }
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  } finally {
    tickingAt = 0;
    if (again) {
      again = false;
      kickSideTick().catch(() => {});
    }
  }
}

// Клик по дропу в очереди параллельного аккаунта: фармить именно его.
export async function watchKickSideDrop(id, dropId) {
  const all = await readKickSide();
  if (!all[id]) return all;
  all[id] = { ...all[id], preferDropId: dropId };
  await chrome.storage.local.set({ [KEY]: all });
  if (tickingAt) again = true;
  else kickSideTick().catch(() => {});
  return all;
}

// Для тестов.
export function resetKickSide() {
  watchers.stopAll();
  pings.clear();
  tickingAt = 0;
  again = false;
}
