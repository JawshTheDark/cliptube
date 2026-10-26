// How much room OurTube takes, and the limit an admin can set for the whole server (on top of each person's
// quota). The size is read from the data folder, so it covers everything: videos, adaptive streaming, thumbnails,
// backups. New uploads are refused when they would go over the limit, or leave less than 1 GB free on the disk:
// a full disk can damage the database.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './db.js';
import { DATA_DIR } from './config.js';
import { HttpError } from './util.js';

const MIN_FREE = 1024 ** 3;
const GB = 1024 ** 3;

export function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          bytes += fs.statSync(p).size;
          files++;
        } catch {}
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

let usedCache = null;
/** The data folder's size (read again at most once a minute), the limit, and the disk's free space. */
export function serverStorage() {
  if (!usedCache || Date.now() - usedCache.at > 60_000) usedCache = { at: Date.now(), bytes: dirSize(DATA_DIR).bytes };
  let disk = { free: null, total: null };
  try {
    const s = fs.statfsSync(DATA_DIR);
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {}
  return { used: usedCache.bytes, limit: (Number(getSettings().storage_limit_gb) || 0) * GB, disk_free: disk.free, disk_total: disk.total };
}

const gb = (n) => `${(n / GB).toFixed(1)} GB`;

/** Refuses `incoming` more bytes when the server would go over its limit or nearly fill its disk. */
export function checkServerSpace(incoming = 0) {
  const s = serverStorage();
  if (s.limit > 0 && s.used + incoming > s.limit) {
    throw new HttpError(413, `This server has reached its storage limit (${gb(s.used)} of ${gb(s.limit)} used), so it can't take this. Ask an admin to make room.`);
  }
  if (s.disk_free !== null && s.disk_free - incoming < MIN_FREE) {
    throw new HttpError(413, `This server's disk is nearly full (${gb(s.disk_free)} free), so it can't take this. Ask an admin to make room.`);
  }
}
