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
- Keyboard shortcuts: `k` play/pause, `j`/`l` seek 10s, arrows seek 5s, `f` fullscreen, `t` theater, `m` mute, `0-9` jump

## Run it

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000. The first account you create becomes the admin.
The console also prints your LAN address so friends on your network can connect.

Development (hot reload, frontend on http://localhost:5173, API on 3000):

```bash
npm run dev
```

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
