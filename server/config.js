import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
// Lets federation talk to localhost / LAN addresses. Only for testing two instances on one machine.
export const ALLOW_PRIVATE_FEDERATION =
  process.argv.includes('--allow-private-federation') || process.env.FEDERATION_ALLOW_PRIVATE === '1';
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
// Port: `--port N` argument wins (used by the dev script), then the PORT env var, then 3000.
const portArg = process.argv.indexOf('--port');
export const PORT = (portArg >= 0 && Number(process.argv[portArg + 1])) || Number(process.env.PORT) || 3000;
// `--log` prints every request (used by the dev script).
export const LOG_REQUESTS = process.argv.includes('--log') || process.env.LOG_REQUESTS === '1';
export const HOST = process.env.HOST || '0.0.0.0';

export const DIRS = {
  originals: path.join(DATA_DIR, 'originals'),
  videos: path.join(DATA_DIR, 'videos'),
  thumbs: path.join(DATA_DIR, 'thumbs'),
  avatars: path.join(DATA_DIR, 'avatars'),
  editor: path.join(DATA_DIR, 'editor'),
  tmp: path.join(DATA_DIR, 'tmp'),
};

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.ts', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.mts', '.m2ts',
]);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
