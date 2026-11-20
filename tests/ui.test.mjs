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

test("у «одной игры» есть картинка, как во вкладке Priority", () => {
  // Запрос пользователя: в строке «одна игра без остановки» не было обложки игры.
  for (const platform of ["twitch", "kick"]) {
    assert.ok(html.includes(`id="solo-${platform}-art"`), "у " + platform + " есть место под картинку");
  }
  assert.ok(popup.includes("function soloArt("), "картинка выбирается общей функцией");
  assert.ok(popup.includes('boxArt(game.id, "144x192")'), "у Twitch обложка строится по id игры");
  const start = popup.indexOf("function soloRow(");
  const end = popup.indexOf("function renderSoloList(");
  assert.ok(start > 0 && end > start, "soloRow найдена");
  assert.ok(popup.slice(start, end).includes("game-art"), "строка списка рисует обложку");
  assert.ok(popup.slice(popup.indexOf("function soloOptions("), start).includes("image: game?.image"), "Kick отдаёт картинку кампании");
});

test("картинки кейсов берутся из ответа Kick, а не из заглушек", () => {
  // Запрос пользователя: у кейсов не было картинок. У открытого кейса есть награда,
  // у остальных — только анимация кейса, которую отдаёт тот же ответ gamification/challenges.
  const cases = read("lib/kickcases.js");
  assert.ok(cases.includes("animations?.idle_url"), "Kick отдаёт ссылку на анимацию кейса");
  assert.ok(cases.includes("animation: caseAnimation(item)"), "строка кейса получает анимацию");
  assert.ok(popup.includes("row.animation"), "попап рисует анимацию из строки");
  assert.ok(popup.includes("case-video"), "у анимации своя обёртка");
  assert.ok(popup.includes("<video"), "это видео, а не выдуманная картинка");
});

test("смена языка сразу перерисовывает кейсы", () => {
  // Жалоба пользователя: описание кейсов оставалось на старом языке до перезапуска попапа.
  const start = popup.indexOf("function render(state)");
  const end = popup.indexOf("// Эксклюзивный дроп без канала", start);
  assert.ok(start > 0 && end > start, "render найдена");
  assert.ok(popup.slice(start, end).includes("if (casesState) renderCases(casesState)"),
    "язык меняется — кейсы перерисовываются вместе с остальным окном");
  assert.ok(!i18n.includes("Открывать кейс самому"), "старая формулировка убрана");
  assert.match(i18n, /casesToggle: "Открывать кейсы автоматически"/);
  assert.match(i18n, /casesHint: "Награды Kick за просмотр/);
});

test("старые строки кейсов сами перечитываются после обновления", () => {
  // У Sunset Reward Case вместо анимации оставалась буква «S»: сохранённые строки пришли
  // из версии без animation, а фон обновлял их только раз в 90 секунд.
  const cases = read("lib/kickcases.js");
  assert.ok(cases.includes("artVersion: 2"), "новые строки помечены как строки с анимацией");
  assert.ok(popup.includes("function needsCaseArt("), "попап умеет узнать старые строки");
  assert.ok(popup.includes('send({ type: "kickCasesTick" })'), "попап просит фон перечитать кейсы");
  const start = popup.indexOf('$("now").addEventListener');
  const end = popup.indexOf('$("inventory-2")', start);
  assert.ok(start > 0 && end > start, "кнопка Refresh найдена");
  assert.ok(popup.slice(start, end).includes("kickCasesTick"), "Refresh обновляет и кейсы");
});

test("карточка очереди обрезает зелёную строку по скруглению", () => {
  // Жалоба пользователя: у текущего дропа зелёная подсветка вылезала за скруглённые
  // углы карточки и выглядела квадратной обводкой.
  const css = read("popup.css");
  const start = css.indexOf(".bucket-card, .log-sheet");
  const end = css.indexOf(".bucket.exclusive .bucket-card", start);
  assert.ok(start > 0 && end > start, "правило карточки найдено");
  assert.ok(css.slice(start, end).includes("overflow: hidden"), "фон строки обрезается по скруглению");
});

test("мёртвых строк не прибавилось", () => {
  // Пять ключей висят с прежних версий: они были не нужны и в main, поэтому это не регрессия ветки.
  const known = new Set(["noLogin", "kickTitle", "kickLeft", "kickChannels", "viewOnly"]);
  const code = ["popup.js", ...fs.readdirSync(path.join(dir, "lib")).filter((name) => name.endsWith(".js")).map((name) => "lib/" + name)]
    .map(read).join("\n");
  const unused = ru.filter((key) => !code.includes(`"${key}"`) && !known.has(key));
  assert.deepEqual(unused, []);
});

test("кейсы показываются только у аккаунта, выбранного чипом", () => {
  const start = popup.indexOf("function casesOf(accounts)");
  const end = popup.indexOf("function renderCases(state)", start);
  assert.ok(start > 0 && end > start, "casesOf найдена");
  const build = (mine, viewed) => new Function("side", "viewedId", `${popup.slice(start, end)}; return casesOf;`)(() => mine, () => viewed);
  const mine = { active: "1", list: [{ id: "1", login: "Main" }, { id: "2", login: "second" }, { id: "3", login: "third" }] };
  const accounts = { 1: { login: "main" }, 2: { login: "second" }, "live:other": { login: "other" } };
  assert.deepEqual(build(mine, "2")(accounts), ["2"], "второй аккаунт видит только свои кейсы");
  assert.deepEqual(build(mine, "1")(accounts), ["1"], "активный — свои, по id");
  assert.deepEqual(build(mine, "3")(accounts), [], "у третьего записи нет: пусто, а не чужие");
  const live = { 1: { login: "" }, current: { login: "" } };
  assert.deepEqual(build(mine, "1")({ current: { login: "" } }), ["current"], "активный без сохранённой записи берёт «current»");
  assert.deepEqual(build(mine, "2")(live), [], "неактивному «current» не отдаётся");
  assert.ok(popup.includes('chip.dataset.view === "kick" && casesState'), "клик по чипу перерисовывает кейсы");
});

test("карточка фарма: две фиксированные строки со сжатием шрифта, карточки аккаунтов грузятся сразу", () => {
  const css = read("popup.css");
  assert.ok(popup.includes('<span class="fit">'), "игра и минуты лежат в отдельных строках");
  const fit = css.slice(css.indexOf(".fine .fit {"), css.indexOf("}", css.indexOf(".fine .fit {")));
  assert.ok(fit.includes("white-space: nowrap") && fit.includes("overflow: hidden"), "строка не переносится");
  assert.match(css, /\.duo \.hero h2 \{ min-height: 2\.4em; \}/, "заголовок занимает два ряда всегда: канал не едет");
  assert.ok(popup.includes("function fitRows(box)") && popup.includes("fitRows(box);"), "шрифт подгоняется после отрисовки");
  const start = popup.indexOf("const preload = chrome.storage.local.get");
  assert.ok(start > 0, "аккаунты и карточки читаются из хранилища напрямую");
  const boot = popup.slice(start, popup.indexOf("// ---------- Баллы, история, аккаунты", start));
  assert.ok(boot.includes('"side", "kickSide", "accounts"'));
  assert.ok(/Promise\.all\(\[send\(\{ type: "getState" \}\), preload\]\)/.test(boot), "основная карточка ждёт те же данные");
  assert.ok(/Promise\.all\(\[send\(\{ type: "getKick" \}\), preload\]\)/.test(boot));
});

test("значок награды внутри кольца под процентами, слот и строка аккаунта занимают место всегда", () => {
  const css = read("popup.css");
  assert.ok(popup.includes('class="ring-slot"') && popup.includes('class="ring-art"'), "значок в кольце");
  assert.ok(!popup.includes('class="hero-art"'), "углового значка больше нет");
  assert.ok(/\.duo \.ring-slot \{[^}]*position: absolute/.test(css), "слой не двигает проценты");
  assert.ok(/\.duo \.who \{[^}]*min-height: 14px/.test(css), "пустая строка аккаунта не сдвигает кольцо");
});

test("ник в карточке всегда: логин, иначе id аккаунта, как в чипах", () => {
  assert.ok(popup.includes("function accountName(account)") && popup.includes("account?.login || account?.id"));
  assert.ok(popup.includes('state.user?.login || activeLogin("twitch")'), "основная карточка Twitch");
  assert.ok(popup.includes('state.user || activeLogin("kick")'), "основная карточка Kick");
  assert.ok(popup.includes("info.login || accountName(account)"), "карточки остальных аккаунтов");
});
