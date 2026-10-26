# Troubleshooting

Admins can start with **Admin → Debugging**: the version and whether a newer one is out, FFmpeg and the GPU
encoders in its build, disk use per folder and free space, the database, the job queue with recent failures,
the network and ActivityPub, whether the live streaming server answers, and the server's recent warnings and
errors. *Copy the whole report* puts all of it on the clipboard for whoever is helping; no passwords or keys
are in it.

Then the log. Lines are tagged by area (`[media]`, `[network]`, `[games]`, `[db]` and so on):

```bash
docker logs cliptube --tail 200 -f
```

- [Installing and starting](#installing-and-starting)
- [Uploads](#uploads)
- [Reaching the site](#reaching-the-site)
- [The network](#the-network)
- [The fediverse](#the-fediverse)
- [Email and notifications](#email-and-notifications)
- [Game artwork](#game-artwork)
- [Deploying](#deploying)

## Installing and starting

**`network proxy-net declared as external, but could not be found`**
The compose file joins your reverse proxy's Docker network. Create it (`docker network create proxy-net`), or
set `PROXY_NETWORK=<name>` in `.env` if your proxy uses another network.

**The container keeps restarting, or the log shows `EACCES` / permission denied**
`./data` must belong to the user the container runs as (1000:1000 unless you set `PUID`/`PGID` in `.env`):
`sudo chown -R 1000:1000 data`.

**Lost the setup code**
It is printed at every start while no account exists:
`docker logs cliptube 2>&1 | grep -i "setup code"`. To choose your own, set `SETUP_CODE` in the environment and
restart.

**Port 3000 is already taken**
Publish another host port in `docker-compose.override.yml` (`"3100:3000"`) and point your proxy at it, or set
`PORT` when running with Node.js.

## Uploads

**Uploads fail right away with `413 Request Entity Too Large`**
The reverse proxy limits request size (nginx allows 1 MB by default). Add `client_max_body_size 0;` (in Nginx
Proxy Manager: the proxy host's *Advanced* tab). See [Installation](Installation.md#nginx-proxy-manager).

**Large uploads stop partway**
The upload page sends files in 32 MB pieces and carries on by itself after a dropped connection; when it gives
up, **Try again** resumes it (unfinished uploads are kept for a day). If pieces keep failing, raise the proxy's
timeouts: `proxy_read_timeout 3600s; proxy_send_timeout 3600s;`. Pieces get through Cloudflare's 100 MB limit;
a single-request upload over the API doesn't. Also check the site's own limit in Admin → Overview, and the
uploader's storage quota.

**Every upload fails with "ffprobe was not found on this server"**
Older versions said `spawn /app/node_modules/ffprobe-static/bin/linux/arm64/ffprobe ENOENT`. The server runs on
ARM, where the bundled ffprobe has no build. Update to v1.9.1 or newer and rebuild (`git pull`, then
`docker compose up -d --build`): the image then adds Debian's FFmpeg. Without Docker, install FFmpeg
(`sudo apt install ffmpeg`). The startup log shows the same message when FFmpeg can't run.

**A video is stuck at "Processing" or failed**
Look for its `[media]` lines in the log. Common causes: the disk is full, or the file isn't really a video. A
GPU encoder that fails falls back to the CPU on its own (`falling back to libx264`), which is slower but works.

**The GPU isn't used**
See [GPU encoding](Installation.md#gpu-encoding): the container needs the device, and FFmpeg needs the encoder.
H.264 uploads are remuxed rather than encoded, so they never touch the GPU.

## Reaching the site

**`502 Bad Gateway` from Nginx Proxy Manager**
The proxy can't reach OurTube. If both are on the same Docker network, forward to `cliptube` port `3000`. If
not, publish a port and forward to the host's **LAN address** (for example `192.168.1.10:3100`), not
`127.0.0.1`, which inside the proxy's container is the proxy itself. Check that OurTube is healthy with
`docker ps`.

**The site works for everyone except me at home**
Your router doesn't support NAT loopback (hairpin NAT). Turn it on if the router has it, add a hosts-file entry
pointing the name at the server's LAN address, or use the LAN address. See
[Hosting at home](Installation.md#hosting-at-home).

**Link previews in Discord show the wrong address, or none**
Set the **Public URL** in Admin → Overview to the site's `https://` address.

**Every visitor seems to come from the same address**
Behind a reverse proxy, `TRUST_PROXY=1` must be set (the Docker image sets it), and the proxy must send
`X-Forwarded-For` and `X-Forwarded-Proto`. Without them the app sees the proxy as the only visitor and plain
HTTP as the scheme.

## The network

**Joining fails**
- The Public URL must be `https://` and reachable from the internet. Test it from outside your network, for
  example with `curl https://your.site/.well-known/cliptube` on a phone's connection.
- The hub may be locked down (not accepting new servers), may require approval (your server waits as
  *pending*), or may only accept HTTPS.
- `docker exec cliptube node server/cli.js network status` shows each peer's state and its last error.

**Other servers' clips don't show up**
Run `network sync` and look at the peers' states in Admin → Network. A clip only travels if it is public, ready
and has *Share with the network* ticked on its server, and a blocked server's clips are hidden. Failing peers are
retried with a growing delay, up to six hours apart.

**Testing two servers on one machine**
The network refuses private addresses. Start both with `--allow-private-federation`. See
[Network](Network.md#testing-several-servers-on-one-machine).

## The fediverse

**Mastodon can't find a channel**
Search for the full handle, `@name_channel@your.site`. ActivityPub must be on (Admin → Network → *Fediverse*)
and the Public URL set to `https://`. Check that `https://your.site/.well-known/webfinger?resource=acct:name_channel@your.site`
answers from outside your network.

**Followers on Mastodon don't see a video**
Only public videos go out, after their details are saved (drafts never do). Mastodon may also only show videos
up to a certain size; the 720p copy (Admin → Overview) is meant for that.

## Email and notifications

**No emails arrive**
Use the test button in Admin → Overview → *Email*. Port 587 usually needs *STARTTLS*, port 465 *TLS*. Check the
spam folder, and that the *From* address belongs to a domain the SMTP server may send for.

**Web push doesn't work**
Push needs HTTPS (or `localhost`), and the browser has to allow notifications for the site. Each device turns it
on separately in Settings → *Notifications*.

## Game artwork

**"Add a SteamGridDB API key first"**
Save a key in Admin → Games (or with `settings set-secret steamgriddb_api_key`). On a member of a network you
usually don't need one: the hub's games bring their artwork.

**"SteamGridDB refused the API key"**
The key is wrong or was revoked. Copy it again from SteamGridDB (Preferences, API) and save it.

**The wrong game's artwork**
Open the game's **Artwork** picker in Admin → Games, search for the right game, and pick its images.

**"The hub keeps this game up to date"**
Games from the hub's catalog are changed on the hub, not on members.

## Deploying

**`Permission denied (publickey)`**
`scripts/deploy.sh` uses SSH in batch mode, so the server must accept your SSH key without a password prompt.

**`kex_exchange_identification: ... Connection reset` or `connection abort`**
Many SSH connections in a short time can trip the server's connection limits (sshd's `MaxStartups`, fail2ban).
Wait a minute and run the deploy again, one server at a time.

**The health check never turns healthy**
`docker logs cliptube --tail 100` shows why. To go back to the previous version, see
[Rolling back](Upgrading-and-Backups.md#rolling-back).
