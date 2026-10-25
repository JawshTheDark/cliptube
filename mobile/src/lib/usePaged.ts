import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from './api';

const PAGE = 24;

type State<T> = { items: T[]; hasMore: boolean; loading: boolean; refreshing: boolean; error: string | null };

/**
 * Loads a paginated list (`?limit=&offset=` returning `{ videos, has_more }`, or any key via `pick`).
 * Pass `null` as the path to wait (e.g. until signed in).
 */
export function usePaged<T = any>(api: Api, path: string | null, pick: (r: any) => T[] = (r) => r.videos, paged = true) {
  const [state, setState] = useState<State<T>>({ items: [], hasMore: false, loading: !!path, refreshing: false, error: null });
  const gen = useRef(0);
  const busy = useRef(false);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!path) return { items: [] as T[], hasMore: false };
      const sep = path.includes('?') ? '&' : '?';
      const r = await api.get(paged ? `${path}${sep}limit=${PAGE}&offset=${offset}` : path);
      const items = pickRef.current(r) || [];
      return { items, hasMore: paged ? (r.has_more ?? items.length === PAGE) : false };
    },
    [api, path, paged],
  );

  const reload = useCallback(
    async (refreshing = false) => {
      const g = ++gen.current;
      busy.current = true;
      setState((s) => ({ ...s, loading: !refreshing, refreshing, error: null, ...(refreshing ? {} : { items: [] }) }));
      try {
        const page = await fetchPage(0);
        if (g === gen.current) setState({ items: page.items, hasMore: page.hasMore, loading: false, refreshing: false, error: null });
      } catch (e: any) {
        if (g === gen.current) setState((s) => ({ ...s, loading: false, refreshing: false, error: e.message }));
      } finally {
        if (g === gen.current) busy.current = false;
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    if (path) reload();
    else setState({ items: [], hasMore: false, loading: false, refreshing: false, error: null });
  }, [path, reload]);

  const loadMore = useCallback(async () => {
    if (busy.current || !state.hasMore) return;
    const g = gen.current;
    busy.current = true;
    try {
      const page = await fetchPage(state.items.length);
      if (g !== gen.current) return;
      setState((s) => {
        // A clip published between pages shifts the offsets; skip anything already shown.
        const seen = new Set(s.items.map((x: any) => x.id));
        return { ...s, items: [...s.items, ...page.items.filter((x: any) => !seen.has(x.id))], hasMore: page.hasMore };
      });
    } catch (e: any) {
      if (g === gen.current) setState((s) => ({ ...s, error: e.message }));
    } finally {
      if (g === gen.current) busy.current = false;
    }
  }, [fetchPage, state.hasMore, state.items.length]);

  const setItems = useCallback((fn: (items: T[]) => T[]) => setState((s) => ({ ...s, items: fn(s.items) })), []);

  return { ...state, reload, refresh: () => reload(true), loadMore, setItems };
}
