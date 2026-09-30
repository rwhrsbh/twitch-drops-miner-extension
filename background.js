import { installKickRules, kickTick, readKick, setKickEnabled, watchKickDrop } from "./lib/kick.js";
import { readSettings, writeSettings } from "./lib/settings.js";
import { pingNow, readState, settingsChanged, setEnabled, setLanguage, setWhitelist, tick, watchDrop } from "./lib/miner.js";

const BUILD = "inv-1";
void BUILD;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
  installKickRules().then(() => kickTick());
  tick("installed");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
  installKickRules().then(() => kickTick());
  tick("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick") {
    pingNow();
    tick("alarm");
    kickTick();
  }
});

// Изменения из попапа читают состояние, правят и пишут обратно. Параллельно они затирали друг друга
// (например, язык и выбор игры), поэтому пишем строго по очереди.
let writes = Promise.resolve();
function serial(work) {
  const run = writes.then(work, work);
  writes = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (type === "getSettings") {
    readSettings().then(sendResponse);
    return true;
  }
  if (type === "setSettings") {
    serial(() => writeSettings(message.patch || {}))
      .then(async (next) => {
        sendResponse(next);
        await Promise.all([settingsChanged(), kickTick()]);
      });
    return true;
  }
  if (type === "watchKickDrop") {
    serial(() => watchKickDrop(message.id)).then(sendResponse);
    return true;
  }
  if (type === "getKick") {
    readKick().then(sendResponse);
    return true;
  }
  if (type === "kickTick") {
    kickTick().then(sendResponse);
    return true;
  }
  if (type === "setKickEnabled") {
    serial(() => setKickEnabled(Boolean(message.enabled))).then(sendResponse);
    return true;
  }
  if (type === "getState") {
    readState().then(sendResponse);
    return true;
  }
  if (type === "tick") {
    tick("manual").then(sendResponse);
    return true;
  }
  if (type === "setEnabled") {
    serial(() => setEnabled(Boolean(message.enabled))).then(sendResponse);
    return true;
  }
  if (type === "setWhitelist") {
    serial(() => setWhitelist(message.ids || [])).then(sendResponse);
    return true;
  }
  if (type === "watchDrop") {
    serial(() => watchDrop(message.id)).then(sendResponse);
    return true;
  }
  if (type === "setLanguage") {
    serial(() => setLanguage(message.lang)).then(sendResponse);
    return true;
  }
  return false;
});
