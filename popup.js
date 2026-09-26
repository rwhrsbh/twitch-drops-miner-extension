import { resolveLang, t } from "./lib/i18n.js";

const $ = (id) => document.getElementById(id);

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
  return `<span class="chip ${state}"><i></i>${escapeHtml(login)} <em>${label}</em><button type="button" data-open="${escapeHtml(login)}">эфир</button></span>`;
}

function gameMeta(game) {
  const bits = [];
  if (!game.linked) bits.push(L("notLinkedGame"));
  if (game.total) bits.push(game.left ? L("ofTotal", { left: game.left, total: game.total }) : L("gotAll"));
  else bits.push(game.campaigns === 1 ? L("oneCampaign") : L("manyCampaigns", { count: game.campaigns }));
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

function render(state) {
  if (!state) return;
  const spot = rememberScroll();
  latest = state;
  const on = Boolean(state.enabled);
  $("toggle").setAttribute("aria-pressed", on ? "true" : "false");

  const lang = resolveLang(state.lang);
  document.documentElement.lang = lang;
  $("title").textContent = L("title");
  $("farm-title").textContent = L("farmHeading");
  $("games-title").textContent = L("gamesHeading");
  $("log-title").textContent = L("journal");
  $("now").textContent = L("refresh");
  $("inventory").textContent = L("inventory");
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
    : (state.message || L("waitFirst"));
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

  $("account").textContent = state.user ? state.user.login : L("noLogin");

  const watch = $("watch");
  if (state.watching) {
    const item = state.watching;
    const shownMinutes = item.current || 0;
    const ratio = item.required ? Math.min(100, Math.round((shownMinutes / item.required) * 100)) : 0;
    const backdrop = campaignUrl(item);
    const reward = rewardUrl(item);
    const rewardTag = reward && reward !== backdrop
      ? `<img class="hero-art" src="${escapeHtml(reward)}" alt="">`
      : "";
    watch.classList.remove("hidden");
    watch.innerHTML = `
      ${backdrop ? `<img class="hero-bg" src="${escapeHtml(backdrop)}" alt="">` : ""}
      <div class="ring" style="--p:${ratio}">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="16"></circle>
          <circle class="value" cx="18" cy="18" r="16"></circle>
        </svg>
        <b>${ratio}%</b>
      </div>
      <div>
        <p class="eyebrow">${on ? L("farmingNow") : L("paused")}</p>
        <h2>${escapeHtml(item.name)}</h2>
        <p class="fine">${escapeHtml(item.game)} · ${L("minutesShort", { current: shownMinutes, required: item.required })} · ${ping.text}</p>
        <button class="channel" type="button" data-open="${escapeHtml(item.login)}"><i></i>${escapeHtml(item.login)}</button>
      </div>
      ${rewardTag}
    `;
  } else {
    watch.classList.add("hidden");
    watch.innerHTML = "";
  }

  const query = filterText.trim().toLowerCase();
  const selectedIds = new Set(state.whitelist || []);
  const pool = (state.games || []).filter((game) => {
    if (!query) return selectedIds.has(game.id);
    return game.name.toLowerCase().includes(query);
  });
  $("game-count").textContent = selectedIds.size ? String(selectedIds.size) : "";
  $("games").innerHTML = pool.length
    ? pool.map((game) => {
      const art = safeUrl(game.image) || boxArt(game.id, "144x192");
      return `
      <label class="game${selectedIds.has(game.id) ? " on" : ""}">
        <input data-game="${escapeHtml(game.id)}" type="checkbox" ${selectedIds.has(game.id) ? "checked" : ""}>
        ${art ? `<img class="game-art" src="${escapeHtml(art)}" alt="">` : ""}
        <span>
          <strong>${escapeHtml(game.name)}</strong>
          <small>${escapeHtml(gameMeta(game))}</small>
        </span>
        <span class="check"></span>
      </label>`;
    }).join("")
    : `<p class="empty">${query ? L("noSuchGame") : L("typeToAdd")}</p>`;

  const queue = $("queue");
  const activeId = state.watching?.dropId || "";
  const drops = (state.queue || []).filter((drop) => !drop.claimed);
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
    queue.innerHTML = [
      renderBucket(L("exclusive"), exclusive, true),
      renderBucket(L("regular"), general, false),
    ].join("");
  } else {
    queue.classList.add("hidden");
    queue.innerHTML = "";
  }

  const lines = (state.log || []).filter((line) => !/нет соединения/.test(line.text));
  $("log").innerHTML = lines.slice(0, 12).map((line) => (
    `<li><time>${clock(line.at)}</time><span>${escapeHtml(line.text)}</span></li>`
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

function dropCard(drop, state, showCampaignArt) {
  const live = state.watching && (drop.id === state.watching.dropId || drop.name === state.watching.name);
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
  const people = (drop.channels || []).map((channel) => {
    const login = typeof channel === "string" ? channel : channel.login;
    const online = typeof channel === "string" ? null : channel.online;
    const cls = online === true ? "is-on" : online === false ? "is-off" : "is-unknown";
    const word = online === true ? L("online") : online === false ? L("offline") : L("checking");
    return `<button class="person ${cls}" type="button" data-open="${escapeHtml(login)}"><i></i>${escapeHtml(login)} <em>${word}</em></button>`;
  }).join("");
  return `
    <article class="drop${live ? " is-current" : ""}${locked ? " is-locked" : ""}${arts.length ? "" : " no-art"}" data-drop="${escapeHtml(drop.id)}">
      ${arts.length ? `<span class="arts">${arts.join("")}</span>` : ""}
      <strong>${escapeHtml(drop.name)}</strong>
      <span class="pct">${ratio}%</span>
      <div class="trackline"><span style="width:${ratio}%"></span></div>
      ${people ? `<div class="people">${people}</div>` : `<div class="any">${L("anyChannel")}</div>`}
    </article>`;
}

function renderBucket(title, items, showCampaignArt) {
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
    return head + group.drops.map((drop) => dropCard(drop, latest, showCampaignArt)).join("");
  }).join("");
  return `<section class="bucket${showCampaignArt ? " exclusive" : " general"}"><p class="bucket-label">${title} · ${items.length}</p><div class="bucket-card">${cards}</div></section>`;
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

$("toggle").addEventListener("click", async () => {
  const state = latest || await send({ type: "getState" });
  render(await send({ type: "setEnabled", enabled: !state?.enabled }));
});

$("now").addEventListener("click", async () => {
  $("now").disabled = true;
  try {
    render(await send({ type: "tick" }));
  } finally {
    $("now").disabled = false;
  }
});

$("inventory").addEventListener("click", () => {
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
  render({ ...latest, lang });
  send({ type: "setLanguage", lang }).then((next) => next && render(next));
});

document.body.addEventListener("click", (event) => {
  const open = event.target.closest("[data-open]");
  if (open) {
    chrome.tabs.create({ url: `https://www.twitch.tv/${open.dataset.open}` });
    return;
  }
  const row = event.target.closest("[data-drop]");
  if (!row?.dataset.drop || !latest) return;
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

$("games").addEventListener("change", (event) => {
  const box = event.target.closest("input[data-game]");
  if (!box || !latest) return;
  const ids = new Set(latest.whitelist || []);
  if (box.checked) ids.add(box.dataset.game);
  else ids.delete(box.dataset.game);
  const names = new Set((latest.games || []).filter((game) => ids.has(game.id)).map((game) => game.name));
  render({
    ...latest,
    whitelist: [...ids],
    games: (latest.games || []).map((game) => ({ ...game, selected: ids.has(game.id) })),
    queue: (latest.queue || []).filter((drop) => names.has(drop.game)),
    watching: latest.watching && names.has(latest.watching.game) ? latest.watching : null,
  });
  send({ type: "setWhitelist", ids: [...ids] }).then((state) => state && render(state));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.state?.newValue) render(changes.state.newValue);
});

send({ type: "getState" }).then(render);
