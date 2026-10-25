import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export function formatDuration(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export function compact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function plural(n, word) {
  return `${compact(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
}

export function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts) / 1000;
  const units = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [secs, name] of units) {
    if (diff >= secs) {
      const n = Math.floor(diff / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** Parses "1:23" / "1:02:03" into seconds. */
export function parseTimestamp(s) {
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Copies text to the clipboard, with a fallback for plain-http LAN hosts where navigator.clipboard is unavailable. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** Paged list loader for endpoints that return { videos, has_more }. */
export function usePaged(url, pageSize = 24) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setItems([]);
    setPage(0);
    setHasMore(true);
    setError(null);
  }, [url]);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    const sep = url.includes('?') ? '&' : '?';
    api(`${url}${sep}limit=${pageSize}&offset=${page * pageSize}`)
      .then((r) => {
        if (dead) return;
        setItems((x) => (page === 0 ? r.videos : [...x, ...r.videos]));
        setHasMore(!!r.has_more);
      })
      .catch((e) => !dead && setError(e))
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
    };
  }, [url, page, pageSize]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) setPage((p) => p + 1);
  }, [loading, hasMore]);

  return { items, hasMore, loading, error, loadMore };
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const h = (e) => setMatches(e.matches);
    mq.addEventListener('change', h);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', h);
  }, [query]);
  return matches;
}

/** Anonymous mode: watching doesn't touch history or count as you (per browser). */
export function isAnonymous() {
  try {
    return localStorage.getItem('ct_anon') === '1';
  } catch {
    return false;
  }
}

export function setAnonymous(on) {
  try {
    localStorage.setItem('ct_anon', on ? '1' : '0');
  } catch {}
}

export const VISIBILITY_HELP = {
  public: 'Anyone can find and watch this video.',
  unlisted: 'Only people with the link can watch. It will not show up in listings or search.',
  private: 'Only you (and admins) can watch this video.',
};
