# Configuration

Almost everything is set in the **Admin** pages and takes effect immediately. The few things the server
needs before it starts are environment variables.

- [Environment variables](#environment-variables)
- [Admin → Overview](#admin--overview)
- [Admin → Moderation](#admin--moderation)
- [Admin → Games](#admin--games)
- [Admin → Legal](#admin--legal)
- [Admin → Network](#admin--network)
- [Passwords and API keys](#passwords-and-api-keys)
- [Settings from the command line](#settings-from-the-command-line)
- [The data folder](#the-data-folder)

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (`--port N` on the command line wins) |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where everything is stored, see [The data folder](#the-data-folder) |
| `TRUST_PROXY` | unset (`1` in Docker) | `1` behind a reverse proxy, so the app sees real client addresses and HTTPS |
| `SETUP_CODE` | random | The code needed to create the first (admin) account |
| `FFMPEG_PATH`, `FFPROBE_PATH` | bundled | Use another FFmpeg, for example one built with your GPU's encoder |
| `LOG_REQUESTS` | unset | `1` prints every request (same as `--log`) |
| `FEDERATION_ALLOW_PRIVATE` | unset | `1` lets the network contact LAN and localhost addresses (same as `--allow-private-federation`). Only for testing several servers on one machine. |

With Docker, put these under `environment:` in a `docker-compose.override.yml`. The compose file itself reads
`PUID`, `PGID` (the user the container runs as, default 1000) and `PROXY_NETWORK` (default `proxy-net`) from
`.env`.

## Admin → Overview

| Setting | Key | Default | Notes |
| --- | --- | --- | --- |
| Site name | `site_name` | ClipTube | Shown in the header, link previews and emails |
| Public URL | `public_url` | empty | The `https://` address people use. Needed for link previews, feeds, emails, the network and the fediverse. |
| Sign-up | `registration_mode` | open | `open`, `approval`, `invite` or `closed`. See [Moderation and Legal](Moderation-and-Legal.md#sign-up). |
| Upload limit | `max_upload_mb` | 8192 MB | Per file. Your reverse proxy must allow at least this much. |
| Default storage quota | `default_quota_mb` | 0 (no limit) | Per person; the users table has per-person overrides |
| Maximum resolution | `max_height` | 1080 | Taller videos are scaled down to this height |
| Encoder | `encoder` | `libx264` | `h264_nvenc`, `h264_qsv` or `h264_amf` for a GPU, see [GPU encoding](Installation.md#gpu-encoding) |
| Delete originals | `delete_originals` | off | Whether to delete the uploaded file after a transcode (see below) |
| Adaptive streaming (HLS) | `hls_ladder` | off | `off`, `720` (720p plus source) or `full` (1080p, 720p and 480p plus source) |
| 720p copy for other platforms | `federation_rendition` | on | A small MP4 for services like Mastodon that only cache small remote videos |
| Show dislikes | `show_dislikes` | on | Uploaders always see their own |

**When is an upload transcoded?** An upload is remuxed (copied into an MP4 without re-encoding, in seconds and
with no quality loss) when it is H.264 video in yuv420p with AAC or MP3 audio, no taller than the maximum
resolution. Anything else is transcoded to H.264 and AAC. A remuxed upload's file is deleted afterwards, since
the MP4 holds the same data; a transcoded upload's file is kept in `originals/` unless *Delete originals* is on.

### Email

Optional. With email, people can confirm an address, reset a forgotten password and get the notification
emails they choose. Admin → Overview → *Email* has a test button.

| Setting | Key | Default |
| --- | --- | --- |
| SMTP server | `smtp_host` | empty (email off) |
| Port | `smtp_port` | 587 |
| Security | `smtp_secure` | `starttls` (or `tls`, or `none` for a local relay) |
| User name | `smtp_user` | empty |
| Password | `smtp_password` | write-only, see [Passwords and API keys](#passwords-and-api-keys) |
| From address | `smtp_from` | empty |

Web push notifications need no setup: the server makes its own keys on first start.

## Admin → Moderation

The report queue, held comments and the audit log live here, along with the spam settings:

| Setting | Key | Default |
| --- | --- | --- |
| Hold a person's first comments for review | `spam_hold_first_comments` | on |
| An account counts as new for | `spam_new_account_hours` | 24 hours |
| Hold links from new accounts | `spam_hold_links_new_accounts` | on |
| Hold names that imitate the uploader | `spam_check_impersonation` | on |
| Comments per 10 minutes | `spam_rate_per_10min` | 20 |
| Comments per 10 minutes for new accounts | `spam_rate_new_per_10min` | 5 |

## Admin → Games

The game catalog, and game artwork from SteamGridDB:

| Setting | Key | Default |
| --- | --- | --- |
| SteamGridDB API key | `steamgriddb_api_key` | empty; write-only |
| Fill in artwork for new games | `steamgriddb_auto` | on |

Get a key from a free SteamGridDB account (its Preferences, API). On a server in a network, the hub's catalog
brings its own artwork, so the key is only needed on the hub. More in
[Clip Tools and Games](Clip-Tools-and-Games.md#game-artwork-from-steamgriddb).

## Admin → Legal

Admins only. Your rules, terms and contacts appear on `/legal`.

| Setting | Key | Default |
| --- | --- | --- |
| Contact email | `legal_contact_email` | empty |
| DMCA designated agent | `legal_dmca_agent` | empty |
| Rules | `legal_rules` | empty |
| Terms (accepted at sign-up when set) | `legal_terms` | empty |
| Public transparency page (`/transparency`) | `legal_transparency_public` | on |
| Keep removed videos' files for | `removed_retention_days` | 30 days |
| Strikes that suspend an account | `strike_threshold` | 3 |
| Strikes expire after | `strike_expiry_days` | 365 days |
| Give a strike with each takedown | `strike_on_takedown` | on |

## Admin → Network

Joining or leaving a network, direct peers, who may peer with you, block lists, hub mode and the fediverse.
All of it is described in [Network](Network.md) and [Fediverse](Fediverse.md). The main switches:

| Setting | Key | Default |
| --- | --- | --- |
| Hub to join | `network_hub_url` | `https://clips.irc.so` |
| Accept new servers (off = lockdown) | `network_accept_new` | on |
| Ask me before a new server peers | `network_require_approval` | off |
| HTTPS only | `network_require_https` | on |
| Most peers | `network_max_peers` | 200 |
| Publish my block list | `network_publish_blocklist` | on |
| Accept comments, likes, subscriptions from other servers | `network_accept_comments`, `network_accept_likes`, `network_accept_subscriptions` | on |
| ActivityPub (the fediverse) | `activitypub_enabled` | on |

## Passwords and API keys

The SMTP password and the SteamGridDB API key are **write-only**: the Admin pages can set or clear them but
never show them again. From the command line, `settings set-secret` reads the value from standard input, so it
stays out of the command line and your shell history:

```bash
docker exec -i cliptube node server/cli.js settings set-secret steamgriddb_api_key < keyfile
docker exec -i cliptube node server/cli.js settings set-secret smtp_password < passwordfile
```

## Settings from the command line

Any setting can be read or changed by its key:

```bash
docker exec cliptube node server/cli.js settings get hls_ladder
docker exec cliptube node server/cli.js settings set hls_ladder full
```

The Admin pages check values before saving them, and some changes start background work (switching adaptive
streaming rebuilds the videos, for example), so prefer the Admin pages for anything but a quick fix.

## The data folder

Everything ClipTube stores is in one folder (`./data`, or `/data` in the container):

```text
data/
├── cliptube.db      SQLite database: accounts, videos, comments, settings and the server's keys
├── videos/          the MP4s viewers watch (and the first version of edited videos)
├── originals/       uploaded files kept after a transcode
├── thumbs/          thumbnails and game artwork
├── avatars/         profile pictures
├── captions/        caption files
├── hls/             adaptive streaming segments
├── renditions/      720p copies for other platforms
├── editor/          filmstrips and waveforms for the timeline editor
├── exports/         GIF and MP4 exports (kept for a day)
├── backups/         database copies made before migrations and deploys
└── tmp/             uploads in progress
```

**Back up the whole folder and you have everything**, including the keys that identify your server to the
network and the fediverse. How to back up a running server: [Upgrading and Backups](Upgrading-and-Backups.md).
