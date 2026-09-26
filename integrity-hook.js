(() => {
  if (window.__dropsMinerHooked) return;
  window.__dropsMinerHooked = true;
  const names = ["client-integrity", "client-session-id", "client-version", "x-device-id", "client-id"];
  const bag = {};

  function remember(name, value) {
    const key = String(name || "").toLowerCase();
    if (!names.includes(key) || !value) return;
    bag[key] = String(value);
    window.__dropsMinerHeaders = { ...bag };
  }

  function take(headers) {
    if (!headers) return;
    if (typeof headers.get === "function") {
      for (const name of names) remember(name, headers.get(name));
      return;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) remember(pair?.[0], pair?.[1]);
      return;
    }
    for (const [name, value] of Object.entries(headers)) remember(name, value);
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (input && typeof input === "object") take(input.headers);
      take(init?.headers);
    } catch {
      // Заголовок страницы не обязателен для самого запроса Twitch.
    }
    const pending = originalFetch.apply(this, arguments);
    const url = typeof input === "string" ? input : input?.url || "";
    if (/gql\.twitch\.tv\/integrity/.test(url)) {
      // Срок жизни токена Twitch отдаёт только в ответе, из самого токена его не прочитать.
      pending.then((response) => response.clone().json()).then((body) => {
        if (!body?.expiration) return;
        bag["integrity-expiration"] = String(body.expiration);
        window.__dropsMinerHeaders = { ...bag };
      }).catch(() => {});
    }
    return pending;
  };

  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    remember(name, value);
    return setRequestHeader.apply(this, arguments);
  };
})();
