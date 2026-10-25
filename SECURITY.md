# Security

## Reporting a vulnerability

Please report security problems privately, through **Security → Report a vulnerability** on this repository's
GitHub page, rather than in a public issue. Include what you found, how to reproduce it, and which version
(`/nodeinfo/2.0` shows it). You'll get an answer as soon as possible, and a fix is released before the details
are made public.

## How a server and a network are protected

- **The first account.** A fresh server only lets the first (admin) account be created with the one-time setup
  code printed in its log, so nobody can claim a server they don't run.
- **Joining a network.** A server that asks to join a hub has to prove it controls its own address: the hub
  calls back to that address and checks a one-time code. Nobody can join, or rejoin, in another server's name.
  Hub admins can require approval for new servers, turn joining off, and suspend or ban any server.
- **Server identity.** Servers sign their requests to each other. Each server's key is read from its own address
  over HTTPS, so the TLS certificate vouches for it, and a key passed along by anyone else is never trusted on
  its own. Signed requests expire after ten minutes.
- **ActivityPub.** Every incoming activity must carry a valid HTTP signature from its actor, and an actor's
  profile is only trusted when it comes from the actor's own server.
- **Linked accounts** count only when both accounts list each other, so nobody can claim yours.
- **Requests to other servers** only go to public addresses: names that point into a private network (LAN,
  localhost, cloud metadata) are refused. ActivityPub traffic is HTTPS only, and so is the network unless an
  admin turns off *HTTPS only*.
- **Accounts.** Passwords are hashed with bcrypt. Failed sign-ins and sign-ups from one address are rate
  limited. Sessions are HTTP-only cookies (or bearer tokens for the Android app), and passwords and API keys
  saved in Admin are never sent back to the browser.

## Running a server safely

- Serve it over HTTPS, and set `TRUST_PROXY=1` behind a reverse proxy (the Docker image does).
- Keep sign-up on invite-only or approval unless you want strangers to join.
- On a hub, turn on **Require my approval** (Admin → Network) to vet new servers before they join.
- Keep the `data` folder private and backed up: it holds the database and the server's keys.
- Update regularly (see [Upgrading and Backups](docs/wiki/Upgrading-and-Backups.md)).
