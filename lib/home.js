// Аккаунт браузера при нескольких аккаунтах («все сразу»).
// Расширение уводит браузер на другой аккаунт, когда тому нужен integrity-токен Twitch (lib/side.js,
// needsMain). Когда он больше не нужен, браузер возвращается на «свой» аккаунт: выбранный в попапе,
// а в режиме «авто» — тот, на котором браузер был до смены (если его нет — самый старый из добавленных).
// Выбранный в попапе аккаунт ставится в браузер сразу, если браузер свободен, иначе — как только освободится.
// Вкладки пользователя при автосмене не перезагружаются (lib/accounts.js, lib/client.js).
// Kick браузер сейчас ни для чего не забирает (параллельные аккаунты работают по своим токенам),
// но правило то же: выбор в попапе возвращает куки выбранного, а будущая смена «ради браузера»
// пометит back так же, как Twitch, и вернётся сама.
import { addPending, readAccounts, returnId } from "./accounts.js";
import { claimKey } from "./keys.js";

// Сколько дать основному майнеру после смены ради integrity: открыть вкладку, получить токен, забрать.
export const MIN_AWAY = 3 * 60 * 1000;
// Дольше не ждём даже незабранного дропа: Twitch мог его не отдать, а браузер нужен владельцу.
export const MAX_AWAY = 30 * 60 * 1000;

// Готовые, но ещё не забранные дропы в очереди основного майнера: ради них браузер и уводили.
// Сундук, ждущий выбора награды человеком, не в счёт — его майнер не заберёт.
export function readyIds(state) {
  const choice = new Set((state?.rewardChoice || []).map((row) => row.id));
  return (state?.queue || []).filter((row) => !row.claimed && row.required > 0 && (row.current || 0) >= row.required
    && !choice.has(row.id) && (row.kind !== "reward" || row.status === "CLAIMABLE")).map((row) => claimKey(row));
}

export function claimWaiting(state) {
  return state?.phase === "claim-pending" || readyIds(state).length > 0;
}

// Ушли домой, а дроп аккаунта так и не забрался: снова уводить браузер ради ТЕХ ЖЕ дропов нельзя,
// иначе браузер ходил бы туда-обратно каждые 10–30 минут с перезагрузкой вкладок. Аккаунт снова
// получит браузер, только когда у него появится другой готовый дроп (тогда майнер заберёт все сразу).
const BLOCK = "homeBlock";
const BLOCK_TTL = 24 * 60 * 60 * 1000;

export async function readBlocks(now = Date.now()) {
  const stored = (await chrome.storage.local.get(BLOCK))[BLOCK] || {};
  return Object.fromEntries(Object.entries(stored).filter(([, entry]) => now - (entry?.at || 0) < BLOCK_TTL));
}

export async function blockAccount(id, ids, now = Date.now()) {
  if (!id || !ids?.length) return;
  const blocks = await readBlocks(now);
  blocks[id] = { at: now, ids: [...new Set(ids.map(String))] };
  await chrome.storage.local.set({ [BLOCK]: blocks });
}

// Что заблокировать при возврате домой: { account, ids } или null.
// Только после смены ради клейма (reason "auto"): при возврате к выбранному в попапе аккаунту блока нет —
// аккаунт, у которого дроп только что созрел, иначе остался бы без клейма на сутки.
// ids — дропы, ради которых уводили (back.need), и те, что всё ещё ждут клейма в очереди майнера.
// Уводили ради дропа, который в очереди уже забран, — его не блокируем.
export function returnBlock(side, state, target) {
  if (side?.back?.reason !== "auto" || !side.active || side.active === target) return null;
  const still = readyIds(state);
  const claimed = new Set((state?.queue || []).filter((row) => row.claimed).map((row) => claimKey(row)));
  const need = (side.back.need?.[side.active] || []).filter((key) => !claimed.has(key));
  const ids = [...new Set([...need, ...still])];
  return ids.length ? { account: side.active, ids } : null;
}

// Можно ли поднимать аккаунт ради integrity: нужен хотя бы один готовый дроп, которого нет в блоке.
// Ключи — claimKey: у повторяемого сундука блок вчерашней выдачи не держит сегодняшнюю.
// needIds нет вовсе (состояние старой версии) — причина неизвестна, блок не мешает. Пустой список —
// ждать нечего (пауза после отказа держит needsMain, а готовых дропов уже нет): не поднимаем.
export function promotable(id, farm, blocks) {
  if (!farm?.needsMain) return false;
  if (Array.isArray(farm.needIds) && !farm.needIds.length) return false;
  const blocked = blocks?.[id]?.ids;
  const need = (farm.needIds || []).map(String);
  if (!blocked?.length || !need.length) return true;
  return need.some((dropId) => !blocked.includes(dropId));
}

// Чем занят браузер. Пока занят — назад не переключаем.
async function busy(platform, side, now) {
  if (platform !== "twitch") return false;
  const { side: farms = {}, state = {} } = await chrome.storage.local.get(["side", "state"]);
  const blocks = await readBlocks(now);
  // Другой аккаунт ждёт integrity: браузер сейчас уйдёт к нему, возвращать рано.
  // Заблокированный (его дроп не забрался и в прошлый раз) не ждёт ничего — на него не смотрим.
  if (Object.entries(farms).some(([id, farm]) => id !== side.active && promotable(id, farm, blocks))) return true;
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
  const home = returnId(side);
  if (!home || home === side.active) return "";
  if (await addPending()) return "";
  if (await busy(platform, side, now)) return "";
  return home;
}
