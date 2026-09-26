# Drops

Browser extension that farms Twitch drops for the games you pick. It does not play the stream. It sends the same minute-watched pings the Twitch web player sends, then reads progress from Twitch and claims a drop when Twitch marks it ready.

The popup can be switched between Russian and English.

## Authorization

Sign in to Twitch in this browser. The extension picks up the `auth-token` cookie from that session. Your password is never stored.

Device-code login is not used. That flow in TwitchDropsMiner was broken at the time this extension was published, so sign-in was rebuilt around the cookie you already have after a normal Twitch login.

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
