# Android App

ClipTube for Android browses, plays and uploads clips on any ClipTube server, with a native player and a sign-in
kept for each server you use. It talks to the same API as the website, so nothing needs setting up on the server
beyond running ClipTube 1.5 or newer.

- [Install](#install)
- [Servers and signing in](#servers-and-signing-in)
- [What you can do](#what-you-can-do)
- [Uploading from your phone](#uploading-from-your-phone)
- [Links that open in the app](#links-that-open-in-the-app)
- [Troubleshooting](#troubleshooting)
- [Building and releasing](#building-and-releasing)

## Install

1. On the phone, open the [releases page](https://github.com/JawshTheDark/cliptube/releases) and pick the newest
   **ClipTube for Android** release (tags named `android-v…`).
2. Download the `.apk` file and open it. Android asks once to allow installs from your browser or file manager.
3. Open **ClipTube**. It starts on [clips.irc.so](https://clips.irc.so), the network's hub.

The repository is private, so the phone's browser has to be signed in to a GitHub account that can see it.
Newer releases install over older ones and keep your servers and sign-ins. The app needs Android 7 or newer.

## Servers and signing in

Every ClipTube server is its own site with its own accounts. Tap the server name at the top of Home (or
**You → Servers**) to switch servers, pick one of the other servers in the network, or type any address.

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

Clips from other servers in the network stream straight from the server that hosts them, like on the website.
Likes, comments and subscriptions on them go through your server.

Still website-only: the timeline editor, thumbnails, captions, clipping and exports, analytics, account settings,
moderation and admin pages, and push notifications. **You → Account settings on the website** opens them.

## Uploading from your phone

**Upload → Choose a video** opens Android's file picker, where Recent, Videos and Downloads list your clips. The
file is read straight from where it is, so even large recordings aren't copied first. Clips publish when the
upload finishes, with the visibility you picked; the screen then follows processing until the clip is ready.

Keep the app open until the upload finishes; the screen stays on meanwhile. The size limit is set by the
server's admin, and the upload screen shows it.

## Links that open in the app

Links to `/watch/…`, `/c/…` and `/n/…` on clips.irc.so, clips.quitlyingto.us and clips.6697.pro offer to open
in the app. A link from a server other than the one you're using opens from that server, signed out, with a
**Switch** button to move over and sign in there.

## Troubleshooting

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
