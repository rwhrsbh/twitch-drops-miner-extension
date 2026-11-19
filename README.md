# Drops

Browser extension that farms Twitch and Kick drops for the games you pick. It does not play the stream. For Twitch it requests the stream playlist and sends HEAD requests for its segments (the method TwitchDropsMiner switched to on 9 October 2026, when Twitch stopped counting plain minute-watched pings), then reads progress from Twitch and claims a drop when Twitch marks it ready.

The popup can be switched between Russian and English.

## Authorization

Sign in to Twitch in this browser. The extension picks up the `auth-token` cookie from that session. Your password is never stored.

Device-code login is not used. That flow in TwitchDropsMiner was broken at the time this extension was published, so sign-in was rebuilt around the cookie you already have after a normal Twitch login.

## Kick

Sign in to kick.com in the same browser. The `session_token` cookie is picked up automatically; nothing to paste. Kick farms in parallel with Twitch. Each Kick account has its own game list (Priority tab), matched by game name; exclusive-channel drops go first. Protocol (viewer token, WebSocket handshake/ping, `tracking.user.watch.livestream`, claim) follows [kickautodrops](https://github.com/PBA4EVSKY/kickautodrops) and [GrubDrops](https://github.com/JourneyDocker/GrubDrops). A `declarativeNetRequest` rule sets `Origin`/`Referer` to kick.com for those requests.

## Kick cases

Cases are not drops and never appear in the Drops list. They are Kick's own gamification rewards — the Daily Reward and promos like the Sunset Reward Case — served from `GET web.kick.com/api/v1/gamification/challenges` and opened with `POST web.kick.com/api/v1/gamification/challenges/{id}/claim` (the answer is `{data: {challenge_id, reveal_type, roulette, winner}}`, where `winner` carries the card you got: rarity, `card_url`, `thumbnail_url`). The watch time that unlocks a case is counted by Kick from the same viewing the drops use, so a case needs nothing extra: the extension reads the list, shows every case with its minutes in the Kick tab, and opens whatever is ready. The claim for the current day is remembered by challenge id and the end of its window, so a case is never opened twice. A switch in the settings turns the automatic opening off, and then the case minutes are not farmed either — the "Open" button in the case list keeps working for cases Kick considers ready.

Cases keep the miner busy when there is nothing left to farm: if no drop of the account is earnable and its case still needs minutes, the miner watches any live stream on that account, so the case keeps filling instead of idling. That watching counts as an idle turn for the rotation: in the turn-based modes the account can be switched away before the case is full. The same applies to every account farming in parallel, each with its own case progress and its own socket. In the one-game mode this is the last resort, used when that game has no live stream at all.

Automatic opening is on by default and stops with the Kick switch: with Kick mining turned off the case pass stops entirely (the usual account sync still runs). In the "Never" rotation mode (accounts change only by hand) cases are handled for the account signed in to the browser only; in the other modes every saved account is served. Accounts that are not served are hidden from the case list and the list says how many there are. With the case switch off the list is frozen until it is turned on again.

Cases are opened for every Kick account, not just the one signed in to the browser: the signed-in account uses its live cookie, the saved accounts use their own session token and send no browser cookies, so one account's request cannot be answered as another's. The case list in the popup shows an account's cases under its name when there is more than one account.

Checked live on 19 November 2026: the list returns the Daily Reward (`claimed`) and the Sunset Reward Case (`in_progress`, 150 of 180 minutes), the claim answer is `{challenge_id, reveal_type, roulette, winner}`, and a claim on an already claimed reward answers 200 with the same winner instead of granting another one. The minutes came from the background WebSocket viewing the extension itself uses for drops: the case went from 150 to 168 over about 20 minutes while nothing but the miner was watching.

## Reward campaigns and badges

Twitch also runs campaigns that do not look like drops in the app: **reward campaigns** (for example "GTAVI Launch Celebration" with its daily chests) and **badge campaigns** (for example "Jordan x Space Jam", Payday 3, OSRS). Both are farmed by the same minute-watched requests as ordinary drops.

- Reward campaigns are listed from the separate `rewardCampaignsAvailableToUser` field, not from `currentUser.dropCampaigns`. Their drops watch a *category* (the game the campaign is tied to) instead of a channel list, and are read from `dropsCampaign` details. A chest is opened with `SelectDropsRewardOption` only when Twitch returns a set of options; until then the chest is "waiting", not failed. A repeatable chest is remembered per day and counted up to its `repeatableTimes`.
- Badge campaigns arrive with `isAccountConnected: false` and `accountLinkURL = https://www.twitch.tv/` because there is no external account to link. A campaign counts as linked when every reward is a `BADGE` and the link points at Twitch itself; a `DIRECT_ENTITLEMENT` campaign with the same link stays unlinked (Payday 3 and OSRS are badges, World of Warships is not).
- Twitch redeems badges by itself: they have no `dropInstanceID` and no "Claim" button, and the campaign details keep saying `isClaimed: false` forever. The miner therefore marks a finished badge as received itself, writes it to the history and remembers it for 60 days under `badgeDrops`, so an already earned badge is not farmed again. This follows TwitchDropsMiner issues [#817](https://github.com/DevilXD/TwitchDropsMiner/issues/817) and [#916](https://github.com/DevilXD/TwitchDropsMiner/issues/916).

Checked live on 19–20 November 2026: a badge drop collects minutes (Payday 3 "Clover", 5 of 30 after playlist pings and a short real player session) while its campaign details still report 0; the current progress only comes from `DropCurrentSession`. "Jordan x Space Jam" did not collect a single minute on its listed channel `samham` for 18 minutes, so a Twitch self-link alone does not guarantee the campaign is available in the region.

## Self-repair

Twitch changes the hashes of its persisted GraphQL queries now and then; an old hash starts answering `PersistedQueryNotFound`. This used to need a new release. Now:

- `lib/remote.js`: once a day, and immediately on `PersistedQueryNotFound`, the extension reads `remote/config.json` from this repository and `constants.py` from DevilXD/TwitchDropsMiner, checks each candidate with an anonymous request to Twitch (a dead hash is visible without signing in) and applies only live ones. They are kept in `chrome.storage.local` under `remote`. Only 64-hex strings for known operations are accepted, so this is data, not remote code.
- `.github/workflows/hashes.yml` runs `tools/update-hashes.mjs` every 6 hours: it probes the hashes in `remote/config.json`, replaces dead ones from upstream, commits the file, and opens an issue when a hash is dead and no source has a working one. To push a hash by hand, edit `remote/config.json`: it is the first candidate once the built-in hash stops working (a hash Twitch still accepts is never replaced). Hashes found by one version are dropped when the extension updates.
- `.github/workflows/tests.yml` runs `npm test` on pushes to `main` and on pull requests.

## Channel points

Not collected in this version: the Points tab and the settings switch are hidden, nothing is sent. Both parts sit behind `FEATURES` in `lib/constants.js` and the code is kept.

- `kickPoints`: works (Kick credits points for the same background WebSocket "viewing" that drops use; balance and daily rewards included; endpoints follow atalaydenknalbant/twitch-kick-points-miner). Hidden for now to keep the popup simple.
- `twitchPoints`: checked in October 2026, Twitch credits points and offers bonuses only to a real player. Minute-watched pings, playlist requests and forged player events earn nothing, and the extension never opens video for points.

## What changed in the defaults

Kick cases are on by default, and that has two visible consequences. With nothing left to farm the miner now watches any live stream so the case keeps filling, where it used to stop. A saved account with no picked games may watch for its own case instead of sitting on "no games picked". Both stop with the Kick switch or with the case switch.

The one-game mode is global: while it is on, it overrides the picked games and auto mode for every account at once. "Each account has its own games" holds for the normal queue, not for this mode.

## One game non-stop

Settings has a "one game" picker for Twitch and one for Kick. When a game is chosen the miner farms that game and nothing else, in this order:

1. the game's drops, on their channels;
2. a live channel of the game with drops enabled, so the minutes still count somewhere;
3. any live stream of that game.

Twitch reaches step 3 through the game directory, Kick through the game's category, remembered from its last campaign. The picked-games list, auto mode and the blacklist stop mattering while this is on; switch the picker back to "Off" to return to the usual queue. On Kick, minutes watched this way still count for cases and channel points.

The mode covers every account, including the ones farming in parallel. Kick accounts use their own token as usual. A Twitch account farming in parallel cannot browse a game directory without an integrity token, so it takes the channel the main miner settled on (they farm the same game, the setting is global) and keeps it alive itself; the case is the same for the catalog of campaigns — the solo game is added to it on purpose.

## Accounts

Settings → Accounts keeps several Twitch and Kick accounts. "Add account" opens a login window; after sign-in the session cookies are saved and the browser returns to the previous account. Each account has its own picked games.

"Several accounts" has four modes. **All at once** (default): the account the browser is signed in to is farmed as usual, and every other saved account farms at the same time by its own saved token, without touching the browser cookies. Twitch refuses to claim a drop without an integrity token, which only the browser's account can get, so when another account has a drop to claim the extension swaps the site cookies to make it the browser's account (at most once in 10 minutes); the browser is then signed in as that account and open Twitch tabs reload. **After campaigns** / **When all is farmed**: accounts take turns by swapping cookies. **Never**: only by hand.

Removing the account the browser is signed in to also signs the site out (otherwise it would be re-added on the next check).

## Claim history

The History tab lists claimed drops with the account they went to.

## Farming

The farming mechanism follows [TwitchDropsMiner](https://github.com/DevilXD/TwitchDropsMiner) by DevilXD: the same persisted GQL operations and minute-watched channel pings. Thank you.

Exclusive drops are watched only on their listed streamers. Regular drops can run on any live channel with drops enabled. If the current streamer goes offline, the miner switches to someone who is live.

## Support

Support for this extension is not guaranteed.

Contributions are welcome. Open a pull request.

## Load unpacked

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on Developer mode.
3. Choose "Load unpacked" and select this folder.

Chrome 153 and newer may ignore `--load-extension`. Edge still loads an unpacked extension with `--load-extension`.

## Chrome Web Store text

Short name and description for the store listing live in `_locales/en` and `_locales/ru`, so Chrome shows the English or Russian version from the browser language. Longer text you can paste into the store dashboard is in `store/listing-en.txt` and `store/listing-ru.txt`.
