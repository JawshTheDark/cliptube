/** RSA keys for ActivityPub actors (Mastodon and PeerTube sign with RSA-SHA256). Made on first use. */
import crypto from 'node:crypto';
import { db, getSettings, setSetting } from '../db.js';

function newPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** A local account's key pair (shared by its Person and its channel Group). */
export function userKeys(userId) {
  const u = db.prepare('SELECT ap_public_key, ap_private_key FROM users WHERE id = ?').get(userId);
  if (!u) throw new Error('No such account');
  if (u.ap_public_key && u.ap_private_key) return { publicKey: u.ap_public_key, privateKey: u.ap_private_key };
  const k = newPair();
  db.prepare('UPDATE users SET ap_public_key = ?, ap_private_key = ? WHERE id = ? AND ap_public_key IS NULL').run(k.publicKey, k.privateKey, userId);
  const again = db.prepare('SELECT ap_public_key, ap_private_key FROM users WHERE id = ?').get(userId);
  return { publicKey: again.ap_public_key, privateKey: again.ap_private_key };
}

export function instanceKeys() {
  const s = getSettings();
  if (s.ap_instance_public_key && s.ap_instance_private_key) return { publicKey: s.ap_instance_public_key, privateKey: s.ap_instance_private_key };
  const k = newPair();
  setSetting('ap_instance_public_key', k.publicKey);
  setSetting('ap_instance_private_key', k.privateKey);
  return k;
}
