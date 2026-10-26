# Webhooks

A webhook tells a bot, a bridge or a chat channel when you post. Set yours up in **Settings → Webhooks**; each
person has their own, for their own videos and streams.

- [Events](#events)
- [Formats](#formats)
- [What a JSON delivery looks like](#what-a-json-delivery-looks-like)
- [Checking the signature](#checking-the-signature)
- [Deliveries, retries and limits](#deliveries-retries-and-limits)

## Events

| Event | When |
| --- | --- |
| `video.published` | You publish a video: public and done processing (a draft when you save its details). Once per video. |
| `live.started` | You start a public [live stream](Live-Streaming.md) |

## Formats

- **JSON** sends the whole event (below), for bots and bridges.
- **Discord** sends a message to a Discord webhook (*Channel settings → Integrations → Webhooks*): who posted
  what, and the link, which Discord then shows with its preview and player.
- **Slack** sends the same message to a Slack incoming webhook, or to Mattermost.

**Test** sends a test right away and shows what the other end answered.

## What a JSON delivery looks like

```json
{
  "event": "video.published",
  "delivery": "kq3T0v9xW2c",
  "sent_at": "2026-10-25T23:15:45.011Z",
  "site": { "name": "Brad's Vidya", "url": "https://video.bradroot.me" },
  "video": {
    "id": "nVei-xmEYFI",
    "title": "Doggos excited to walk",
    "description": "",
    "url": "https://video.bradroot.me/watch/nVei-xmEYFI",
    "thumbnail_url": "https://video.bradroot.me/media/thumbs/nVei-xmEYFI.jpg",
    "video_url": "https://video.bradroot.me/media/videos/nVei-xmEYFI.mp4",
    "duration": 21.5,
    "width": 1080,
    "height": 1920,
    "game": { "id": "umamusume-pretty-derby", "name": "Umamusume: Pretty Derby" },
    "tags": ["dogs"],
    "published_at": "2026-10-25T22:01:00.000Z",
    "channel": { "username": "amiantos", "display_name": "amiantos", "url": "https://video.bradroot.me/c/amiantos", "avatar_url": null }
  }
}
```

`live.started` has a `stream` instead: `id`, `title`, `description`, `url` (the live page), `game`, `started_at`
and `channel`. A test delivery has `"event": "test"`, with your latest public video when you have one. Each
request carries the `X-ClipTube-Event` and `X-ClipTube-Delivery` headers and a `User-Agent` starting with
`ClipTube/`. The links are complete when the site's admin has set its Public URL.

## Checking the signature

With a **secret**, `X-ClipTube-Signature` is `sha256=` followed by the HMAC-SHA256 of the raw body with the secret,
so the other end can check that the request came from this site:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-cliptube-signature'] || ''));
```

The secret is never shown again after you save it; leave it out when editing to keep it.

## Deliveries, retries and limits

- A delivery that doesn't get a `2xx` answer within 10 seconds is tried again, up to five times, a little later
  each time. Your list shows how the last one went.
- Up to 10 webhooks each, and 10 tests every 10 minutes.
- Webhooks can't reach the server's own network (localhost, the LAN, its other containers, cloud metadata
  addresses): the address is checked when you save it, and the address actually connected to on every delivery.
  An admin's webhooks may, for bots running next to the site.
