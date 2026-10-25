# Installation

ClipTube runs wherever Docker or Node.js runs. This page takes you from nothing to a working site; the
settings you can change afterwards are in [Configuration](Configuration.md).

- [What you need](#what-you-need)
- [Docker behind a reverse proxy (recommended)](#docker-behind-a-reverse-proxy-recommended)
  - [Nginx Proxy Manager](#nginx-proxy-manager)
  - [Caddy](#caddy)
  - [nginx with Let's Encrypt](#nginx-with-lets-encrypt)
  - [Tunnels](#tunnels)
- [Docker on its own](#docker-on-its-own)
- [Without Docker](#without-docker)
- [First run](#first-run)
- [Joining the network](#joining-the-network)
- [Hosting at home](#hosting-at-home)
- [GPU encoding](#gpu-encoding)
- [Checking that it works](#checking-that-it-works)

## What you need

| | |
| --- | --- |
| **Machine** | A 64-bit x86 server, VM or PC. The Docker image is built for x86-64; Node.js runs anywhere Node does. |
| **Software** | Docker Engine with Compose v2, or Node.js 22.13 or newer. FFmpeg comes bundled. |
| **Disk** | Room for your clips. An edited video keeps its first version as the editing source (about twice the space), and adaptive streaming adds a few renditions per video. |
| **CPU** | Transcoding is the only heavy work, and H.264 recordings skip it (they are remuxed in seconds). A GPU encoder helps with the rest. |
| **Network** | For anything beyond your LAN: a domain name and HTTPS. Linking with other servers and the fediverse needs a public `https://` address. |

## Docker behind a reverse proxy (recommended)

This is how clips.irc.so runs: ClipTube in a container with no published port, and a reverse proxy on the same
Docker network that handles HTTPS.

**1. Get the code and make the data folder**

```bash
git clone https://github.com/JawshTheDark/cliptube.git
cd cliptube
mkdir -p data
```

**2. Make sure the proxy network exists**

The compose file joins an external Docker network called `proxy-net`, which your reverse proxy should be on too:

```bash
docker network create proxy-net
docker network connect proxy-net <your-proxy-container>    # if the proxy isn't on it yet
```

If your proxy already uses a network with another name, or your user isn't uid/gid 1000, put that in `.env`
next to `docker-compose.yml`:

```bash
printf 'PROXY_NETWORK=my-proxy-net\nPUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" > .env
```

The container runs as `PUID:PGID` and writes to `./data`, so that folder must belong to the same user
(`sudo chown -R 1000:1000 data` if it doesn't).

**3. Build and start**

```bash
docker compose up -d --build
```

**4. Note the setup code**

```bash
docker logs cliptube 2>&1 | grep -i "setup code"
```

**5. Point your reverse proxy at `cliptube:3000`** (below), then continue with [First run](#first-run).

Whatever proxy you use, it has to let large uploads through: no request body limit (or one larger than your
biggest clip), no request buffering, and timeouts long enough for a slow upload.

### Nginx Proxy Manager

Add a **Proxy Host**:

| Field | Value |
| --- | --- |
| Domain Names | `clips.example.com` |
| Scheme | `http` |
| Forward Hostname / IP | `cliptube` |
| Forward Port | `3000` |
| Block Common Exploits | on |
| SSL | Request a new certificate, Force SSL, HTTP/2 Support |

Paste this in the **Advanced** tab so multi-gigabyte uploads aren't cut off:

```nginx
client_max_body_size 0;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

> [!NOTE]
> If Nginx Proxy Manager is **not** on the same Docker network as ClipTube, publish a port
> ([Docker on its own](#docker-on-its-own)) and forward to the host's LAN address, for example
> `192.168.1.10:3100`. Don't use `127.0.0.1`: inside the proxy's container, that is the proxy itself.

### Caddy

With Caddy in a container on `proxy-net`:

```caddyfile
clips.example.com {
	reverse_proxy cliptube:3000
}
```

Caddy gets and renews the certificate itself and doesn't limit upload size by default. If Caddy runs on the
host instead, publish a port and use `reverse_proxy localhost:3000`.

### nginx with Let's Encrypt

For nginx installed on the host (this is how clips.quitlyingto.us runs). Publish a port first
([Docker on its own](#docker-on-its-own)); the example uses `3100`. Then create
`/etc/nginx/sites-available/clips.example.com`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name clips.example.com;

    client_max_body_size 0;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable it and let Certbot add HTTPS and the redirect from HTTP:

```bash
sudo ln -s /etc/nginx/sites-available/clips.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d clips.example.com
```

### Tunnels

Cloudflare Tunnel and Tailscale Funnel work too, as long as they pass large requests. Cloudflare's proxy
limits a request body to 100 MB on its free plan, which caps the size of a single upload.

## Docker on its own

For trying ClipTube out on your LAN, or for a reverse proxy outside Docker, publish a port with a
`docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  cliptube:
    ports:
      - "3000:3000"    # or "3100:3000" if 3000 is taken
```

The compose file still expects the `proxy-net` network, so create it once (`docker network create proxy-net`),
then start as before:

```bash
docker compose up -d --build
```

Open `http://<server-address>:3000`. Without HTTPS everything works on the LAN except linking with other
servers, the fediverse and web push, which need a public `https://` address.

## Without Docker

You need Node.js 22.13 or newer (24 recommended) and git. Linux, macOS and Windows all work.

```bash
git clone https://github.com/JawshTheDark/cliptube.git
cd cliptube
npm install        # also downloads FFmpeg for your platform
npm run build      # builds the web app into web/dist
npm start          # serves it on http://localhost:3000
```

Data goes to `./data` unless you set `DATA_DIR`. Behind a reverse proxy, set `TRUST_PROXY=1`. The server
prints its LAN address at startup so friends on your network can connect.

To keep it running on Linux, a systemd unit such as `/etc/systemd/system/cliptube.service`:

```ini
[Unit]
Description=ClipTube
After=network-online.target
Wants=network-online.target

[Service]
User=cliptube
WorkingDirectory=/opt/cliptube
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/cliptube
Environment=TRUST_PROXY=1
ExecStart=/usr/bin/node server/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cliptube
journalctl -u cliptube -f      # the setup code is printed here
```

## First run

1. **Find the setup code.** While no account exists, the server prints:

   ```text
   No accounts exist yet. Create the first (admin) account at /register using setup code: 1a2b3c4d
   ```

   It's in `docker logs cliptube` (or the console). To choose it yourself, set `SETUP_CODE` in the
   environment. The code stops a stranger from claiming the admin account of a freshly started public server.

2. **Create the first account** at `/register` with that code. It becomes the admin.

3. **Admin → Overview:**
   - **Site name.**
   - **Public URL**: the `https://` address people use. Links, Discord previews, feeds, emails and the network
     all use it.
   - **Sign-up**: open, approval, invite-only or closed. Invite-only is a good start for a friends' server.
   - **Upload limit** (8 GB by default), **maximum resolution** (1080p by default) and the **encoder**.

4. **Optional extras:**
   - **Email** (Admin → Overview → *Email*) for address confirmations, password resets and notification emails.
   - **Adaptive streaming** (Admin → Overview) for viewers on slow connections.
   - **Game artwork**: a SteamGridDB API key under Admin → Games. On a server that joins a network, the hub's
     catalog brings its artwork, so this is only needed on the hub or a server on its own.
   - **The network** (below).

## Joining the network

Set the Public URL to the server's `https://` address first, and make sure it can be reached from the
internet. Then either:

- **Admin → Network → Join network**, and enter `https://clips.irc.so` (or the address of any server already
  in the network), or
- from the command line:

  ```bash
  docker exec cliptube node server/cli.js network join https://clips.irc.so
  ```

Within a sync round the hub's games appear under Admin → Games, and other servers' clips appear under
**Network**, on Home and in search. How the network works and what you can control: [Network](Network.md).

## Hosting at home

1. **Forward ports 80 and 443** on your router to the machine running ClipTube (or its reverse proxy).
2. **Give it a name.** Point a domain or subdomain at your home IP. If your IP changes, keep the record
   current with dynamic DNS, for example ddclient with your registrar's DDNS protocol.
3. **Get a certificate** with your reverse proxy (Nginx Proxy Manager, Caddy, or nginx with Certbot).
4. **Expect hairpin NAT trouble.** Many home routers don't support NAT loopback: from inside your own network
   the public name won't connect even though it works for everyone else. Turn on NAT loopback if your router
   has it, add a hosts-file entry pointing the name at the machine's LAN address, or use the LAN address
   directly (for example `http://192.168.1.10:3100`). For the same reason, your own clips can look broken to
   you when you view them through another server in the network.

## GPU encoding

Pick the encoder in **Admin → Overview**:

| Encoder | Hardware |
| --- | --- |
| `libx264` | CPU (default, works everywhere) |
| `h264_nvenc` | NVIDIA |
| `h264_qsv` | Intel Quick Sync |
| `h264_amf` | AMD (Windows) |

If a hardware encoder fails, ClipTube encodes that video on the CPU instead and logs
`encoder h264_nvenc failed, falling back to libx264`. H.264 uploads are remuxed rather than encoded, so the
GPU matters for other formats, edits, clips and adaptive-streaming renditions.

In Docker, the container needs access to the GPU, and FFmpeg needs the encoder built in. First check what the
bundled FFmpeg offers:

```bash
docker exec cliptube node_modules/ffmpeg-static/ffmpeg -hide_banner -encoders | grep h264
```

If your encoder isn't listed, mount an FFmpeg build that has it and point `FFMPEG_PATH` and `FFPROBE_PATH` at
it. Then give the container the GPU in `docker-compose.override.yml`:

```yaml
# NVIDIA (needs the NVIDIA Container Toolkit on the host)
services:
  cliptube:
    environment:
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

```yaml
# Intel Quick Sync
services:
  cliptube:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "993"    # the gid of the host's render group: getent group render
```

## Checking that it works

```bash
docker ps --filter name=cliptube                   # STATUS should say (healthy)
curl -s https://clips.example.com/api/site         # basic site info as JSON, including the site name
curl -s https://clips.example.com/nodeinfo/2.0     # the version, for the fediverse
```

Then upload a short clip: an H.264 recording should be ready within seconds. If something is off, see
[Troubleshooting](Troubleshooting.md).
