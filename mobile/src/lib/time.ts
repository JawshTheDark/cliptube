import { parseStamp } from '@/components/RichText';
import { duration } from './format';

/** Seconds -> "1:05.3", like the website's clip and segment times. */
export function precise(sec: number | null | undefined): string {
  const s = Math.max(0, Number(sec) || 0);
  const whole = Math.floor(s);
  const tenth = Math.min(9, Math.floor((s - whole) * 10 + 1e-6));
  return `${duration(whole)}.${tenth}`;
}

/** Seconds for a link: whole numbers stay whole, otherwise one decimal. */
export function urlSeconds(sec: number): string {
  const r = Math.round((Number(sec) || 0) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export type Chapter = { start: number; title: string };

/**
 * Chapters from a description, the way the website reads them (web/src/util.js parseChapters): lines like
 * "0:00 Intro" or "Intro - 1:23", at least two, in order. A first chapter that starts late gets an untitled one
 * before it.
 */
export function parseChapters(text: string | null | undefined, length = Infinity): Chapter[] {
  const ts = String.raw`[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?`;
  const first = new RegExp(String.raw`^\s*${ts}\s*[-–—:|.]?\s*(.*?)\s*$`);
  const last = new RegExp(String.raw`^\s*(.+?)\s*[-–—:|]?\s*${ts}\s*$`);
  const out: Chapter[] = [];
  for (const line of String(text || '').split('\n')) {
    let m = first.exec(line);
    let stamp = m?.[1];
    let title = m?.[2];
    if (!m && (m = last.exec(line))) [stamp, title] = [m[2], m[1]];
    if (!stamp) continue;
    const start = parseStamp(stamp);
    if (start === null || start >= length || (out.length && start <= out[out.length - 1].start)) continue;
    out.push({ start, title: (title || '').replace(/^[-–—:|.\s]+/, '').slice(0, 100) });
  }
  if (out.length < 2) return [];
  if (out[0].start > 0) out.unshift({ start: 0, title: '' });
  return out;
}

/** The chapter playing at `t`. */
export function chapterAt(chapters: Chapter[], t: number): number {
  let i = -1;
  for (let k = 0; k < chapters.length; k++) if (chapters[k].start <= t + 0.05) i = k;
  return i;
}

export type Cue = { start: number; end: number; text: string };

const cueTime = (s: string) => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
};

/**
 * The cues of a WebVTT file (the server turns SRT uploads into WebVTT). Styling tags are dropped, as the native
 * player can't show captions from a separate file and the app draws them itself.
 */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = cueTime(a);
    const end = cueTime((b || '').trim().split(/\s+/)[0] || '');
    if (start === null || end === null) continue;
    const body = lines
      .slice(at + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** The text showing at `t` (overlapping cues stack). */
export function cueText(cues: Cue[], t: number): string {
  const on: string[] = [];
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end) on.push(c.text);
  }
  return on.join('\n');
}
