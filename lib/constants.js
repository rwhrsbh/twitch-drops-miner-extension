// Хэши persisted-query с master DevilXD/TwitchDropsMiner (сентябрь 2026).
// Смотреть: constants.py → GQL_QUERIES. Spade, не sendSpadeEvents:
// с июля 2026 мутация sendSpadeEvents молча ничего не делает.

export const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
export const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
export const CAMPAIGNS_URL = "https://www.twitch.tv/drops/campaigns";
export const CONNECT_URL = CAMPAIGNS_URL;
export const GQL_URL = "https://gql.twitch.tv/gql";
export const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";

const HASH = {
  GetStreamInfo: "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d",
  ClaimDrop: "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930",
  Inventory: "8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404",
  CurrentDrop: "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b",
  Campaigns: "c16bb890cc8ce7647a96ee69cd313d423a378a3dedadf630a1017cde18975feb",
  CampaignDetails: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
  AvailableDrops: "782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20",
  GameDirectory: "86bcceb4e8b1a51256ff8eed8bd8aae4acacf80d737efe904f84f3aeadf8cafd",
  // Сняты с twitch.tv в октябре 2026. ClaimCommunityPoints: тот же, что в открытых майнерах баллов.
  ChannelPoints: "33884dcfeab64eb44c2d61255145643cf69ea993e0c6c2ecb0fa46238586a111",
  ClaimPoints: "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0",
  // TwitchDropsMiner, constants.py (октябрь 2026).
  PlaybackToken: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9",
  Search: "075d5e21955b5be5580afaf7d4bf5a7b6392379d38a40995a86f0d5794ad3e01",
};

// Имя операции Twitch -> ключ в HASH. Хэши могут смениться на ходу: lib/remote.js подставляет
// рабочие, когда Twitch перестаёт узнавать старые.
const OPERATION = {
  VideoPlayerStreamInfoOverlayChannel: "GetStreamInfo",
  DropsPage_ClaimDropRewards: "ClaimDrop",
  Inventory: "Inventory",
  DropCurrentSessionContext: "CurrentDrop",
  ViewerDropsDashboard: "Campaigns",
  DropCampaignDetails: "CampaignDetails",
  DropsHighlightService_AvailableDrops: "AvailableDrops",
  DirectoryPage_Game: "GameDirectory",
  ChannelPointsContext: "ChannelPoints",
  ClaimCommunityPoints: "ClaimPoints",
  PlaybackAccessToken: "PlaybackToken",
  SearchResultsPage_SearchResults: "Search",
};

// Операции выключенных возможностей: чинить и проверять их хэши незачем.
const NEEDS = {
  ChannelPointsContext: "twitchPoints",
  ClaimCommunityPoints: "twitchPoints",
  SearchResultsPage_SearchResults: "twitchPoints",
};

// used — только операции, которыми расширение сейчас пользуется.
export function gqlHashes(used = false) {
  return Object.fromEntries(Object.entries(OPERATION)
    .filter(([operation]) => !used || !NEEDS[operation] || FEATURES[NEEDS[operation]])
    .map(([operation, key]) => [operation, HASH[key]]));
}

export function setGqlHashes(hashes) {
  for (const [operation, hash] of Object.entries(hashes || {})) {
    if (OPERATION[operation] && /^[0-9a-f]{64}$/.test(String(hash))) HASH[OPERATION[operation]] = String(hash);
  }
}

function persisted(operationName, sha256Hash, variables) {
  return {
    operationName,
    variables,
    extensions: {
      persistedQuery: { version: 1, sha256Hash },
    },
  };
}

export function qGetStreamInfo(login) {
  return persisted("VideoPlayerStreamInfoOverlayChannel", HASH.GetStreamInfo, {
    channel: login,
  });
}

export function qClaimDrop(dropInstanceID) {
  return persisted("DropsPage_ClaimDropRewards", HASH.ClaimDrop, {
    input: { dropInstanceID },
  });
}

export function qInventory() {
  return persisted("Inventory", HASH.Inventory, { fetchRewardCampaigns: false });
}

export function qCurrentDrop(channelID) {
  return persisted("DropCurrentSessionContext", HASH.CurrentDrop, {
    channelID: String(channelID),
    channelLogin: "",
  });
}

export function qCampaigns() {
  return persisted("ViewerDropsDashboard", HASH.Campaigns, {
    fetchRewardCampaigns: false,
  });
}

export function qCampaignDetails(channelLogin, dropID) {
  return persisted("DropCampaignDetails", HASH.CampaignDetails, {
    channelLogin,
    dropID,
  });
}

export function qAvailableDrops(channelID) {
  return persisted("DropsHighlightService_AvailableDrops", HASH.AvailableDrops, {
    channelID: String(channelID),
  });
}

export function qGameDirectory(slug) {
  return persisted("DirectoryPage_Game", HASH.GameDirectory, {
    limit: 30,
    slug,
    imageWidth: 50,
    includeCostreaming: false,
    options: {
      broadcasterLanguages: [],
      freeformTags: null,
      includeRestricted: ["SUB_ONLY_LIVE"],
      recommendationsContext: { platform: "web" },
      sort: "VIEWER_COUNT",
      systemFilters: [],
      tags: [],
      requestID: "JIRA-VXP-2397",
    },
    sortTypeIsRecency: false,
  });
}

export function qChannelPoints(login) {
  return persisted("ChannelPointsContext", HASH.ChannelPoints, {
    channelLogin: login,
    includeGoalTypes: ["CREATOR", "BOOST"],
  });
}

export function qClaimPoints(channelID, claimID) {
  return persisted("ClaimCommunityPoints", HASH.ClaimPoints, {
    input: { channelID: String(channelID), claimID },
  });
}

export function qSearchChannels(query) {
  return persisted("SearchResultsPage_SearchResults", HASH.Search, {
    platform: "web",
    query,
    options: { targets: [{ index: "CHANNEL" }], shouldSkipDiscoveryControl: false },
    requestID: crypto.randomUUID(),
  });
}

export function qPlaybackToken(login) {
  return persisted("PlaybackAccessToken", HASH.PlaybackToken, {
    isLive: true,
    isVod: false,
    login,
    platform: "web",
    playerType: "site",
    vodID: "",
  });
}

// Баллы каналов Twitch отключены. Проверено в октябре 2026: без настоящего плеера Twitch баллы не
// начисляет и бонусы не предлагает (пинги minute-watched, запросы плейлиста и поддельные события плеера
// дают ноль), а забирать у аккаунтов, под которыми браузер не залогинен, нельзя без integrity.
// Код оставлен (lib/points.js, вкладка в попапе): если появится рабочий способ, достаточно вернуть true.
// Баллы Kick работают (тот же фоновый сокет, что и дропы), но пока спрятаны вместе с Twitch, чтобы не
// путать: вкладки «Баллы» и переключателя в настройках нет, сбор не идёт. Вернуть: kickPoints: true.
export const FEATURES = { twitchPoints: false, kickPoints: false };
