# Development

- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Tests](#tests)
- [Database migrations](#database-migrations)
- [Background jobs](#background-jobs)
- [Federation work](#federation-work)
- [Releasing](#releasing)
- [This wiki](#this-wiki)

## Getting started

You need Node.js 22.13 or newer (24 recommended).

```bash
git clone https://github.com/JawshTheDark/cliptube.git
cd cliptube
npm install
npm run dev
```

`npm run dev` starts two things:

- the **API** on http://localhost:3000, restarted whenever a file in `server/` changes, with request logging and
  private-address federation allowed (`--log --allow-private-federation`);
- **Vite** on http://localhost:5173 with hot reload, passing `/api`, `/media`, `/feeds` and `/.well-known` to
  the API.

Open http://localhost:5173 and create the first account with the setup code printed in the console. Data goes
to `./data` (ignored by git).

## Repository layout

```text
server/              the Express app
├── index.js         startup, routes, static files
├── routes/          the videos, users, media and admin APIs
├── ap/              ActivityPub: actors, inbox, delivery, HTTP signatures, keys, peering, moves
├── network.js       the ClipTube network: hub directory, admission switches, block lists, game catalog
├── media.js         FFprobe and FFmpeg: processing, thumbnails, editor filmstrips and waveforms
├── jobs.js          the persistent job queue
├── migrations.js    numbered database migrations
├── cli.js           the admin command line
└── …                games, SteamGridDB, search, feeds, notifications, moderation, spam, privacy, stats
web/                 the React app, built by Vite into web/dist
├── src/pages/       one file per page
└── src/components/  the player, pickers, dialogs and other shared pieces
test/                node:test suites; helpers.js starts real servers for them
scripts/             deploy.sh, fediverse-sandbox.sh, publish-wiki.sh
sandbox/             the Docker setup the fediverse sandbox runs
docs/                the federation design, this wiki and the screenshots
```

## Tests

```bash
npm test                              # every suite, one file at a time (about a minute)
npm run test:unit                     # the quick unit tests only
node --test test/network.test.js      # one file
```

Most suites start **real ClipTube servers** in temporary data folders, with private-address federation allowed,
and talk to them over HTTP. Network and ActivityPub tests therefore exercise the real code, including
signatures and the job queue (`waitFor` in `test/helpers.js` waits for asynchronous deliveries). Outside
services are replaced by small stand-ins: `STEAMGRIDDB_BASE_URL`, for example, points the SteamGridDB client at
a fake server in `test/artwork.test.js`.

## Database migrations

Schema changes go at the end of `server/migrations.js` as a new numbered migration; never change one that has
been released. The server applies pending migrations at startup, after copying the database to
`data/backups/pre-migration-<time>.db`.

## Background jobs

Slow and retryable work runs through the job queue in `server/jobs.js`:

```js
defineJob('games.artwork', { maxAttempts: 3, handler: async ({ id }) => { /* ... */ } });
enqueueJob('games.artwork', { id }, { dedupe: `games-artwork:${id}` });
```

Jobs are stored in the `jobs` table, so they survive restarts, and are retried with a growing delay. Each job
type belongs to a lane, and each lane has its own number of workers, so a long transcode never holds up
deliveries:

| Lane | Workers | Used for |
| --- | --- | --- |
| `media` | 1 | FFmpeg work: processing, renditions, edits, exports |
| `network` | 4 | ActivityPub deliveries, incoming activities, backfills and follower moves |
| `transfer` | 1 | Channel exports and imports |
| `default` | 2 | Everything else |

## Federation work

- The design, the ClipTube extensions and the reasoning behind them are in
  [docs/federation.md](https://github.com/JawshTheDark/cliptube/blob/main/docs/federation.md).
- To check changes against real fediverse software, run
  `scripts/fediverse-sandbox.sh <ssh-host> [--keep]`: it builds ClipTube from your working tree and runs the
  interop checks against PeerTube and GoToSocial in a private Docker sandbox on that host (see
  [Fediverse](Fediverse.md#checked-against-real-servers)).

## Releasing

1. Set the new version: `npm version 1.5.0 --no-git-tag-version` (updates `package.json` and
   `package-lock.json`).
2. Update [PLAN.md](https://github.com/JawshTheDark/cliptube/blob/main/PLAN.md) and
   [TODO.md](https://github.com/JawshTheDark/cliptube/blob/main/TODO.md), and the README if features changed.
3. Run `npm test`.
4. Commit, tag (`git tag -a v1.5.0 -m "v1.5.0: ..."`) and push the branch and the tag.
5. Deploy with `scripts/deploy.sh`, one server at a time, and run `network sync` on each (see
   [Upgrading and Backups](Upgrading-and-Backups.md#deploying-from-another-machine)).

## This wiki

The wiki's pages live in the repository under `docs/wiki/`, so they change in the same commits as the code
they describe, and the screenshots are in `docs/images/`. To copy them to the GitHub Wiki tab:

```bash
scripts/publish-wiki.sh
```

The Wiki tab has to be turned on in the repository's settings, with one page created on github.com first;
GitHub only offers wikis on private repositories with a paid plan.
