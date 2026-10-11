import {
  PLATFORMS,
  addPending,
  addingPlatform,
  cancelAdd,
  finishAdd,
  noteAddTab,
  publicAccounts,
  readAccounts,
  recover,
  removeAccount,
  setRotation,
  setSelection,
  setWarned,
  startAdd,
  switchTo,
  syncCurrent,
} from "./lib/accounts.js";
import { readAuth, resetSession, searchChannels } from "./lib/client.js";
import { clearHistory, readHistory } from "./lib/history.js";
import { installKickRules, kickTick, readKick, resetKickAccount, setKickEnabled, twitchPickedNames, watchKickDrop } from "./lib/kick.js";
import {
  pingNow,
  readState,
  resetForAccount,
  settingsChanged,
  setEnabled,
  setLanguage,
  setWhitelist,
  tick,
  watchDrop,
  watchNow,
} from "./lib/miner.js";
import { pointsTick, readPoints, replacePoints, setPointsChannels, setPointsEnabled } from "./lib/points.js";
import { primeSide, readSide, sideTick, sideWatch, watchSideDrop } from "./lib/side.js";
import { kickSideTick, readKickSide, watchKickSideDrop } from "./lib/kickside.js";
import {
  kickPointsTick,
  readKickPoints,
  replaceKickPoints,
  searchKickChannels,
  setKickPointsChannels,
} from "./lib/kickpoints.js";
import { rotate } from "./lib/rotation.js";
import { loadHashes, refreshHashes } from "./lib/remote.js";
import { readSettings, writeSettings } from "./lib/settings.js";

const BUILD = "inv-1";
void BUILD;

// Как выбор аккаунта попадает в состояние майнеров.
const hooks = {
  // Перед подменой кук: integrity-заголовки прежнего аккаунта не должны уйти с токеном нового.
  async before(platform) {
    if (platform === "twitch") await resetSession();
  },
  // Аккаунт стал активным: его игры и каналы баллов становятся текущими, прежняя сессия сбрасывается.
  async apply(platform, account) {
    if (platform === "twitch") {
      await replacePoints(account?.points || []);
      await writeSettings({ wishes: account?.wishes || [] });
      await resetForAccount(account?.whitelist || []);
    } else {
      await writeSettings({ picked: account?.picked || [] });
      await replaceKickPoints(account?.points || []);
      await resetKickAccount();
    }
  },
  // Пользователь поменял выбор у активного аккаунта.
  async select(platform, _account, patch) {
    if (platform === "twitch") {
      if (Array.isArray(patch.wishes)) await writeSettings({ wishes: patch.wishes });
      if (Array.isArray(patch.whitelist)) await setWhitelist(patch.whitelist);
      if (Array.isArray(patch.points)) await setPointsChannels(patch.points);
    } else {
      if (Array.isArray(patch.points)) await setKickPointsChannels(patch.points);
      if (Array.isArray(patch.picked)) {
        await writeSettings({ picked: patch.picked });
        // Проходы майнеров не ждём: они долгие, а эта функция держит очередь записи.
        settingsChanged().catch(() => {});
        kickTick().catch(() => {});
      }
    }
  },
};

// До 1.7.0 игра, выбранная в списке Twitch, считалась выбранной и на Kick. Теперь списки раздельные:
// один раз дописываем эти названия в списки Kick, чтобы после обновления ничего не перестало фармиться.
// Название игры известно, только пока у неё есть кампания или она запомнена. Игры без названия
// запоминаются по id, и следующие проходы смотрят только на них (не дольше трёх дней): иначе перенос
// повторялся бы целиком каждую минуту и возвращал игру, которую пользователь снял в списке Kick.
const SPLIT_WAIT = 3 * 24 * 60 * 60 * 1000;
async function splitPicks() {
  const stored = await chrome.storage.local.get(["picksSplit", "picksPending"]);
  if (stored.picksSplit) return;
  const waiting = stored.picksPending;
  const { names, missing } = await twitchPickedNames(waiting?.ids);
  if (names.length) {
    const merge = (list) => {
      const seen = new Map([...(list || []), ...names].map((name) => [String(name).toLowerCase(), String(name)]));
      return [...seen.values()];
    };
    const data = await readAccounts();
    await writeSettings({ picked: merge((await readSettings()).picked) });
    for (const account of data.kick.list) {
      if (account.id !== data.kick.active) await setSelection("kick", account.id, { picked: merge(account.picked) }, hooks);
    }
  }
  const until = waiting?.until || Date.now() + SPLIT_WAIT;
  if (!missing.length || Date.now() > until) {
    await chrome.storage.local.set({ picksSplit: true });
    await chrome.storage.local.remove("picksPending");
  } else if (missing.length !== waiting?.ids?.length) {
    await chrome.storage.local.set({ picksPending: { ids: missing, until } });
  }
}

async function cycle() {
  await serial(splitPicks).catch(() => {});
  // Сохранённые рабочие хэши запросов Twitch — до первого запроса; раз в сутки сверка с источниками.
  await loadHashes();
  refreshHashes().catch(() => {});
  // Перезапуск мог оборвать подмену кук или оставить сайт разлогиненным после окна входа.
  await serial(() => recover(hooks)).catch(() => {});
  // Пользователь мог сам перелогиниться на сайте: подхватываем аккаунт до прохода.
  if (!(await addPending())) {
    await serial(async () => {
      await syncCurrent("twitch", hooks);
      await syncCurrent("kick", hooks);
    }).catch(() => {});
  } else {
    // Окно входа открыто: вход мог пройти, а событие кук потеряться.
    await serial(() => finishAdd(hooks)).catch(() => {});
  }
  pingNow();
  pointsTick();
  // Какие игры выбраны у остальных аккаунтов: основной майнер добавит их кампании в каталог.
  await primeSide().catch(() => {});
  tick("alarm").then(async (state) => {
    await rotate("twitch", state, hooks);
    await runSide();
  }).catch(() => {});
  kickTick().then((state) => {
    // После прохода майнера: уже известно, какой канал он смотрит ради дропа.
    kickPointsTick();
    // Остальные аккаунты Kick фармят параллельно по своим токенам.
    kickSideTick().catch(() => {});
    return rotate("kick", state, hooks);
  }).catch(() => {});
}

// Остальные аккаунты Twitch фармят параллельно. Кому нужен integrity для клейма (или активного аккаунта
// не стало), тот становится активным: как часто, решает lib/side.js.
async function runSide() {
  const side = await sideTick().catch(() => ({}));
  if (side.switchTo && !(await addPending())) await serial(() => switchTo("twitch", side.switchTo, hooks, true));
}

// Аккаунт убрали, сменили режим или выключили майнер: параллельные аккаунты узнают сразу, а не через минуту.
function nudge() {
  runSide().catch(() => {});
  kickSideTick().catch(() => {});
  kickPointsTick().catch(() => {});
}

chrome.tabs.onCreated.addListener((tab) => {
  noteAddTab(tab).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  alarms();
  installKickRules().then(() => kickTick());
  serial(() => recover(hooks)).catch(() => {}).then(() => tick("installed"));
});

chrome.runtime.onStartup.addListener(() => {
  alarms();
  installKickRules().then(() => kickTick());
  serial(() => recover(hooks)).catch(() => {}).then(() => tick("startup"));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick") cycle();
  // Между минутными проходами: ещё один заход на плейлист канала дропа, чтобы просмотр не прерывался.
  if (alarm.name === "watch") {
    watchNow();
    sideWatch();
  }
});

function alarms() {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
  // Со сдвигом в полминуты относительно основного будильника.
  chrome.alarms.create("watch", { delayInMinutes: 0.5, periodInMinutes: 1 });
}

// Вход в окне добавления аккаунта: появилась кука сессии.
chrome.cookies.onChanged.addListener((change) => {
  if (change.removed) return;
  const platform = Object.keys(PLATFORMS).find((key) => (
    PLATFORMS[key].cookie === change.cookie.name && change.cookie.domain.endsWith(PLATFORMS[key].domain)
  ));
  if (!platform) return;
  addPending().then((waiting) => {
    if (waiting) serial(() => finishAdd(hooks)).catch(() => {});
    else loginSeen(platform);
  });
});

// Пользователь вошёл на сайте сам (кнопка «Войти» или обычная вкладка): подхватываем сразу,
// не дожидаясь минутного будильника. Куки при входе меняются пачкой, поэтому с задержкой.
const loginTimers = {};
function loginSeen(platform) {
  clearTimeout(loginTimers[platform]);
  loginTimers[platform] = setTimeout(async () => {
    await serial(() => syncCurrent(platform, hooks)).catch(() => {});
    if (platform === "twitch") tick("login").catch(() => {});
    else kickTick().catch(() => {});
  }, 2500);
}

chrome.windows.onRemoved.addListener((windowId) => {
  serial(() => cancelAdd(windowId, hooks)).catch(() => {});
});

// Изменения из попапа читают состояние, правят и пишут обратно. Параллельно они затирали друг друга
// (например, язык и выбор игры), поэтому пишем строго по очереди.
let writes = Promise.resolve();
function serial(work) {
  const run = writes.then(work, work);
  writes = run.catch(() => {});
  return run;
}

const accountsView = async () => ({ ...publicAccounts(await readAccounts()), adding: await addingPlatform() });

// Ответ: функция от сообщения. Пишущие идут через очередь.
const readers = {
  getSettings: () => readSettings(),
  getKick: () => readKick(),
  kickTick: () => kickTick(),
  getState: () => readState(),
  tick: () => tick("manual"),
  getPoints: () => readPoints(),
  getSide: () => readSide(),
  getKickSide: () => readKickSide(),
  getKickPoints: () => readKickPoints(),
  searchKickChannels: async (message) => {
    try {
      return { items: await searchKickChannels(message.query) };
    } catch (error) {
      return { error: String(error?.message || error), items: [] };
    }
  },
  getHistory: () => readHistory(),
  // Заодно запоминаем сессии, в которые пользователь вошёл сам.
  getAccounts: async () => {
    if (!(await addPending())) {
      await syncCurrent("twitch", hooks);
      await syncCurrent("kick", hooks);
    }
    return accountsView();
  },
  searchChannels: async (message) => {
    const auth = await readAuth();
    if (!auth) return { error: "need-login", items: [] };
    try {
      return { items: await searchChannels(auth, String(message.query || "").trim()) };
    } catch (error) {
      return { error: String(error?.message || error), items: [] };
    }
  },
};

const writers = {
  watchKickDrop: (message) => watchKickDrop(message.id),
  setKickEnabled: async (message) => {
    const next = await setKickEnabled(Boolean(message.enabled));
    nudge();
    return next;
  },
  setEnabled: async (message) => {
    const next = await setEnabled(Boolean(message.enabled));
    nudge();
    return next;
  },
  setWhitelist: (message) => setWhitelist(message.ids || []),
  watchDrop: (message) => watchDrop(message.id),
  setLanguage: (message) => setLanguage(message.lang),
  setPointsChannels: (message) => setPointsChannels(message.channels || []),
  setKickPointsChannels: (message) => setKickPointsChannels(message.channels || []),
  watchSideDrop: (message) => watchSideDrop(String(message.account), String(message.id)),
  watchKickSideDrop: (message) => watchKickSideDrop(String(message.account), String(message.id)),
  setPointsEnabled: async (message) => {
    const next = await setPointsEnabled(message.enabled);
    nudge();
    return next;
  },
  clearHistory: () => clearHistory(),
  setRotation: async (message) => {
    const next = publicAccounts(await setRotation(message.patch || {}));
    nudge();
    return next;
  },
  setAccountsWarned: async () => publicAccounts(await setWarned()),
  removeAccount: async (message) => {
    const next = publicAccounts(await removeAccount(message.platform, message.id, hooks));
    nudge();
    return next;
  },
  switchAccount: async (message) => {
    const next = publicAccounts(await switchTo(message.platform, message.id, hooks));
    nudge();
    return next;
  },
  setAccountSelection: async (message) => (
    publicAccounts(await setSelection(message.platform, message.id, message.patch || {}, hooks))
  ),
  addAccount: (message) => startAdd(message.platform, hooks),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (type === "setSettings") {
    serial(() => writeSettings(message.patch || {}))
      .then(async (next) => {
        sendResponse(next);
        await Promise.all([settingsChanged(), kickTick()]);
      });
    return true;
  }
  if (readers[type]) {
    Promise.resolve(readers[type](message)).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (writers[type]) {
    serial(() => writers[type](message)).then(sendResponse, () => sendResponse(null));
    return true;
  }
  return false;
});
