# Watching and Discovery

- [The player](#the-player)
- [Adaptive streaming](#adaptive-streaming)
- [Downloads and the 720p copy](#downloads-and-the-720p-copy)
- [Community titles and thumbnails](#community-titles-and-thumbnails)
- [Captions and skippable parts](#captions-and-skippable-parts)
- [Support links](#support-links)
- [Home](#home)
- [Search](#search)
- [Playlists](#playlists)
- [Feeds](#feeds)
- [Subscriptions and notifications](#subscriptions-and-notifications)
- [Analytics](#analytics)
- [Privacy](#privacy)

## The player

| Key | Action |
| --- | --- |
| `k` | Play or pause |
| `j` / `l` | Back or forward 10 seconds |
| `←` / `→` | Back or forward 5 seconds |
| `f` | Fullscreen |
| `t` | Theater mode |
| `m` | Mute |
| `0` to `9` | Jump to 0% to 90% of the video |

Signed in, videos resume where you left off (unless you paused your history). Under the player you can like
or dislike, subscribe, **Share** (with a *start at* time, or a looping range), **Compare** with another clip,
and download the original when the uploader allows it.

Shared links show a preview with an inline player in Discord, Slack and anything else that reads Open Graph
tags, so set the Public URL in Admin for them to point at the right address. That includes clips from other
servers in the network: their card says who posted them and where, and the thumbnail and video come from the
server that hosts them.

## Adaptive streaming

Admin → Overview → *Adaptive streaming (HLS)*: off, 720p plus source, or 1080p, 720p and 480p plus source.
The source rung is the published file cut into segments without re-encoding, so full quality is always
offered. The player switches quality with the connection, and the quality button picks one by hand
(remembered per browser). The MP4 stays for downloads, link previews and older browsers. Videos are rebuilt
in the background when the setting changes.

## Downloads and the 720p copy

- **Download original.** Uploaders can always download the file they uploaded (or the full-quality file when
  the upload was remuxed). Ticking *Let viewers download the original* on a video offers it to everyone.
- **720p copy for other platforms.** Large videos also get a small MP4, for services like Mastodon that only
  cache small remote videos (on by default, Admin → Overview).

## Community titles and thumbnails

Viewers can suggest a plainer title or pick a better frame, and vote on suggestions. People who turn on
*Community titles and thumbnails* in Settings see the most-voted version everywhere; the uploader can adopt a
suggestion as the real title or thumbnail.

Dislikes are shown by default; admins can hide the counts (uploaders still see their own).

## Captions and skippable parts

Captions appear in the player's caption menu once the uploader publishes them, and viewers can submit their
own from the watch page's ⋯ menu.

Uploaders (and viewers, as suggestions) mark sponsor reads, intros, outros, recaps and self-promotion. In
Settings → *Watching* you choose per kind: skip automatically, show a Skip button, or don't skip.

## Support links

Settings → *Support links* holds up to five tip, membership or merch links. They show on your channel and under
each of your videos, and as profile fields on Mastodon.

## Home

At the top, **Everything**, **Videos** and **Shorts** pick what kind of video to show. Shorts are videos taller
than they are wide. *Everything* shows the landscape videos with the newest Shorts on a shelf of their own after
the first rows; *Shorts* fills the page with them (so does **Shorts** in the sidebar). Live streams on now sit
above it all.

Next to it, the chips:

| Chip | What it shows |
| --- | --- |
| **All** | Newest first, including videos from the rest of the network |
| **This site** | Only videos hosted here (when the server is in a network) |
| **For you** | When signed in: picks from channels you follow and games and tags you like, and says why on every card. Each card has *Not interested*, *More/Less of this game* and *More/Less from this channel*, and there is *Hide watched*. It mixes every kind of video. |
| **Top rated** | The most liked |
| Tag chips | Videos with that tag |

*Videos* or *Shorts* stays picked while you switch chips. To keep Shorts off the home page (no shelf, and none
in *Top rated* or other lists), turn on *Keep Shorts off the home page* in Settings → *Watching*. **Trending** in
the sidebar ranks what's being watched now, and **Games** lists every game with its videos (see
[Clip Tools and Games](Clip-Tools-and-Games.md#games)).

## Search

Search ranks by relevance across titles, tags, games, channels and descriptions. Put words in quotes for an
exact phrase. Filters narrow by length, upload date, shape (vertical or not), game, and where a clip is hosted
(this server, the network or the fediverse).

## Playlists

**Save** under any video (from this server or from the rest of the network) adds it to **Watch later** or to
any of your playlists, or starts a new one. Your playlists are under **Playlists** in the sidebar.

- **Who sees a playlist:** *public* ones show on your channel's *Playlists* tab, *unlisted* ones open for
  anyone with the link, *private* ones only for you. Watch later is always private.
- **Playing:** *Play all* starts at the top and *Shuffle* in a random order. While you watch, the playlist sits
  beside the player with the next videos; its buttons turn shuffle, looping the whole list, and autoplay on or
  off.
- **Editing:** on the playlist's page, drag videos to reorder them (or use the arrows), remove them, and rename
  the list, describe it or change who can see it.
- **Videos that go away** (deleted here, or hidden from the network) disappear from the list or stay as
  *No longer available*, with their title.
- Public and unlisted playlists have their own feed: `/feeds/playlist/<id>.atom` (or `.rss`).

## Feeds

Atom and RSS feeds for feed readers, with the thumbnail and the MP4 in each entry:

| Feed | Address |
| --- | --- |
| The whole site | `/feeds/videos.atom` |
| A channel | `/feeds/channel/<name>.atom` |
| A game | `/feeds/game/<id>.atom` |

Swap `.atom` for `.rss` for RSS. Pages also link their feed for readers that find feeds automatically.

## Subscriptions and notifications

Subscribe to a channel here, on another server in the network, or on the fediverse (see
[Fediverse](Fediverse.md#following-out)). The bell shows:

- new uploads from channels you subscribe to,
- replies to your comments and @mentions,
- comments on your videos,
- moderation decisions about your content.

Settings → *Notifications* picks which of these also arrive as **web push** on a device, or by **email** (when
the admin has set up email and you've confirmed your address).

## Analytics

Studio → *Analytics* shows views and watch time per day, where views came from, your top videos, and a
retention curve per video. Only counts are stored, never who watched, and anonymous mode sends nothing.

## Privacy

Settings → *Privacy* and *Your data*:

- **Pause watch history**, or clear it.
- **Anonymous mode** in a browser: nothing you watch there is recorded.
- **Download your data**: everything you've put on the site, in one archive.
- **Delete your account**, after a 7-day grace period in which you can change your mind. The deletion is
  announced to the network and the fediverse.
