import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { DIRS, VIDEO_EXTENSIONS, IMAGE_EXTENSIONS } from './config.js';
import { getSettings } from './db.js';
import { HttpError, newId } from './util.js';

const tmpStorage = multer.diskStorage({
  destination: DIRS.tmp,
  filename: (req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
});

function extFilter(allowed, label) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.has(ext)) return cb(new HttpError(400, `${label}: unsupported file type ${ext || '(none)'}`));
    cb(null, true);
  };
}

/** Video upload middleware. The size limit is read from settings on every request. */
export function videoUpload(req, res, next) {
  const maxMb = Number(getSettings().max_upload_mb) || 8192;
  const mw = multer({
    storage: tmpStorage,
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: extFilter(VIDEO_EXTENSIONS, 'Video'),
  }).single('file');
  mw(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `File is larger than the ${maxMb} MB upload limit`));
    next(err);
  });
}

export function imageUpload(field) {
  return multer({
    storage: tmpStorage,
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: extFilter(IMAGE_EXTENSIONS, 'Image'),
  }).single(field);
}

export function discard(file) {
  if (!file) return;
  try { fs.unlinkSync(file.path); } catch {}
}
