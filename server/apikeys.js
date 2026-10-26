// API keys, each person's own, for uploaders that send a file with a fixed header (ShareX, scripts, curl).
// A key can only upload, in one request or in pieces; it is shown once and kept as a hash. Uploads with a key
// use its defaults (visibility, publish right away or keep as a draft) for whatever the request leaves out.
import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';
import { API_KEY_PREFIX, requireAuth } from './auth.js';
import { apBase } from './ap/common.js';
import { HttpError, newId, now, sha256, str } from './util.js';

const MAX_PER_PERSON = 10;
const VISIBILITIES = ['public', 'unlisted', 'private'];

const view = (k) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  visibility: k.visibility,
  publish: !!k.publish,
  created_at: k.created_at,
  last_used_at: k.last_used_at,
});

function ownKey(id, user) {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(String(id), user.id);
  if (!k) throw new HttpError(404, 'API key not found');
  return k;
}
function cleanVisibility(input) {
  const v = String(input || 'unlisted');
  if (!VISIBILITIES.includes(v)) throw new HttpError(400, 'Visibility must be public, unlisted or private');
  return v;
}

export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth);

apiKeysRouter.get('/', (req, res) => {
  res.json({
    keys: db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at').all(req.user.id).map(view),
    upload_url: `${apBase(req) || `${req.protocol}://${req.get('host')}`}/api/videos`,
  });
});

apiKeysRouter.post('/', (req, res) => {
  const b = req.body || {};
  if (db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(req.user.id).n >= MAX_PER_PERSON) {
    throw new HttpError(400, `At most ${MAX_PER_PERSON} API keys each`);
  }
  const key = `${API_KEY_PREFIX}${crypto.randomBytes(30).toString('base64url')}`;
  const id = newId();
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, prefix, visibility, publish, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, req.user.id, str(b.name, 60).trim() || 'API key', sha256(key), key.slice(0, 10), cleanVisibility(b.visibility), b.publish === false ? 0 : 1, now(),
  );
  // The key itself is only ever in this answer.
  res.status(201).json({ key, api_key: view(ownKey(id, req.user)) });
});

apiKeysRouter.patch('/:id', (req, res) => {
  const k = ownKey(req.params.id, req.user);
  const b = req.body || {};
  db.prepare('UPDATE api_keys SET name = ?, visibility = ?, publish = ? WHERE id = ?').run(
    b.name !== undefined ? str(b.name, 60).trim() || 'API key' : k.name,
    b.visibility !== undefined ? cleanVisibility(b.visibility) : k.visibility,
    b.publish !== undefined ? (b.publish ? 1 : 0) : k.publish,
    k.id,
  );
  res.json({ api_key: view(ownKey(k.id, req.user)) });
});

apiKeysRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(ownKey(req.params.id, req.user).id);
  res.status(204).end();
});
