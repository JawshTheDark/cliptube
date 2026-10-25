import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { DIRS } from '../config.js';
import { HttpError } from '../util.js';
import { editorDir } from '../media.js';

export const mediaRouter = Router();

function idFrom(file) {
  return String(file).replace(/\.mp4$/i, '');
}

function editorOnly(req, v) {
  if (!v || !(req.user && (req.user.id === v.user_id || req.user.is_admin))) throw new HttpError(404, 'Not found');
}

mediaRouter.get('/videos/:file', (req, res) => {
  const v = db.prepare('SELECT id, user_id, title, visibility, status, file_path FROM videos WHERE id = ?').get(idFrom(req.params.file));
  if (!v || v.status !== 'ready' || !v.file_path) throw new HttpError(404, 'Not found');
  if (v.visibility === 'private' && !(req.user && (req.user.id === v.user_id || req.user.is_admin))) throw new HttpError(404, 'Not found');
  // URLs carry ?v=<edit version>, so a long cache is safe; unversioned URLs get a short one.
  const versioned = req.query.v !== undefined;
  const opts = { acceptRanges: true, cacheControl: true, maxAge: versioned ? '30d' : '10m', headers: { 'Content-Type': 'video/mp4' } };
  if (req.query.download !== undefined) {
    const safe = v.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || v.id;
    opts.headers['Content-Disposition'] = `attachment; filename="${safe}.mp4"`;
  }
  res.sendFile(path.join(DIRS.videos, v.file_path), opts);
});

/** The unedited source the timeline editor works on. Owner and admins only. */
mediaRouter.get('/source/:file', (req, res) => {
  const v = db.prepare('SELECT id, user_id, base_path FROM videos WHERE id = ?').get(idFrom(req.params.file));
  editorOnly(req, v);
  if (!v.base_path) throw new HttpError(404, 'Not found');
  res.sendFile(path.join(DIRS.videos, v.base_path), { acceptRanges: true, cacheControl: false, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=600' } });
});

mediaRouter.get('/editor/:id/sprite.jpg', (req, res) => {
  const v = db.prepare('SELECT id, user_id FROM videos WHERE id = ?').get(String(req.params.id));
  editorOnly(req, v);
  const file = path.join(editorDir(v.id), 'sprite.jpg');
  if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
  res.sendFile(file, { cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600' } });
});

mediaRouter.use('/thumbs', express.static(DIRS.thumbs, { maxAge: '30d', immutable: true, fallthrough: false }));
mediaRouter.use('/avatars', express.static(DIRS.avatars, { maxAge: '30d', immutable: true, fallthrough: false }));
