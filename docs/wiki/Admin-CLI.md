# Admin CLI

`server/cli.js` manages a server from its shell, without a web login. It works on the server's own database,
so run it where the data lives:

```bash
docker exec cliptube node server/cli.js <command>        # Docker
node server/cli.js <command>                              # Node.js, from the app folder, with the same DATA_DIR
```

Run it with no arguments for a short usage line. Anything the command sends to other servers is queued and
delivered by the running server's job queue.

## Network

| Command | What it does |
| --- | --- |
| `network status` | This server's network role and state: peers, hub, block lists |
| `network hub-enable <public-url>` | Make this server the hub of a network |
| `network hub-disable` | Stop being a hub |
| `network join <url> [--self <url>]` | Join a network through its hub or any server in it. Uses the Public URL setting unless `--self` is given. |
| `network peer <url>` | Peer with a server directly |
| `network follow-blocklist <url> [--mode auto\|review]` | Follow another server's published block list, applied automatically or after review |
| `network leave [--keep-peers]` | Leave the network, or with `--keep-peers` only the hub |
| `network sync` | Sync now (hub, block lists, peers) and print the result |

## Accounts

| Command | What it does |
| --- | --- |
| `user list` | Local accounts with their role and status |
| `user role <username> <user\|moderator\|admin>` | Change someone's role |
| `user status <username> <active\|suspended\|banned> [reason]` | Suspend, ban or reinstate an account |

## Settings

| Command | What it does |
| --- | --- |
| `settings get <key>` | Print a setting |
| `settings set <key> <value>` | Change a setting (keys are listed in [Configuration](Configuration.md)) |
| `settings set-secret <steamgriddb_api_key\|smtp_password>` | Set a secret from standard input, keeping it out of the command line and your shell history |

## Examples

```bash
# Join the OurTube network
docker exec cliptube node server/cli.js network join https://clips.irc.so

# Make someone a moderator
docker exec cliptube node server/cli.js user role alice moderator

# Ban a spammer, with a reason
docker exec cliptube node server/cli.js user status spammer banned "posting spam"

# Turn on adaptive streaming
docker exec cliptube node server/cli.js settings set hls_ladder full

# Save a SteamGridDB API key (note the -i, so the key file reaches the container)
docker exec -i cliptube node server/cli.js settings set-secret steamgriddb_api_key < keyfile

# Follow the hub's block list, reviewing each block before it applies
docker exec cliptube node server/cli.js network follow-blocklist https://clips.irc.so --mode review
```

## Locked out of the admin account?

With email set up, use *Forgot password* on the sign-in page. Without it, there is no password reset from the
command line yet; instead, open sign-up for a moment, create a new account, promote it, and close sign-up again:

```bash
docker exec cliptube node server/cli.js settings set registration_mode open
# create the account in the browser, then:
docker exec cliptube node server/cli.js user role <new-account> admin
docker exec cliptube node server/cli.js settings set registration_mode invite
```
