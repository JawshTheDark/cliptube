# Android App

ClipTube for Android browses, plays and uploads clips on any ClipTube server, with a native player and a sign-in
kept for each server you use. It talks to the same API as the website, so nothing needs setting up on the server
beyond running ClipTube 1.5 or newer.

- [Install](#install)
- [Servers and signing in](#servers-and-signing-in)
- [What you can do](#what-you-can-do)
- [Playlists and Watch later](#playlists-and-watch-later)
- [Watch parties](#watch-parties)
- [Live streams](#live-streams)
- [Uploading from your phone](#uploading-from-your-phone)
- [Links that open in the app](#links-that-open-in-the-app)
- [Troubleshooting](#troubleshooting)
- [Building and releasing](#building-and-releasing)

## Install

1. On the phone, open the [releases page](https://github.com/JawshTheDark/cliptube/releases) and pick the newest
   **ClipTube for Android** release (tags named `android-v…`).
2. Download the `.apk` file and open it. Android asks once to allow installs from your browser or file manager.
3. Open **ClipTube** and pick your main server: type its address, or choose one of the servers in the ClipTube
   network. The app opens on your main server from then on.

Newer releases install over older ones and keep your servers and sign-ins. The app needs Android 7 or newer.

## Servers and signing in

Every ClipTube server is its own site with its own accounts. Tap the server name at the top of Home (or
**You → Servers**) to switch servers, pick one of the other servers in the network, or type any address.

**Your main server** is the one the app opens on. You pick it the first time you open the app, and change it under
**You → App settings** or with **Make main** on the Servers screen. Switching to another server lasts until the
app is closed; the next time it opens, it's back on your main server. Removing your main server makes another of
your servers the main one, and removing every server takes you back to picking one.

- **Sign in** from **You** or from any action that needs an account. The app keeps one sign-in per server and
  switches with the server. Signing out ends that session on the server too.
- **Create an account** works the same as on the website: open sign-up, invite codes, approval, and the site's
  rules when it has any.
- **Forgot your password?** Reset it on the website; the sign-in screen links there.
- A server on plain `http://` outside your home network gets a warning on the sign-in screen, since the password
  would travel unencrypted.

The app signs in with a session token (ClipTube 1.5 added these) instead of a cookie. The token is stored in the
phone's keystore and is only ever sent to the server it belongs to, so a clip from another server never sees it.
Servers older than 1.5 can be browsed and watched, but signing in says the server needs updating.

## What you can do

| Screen | What's there |
| --- | --- |
| Home | All, This site, For you, Subscriptions, Trending, Vertical, Top rated and popular tags, as on the website |
| Watch | The native player with fullscreen, picture-in-picture and resume; likes, subscribe, share, related clips |
| Comments | Read and write comments and replies; uploaders and moderators approve held comments and delete any |
| Explore | Search with sorting, and the game catalog with its artwork; game pages and channel pages |
| Upload | Pick a video and fill in the title, description, game, tags, visibility and clipping |
| Inbox | Your notifications, with an unread count on the tab, checked every minute while the app is open |
| You | Your clips (edit details, publish drafts, delete), history, liked clips, subscriptions, servers, sign out |
| Linked accounts | Under You: link your accounts on other servers or Mastodon, link back, check again, unlink |
| Playlists | Save clips to Watch later or your playlists, play a list through, edit and reorder your own |
| Watch parties | Watch along with friends in sync, with chat, reactions and a shared queue |
| Live streams | Who's live on Home, live pages with the stream, live chat and reactions |

Channel pages show the channel's [linked accounts](Fediverse.md#linked-accounts) under **Also on**, with
**Subscribe to all** and an **All accounts** filter for its videos from the other servers. An Also on account on
a server in your network opens in the app; anything else opens in the browser. Comments the uploader writes from
a linked account carry the uploader's mark. Linked accounts need ClipTube 1.6 or newer on the server.

Clips from other servers in the network stream straight from the server that hosts them, like on the website.
Likes, comments and subscriptions on them go through your server.

Still website-only: the timeline editor, thumbnails, captions, clipping and exports, analytics, account settings,
moderation and admin pages, and push notifications. **You → Account settings on the website** opens them.

## Playlists and Watch later

Needs ClipTube 1.7 or newer on the server. See [Playlists](Watching-and-Discovery.md#playlists) for how they
work on the website.

- **Save** on any clip, including clips from other servers in the network, ticks it into Watch later or any of
  your playlists, or into a new one.
- **You → Watch later** and **You → Playlists** list your own; channel pages have a **Playlists** tab with the
  channel's public ones.
- A playlist's page has **Play all**, **Shuffle** and **Watch together**. While a list plays, a bar under the
  clip shows where you are and what's next, with shuffle, loop, autoplay and a skip button. Autoplay moves on when
  a clip ends.
- On your own playlists you can rename them, change who can see them, reorder clips with the arrows, remove clips
  and delete the list. Watch later can be emptied but not deleted.

## Watch parties

Needs ClipTube 1.8 or newer on the server. **Watch together** on a clip or a playlist starts a party and opens it;
**Share** sends its link. Everyone in the party sees the same clip at the same moment: the app keeps its player in
step with the server's clock, seeking when far off and nudging the speed when slightly off.

- **The host steers** with the play, pause, skip-10-seconds and next buttons, and the progress bar. The host can
  let everyone steer, and while the host is away anyone can. Everyone else can **Step out** to pause just for
  themselves, then get **Back in sync**.
- **Chat** and **reactions** under the player; the host's name shows in yellow. A long press removes your own
  message, or any message if you host.
- **Queue**: what plays next. The people steering can pick a clip, reorder, remove, paste a clip link, or add one
  of their playlists.
- **People**: who's watching. The host can let everyone steer, lock the party, remove someone, or end it.
- People without an account on that server join under a name of their choosing. **You → Watch parties** lists the
  parties you host.

## Live streams

Needs ClipTube 1.9 or newer, with live streaming turned on by the server's admin (see
[Live Streaming](Live-Streaming.md)). Watching needs no account.

- **Home** shows who's live, on your server and on the rest of the network, above the clips. A channel that is
  live has a **LIVE** banner on its page.
- The **live page** plays the stream (fullscreen and picture-in-picture work), with the viewer count, the stream's
  title and game, and the live chat with reactions. A stream on another server plays from that server.
- **Chat** as yourself when signed in on that server, or pick a name. A long press removes your own message; the
  streamer and moderators can remove any message and ban someone from the chat.
- When the channel isn't live, the page says so and links to the last stream's recording when there is one.
- Going live happens from OBS or a streaming app on the computer, not from the ClipTube app.

## Uploading from your phone

**Upload → Choose a video** opens Android's file picker, where Recent, Videos and Downloads list your clips. The
file is read straight from where it is, so even large recordings aren't copied first. Clips publish when the
upload finishes, with the visibility you picked; the screen then follows processing until the clip is ready.

Keep the app open until the upload finishes; the screen stays on meanwhile. The size limit is set by the
server's admin, and the upload screen shows it.

## Links that open in the app

Links to clips (`/watch/…`, `/n/…`), channels (`/c/…`), playlists (`/playlist/…`), watch parties
(`/party/…`) and live streams (`/live/…`) on clips.irc.so, clips.quitlyingto.us and clips.6697.pro offer to open
in the app. A link from a server other than the one you're using opens from that server, signed out, with a
**Switch** button to move over and sign in there.

## Troubleshooting

**"Too many failed sign-ins. Try again in a few minutes."**
ClipTube 1.6.1 slows down password guessing: after several wrong passwords for an account, or from one address,
signing in waits for up to 15 minutes. Wait, then sign in with the right password.

**"This server runs an older ClipTube that the app can't sign in to"**
The server is older than 1.5. Update it ([Upgrading and Backups](Upgrading-and-Backups.md)); browsing works
meanwhile.

**"App not installed" when installing a new version**
The APK was signed with a different key from the one on the phone, for example a build you made yourself.
Uninstall the old app first; you'll need to sign in again.

**Can't reach a server on my home network**
Use the server's LAN address with `http://` and its port, for example `http://192.168.1.97:3000`. A public
address that loops back to your own network may not work from inside it (see
[Troubleshooting: Reaching the site](Troubleshooting.md#reaching-the-site)).

**An upload stops partway**
The app was closed or the connection dropped. Choose the file and upload it again.

## Building and releasing

The app's code is in `mobile/` (React Native with Expo SDK 58 and Expo Router). Building the APK, the signing
key, the release workflow and developing against a local server are in
[mobile/README.md](https://github.com/JawshTheDark/cliptube/blob/main/mobile/README.md).
