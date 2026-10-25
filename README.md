# ClipTube

A self-hosted, YouTube-style video site for sharing gaming clips with friends.
Node.js + Express + SQLite on the backend, React on the frontend, ffmpeg bundled through npm
(nothing else to install).

## Features

- Upload clips (drag and drop, multiple files, progress bar), fill in details while they upload
- Automatic thumbnails, duration, resolution; custom thumbnails
- Smart processing: H.264 MP4s are remuxed losslessly in seconds, everything else (MKV, HEVC, WebM, ...) is
  transcoded to browser-friendly MP4 with an optional GPU encoder (NVENC / QuickSync / AMF)
- Home feed with tag chips, trending, search, channel pages, related videos
- Accounts, subscriptions, likes/dislikes, threaded comments, watch history with resume
- Public / unlisted / private videos, share dialog with "start at" timestamps
- Discord/Slack link previews (Open Graph tags with inline player)
- Studio page to manage your videos, admin page for site settings and users
- **Timeline editor**: trim, split, cut out sections, volume boost or mute, fade in/out, pick a thumbnail from any frame
- **Network**: instances browse and search each other's clips, with likes, comments and subscriptions across instances; join through a hub or any instance, and keep working without the hub
- **Moderation**: reports (also across instances), a moderation queue with an audit log, comment spam holds, copyright takedowns with counter-notices and strikes, invite or approval sign-up, storage quotas
- **Privacy**: pause history, anonymous mode, download all your data, delete your account
- **Clip tools**: clip a moment into a new video, GIF and MP4 export, looping share links, games with their own pages, side-by-side compare
- Keyboard shortcuts: `k` play/pause, `j`/`l` seek 10s, arrows seek 5s, `f` fullscreen, `t` theater, `m` mute, `0-9` jump

## Run it

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000. The first account you create becomes the admin; the register form asks
for the one-time **setup code** that the server prints in its console at startup, so nobody else can
claim the admin account on a public instance (with Docker: `docker logs cliptube`).
The console also prints your LAN address so friends on your network can connect.

Development (hot reload, frontend on http://localhost:5173, API on 3000):

```bash
npm run dev
```

## Timeline editor

Open it from Studio (scissors icon), the video details page, or the Editor button on your own watch page.

- The timeline shows a filmstrip and the audio waveform. Click or drag on it to move the playhead.
- **S** splits the part under the playhead, **Del** removes the selected part, and dragging a part's yellow
  edges trims it (it snaps to the playhead). **I** / **O** set the selected part's start and end to the playhead.
- Removed sections are hatched; double-click one to bring it back.
- **Preview edit** plays the result live, skipping cut sections. **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo.
- Volume goes up to 300%, mute removes the audio track, and fades go to and from black.
- **Save** renders the edit in the background. The old version stays up until the new one is ready, and
  shared links keep working. **Revert to original** restores the upload at any time, because edits are
  non-destructive: the first processed file is kept as the editing source (an edited video uses roughly
  twice its disk space).

## Gaming clip tools

- **Clip a moment.** The Clip button on a watch page (and "Make a clip" in the editor) cuts a range into a
  new video that links back to where it came from. It defaults to the 30 seconds before the playhead.
  "Exact" starts where you chose; "Fast" starts at the nearest keyframe before it and copies without
  re-encoding, so it keeps full quality and is ready almost at once. Uploaders can tick "Let others clip
  this video" so viewers can make their own clips of it.
- **GIF and MP4 export.** The same dialog exports a range as a palette-optimised GIF (up to 15 seconds) or a
  720p MP4 (up to 60 seconds, with or without sound). Downloads last a day.
- **Looping links.** Share → "Loop a range" makes a link like `/watch/abc?t=12&end=20` that plays and loops
  just that part.
- **Games.** Moderators keep a list in Admin → Games, with box art and other spellings ("Also known as").
  Uploads and video details have a Game field; each game has a page at `/g/<id>` and all of them are under
  Games in the sidebar. The game travels with the video across the network, and aliases match it to the
  same game on other instances.
- **Compare.** The compare button on a watch page opens `/compare` with that clip on one side. Pick the
  other, line up the same moment with each side's start buttons (down to one frame), then play both on one
  transport bar at up to 1/10 speed. "Copy link" shares the lined-up comparison.

## Network (a hub if you want one, peers either way)

Each person runs their own instance and hosts their own clips. Instances in a network see each other's public
clips in **Network**, on the home feed and in search. Video files are never copied: viewers stream from the
instance that hosts the clip.

A **hub** is the easy way in and can moderate the whole network, but it is optional. Instances also peer with
each other directly: each one checks the others' keys at their own addresses, pulls their clips itself and
pings them when its own clips change. You can join through the hub or through any instance already in the
network, and the rest is found from there. If the hub goes offline, gets a legal notice or shuts down, the
others keep seeing each other and keep liking and commenting.

People can like, comment on and subscribe to videos on other instances. The action is sent to the instance
hosting the video, signed by the sender's instance, so counts and comment threads are the same everywhere.
People from elsewhere appear as `name@their.host` and link back to their home instance.

**Running the hub** (Admin → Network → *This instance is the hub*):

| Setting | Default | What it does |
| --- | --- | --- |
| Accept new instances | on | Turn off to lock the network to its current members |
| Require my approval | off | New instances wait until the hub admin approves them |
| HTTPS only | on | Refuse instances not served over HTTPS (the same three switches decide who may peer with the hub) |
| Comments / likes / subscriptions between instances | on | Network-wide switches for each kind of interaction |
| Include this instance's videos | on | Share the hub's own public clips with the network |
| Max videos per instance | 5000 | Cap on how many clips one instance can put in the index |
| Sync every | 10 min | How often the hub and members refresh (changes are also pushed within seconds) |
| Announcement | empty | Banner shown on the Network page of every instance |

Per instance, the hub admin can approve, suspend (temporarily drop from the network), ban (can't rejoin),
stop its likes and comments, hide its videos, or remove it. Any single network video can be hidden too.

**Joining** (Admin → Network → *Join network*): enter the hub's address (`https://clips.irc.so` by default) or
the address of any instance in the network. The site needs a public HTTPS address set as its Public URL. Each
instance can also:

- peer with any instance directly (Direct peers → *Peer with it*), and see each peer's state both ways;
- decide who can peer with it: accept new instances (lockdown when off), ask first, HTTPS only, a peer limit;
- block any other instance, which hides its videos and refuses likes, comments and subscriptions from it;
- publish its block list and follow other instances' lists, applied automatically or after review. Members
  follow their hub's list automatically, so the hub's bans and network-wide hides reach them even though they
  pull from peers directly. Blocks from a list are lifted when the source lifts them;
- turn off accepting comments, likes or subscriptions from other instances;
- untick **Share with the network** on a public video to keep it local;
- **Leave hub only** (keep the direct peers) or leave the network entirely.

Failing peers are retried with backoff (1 minute doubling up to 6 hours).

Only public, ready videos with sharing on are ever listed. Networking refuses to contact private-network
addresses; to test several instances on one machine, start them with `--allow-private-federation`.

Protocol summary (v3, JSON over HTTPS): `GET /.well-known/cliptube` describes an instance, its Ed25519 key and
its admission switches; a key is trusted only after it was fetched from the instance's own address. Requests
between peers carry `X-ClipTube-Instance`, `X-ClipTube-Date` and `X-ClipTube-Signature` (a signature over the
method, path and query, date, sender and a SHA-256 of the body). `POST /api/network/hello` asks to peer and
returns the decision and the peers the receiver can vouch for; `GET /api/network/known-peers` exchanges peer
lists; `GET /api/network/feed` and `/feed/ids` serve public videos to accepted peers; `POST /api/network/ping`
says "something changed"; `POST /api/network/goodbye` leaves; `GET /api/network/blocklist` publishes blocks.
Interactions go to the target's `/api/network/inbox`, signed over the body.

The v2 hub protocol still works alongside, so older instances keep working during an upgrade: members
register with `POST /api/hub/join` (nonce callback to `/api/network/verify`), the hub pulls their feeds with a
token and serves `/api/hub/index`, `/api/hub/index/ids` and `/api/hub/directory`. Members use the hub's index
only for instances they can't pull directly.

## Moderation and legal

Everything here lives under **Admin**: the **Moderation** tab for moderators and admins, and the **Legal** tab
for admins.

- **Roles.** Members, moderators (reports, held comments, hiding and removing videos, suspending members) and
  admins (everything, including settings, the network and legal).
- **Reports.** Signed-in people can flag a video, comment or channel, including ones from other instances.
  Reports about another instance's content are forwarded to it, so its moderators see them in their own queue.
  Each report has one-click actions, notes, and every action lands in the audit log.
- **Videos** can be hidden (only the uploader and moderators see it) or removed (nobody can play it). Removed
  files are kept for the retention period in Admin → Legal, then deleted.
- **Comments.** First comments, links from new accounts and names that imitate the uploader are held for
  review, and fast posting is rate limited. Uploaders can add blocked words, hold every comment, turn comments
  off per video, and pin or heart comments. Held comments stay visible to their author marked as held, and
  wait in Studio → Comments to review. The thresholds are in Admin → Moderation → Spam settings.
- **Sign-up** can be open, need approval, be invite-only (invite links with use limits and expiry) or closed.
  An invite also skips approval. If you write terms in Admin → Legal, people accept them when they sign up.
- **Storage quotas**: a default per person in Admin → Overview, with per-person overrides in the users table.
- **Copyright notices.** Record each notice in Admin → Legal. Choosing "Remove the video" takes it down and,
  optionally, gives the uploader a strike; enough active strikes suspend the account. The uploader can send a
  counter-notice from the removed video, and accepting it restores the video and takes the strike away.
- **Public pages.** `/legal` shows your rules, terms and contacts, and `/transparency` shows counts of notices,
  removals and restorations (you can turn it off).
- **Privacy.** People can pause their watch history, turn on anonymous mode in a browser, download all of their
  data, and delete their account after a 7-day grace period. Deletion is announced to the network.

### Background, not legal advice

If strangers can upload to your instance, you are hosting their content. Laws differ by country, so talk to a
lawyer before opening sign-ups. For the US, the short version:

- **DMCA safe harbor (17 U.S.C. § 512(c))** protects hosts from copyright claims over user uploads if they
  register a designated agent with the US Copyright Office (an online form with a small fee, renewed every
  three years), remove material quickly when they get a valid notice, and have and enforce a policy that ends
  repeat infringers' accounts. Put the agent's details in Admin → Legal so they show on `/legal`.
- **Counter-notices.** After a valid counter-notice, the law expects the host to put the material back in 10 to
  14 business days unless the claimant says they have gone to court. ClipTube records the counter-notice and
  leaves the decision to you.
- **Section 230** generally shields hosts from liability for what users post, but not for copyright or
  federal crimes. Child sexual abuse material must be reported to NCMEC; remove it and preserve what you're
  told to.
- **Elsewhere**: the EU's Digital Services Act has its own notice-and-action and transparency rules for hosts.

Running a members-only instance for friends keeps most of this simple. Use invite-only sign-up until you're
ready for more.

## Configuration

Environment variables (all optional):

| Variable      | Default    | Purpose                                              |
| ------------- | ---------- | ---------------------------------------------------- |
| `PORT`        | `3000`     | Port to listen on                                    |
| `HOST`        | `0.0.0.0`  | Interface to bind                                    |
| `DATA_DIR`    | `./data`   | Where the database, videos and thumbnails are stored |
| `TRUST_PROXY` | unset      | Set to `1` when running behind a reverse proxy       |

Everything else (site name, registration on/off, upload limit, max resolution, encoder, public URL)
is in the Admin page.

## Storage

```
data/
  cliptube.db   SQLite database
  videos/       processed MP4s served to viewers
  thumbs/       thumbnails
  originals/    source files kept after a transcode (remuxed sources are deleted; see Admin)
  avatars/
```

Back up the `data` folder and you have everything.

Optional: `FFMPEG_PATH` and `FFPROBE_PATH` point at a system ffmpeg instead of the bundled one, for
example a build with NVENC support.

## Deploy with Docker behind Nginx Proxy Manager

On the server (Docker + Compose, a running Nginx Proxy Manager on a shared docker network):

```bash
git clone git@github.com:JawshTheDark/cliptube.git && cd cliptube
mkdir -p data
# Only if your proxy network is not called "proxy-net", or your uid/gid is not 1000:
# printf 'PROXY_NETWORK=my-proxy-net\nPUID=1000\nPGID=1000\n' > .env
docker compose up -d --build
```

The container publishes no host port. In Nginx Proxy Manager add a **Proxy Host**:

| Field                | Value                                   |
| -------------------- | --------------------------------------- |
| Domain               | `clips.example.com`                     |
| Scheme / Host / Port | `http` / `cliptube` / `3000`            |
| Block Common Exploits | on                                     |
| SSL                  | Request a new certificate, Force SSL, HTTP/2 |

and paste this in the **Advanced** tab so multi-gigabyte uploads are not cut off:

```nginx
client_max_body_size 0;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Then open the site, create the first (admin) account, set the **Public URL** in Admin so Discord previews
use the right address, and turn off "Allow new people to create accounts" once your friends have joined.

Update later with:

```bash
git pull && docker compose up -d --build
```

Or, from a checkout on another machine, deploy over SSH (backs up the database, tags the old image as
`cliptube:rollback`, rebuilds and waits for the health check):

```bash
scripts/deploy.sh user@your-server
```

## Admin command line

For server operators, without needing a web login (inside Docker prefix with `docker exec cliptube`):

```bash
node server/cli.js network status
node server/cli.js network hub-enable https://clips.example.com
node server/cli.js network join https://clips.irc.so
node server/cli.js network peer https://clips.friend.example
node server/cli.js network follow-blocklist https://clips.irc.so --mode auto
node server/cli.js network leave --keep-peers
node server/cli.js user list
node server/cli.js user role alice moderator
node server/cli.js user status spammer banned "posting spam"
```

Run `node server/cli.js` with no arguments for the full list.

## Development

```bash
npm run dev     # API on :3000, frontend with hot reload on :5173
npm test        # unit tests plus real multi-instance integration tests (under a minute)
```

Database changes go in `server/migrations.js` as a new numbered migration; the server applies pending
migrations at startup and writes a backup to `data/backups` first.

## Sharing outside your network without Docker

Any reverse proxy with HTTPS works (Caddy, nginx, Cloudflare Tunnel, Tailscale Funnel). Set
`TRUST_PROXY=1` so the app sees real client addresses and the HTTPS scheme, and raise the proxy's
request body limit for uploads.

## Hosting at home

Forward ports 80 and 443 on your router to the machine running ClipTube, point a (dynamic) DNS name at
your home IP (for example with ddclient), and put nginx or Caddy with a Let's Encrypt certificate in front.
Many home routers don't support "NAT loopback" (hairpin NAT): from inside your own network the public name
then won't connect, even though it works for everyone else. Turn on NAT loopback if your router has it,
add a hosts-file entry pointing the name at the machine's LAN address, or use the LAN address directly
(for example `http://192.168.1.97:3100`).
