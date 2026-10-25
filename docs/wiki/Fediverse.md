# Fediverse

ClipTube speaks **ActivityPub**, the protocol of Mastodon, PeerTube and the rest of the fediverse. It is on by
default (Admin → Network → *Fediverse*) and needs the Public URL set to the site's `https://` address.

- [Being followed](#being-followed)
- [What followers get](#what-followers-get)
- [Interactions coming back](#interactions-coming-back)
- [Following out](#following-out)
- [Mastodon](#mastodon)
- [PeerTube](#peertube)
- [Moderation](#moderation)
- [Moving a channel](#moving-a-channel)
- [Checked against real servers](#checked-against-real-servers)
- [Under the hood](#under-the-hood)

## Being followed

Every account is a fediverse account and has a channel, in PeerTube's style:

| Handle | What it is |
| --- | --- |
| `@name_channel@clips.example.com` | The channel: follow this to get the videos |
| `@name@clips.example.com` | The account |

Search for either from Mastodon or PeerTube. Each channel's *About* tab lists both, and fediverse followers
count as subscribers. Pasting a `/watch/...` or `/c/...` link into Mastodon or PeerTube search finds the video
or the channel.

## What followers get

- **New videos** go out to followers when they're published (a `Create`, plus an `Announce` from the channel).
  Edits and removals follow (`Update`, `Delete`). Drafts and private videos never go out.
- The video object uses **PeerTube's vocabulary**, so PeerTube plays the MP4s directly.
- **Mastodon** gets a post with the title, a link and a playable video with its poster frame (the small 720p
  copy when there is one).

## Interactions coming back

- **Replies** from the fediverse land in the comment thread, through the same spam checks as everyone else's,
  and replies here go back to the person you answered.
- **Likes and dislikes** count, and **shares** are counted.

## Following out

**Subscriptions → Follow from the fediverse** takes a handle (`@channel@peertube.example`) or a link. Once the
channel accepts, its recent videos are imported, new ones arrive as they're posted, and they show up under
Network, in search and in your subscriptions, with notifications. You can like and comment on them here; your
comments go to their server.

Admins can also follow a **whole PeerTube server**, the way PeerTube servers mirror each other.

## Mastodon

- Channel pages have **Follow from your server**, which opens the follow page on the viewer's own server.
- Follow buttons on other servers can point back here (`/authorize_interaction`).
- **Support links** show as profile fields.
- `/help/fediverse` explains all of this for viewers.

## PeerTube

PeerTube channels can be followed from ClipTube and the other way round, and each side plays the other's videos.
PeerTube comments and likes work in both directions.

## Moderation

- **Blocked servers are blocked for ActivityPub too.**
- **Reports** about fediverse videos go to their server as a `Flag` from this server, not from the person who
  reported, and incoming reports join the moderation queue.

## Moving a channel

To move to another server (Settings → *Moving to another site*):

1. **Export** the channel on the old server: one archive with the videos, thumbnails, captions, comments and the
   subscriber list.
2. **Import** it on the new server, from the export's private link or by uploading the archive.
3. On the new server, add the old account as an alias (Settings → *Moving here*).
4. On the old server, **move**.

Fediverse followers get an ActivityPub `Move` and follow the new channel; subscribers on the old server and on
other ClipTube servers are moved too, and the old channel points to the new one. When a fediverse account that
people here follow moves, ClipTube follows the move.

## Checked against real servers

`scripts/fediverse-sandbox.sh <ssh-host>` starts **PeerTube 7.3**, **GoToSocial 0.22** and a ClipTube built
from your working tree in a private Docker sandbox on that host (an internal network with its own certificate
authority; nothing is exposed), runs the interop checks and cleans up. Add `--keep` to leave it running for a
look around.

```bash
scripts/fediverse-sandbox.sh user@docker-host
```

## Under the hood

- **Discovery:** WebFinger, NodeInfo (`/nodeinfo/2.0`) and host-meta.
- **Security:** RSA HTTP Signatures (draft-cavage, `rsa-sha256`) on every delivery and fetch, checked on every
  incoming activity.
- **Delivery:** through the job queue, retried for up to three days.
- **Extensions:** a few ClipTube fields (the game, counts, a report reason) under the `cliptube:` context; other
  software ignores them. Details in
  [docs/federation.md](https://github.com/JawshTheDark/cliptube/blob/main/docs/federation.md).
