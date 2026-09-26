const ENTITY = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function decodeText(value) {
  return String(value || "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => ENTITY[entity] || " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseWatchMinutes(text) {
  const source = decodeText(text);
  const hours = /(\d+)\s*hour/i.exec(source);
  const minutes = /(\d+)\s*minute/i.exec(source);
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
}

function sliceBetween(html, startMarker, endMarkers) {
  const start = html.indexOf(startMarker);
  if (start < 0) return "";
  let end = html.length;
  for (const marker of endMarkers) {
    const at = html.indexOf(marker, start + startMarker.length);
    if (at >= 0 && at < end) end = at;
  }
  return html.slice(start, end);
}

function classTokens(value) {
  return String(value || "").split(/\s+/).filter(Boolean);
}

function openingTags(html) {
  const tags = [];
  const re = /<(a|div)\b[^>]*class="([^"]*)"[^>]*>/gi;
  for (const match of html.matchAll(re)) {
    if (!classTokens(match[2]).includes("drop-box")) continue;
    tags.push({ index: match.index, tag: match[0] });
  }
  return tags;
}

function parseStreamers(chunk) {
  const streamers = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bstreamer-info\b[^>]*>[\s\S]*?<\/a>/gi;
  for (const match of chunk.matchAll(re)) {
    const block = match[0];
    const login = /twitch\.tv\/([A-Za-z0-9_]+)/.exec(block)?.[1];
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    streamers.push({
      login,
      online: /online-status/.test(block),
    });
  }
  return streamers;
}

function parseDrop(chunk) {
  const name = decodeText(/class="drop-type">([^<]*)</.exec(chunk)?.[1] || "");
  const timeText = /class="drop-time"[\s\S]*?<span>([^<]*)<\/span>/.exec(chunk)?.[1] || "";
  const minutes = parseWatchMinutes(timeText);
  const itemId = /data-itemid="(\d+)"/.exec(chunk)?.[1] || "";
  const streamers = parseStreamers(chunk);
  if (!name || minutes <= 0) return null;
  const boxLive = classTokens(/class="([^"]*)"/.exec(chunk)?.[1]).includes("is-live");
  return {
    name,
    minutes,
    itemId,
    streamers,
    live: boxLive || streamers.some((streamer) => streamer.online),
  };
}

function parseDrops(sectionHtml) {
  const tags = openingTags(sectionHtml);
  const drops = [];
  for (let i = 0; i < tags.length; i += 1) {
    const chunk = sectionHtml.slice(tags[i].index, tags[i + 1]?.index ?? sectionHtml.length);
    const drop = parseDrop(chunk);
    if (drop) drops.push(drop);
  }
  return drops;
}

function pickWindow(html, now) {
  const windows = [...html.matchAll(
    /setupCountdown\(\s*'\.(campaign-\d+)'\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g
  )].map((match) => {
    const cls = match[1];
    return {
      cls,
      start: Number(match[2]),
      end: Number(match[3]),
      active: new RegExp(`class="[^"]*\\b${cls}\\b[^"]*\\bis-active\\b`).test(html),
    };
  });
  if (!windows.length) return null;
  const current = windows.find((item) => item.start <= now && now < item.end);
  if (current) return current;
  const active = windows.find((item) => item.active);
  if (active) return active;
  return windows[0];
}

export function parseFacepunch(html, now = Date.now()) {
  const source = String(html || "");
  const window = pickWindow(source, now);
  const rounds = [...source.matchAll(/class="event-round">([^<]+)/g)].map((match) =>
    decodeText(match[1])
  );
  const general = parseDrops(sliceBetween(source, 'id="drops"', ["streamer-drops"]));
  const streamer = parseDrops(
    sliceBetween(source, "streamer-drops", ["current-campaign", "Drops Metrics", 'class="faq"'])
  );
  const startsAt = window?.start || 0;
  const endsAt = window?.end || 0;
  const badgeLive = /status-badge is-live/.test(source);
  const inWindow = Boolean(startsAt && endsAt && startsAt <= now && now < endsAt);
  const upcoming = Boolean(startsAt && now < startsAt);
  const ended = Boolean(endsAt && now >= endsAt);
  const hasDrops = general.length + streamer.length > 0;
  return {
    title: decodeText(/class="event-title">([^<]+)/.exec(source)?.[1] || ""),
    round: rounds.find((item) => /round/i.test(item)) || rounds[0] || "",
    host: decodeText(/class="event-subtitle">([^<]+)/.exec(source)?.[1] || ""),
    startsAt,
    endsAt,
    live: hasDrops && !upcoming && !ended && (badgeLive || inWindow || !startsAt),
    upcoming,
    ended,
    general,
    streamer,
  };
}
