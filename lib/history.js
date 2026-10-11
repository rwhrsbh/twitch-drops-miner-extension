// История клеймов: дропы Twitch и Kick, бонусы баллов каналов. Хранится локально, последние 300 записей.
const KEY = "history";
const LIMIT = 300;
let chain = Promise.resolve();

export async function readHistory() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] || [];
}

// kind: "drop" | "points"; platform: "twitch" | "kick".
export function addHistory(entry) {
  const run = chain.then(async () => {
    const list = await readHistory();
    const next = [{ at: Date.now(), ...entry }, ...list].slice(0, LIMIT);
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
  chain = run.catch(() => {});
  return run;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [KEY]: [] });
  return [];
}
