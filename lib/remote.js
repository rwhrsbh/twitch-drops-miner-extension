// Хэши persisted-query Twitch чинятся сами.
// Twitch время от времени меняет хэш запроса, и старый начинает отвечать PersistedQueryNotFound.
// Раньше это лечилось только новой версией расширения. Теперь расширение само:
//   1) раз в сутки, а при PersistedQueryNotFound сразу, берёт кандидатов для мёртвых хэшей из двух источников:
//      remote/config.json в репозитории расширения (его обновляет GitHub Action) и constants.py
//      TwitchDropsMiner, откуда эти хэши и берутся;
//   2) проверяет кандидата анонимным запросом к Twitch (жив хэш или нет видно без входа);
//   3) применяет только живые и запоминает их в chrome.storage.local.
// Это данные, а не код: с сервера приходят только строки из 64 hex-символов для известных операций.

import { GQL_URL, WEB_CLIENT_ID, gqlHashes, setGqlHashes } from "./constants.js";

const KEY = "remote";
export const CONFIG_URL = "https://raw.githubusercontent.com/rwhrsbh/twitch-drops-miner-extension/main/remote/config.json";
export const UPSTREAM_URL = "https://raw.githubusercontent.com/DevilXD/TwitchDropsMiner/master/constants.py";
const DAY = 24 * 60 * 60 * 1000;
const RETRY = 10 * 60 * 1000;
const SLOW = 6 * 60 * 60 * 1000;
const HEX = /^[0-9a-f]{64}$/;

// ---- Чистые функции: ими же пользуется scripts/update-hashes.mjs ----

// constants.py: GQLPersistedQuery("ИмяОперации", "хэш", ...)
export function parseUpstream(text) {
  const found = {};
  for (const match of String(text || "").matchAll(/GQLPersistedQuery\(\s*"(\w+)",\s*"([0-9a-f]{64})"/g)) {
    found[match[1]] = match[2];
  }
  return found;
}

export function parseConfig(value) {
  const found = {};
  for (const [operation, hash] of Object.entries(value?.hashes || {})) {
    if (HEX.test(String(hash))) found[operation] = String(hash);
  }
  return found;
}

// true — Twitch знает такой хэш, false — PersistedQueryNotFound, null — не удалось узнать.
export async function probeHash(operation, hash, fetcher = fetch) {
  try {
    const response = await fetcher(GQL_URL, {
      method: "POST",
      headers: { "Client-Id": WEB_CLIENT_ID, "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ operationName: operation, variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      credentials: "omit",
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    if (/PersistedQueryNotFound|PERSISTED_QUERY_NOT_FOUND/.test(text)) return false;
    // Живой хэш отвечает данными или ошибкой про переменные; всё остальное (5xx, заглушка) ничего не говорит.
    return response.ok && /"data"|"errors"/.test(text) ? true : null;
  } catch {
    return null;
  }
}

// Решает, какие хэши заменить. current — действующие, sources — списки кандидатов по порядку доверия.
// Заменяется только мёртвый хэш: проверка видит лишь «Twitch знает такой хэш», а не «он от этой операции»,
// поэтому рабочий хэш ни один источник (даже свой конфиг) не трогает.
// Возвращает { hashes: {операция: новый хэш}, broken: [операции без рабочего хэша] }.
export async function resolveHashes(current, sources, probe) {
  const hashes = {};
  const broken = [];
  for (const [operation, now] of Object.entries(current)) {
    const alive = await probe(operation, now);
    if (alive !== false) continue;
    let fixed = "";
    for (const source of sources) {
      const candidate = source?.[operation];
      if (!candidate || candidate === now) continue;
      if ((await probe(operation, candidate)) === true) {
        fixed = candidate;
        break;
      }
    }
    if (fixed) hashes[operation] = fixed;
    else broken.push(operation);
  }
  return { hashes, broken };
}

// ---- Расширение ----

function version() {
  return chrome.runtime?.getManifest?.().version || "";
}

// Найденные хэши относятся к версии, которая их искала: в новой версии свои, более свежие, и старая
// находка не должна их перекрыть.
async function readRemote() {
  const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
  const blank = { hashes: {}, checkedAt: 0, triedAt: 0, broken: [], fails: 0, version: version() };
  return (stored.version || "") === version() ? { ...blank, ...stored } : blank;
}

let loaded = false;

// Фоновый скрипт перезапускается: сохранённые хэши надо применить до первого запроса.
export async function loadHashes() {
  if (loaded) return;
  loaded = true;
  try {
    setGqlHashes(parseConfig(await readRemote()));
  } catch {
    // Без хранилища работают хэши из кода.
  }
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.text() : "";
  } catch {
    return "";
  }
}

async function sources() {
  const [config, upstream] = await Promise.all([fetchText(CONFIG_URL), fetchText(UPSTREAM_URL)]);
  let mine = {};
  try {
    mine = parseConfig(JSON.parse(config));
  } catch {
    // Конфига нет или он битый: остаётся второй источник.
  }
  return [mine, parseUpstream(upstream)];
}

let running = null;

// urgent — Twitch только что ответил PersistedQueryNotFound: проверяем сразу, но не чаще раза в 10 минут.
export function refreshHashes(urgent = false) {
  running ||= (async () => {
    try {
      await loadHashes();
      const state = await readRemote();
      const now = Date.now();
      // Починить не удалось: каждая следующая попытка реже, до раза в 6 часов.
      if (now - state.triedAt < Math.min(RETRY * 2 ** state.fails, SLOW)) return state;
      if (!urgent && now - state.checkedAt < (state.broken.length ? SLOW : DAY)) return state;
      await chrome.storage.local.set({ [KEY]: { ...state, triedAt: now } });
      const result = await resolveHashes(gqlHashes(true), await sources(), probeHash);
      setGqlHashes(result.hashes);
      const next = {
        hashes: { ...state.hashes, ...result.hashes },
        checkedAt: now,
        triedAt: now,
        broken: result.broken,
        fails: result.broken.length ? state.fails + 1 : 0,
        version: version(),
      };
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    } finally {
      running = null;
    }
  })();
  return running;
}

// Вызывается из GQL-клиента, когда Twitch не узнал хэш.
export function noteDeadHash() {
  refreshHashes(true).catch(() => {});
}
