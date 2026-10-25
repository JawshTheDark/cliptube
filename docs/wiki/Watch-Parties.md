# Watch Parties

Watch videos with friends at the same moment, with chat and reactions.

- [Starting one](#starting-one)
- [Watching together](#watching-together)
- [The queue](#the-queue)
- [Chat and reactions](#chat-and-reactions)
- [The host's controls](#the-hosts-controls)
- [Under the hood](#under-the-hood)

## Starting one

**Watch together** under any video (from this server or from the network) starts a party with that video. On a
playlist's page it starts one with the whole playlist. Hosting needs an account on the server.

**Invite** copies the party's link. Anyone with the link can join: people with an account here join as
themselves, and everyone else just picks a name, so friends from other servers (or without an account
anywhere) can come along.

## Watching together

- Everyone's player follows the party: play, pause, seeking, and which video is on.
- Players keep themselves in step with the server's clock. One that is more than a second off jumps back in;
  smaller drift is corrected by playing very slightly faster or slower, so everyone stays within a fraction of a
  second.
- If your browser blocks videos from starting on their own, click **Join the playback** once.
- By default only the host steers. Without control, pausing takes you out of step for yourself only, and **Back
  to the party** rejoins.
- When a video ends, the party moves on to the next one in the queue.

## The queue

Whoever can steer adds videos by pasting a link to a video on this server (or one from **Network**), or adds one
of their playlists, reorders the queue with the arrows, removes videos, and clicks one to play it right away.

## Chat and reactions

The chat sits beside the player; people who join later see the last 200 messages. The emoji under the player
float up over the video for everyone. Both are rate limited, and anyone can remove their own messages.

## The host's controls

The ⚙ menu (host only):

- **Everyone can steer** lets anyone in the party control playback and the queue.
- **Lock** keeps newcomers out; people who were already in can come back.
- **End the party** closes it for everyone.

The × next to someone's name removes them from the party for good. While the host is away, anyone in the party
can steer, so it never gets stuck. Parties nobody has used for a day end on their own, and one person can host up
to five at once.

## Under the hood

Players hear about changes through server-sent events, which pass through reverse proxies (Nginx Proxy Manager
included) without any WebSocket settings. The server keeps the playback state as the video, whether it's playing,
the position, and the server time when that was true. Each browser works out how far its clock is from the
server's from a few quick round trips, and positions the video from that.

For apps, the API is under `/api/parties`: `POST /api/parties` starts one, `GET /api/parties/<id>/events` is the
event stream (guests pass their token as `?member=`), and `POST /api/parties/<id>/control`, `/chat`, `/react` and
`/queue` act in it.
