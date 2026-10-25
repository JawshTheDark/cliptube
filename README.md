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
- **Network**: instances join one hub to browse and search each other's clips, with likes, comments and subscriptions across instances
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

## Network (one hub, many instances)

Each person runs their own instance and hosts their own clips. Every instance joins one **hub**, and the hub
shares an index of the whole network, so everyone's public clips show up in **Network**, on the home feed and
in search everywhere. Video files are never copied: viewers stream from the instance that hosts the clip.

People can like, comment on and subscribe to videos on other instances. The action is sent to the instance
hosting the video, signed by the sender's instance, so counts and comment threads are the same everywhere.
People from elsewhere appear as `name@their.host` and link back to their home instance.

**Running the hub** (Admin → Network → *This instance is the hub*):

| Setting | Default | What it does |
| --- | --- | --- |
| Accept new instances | on | Turn off to lock the network to its current members |
| Require my approval | off | New instances wait until the hub admin approves them |
| HTTPS only | on | Refuse instances not served over HTTPS |
| Comments / likes / subscriptions between instances | on | Network-wide switches for each kind of interaction |
| Include this instance's videos | on | Share the hub's own public clips with the network |
| Max videos per instance | 5000 | Cap on how many clips one instance can put in the index |
| Sync every | 10 min | How often the hub and members refresh (changes are also pushed within seconds) |
| Announcement | empty | Banner shown on the Network page of every instance |

Per instance, the hub admin can approve, suspend (temporarily drop from the network), ban (can't rejoin),
stop its likes and comments, hide its videos, or remove it. Any single network video can be hidden too.

**Joining** (Admin → Network → *Join network*): enter the hub's address (`https://clips.irc.so` by default).
The site needs a public HTTPS address set as its Public URL. Each instance can also:

- block any other instance, which hides its videos and refuses likes, comments and subscriptions from it;
- turn off accepting comments, likes or subscriptions from other instances;
- untick **Share with the network** on a public video to keep it local, or leave the network at any time.

Only public, ready videos with sharing on are ever listed. Networking refuses to contact private-network
addresses; to test several instances on one machine, start them with `--allow-private-federation`.

Protocol summary (v2, JSON over HTTPS): `GET /.well-known/cliptube` describes an instance and its Ed25519 key.
Members register with `POST /api/hub/join` and prove they own their address through a nonce callback to
`/api/network/verify`. The hub pulls each member's `/api/network/feed` and serves `/api/hub/index`,
`/api/hub/index/ids` and `/api/hub/directory` (members and their public keys). Interactions go to the target
instance's `/api/network/inbox`, signed with an `X-ClipTube-Signature` header.

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
node server/cli.js user list
node server/cli.js user role alice moderator
node server/cli.js user status spammer banned "posting spam"
```

Run `node server/cli.js` with no arguments for the full list.

## Development

```bash
npm run dev     # API on :3000, frontend with hot reload on :5173
npm test        # unit tests plus real multi-instance integration tests (about 10 seconds)
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
