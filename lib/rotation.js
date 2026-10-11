// Смена аккаунта по очереди после прохода майнера.
// Переходим, когда закрыто нужное число кампаний, или когда активному аккаунту нечего фармить.
// «Нечего фармить» должно продержаться два прохода подряд, чтобы не прыгать из-за секундного простоя.
import { addPending, nextAccount, readAccounts, switchTo } from "./accounts.js";

const NOTHING = new Set(["all-claimed", "no-channel", "pick-game", "no-campaign", "not-linked"]);
let rotating = false;

// Счётчик простоя лежит в session: фоновый скрипт может уснуть между двумя проходами.
async function idleTicks() {
  return { twitch: 0, kick: 0, ...((await chrome.storage.session.get("rotateIdle")).rotateIdle || {}) };
}

async function setIdle(platform, count) {
  const ticks = await idleTicks();
  if (ticks[platform] === count) return;
  await chrome.storage.session.set({ rotateIdle: { ...ticks, [platform]: count } });
}

// state — состояние майнера платформы после прохода. Возвращает id аккаунта, на который перешли, или "".
export async function rotate(platform, state, hooks) {
  if (rotating || !state?.enabled || await addPending()) return "";
  const accounts = await readAccounts();
  if (accounts[platform].list.length < 2) return "";
  let target = await nextAccount(platform, "campaign");
  if (!target) {
    const idle = NOTHING.has(state.phase) ? (await idleTicks())[platform] + 1 : 0;
    await setIdle(platform, idle);
    if (idle < 2) return "";
    target = await nextAccount(platform, "nothing");
  }
  await setIdle(platform, 0);
  if (!target) return "";
  rotating = true;
  try {
    await switchTo(platform, target, hooks);
    return target;
  } finally {
    rotating = false;
  }
}

// Для тестов.
export function resetRotation() {
  chrome.storage.session.remove("rotateIdle");
  rotating = false;
}
