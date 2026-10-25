# ClipTube TODO

Planned work. Current state (v0.5.0): one hub (clips.irc.so) that every instance joins, with
cross-instance likes, comments and subscriptions signed per instance. The build order, sizes and
dependencies are in [PLAN.md](PLAN.md).

## 1. Hub-optional network (keep working if the hub disappears)

Goal: the hub becomes an optional starting point and moderation layer. If clips.irc.so goes offline, gets a
legal notice, or is shut down, every other instance keeps seeing and interacting with the rest.

- [ ] **Direct key verification.** Verify another instance's signing key by fetching its own
      `/.well-known/cliptube` over HTTPS (the domain's TLS certificate vouches for it), cached with a TTL.
      Stop depending on the hub directory for keys; keep the hub directory only as a hint.
- [ ] **Peer list per instance.** Each instance stores the instances it knows (`instances` table already
      exists), with where it learned about each one and when it last answered.
- [ ] **Peer exchange.** New endpoint that returns an instance's known, unblocked, reachable peers. Instances
      merge each other's lists on every sync, so joining via any single instance reaches the whole network.
- [ ] **Direct feed pulls.** Each instance pulls `/api/network/feed` from every peer itself (reuse the hub's
      `pullMember` code). Peers authorise each other with per-peer feed tokens or signed requests.
- [ ] **Join via any instance.** "Join network" accepts any instance address, not only a hub. Allow listing
      several hubs; fall back to peer-to-peer when none answer.
- [ ] **Per-instance admission switches.** Every instance (not just the hub) gets: accept new peers
      (lockdown), require approval, HTTPS only. Open by default.
- [ ] **Shared blocklists.** Subscribe to another instance's published block list (with a reason per entry);
      choose auto-apply or review. Export your own block list.
- [ ] **Traffic limits.** Back off from peers that keep failing; cap peers per instance; consider pushing
      change notifications to peers instead of everyone polling everyone once the network grows past dozens.
- [ ] **Migration path.** Existing hub members keep working; the hub keeps its moderation tools (network-wide
      hide and ban), which become a shared blocklist other instances can follow.
- [ ] Tests: three instances, hub turned off mid-test, everything still syncs and interacts.

## 2. Legal and abuse handling

Not legal advice; talk to a lawyer before opening a public instance.

- [x] **Abuse / DMCA contact page** per instance (`/legal`), set in Admin: contact email, DMCA agent details,
      rules text. Linked in the sidebar footer and on every watch page.
- [x] **Report button** on videos and comments (local and remote), with reasons (copyright, spam,
      harassment, illegal content, other). Reports for remote content are forwarded to the hosting instance's
      inbox as a signed `report` request.
- [x] **Moderation queue** in Admin: open reports, one-click hide or delete video, ban user, block or ban
      instance, notes, resolved state.
- [x] **Takedown log**: record notices received, action taken, date. Supports a repeat-infringer policy.
- [x] **Counter-notice flow**: uploader sees why a video was removed and can respond.
- [x] **Registration modes**: open, approval required, invite-only (invite links), closed.
- [x] **Terms / rules page** template shown at sign-up.
- [x] Docs: what the DMCA safe harbors require (registered DMCA agent with the US Copyright Office, prompt
      action on notices, repeat-infringer policy) and Section 230 basics, with a pointer to get real advice.

## 3. ActivityPub (join the fediverse)

Goal: ClipTube speaks the same standard as PeerTube and Mastodon, so their users can follow ClipTube channels,
watch and comment on clips, and ClipTube users can follow PeerTube channels.

- [ ] **Discovery**: WebFinger (`/.well-known/webfinger`), NodeInfo (`/.well-known/nodeinfo`), host-meta.
- [ ] **Actors**: each channel as a `Person` (or PeerTube-style `Group` for channels plus `Person` for
      accounts), each instance as an `Application` actor; inbox, outbox, followers, following collections.
- [ ] **HTTP Signatures** (draft-cavage, RSA-SHA256 for compatibility; keep Ed25519 for ClipTube-to-ClipTube).
- [ ] **Videos as `Video` objects** in the outbox, following PeerTube's vocabulary so PeerTube can play them
      (duration, `url` entries for the MP4 with mediaType/height/fps, thumbnails, tags, `sensitive`).
- [ ] **Follow / Accept / Undo** so remote users can subscribe to channels; deliver `Create Video` to
      followers' inboxes on publish; `Update` and `Delete` on edits and removal.
- [ ] **Likes and dislikes**: `Like` / `Dislike` / `Undo` in the inbox, counted like local ones.
- [ ] **Comments as `Note` objects** with `inReplyTo` pointing at the video or a parent comment, so replies
      from Mastodon land in the comment thread and ClipTube comments show up as replies on Mastodon.
- [ ] **Announce** (boosts/shares) counted and shown.
- [ ] **Delivery queue** with retries and backoff; shared inbox support.
- [ ] **Moderation**: domain blocks apply to ActivityPub traffic; `Flag` activities for reports.
- [ ] **Account migration**: `Move` activity so a channel can move between instances keeping followers.

### PeerTube

- [ ] Let ClipTube follow PeerTube channels and instances; show their videos in Network and search.
- [ ] Make ClipTube videos playable from PeerTube (MP4 `url` entries; PeerTube prefers HLS, so add an HLS
      rendition, see "Playback" below).
- [ ] Decide: stay a lightweight ClipTube-native network that also speaks ActivityPub, or recommend PeerTube
      for people who want the full fediverse feature set. Write up the trade-offs.
- [ ] Test against a real PeerTube instance (docker image) in CI or a local script.

### Mastodon

- [ ] Mastodon users can follow `@channel@clips.example.com`, see new clips in their timeline with a playable
      video attachment, like and boost them, and reply (replies become comments).
- [ ] Mastodon replies show the author's handle and avatar in the comment thread, linking to their profile.
- [ ] Test against a real Mastodon instance (or GoToSocial for something lighter).

## 4. Better than YouTube (ideas from common complaints)

Things people dislike about YouTube that ClipTube can do better. Checked items already exist.

### Feeds and discovery

- [x] Subscriptions feed shows every upload, newest first, including channels on other instances.
- [ ] RSS/Atom feed per channel and per instance.
- [ ] Notifications that always fire for subscribed channels (in-app, plus optional email or web push).
- [ ] Home feed stays chronological or tag-based; "why am I seeing this" on every recommendation; viewer
      controls (more of this game, less of this channel, hide watched).
- [ ] Vertical short clips get their own optional tab that viewers can turn off. Never forced into the feed.
- [ ] Search filters: game, length, upload date, instance, exact phrase; sort by relevance, date, views.

### Creators and copyright

- [x] No automated Content ID matching.
- [x] Human-reviewed takedowns with a counter-notice flow and a public takedown log (see section 2).
- [x] Every removal or restriction shows the reason and the rule it broke; instances publish their rules;
      appeals go to a human.
- [ ] Full channel export (videos, metadata, comments, subscribers list) and import on another instance;
      account moves between instances keep subscribers (ActivityPub `Move`, see section 3).
- [ ] Creator analytics that are honest and simple: views over time, where viewers came from, retention graph.

### Watching

- [x] No ads.
- [ ] Optional tip and support links on channels and videos.
- [x] H.264 uploads are remuxed at their original quality and keep 60fps; transcodes keep the original file.
- [ ] "Download original" for the uploader (and optionally viewers), not just the processed MP4.
- [ ] Adaptive streaming (HLS) with a source-quality rendition that isn't paywalled.
- [ ] Show dislike counts, with a per-instance setting to hide them.
- [ ] Never force AI dubbing or auto-translated titles; bring back community-written captions and subtitles.
- [ ] Built-in skippable segments (sponsor, intro, outro) marked by creators, with optional viewer
      suggestions, like SponsorBlock.
- [ ] Optional community title and thumbnail suggestions to counter clickbait, like DeArrow.

### Comments and community

- [x] Anti-spam: rate limits for new accounts, hold first-time commenters for review, link filtering,
      block display names that imitate the uploader.
- [x] Never silently drop comments: tell the commenter when a comment is held, and why.
- [x] Creator tools: keyword filters, hold-for-review, pinned comments, creator hearts, turn comments off
      per video.

### Privacy

- [x] No tracking or third-party scripts; watch history can be cleared.
- [x] Pause watch history; anonymous viewing mode; per-user data export and account deletion.

### Gaming clips

- [x] Timeline editor for trimming and cutting clips out of longer recordings.
- [x] Discord and Slack link previews with an inline player.
- [ ] One-click "clip the last 30 seconds" (or any length) from a long video or stream VOD.
- [ ] GIF and short MP4 export of a selection.
- [ ] Share links with precise start and end times (`?t=` and `&end=`), looping the selection.
- [ ] Game tags with a per-game browse page and game artwork.
- [ ] Side-by-side comparison player for two clips (same play, two angles), synced.

## 5. Smaller follow-ups

- [x] Merge the `network-hub` branch into `main` (production already runs it).
- [ ] Playback: optional HLS renditions (e.g. 1080p60, 720p60, 480p) alongside the MP4 for weak connections.
- [x] Hairpin NAT note in docs: on a home network without NAT loopback, use the LAN address or a hosts entry.
