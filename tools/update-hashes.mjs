// node tools/update-hashes.mjs
// Запускается GitHub Action по расписанию. Проверяет хэши persisted-query Twitch из remote/config.json
// анонимными запросами; мёртвые заменяет рабочими из TwitchDropsMiner. Расширения читают этот файл
// сами, так что починка доходит до пользователей без новой версии в магазине.
// Код выхода 2: остался запрос без рабочего хэша (Action заводит issue).

import { readFile, writeFile } from "node:fs/promises";
import { gqlHashes } from "../lib/constants.js";
import { UPSTREAM_URL, parseConfig, parseUpstream, probeHash, resolveHashes } from "../lib/remote.js";

const FILE = new URL("../remote/config.json", import.meta.url);

let saved = {};
try {
  saved = parseConfig(JSON.parse(await readFile(FILE, "utf8")));
} catch {
  // Файла ещё нет: начинаем с хэшей из кода.
}
// Только операции, которые расширение знает; хэши из кода — запасной кандидат.
const builtIn = gqlHashes(true);
const current = Object.fromEntries(Object.keys(builtIn).map((operation) => [operation, saved[operation] || builtIn[operation]]));

const response = await fetch(UPSTREAM_URL);
const upstream = response.ok ? parseUpstream(await response.text()) : {};
if (!Object.keys(upstream).length) console.warn("upstream: no hashes read");

const result = await resolveHashes(current, [upstream, builtIn], probeHash);
const hashes = { ...current, ...result.hashes };
for (const [operation, hash] of Object.entries(result.hashes)) console.log(`fixed ${operation}: ${current[operation]} -> ${hash}`);
for (const operation of result.broken) console.error(`BROKEN ${operation}: ${current[operation]} is dead and no source has a working hash`);

const sorted = Object.fromEntries(Object.keys(hashes).sort().map((operation) => [operation, hashes[operation]]));
const changed = JSON.stringify(sorted) !== JSON.stringify(Object.fromEntries(Object.keys(saved).sort().map((operation) => [operation, saved[operation]])));
if (changed) {
  await writeFile(FILE, `${JSON.stringify({ updated: new Date().toISOString().slice(0, 10), hashes: sorted }, null, 2)}\n`);
  console.log("remote/config.json updated");
} else {
  console.log("no changes");
}
process.exit(result.broken.length ? 2 : 0);
