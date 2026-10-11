# Privacy policy

Drops is a browser extension that farms Twitch and Kick drops for games you choose.

## What stays on your device

The extension stores your selected games, blacklist, settings, interface language, the current farming state, claim history, saved account sessions, and cached drop images in the browser’s local storage. This data is not sent to the developer.

## Twitch session

If you are signed in to Twitch in this browser, the extension reads the `auth-token` cookie. That cookie is used only to call Twitch (for example `id.twitch.tv` and `gql.twitch.tv`) so the extension can see your drops, request the stream playlist of the channel being farmed, send minute-watched pings, and claim a drop Twitch marks as ready. Your password is never collected or stored.

The extension also shows the Twitch login name returned by Twitch for that session.

## Kick session

If you are signed in to Kick in this browser, the extension reads the `session_token` cookie. That cookie is used only to call Kick (`kick.com`, `web.kick.com`, `websockets.kick.com`) so the extension can see your drop progress, keep a viewer connection to the channel it farms, and claim finished rewards. While a kick.com page is open, the extension also reads Kick's public web client token from that page's own requests, so it keeps working if Kick changes it. Your password is never collected or stored.

The extension shows the Kick username returned by Kick for that session.

If the viewer connection fails, the extension may open a pinned, muted kick.com tab with the channel player until progress counts again, then closes it.

## Several accounts

The extension saves the twitch.tv and kick.com session cookies of the account you are signed in to, and of every account you add, in the browser's local storage (chrome.storage.local), so that it can return to that account later. They are sent only to their own site, twitch.tv or kick.com, never to the developer or third parties. In the "all at once" mode each saved account talks to its site with its own token at the same time. When the extension switches accounts it swaps the site cookies: the browser itself is then signed in as that account, and open Twitch and Kick tabs reload. Removing an account in the settings deletes its saved cookies.

When you add an account, the extension asks for optional access to accounts.google.com. It is used for one thing: while the sign-in window is open, Google is asked to show its account chooser in that window, so that you can sign in to a second Twitch or Kick account. You can decline; everything else works without it.

## Self-repair of Twitch request ids

Twitch identifies each of its API requests by a hash and changes these hashes from time to time. Once a day, and right away when Twitch rejects one, the extension downloads two public text files from raw.githubusercontent.com (a list of current hashes from this extension's repository and from the TwitchDropsMiner repository) and checks a candidate with an anonymous request to Twitch. Only 64-character hashes for requests the extension already knows are accepted; no code is downloaded and nothing about you is sent.

## Claim history

The list of claimed drops is kept in the browser's local storage and can be cleared in the popup.

## What is not collected

The developer does not run a server for this extension. The extension does not sell user data, does not use it for advertising or credit decisions, and does not collect health, financial, location, browsing-history, or keystroke data.

## Contact

Questions: https://github.com/rwhrsbh/twitch-drops-miner-extension/issues
