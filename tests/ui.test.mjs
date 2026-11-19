// node --test tests/ui.test.mjs — попап и тексты: каждый id из popup.js есть в popup.html, каждый ключ
// L()/mark()/tr() есть в обоих языках, наборы ключей ru и en совпадают, мёртвых новых строк нет.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");

const popup = read("popup.js");
const html = read("popup.html");
const i18n = read("lib/i18n.js");

function pack(lang) {
  const marker = new RegExp("\\n  " + lang + ": \\{");
  const start = i18n.search(marker);
  assert.ok(start >= 0, "пакет " + lang + " найден");
  const rest = i18n.slice(start).split(/\n  \},\n/)[0];
  return [...rest.matchAll(/^    ([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
}

const ru = pack("ru");
const en = pack("en");

test("все id из popup.js есть в popup.html", () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set([...popup.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test("языки совпадают по набору ключей, без дублей", () => {
  assert.equal(ru.length, new Set(ru).size, "дубли в ru");
  assert.equal(en.length, new Set(en).size, "дубли в en");
  assert.deepEqual(ru.filter((key) => !en.includes(key)), [], "ключи только в ru");
  assert.deepEqual(en.filter((key) => !ru.includes(key)), [], "ключи только в en");
});

test("каждый ключ, который просит код, есть в обоих языках", () => {
  const have = new Set([...ru, ...en]);
  const wanted = new Set();
  for (const file of ["popup.js", "lib/miner.js", "lib/kick.js", "lib/kickcases.js", "lib/kickpoints.js"]) {
    const text = read(file);
    for (const match of text.matchAll(/(?:L|\.tr|tr|mark)\((?:state, )?"([A-Za-z0-9_]+)"/g)) wanted.add(match[1]);
  }
  const missing = [...wanted].filter((key) => !have.has(key));
  assert.deepEqual(missing, []);
  assert.ok(wanted.size > 50, "ключи действительно найдены, а не пропущены разбором");
});

test("новые строки режимов и кейсов действительно используются", () => {
  const code = ["popup.js", "lib/miner.js", "lib/kick.js", "lib/kickcases.js"]
    .map(read).join("\n");
  for (const key of ["soloTwitch", "soloKick", "soloOff", "soloSearch", "soloSearchHint", "soloFine", "soloLine", "soloLineDrops", "soloLineAny",
    "soloOffline", "casesTitle", "casesHint", "casesEmpty", "casesError", "casesOpen", "casesClaimed",
    "casesProgress", "casesToggle", "casesToggleHint"]) {
    assert.ok(code.includes(`"${key}"`), "ключ " + key + " используется");
  }
});

test("одна игра выбирается поиском, а не выпадающим списком", () => {
  // Жалоба пользователя: <select> выглядел как захардкоженный список игр. Теперь там поиск,
  // как во вкладке Priority: строка ввода и список строк под ней.
  assert.ok(!/<select id="solo-/.test(html), "выпадающих списков «одна игра» больше нет");
  for (const platform of ["twitch", "kick"]) {
    assert.ok(html.includes(`id="solo-${platform}-filter"`), "у " + platform + " есть строка поиска");
    assert.ok(html.includes(`id="solo-${platform}-list"`), "у " + platform + " есть список игр");
    assert.ok(popup.includes(`id="solo-${platform}-filter"`) || popup.includes(`solo-${platform}-filter`), "поиск " + platform + " подключён");
  }
});

test("список игр «одной игры» подтягивается из состояния, а не захардкожен", () => {
  // Пользователь: «убедись, что ты не хардкодишь, а подтягиваешь списки». Варианты строятся из игр
  // кампаний Kick, его очереди, выбранных в Priority игр и состояния Twitch.
  const start = popup.indexOf("function soloOptions(");
  const end = popup.indexOf("function soloMatches(");
  assert.ok(start > 0 && end > start, "soloOptions найдена");
  const code = popup.slice(start, end);
  for (const source of ["kickState?.games", "kickState?.queue", "settings.picked", "latest?.games", "latest?.whitelist"]) {
    assert.ok(code.includes(source), "источник " + source);
  }
  assert.ok(!/"(Rust|Minecraft|Grand Theft|Fortnite)"/.test(code), "названий игр в коде нет");
});

test("мёртвых строк не прибавилось", () => {
  // Пять ключей висят с прежних версий: они были не нужны и в main, поэтому это не регрессия ветки.
  const known = new Set(["noLogin", "kickTitle", "kickLeft", "kickChannels", "viewOnly"]);
  const code = ["popup.js", ...fs.readdirSync(path.join(dir, "lib")).filter((name) => name.endsWith(".js")).map((name) => "lib/" + name)]
    .map(read).join("\n");
  const unused = ru.filter((key) => !code.includes(`"${key}"`) && !known.has(key));
  assert.deepEqual(unused, []);
});
