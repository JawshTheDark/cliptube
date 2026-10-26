# Thoughts

Ideas that aren't decided yet. Nothing here is planned until it moves to [PLAN.md](PLAN.md) or [TODO.md](TODO.md).

## Adult (18+) content without ID checks

The goal: a video marked adult never shows up for people who aren't signed in, never appears anywhere in
discovery, and is only reachable by going to the uploader's channel. Children shouldn't stumble onto it, and
nobody should have to upload an ID to prove their age.

A possible design:

- **Marking.** The uploader ticks "18+ / adult content" on a video; moderators can set it too, and reports get a
  "should be marked 18+" reason. Over ActivityPub it goes out as `sensitive: true`, the flag PeerTube and
  Mastodon already use.
- **Who sees it.** Only signed-in accounts that turned on *Show adult content* in Settings, which means ticking
  "I'm 18 or older" (self-declared, like Reddit, Discord and Mastodon). Off by default; signed-out visitors never
  see these videos at all.
- **Where it shows.** Only on the uploader's channel, in its own 18+ tab. Never on Home, Trending, Shorts or the
  Shorts shelf, search, game pages, Up next, RSS feeds, playlists or other servers' home pages. A direct link opens
  a "This video is marked 18+" notice instead of the video, and link previews (Discord and the like) get no
  thumbnail or player.
- **A switch per server.** Admins choose *not allowed* (the default: the 18+ option is hidden and nothing marked
  18+ is shown) or *allowed for signed-in adults*.
- **The fediverse.** Since v1.15.2, videos other servers mark sensitive aren't taken into the network index at all.
  That fits "never on the front page", and could stay that way even with the rest of this built.

On children: without ID nothing stops a determined kid who lies, and that's true everywhere. This keeps anyone
from stumbling onto it: they'd need an account, would have to flip a setting and claim to be 18, and would still
have to go looking on a specific channel. Approval or invite-only sign-up helps more on servers that want it.

Some places (the UK, several US states) legally require real age checks for sites with a lot of pornography.
Another reason to leave each server's switch at *not allowed* unless its admin decides otherwise, after checking
what applies to them.
