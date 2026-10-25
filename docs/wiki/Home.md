# ClipTube Wiki

<img src="../images/game.jpg" alt="A ClipTube game page with SteamGridDB artwork" width="100%">

**ClipTube** is a self-hosted, YouTube-style video site for gaming clips. Each friend runs their own server
and hosts their own clips; the servers link up into one network with [clips.irc.so](https://clips.irc.so) as
its hub, and Mastodon and PeerTube can follow along.

## Start here

| I want to… | Read |
| --- | --- |
| Set up a server | [Installation](Installation.md) |
| Change how my server works | [Configuration](Configuration.md) |
| Update, back up or move a server | [Upgrading and Backups](Upgrading-and-Backups.md) |
| Link my server with my friends' | [Network](Network.md) |
| Use ClipTube on my phone | [Android App](Android-App.md) |
| Fix something | [Troubleshooting](Troubleshooting.md) |

## Using ClipTube

- [Uploading and Editing](Uploading-and-Editing.md): uploads, drafts, processing, the timeline editor,
  captions and skippable parts
- [Watching and Discovery](Watching-and-Discovery.md): the player, adaptive streaming, Home, search, feeds,
  notifications, analytics and privacy
- [Clip Tools and Games](Clip-Tools-and-Games.md): clipping, GIF and MP4 exports, looping links, compare, the
  game catalog and SteamGridDB artwork
- [Watch Parties](Watch-Parties.md): watching with friends in sync, the queue, chat and reactions
- [Android App](Android-App.md): installing the app, servers and sign-in, uploading from your phone

## Running a server

- [Installation](Installation.md): Docker, reverse proxies, Node.js, hosting at home, GPU encoding, first run
- [Configuration](Configuration.md): environment variables, every admin setting, the data folder
- [Upgrading and Backups](Upgrading-and-Backups.md): updates, deploys, rollbacks, backups, moving machines
- [Moderation and Legal](Moderation-and-Legal.md): roles, reports, spam, sign-up, copyright, legal background
- [Admin CLI](Admin-CLI.md): every command-line command
- [Troubleshooting](Troubleshooting.md): common problems and their fixes

## Linking up

- [Network](Network.md): how servers link, joining, what each server controls, running a hub
- [Fediverse](Fediverse.md): Mastodon, PeerTube, following out, linked accounts, moving a channel

## Contributing

- [Development](Development.md): the code layout, tests, migrations, the job queue and releases
- The federation design: [docs/federation.md](https://github.com/JawshTheDark/cliptube/blob/main/docs/federation.md)

---

<sub>Written for ClipTube 1.6. The pages live in the repository under `docs/wiki/` and change with the code.</sub>
