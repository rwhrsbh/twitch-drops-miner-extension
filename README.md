# Drops

Browser extension that farms Twitch and Kick drops for the games you pick. It does not play the stream. For Twitch it requests the stream playlist and sends HEAD requests for its segments (the method TwitchDropsMiner switched to on 9 October 2026, when Twitch stopped counting plain minute-watched pings), then reads progress from Twitch and claims a drop when Twitch marks it ready.

The popup can be switched between Russian and English.

## Authorization

Sign in to Twitch in this browser. The extension picks up the `auth-token` cookie from that session. Your password is never stored.

Device-code login is not used. That flow in TwitchDropsMiner was broken at the time this extension was published, so sign-in was rebuilt around the cookie you already have after a normal Twitch login.

## Kick

Sign in to kick.com in the same browser. The `session_token` cookie is picked up automatically; nothing to paste. Kick farms in parallel with Twitch. Each Kick account has its own game list (Priority tab), matched by game name; exclusive-channel drops go first. Protocol (viewer token, WebSocket handshake/ping, `tracking.user.watch.livestream`, claim) follows [kickautodrops](https://github.com/PBA4EVSKY/kickautodrops) and [GrubDrops](https://github.com/JourneyDocker/GrubDrops). A `declarativeNetRequest` rule sets `Origin`/`Referer` to kick.com for those requests.

## Self-repair

Twitch changes the hashes of its persisted GraphQL queries now and then; an old hash starts answering `PersistedQueryNotFound`. This used to need a new release. Now:

- `lib/remote.js`: once a day, and immediately on `PersistedQueryNotFound`, the extension reads `remote/config.json` from this repository and `constants.py` from DevilXD/TwitchDropsMiner, checks each candidate with an anonymous request to Twitch (a dead hash is visible without signing in) and applies only live ones. They are kept in `chrome.storage.local` under `remote`. Only 64-hex strings for known operations are accepted, so this is data, not remote code.
- `.github/workflows/hashes.yml` runs `tools/update-hashes.mjs` every 6 hours: it probes the hashes in `remote/config.json`, replaces dead ones from upstream, commits the file, and opens an issue when a hash is dead and no source has a working one. To push a hash by hand, edit `remote/config.json`: it is the first candidate once the built-in hash stops working (a hash Twitch still accepts is never replaced). Hashes found by one version are dropped when the extension updates.
- `.github/workflows/tests.yml` runs `npm test` on pushes to `main` and on pull requests.

## Channel points

Not collected in this version: the Points tab and the settings switch are hidden, nothing is sent. Both parts sit behind `FEATURES` in `lib/constants.js` and the code is kept.

- `kickPoints`: works (Kick credits points for the same background WebSocket "viewing" that drops use; balance and daily rewards included; endpoints follow atalaydenknalbant/twitch-kick-points-miner). Hidden for now to keep the popup simple.
- `twitchPoints`: checked in October 2026, Twitch credits points and offers bonuses only to a real player. Minute-watched pings, playlist requests and forged player events earn nothing, and the extension never opens video for points.

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
