import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Api, normalizeServerUrl } from './api';
import { useSession } from './session';

/**
 * A link shared from another ClipTube server (https://clips.example/watch/x) opens with `?server=`.
 * Screens then read from that server, signed out, until the person switches to it.
 */
type Scope = { api: Api; foreign: string | null };

const ScopeCtx = createContext<Scope | null>(null);

export function useLinkedApi(serverParam?: string | string[]): Scope {
  const { api, server } = useSession();
  const param = Array.isArray(serverParam) ? serverParam[0] : serverParam;
  return useMemo(() => {
    if (!param) return { api, foreign: null };
    try {
      const url = normalizeServerUrl(param);
      return url === server ? { api, foreign: null } : { api: new Api(url), foreign: url };
    } catch {
      return { api, foreign: null };
    }
  }, [param, api, server]);
}

export function ApiScope({ value, children }: { value: Scope; children: ReactNode }) {
  return <ScopeCtx.Provider value={value}>{children}</ScopeCtx.Provider>;
}

/** The client for this part of the screen: a linked server's, or the active one. */
export function useScope(): Scope {
  const scoped = useContext(ScopeCtx);
  const { api } = useSession();
  return scoped || { api, foreign: null };
}

/** Adds `?server=` to an app path when browsing another server's content. */
export function withServer(path: string, foreign: string | null): string {
  if (!foreign) return path;
  return `${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(foreign)}`;
}
