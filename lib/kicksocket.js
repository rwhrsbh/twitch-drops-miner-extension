// «Просмотр» канала Kick по WebSocket без видео: channel_handshake, ping и раз в минуту
// tracking.user.watch.livestream. Так набираются и минуты дропов, и баллы канала.
// Набор сокетов по ключам: у баллов и у параллельных аккаунтов их несколько сразу.
export function createWatchers(onWatch) {
  const sockets = new Map();

  function close(key) {
    const item = sockets.get(key);
    if (!item) return;
    clearTimeout(item.timer);
    item.ws.onclose = null;
    try {
      item.ws.close();
    } catch {
      // Сокет уже закрыт.
    }
    sockets.delete(key);
  }

  // card: { channelId, livestreamId, login } — числовые id из карточки канала.
  function open(key, viewer, card) {
    close(key);
    const ws = new WebSocket(`wss://websockets.kick.com/viewer/v1/connect?token=${encodeURIComponent(viewer)}`);
    const mine = { ws, timer: 0, beat: 0, sentAt: 0, dead: false, opened: false, livestreamId: card.livestreamId, login: card.login || "" };
    sockets.set(key, mine);
    const send = (value) => ws.send(JSON.stringify(value));
    const handshake = () => send({ type: "channel_handshake", data: { message: { channelId: card.channelId } } });
    const watch = () => {
      mine.sentAt = Date.now();
      send({ type: "user_event", data: { message: { name: "tracking.user.watch.livestream", channel_id: card.channelId, livestream_id: card.livestreamId } } });
      onWatch?.(key, mine);
    };
    const loop = () => {
      if (sockets.get(key) !== mine || ws.readyState !== WebSocket.OPEN) return;
      mine.beat += 1;
      if (mine.beat % 2) handshake();
      else send({ type: "ping" });
      if (Date.now() - mine.sentAt >= 60000) watch();
      mine.timer = setTimeout(loop, 13000 + Math.floor(Math.random() * 6000));
    };
    ws.onopen = () => {
      mine.opened = true;
      handshake();
      watch();
      mine.timer = setTimeout(loop, 13000);
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string" && /^\s*(ping|\{"type":"ping")/.test(event.data)) send({ type: "pong" });
    };
    ws.onclose = () => {
      mine.dead = true;
      clearTimeout(mine.timer);
    };
    ws.onerror = () => {
      mine.dead = true;
    };
    return mine;
  }

  return {
    open,
    close,
    get: (key) => sockets.get(key) || null,
    has: (key) => sockets.has(key),
    keys: () => [...sockets.keys()],
    // Сокет жив и смотрит именно этот эфир (у нового эфира того же канала другой id).
    alive(key, livestreamId) {
      const item = sockets.get(key);
      return Boolean(item && !item.dead && item.ws.readyState <= WebSocket.OPEN && (livestreamId == null || item.livestreamId === livestreamId));
    },
    stopAll(prefix = "") {
      for (const key of [...sockets.keys()]) if (key.startsWith(prefix)) close(key);
    },
  };
}
