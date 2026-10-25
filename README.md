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

## Sharing outside your network

Put it behind a reverse proxy with HTTPS (Caddy, nginx, Cloudflare Tunnel, Tailscale Funnel) and set
the Public URL in Admin so link previews point to the right address. Turn off "Allow new people to
create accounts" once your friends have signed up.
