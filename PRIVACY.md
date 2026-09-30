# Privacy policy

Drops is a browser extension that farms Twitch and Kick drops for games you choose.

## What stays on your device

The extension stores your selected games, blacklist, settings, interface language, the current farming state, and cached drop images in the browser’s local storage. This data is not sent to the developer.

## Twitch session

If you are signed in to Twitch in this browser, the extension reads the `auth-token` cookie. That cookie is used only to call Twitch (for example `id.twitch.tv` and `gql.twitch.tv`) so the extension can see your drops, send minute-watched pings, and claim a drop Twitch marks as ready. Your password is never collected or stored.

The extension also shows the Twitch login name returned by Twitch for that session.

## Kick session

If you are signed in to Kick in this browser, the extension reads the `session_token` cookie. That cookie is used only to call Kick (`kick.com`, `web.kick.com`, `websockets.kick.com`) so the extension can see your drop progress, keep a viewer connection to the channel it farms, and claim finished rewards. While a kick.com page is open, the extension also reads Kick's public web client token from that page's own requests, so it keeps working if Kick changes it. Your password is never collected or stored.

The extension shows the Kick username returned by Kick for that session.

If the viewer connection fails, the extension may open a pinned, muted kick.com tab with the channel player until progress counts again, then closes it.

## What is not collected

The developer does not run a server for this extension. The extension does not sell user data, does not use it for advertising or credit decisions, and does not collect health, financial, location, browsing-history, or keystroke data.

## Contact

Questions: https://github.com/rwhrsbh/twitch-drops-miner-extension/issues
