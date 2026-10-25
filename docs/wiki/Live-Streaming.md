# Live Streaming

Stream from OBS (or any app that streams over RTMP or SRT) to your channel, with a live chat, and keep the
stream as a video afterwards.

- [Going live](#going-live)
- [Watching and chatting](#watching-and-chatting)
- [After the stream](#after-the-stream)
- [Turning it on (admins)](#turning-it-on-admins)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

## Going live

1. Open **Settings → Live streaming**. It shows a **Server** and a **Stream key**.
2. In OBS: **Settings → Stream**, service **Custom**, paste the server (for example `rtmp://clips.example.com/live`)
   and the stream key, then **Start Streaming**.
3. Your stream plays at `/live/<your name>`, and your subscribers get a notification.

The key is like a password: anyone who has it can stream as you. **New key** makes a fresh one (update OBS
afterwards).

The same section sets the stream's **title**, **description** and **game**, who can watch (**public**: on Home,
in the network, and your subscribers are told; or **unlisted**: only people with the link), and whether to **keep
each stream as a draft video**. Changes reach a stream that is on right now too.

OBS settings that work well: H.264 (x264 or NVENC), AAC audio, a keyframe interval of 1 or 2 seconds, and a
bitrate your upload can carry (about 6000 kbps for 1080p60, 3500 kbps for 720p). The stream is passed to viewers
as it is, without re-encoding, so the quality you send is the quality they get.

SRT works too, when the admin has set an SRT address: Settings shows the full `srt://` address with your key in it.

## Watching and chatting

- **Live now** at the top of Home lists the streams on this server and on the rest of the network.
- A channel that is live shows a **LIVE** banner on its page.
- The live page plays the stream about two to four seconds behind real time (low-latency HLS). It shows the
  number of people watching.
- **Chat:** people with an account here chat as themselves, and anyone else picks a name. Reactions float over
  the video. The streamer and the site's moderators can remove messages and remove people from the chat.

## After the stream

When the stream stops (or its connection drops for more than 45 seconds), it ends. If you chose to keep it, the
recording becomes a **draft video** in Studio: trim it in the editor, give it a title, and **Save and publish**
like any upload. Otherwise the recording is deleted.

A connection that drops and comes back within those 45 seconds continues the same stream.

## Turning it on (admins)

Live streaming runs a second container, [MediaMTX](https://github.com/bluenviron/mediamtx), next to ClipTube.
It is off until you turn it on:

1. Add these lines to `.env` next to `docker-compose.yml` (pick your own long random secret):

   ```bash
   COMPOSE_PROFILES=live
   LIVE_SERVER=cliptube-live
   LIVE_SECRET=change-me-to-a-long-random-string
   ```

   `LIVE_RTMP_URL` sets the address shown to streamers if it isn't `rtmp://<your public host>/live`.

2. Make sure `data/live` exists and belongs to the container user (ClipTube creates it at startup, so this
   normally is already the case).
3. `docker compose up -d`. The `cliptube-live` container starts next to ClipTube.
4. Let streamers reach **TCP port 1935** (RTMP): the `cliptube-live` container listens on that port of the host
   itself. Open it in the firewall, or forward it on your router for a server at home. SRT is optional: UDP port
   8890, with `LIVE_SRT_URL=srt://your.site:8890`.

Viewers need nothing extra: the stream reaches them through ClipTube's own address (`/live/hls/...`), so the
reverse proxy you already have is enough.

**What it costs:** almost no CPU, since nothing is re-encoded. Bandwidth adds up: every viewer pulls the stream
from your server, so a 6 Mbps stream with ten viewers needs about 60 Mbps of upload. Recordings take disk space
while a stream runs (about 2.7 GB per hour at 6 Mbps) until they are saved as a video or deleted.

## How it works

- MediaMTX asks ClipTube about every connection (`/api/live/auth`, with the shared secret). A stream to
  `live/<name>` is accepted only with that channel's key; reading is allowed only to ClipTube itself, so the HLS
  can only be watched through ClipTube.
- ClipTube asks MediaMTX's control API which streams are coming in, to notice when one ends.
- MediaMTX records every stream as fragmented MP4; when the stream ends, ClipTube joins the pieces and hands them
  to the normal upload pipeline (an OBS stream is H.264, so it is ready in seconds).
- Viewers follow the chat and the viewer count over server-sent events, like watch parties.
- Other ClipTube servers in the network read `GET /api/live/now` to show your streams in their **Live now**.
  Fediverse followers get a post with a link when a public stream starts.

`scripts/live-sandbox.sh <ssh-host>` runs all of this with the real MediaMTX in a private Docker sandbox: it
streams a test picture with ffmpeg and checks the stream, the HLS and the saved recording.

## Troubleshooting

**OBS says it can't connect.** Port 1935 isn't reachable: check the firewall and the router's port forward. From
another network, `nc -vz your.site 1935` should connect.

**OBS connects and is disconnected at once.** The stream key is wrong (copy it again from Settings, or make a
new one), or the server URL and key are swapped.

**The live page says the channel isn't live, but OBS is streaming.** Check `docker logs cliptube-live` for
"authentication failed", and that `LIVE_SECRET` in `.env` is the same for both containers (they both read it
from there).

**No recording was saved.** "Keep each stream" was off, or `data/live` isn't writable by the container user:
`docker logs cliptube-live` shows the error.
