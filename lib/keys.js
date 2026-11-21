// Ключ отметки клейма. У повторяемой reward-группы id один на все дни, поэтому отметка привязана
// к окну Twitch. Окна нет — к шестичасовому отрезку: часовой пояс сброса у Twitch неизвестен,
// и сутки UTC могли бы держать отметку до чужой полуночи. Через 6 часов прогресс перечитывается заново.
// Тем же ключом lib/home.js блокирует повторный подъём аккаунта: блок вчерашней выдачи не держит сегодняшнюю.
export const REPEAT_BUCKET = 6 * 60 * 60 * 1000;

export function repeatable(drop) {
  return drop?.kind === "reward" && (Number(drop.repeatableTimes) || 1) > 1;
}

export function claimKey(drop, now = Date.now()) {
  const id = String(drop?.id || "");
  if (!repeatable(drop)) return id;
  const window = Number(drop.windowEndsAt) || 0;
  return `${id}@${window || `h${Math.floor(now / REPEAT_BUCKET)}`}`;
}
