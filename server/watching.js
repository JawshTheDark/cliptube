/**
 * Watching upgrades that hang off a video: captions (uploaded by the uploader or submitted by viewers
 * for approval), skippable segments (sponsor, intro, outro, recap, self-promotion), community title and
 * thumbnail suggestions with votes (opt-in for viewers, like DeArrow), original-file downloads, and the
 * media routes for HLS, the federation MP4, captions and originals.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from './db.js';
import { DIRS } from './config.js';
import { requireAuth } from './auth.js';
import { HttpError, newId, now, str } from './util.js';
import { grabFrame } from './media.js';
import { canEdit, canPlay, canView, loadVideo, touchVideo } from './routes/videos.js';
import { logAction } from './reports.js';
import { indexVideo } from './search.js';

export const SEGMENT_KINDS = { sponsor: 'Sponsor', intro: 'Intro', outro: 'Outro', recap: 'Recap', selfpromo: 'Self-promotion' };
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const canManage = (v, user) => !!user && (canEdit(v, user) || user.is_moderator);

function viewable(req) {
  const v = loadVideo(req.params.id);
  if (!v || !canView(v, req.user)) throw new HttpError(404, 'Video not found');
  return v;
}

// ---- captions ---------------------------------------------------------------------------------------

/** Converts SubRip to WebVTT; WebVTT is checked and passed through. */
export function toVtt(text) {
  let t = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(t)) return `${t}\n`;
  if (!/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t)) throw new HttpError(400, "That doesn't look like a WebVTT or SRT caption file");
  t = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
  const lines = t.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+$/.test(lines[i].trim()) && /-->/.test(lines[i + 1] || '')) continue; // SRT cue numbers
    out.push(lines[i]);
  }
  return `WEBVTT\n\n${out.join('\n')}\n`;
}

const captionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');

function serializeCaption(c, user) {
  return {
    id: c.id,
    lang: c.lang,
    label: c.label,
    status: c.status,
    url: `/media/captions/${c.id}.vtt`,
    mine: !!user && c.submitted_by === user.id,
    submitted_by: c.submitted_by ? db.prepare('SELECT username FROM users WHERE id = ?').get(c.submitted_by)?.username || null : null,
    created_at: c.created_at,
  };
}

export function publishedCaptions(videoId) {
  return db.prepare("SELECT * FROM captions WHERE video_id = ? AND status = 'published' ORDER BY label").all(videoId).map((c) => serializeCaption(c, null));
}

export const watchingRouter = Router();

watchingRouter.get('/videos/:id/captions', (req, res) => {
  const v = viewable(req);
  const all = canManage(v, req.user);
  const rows = db.prepare('SELECT * FROM captions WHERE video_id = ? ORDER BY status DESC, label').all(v.id);
  res.json({ captions: rows.filter((c) => c.status === 'published' || all || c.submitted_by === req.user?.id).map((c) => serializeCaption(c, req.user)) });
});

watchingRouter.post('/videos/:id/captions', requireAuth, captionUpload, (req, res) => {
  const v = viewable(req);
  if (!req.file) throw new HttpError(400, 'Choose a .vtt or .srt file');
  const lang = String(req.body?.lang || '').trim();
  if (!LANG_RE.test(lang)) throw new HttpError(400, 'Language must be a code like en, es or pt-BR');
  const label = str(req.body?.label, 40).trim() || lang;
  const vtt = toVtt(req.file.buffer.toString('utf8'));
  const owner = canManage(v, req.user);
  if (!owner && db.prepare("SELECT COUNT(*) AS n FROM captions WHERE video_id = ? AND submitted_by = ? AND status = 'pending'").get(v.id, req.user.id).n >= 3) {
    throw new HttpError(429, 'You already have captions waiting for review on this video');
  }
  const id = newId();
  const file = `${v.id}-${id}.vtt`;
  fs.writeFileSync(path.join(DIRS.captions, file), vtt);
  db.prepare('INSERT INTO captions (id, video_id, lang, label, file, status, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, v.id, lang, label, file, owner ? 'published' : 'pending', req.user.id, now(),
  );
  res.status(201).json({ caption: serializeCaption(db.prepare('SELECT * FROM captions WHERE id = ?').get(id), req.user) });
});

function captionFor(req) {
  const v = viewable(req);
  const c = db.prepare('SELECT * FROM captions WHERE id = ? AND video_id = ?').get(String(req.params.cid), v.id);
  if (!c) throw new HttpError(404, 'Captions not found');
  return { v, c };
}

watchingRouter.patch('/videos/:id/captions/:cid', requireAuth, (req, res) => {
  const { v, c } = captionFor(req);
  if (!canManage(v, req.user)) throw new HttpError(403, 'Only the uploader can publish captions');
  const b = req.body || {};
  if (b.status !== undefined && b.status !== 'published') throw new HttpError(400, 'Captions can only be published; delete them to reject');
  db.prepare('UPDATE captions SET status = COALESCE(?, status), label = COALESCE(?, label) WHERE id = ?').run(b.status || null, b.label ? str(b.label, 40).trim() : null, c.id);
  res.json({ caption: serializeCaption(db.prepare('SELECT * FROM captions WHERE id = ?').get(c.id), req.user) });
});

watchingRouter.delete('/videos/:id/captions/:cid', requireAuth, (req, res) => {
  const { v, c } = captionFor(req);
  if (!(canManage(v, req.user) || (c.submitted_by === req.user.id && c.status === 'pending'))) throw new HttpError(403, 'You cannot delete these captions');
  db.prepare('DELETE FROM captions WHERE id = ?').run(c.id);
  try { fs.unlinkSync(path.join(DIRS.captions, c.file)); } catch {}
  res.json({ ok: true });
});

// ---- skippable segments ---------------------------------------------------------------------------------

function serializeSegment(s, user) {
  return { id: s.id, kind: s.kind, label: SEGMENT_KINDS[s.kind], start: s.start_s, end: s.end_s, status: s.status, mine: !!user && s.submitted_by === user.id };
}

export function publishedSegments(videoId) {
  return db.prepare("SELECT * FROM segments WHERE video_id = ? AND status = 'published' ORDER BY start_s").all(videoId).map((s) => serializeSegment(s, null));
}

watchingRouter.get('/videos/:id/segments', (req, res) => {
  const v = viewable(req);
  const all = canManage(v, req.user);
  const rows = db.prepare('SELECT * FROM segments WHERE video_id = ? ORDER BY start_s').all(v.id);
  res.json({ segments: rows.filter((s) => s.status === 'published' || all || s.submitted_by === req.user?.id).map((s) => serializeSegment(s, req.user)) });
});

watchingRouter.post('/videos/:id/segments', requireAuth, (req, res) => {
  const v = viewable(req);
  const b = req.body || {};
  if (!SEGMENT_KINDS[b.kind]) throw new HttpError(400, `Kind must be one of ${Object.keys(SEGMENT_KINDS).join(', ')}`);
  const start = Math.max(0, Number(b.start) || 0);
  const end = Math.min(v.duration || 0, Number(b.end) || 0);
  if (!(end - start >= 1)) throw new HttpError(400, 'A segment has to be at least a second long');
  const owner = canManage(v, req.user);
  if (!owner && db.prepare("SELECT COUNT(*) AS n FROM segments WHERE video_id = ? AND submitted_by = ? AND status = 'pending'").get(v.id, req.user.id).n >= 5) {
    throw new HttpError(429, 'You already have several suggestions waiting on this video');
  }
  const id = newId();
  db.prepare('INSERT INTO segments (id, video_id, kind, start_s, end_s, status, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, v.id, b.kind, start, end, owner ? 'published' : 'pending', req.user.id, now(),
  );
  res.status(201).json({ segment: serializeSegment(db.prepare('SELECT * FROM segments WHERE id = ?').get(id), req.user) });
});

watchingRouter.patch('/videos/:id/segments/:sid', requireAuth, (req, res) => {
  const v = viewable(req);
  const s = db.prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(String(req.params.sid), v.id);
  if (!s) throw new HttpError(404, 'Segment not found');
  if (!canManage(v, req.user)) throw new HttpError(403, 'Only the uploader can publish segments');
  const b = req.body || {};
  const kind = b.kind !== undefined ? b.kind : s.kind;
  if (!SEGMENT_KINDS[kind]) throw new HttpError(400, 'Unknown segment kind');
  const start = b.start !== undefined ? Math.max(0, Number(b.start) || 0) : s.start_s;
  const end = b.end !== undefined ? Math.min(v.duration || 0, Number(b.end) || 0) : s.end_s;
  if (!(end - start >= 1)) throw new HttpError(400, 'A segment has to be at least a second long');
  db.prepare("UPDATE segments SET kind = ?, start_s = ?, end_s = ?, status = 'published' WHERE id = ?").run(kind, start, end, s.id);
  res.json({ segment: serializeSegment(db.prepare('SELECT * FROM segments WHERE id = ?').get(s.id), req.user) });
});

watchingRouter.delete('/videos/:id/segments/:sid', requireAuth, (req, res) => {
  const v = viewable(req);
  const s = db.prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(String(req.params.sid), v.id);
  if (!s) throw new HttpError(404, 'Segment not found');
  if (!(canManage(v, req.user) || (s.submitted_by === req.user.id && s.status === 'pending'))) throw new HttpError(403, 'You cannot delete that segment');
  db.prepare('DELETE FROM segments WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// ---- community titles and thumbnails ------------------------------------------------------------------

const TABLE = { title: 'title_suggestions', thumbnail: 'thumbnail_suggestions' };

/** The top-voted community title and thumbnail, for viewers who choose to see them. */
export function communityFor(videoId) {
  const t = db.prepare('SELECT title FROM title_suggestions WHERE video_id = ? AND votes > 0 ORDER BY votes DESC, created_at LIMIT 1').get(videoId);
  const th = db.prepare('SELECT file FROM thumbnail_suggestions WHERE video_id = ? AND votes > 0 ORDER BY votes DESC, created_at LIMIT 1').get(videoId);
  return t || th ? { title: t?.title || null, thumbnail_url: th ? `/media/thumbs/${th.file}` : null } : null;
}

function suggestionsFor(v, user) {
  const voted = (kind, id) => !!user && !!db.prepare('SELECT 1 FROM suggestion_votes WHERE kind = ? AND suggestion_id = ? AND user_id = ?').get(kind, id, user.id);
  const by = (uid) => db.prepare('SELECT username FROM users WHERE id = ?').get(uid)?.username || null;
  return {
    titles: db
      .prepare('SELECT * FROM title_suggestions WHERE video_id = ? ORDER BY votes DESC, created_at')
      .all(v.id)
      .map((s) => ({ id: s.id, title: s.title, votes: s.votes, voted: voted('title', s.id), mine: !!user && s.user_id === user.id, by: by(s.user_id) })),
    thumbnails: db
      .prepare('SELECT * FROM thumbnail_suggestions WHERE video_id = ? ORDER BY votes DESC, created_at')
      .all(v.id)
      .map((s) => ({ id: s.id, url: `/media/thumbs/${s.file}`, time: s.time_s, votes: s.votes, voted: voted('thumbnail', s.id), mine: !!user && s.user_id === user.id, by: by(s.user_id) })),
    can_adopt: !!user && canEdit(v, user),
  };
}

function vote(kind, id, userId) {
  const r = db.prepare('INSERT OR IGNORE INTO suggestion_votes (kind, suggestion_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(kind, id, userId, now());
  if (r.changes) db.prepare(`UPDATE ${TABLE[kind]} SET votes = votes + 1 WHERE id = ?`).run(id);
}

watchingRouter.get('/videos/:id/suggestions', (req, res) => {
  const v = viewable(req);
  res.json(suggestionsFor(v, req.user));
});

watchingRouter.post('/videos/:id/suggestions/titles', requireAuth, (req, res) => {
  const v = viewable(req);
  const title = str(req.body?.title, 100).trim();
  if (title.length < 3) throw new HttpError(400, 'Suggest a title of at least 3 characters');
  if (title.toLowerCase() === v.title.toLowerCase()) throw new HttpError(400, "That's already the title");
  if (db.prepare('SELECT COUNT(*) AS n FROM title_suggestions WHERE video_id = ? AND user_id = ?').get(v.id, req.user.id).n >= 3) {
    throw new HttpError(429, 'You can suggest up to 3 titles for a video');
  }
  const same = db.prepare('SELECT id FROM title_suggestions WHERE video_id = ? AND lower(title) = lower(?)').get(v.id, title);
  if (same) vote('title', same.id, req.user.id);
  else {
    const id = newId();
    db.prepare('INSERT INTO title_suggestions (id, video_id, user_id, title, votes, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(id, v.id, req.user.id, title, now());
    vote('title', id, req.user.id);
  }
  res.status(201).json(suggestionsFor(v, req.user));
});

watchingRouter.post('/videos/:id/suggestions/thumbnails', requireAuth, async (req, res) => {
  const v = viewable(req);
  if (!canPlay(v, req.user) || v.status !== 'ready' || !v.file_path) throw new HttpError(400, 'The video is not ready');
  const time = Math.max(0, Math.min((v.duration || 0) - 0.05, Number(req.body?.time) || 0));
  if (db.prepare('SELECT COUNT(*) AS n FROM thumbnail_suggestions WHERE video_id = ? AND user_id = ?').get(v.id, req.user.id).n >= 3) {
    throw new HttpError(429, 'You can suggest up to 3 thumbnails for a video');
  }
  const id = newId();
  const file = `sugg-${v.id}-${id}.jpg`;
  await grabFrame(path.join(DIRS.videos, v.file_path), time, path.join(DIRS.thumbs, file));
  db.prepare('INSERT INTO thumbnail_suggestions (id, video_id, user_id, time_s, file, votes, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, v.id, req.user.id, time, file, now());
  vote('thumbnail', id, req.user.id);
  res.status(201).json(suggestionsFor(v, req.user));
});

function suggestion(req) {
  const kind = req.params.kind === 'titles' ? 'title' : req.params.kind === 'thumbnails' ? 'thumbnail' : null;
  if (!kind) throw new HttpError(404, 'Not found');
  const s = db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(String(req.params.sid));
  if (!s) throw new HttpError(404, 'Suggestion not found');
  const v = loadVideo(s.video_id);
  if (!v || !canView(v, req.user)) throw new HttpError(404, 'Suggestion not found');
  return { kind, s, v };
}

watchingRouter.post('/suggestions/:kind/:sid/vote', requireAuth, (req, res) => {
  const { kind, s, v } = suggestion(req);
  const had = db.prepare('SELECT 1 FROM suggestion_votes WHERE kind = ? AND suggestion_id = ? AND user_id = ?').get(kind, s.id, req.user.id);
  if (had) {
    db.prepare('DELETE FROM suggestion_votes WHERE kind = ? AND suggestion_id = ? AND user_id = ?').run(kind, s.id, req.user.id);
    db.prepare(`UPDATE ${TABLE[kind]} SET votes = MAX(0, votes - 1) WHERE id = ?`).run(s.id);
  } else vote(kind, s.id, req.user.id);
  res.json(suggestionsFor(v, req.user));
});

function deleteSuggestion(kind, s) {
  db.prepare(`DELETE FROM ${TABLE[kind]} WHERE id = ?`).run(s.id);
  db.prepare('DELETE FROM suggestion_votes WHERE kind = ? AND suggestion_id = ?').run(kind, s.id);
  if (kind === 'thumbnail') try { fs.unlinkSync(path.join(DIRS.thumbs, s.file)); } catch {}
}

watchingRouter.delete('/suggestions/:kind/:sid', requireAuth, (req, res) => {
  const { kind, s, v } = suggestion(req);
  if (!(s.user_id === req.user.id || canManage(v, req.user))) throw new HttpError(403, 'You cannot remove that suggestion');
  deleteSuggestion(kind, s);
  res.json(suggestionsFor(v, req.user));
});

// The uploader takes a community suggestion as the real title or thumbnail.
watchingRouter.post('/suggestions/:kind/:sid/adopt', requireAuth, (req, res) => {
  const { kind, s, v } = suggestion(req);
  if (!canEdit(v, req.user)) throw new HttpError(403, 'Only the uploader can use a suggestion');
  if (kind === 'title') {
    db.prepare('UPDATE videos SET title = ? WHERE id = ?').run(s.title.slice(0, 120), v.id);
    indexVideo(v.id);
  } else {
    const name = `${v.id}-${Date.now()}.jpg`;
    fs.copyFileSync(path.join(DIRS.thumbs, s.file), path.join(DIRS.thumbs, name));
    if (v.thumb_path) try { fs.unlinkSync(path.join(DIRS.thumbs, v.thumb_path)); } catch {}
    db.prepare('UPDATE videos SET thumb_path = ?, custom_thumb = 1 WHERE id = ?').run(name, v.id);
  }
  deleteSuggestion(kind, s);
  touchVideo(v.id);
  logAction(req.user, `suggestion.adopt_${kind}`, { targetType: 'video', targetId: v.id, targetLabel: v.title });
  res.json(suggestionsFor(loadVideo(v.id), req.user));
});

// ---- media: HLS, federation MP4, captions, originals ----------------------------------------------------

export const watchingMediaRouter = Router();

const HLS_TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4' };

watchingMediaRouter.get('/hls/:dir/:file', (req, res) => {
  const dir = String(req.params.dir);
  const file = String(req.params.file);
  const m = /^([A-Za-z0-9_-]+)-v(\d+)$/.exec(dir);
  if (!m || !/^[a-z0-9-]+\.(m3u8|m4s|mp4)$/.test(file)) throw new HttpError(404, 'Not found');
  const v = db.prepare('SELECT id, user_id, visibility, status, moderation_status FROM videos WHERE id = ?').get(m[1]);
  if (!v || !canPlay(v, req.user)) throw new HttpError(404, 'Not found');
  const full = path.join(DIRS.hls, dir, file);
  if (!fs.existsSync(full)) throw new HttpError(404, 'Not found');
  // Folders are versioned, so they can be cached for a long time.
  res.sendFile(full, { acceptRanges: true, cacheControl: true, maxAge: '30d', headers: { 'Content-Type': HLS_TYPES[path.extname(file)] } });
});

watchingMediaRouter.get('/renditions/:file', (req, res) => {
  const file = String(req.params.file);
  const m = /^([A-Za-z0-9_-]+)-v\d+-720\.mp4$/.exec(file);
  if (!m) throw new HttpError(404, 'Not found');
  const v = db.prepare('SELECT id, user_id, visibility, status, moderation_status FROM videos WHERE id = ?').get(m[1]);
  if (!v || !canPlay(v, req.user)) throw new HttpError(404, 'Not found');
  const full = path.join(DIRS.renditions, file);
  if (!fs.existsSync(full)) throw new HttpError(404, 'Not found');
  res.sendFile(full, { acceptRanges: true, cacheControl: true, maxAge: '30d', headers: { 'Content-Type': 'video/mp4' } });
});

watchingMediaRouter.get('/captions/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.vtt$/, '');
  const c = db.prepare('SELECT * FROM captions WHERE id = ?').get(id);
  const v = c && loadVideo(c.video_id);
  if (!c || !v || !canView(v, req.user)) throw new HttpError(404, 'Not found');
  if (c.status !== 'published' && !(canManage(v, req.user) || c.submitted_by === req.user?.id)) throw new HttpError(404, 'Not found');
  res.sendFile(path.join(DIRS.captions, c.file), { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=300' } });
});

/** The best "original" there is: the upload itself, else the unedited processed file, else the published one. */
export function originalFile(v) {
  const candidates = [
    v.original_path && path.join(DIRS.originals, v.original_path),
    v.base_path && path.join(DIRS.videos, v.base_path),
    v.file_path && path.join(DIRS.videos, v.file_path),
  ].filter(Boolean);
  for (const f of candidates) if (fs.existsSync(f)) return { file: f, size: fs.statSync(f).size, upload: f === candidates[0] && !!v.original_path };
  return null;
}

export const canDownloadOriginal = (v, user) => canPlay(v, user) && (canEdit(v, user) || !!v.allow_original_download);

watchingMediaRouter.get('/original/:id', (req, res) => {
  const v = loadVideo(String(req.params.id));
  if (!v || !canDownloadOriginal(v, req.user)) throw new HttpError(404, 'Not found');
  const o = originalFile(v);
  if (!o) throw new HttpError(404, 'The original file is gone');
  const ext = path.extname(o.file) || '.mp4';
  const base = (v.original_name ? path.basename(v.original_name, path.extname(v.original_name)) : v.title).replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || v.id;
  res.download(o.file, `${base}${ext}`);
});

/** Removes caption files of a deleted video. */
export function removeWatchingFiles(id) {
  for (const [dir, prefix] of [[DIRS.captions, `${id}-`], [DIRS.thumbs, `sugg-${id}-`]]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) if (n.startsWith(prefix)) try { fs.unlinkSync(path.join(dir, n)); } catch {}
  }
}
