const KEY = "settings";

export function defaultSettings() {
  return { autoAll: false, blacklist: [], picked: [] };
}

export async function readSettings() {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY] || {};
  return {
    autoAll: Boolean(value.autoAll),
    blacklist: (value.blacklist || []).map(String),
    picked: (value.picked || []).map(String),
  };
}

export async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  for (const key of ["blacklist", "picked"]) {
    if (!patch[key]) continue;
    const seen = new Map();
    for (const name of patch[key]) {
      const text = String(name).trim();
      if (text) seen.set(text.toLowerCase(), text);
    }
    next[key] = [...seen.values()];
  }
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function isBlocked(settings, name) {
  const key = String(name || "").trim().toLowerCase();
  return Boolean(key) && settings.blacklist.some((item) => item.toLowerCase() === key);
}
