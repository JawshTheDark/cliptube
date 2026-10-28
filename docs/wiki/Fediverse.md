# Fediverse

OurTube speaks **ActivityPub**, the protocol of Mastodon, PeerTube and the rest of the fediverse. It is on by
default (Admin → Network → *Fediverse*) and needs the Public URL set to the site's `https://` address.

- [Being followed](#being-followed)
- [What followers get](#what-followers-get)
- [Interactions coming back](#interactions-coming-back)
- [Following out](#following-out)
- [Mastodon](#mastodon)
- [PeerTube](#peertube)
- [Moderation](#moderation)
- [Linked accounts](#linked-accounts)
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
comments go to their server. The whole comment thread shows, including comments made before anyone here
followed: for PeerTube videos it is read from the video's server (up to 200 threads, refreshed every minute).

Admins can also follow a **whole PeerTube server**, the way PeerTube servers mirror each other: type its address
under Admin → Network → *Follow a whole server*, or pick it from **Browse the PeerTube directory** there. The
directory is [joinpeertube.org](https://joinpeertube.org/instances)'s list of servers, searchable by words, language
and topics (gaming, how to, science and tech, comedy ...), sorted by videos, followers, people or newest, with a
Follow button on each. Servers that show NSFW openly are left out unless you ask for them, and videos marked
sensitive stay out either way. A server accepts the follow by itself or after its admin approves it; until then it
shows as waiting. Set `PEERTUBE_DIRECTORY_URL` to use another directory with the same API.

Servers in an OurTube network can pass what they follow on to each other, if both sides opt in: see
[Sharing what you follow](Network.md#sharing-what-you-follow).

## Mastodon

- Channel pages have **Follow from your server**, which opens the follow page on the viewer's own server.
- Follow buttons on other servers can point back here (`/authorize_interaction`).
- **Support links** show as profile fields.
- `/help/fediverse` explains all of this for viewers.

## PeerTube

PeerTube channels can be followed from OurTube and the other way round, and each side plays the other's videos.
PeerTube comments and likes work in both directions.

## Moderation

- **Blocked servers are blocked for ActivityPub too.**
- **Reports** about fediverse videos go to their server as a `Flag` from this server, not from the person who
  reported, and incoming reports join the moderation queue.

## Linked accounts

If you have accounts on several OurTube servers (or an OurTube account and a Mastodon one), link them, and
every server shows them as one person. Unlike a move, nothing goes away: each account keeps its own videos,
subscribers and login.

**Linking.** In Settings → *Linked accounts*, enter your other account (`@you@other-site.example`), then do the
same on the other site for this account. A link counts once **both accounts list each other**, so nobody can
claim an account that isn't theirs. When you link on one site first, the other one shows the new account under
*These accounts say they're you*, with a **Link back** button. Up to five accounts can be linked.

**Mastodon** accounts take part through an account alias: on Mastodon, open Preferences → Account → *Moving
from a different account* and add your OurTube account there (it moves nothing). Then click *Check again* on
OurTube.

**What people see** once a link counts:

- **Also on** on your channel page, with a check mark, linking to each of your other accounts;
- **Subscribe to all**, which subscribes to your channel here and follows your channels elsewhere in one click
  (a Mastodon account has no videos to follow, so it is left out);
- an **All accounts** filter on your channel's videos, which brings in your videos from the other servers;
- your comments from any of your accounts with the **uploader's mark** on your own videos. They also skip the
  spam check that holds names imitating the uploader.

**Under the hood.** Linked accounts are published in your account's `alsoKnownAs`, next to old accounts from
*Moving here*, and your channel page carries `rel="me"` links to them, so Mastodon can verify a profile link to
your channel. Each server checks the other side whenever an account changes and twice a day, and drops the link
as soon as either side removes it.

## Moving a channel

To move to another server (Settings → Account → *Moving to another site*):

1. **Export** the channel on the old server: one archive with the videos, thumbnails, captions, comments and the
   subscriber list.
2. **Import** it on the new server, from the export's private link or by uploading the archive.
3. On the new server, add the old account as an alias (Settings → Account → *Moving here*).
4. On the old server, **move**.

Fediverse followers get an ActivityPub `Move` and follow the new channel; subscribers on the old server and on
other OurTube servers are moved too, and the old channel points to the new one. When a fediverse account that
people here follow moves, OurTube follows the move.

## Checked against real servers

`scripts/fediverse-sandbox.sh <ssh-host>` starts **PeerTube 7.3**, **GoToSocial 0.22** and an OurTube built
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
- **Extensions:** a few OurTube fields (the game, counts, a report reason) under the `cliptube:` context; other
  software ignores them. Details in
  [docs/federation.md](https://github.com/JawshTheDark/ourtube/blob/main/docs/federation.md).
