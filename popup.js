import { FEATURES } from "./lib/constants.js";
import { resolveLang, show, t } from "./lib/i18n.js";

const $ = (id) => document.getElementById(id);
let wantedLang = "";

function L(key, vars) {
  return t(latest?.lang, key, vars);
}

function phaseLink(phase) {
  if (phase === "need-login") return [L("enterTwitch"), "https://www.twitch.tv/login"];
  if (phase === "not-linked") return [L("linkGame"), "https://www.twitch.tv/drops/campaigns"];
  if (phase === "pick-game") return [L("twitchCampaigns"), "https://www.twitch.tv/drops/campaigns"];
  return null;
}

let latest = null;
let settings = { autoAll: false, blacklist: [] };
let blackFilter = "";
let filterText = "";

function clock(value) {
  if (!value) return "";
  const locale = resolveLang(latest?.lang) === "en" ? "en-US" : "ru-RU";
  return new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function ago(value) {
  if (!value) return { text: L("pingNever"), stale: true };
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 20) return { text: L("pingJust"), stale: false };
  if (seconds < 90) return { text: L("pingSeconds", { n: seconds }), stale: false };
  const minutes = Math.round(seconds / 60);
  return { text: L("pingMinutes", { n: minutes }), stale: minutes >= 3 };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Картинки: сутки лежат в Cache API и подставляются как blob-адреса, а разметка не переписывается, если не изменилась.
// Иначе каждый тик пересоздаёт <img>, и картинки мигают.
const ART_CACHE = "drops-art";
const ART_TTL = 24 * 60 * 60 * 1000;
const artUrls = new Map();
const artPending = new Set();
let artTimer = 0;

function decodeAttr(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function withArt(html) {
  return html.replace(/src="(https:[^"]+)"/g, (whole, raw) => {
    const url = decodeAttr(raw);
    const local = artUrls.get(url);
    if (!local) queueArt(url);
    return local ? `src="${local}" data-art="${escapeHtml(url)}"` : whole;
  });
}

function setHtml(element, html) {
  if (!element) return;
  const next = withArt(html);
  if (element.__html === next) return;
  element.__html = next;
  element.innerHTML = next;
}

function queueArt(url) {
  if (artPending.has(url) || !globalThis.caches) return;
  artPending.add(url);
  clearTimeout(artTimer);
  artTimer = setTimeout(loadArt, 30);
}

async function loadArt() {
  const urls = [...artPending];
  if (!urls.length) return;
  let changed = false;
  try {
    const cache = await caches.open(ART_CACHE);
    await Promise.all(urls.map(async (url) => {
      try {
        let response = await cache.match(url);
        const stamp = Number(response?.headers.get("x-cached-at") || 0);
        if (!response || Date.now() - stamp > ART_TTL) {
          try {
            const fresh = await fetch(url);
            if (fresh.ok) {
              const body = await fresh.blob();
              const headers = new Headers({ "content-type": fresh.headers.get("content-type") || body.type, "x-cached-at": String(Date.now()) });
              await cache.put(url, new Response(body, { headers }));
              response = await cache.match(url);
            }
          } catch {
            // Старая копия лучше, чем ничего.
          }
        }
        if (!response) return;
        artUrls.set(url, URL.createObjectURL(await response.blob()));
        changed = true;
      } catch {
        // Картинка останется по обычной ссылке.
      }
    }));
  } finally {
    for (const url of urls) artPending.delete(url);
  }
  if (changed && latest) {
    render(latest);
    if (kickState) renderKick(kickState);
  }
}

function safeUrl(value) {
  const url = String(value || "");
  return url.startsWith("https://") ? url : "";
}

function boxArt(id, size) {
  return id ? `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(id)}-${size}.jpg` : "";
}

function gameIdOf(drop, state) {
  if (drop?.gameId) return drop.gameId;
  const game = (state?.games || []).find((item) => item.name && item.name === drop?.game);
  return game?.id || "";
}

function artUrl(url, kind) {
  const safe = safeUrl(url);
  if (!safe || /ttv-boxart|\/boxart\//i.test(safe)) return "";
  if (kind === "item" && /\/CAMPAIGN\//i.test(safe)) return "";
  if (kind === "campaign" && /\/REWARD\//i.test(safe)) return "";
  return safe;
}

function rewardUrl(drop) {
  return artUrl(drop?.image, "item");
}

function campaignUrl(drop) {
  const id = gameIdOf(drop, latest);
  const game = (latest?.games || []).find((item) => item.id === id || (item.name && item.name === drop?.game));
  return safeUrl(game?.image) || boxArt(id, "285x380");
}

function hideBrokenImages(root) {
  for (const image of root.querySelectorAll("img")) {
    image.addEventListener("error", () => image.remove(), { once: true });
  }
}

function streamerChip(channel) {
  const login = typeof channel === "string" ? channel : channel.login;
  const online = typeof channel === "string" ? null : channel.online;
  const state = online === true ? "is-on" : online === false ? "is-off" : "is-unknown";
  const label = online === true ? L("online") : online === false ? L("offline") : "";
  return `<span class="chip ${state}"><i></i>${escapeHtml(login)} <em>${label}</em><button type="button" data-open="${escapeHtml(login)}">${L("stream")}</button></span>`;
}

// Чей список игр открыт на вкладке: одна площадка и один её аккаунт (у каждого аккаунта список свой).
let gamesSide = "twitch";
try {
  if (localStorage.getItem("gamesSide") === "kick") gamesSide = "kick";
} catch {
  // Без хранилища открывается список Twitch.
}

// Игры открытого списка. Id: у Twitch — id игры, "w:<название>" — добавлена по названию и ждёт кампанию;
// у Kick — "k:<название>" (Kick выбирает игры по названию).
function pickerGames() {
  const chosen = selectedGameIds();
  const list = gamesSide === "kick"
    ? (kickState?.games || []).map((game) => ({ id: `k:${game.name}`, name: game.name, image: game.image, kickOnly: true, linked: game.linked, campaigns: game.campaigns }))
    : (latest?.games || []).map((game) => ({ ...game }));
  // Выбранные игры, у которых сейчас нет кампаний: остаются в списке и ждут новую кампанию.
  const present = new Set(list.map((game) => String(game.id)));
  const picks = latest?.picks || {};
  for (const id of chosen) {
    if (present.has(String(id))) continue;
    if (id.startsWith("k:") || id.startsWith("w:")) list.push({ id, name: id.slice(2), image: "", kickOnly: id.startsWith("k:"), gone: true });
    else list.push({ id, name: picks[id]?.name || `${L("gameFallback")} #${id}`, image: picks[id]?.image || "", gone: true });
  }
  return list.sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function side(platform) {
  return accounts?.[platform] || { active: "", list: [] };
}

function targetId(platform) {
  const mine = side(platform);
  return mine.list.some((item) => item.id === editing[platform]) ? editing[platform] : mine.active;
}

// Правим активный аккаунт (или аккаунтов ещё нет): выбор лежит в живом состоянии майнера.
function editsLive(platform) {
  const mine = side(platform);
  return !mine.list.length || targetId(platform) === mine.active;
}

function targetAccount(platform) {
  return side(platform).list.find((item) => item.id === targetId(platform)) || null;
}

// Названия, добавленные вручную и ждущие кампанию, у открытого аккаунта Twitch.
function twitchWishes() {
  return (editsLive("twitch") ? settings.wishes : targetAccount("twitch")?.wishes) || [];
}

function selectedGameIds() {
  if (gamesSide === "kick") {
    const picked = editsLive("kick") ? settings.picked || [] : targetAccount("kick")?.picked || [];
    const exact = new Map((kickState?.games || []).map((game) => [game.name.toLowerCase(), game.name]));
    return new Set(picked.map((name) => `k:${exact.get(String(name).toLowerCase()) || name}`));
  }
  const ids = (editsLive("twitch") ? latest?.whitelist || [] : targetAccount("twitch")?.whitelist || []).map(String);
  // Название не показываем отдельной строкой, если такая игра уже есть в списке игр или уже выбрана.
  const picks = latest?.picks || {};
  const known = new Set((latest?.games || []).map((game) => game.name.toLowerCase()));
  for (const id of ids) if (picks[id]?.name) known.add(picks[id].name.toLowerCase());
  const waiting = twitchWishes().filter((name) => !known.has(name.toLowerCase()));
  return new Set([...ids, ...waiting.map((name) => `w:${name}`)]);
}

function gameMeta(game) {
  if (game.gone) return L("noCampaignNow");
  // Привязка и прогресс известны только для активного аккаунта: у остальных их не показываем.
  const own = editsLive(game.kickOnly ? "kick" : "twitch");
  if (game.kickOnly) {
    const kickBits = [];
    if (own && !game.linked) kickBits.push(L("kickLinkNeeded"));
    kickBits.push(game.campaigns === 1 ? L("oneCampaign") : L("manyCampaigns", { count: game.campaigns }));
    return kickBits.join(" · ");
  }
  const bits = [];
  if (own && !game.linked) bits.push(L("notLinkedGame"));
  if (own && game.total) bits.push(game.left ? L("ofTotal", { left: game.left, total: game.total }) : L("gotAll"));
  else if (game.campaigns) bits.push(game.campaigns === 1 ? L("oneCampaign") : L("manyCampaigns", { count: game.campaigns }));
  return bits.join(" · ");
}

function pageTop() {
  return document.scrollingElement?.scrollTop || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function setPageTop(top) {
  if (document.scrollingElement) document.scrollingElement.scrollTop = top;
  document.documentElement.scrollTop = top;
  document.body.scrollTop = top;
}

function rememberScroll() {
  return {
    page: pageTop(),
    games: $("games")?.scrollTop || 0,
    cards: [...document.querySelectorAll(".bucket-card")].map((card) => card.scrollTop),
  };
}

function restoreScroll(spot) {
  const apply = () => {
    setPageTop(spot.page);
    const games = $("games");
    if (games) games.scrollTop = spot.games;
    document.querySelectorAll(".bucket-card").forEach((card, index) => {
      if (spot.cards[index] != null) card.scrollTop = spot.cards[index];
    });
  };
  apply();
  requestAnimationFrame(apply);
}

// Главный тумблер включает и выключает оба майнера; по отдельности их можно выключить в настройках.
function ringHtml(ratio, idle) {
  return `<div class="ring" style="--p:${ratio}">
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <circle class="track" cx="18" cy="18" r="16"></circle>
      <circle class="value" cx="18" cy="18" r="16"></circle>
    </svg>
    <b>${idle ? "—" : `${ratio}%`}</b>
  </div>`;
}

// Одна и та же карточка для Twitch и Kick: активный дроп с кольцом или короткое сообщение, почему майнер стоит.
function paintHero(box, card) {
  const item = card.item;
  const ratio = item?.required ? Math.min(100, Math.round(((item.current || 0) / item.required) * 100)) : 0;
  const backdrop = item ? card.backdrop : "";
  const reward = item ? card.reward : "";
  const label = `${card.platform} · ${item ? (card.on ? L("farmingNow") : L("paused")) : L("kickIdleShort")}`;
  box.className = `hero${item ? "" : " idle"}`;
  setHtml(box, `
    ${backdrop ? `<img class="hero-bg" src="${escapeHtml(backdrop)}" alt="">` : ""}
    <div><p class="eyebrow">${escapeHtml(label)}</p>${card.user ? `<span class="who">${escapeHtml(card.user)}</span>` : ""}</div>
    ${ringHtml(ratio, !item)}
    ${item ? `<div>
      <h2>${escapeHtml(item.name)}</h2>
      <p class="fine">${escapeHtml(item.game)} · ${L("minutesShort", { current: item.current || 0, required: item.required })}${card.ping ? ` · ${escapeHtml(card.ping)}` : ""}</p>
      <button class="channel" type="button" ${card.openAttr}="${escapeHtml(item.login)}"><i></i><span>${escapeHtml(item.login)}</span></button>
    </div>` : `<div><p class="hero-msg${card.bad ? " bad" : ""}">${escapeHtml(card.message || "")}</p></div>`}
    ${reward && reward !== backdrop ? `<img class="hero-art" src="${escapeHtml(reward)}" alt="">` : ""}
  `);
  hideBrokenImages(box);
}

// Остальные аккаунты Twitch, которые фармят одновременно с активным: по карточке на каждый.
let sideFarm = {};
let kickSideFarm = {};
const SIDE_NOTES = {
  "need-login": "accountExpired",
  "no-channel": "sideNoChannel",
  "all-claimed": "sideAllClaimed",
  "no-campaign": "sideNoCampaign",
  "pick-game": "sidePickGame",
  "needs-main": "sideNeedsMain",
  "not-linked": "sideNotLinked",
  waiting: "sideWaiting",
  error: "sideError",
};

function renderSideCards() {
  const box = $("duo-more");
  const cards = [];
  if (accounts?.rotate?.mode === "all") {
    for (const platform of ["twitch", "kick"]) {
      const mine = side(platform);
      const farm = platform === "kick" ? kickSideFarm : sideFarm;
      const enabled = platform === "kick" ? kickState?.enabled !== false : latest?.enabled !== false;
      if (!enabled) continue;
      for (const account of mine.list) {
        if (account.id !== mine.active && farm[account.id]) cards.push({ platform, account, info: farm[account.id] });
      }
    }
  }
  box.classList.toggle("hidden", !cards.length);
  // Карточки создаются один раз на аккаунт и потом только перерисовываются: картинки не мигают.
  const keyOf = (card) => `${card.platform}:${card.account.id}`;
  for (const node of [...box.children]) if (!cards.some((card) => keyOf(card) === node.dataset.side)) node.remove();
  for (const card of cards) {
    let node = [...box.children].find((item) => item.dataset.side === keyOf(card));
    if (!node) {
      node = document.createElement("section");
      node.dataset.side = keyOf(card);
      box.append(node);
    }
    const { info, account, platform } = card;
    const item = info.watching;
    const kick = platform === "kick";
    paintHero(node, {
      platform: kick ? "Kick" : "Twitch",
      user: account.login || info.login || "",
      item,
      on: true,
      ping: item ? ago(kick ? info.lastPing : info.lastPing?.at).text : "",
      openAttr: kick ? "data-open-kick" : "data-open",
      backdrop: item ? (kick ? safeUrl(item.campaignImage) : campaignUrl(item)) : "",
      reward: item ? (kick ? safeUrl(item.image) : rewardUrl(item)) : "",
      message: L(SIDE_NOTES[info.phase] || "kickIdleShort"),
      bad: info.phase === "need-login" || info.phase === "error",
    });
  }
}

// Вкладки Twitch и Kick в режиме «все сразу»: чью очередь показывать.
const viewAcc = { twitch: "", kick: "" };

function viewedId(platform) {
  const mine = side(platform);
  return mine.list.some((item) => item.id === viewAcc[platform]) ? viewAcc[platform] : mine.active;
}

// Данные выбранного неактивного аккаунта или null, если показывается активный.
function viewedSide(platform) {
  const mine = side(platform);
  if (accounts?.rotate?.mode !== "all" || viewedId(platform) === mine.active) return null;
  return (platform === "kick" ? kickSideFarm : sideFarm)[viewedId(platform)] || { queue: [], watching: null };
}

function paintViewChips(platform) {
  const mine = side(platform);
  const box = $(`${platform}-accounts`);
  if (accounts?.rotate?.mode !== "all" || mine.list.length < 2) {
    box.innerHTML = "";
    return;
  }
  const current = viewedId(platform);
  box.innerHTML = `<div class="acc-row">${mine.list.map((item) => (
    `<button class="acc-chip${item.id === current ? " on" : ""}" type="button" data-view="${platform}" data-id="${escapeHtml(item.id)}">${escapeHtml(item.login || item.id)}</button>`
  )).join("")}</div>`;
}

document.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-view]");
  if (!chip) return;
  viewAcc[chip.dataset.view] = chip.dataset.id;
  if (latest) render(latest);
});

function paintSwitches(twitch, kick) {
  const twitchOn = Boolean(twitch?.enabled);
  const kickOn = kick ? Boolean(kick.enabled) : true;
  const flag = (on) => (on ? "true" : "false");
  $("toggle").setAttribute("aria-pressed", flag(twitchOn || kickOn));
  $("twitch-toggle").setAttribute("aria-pressed", flag(twitchOn));
  $("kick-toggle").setAttribute("aria-pressed", flag(kickOn));
}

function paintAccount() {
  const twitch = latest?.user?.login || "";
  // Ник Kick мог не прочитаться, хотя сессия жива: тогда пишем просто «вход выполнен».
  const kickIn = Boolean(kickState) && kickState.enabled !== undefined && kickState.phase !== "need-login"
    && (Boolean(kickState.user) || ["watching", "no-channel", "all-claimed"].includes(kickState.phase));
  const kick = kickIn ? kickState.user || L("signedShort") : "";
  let text;
  if (!twitch && !kick) text = L("noLoginBoth");
  // Это аккаунты самого браузера: под ними пользователь окажется, открыв twitch.tv или kick.com.
  else text = `${L("browserAs")}: Twitch ${twitch || L("noLoginShort")} · Kick ${kick || L("noLoginShort")}`;
  $("account").textContent = text;
}

function render(state) {
  if (!state) return;
  // Пока фон не подтвердил последний выбранный язык, показываем его, а не то, что пришло раньше.
  if (wantedLang) state = { ...state, lang: wantedLang };
  const spot = rememberScroll();
  latest = state;
  const on = Boolean(state.enabled);
  paintSwitches(state, kickState);

  const lang = resolveLang(state.lang);
  document.documentElement.lang = lang;
  $("title").textContent = L("title");
  $("farm-title").textContent = L("farmHeading");
  $("games-title").textContent = L(settings.autoAll ? "priorityHeading" : "gamesHeading");
  $("log-title").textContent = L("journal");
  $("now").textContent = L("refresh");
  $("inventory-2").textContent = L("inventory");
  $("filter").placeholder = L("addGame");
  $("toggle").setAttribute("aria-label", L("minerLabel"));
  document.querySelectorAll("#langs [data-lang]").forEach((button) => {
    button.classList.toggle("on", button.dataset.lang === lang);
  });
  const ping = ago(state.lastPing?.at);
  const status = $("status");
  const raw = state.watching
    ? L("watchLine", {
      game: state.watching.game || "",
      name: state.watching.name || "",
      login: state.watching.login || L("channelWord"),
      current: state.watching.current || 0,
      required: state.watching.required || 0,
      ratio: state.watching.required ? Math.min(100, Math.round(((state.watching.current || 0) / state.watching.required) * 100)) : 0,
    })
    : (show(state.lang, state.message) || L("waitFirst"));
  status.textContent = /GQL|integrity|Failed to fetch|молчит|не ответил/i.test(raw)
    ? (state.watching ? L("outOf", { current: state.watching.current, required: state.watching.required }) : L("updating"))
    : raw;
  status.className = "status";
  if (state.phase === "error" || state.phase === "need-login") status.classList.add("bad");
  if (state.phase === "pick-game" || state.phase === "not-linked" || state.phase === "no-channel"
    || state.phase === "claim-pending") {
    status.classList.add("wait");
  }
  if (state.phase === "watching" && ping.stale) status.classList.add("stale");

  paintAccount();

  // Пока карточка сверху показывает дроп, строка статуса под вкладками только дублирует её.
  status.classList.toggle("hidden", state.phase !== "error");
  const twitchMessage = !on
    ? L("kickIdle")
    : state.phase === "need-login" ? L("noLoginShort") : status.textContent;
  paintHero($("watch"), {
    platform: "Twitch",
    user: state.user?.login || "",
    item: on ? state.watching : null,
    on,
    ping: ping.text,
    openAttr: "data-open",
    backdrop: state.watching ? campaignUrl(state.watching) : "",
    reward: state.watching ? rewardUrl(state.watching) : "",
    message: twitchMessage,
    bad: state.phase === "need-login" || state.phase === "error",
  });

  const query = filterText.trim().toLowerCase();
  const selectedIds = selectedGameIds();
  const everyGame = pickerGames();
  const pool = everyGame.filter((game) => {
    if (!query) return selectedIds.has(game.id);
    return game.name.toLowerCase().includes(query);
  });
  const pickedCount = everyGame.filter((game) => selectedIds.has(game.id)).length;
  $("game-count").textContent = pickedCount ? String(pickedCount) : "";
  $("tab-games-n").textContent = pickedCount ? String(pickedCount) : "";
  // Такой игры в списке нет: её можно добавить по названию, она включится, когда появится кампания.
  const typed = filterText.trim();
  const addRow = typed.length >= 2 && !everyGame.some((game) => game.name.toLowerCase() === query)
    ? `
      <label class="game">
        <input data-game="${escapeHtml(`${gamesSide === "kick" ? "k" : "w"}:${typed}`)}" data-name="${escapeHtml(typed)}" type="checkbox">
        <span>
          <strong>${escapeHtml(L("addByName", { name: typed }))}</strong>
          <small>${escapeHtml(L("addByNameHint"))}</small>
        </span>
        <span class="check"></span>
      </label>`
    : "";
  $("tab-games-label").textContent = L(settings.autoAll ? "priorityHeading" : "gamesHeading");
  paintGamesHint();
  setHtml($("games"), pool.length
    ? pool.map((game) => {
      const art = safeUrl(game.image) || (game.kickOnly ? "" : boxArt(game.id, "144x192"));
      return `
      <label class="game${selectedIds.has(game.id) ? " on" : ""}">
        <input data-game="${escapeHtml(game.id)}" data-name="${escapeHtml(game.name)}" type="checkbox" ${selectedIds.has(game.id) ? "checked" : ""}>
        ${art ? `<img class="game-art" src="${escapeHtml(art)}" alt="">` : ""}
        <span>
          <strong>${escapeHtml(game.name)}</strong>
          <small>${escapeHtml(gameMeta(game))}</small>
        </span>
        <span class="check"></span>
      </label>`;
    }).join("") + addRow
    : addRow || `<p class="empty">${query ? L("noSuchGame") : L("typeToAdd")}</p>`);

  // В режиме «все сразу» вкладка показывает очередь выбранного аккаунта.
  paintViewChips("twitch");
  const otherTwitch = viewedSide("twitch");
  if (otherTwitch) state = { ...state, queue: otherTwitch.queue || [], watching: otherTwitch.watching || null };
  const queue = $("queue");
  const activeId = state.watching?.dropId || "";
  const drops = (state.queue || []).filter((drop) => !drop.claimed);
  $("tab-twitch-n").textContent = drops.length ? String(drops.length) : "";
  const byFarm = (left, right) => {
    const leftNow = left.id === activeId ? -1 : 0;
    const rightNow = right.id === activeId ? -1 : 0;
    if (leftNow !== rightNow) return leftNow - rightNow;
    const leftRatio = left.required ? left.current / left.required : 0;
    const rightRatio = right.required ? right.current / right.required : 0;
    return rightRatio - leftRatio;
  };
  const exclusive = drops.filter((drop) => (drop.channels || []).length).sort(byFarm);
  const general = drops.filter((drop) => !(drop.channels || []).length).sort(byFarm);
  if (drops.length) {
    queue.classList.remove("hidden");
    setHtml(queue, [
      renderBucket(L("exclusive"), exclusive, true, state),
      renderBucket(L("regular"), general, false, state),
    ].join(""));
  } else {
    queue.classList.add("hidden");
    setHtml(queue, "");
  }

  const lines = (state.log || []).filter((line) => !/нет соединения/.test(line.text));
  $("log").innerHTML = lines.slice(0, 12).map((line) => (
    `<li><time>${clock(line.at)}</time><span>${escapeHtml(show(state.lang, line.text))}</span></li>`
  )).join("") || `<li><time></time><span>${L("emptyLog")}</span></li>`;

  const extra = $("extra");
  const link = phaseLink(state.phase);
  if (link && on) {
    extra.classList.remove("hidden");
    extra.textContent = link[0];
    extra.dataset.url = state.linkUrl || link[1];
  } else {
    extra.classList.add("hidden");
  }
  hideBrokenImages(document.body);
  restoreScroll(spot);
  renderSettings();
  // Kick перерисовывается вместе с Twitch, иначе после смены языка его подписи остаются старыми.
  if (kickState) renderKick(kickState);
  renderExtras();
}

// Эксклюзивный дроп без канала в сети и в нужной игре выбрать нельзя: минуты там не идут.
function isLocked(drop) {
  const channels = drop?.channels || [];
  return channels.length > 0 && !channels.some((channel) => channel?.online === true);
}

function watchChoice(queue, drop) {
  const liveLogin = (item) => {
    const channel = (item?.channels || []).find((entry) => entry?.online === true);
    return channel ? (channel.login || "") : "";
  };
  const open = (item) => item && !item.claimed && item.required > 0 && (item.current || 0) < item.required;
  const own = open(drop) ? liveLogin(drop) : "";
  if (own) return { drop, login: own };
  if (open(drop) && !(drop.channels || []).length) return { drop, login: "" };
  const ranked = (queue || []).filter((item) => open(item) && item.id !== drop?.id && liveLogin(item));
  ranked.sort((left, right) => (right.current > 0) - (left.current > 0)
    || ((right.current || 0) / (right.required || 1)) - ((left.current || 0) / (left.required || 1)));
  const next = ranked[0];
  if (next) return { drop: next, login: liveLogin(next) };
  return { drop, login: "" };
}

// Каналов бывает много: всего два чипа, сначала те, кто в сети, остальных пишем числом.
function peopleHtml(channels, attr) {
  const items = channels.map((channel) => (typeof channel === "string"
    ? { login: channel, online: null }
    : { login: channel.login, online: channel.online }));
  const sorted = [...items.filter((item) => item.online === true), ...items.filter((item) => item.online !== true)];
  const chip = (item) => {
    const cls = item.online === true ? "is-on" : item.online === false ? "is-off" : "is-unknown";
    const word = item.online === true ? L("online") : item.online === false ? L("offline") : L("checking");
    return `<button class="person ${cls}" type="button" ${attr}="${escapeHtml(item.login)}"><i></i>${escapeHtml(item.login)} <em>${word}</em></button>`;
  };
  const rest = sorted.length - 2;
  return sorted.slice(0, 2).map(chip).join("") + (rest > 0 ? `<span class="person more">${L("moreChannels", { n: rest })}</span>` : "");
}

function dropCard(drop, state, showCampaignArt) {
  const live = state.watching && (state.watching.dropId ? drop.id === state.watching.dropId : drop.name === state.watching.name);
  const locked = !live && isLocked(drop);
  const minutes = drop.current || 0;
  const ratio = drop.required ? Math.min(100, Math.round((minutes / drop.required) * 100)) : 0;
  const reward = rewardUrl(drop);
  const camp = campaignUrl(drop);
  const arts = [];
  const bothBox = /ttv-boxart/.test(reward) && /ttv-boxart/.test(camp);
  if (showCampaignArt && camp) arts.push(`<img class="camp-art" src="${escapeHtml(camp)}" alt="">`);
  if (reward && reward !== camp && !bothBox) arts.push(`<img class="thumb" src="${escapeHtml(reward)}" alt="">`);
  else if (showCampaignArt && !arts.length && reward) arts.push(`<img class="thumb" src="${escapeHtml(reward)}" alt="">`);
  const people = peopleHtml(drop.channels || [], "data-open");
  return `
    <article class="drop${live ? " is-current" : ""}${locked ? " is-locked" : ""}${arts.length ? "" : " no-art"}" data-drop="${escapeHtml(drop.id)}">
      ${arts.length ? `<span class="arts">${arts.join("")}</span>` : ""}
      <strong>${escapeHtml(drop.name)}</strong>
      <span class="pct">${ratio}%</span>
      <div class="trackline"><span style="width:${ratio}%"></span></div>
      ${people ? `<div class="people">${people}</div>` : `<div class="any">${L("anyChannel")}</div>`}
    </article>`;
}

function renderBucket(title, items, showCampaignArt, state = latest) {
  if (!items.length) return "";
  const groups = [];
  for (const drop of items) {
    const key = drop.campaignName || drop.game || drop.id;
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, name: drop.campaignName || "", image: campaignUrl(drop), drops: [] };
      groups.push(group);
    }
    if (!group.image) group.image = campaignUrl(drop);
    group.drops.push(drop);
  }
  const cards = groups.map((group) => {
    const head = !showCampaignArt && group.drops.length
      ? `<div class="camp">${group.image ? `<img class="camp-art" src="${escapeHtml(group.image)}" alt="">` : ""}<span>${escapeHtml(group.name)}</span></div>`
      : "";
    return head + group.drops.map((drop) => dropCard(drop, state, showCampaignArt)).join("");
  }).join("");
  return `<section class="bucket${showCampaignArt ? " exclusive" : " general"}"><p class="bucket-label">${title} · ${items.length}</p><div class="bucket-card">${cards}</div></section>`;
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

$("toggle").addEventListener("click", async () => {
  const state = latest || await send({ type: "getState" });
  const on = !(state?.enabled || (kickState ? kickState.enabled : true));
  const [twitch, kick] = await Promise.all([
    send({ type: "setEnabled", enabled: on }),
    send({ type: "setKickEnabled", enabled: on }),
  ]);
  render(twitch);
  renderKick(kick);
});

$("twitch-toggle").addEventListener("click", async () => {
  const state = latest || await send({ type: "getState" });
  render(await send({ type: "setEnabled", enabled: !state?.enabled }));
});

$("now").addEventListener("click", async () => {
  $("now").disabled = true;
  try {
    const [twitch, kick] = await Promise.all([send({ type: "tick" }), send({ type: "kickTick" })]);
    render(twitch);
    renderKick(kick);
  } finally {
    $("now").disabled = false;
  }
});

$("inventory-2").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory" });
});

$("extra").addEventListener("click", () => {
  const url = $("extra").dataset.url;
  if (url) chrome.tabs.create({ url });
});

$("filter").addEventListener("input", (event) => {
  filterText = event.target.value;
  if (latest) render(latest);
  $("filter").value = filterText;
  $("filter").focus();
});

$("langs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-lang]");
  if (!button || !latest) return;
  const lang = button.dataset.lang;
  wantedLang = lang;
  render(latest);
  send({ type: "setLanguage", lang }).then((next) => {
    if (next?.lang === wantedLang) wantedLang = "";
    if (next) render(next);
  });
});

document.body.addEventListener("click", (event) => {
  const kickOpen = event.target.closest("[data-open-kick]");
  if (kickOpen) {
    chrome.tabs.create({ url: `https://kick.com/${kickOpen.dataset.openKick}` });
    return;
  }
  const open = event.target.closest("[data-open]");
  if (open) {
    chrome.tabs.create({ url: `https://www.twitch.tv/${open.dataset.open}` });
    return;
  }
  const kickRow = event.target.closest("[data-kdrop]");
  if (kickRow && viewedSide("kick")) {
    send({ type: "watchKickSideDrop", account: viewedId("kick"), id: kickRow.dataset.kdrop });
    return;
  }
  if (kickRow && kickState) {
    const picked = (kickState.queue || []).find((item) => item.id === kickRow.dataset.kdrop);
    if (picked) {
      const liveNow = picked.live || [];
      renderKick({
        ...kickState,
        preferDropId: picked.id,
        watching: {
          dropId: picked.id,
          name: picked.name,
          game: picked.game,
          login: picked.channels.length ? liveNow[0] || "" : kickState.watching?.login || "",
          current: picked.current,
          required: picked.required,
          exclusive: picked.channels.length > 0,
          image: picked.image,
          campaignImage: picked.campaignImage,
        },
      });
    }
    send({ type: "watchKickDrop", id: kickRow.dataset.kdrop }).then((next) => next && renderKick(next));
    return;
  }
  const row = event.target.closest("[data-drop]");
  if (!row?.dataset.drop || !latest) return;
  // Очередь другого аккаунта: выбор дропа уходит ему, а не аккаунту браузера.
  if (viewedSide("twitch")) {
    const id = viewedId("twitch");
    const picked = (sideFarm[id]?.queue || []).find((item) => item.id === row.dataset.drop);
    if (picked && !isLocked(picked)) {
      sideFarm = { ...sideFarm, [id]: { ...sideFarm[id], preferDropId: picked.id } };
      send({ type: "watchSideDrop", account: id, id: picked.id });
    }
    return;
  }
  const drop = (latest.queue || []).find((item) => item.id === row.dataset.drop);
  if (drop && isLocked(drop)) return;
  if (drop) {
    const picked = watchChoice(latest.queue, drop);
    render({
      ...latest,
      preferDropId: picked.drop.id,
      message: L("watchLine", {
        game: picked.drop.game || "",
        name: picked.drop.name || "",
        login: picked.login || L("channelWord"),
        current: picked.drop.current || 0,
        required: picked.drop.required || 0,
        ratio: picked.drop.required ? Math.min(100, Math.round(((picked.drop.current || 0) / picked.drop.required) * 100)) : 0,
      }),
      watching: {
        dropId: picked.drop.id,
        name: picked.drop.name,
        game: picked.drop.game,
        current: picked.drop.current || 0,
        required: picked.drop.required || 0,
        login: picked.login,
        image: picked.drop.image || "",
        campaignImage: picked.drop.campaignImage || "",
        gameId: picked.drop.gameId || "",
        streamer: Boolean(picked.drop.channels?.length),
      },
    });
  }
  send({ type: "watchDrop", id: row.dataset.drop }).then((state) => state && render(state));
});

// Ответ на прежний клик приходит уже после следующего: применять его нельзя, он откатил бы новую отметку.
let gameEdit = 0;
$("games").addEventListener("change", (event) => {
  const box = event.target.closest("input[data-game]");
  if (!box || !latest) return;
  gameEdit += 1;
  const mark = gameEdit;
  const last = (apply) => (value) => { if (mark === gameEdit) apply(value); };
  const ids = selectedGameIds();
  if (box.checked) ids.add(box.dataset.game);
  else ids.delete(box.dataset.game);

  if (gamesSide === "kick") {
    const picked = [...ids].map((id) => id.slice(2));
    if (editsLive("kick")) {
      settings = { ...settings, picked };
      send({ type: "setSettings", patch: { picked } }).then(last((next) => { if (next) settings = next; }));
    } else {
      // Выбор для неактивного аккаунта сохраняется в его записи и применится при переключении.
      const account = targetAccount("kick");
      if (account) account.picked = picked;
      send({ type: "setAccountSelection", platform: "kick", id: targetId("kick"), patch: { picked } }).then(last(applyAccounts));
    }
    render(latest);
    return;
  }

  // wishes — названия, добавленные вручную: по ним игра выберется сама, когда у неё появится кампания.
  // Снятая игра уходит и оттуда, иначе она выберется снова.
  const typedName = (box.dataset.name || "").trim();
  const before = twitchWishes();
  const wishes = before.filter((item) => item.toLowerCase() !== typedName.toLowerCase());
  if (box.checked && box.dataset.game.startsWith("w:") && typedName) wishes.push(typedName);
  const wishesChanged = wishes.join("\n") !== before.join("\n");
  const twitchIds = [...ids].filter((id) => !id.startsWith("w:"));
  if (!editsLive("twitch")) {
    const account = targetAccount("twitch");
    if (account) Object.assign(account, { whitelist: twitchIds, wishes });
    send({ type: "setAccountSelection", platform: "twitch", id: targetId("twitch"), patch: { whitelist: twitchIds, wishes } }).then(last(applyAccounts));
    render(latest);
    return;
  }
  if (wishesChanged) {
    settings = { ...settings, wishes };
    send({ type: "setSettings", patch: { wishes } }).then(last((next) => { if (next) settings = { ...settings, wishes: next.wishes }; }));
  }
  const names = new Set((latest.games || []).filter((game) => twitchIds.includes(game.id)).map((game) => game.name));
  render({
    ...latest,
    whitelist: twitchIds,
    games: (latest.games || []).map((game) => ({ ...game, selected: twitchIds.includes(game.id) })),
    queue: settings.autoAll ? latest.queue : (latest.queue || []).filter((drop) => names.has(drop.game)),
    watching: settings.autoAll || (latest.watching && names.has(latest.watching.game)) ? latest.watching : null,
  });
  send({ type: "setWhitelist", ids: twitchIds }).then(last((state) => state && render(state)));
});

let kickState = null;
let kickPing = null;
let accounts = null;
let pointsState = null;
let kickPointsState = null;
// Какая платформа открыта на вкладке баллов.
let pointsSide = "kick";
try {
  if (FEATURES.twitchPoints && localStorage.getItem("pointsSide") !== "kick") pointsSide = "twitch";
} catch {
  // Без хранилища открывается Kick.
}
let historyList = [];
let pointsQuery = "";
let pointsFound = [];
let pointsSearchTimer = 0;
let pendingAdd = "";
// Для какого аккаунта правим выбор игр и каналов; пусто = активный.
const editing = { twitch: "", kick: "" };

// Баллы спрятаны целиком, пока выключены обе платформы (FEATURES в lib/constants.js).
const POINTS_UI = FEATURES.twitchPoints || FEATURES.kickPoints;

function savedTab() {
  try {
    const tab = localStorage.getItem("tab") || "twitch";
    return tab === "points" && !POINTS_UI ? "twitch" : tab;
  } catch {
    return "twitch";
  }
}

function setTab(name) {
  for (const key of ["twitch", "kick", "points", "games", "history"]) {
    $(`panel-${key}`).classList.toggle("hidden", key !== name);
  }
  document.querySelectorAll("#tabs [data-tab]").forEach((button) => {
    button.classList.toggle("on", button.dataset.tab === name);
  });
  try {
    localStorage.setItem("tab", name);
  } catch {
    // Без хранилища вкладка просто не запоминается.
  }
}

$("tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) setTab(button.dataset.tab);
});
setTab(savedTab());
let lastKickGames = "";

function renderKickHero(state) {
  const item = state.enabled ? state.watching : null;
  const message = !state.enabled
    ? L("kickIdle")
    : state.phase === "need-login" ? L("noLoginShort") : show(latest?.lang, state.message) || L("waitFirst");
  paintHero($("kick-watch"), {
    platform: "Kick",
    user: state.user || "",
    item,
    on: state.enabled,
    ping: item && kickPing?.login === item.login ? ago(kickPing.at).text : "",
    openAttr: "data-open-kick",
    backdrop: item ? safeUrl(item.campaignImage) : "",
    reward: item ? safeUrl(item.image) : "",
    message,
    bad: state.phase === "need-login" || state.phase === "error",
  });
}

function kickCard(row, state, showCampaignArt) {
  const ratio = row.required ? Math.min(100, Math.round((row.current / row.required) * 100)) : 0;
  const live = state.watching?.dropId === row.id;
  const arts = [];
  if (showCampaignArt && safeUrl(row.campaignImage)) arts.push(`<img class="camp-art" src="${escapeHtml(row.campaignImage)}" alt="">`);
  if (safeUrl(row.image)) arts.push(`<img class="thumb" src="${escapeHtml(row.image)}" alt="">`);
  const liveNow = new Set(row.live || []);
  // Как у Twitch: дроп без канала в эфире или без привязки выбрать нельзя, минуты там не идут.
  const locked = !live && (!row.linked || (row.channels.length > 0 && !liveNow.size));
  const people = row.linked && row.channels.length
    ? peopleHtml(row.channels.map((slug) => ({ login: slug, online: liveNow.has(slug) })), "data-open-kick")
    : "";
  const note = !row.linked ? L("kickLinkNeeded") : L("anyChannel");
  return `
    <article class="drop${live ? " is-current" : ""}${locked ? " is-locked" : ""}${arts.length ? "" : " no-art"}"${locked ? "" : ` data-kdrop="${escapeHtml(row.id)}"`}>
      ${arts.length ? `<span class="arts">${arts.join("")}</span>` : ""}
      <strong>${escapeHtml(row.name)}</strong>
      <span class="pct">${ratio}%</span>
      <div class="trackline"><span style="width:${ratio}%"></span></div>
      ${people ? `<div class="people">${people}</div>` : `<div class="any">${escapeHtml(note)}</div>`}
    </article>`;
}

function kickBucket(title, items, state, showCampaignArt) {
  if (!items.length) return "";
  const groups = [];
  for (const row of items) {
    let group = groups.find((item) => item.key === row.campaignId);
    if (!group) {
      group = { key: row.campaignId, name: row.campaign, image: row.campaignImage, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  const cards = groups.map((group) => {
    const head = !showCampaignArt
      ? `<div class="camp">${safeUrl(group.image) ? `<img class="camp-art" src="${escapeHtml(group.image)}" alt="">` : ""}<span>${escapeHtml(group.name)}</span></div>`
      : "";
    return head + group.rows.map((row) => kickCard(row, state, showCampaignArt)).join("");
  }).join("");
  return `<section class="bucket${showCampaignArt ? " exclusive" : " general"}"><p class="bucket-label">${title} · ${items.length}</p><div class="bucket-card">${cards}</div></section>`;
}

function renderKickQueue(state) {
  const activeId = state.watching?.dropId || "";
  const rows = (state.queue || []).filter((row) => !row.claimed);
  const rank = (row) => (row.id === activeId ? -1 : 0);
  const sorted = [...rows].sort((left, right) => (rank(left) - rank(right)) || ((right.progress || 0) - (left.progress || 0)));
  return kickBucket(L("exclusive"), sorted.filter((row) => row.channels.length), state, true)
    + kickBucket(L("regular"), sorted.filter((row) => !row.channels.length), state, false);
}

function blackNames() {
  const names = new Map();
  for (const game of latest?.games || []) if (game.name) names.set(game.name.toLowerCase(), game.name);
  for (const row of kickState?.queue || []) if (row.game) names.set(row.game.toLowerCase(), row.game);
  for (const name of settings.blacklist) names.set(name.toLowerCase(), name);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function renderSettings() {
  $("settings-title").textContent = L("settings");
  $("lang-label").textContent = L("language");
  $("twitch-label").textContent = L("mineTwitch");
  $("kick-label").textContent = L("mineKick");
  $("auto-title").textContent = L("autoTitle");
  $("auto-hint").textContent = L("autoHint");
  $("auto").setAttribute("aria-pressed", settings.autoAll ? "true" : "false");
  $("black-title").textContent = L("blackTitle");
  $("black-hint").textContent = L("blackHint");
  $("black").classList.toggle("dim", !settings.autoAll);
  $("black-filter").placeholder = L("blackPlaceholder");
  const blocked = new Set(settings.blacklist.map((name) => name.toLowerCase()));
  $("black-count").textContent = blocked.size ? String(blocked.size) : "";
  const query = blackFilter.trim().toLowerCase();
  const pool = blackNames().filter((name) => (query ? name.toLowerCase().includes(query) : blocked.has(name.toLowerCase())));
  setHtml($("black-list"), pool.length
    ? pool.map((name) => `<label class="game${blocked.has(name.toLowerCase()) ? " on" : ""}"><input data-black="${escapeHtml(name)}" type="checkbox" ${blocked.has(name.toLowerCase()) ? "checked" : ""}><span><strong>${escapeHtml(name)}</strong></span><span class="check"></span></label>`).join("")
    : `<p class="empty">${L("blackEmpty")}</p>`);
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  renderSettings();
  if (latest) render(latest);
  settings = (await send({ type: "setSettings", patch })) || settings;
  renderSettings();
}

$("gear").addEventListener("click", () => {
  const open = $("gear").getAttribute("aria-pressed") !== "true";
  $("gear").setAttribute("aria-pressed", open ? "true" : "false");
  $("settings").classList.toggle("hidden", !open);
  $("main").classList.toggle("hidden", open);
  if (open) renderSettings();
});

$("auto").addEventListener("click", () => saveSettings({ autoAll: !settings.autoAll }));

$("black-filter").addEventListener("input", (event) => {
  blackFilter = event.target.value;
  renderSettings();
  $("black-filter").value = blackFilter;
  $("black-filter").focus();
});

$("black-list").addEventListener("change", (event) => {
  const box = event.target.closest("input[data-black]");
  if (!box) return;
  const list = new Set(settings.blacklist);
  if (box.checked) list.add(box.dataset.black);
  else for (const name of list) if (name.toLowerCase() === box.dataset.black.toLowerCase()) list.delete(name);
  saveSettings({ blacklist: [...list] });
});

function renderKick(state) {
  if (!state) return;
  kickState = state;
  paintSwitches(latest, state);
  paintAccount();
  const status = $("kick-status");
  const open = (state.queue || []).filter((row) => !row.claimed);
  status.className = "status" + (state.phase === "need-login" || state.phase === "error" ? " bad" : "");
  status.textContent = !state.enabled
    ? L("kickIdle")
    : state.watching
      ? `${state.watching.login} · ${state.watching.name} · ${L("outOf", { current: state.watching.current, required: state.watching.required })}`
      : show(latest?.lang, state.message) || L("waitFirst");
  renderKickHero(state);
  const kickOpen = (state.queue || []).filter((row) => !row.claimed).length;
  $("tab-kick-n").textContent = state.enabled && kickOpen ? String(kickOpen) : "";
  status.classList.toggle("hidden", !state.enabled || state.phase !== "error");
  paintViewChips("kick");
  const otherKick = viewedSide("kick");
  const shown = otherKick ? { ...state, queue: otherKick.queue || [], watching: otherKick.watching || null } : state;
  setHtml($("kick-list"), state.enabled ? renderKickQueue(shown) : "");
  const extra = $("kick-extra");
  const wantsLink = state.enabled && (state.phase === "pick-game" || state.phase === "not-linked");
  extra.classList.toggle("hidden", !wantsLink);
  extra.textContent = L("kickCampaigns");
  extra.dataset.url = state.linkUrl || "https://kick.com/drops/campaigns";
  const games = JSON.stringify(state.games || []);
  const changed = games !== lastKickGames;
  lastKickGames = games;
  $("kick-login").classList.toggle("hidden", state.phase !== "need-login" || !state.enabled);
  $("kick-login").textContent = L("kickSignIn");
  if (changed && latest) render(latest);
}

$("kick-toggle").addEventListener("click", async () => {
  const on = !(kickState?.enabled ?? true);
  renderKick({ ...(kickState || {}), enabled: on });
  renderKick(await send({ type: "setKickEnabled", enabled: on }));
});

$("kick-extra").addEventListener("click", () => {
  const url = $("kick-extra").dataset.url;
  if (url) chrome.tabs.create({ url });
});

$("kick-login").addEventListener("click", () => chrome.tabs.create({ url: "https://kick.com/" }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Смена аккаунта подставляет в настройки его игры Kick и ожидающие названия: без этого попап показал бы
  // и записал список прежнего аккаунта новому.
  if (changes.settings?.newValue) {
    settings = { ...settings, ...changes.settings.newValue };
    if (latest && !changes.state?.newValue) render(latest);
  }
  if (changes.state?.newValue) render(changes.state.newValue);
  if (changes.kick?.newValue) renderKick(changes.kick.newValue);
  if (changes.kickPing?.newValue) {
    kickPing = changes.kickPing.newValue;
    if (kickState) renderKick(kickState);
  }
});

chrome.storage.local.get("kickPing").then((value) => {
  kickPing = value.kickPing || null;
  if (kickState) renderKick(kickState);
});

// «Пинг N с назад» тикает сам, даже если состояние не менялось.
setInterval(() => {
  if (latest) render(latest);
}, 15000);

send({ type: "getState" }).then(render);
send({ type: "getKick" }).then(renderKick);
send({ type: "getSettings" }).then((value) => {
  if (value) settings = value;
  if (latest) render(latest);
  renderSettings();
});


// ---------- Баллы, история, аккаунты ----------

function accountChips(platform) {
  const mine = side(platform);
  if (mine.list.length < 2) return "";
  const target = targetId(platform);
  const chips = mine.list.map((item) => (
    `<button class="acc-chip${item.id === target ? " on" : ""}" type="button" data-edit="${platform}" data-id="${escapeHtml(item.id)}">${escapeHtml(item.login || item.id)}</button>`
  )).join("");
  return `<div class="acc-row"><span>${platform === "twitch" ? "Twitch" : "Kick"}</span>${chips}</div>`;
}

// Подпись над списком игр: что он значит и чей он.
function paintGamesHint() {
  const login = targetAccount(gamesSide)?.login || "";
  const who = `${gamesSide === "twitch" ? "Twitch" : "Kick"} ${login}`.trim();
  $("games-hint").textContent = `${L(settings.autoAll ? "gamesHintPriority" : "gamesHintOnly")} ${L("gamesHintWho", { who })}`;
}

// Выбор, чей список игр открыт: по одной кнопке на аккаунт (или на площадку, если аккаунтов нет).
function gamesChips() {
  const chips = [];
  for (const platform of ["twitch", "kick"]) {
    const mine = side(platform);
    const rows = mine.list.length ? mine.list : [{ id: "", login: "" }];
    for (const item of rows) {
      const on = platform === gamesSide && (!item.id || item.id === targetId(platform));
      chips.push(`<button class="acc-chip${on ? " on" : ""}" type="button" data-games-side="${platform}" data-id="${escapeHtml(item.id)}"><b>${platform === "twitch" ? "Twitch" : "Kick"}</b>${escapeHtml(item.login || "")}</button>`);
    }
  }
  return `<div class="acc-cap">${escapeHtml(L("gamesEditWho"))}</div><div class="acc-row">${chips.join("")}</div>`;
}

function sideState(platform = pointsSide) {
  return platform === "kick" ? kickPointsState : pointsState;
}

function pointsChannels(platform = pointsSide) {
  return editsLive(platform) ? sideState(platform)?.channels || [] : targetAccount(platform)?.points || [];
}

function channelRow(channel, picked) {
  const info = picked && editsLive(pointsSide) ? sideState()?.status?.[channel.login] || {} : {};
  const live = picked ? info.live : channel.live;
  const bits = [];
  if (picked) {
    bits.push(`<i class="dot${info.live ? " on" : ""}"></i>${info.live ? L("pointsLive") : L("pointsOffline")}`);
    if (info.watching && info.live) bits.push(L("pointsWatching"));
    if (info.lastGain && (info.claimedAt || info.gainAt)) bits.push(`+${info.lastGain} · ${clock(info.claimedAt || info.gainAt)}`);
  } else {
    bits.push(`<i class="dot${live ? " on" : ""}"></i>${live ? L("pointsLive") : L("pointsOffline")}`);
  }
  const amount = picked && typeof info.balance === "number" ? `<span class="amount">${info.balance.toLocaleString()}</span>` : "";
  return `
    <label class="game${picked ? " on" : ""}">
      <input type="checkbox" data-channel="${escapeHtml(channel.login)}" ${picked ? "checked" : ""}>
      ${safeUrl(channel.image) ? `<img class="avatar" src="${escapeHtml(channel.image)}" alt="">` : ""}
      <span><strong>${escapeHtml(channel.name || channel.login)}</strong><small>${bits.join(" · ")}</small></span>
      ${amount}
      <span class="check"></span>
    </label>`;
}

function dropChannelRow(login, info) {
  const amount = typeof info.balance === "number" ? `<span class="amount">${info.balance.toLocaleString()}</span>` : "";
  const bits = [`<i class="dot on"></i>${L("pointsDropChannel")}`];
  if (info.lastGain && (info.claimedAt || info.gainAt)) bits.push(`+${info.lastGain} · ${clock(info.claimedAt || info.gainAt)}`);
  return `<div class="game auto"><span><strong>${escapeHtml(login)}</strong><small>${bits.join(" · ")}</small></span>${amount}</div>`;
}

function renderPoints() {
  document.querySelector('#tabs [data-tab="points"]').classList.toggle("hidden", !POINTS_UI);
  $("points-row").classList.toggle("hidden", !POINTS_UI);
  if (!POINTS_UI) return;
  $("tab-points-label").textContent = L("tabPoints");
  $("points-title").textContent = L("pointsTitle");
  $("points-hint").textContent = L(pointsSide === "kick" ? "kickPointsHint" : "pointsHint");
  $("points-sides").classList.toggle("hidden", !FEATURES.twitchPoints);
  for (const button of $("points-sides").querySelectorAll("button")) button.classList.toggle("on", button.dataset.side === pointsSide);
  $("points-filter").placeholder = L("pointsSearch");
  const pointsOn = Boolean(pointsState?.enabled);
  $("points-label").textContent = L("pointsToggle");
  $("points-toggle-hint").textContent = L("pointsToggleHint");
  $("points-toggle").setAttribute("aria-pressed", pointsOn ? "true" : "false");
  $("points-off").textContent = L("pointsOff");
  $("points-off").classList.toggle("hidden", pointsOn);
  const channels = pointsChannels();
  const chosen = new Set(channels.map((channel) => channel.login));
  $("points-count").textContent = channels.length ? String(channels.length) : "";
  const total = (FEATURES.twitchPoints ? pointsChannels("twitch").length : 0) + pointsChannels("kick").length;
  $("tab-points-n").textContent = total ? String(total) : "";
  $("points-accounts").innerHTML = accountChips(pointsSide);
  const found = pointsFound.filter((channel) => !chosen.has(channel.login));
  setHtml($("points-results"), pointsQuery.trim()
    ? (found.length ? found.map((channel) => channelRow(channel, false)).join("") : `<p class="empty">${L(pointsFound.error === "need-login" ? "pointsNeedLogin" : "pointsNone")}</p>`)
    : "");
  // Канал, где сейчас фармится дроп: проверяется сам, в список его добавлять не нужно.
  const dropRows = editsLive(pointsSide) && pointsOn
    ? Object.entries(sideState()?.status || {}).filter(([login, info]) => info.drop && !chosen.has(login))
      .map(([login, info]) => dropChannelRow(login, info)).join("")
    : "";
  setHtml($("points-list"), (channels.length
    ? channels.map((channel) => channelRow(channel, true)).join("")
    : (pointsQuery.trim() || dropRows ? "" : `<p class="empty">${L("pointsEmpty")}</p>`)) + dropRows);
  hideBrokenImages($("panel-points"));
}

function savePoints(channels) {
  const platform = pointsSide;
  const put = (value) => {
    if (platform === "kick") kickPointsState = value;
    else pointsState = value;
  };
  if (editsLive(platform)) {
    put({ ...(sideState(platform) || {}), channels });
    send({ type: platform === "kick" ? "setKickPointsChannels" : "setPointsChannels", channels })
      .then((next) => { if (next) put(next); renderPoints(); });
  } else {
    const account = targetAccount(platform);
    if (account) account.points = channels;
    send({ type: "setAccountSelection", platform, id: targetId(platform), patch: { points: channels } }).then(applyAccounts);
  }
  renderPoints();
}

$("points-filter").addEventListener("input", (event) => {
  pointsQuery = event.target.value;
  clearTimeout(pointsSearchTimer);
  if (!pointsQuery.trim()) {
    pointsFound = [];
    renderPoints();
    return;
  }
  const asked = pointsQuery;
  pointsSearchTimer = setTimeout(async () => {
    const platform = pointsSide;
    const reply = await send({ type: platform === "kick" ? "searchKickChannels" : "searchChannels", query: asked });
    if (asked !== pointsQuery || platform !== pointsSide) return;
    pointsFound = reply?.items || [];
    pointsFound.error = reply?.error || "";
    renderPoints();
  }, 350);
});

$("points-sides").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-side]");
  if (!button || button.dataset.side === pointsSide) return;
  pointsSide = button.dataset.side;
  try {
    localStorage.setItem("pointsSide", pointsSide);
  } catch {
    // Без хранилища выбор просто не запоминается.
  }
  pointsQuery = "";
  pointsFound = [];
  $("points-filter").value = "";
  renderPoints();
});

$("points-toggle").addEventListener("click", async () => {
  const on = !pointsState?.enabled;
  pointsState = { ...(pointsState || {}), enabled: on };
  renderPoints();
  const next = await send({ type: "setPointsEnabled", enabled: on });
  if (next) pointsState = next;
  renderPoints();
});

$("panel-points").addEventListener("change", (event) => {
  const box = event.target.closest("input[data-channel]");
  if (!box) return;
  const login = box.dataset.channel;
  const current = pointsChannels();
  if (box.checked) {
    const found = pointsFound.find((channel) => channel.login === login);
    if (!found) return;
    savePoints([...current, { login: found.login, id: found.id, name: found.name, image: found.image }]);
  } else {
    savePoints(current.filter((channel) => channel.login !== login));
  }
});

function historyRow(item) {
  const platform = item.platform === "kick" ? "Kick" : "Twitch";
  const art = item.kind === "points"
    ? (safeUrl(item.image) ? `<img class="avatar" src="${escapeHtml(item.image)}" alt="">` : `<span class="badge">+</span>`)
    : (safeUrl(item.image) ? `<img class="thumb" src="${escapeHtml(item.image)}" alt="">` : `<span class="badge">${platform[0]}</span>`);
  const title = item.kind === "points" ? `${item.name} ${L("pointsWord")}` : item.name;
  const sub = [item.game, platform, item.account].filter(Boolean).join(" · ");
  const locale = resolveLang(latest?.lang) === "en" ? "en-US" : "ru-RU";
  const day = new Date(item.at).toLocaleDateString(locale, { day: "numeric", month: "short" });
  return `<div class="hist">${art}<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(sub)}</small></span><time>${day}<br>${clock(item.at)}</time></div>`;
}

function renderHistory() {
  $("tab-history-label").textContent = L("tabHistory");
  $("history-title").textContent = L("historyTitle");
  $("history-clear").textContent = historyList.length ? L("historyClear") : "";
  setHtml($("history-list"), historyList.length
    ? historyList.slice(0, 100).map(historyRow).join("")
    : `<p class="empty">${L("historyEmpty")}</p>`);
  hideBrokenImages($("panel-history"));
}

$("history-clear").addEventListener("click", async () => {
  historyList = (await send({ type: "clearHistory" })) || [];
  renderHistory();
});

function renderAccounts() {
  $("accounts-title").textContent = L("accountsTitle");
  $("accounts-hint").textContent = L("accountsHint");
  $("add-twitch").textContent = L("addTwitch");
  $("add-kick").textContent = L("addKick");
  $("rotate-title").textContent = L("rotateTitle");
  $("accounts-confirm-text").textContent = L("accountsConfirm");
  $("accounts-confirm-yes").textContent = L("continueWord");
  $("accounts-confirm-no").textContent = L("cancelWord");
  $("accounts-adding").textContent = addingNow
    ? `${L("accountAdding", { site: addingNow === "kick" ? "Kick" : "Twitch" })} ${L("accountAddingGoogle")}`
    : "";
  $("accounts-adding").classList.toggle("hidden", !addingNow);
  const rows = [];
  for (const platform of ["twitch", "kick"]) {
    const mine = side(platform);
    for (const item of mine.list) {
      const active = item.id === mine.active;
      rows.push(`
        <div class="row acc-item" data-switch="${platform}" data-id="${escapeHtml(item.id)}">
          <span class="tag ${platform}">${platform === "twitch" ? "Twitch" : "Kick"}</span>
          <div class="row-text"><strong>${escapeHtml(item.login || item.id)}</strong></div>
          ${item.expired ? `<span class="state bad">${L("accountExpired")}</span>` : active ? `<span class="state">${L("accountActive")}</span>` : ""}
          <button class="x" type="button" data-remove="${platform}" data-id="${escapeHtml(item.id)}" aria-label="${L("removeWord")}">×</button>
        </div>`);
    }
  }
  setHtml($("accounts-list"), rows.join("") || `<p class="empty">${L("accountsEmpty")}</p>`);
  const rotate = accounts?.rotate || { mode: "all", limit: 1 };
  const select = $("rotate-mode");
  const options = [["all", L("rotateAll")], ["campaigns", L("rotateCampaigns")], ["done", L("rotateDone")], ["never", L("rotateNever")]];
  const html = options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  if (select.__html !== html) {
    select.__html = html;
    select.innerHTML = html;
  }
  select.value = rotate.mode;
  $("rotate-limit").classList.toggle("hidden", rotate.mode !== "campaigns");
  if (document.activeElement !== $("rotate-limit")) $("rotate-limit").value = rotate.limit;
  $("rotate-hint").textContent = L({ all: "rotateHintAll", campaigns: "rotateHintCampaigns", done: "rotateHintDone" }[rotate.mode] || "rotateHintNever");
}

// Платформа, для которой сейчас открыто окно входа.
let addingNow = "";

function applyAccounts(next) {
  if (!next) return;
  if ("adding" in next) addingNow = next.adding || "";
  accounts = next;
  renderExtras();
  if (latest) render(latest);
}

function startAdd(platform) {
  if (!accounts?.warned) {
    pendingAdd = platform;
    $("accounts-confirm").classList.remove("hidden");
    return;
  }
  addingNow = platform;
  askGoogle(platform).then(() => send({ type: "addAccount", platform }));
  renderAccounts();
}

// Просим доступ к странице входа Google: тогда при входе через Google покажется выбор аккаунта.
// Отказ ничего не ломает, поэтому спрашиваем один раз.
async function askGoogle() {
  const origins = ["https://accounts.google.com/*"];
  try {
    if (localStorage.getItem("googleAsked") === "no") return;
    if (await chrome.permissions.contains({ origins })) return;
    // Отметку ставим только по ответу пользователя: запрос без жеста просто не показывается и повторится.
    const granted = await chrome.permissions.request({ origins });
    if (!granted) localStorage.setItem("googleAsked", "no");
  } catch {
    // Нет жеста пользователя или API недоступен.
  }
}

$("add-twitch").addEventListener("click", () => startAdd("twitch"));
$("add-kick").addEventListener("click", () => startAdd("kick"));
$("accounts-confirm-no").addEventListener("click", () => {
  pendingAdd = "";
  $("accounts-confirm").classList.add("hidden");
});
$("accounts-confirm-yes").addEventListener("click", async () => {
  $("accounts-confirm").classList.add("hidden");
  applyAccounts(await send({ type: "setAccountsWarned" }));
  if (pendingAdd) {
    const platform = pendingAdd;
    addingNow = platform;
    askGoogle(platform).then(() => send({ type: "addAccount", platform }));
    renderAccounts();
  }
  pendingAdd = "";
});

$("accounts-list").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    applyAccounts(await send({ type: "removeAccount", platform: remove.dataset.remove, id: remove.dataset.id }));
    return;
  }
  const row = event.target.closest("[data-switch]");
  if (!row) return;
  // Сессия аккаунта умерла: по клику открываем окно входа, после входа куки обновятся.
  if (side(row.dataset.switch).list.find((item) => item.id === row.dataset.id)?.expired) {
    addingNow = row.dataset.switch;
    const platform = row.dataset.switch;
    askGoogle(platform).then(() => send({ type: "addAccount", platform }));
    renderAccounts();
    return;
  }
  if (side(row.dataset.switch).active === row.dataset.id) return;
  applyAccounts(await send({ type: "switchAccount", platform: row.dataset.switch, id: row.dataset.id }));
});

$("rotate-mode").addEventListener("change", async (event) => {
  applyAccounts(await send({ type: "setRotation", patch: { mode: event.target.value } }));
});
$("rotate-limit").addEventListener("change", async (event) => {
  applyAccounts(await send({ type: "setRotation", patch: { limit: Number(event.target.value) } }));
});

document.body.addEventListener("click", (event) => {
  const pick = event.target.closest("[data-games-side]");
  if (pick) {
    gamesSide = pick.dataset.gamesSide;
    if (pick.dataset.id) editing[gamesSide] = pick.dataset.id;
    try {
      localStorage.setItem("gamesSide", gamesSide);
    } catch {
      // Без хранилища выбор просто не запоминается.
    }
    filterText = "";
    $("filter").value = "";
    renderExtras();
    if (latest) render(latest);
    return;
  }
  const chip = event.target.closest("[data-edit]");
  if (!chip) return;
  editing[chip.dataset.edit] = chip.dataset.id;
  renderExtras();
  if (latest) render(latest);
});

function renderExtras() {
  renderSideCards();
  renderPoints();
  renderHistory();
  renderAccounts();
  $("games-accounts").innerHTML = gamesChips();
  paintGamesHint();
}

// Куки аккаунтов попапу не нужны: из хранилища берём только то, что показываем.
function publicSide(raw) {
  return {
    active: raw?.active || "",
    done: raw?.done || 0,
    list: (raw?.list || []).map((item) => ({
      id: item.id, login: item.login, whitelist: item.whitelist || [], picked: item.picked || [], points: item.points || [], wishes: item.wishes || [],
      expired: Boolean(item.expired),
    })),
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  // Окно входа открылось или закрылось: обновляем подсказку и список аккаунтов.
  if (area === "session" && changes.accountAdd) {
    addingNow = changes.accountAdd.newValue?.platform || "";
    renderAccounts();
    send({ type: "getAccounts" }).then(applyAccounts);
    return;
  }
  if (area !== "local") return;
  if (changes.points?.newValue) {
    pointsState = changes.points.newValue;
    renderPoints();
  }
  if (changes.side) {
    sideFarm = changes.side.newValue || {};
    renderSideCards();
    if (viewedSide("twitch") && latest) render(latest);
  }
  if (changes.kickSide) {
    kickSideFarm = changes.kickSide.newValue || {};
    renderSideCards();
    if (viewedSide("kick") && kickState) renderKick(kickState);
  }
  if (changes.kickPoints?.newValue) {
    kickPointsState = changes.kickPoints.newValue;
    renderPoints();
  }
  if (changes.history?.newValue) {
    historyList = changes.history.newValue;
    renderHistory();
  }
  if (changes.accounts?.newValue) {
    const raw = changes.accounts.newValue;
    accounts = { twitch: publicSide(raw.twitch), kick: publicSide(raw.kick), rotate: raw.rotate || accounts?.rotate, warned: Boolean(raw.warned) };
    renderExtras();
  }
});

send({ type: "getPoints" }).then((value) => { pointsState = value; renderPoints(); });
send({ type: "getKickPoints" }).then((value) => { kickPointsState = value; renderPoints(); });
send({ type: "getSide" }).then((value) => { sideFarm = value || {}; renderSideCards(); });
send({ type: "getKickSide" }).then((value) => { kickSideFarm = value || {}; renderSideCards(); });
send({ type: "getHistory" }).then((value) => { historyList = value || []; renderHistory(); });
send({ type: "getAccounts" }).then(applyAccounts);
