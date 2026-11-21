// Аккаунт браузера при нескольких аккаунтах («все сразу»).
// Расширение уводит браузер на другой аккаунт, когда тому нужен integrity-токен Twitch (lib/side.js,
// needsMain). Когда он больше не нужен, браузер возвращается на «свой» аккаунт: выбранный в попапе,
// а в режиме «авто» — самый старый из добавленных. Выбранный в попапе аккаунт ставится в браузер
// сразу, если браузер свободен, иначе — как только освободится.
// Kick браузер сейчас ни для чего не забирает (параллельные аккаунты работают по своим токенам),
// но правило то же: выбор в попапе возвращает куки выбранного, а будущая смена «ради браузера»
// пометит back так же, как Twitch, и вернётся сама.
import { addPending, homeId, readAccounts } from "./accounts.js";

// Сколько дать основному майнеру после смены ради integrity: открыть вкладку, получить токен, забрать.
export const MIN_AWAY = 3 * 60 * 1000;
// Дольше не ждём даже незабранного дропа: Twitch мог его не отдать, а браузер нужен владельцу.
export const MAX_AWAY = 30 * 60 * 1000;

// Готовый, но ещё не забранный дроп в очереди основного майнера: ради него браузер и уводили.
// Сундук, ждущий выбора награды человеком, не в счёт — его майнер не заберёт.
export function claimWaiting(state) {
  if (state?.phase === "claim-pending") return true;
  const choice = new Set((state?.rewardChoice || []).map((row) => row.id));
  return (state?.queue || []).some((row) => !row.claimed && row.required > 0 && (row.current || 0) >= row.required
    && !choice.has(row.id) && (row.kind !== "reward" || row.status === "CLAIMABLE"));
}

// Чем занят браузер. Пока занят — назад не переключаем.
async function busy(platform, side, now) {
  if (platform !== "twitch") return false;
  const { side: farms = {}, state = {} } = await chrome.storage.local.get(["side", "state"]);
  // Другой аккаунт ждёт integrity: браузер сейчас уйдёт к нему, возвращать рано.
  if (Object.entries(farms).some(([id, farm]) => id !== side.active && farm?.needsMain)) return true;
  if (side.back?.reason !== "auto") return false;
  const away = now - (side.back.at || 0);
  if (away < MIN_AWAY) return true;
  return away < MAX_AWAY && claimWaiting(state);
}

// Куда вернуть браузер сейчас: id аккаунта или "" — оставить как есть.
export async function homeTarget(platform, now = Date.now()) {
  const data = await readAccounts();
  // В режимах по очереди аккаунт браузера и есть фармящий: возвращать его некуда.
  if (data.rotate.mode !== "all") return "";
  const side = data[platform];
  if (!side?.back || side.list.length < 2) return "";
  const home = homeId(side);
  if (!home || home === side.active) return "";
  if (await addPending()) return "";
  if (await busy(platform, side, now)) return "";
  return home;
}
