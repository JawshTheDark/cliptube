# OurTube implementation plan

How to build everything in [TODO.md](TODO.md). Drafted 2026-10-25 against v0.3.0 (branch `network-hub`).

## Status

Work order follows the suggested order below. Updated as each milestone lands. Version numbers follow release
order, so M3 shipped as v0.6.0 ahead of M2 (now v0.7.0), and later milestones move up one place.

| Milestone | Status | Released |
| --- | --- | --- |
| M0 Foundations | Done | v0.4.0, 2026-10-25 |
| M1 Trust and safety | Done | v0.5.0, 2026-10-25 |
| M3 Gaming clip tools | Done | v0.6.0, 2026-10-25 |
| M2 Hub-optional network | Done | v0.7.0, 2026-10-25 |
| M4 Watching upgrades | Done | v0.8.0, 2026-10-25 |
| M5 Feeds, notifications, search, analytics | Done | v0.9.0, 2026-10-25 |
| M6 ActivityPub and PeerTube | Done (live PeerTube check pending) | v1.0.0, 2026-10-25 |
| M7 Mastodon, moves, export and import | Done (live Mastodon check pending) | v1.1.0, 2026-10-25 |
| M8 One federation protocol | Done: the network runs over ActivityPub (see docs/federation.md) | v1.2.0 decision, v1.3.0 switch, 2026-10-25 |
| After M8: game catalog from the hub, verticals toggle moved to Settings | Done | v1.3.0, 2026-10-25 |
| After M8: SteamGridDB artwork, uploads as drafts until saved | Done | v1.4.0, 2026-10-25 |
| Android app (mobile/, Expo); bearer-token sign-in for it | Done | v1.5.0 and android-v1.0.0, 2026-10-25 |
| After M8: linked accounts (one person on several servers, verified both ways) | Done | v1.6.0, 2026-10-25 |
| Security pass before going public: sign-in and sign-up limits, SECURITY.md, no private details in the repo | Done | v1.6.1, 2026-10-25 |
| Playlists and Watch later | Done | v1.7.0, 2026-10-25 |
| Watch parties | Done | v1.8.0, 2026-10-25 |
| Live streaming (MediaMTX next to OurTube) | Done | v1.9.0, 2026-10-25 |
| ARM64 servers: the image adds Debian's ffprobe where the bundled one has no build | Done | v1.9.1, 2026-10-25 |
| Uploads in pieces that resume, for proxies with a request cap such as Cloudflare's | Done | v1.10.0, 2026-10-25 |
| The hub shows each member's current version, not the one it joined with | Done | v1.10.1, 2026-10-25 |
| Merging duplicate games (by hand, and a member's copy into the hub's); a renamed member shows its new name | Done | v1.10.2, 2026-10-25 |
| Sync now reads each server's name and version at its own address (hourly otherwise) | Done | v1.10.3, 2026-10-25 |
| Link previews for clips from other servers in the network | Done | v1.10.4, 2026-10-25 |
| Outgoing webhooks for new videos and live streams (JSON, Discord, Slack) | Done | v1.11.0, 2026-10-25 |
| Webhooks are each person's own, in Settings, and can't reach the server's own network | Done | v1.12.0, 2026-10-25 |
| The OurTube look: dark purple theme, new logo and fonts, Everything / Videos / Shorts on Home with a Shorts shelf, every video tagged with its server | Done | v1.13.0, 2026-10-25 |
| Game pages: sort chips sit cleanly on the artwork, and game pages count videos, not clips | Done | v1.13.1, 2026-10-25 |
| The name OurTube everywhere (repository JawshTheDark/ourtube); webhooks send X-OurTube-* headers as well as the old ones | Done | v1.13.2, 2026-10-26 |
| Whole-server webhooks for admins: everything published here, and optionally new videos from the network | Done | v1.14.0, 2026-10-26 |
| A renamed hub keeps its new name on members (the member directory sent the name from setup) | Done | v1.14.1, 2026-10-26 |
| A channel's new picture, name and bio reach the videos other servers already have | Done | v1.14.2, 2026-10-26 |
| Servers linked (clips.irc.so hub; laptop and clips.6697.pro members) | Done | Linked 2026-10-25, checked after every deploy |

### Needs you

- Auto-continue: creating a scheduled task to resume after a usage limit was refused by Claude Code's
  safety check, so if a limit stops the work it waits until you restart it.
- Legal (M1): fill in Admin → Legal on clips.irc.so (contact email, rules, DMCA agent once you register
  one with the US Copyright Office). Until then `/legal` says no rules are published.
- Streaming (M4): adaptive streaming is off on both servers, because it costs CPU once per video and 50 to 100%
  more disk. Turn it on under Admin → Overview → Adaptive streaming; existing videos are rebuilt in the
  background. I tested the ladder, quality switching and skipping in a browser, not playback on a throttled link.
- Fediverse checks (M6, M7): done without subdomains. `scripts/fediverse-sandbox.sh <ssh-host>` runs a
  real PeerTube (7.3) and GoToSocial (0.22, Mastodon-compatible) next to OurTube in a private Docker sandbox on
  the laptop, with no ports opened, and all 17 checks pass. It cleans up after itself; the images stay cached
  (about 2.3 GB). A check from a real Mastodon account is still worth a try: search for
  @Jawsh_channel@clips.irc.so and follow it.
- Email (M5): no SMTP server is set up, so notifications are in-app and web push only, and there are no
  password-reset emails. Add one under Admin → Overview → Email (any provider's SMTP details work).
- Sign-up (M1): both servers still allow open sign-up. The plan suggested invite-only until moderation tools
  existed; they exist now, so I left it open. Switch it in Admin → Overview → Sign-up if you prefer.

## How this plan works

- Nine milestones, each a release you can deploy on its own. Stopping after any milestone still leaves a
  working product.
- Every release ends the same way: tests pass, the database is backed up and a rollback image is tagged on
  both servers, the laptop gets it first as staging, then clips.irc.so.
- Sizes are relative. **S** is about an hour of work, **M** about half a session, **L** about one full
  session (the size of the hub-network rebuild), **XL** several sessions.
- Total: roughly 15 to 18 sessions.
- Order: safety first, because that's the risk you raised. ActivityPub comes late, because it's the largest
  piece and builds on almost everything before it.

## Milestones at a glance

| # | Release | Theme | Size | Needs |
| --- | --- | --- | --- | --- |
| M0 | v0.4 | Foundations: tests, CI, migrations, job queue, deploy script | L | nothing |
| M1 | v0.5 | Trust and safety: legal page, reports, moderation, takedowns, registration, comment spam, privacy | XL (2 sessions) | M0 |
| M2 | v0.6 | Hub-optional network | L | M0 (M1 preferred) |
| M3 | v0.7 | Gaming clip tools | L | M0 |
| M4 | v0.8 | Watching: adaptive streaming, originals, captions, skip segments, community titles | XL (2 sessions) | M0 |
| M5 | v0.9 | Feeds, notifications, search, analytics | XL (2 sessions) | M0, M1 |
| M6 | v1.0 | ActivityPub core and PeerTube | XL (3 to 4 sessions) | M0, M1, M2, M4 |
| M7 | v1.1 | Mastodon, account moves, channel export and import | L to XL | M6 |
| M8 | n/a | One federation protocol: decision and cleanup | M | M6, M7 |

Suggested order with two sessions running at a time: M0, then M1 and M3 together, then M2 and M4
together, then M5, M6, M7 and M8. See "Parallel workstreams" for which files each stream owns.

## Decisions to make first

Each has a recommendation. None blocks anything before the milestone named.

1. **One federation protocol in the long run (decide by M6).** OurTube speaks its own protocol today.
   ActivityPub can do the same job: PeerTube servers mirror each other's video lists by having their instance
   accounts follow each other. Running both protocols forever doubles the federation code to maintain.
   *Recommendation:* build ActivityPub as the main protocol, keep the OurTube protocol working until
   ActivityPub covers everything it does, and decide in M8 whether to retire it.
2. **Channel model (M6).** PeerTube expects every video to belong to a channel (an ActivityPub `Group`) as
   well as an account (a `Person`). *Recommendation:* expose each OurTube user as both, with one default
   channel. Several channels per user can come later.
3. **Fediverse test sandbox (M6 and M7).** Real interop needs real servers. *Recommendation:* for the length
   of M6 and M7, run a small PeerTube and a GoToSocial server (a lightweight Mastodon-compatible server) on
   test subdomains of irc.so, plus a staging OurTube. That needs DNS records and a few GB of RAM on the
   server. *Alternative:* a full Mastodon, which is heavier but is what most people use.
4. **Storage budget (M4).** Adaptive streaming adds roughly 50 to 100% more disk per video depending on the
   quality ladder, and keeping originals adds more. *Recommendation:* make the ladder an instance setting
   (off, 720p plus source, or full) and add per-user storage quotas in M1.
5. **Email (M1 and M5).** Password resets, notifications and the legal contact work better with email.
   *Recommendation:* optional SMTP settings, with everything still working without email.
6. **Game list and artwork (M3).** *Recommendation:* admins add games and upload artwork by hand; an optional
   IGDB lookup can come later (it needs a free Twitch developer key).
7. **Legal steps that are yours, not code (M1).** Register a DMCA agent with the US Copyright Office (a small
   fee, renewed every three years), and talk to a lawyer if clips.irc.so stays open to strangers.
8. **Registration on clips.irc.so (M1).** *Recommendation:* switch to invite-only until the moderation tools
   are live.

## M0: Foundations (v0.4), size L

Everything later depends on these.

- ✅ Merge `network-hub` into `main` and tag v0.3.0. (S)
- ✅ **Test suite** (`npm test`) on Node's built-in test runner. Unit tests for parsers, signing and edit
  validation. Integration tests that start several instances on random ports with temporary data folders,
  replacing the hand-run scratchpad scripts. Today's hub-network checks become the first suite. (M)
- ✅ **CI** on GitHub Actions running the suite on every push. (S)
- ✅ **Numbered migrations** with a `schema_version` table instead of ad-hoc `addColumn` calls, with an
  automatic database backup before migrating. (S)
- ✅ **Persistent job queue**: a `jobs` table with type, payload, run time, attempts and last error; retries
  with exponential backoff; survives restarts. Video processing and edit renders move onto it, and
  federation delivery, notifications, exports and streaming renditions will use it. Separate lanes so a long
  encode never holds up deliveries. (M)
- ✅ **Content intake pipeline**: one code path that every new comment, like and report passes through,
  whether local or from another instance, so spam filters (M1), moderation (M1) and ActivityPub (M6) all
  plug in at one place. (S)
- ✅ **Roles and account status**: a `moderator` role alongside admin, and account status (active, suspended,
  banned). (S)
- ✅ **Deploy script** (`scripts/deploy.sh <host>`): backup, rollback tag, ship, build, health check. (S)
- ✅ Docs: the hairpin NAT note for home hosting. (S)

**Schema:** `schema_version`, `jobs`, `users.role`, `users.status`.
**Done when:** CI is green, v0.4 ships with the deploy script, and the hub network still works between
both servers.

## M1: Trust and safety (v0.5), size XL

### Legal and abuse

- ✅ **`/legal` page** per instance with contact email, DMCA agent details and rules, edited in a new
  Admin → Legal tab. Linked from the sidebar footer, every watch page and the sign-up form. (S)
- ✅ **Registration modes**: open, approval required, invite-only (invite links with expiry and use limits),
  closed. Terms are shown and accepted at sign-up. (M)
- ✅ **Report button** on videos, comments and channels, local and remote, with reasons (copyright, spam,
  harassment, illegal content, other). Reports about another instance's content are forwarded to it as a
  signed `report` request, and as an ActivityPub `Flag` once M6 lands. (M)
- ✅ **Moderation queue** (Admin → Moderation): open reports with context, one-click actions (hide or remove
  video, delete comment, suspend or ban user, block or ban instance, dismiss), moderator notes, resolved
  state, and an audit log of every action. (L)
- ✅ **Video moderation status**: hidden or removed, with a reason the uploader can see. Removed files are kept
  for a set period in case of a counter-notice. (S)
- ✅ **Takedown log**: admins record notices (claimant, work, URL, date, action taken). Optional public
  transparency page with counts. (S)
- ✅ **Counter-notice flow**: the uploader submits a counter-notice from the removed video; the admin sees it
  next to the original notice and restores the video or keeps it down. (M)
- ✅ **Repeat-infringer policy**: strikes per account with a configurable threshold that suspends the account
  automatically. (S)
- ✅ **Storage quotas**: a default per-user quota with per-user overrides. (S)
- ✅ Docs: background on what the DMCA safe harbors and Section 230 require, pointing to real legal advice. (S)

### Comments

These live here because they share the moderation queue.

- ✅ **Anti-spam**: rate limits by account age, hold first-time commenters for review, no links from new
  accounts, and hold names that imitate the video's uploader (lookalike-character check). (M)
- ✅ **Never silently dropped**: held comments show to their author as "held for review". Comments from other
  instances get the same treatment, and the sending instance is told the comment is held. (S)
- ✅ **Creator tools**: keyword filters, hold everything for review, pin, creator heart, and turning comments
  off per video. (M)

### Privacy

- ✅ **Pause watch history**, and an anonymous mode that records nothing while it's on. (S)
- ✅ **Personal data export** (JSON plus your uploads) and **self-serve account deletion** with a 7-day grace
  period. Deletion is announced to the network so other instances drop the person's comments and likes. (M)

**Schema:** `reports`, `mod_actions`, `takedown_notices`, `counter_notices`, `invites`, `strikes`,
`comment_filters`; `videos.moderation_status`, `videos.moderation_reason`, `videos.moderated_at`;
`comments.status`; `users.quota_bytes`, `users.history_paused`.
**Done when:** a report filed on one instance about a video on another reaches that instance's queue, and
the action taken there removes the video everywhere.

## M2: Hub-optional network (v0.6), size L

- ✅ **Direct key checks**: fetch a peer's key from its own `/.well-known/cliptube` over HTTPS and cache it.
  The hub directory becomes a hint only. (S)
- ✅ **Signed requests between peers**: replace the single hub feed token with per-request signatures, so any
  approved peer can pull any other peer's feed. (M)
- ✅ **Peer list and peer exchange**: record where each peer was learned (hub, another peer, typed in by an
  admin) and when it last answered. A new endpoint returns an instance's known healthy peers, merged on
  every sync. (M)
- ✅ **Direct feed pulls** from every peer, reusing the hub's pull code. Instances send each other a "something
  changed" ping instead of everyone polling everyone. (M)
- ✅ **Join through any instance**: list several hubs, and fall back to peers when no hub answers. (S)
- ✅ **Admission switches on every instance**: accept new peers, require approval, HTTPS only. (S)
- ✅ **Shared blocklists**: publish your block list; subscribe to other instances' lists with auto-apply or
  review. The hub's bans become a list members can follow. (M)
- ✅ **Limits**: back off from failing peers, cap the number of peers, limit requests per host. (S)
- ✅ **Upgrade path**: a protocol version bump that stays compatible with v0.3 instances during rollout. (S)

As built: an instance is a member of one hub at a time; other hubs and any other instances can be added as
direct peers, which gives the same fallback when a hub stops answering.

**Schema:** `instances.source`, `instances.last_ok_at`, `instances.key_checked_at`;
`blocklist_subscriptions`, `blocklist_entries`.
**Done when:** three instances find each other through one of them, the hub is switched off in the middle
of the test, and syncing, likes and comments keep working.

## M3: Gaming clip tools (v0.7), size L

- ✅ **Clip a moment**: a Clip button in the player and the editor makes a new video from a range of an
  existing one, defaulting to the 30 seconds before the playhead. The new clip links back to its source.
  Runs as a job; copies without re-encoding when the cut points fall on keyframes. (M)
- ✅ **GIF and short MP4 export** of a selection, with size and length limits and a palette-optimised GIF. (M)
- ✅ **Share ranges**: `?t=` and `&end=` with looping playback, and start and end fields in the share dialog,
  filled from the current selection. (S)
- ✅ **Games**: a games list (name, short name, artwork, aliases), a game field on videos with autocomplete,
  per-game browse pages, and the game shown on video cards. Shared with the network as a tag, so other
  instances group clips by game too. (M)
- ✅ **Side-by-side compare** (`/compare?a=…&b=…`): two players on one transport bar, a per-side offset to line
  up the action, and audio from either side. Works with videos from other instances. (M)

**Schema:** `games`, `videos.game_id`, `videos.source_video_id`, `videos.source_start`, `videos.source_end`.
**Done when:** you can clip a moment from the CoD video, export it as a GIF, share a looping range link,
and compare two clips side by side.

## M4: Watching upgrades (v0.8), size XL

- ✅ **Adaptive streaming (HLS)**: a job builds a quality ladder (for example 1080p60, 720p60 and 480p) plus a
  source-quality rendition that's never paywalled. The player uses hls.js (bundled and pinned) with a quality
  menu. MP4 stays as the fallback and for downloads and Discord previews. The ladder is an instance setting. (L)
- ✅ **Federation rendition**: a smaller MP4, around 720p, for platforms that only cache remote video under a
  size limit. Mastodon does this, so M7 needs it. (S)
- ✅ **Download original**: always for the uploader; for viewers when the uploader allows it on that video. (S)
- ✅ **Dislike counts** shown, with an instance setting to hide them. (S)
- ✅ **Support links** on channels, shown on watch pages. (S)
- ✅ **Captions**: upload WebVTT or SRT per language; viewers can submit captions that the uploader approves;
  shown in the player. No automatic dubbing or translation, ever. (M)
- ✅ **Skippable segments**: creators mark sponsor, intro, outro and recap segments in the editor; viewers can
  suggest segments; each viewer picks auto-skip, ask, or just show them. (M)
- ✅ **Community titles and thumbnails**: viewers suggest a plainer title or pick a frame for the thumbnail,
  with votes. Viewers can choose to see community versions, and the uploader can adopt one. (M)

**Schema:** `renditions`, `captions`, `segments`, `title_suggestions`, `thumbnail_suggestions`,
`suggestion_votes`; `users.support_links`; `videos.allow_original_download`.
**Done when:** a 1080p60 clip plays smoothly on a throttled connection, captions and auto-skip work, and
viewers can download the original when allowed.

## M5: Feeds, notifications, search and analytics (v0.9), size XL

- ✅ **RSS and Atom feeds** per channel, per game and per instance, linked from those pages. (S)
- ✅ **Notifications**: an in-app bell with unread count for new uploads from subscriptions, replies, mentions
  and moderation outcomes; then web push (service worker plus VAPID keys); then optional email. Delivered
  through the job queue. (L)
- ✅ **Transparent home feed**: every recommendation carries its reason ("new from a channel you follow",
  "popular in #valorant", "because you liked …"). Viewer controls: more or less of a game or channel, not
  interested, hide watched. Chronological stays the default. (M)
- ✅ **Vertical clips tab**: detected from the video's dimensions, with its own tab and a setting to keep them
  out of the main feed. (S)
- ✅ **Search**: a SQLite FTS5 full-text index if Node's built-in SQLite includes it (check first; otherwise
  keep the current matching), relevance ranking, filters (game, length, upload date, instance, exact phrase)
  and sort options. (M)
- ✅ **Creator analytics**: daily views and watch time, referring sites, and a retention graph built from
  sampled playback progress. Anonymous viewers are included, and no personal data is kept. (M)

**Schema:** `notifications`, `push_subscriptions`, `feed_preferences`, `video_stats_daily`,
`video_retention`, an FTS virtual table.
**Done when:** a new upload notifies subscribers within a minute on the same instance and on another one,
and search finds clips by game, length and phrase.

## M6: ActivityPub core and PeerTube (v1.0), size XL

**Setup:** the fediverse sandbox from decision 3, plus a staging OurTube.

- ✅ **Discovery**: WebFinger, NodeInfo and host-meta. (S)
- ✅ **Actors**: an instance `Application` actor, and each user as a `Person` plus a default channel `Group`,
  each with inbox, outbox, followers and following collections. (M)
- ✅ **HTTP Signatures**: an RSA key per actor, because Mastodon and PeerTube sign with RSA. Outgoing requests
  are signed; incoming ones are verified against a cached key fetch. Signed GETs from the instance actor
  cover servers that require them. (M)
- ✅ **Videos as `Video` objects** in PeerTube's vocabulary: duration, `url` entries for the MP4 renditions
  and the HLS playlist, thumbnails, tags, sensitive flag, comments-enabled flag and view counts. (M) As built:
  HLS is left out of the object, because PeerTube needs per-segment hashes for it; PeerTube plays the MP4s.
- ✅ **Follows**: Follow, Accept, Reject and Undo, for channels (subscriptions) and for the instance actor
  (whole-instance mirroring, the way PeerTube servers follow each other). Remote followers become placeholder
  accounts, as they do today. (M)
- ✅ **Delivery**: Create, Update and Delete for videos, sent to followers' shared inboxes through the job
  queue, retried over several days, with per-host limits. (M)
- ✅ **Interactions**: Like, Dislike, Announce and Undo are counted. Comments travel as `Note` objects with
  `inReplyTo`, threaded both ways. (M)
- ✅ **Moderation**: instance blocks and blocklists apply to ActivityPub traffic; reports go out as `Flag`;
  remote accounts can be silenced or suspended. (S)
- ✅ **Remote video ingestion**: ActivityPub videos go into the same network index, so Network, search and
  feeds show them, and the player picks the best MP4 or HLS source. (M)
- ◐ **PeerTube interop** (built to PeerTube's vocabulary and tested against a stand-in server in the tests, with object shapes taken from a live PeerTube; not yet checked against a real PeerTube, see Needs you): OurTube follows PeerTube channels and whole instances; PeerTube follows OurTube
  channels and plays their videos; comments and likes flow both ways. Checked against the sandbox. (M)

**Schema:** `ap_actors` (cache of remote actors and keys), `ap_objects` (seen activity and object ids, for
deduplication), `users.ap_public_key`, `users.ap_private_key`, `network_videos.ap_id`,
`network_videos.origin_type`, `comments.ap_id`.
**Done when:** the sandbox PeerTube follows an OurTube channel, plays a new upload within a minute, and a
comment posted there shows up on OurTube, and the reverse works too.

## M7: Mastodon, account moves, export and import (v1.1), size L to XL

- ◐ **Mastodon**: people follow `@user@clips.example.com`, and new clips appear in their timeline with the
  title, thumbnail and a playable video attachment using the federation rendition. Likes, boosts and replies
  come back as likes, shares and comments. Checked against GoToSocial, and Mastodon if you choose it. (M)
  *As built:* the attachment carries the poster frame and alt text, support links are profile fields,
  channels have "Follow from your server", and the leading @mention on Mastodon replies is dropped. Checked
  against a Mastodon-like stand-in in the tests, not a real Mastodon or GoToSocial yet (see "Needs you").
- ✅ **Channel export and import**: one archive with videos, metadata, comments and the subscriber list; import
  recreates the channel on another instance. (M)
  *As built:* the new instance can fetch the archive from the export's private link, so it never passes
  through a phone. Comments keep their authors as linked placeholder accounts, the owner's own comments
  become the new account's, and old videos are not announced as new uploads. Videos taken down by
  moderators stay behind.
- ✅ **Account moves**: ActivityPub `Move` with `alsoKnownAs`, so followers carry over. The OurTube network
  learns about the move too. (M)
  *As built:* subscribers on the old instance are moved by it, and other OurTube instances get a signed
  "account moved" message and move their people, after checking the new account lists the old one.
- ✅ **Public docs**: how to follow OurTube channels from Mastodon and PeerTube. (S) At `/help/fediverse`.

**Schema:** `users.moved_to`, `users.also_known_as`; export archives run as jobs.
**Done when:** a sandbox Mastodon or GoToSocial account follows an OurTube channel, watches a clip in its
timeline, replies, and the reply appears as a comment.

## M8: One federation protocol, size M

- ✅ Compare the OurTube protocol with ActivityPub for OurTube-to-OurTube traffic: features, reliability and
  how much code each needs. The comparison is in [docs/federation.md](docs/federation.md).
- ✅ *Recommended outcome* if ActivityPub covers everything: OurTube instances talk ActivityPub to each other,
  the hub becomes an optional directory and blocklist service (like the instance index PeerTube runs at
  joinpeertube.org), and the old protocol stays read-only for one release before it's removed.
  *Outcome:* first decided (v1.2.0) to keep two layers, because moving would lose immediate comment verdicts,
  whole comment threads, the hub's switches and a reliable video index. You chose the full move, so v1.3.0
  (protocol 4) won those back over ActivityPub: Accept or Reject answers to comments, the comments collection
  with notes inline, the switches enforced on ActivityPub traffic between members, and outbox reconciliation
  each round. Peering is now a follow between instance actors under the same admission switches. The hub is
  the directory, switchboard, block list and game catalog. v3 stays for one release for older instances.
  *Cleanup shipped:* one placeholder account per person and one row per video across both protocols, the
  game carried over ActivityPub, and account deletions sent to every known fediverse server.

## Parallel workstreams

After M0 the work splits into separate sessions with clear file ownership:

| Stream | Milestones | Owns | Watch out for |
| --- | --- | --- | --- |
| Safety | M1, then M5 privacy and notifications | moderation, users, comment intake | Comments overlap with Federation; both go through the M0 intake pipeline |
| Federation | M2, then M6 to M8 | `server/network.js`, a new `server/activitypub/` | M6 needs M1's reports and M4's renditions first |
| Clips | M3 | editor, player controls, new clip routes | Shares the media pipeline with Watching; change the pipeline in one stream at a time |
| Watching | M4 | media pipeline, streaming, captions | HLS changes the player; coordinate with Clips |

## Testing and release process

- Every milestone adds tests to `npm test`, and CI must pass before a deploy.
- Multi-instance tests start real servers with temporary data and `--allow-private-federation`.
- Fediverse interop tests run against the sandbox in M6 and M7, scripted so they can be re-run.
- Before M2 and M6 ship, a load check: 10,000 synthetic videos and 50 simulated instances, measuring sync
  time, request volume and database size.
- Release steps: tests, deploy to the laptop as staging, smoke check, deploy to clips.irc.so, smoke check.
  Backup and rollback image every time.

## Risks

- **ActivityPub details.** PeerTube's and Mastodon's expectations are only partly documented. *Mitigation:*
  the sandbox, and reading their published ActivityPub notes before building.
- **Storage growth** from streaming renditions, originals and federation renditions. *Mitigation:* instance
  settings, quotas, and a disk-usage view in Admin.
- **Spam and abuse** once OurTube talks to the wider fediverse. *Mitigation:* M1's tools ship before M6, and
  new remote accounts start rate-limited.
- **Legal.** The plan reduces exposure but isn't legal advice. *Mitigation:* decision 7.
- **Home hosting.** The laptop depends on your connection, router and changing IP. Fine as staging, not as a
  hub.
- **Scope.** This is many sessions of work. *Mitigation:* every milestone ships on its own.

## Coverage of TODO.md

Every item in TODO.md and where it's built.

| TODO.md section | Items | Milestone |
| --- | --- | --- |
| 1. Hub-optional network | Direct key checks, peer list, peer exchange, direct pulls, join via any instance, admission switches, shared blocklists, traffic limits, migration path, tests | M2 |
| 2. Legal and abuse | Legal page, report button, moderation queue, takedown log, counter-notices, registration modes, terms, docs | M1 |
| 3. ActivityPub | Discovery, actors, signatures, `Video` objects, follows, likes, comments, announces, moderation | M6 |
| 3. ActivityPub | Delivery queue | M0 (queue) and M6 (delivery) |
| 3. ActivityPub | Account moves | M7 |
| 3. PeerTube | Follow PeerTube, play OurTube videos on PeerTube, interop tests | M6 |
| 3. PeerTube | Stay native or recommend PeerTube | M8 |
| 3. Mastodon | Follows, timeline posts, replies as comments, interop tests | M7 |
| 4. Feeds and discovery | RSS, notifications, transparent feed, vertical clips tab, search filters | M5 |
| 4. Creators and copyright | Takedowns, reasons and appeals | M1 |
| 4. Creators and copyright | Channel export and import, account moves | M7 |
| 4. Creators and copyright | Analytics | M5 |
| 4. Watching | Support links, download original, HLS, dislike counts, captions, skippable segments, community titles and thumbnails | M4 |
| 4. Comments and community | Anti-spam, held comments shown to authors, creator tools | M1 |
| 4. Privacy | Pause history, anonymous viewing, data export, account deletion | M1 |
| 4. Gaming clips | Clip a moment, GIF and MP4 export, share ranges, games, side-by-side compare | M3 |
| 5. Smaller follow-ups | Merge `network-hub`, hairpin NAT docs | M0 |
| 5. Smaller follow-ups | HLS | M4 |

## First step

Start M0: merge `network-hub`, set up the test suite and CI, add migrations and the job queue, and ship v0.4
with the deploy script.
