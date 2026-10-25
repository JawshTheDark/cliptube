#!/usr/bin/env node
/**
 * ClipTube admin command line, for server operators (no web login needed).
 * Run it where the server's data lives, for example inside the container:
 *
 *   docker exec cliptube node server/cli.js <command>
 *
 * Commands:
 *   network status                          Show this instance's network role and state
 *   network hub-enable <public-url>         Turn on hub mode (this instance runs the network)
 *   network hub-disable                     Turn off hub mode
 *   network join <url> [--self <url>]       Join a network through a hub or any instance in it
 *                                           (uses the Public URL setting unless --self is given)
 *   network peer <url>                      Peer with an instance directly
 *   network follow-blocklist <url> [--mode auto|review]
 *                                           Follow another instance's published block list
 *   network leave [--keep-peers]            Leave the network (or only the hub, keeping direct peers)
 *   network sync                            Sync now: hub, block lists, peers
 *   user list                               List local accounts with role and status
 *   user role <username> <user|moderator|admin>
 *   user status <username> <active|suspended|banned> [reason]
 *   settings get <key>
 *   settings set <key> <value>
 */
import { db, getSettings, setSetting, SECRET_SETTINGS } from './db.js';
import { setUserRole, setUserStatus } from './auth.js';
import {
  enableHub, disableHub, joinNetwork, leaveHub, networkTick, introduce, subscribeBlocklist, networkRole, networkActive, isHub, PROTOCOL,
} from './network.js';
// The ActivityPub side of the network (peering, reconciling), and signed fetches as the instance actor.
// Deliveries it queues are sent by the running server's job queue.
import './ap/routes.js';
import './ap/peering.js';

const [, , area, cmd, ...rest] = process.argv;

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node server/cli.js <network|user|settings> <command> [args]  (see the top of server/cli.js)');
  process.exit(msg ? 1 : 0);
}

function flag(name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

function localUser(username) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(String(username || ''));
  if (!u) usage(`No local account called ${username}`);
  return u;
}

function networkStatus() {
  const s = getSettings();
  const out = {
    role: networkRole(),
    active: networkActive(),
    protocol: PROTOCOL,
    self_url: s.network_self_url || s.public_url || null,
    peers: db
      .prepare(
        `SELECT url, name, source, peer_status, remote_status, protocol, video_count, last_ok_at, last_error FROM instances
         WHERE is_self = 0 AND blocked = 0 AND (peer_status IS NOT NULL OR remote_status IS NOT NULL) ORDER BY url`,
      )
      .all()
      .map((p) => ({ ...p, last_ok_at: p.last_ok_at ? new Date(p.last_ok_at).toISOString() : null })),
    blocked: db.prepare('SELECT url, block_reason, block_source FROM instances WHERE blocked = 1 ORDER BY url').all(),
    blocklists: db.prepare('SELECT url, mode, last_error FROM blocklist_subscriptions').all(),
  };
  if (isHub()) {
    out.hub = {
      network_name: s.hub_network_name,
      accept_new: s.hub_accept_new,
      require_approval: s.hub_require_approval,
      members: db
        .prepare("SELECT url, name, hub_status, video_count, last_sync_at, last_error FROM instances WHERE is_self = 0 AND hub_status IS NOT NULL AND hub_status != 'gone'")
        .all(),
    };
  } else if (s.network_enabled === 'true') {
    out.member = {
      hub_url: s.network_hub_url,
      status: s.network_status,
      note: s.network_note || null,
      mirrored_videos: db.prepare('SELECT COUNT(*) AS n FROM network_videos').get().n,
      last_sync: s.network_last_sync ? new Date(Number(s.network_last_sync)).toISOString() : null,
      last_error: s.network_last_error || null,
    };
  }
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  try {
    switch (`${area} ${cmd}`) {
      case 'network status':
        return networkStatus();
      case 'network hub-enable':
        if (!rest[0]) usage('Give the public URL, e.g. https://clips.example.com');
        enableHub(rest[0]);
        console.log(`Hub mode is on at ${getSettings().network_self_url}`);
        return networkStatus();
      case 'network hub-disable':
        disableHub();
        return console.log('Hub mode is off');
      case 'network join': {
        if (!rest[0]) usage('Give the address of a hub or any instance in the network, e.g. https://clips.irc.so');
        const self = flag('--self') || getSettings().public_url;
        if (!self) usage('Set the public_url setting first, or pass --self https://your.address');
        await joinNetwork(self, rest[0]);
        return networkStatus();
      }
      case 'network peer':
        if (!rest[0]) usage('Give the address of the instance to peer with');
        await introduce(rest[0], 'admin');
        return networkStatus();
      case 'network follow-blocklist':
        if (!rest[0]) usage('Give the address of the instance whose block list to follow, and optionally --mode auto');
        subscribeBlocklist(rest[0], flag('--mode') || 'review');
        await networkTick({ full: true });
        return networkStatus();
      case 'network leave':
        await leaveHub({ keepPeers: rest.includes('--keep-peers') });
        return console.log(rest.includes('--keep-peers') ? 'Left the hub; direct peers are kept' : 'Left the network');
      case 'network sync':
        await networkTick({ full: true });
        return networkStatus();
      case 'user list':
        for (const u of db.prepare('SELECT username, role, status, status_reason FROM users WHERE remote_instance_id IS NULL ORDER BY created_at').all()) {
          console.log(`${u.username}\t${u.role}\t${u.status}${u.status_reason ? `\t${u.status_reason}` : ''}`);
        }
        return;
      case 'user role':
        setUserRole(localUser(rest[0]).id, rest[1]);
        return console.log(`${rest[0]} is now ${rest[1]}`);
      case 'user status':
        setUserStatus(localUser(rest[0]).id, rest[1], rest.slice(2).join(' '));
        return console.log(`${rest[0]} is now ${rest[1]}`);
      case 'settings get':
        if (SECRET_SETTINGS.has(rest[0])) usage('That setting is secret');
        return console.log(getSettings()[rest[0]] ?? '');
      case 'settings set':
        if (SECRET_SETTINGS.has(rest[0]) || rest[0]?.startsWith('instance_')) usage('That setting cannot be set here');
        setSetting(rest[0], rest.slice(1).join(' '));
        return console.log(`${rest[0]} set`);
      default:
        return usage(area ? `Unknown command: ${area} ${cmd || ''}` : undefined);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

await main();
process.exit(0);
