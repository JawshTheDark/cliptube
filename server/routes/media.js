import express, { Router } from 'express';
import path from 'node:path';
import { db } from '../db.js';
import { DIRS } from '../config.js';
import { HttpError } from '../util.js';

export const mediaRouter = Router();

mediaRouter.get('/videos/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.mp4$/i, '');
  const v = db.prepare('SELECT id, user_id, title, visibility, status, file_path FROM videos WHERE id = ?').get(id);
  if (!v || v.status !== 'ready' || !v.file_path) throw new HttpError(404, 'Not found');
  if (v.visibility === 'private' && !(req.user && (req.user.id === v.user_id || req.user.is_admin))) throw new HttpError(404, 'Not found');
  const opts = { acceptRanges: true, cacheControl: true, maxAge: '1d', headers: { 'Content-Type': 'video/mp4' } };
  if (req.query.download !== undefined) {
    const safe = v.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || v.id;
    opts.headers['Content-Disposition'] = `attachment; filename="${safe}.mp4"`;
  }
  res.sendFile(path.join(DIRS.videos, v.file_path), opts);
});

mediaRouter.use('/thumbs', express.static(DIRS.thumbs, { maxAge: '30d', immutable: true, fallthrough: false }));
mediaRouter.use('/avatars', express.static(DIRS.avatars, { maxAge: '30d', immutable: true, fallthrough: false }));
