// Баллы каналов Twitch. Только для каналов, которые пользователь добавил сам.
//
// Расширение НЕ «смотрит» каналы ради баллов и не открывает видео. Проверено в октябре 2026:
// ни пинг minute-watched, ни запросы к плейлисту потока (способ Twitch-Channel-Points-Miner-v2)
// баллов не дают, Twitch начисляет их только настоящему плееру. К тому же второй «просмотр»
// сбивает набор минут дропа. Поэтому баллы живут отдельно от дропов и им не мешают:
// раз в 5 минут расширение читает баланс и забирает бонус, если Twitch его предлагает
// (бонус появляется, когда пользователь сам смотрит канал). Больше ничего.
// Проверяются каналы из списка пользователя и канал, на котором сейчас фармится дроп.
// По умолчанию сбор баллов выключен, включается в настройках.
import { channelPoints, claimPoints, getStream, readAuth } from "./client.js";
import { FEATURES } from "./constants.js";
import { addHistory } from "./history.js";

const KEY = "points";
const CHECK_MS = 5 * 60 * 1000;
const TICK_STALE = 3 * 60 * 1000;
let tickingAt = 0;

function defaults() {
  return { enabled: false, channels: [], status: {}, checkedAt: 0, updatedAt: 0 };
}

export async function readPoints() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...defaults(), ...(stored[KEY] || {}) };
}

async function save(patch) {
  const fresh = await readPoints();
  const next = { ...fresh, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

function clean(channels) {
  const seen = new Map();
  for (const channel of channels || []) {
    const login = String(channel?.login || "").trim().toLowerCase();
    if (!login) continue;
    seen.set(login, {
      login,
      id: String(channel.id || ""),
      name: channel.name || login,
      image: channel.image || "",
    });
  }
  return [...seen.values()];
}

// Список изменился или баллы включили: проверяем сразу, не дожидаясь пяти минут.
export async function setPointsChannels(channels) {
  const next = await save({ channels: clean(channels), checkedAt: 0 });
  pointsTick();
  return next;
}

export async function setPointsEnabled(enabled) {
  const next = await save({ enabled: Boolean(enabled), checkedAt: 0 });
  pointsTick();
  return next;
}

// Список каналов и статусы целиком (смена аккаунта).
export async function replacePoints(channels) {
  return save({ channels: clean(channels), status: {}, checkedAt: 0 });
}

// Версия 1.7.0 до релиза открывала для баллов вкладки с плеером. Если такие остались, закрываем их один раз.
async function closeLegacyTabs() {
  const stored = await chrome.storage.local.get("pointsTabs");
  if (!stored.pointsTabs) return;
  // Номер вкладки после перезапуска браузера может достаться чужой вкладке: закрываем только Twitch.
  for (const id of Object.values(stored.pointsTabs)) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (/^https:\/\/(www\.)?twitch\.tv\//.test(tab?.url || "")) await chrome.tabs.remove(id).catch(() => null);
  }
  await chrome.storage.local.remove("pointsTabs");
}

// Вызывается каждую минуту вместе с проходом майнера, но работает раз в 5 минут.
export async function pointsTick() {
  // Отключено целиком, см. FEATURES в constants.js. Вкладки старой сборки всё равно закрываем.
  if (!FEATURES.twitchPoints) {
    await closeLegacyTabs().catch(() => {});
    return readPoints();
  }
  if (tickingAt && Date.now() - tickingAt < TICK_STALE) return readPoints();
  tickingAt = Date.now();
  try {
    return await run();
  } catch {
    return readPoints();
  } finally {
    tickingAt = 0;
  }
}

async function run() {
  await closeLegacyTabs();
  const state = await readPoints();
  if (!state.enabled) return state;
  const miner = (await chrome.storage.local.get("state")).state || {};
  if (miner.enabled === false) return state;
  // Канал, где сейчас фармится дроп, проверяем заодно, даже если его нет в списке.
  const dropLogin = String(miner.watching?.login || "").toLowerCase();
  const list = [...state.channels];
  if (dropLogin && !list.some((channel) => channel.login === dropLogin)) {
    list.push({ login: dropLogin, id: String(miner.watching.channelId || ""), name: miner.watching.login, image: "", drop: true });
  }
  if (!list.length) return state;
  // Сменился канал дропа: проверяем сразу, а не через пять минут.
  const fresh = dropLogin && dropLogin !== state.dropLogin;
  if (!fresh && Date.now() - (state.checkedAt || 0) < CHECK_MS) return state;
  const auth = await readAuth();
  if (!auth) return state;

  // Статусы только для проверяемых каналов: убранные не копятся.
  const status = Object.fromEntries(list.map((channel) => [channel.login, { ...(state.status?.[channel.login] || {}), drop: Boolean(channel.drop) }]));
  for (const channel of list) {
    const entry = status[channel.login];
    entry.error = "";
    try {
      const stream = await getStream(auth, channel.login);
      entry.live = Boolean(stream);
      // Вне эфира бонусов не бывает, а баланс не меняется: лишний запрос не делаем.
      if (!stream && typeof entry.balance === "number") continue;
      const points = await channelPoints(auth, channel.login);
      if (!points) continue;
      entry.balance = points.balance;
      entry.enabled = points.enabled;
      if (points.claimId) {
        const result = await claimPoints(auth, points.channelId || stream?.channelId || channel.id, points.claimId);
        const gained = result.gained || Math.max(0, result.balance - points.balance);
        entry.balance = result.balance || points.balance + gained;
        entry.claimedAt = Date.now();
        entry.lastGain = gained;
        await addHistory({
          kind: "points",
          platform: "twitch",
          account: auth.login,
          name: `+${gained}`,
          game: channel.name,
          image: channel.image,
          amount: gained,
        });
      }
    } catch (error) {
      entry.error = String(error?.message || error).slice(0, 100);
    }
  }
  return save({ status, checkedAt: Date.now(), dropLogin });
}
