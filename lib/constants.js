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
};

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
