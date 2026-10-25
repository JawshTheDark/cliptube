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
- **Opt-in federation**: follow friends' ClipTube instances to browse and search their clips here while they keep hosting them
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

## Federation (opt-in)

Each person runs their own instance and hosts their own clips. Instances that follow each other show each
other's public clips in **Network**, on the home feed and in search. The video files are never copied:
viewers stream straight from the instance that hosts the clip, and views count there.

1. Admin → **Federation** → tick **Take part in federation**. It is off by default; while off the instance
   is invisible to others and contacts nobody.
2. Choose who may follow you: **only instances you approve** (default) or **any instance**.
3. To see a friend's clips, enter their address (e.g. `clips.example.com`) under **Follow an instance**.
   Their admin approves you under **Followers**, and they can **Follow back** with one click.
4. Clips sync every 10 minutes (or press sync). Making a clip private or unlisted, unticking
   **Share with followed instances** on it, or blocking a follower removes it from the other side on the
   next sync.

Only public, ready videos with sharing on are ever listed. Both instances need to be reachable over HTTPS
for visitors to play each other's clips. Federation refuses to contact private-network addresses; to test
two instances on one machine, start both with `--allow-private-federation`.

Protocol summary (v1, JSON over HTTPS): `GET /.well-known/cliptube` describes an instance;
`POST /api/federation/follow` starts a follow, which the target confirms by calling back the follower's
`/api/federation/verify`; approved followers get a bearer token for `GET /api/federation/videos`
(incremental by `updated_since`), `GET /api/federation/ids` (for pruning) and `GET /api/federation/status`.

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

## Sharing outside your network without Docker

Any reverse proxy with HTTPS works (Caddy, nginx, Cloudflare Tunnel, Tailscale Funnel). Set
`TRUST_PROXY=1` so the app sees real client addresses and the HTTPS scheme, and raise the proxy's
request body limit for uploads.
