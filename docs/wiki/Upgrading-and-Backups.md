# Upgrading and Backups

- [Updating a server](#updating-a-server)
- [Deploying from another machine](#deploying-from-another-machine)
- [Rolling back](#rolling-back)
- [Backing up](#backing-up)
- [Restoring](#restoring)
- [Moving to a new machine](#moving-to-a-new-machine)
- [Checking the version](#checking-the-version)

## Updating a server

With the code checked out on the server:

```bash
cd ~/cliptube
git pull
docker compose up -d --build
```

Database changes are applied automatically when the new version starts. Before it changes anything, the server
copies the database to `data/backups/pre-migration-<time>.db` (the 10 most recent are kept).

Your `.env`, `docker-compose.override.yml` and `data/` are never touched by an update.

## Deploying from another machine

`scripts/deploy.sh` updates one or more servers over SSH from a checkout on your own machine:

```bash
scripts/deploy.sh user@your-server
scripts/deploy.sh user@server-one user@server-two    # one after the other
```

For each server it:

1. copies the database to `data/backups/pre-deploy-<time>.db` (the 10 most recent are kept),
2. tags the running image as `cliptube:rollback`,
3. copies the committed code (`git archive HEAD`) to `~/cliptube`, leaving `data/`, `.env` and
   `docker-compose.override.yml` alone,
4. rebuilds and restarts the container, and
5. waits up to two minutes for the health check, then prints the site name, its network role and any errors
   from the log.

It deploys what is committed, not your working tree, and warns when you have uncommitted changes. The server
needs Docker, SSH access with a key, and a first install in `~/cliptube` (see [Installation](Installation.md)).

When several servers in a network are updated, do them one at a time and check each before the next:

```bash
ssh user@your-server 'docker exec cliptube node server/cli.js network sync'
```

## Rolling back

Go back to the image that ran before the last deploy:

```bash
cd ~/cliptube
docker tag cliptube:rollback cliptube:latest
docker compose up -d --no-build
```

If the newer version changed the database, put back the copy made before it started as well. Anything written
since that copy (new uploads, comments) is lost from the database, so do this only if you need to:

```bash
cd ~/cliptube
docker compose stop
cp data/backups/pre-deploy-<time>.db data/cliptube.db
rm -f data/cliptube.db-wal data/cliptube.db-shm
docker compose up -d --no-build
```

## Backing up

Everything is in the data folder (see [The data folder](Configuration.md#the-data-folder)), so backing up
means copying it. The database is SQLite in WAL mode, so don't copy `cliptube.db` while the server writes to
it. Either stop the server for the copy:

```bash
cd ~/cliptube
docker compose stop
tar -czf ~/cliptube-backup-$(date +%F).tar.gz data
docker compose start
```

or, with the server running, take a consistent copy of the database first and then copy everything else:

```bash
cd ~/cliptube
docker exec cliptube node -e "new (require('node:sqlite').DatabaseSync)('/data/cliptube.db').exec(\"VACUUM INTO '/data/backups/manual-$(date +%F-%H%M).db'\")"
rsync -a --exclude 'cliptube.db*' data/ backup-host:/backups/cliptube/
```

The copy lands in `data/backups/`, which `rsync` then sends along with the videos.

## Restoring

1. Stop the server: `docker compose stop`.
2. Put the data folder back. If you're restoring from a database copy, place it as `data/cliptube.db` and
   delete any `cliptube.db-wal` and `cliptube.db-shm` next to it.
3. Make sure it belongs to the user the container runs as: `sudo chown -R 1000:1000 data`.
4. Start it: `docker compose start`.

## Moving to a new machine

1. Install OurTube on the new machine ([Installation](Installation.md)), but don't create an account.
2. Stop the old server and copy its data folder across, for example
   `rsync -a old-host:cliptube/data/ ~/cliptube/data/`.
3. Fix the ownership (`sudo chown -R 1000:1000 data`), start the new server, and point your DNS or reverse
   proxy at it.

Keep the same Public URL. Other servers and the fediverse know your server by its address and its keys
(which are in the database), so the move is invisible to them. A server under a new address is a new server to
everyone else; to take a channel to another server, use a channel move instead (see
[Fediverse](Fediverse.md#moving-a-channel)).

## Checking the version

```bash
docker exec cliptube node -p "require('./package.json').version"
curl -s https://clips.example.com/nodeinfo/2.0     # "version" under "software"
```

Releases are tagged `vX.Y.Z` in the repository, and the milestones are listed in
[PLAN.md](https://github.com/JawshTheDark/ourtube/blob/main/PLAN.md).
