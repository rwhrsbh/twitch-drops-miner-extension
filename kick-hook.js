// Запоминает X-Client-Token из запросов самого kick.com. Если Kick сменит значение,
// расширение возьмёт новое отсюда вместо вшитого (см. lib/kick.js, refreshClientToken).
(() => {
  if (window.__dropsKickHooked) return;
  window.__dropsKickHooked = true;

  function take(headers) {
    if (!headers) return;
    let value = "";
    if (typeof headers.get === "function") value = headers.get("x-client-token") || "";
    else if (Array.isArray(headers)) value = (headers.find((pair) => String(pair?.[0]).toLowerCase() === "x-client-token") || [])[1] || "";
    else {
      for (const [name, item] of Object.entries(headers)) {
        if (name.toLowerCase() === "x-client-token") value = item;
      }
    }
    if (/^[0-9a-f]{32,128}$/i.test(String(value))) window.__dropsKickClientToken = String(value);
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (input && typeof input === "object") take(input.headers);
      take(init?.headers);
    } catch {
      // Перехват не должен ломать сайт.
    }
    return originalFetch.apply(this, arguments);
  };

  const originalSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (String(name).toLowerCase() === "x-client-token") take({ [name]: value });
    } catch {
      // Перехват не должен ломать сайт.
    }
    return originalSet.apply(this, arguments);
  };
})();
