import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

/**
 * How much fits on a screen of videos (App settings → Density, the same three as the website's Layout density). Each
 * step makes the cards, their text and the Shorts smaller, and the smaller cards fit more across: Dense puts two
 * across a phone held upright, like the website.
 */
export type Density = 'comfortable' | 'compact' | 'dense';

export const DENSITIES: { key: Density; label: string; hint: string }[] = [
  { key: 'comfortable', label: 'Comfortable', hint: 'Big cards: one across a phone held upright' },
  { key: 'compact', label: 'Compact', hint: 'Smaller cards and text, more across on wider screens' },
  { key: 'dense', label: 'Dense', hint: 'The smallest cards: two across a phone, more on a tablet' },
];

const KEY = 'density';
// minCard: the narrowest a feed card gets before one fewer fits across. 320 gives one across a phone, two across a
// tablet held upright and four across one on its side.
const SPEC: Record<Density, { minCard: number; scale: number }> = {
  comfortable: { minCard: 320, scale: 1 },
  compact: { minCard: 260, scale: 0.9 },
  dense: { minCard: 190, scale: 0.8 },
};

type Ctx = { density: Density; setDensity: (d: Density) => void; minCard: number; scale: number };
const DensityCtx = createContext<Ctx>({ density: 'comfortable', setDensity: () => {}, ...SPEC.comfortable });

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, set] = useState<Density>('comfortable');
  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((v) => v && v in SPEC && set(v as Density))
      .catch(() => {});
  }, []);
  const setDensity = useCallback((d: Density) => {
    set(d);
    SecureStore.setItemAsync(KEY, d).catch(() => {});
  }, []);
  const value = useMemo(() => ({ density, setDensity, ...SPEC[density] }), [density, setDensity]);
  return <DensityCtx.Provider value={value}>{children}</DensityCtx.Provider>;
}

export const useDensity = () => useContext(DensityCtx);
