const KEY = "settings";

export function defaultSettings() {
  // wishes — названия игр, добавленные вручную, пока у игры нет кампании (общие для всех аккаунтов).
  // soloTwitch — id игры, которую Twitch фармит непрерывно ("" — обычный режим).
  // soloKick — название игры Kick в том же смысле: у Kick игры идентифицируются названием.
  // soloKickCat — id категории этой игры: по названию Kick категорию не ищет, а кампании
  // могут закончиться, и тогда без id соло-режиму нечего смотреть.
  return { autoAll: false, blacklist: [], picked: [], wishes: [], soloTwitch: "", soloKick: "", soloKickCat: 0 };
}

export async function readSettings() {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY] || {};
  return {
    autoAll: Boolean(value.autoAll),
    blacklist: (value.blacklist || []).map(String),
    picked: (value.picked || []).map(String),
    wishes: (value.wishes || []).map(String),
    soloTwitch: String(value.soloTwitch || ""),
    soloKick: String(value.soloKick || ""),
    soloKickCat: Number(value.soloKickCat) || 0,
  };
}

export async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  for (const key of ["blacklist", "picked", "wishes"]) {
    if (!patch[key]) continue;
    const seen = new Map();
    for (const name of patch[key]) {
      const text = String(name).trim();
      if (text) seen.set(text.toLowerCase(), text);
    }
    next[key] = [...seen.values()];
  }
  for (const key of ["soloTwitch", "soloKick"]) {
    if (patch[key] === undefined) continue;
    next[key] = String(patch[key] || "").trim();
  }
  if (patch.soloKickCat !== undefined) next.soloKickCat = Number(patch.soloKickCat) || 0;
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function isBlocked(settings, name) {
  const key = String(name || "").trim().toLowerCase();
  return Boolean(key) && settings.blacklist.some((item) => item.toLowerCase() === key);
}

// Игра, которую площадка фармит непрерывно. Пусто — обычный режим: очередь дропов и список выбранных игр.
export function soloGame(settings, platform) {
  return String((platform === "kick" ? settings?.soloKick : settings?.soloTwitch) || "").trim();
}

// Та ли это игра. У Twitch id и название, у Kick — только название, поэтому сравниваем и id, и название.
export function isSolo(settings, platform, game) {
  const solo = soloGame(settings, platform).toLowerCase();
  if (!solo) return false;
  const id = String(game?.id ?? game?.gameId ?? "").toLowerCase();
  const name = String(typeof game === "string" ? game : game?.name || "").toLowerCase();
  return (platform !== "kick" && id === solo) || name === solo;
}
