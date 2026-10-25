# Federation: how ClipTube instances talk

ClipTube speaks two protocols: its own (the ClipTube network, protocol v3) and ActivityPub (the fediverse:
Mastodon, PeerTube and friends). Milestone M8 asked whether ClipTube instances should drop their own
protocol and use only ActivityPub between themselves. This is the comparison and the decision.

## Decision (October 2026)

**Keep two layers, each with one job.**

- **ActivityPub is the people layer.** Follows, comments, likes, shares, reports, account deletions and
  account moves with the rest of the fediverse. Anything a person does that another server should know
  about has an ActivityPub form.
- **The ClipTube protocol is the instance layer.** ClipTube instances use it to find each other (peers and
  the optional hub directory), keep the network's video index (pulled and reconciled, so deletions are
  never missed), share block lists, apply network-wide switches, and pass likes, comments and
  subscriptions between them with an immediate answer.
- **The hub stays optional.** It is a directory, a block list publisher and the network's switchboard.
  Instances keep peering directly (v3) when it is gone.

The plan's recommended outcome was to move ClipTube-to-ClipTube traffic to ActivityPub and retire the
ClipTube protocol, *if ActivityPub covers everything*. It doesn't yet. Four things would be lost:

1. **Immediate verdicts.** Over the ClipTube protocol, a comment gets an answer at once: posted, held for
   review, or refused (and why). ActivityPub is fire-and-forget, so a held comment would simply never
   appear for its author.
2. **Whole comment threads.** A ClipTube instance shows the full, live thread of a video on another
   instance. Over ActivityPub it would only show the comments that happened to be delivered to it.
3. **Network-wide switches.** The hub can turn comments, likes or subscriptions off across the network,
   require approval for new instances, or lock the network down. ActivityPub has per-server blocks only.
4. **A reliable video index.** Pulling a feed with a list of ids catches every deletion and edit, even after
   an outage. ActivityPub pushes with retries (three days here); anything missed after that is gone, and an
   outbox crawl only sees recent items.

Rebuilding those on top of ActivityPub would mean ClipTube-only extensions that no other fediverse
software understands: the ClipTube protocol again, in a different envelope, with no interoperability gain.

## Comparison

| | ClipTube protocol (v3) | ActivityPub |
| --- | --- | --- |
| Finding other instances | Peers share peer lists; optional hub directory | None built in (relays, manual follows) |
| A whole instance's videos | Pulled feed plus id list: edits and deletions always caught | Server follow plus Announce: push only, retries for 3 days |
| Following a channel | Yes | Yes |
| Likes and dislikes | Yes, with the new counts back | Yes, no answer |
| Comments | Verdict right away (posted, held, refused); full thread read live | No answer; only delivered comments are known |
| Reports | Yes, with the reporter's handle | `Flag`, sent by the instance (anonymous) |
| Account deletion | Notice to every known ClipTube instance | `Delete` (now to every known server, see below) |
| Account moves | Signed "account moved" notice | `Move` with `alsoKnownAs` (Mastodon-compatible) |
| Network-wide switches | Yes (hub and per instance) | No (per-server blocks) |
| Shared block lists | Yes, auto or review mode | No standard |
| The game a clip is from | Yes | ClipTube extension (below) plus a hashtag |
| Signatures | Ed25519, one key per instance, checked at its own address | RSA HTTP Signatures, one key per actor |
| Works with Mastodon and PeerTube | No | Yes |
| Code (October 2026) | `server/network.js`, about 2,300 lines (with the hub) | `server/ap/`, about 2,250 lines |

The code sizes are close, so removing either one would not shrink ClipTube much: each layer does work the
other can't.

## Cleanup done in M8

The two layers used to overlap in ways that produced duplicates. Fixed in v1.2:

- **One person, one account.** Someone from another ClipTube instance who both comments through the
  network and follows over ActivityPub used to get two placeholder accounts. Now the ActivityPub side adopts
  the network's placeholder (same server, same name), so likes, comments and subscriptions add up.
- **One video, one row.** A ClipTube video that arrives both ways (pulled from a peer, and over ActivityPub
  from a follow) is one entry. The ClipTube path stays in charge when it knows the video, so its page keeps
  the live thread and immediate verdicts.
- **The game travels over ActivityPub too**, as the `game` extension below plus a hashtag, and ClipTube
  reads it back.
- **Account deletion reaches the whole fediverse a site knows**, not only followers, matching what the
  ClipTube network's deletion notice already did.

## When to revisit

Move ClipTube-to-ClipTube interactions to ActivityPub when both of these hold:

- Reply approval is common in the fediverse (interaction policies, where the video's server answers a
  reply with `Accept` or `Reject`, as GoToSocial does and FEP-5624 describes). That brings verdicts back.
- ClipTube can reconcile a peer's videos over ActivityPub (for example an outbox crawl with an id list).

Then: interactions go over ActivityPub, the ClipTube inbox stays read-only for one release, and it is
removed in the next. Discovery, block lists and the hub's switches stay in the instance layer.

## The `game` extension

ClipTube adds one term to its ActivityPub context:

```json
{
  "cliptube": "https://github.com/JawshTheDark/cliptube/blob/main/docs/federation.md#",
  "game": "cliptube:game"
}
```

A `Video` from a clip filed under a game carries:

```json
"game": { "slug": "rocket-league", "name": "Rocket League", "url": "https://clips.example/g/rocket-league" }
```

The slug also goes into `tag` as a `Hashtag`, so software that doesn't know the term still groups by it.

## ClipTube or PeerTube?

The TODO asked whether ClipTube should stay its own thing or point people to PeerTube.

**Stay ClipTube, and speak ActivityPub.** ClipTube is built for gaming clips: one process, SQLite and ffmpeg,
cheap to run on a laptop or a small VPS, with clip tools PeerTube doesn't have (the timeline editor, clipping
from other videos, GIF and MP4 exports, games, side-by-side compare) and a network with hub controls.
Because it speaks ActivityPub, its channels can be followed from PeerTube and Mastodon, so nobody is cut off.

**Recommend PeerTube** to people who need live streaming, peer-to-peer delivery for big audiences, plugins,
remote transcoding runners, object storage, or a mobile app. It is the mature, general-purpose choice; a
PeerTube channel can be followed from ClipTube too.
