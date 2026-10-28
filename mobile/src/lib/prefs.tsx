import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

/**
 * Watching preferences kept on this phone, the website's per-browser ones under the same names and defaults
 * (web/src/util.js PREF_DEFAULTS): skipping marked parts, community titles, captions, keeping Shorts off Home,
 * and anonymous mode.
 */
export type Prefs = {
  skip: 'auto' | 'ask' | 'off';
  community: 'on' | 'off';
  captions: 'on' | 'off';
  hide_vertical: 'on' | 'off';
  anonymous: 'on' | 'off';
};
const DEFAULTS: Prefs = { skip: 'ask', community: 'off', captions: 'off', hide_vertical: 'off', anonymous: 'off' };
const KEY = 'prefs';

type Ctx = { prefs: Prefs; setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void };
const PrefsCtx = createContext<Ctx>({ prefs: DEFAULTS, setPref: () => {} });

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((raw) => raw && setPrefs({ ...DEFAULTS, ...JSON.parse(raw) }))
      .catch(() => {});
  }, []);
  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => {
      const next = { ...p, [key]: value };
      SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);
  return <PrefsCtx.Provider value={value}>{children}</PrefsCtx.Provider>;
}

export const usePrefs = () => useContext(PrefsCtx);

/** The title and thumbnail to show: the community's when the viewer chose them (as the website's displayed()). */
export function useDisplayed() {
  const on = usePrefs().prefs.community === 'on';
  return useCallback(
    (v: { title: string; thumbnail_url?: string | null; community?: { title?: string | null; thumbnail_url?: string | null } | null }) => ({
      title: (on && v.community?.title) || v.title,
      thumbnail_url: (on && v.community?.thumbnail_url) || v.thumbnail_url || null,
    }),
    [on],
  );
}
