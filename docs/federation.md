# Federation: how OurTube instances talk

Since OurTube 1.3 (protocol 4), OurTube instances talk ActivityPub to each other, the same standard
they use with Mastodon, PeerTube and the rest of the fediverse. The OurTube-specific part shrank to the
instance layer: finding each other, the hub's directory and switches, shared block lists and the hub's game
catalog.

## How it works

- **Peering is a follow.** Each instance has an instance actor (`/ap/actor`). Two instances peer when their
  instance actors follow each other, which happens on its own when one joins the other, a hub or a peer
  that knows it. The admission switches decide whether a follow is accepted: accept new instances,
  require approval (the follow waits for an admin), HTTPS only, blocks, and the hub's bans and suspensions.
- **Videos.** Each new, changed or removed public video goes out as Create, Update or Delete, with an
  Announce from the instance actor for instances that follow it. Every round each instance also reads its
  peers' outboxes (the instance actor's lists every public video) and fetches what's new or changed, so a
  missed delivery is caught and deletions are never missed.
- **People.** Subscriptions are follows of a channel's actor (`name_channel`), likes and dislikes are Like
  and Dislike, comments are Notes, reports are Flags, deleted accounts are Delete, and moves are Move.
- **Comment answers.** The server hosting a video answers each comment from a OurTube instance with
  Accept (shown, right away or once its owner approves a held one) or Reject (refused, with the reason).
  Until then the author sees it as waiting. A server that refuses the delivery outright (because it blocks
  the sender) marks it refused too.
- **Whole threads.** A video page on another instance reads the full comment thread from the hosting
  instance (its comments collection, with the notes and their authors inline), not only the comments that
  happened to be delivered.
- **The network's switches.** The hub can turn comments, likes or subscriptions off between instances.
  Members refuse to send them, and members refuse to receive them from other members.
- **The hub** stays optional: it is a directory of members, the network's switches, a block list members
  follow, and the game catalog. Members peer with each other directly, so the network keeps working if the
  hub goes away.

## The game catalog

The hub publishes its list of games (`/api/hub/games`, for members) and members take it every round, so a
member doesn't have to build its own list. Games from the hub are marked as such on members and can only be
changed there. When the hub deletes a game, members delete it too and their clips stay, without a game.
Members can still add games of their own. A member that leaves the hub keeps the games it has as its own.

## What was given up, and how it was won back

Moving off the OurTube protocol meant giving up four things it did in a single request. They are back:

| Before (protocol v3) | Now (protocol 4, over ActivityPub) |
| --- | --- |
| A comment got its verdict (posted, held, refused) in the response | Accept or Reject from the hosting server, usually within a second; held comments stay "waiting" until approved |
| The video page read the full thread from the hosting instance | Same, through the comments collection (`?embed=1`) |
| The hub's switches covered interactions between members | Same, enforced by both members on ActivityPub traffic |
| Feeds with id lists caught every deletion | Outbox reconciliation every round, plus Delete activities |

Two things work differently: reports reach the hosting instance from the reporting instance (as Flags,
without the reporter's name, the way Mastodon forwards them), and like counts on another instance's video
are refreshed when its page opens.

## Extensions

OurTube adds a few things that other software ignores. The context term is:

```json
{ "cliptube": "https://github.com/JawshTheDark/cliptube/blob/main/docs/federation.md#", "game": "cliptube:game", "counts": "cliptube:counts" }
```

The namespace keeps the repository's old name (it moved to `JawshTheDark/ourtube`, and GitHub redirects the old
address). It names the terms rather than linking to them, so it stays the same on every version, like the
`X-ClipTube-Signature` header and the `cliptube` software name.

- `game` on a Video: `{ "slug": "rocket-league", "name": "Rocket League", "url": "https://clips.example/g/rocket-league" }`.
  The slug also goes into `tag` as a Hashtag, for software that doesn't know the term.
- `counts` on a Video: `{ "likes": 3, "dislikes": 0, "comments": 2, "shares": 1 }`.
- `updated` on the instance outbox's Announce items, so reconciliation fetches only what changed.
- `?embed=1` on a video's comments collection: the notes inline, with their authors' names and pictures.
- `reason` on a Flag: the report reason (`copyright`, `spam`...), next to the usual `content`.
- Accept or Reject whose `object` is a Note: the answer to a comment, as described above.

## Working with the rest of the fediverse

Checked against real servers in a private sandbox (`scripts/fediverse-sandbox.sh`, which runs them in
Docker on a host with no ports opened):

- **PeerTube 7.3:** subscribing to a OurTube channel imports its videos, which PeerTube plays from the MP4;
  comments and likes go both ways; OurTube follows PeerTube channels and whole servers and plays their videos.
- **GoToSocial 0.22** (it speaks Mastodon's API): following a OurTube account, new clips in the timeline with
  a playable video, replies becoming comments, favourites and boosts counting, OurTube's replies arriving,
  and OurTube following GoToSocial accounts.

GoToSocial only takes one `attributedTo`, while PeerTube needs the account and the channel, so GoToSocial
gets the account alone.

## Older instances

Instances on OurTube 1.2 and earlier speak protocol v3. For one release, a 1.3 instance still serves its
v3 feed to them, pulls theirs, and takes their v3 messages, so a network can upgrade one instance at a
time. Each round, an upgraded instance checks whether its v3 peers have upgraded and moves them to
ActivityPub, including the subscriptions of people here to their channels.

## OurTube or PeerTube?

**Stay OurTube, and speak ActivityPub.** OurTube is built for gaming clips: one process, SQLite and ffmpeg,
cheap to run on a laptop or a small VPS, with clip tools PeerTube doesn't have (the timeline editor,
clipping from other videos, GIF and MP4 exports, games, side-by-side compare) and a network with hub
controls. Its channels can be followed from PeerTube and Mastodon, so nobody is cut off.

**Recommend PeerTube** to people who need live streaming, peer-to-peer delivery for big audiences, plugins,
remote transcoding runners, object storage, or a mobile app. It is the mature, general-purpose choice; a
PeerTube channel can be followed from OurTube too.
