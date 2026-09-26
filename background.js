import { readState, setEnabled, setLanguage, setWhitelist, tick, watchDrop } from "./lib/miner.js";

const BUILD = "ui-1";
void BUILD;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
  tick("installed");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
  tick("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick") tick("alarm");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (type === "getState") {
    readState().then(sendResponse);
    return true;
  }
  if (type === "tick") {
    tick("manual").then(sendResponse);
    return true;
  }
  if (type === "setEnabled") {
    setEnabled(Boolean(message.enabled)).then(sendResponse);
    return true;
  }
  if (type === "setWhitelist") {
    setWhitelist(message.ids || []).then(sendResponse);
    return true;
  }
  if (type === "watchDrop") {
    watchDrop(message.id).then(sendResponse);
    return true;
  }
  if (type === "setLanguage") {
    setLanguage(message.lang).then(sendResponse);
    return true;
  }
  return false;
});
