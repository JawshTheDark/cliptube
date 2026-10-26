import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Api, ApiError, normalizeServerUrl } from './api';
import type { Site, User } from './types';

/**
 * Where the first-launch screen looks for server suggestions: the OurTube network's hub, which lists the
 * servers in it. Only a suggestion; nothing is chosen for the user.
 */
export const NETWORK_DIRECTORY = 'https://clips.irc.so';

export type SavedServer = { url: string; name: string };

type RegisterInput = { username: string; password: string; display_name?: string; invite?: string; accept_terms?: boolean };

type Session = {
  ready: boolean;
  /** No server chosen yet: first launch, or every server was removed. */
  needsSetup: boolean;
  /** The server the app opens on. */
  main: string | null;
  server: string;
  servers: SavedServer[];
  site: Site | null;
  siteError: string | null;
  user: User | null;
  api: Api;
  unread: number;
  setUnread: (n: number) => void;
  refresh: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<{ pending?: boolean; message?: string }>;
  signOut: () => Promise<void>;
  addServer: (input: string) => Promise<SavedServer>;
  switchServer: (url: string) => Promise<void>;
  removeServer: (url: string) => Promise<void>;
  /** Makes a server the main one (adding it first if needed) and switches to it. */
  setMain: (input: string) => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

// SecureStore keys may only hold letters, digits, ".", "-" and "_".
const tokenKey = (url: string) => `token_${url.replace(/[^A-Za-z0-9]/g, '_')}`;
const SERVERS_KEY = 'servers';
const ACTIVE_KEY = 'active_server'; // 1.1 and before: the server the app was last on
const MAIN_KEY = 'main_server';

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Checks that an address is an OurTube server and returns its site info. */
export async function probeServer(url: string): Promise<Site> {
  const site = await new Api(url).get<Site>('/site').catch((e) => {
    throw new Error(e instanceof ApiError && e.status ? `${url} answered, but it doesn't look like an OurTube server` : e.message);
  });
  if (!site || typeof site.site_name !== 'string') throw new Error(`${url} doesn't look like an OurTube server`);
  return site;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [main, setMainState] = useState<string | null>(null);
  const [server, setServer] = useState('');
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const api = useMemo(() => new Api(server, token), [server, token]);
  const apiRef = useRef(api);
  apiRef.current = api;

  /** Loads the site info and who we are on the active server. A rejected token signs out quietly. */
  const load = useCallback(async (url: string, tok: string | null) => {
    const a = new Api(url, tok);
    setSiteError(null);
    const [s, me] = await Promise.all([
      a.get<Site>('/site').catch((e) => {
        setSiteError(e.message);
        return null;
      }),
      tok ? a.get<{ user: User | null }>('/auth/me').catch(() => undefined) : Promise.resolve({ user: null }),
    ]);
    if (s) setSite(s);
    // undefined: the server couldn't be reached, so keep the token and try again later.
    if (me !== undefined) {
      setUser(me.user);
      if (tok && !me.user) {
        await SecureStore.deleteItemAsync(tokenKey(url)).catch(() => {});
        setToken(null);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const saved = await readJson<SavedServer[]>(SERVERS_KEY, []);
      if (!saved.length) {
        // First launch: the user picks a server; there's no default.
        setNeedsSetup(true);
        setReady(true);
        return;
      }
      let home = await SecureStore.getItemAsync(MAIN_KEY).catch(() => null);
      if (!home || !saved.some((s) => s.url === home)) {
        // Updating from 1.1: the server the app was last on becomes the main one.
        const last = await SecureStore.getItemAsync(ACTIVE_KEY).catch(() => null);
        home = last && saved.some((s) => s.url === last) ? last : saved[0].url;
        await SecureStore.setItemAsync(MAIN_KEY, home).catch(() => {});
      }
      // The app opens on the main server, whichever one it was on last time.
      const tok = await SecureStore.getItemAsync(tokenKey(home)).catch(() => null);
      setServers(saved);
      setMainState(home);
      setServer(home);
      setToken(tok);
      setReady(true);
      await load(home, tok);
    })();
  }, [load]);

  const refresh = useCallback(() => load(server, token), [load, server, token]);

  // Unread notifications: on start, when the app comes back to the foreground, and every minute.
  useEffect(() => {
    if (!user) {
      setUnread(0);
      return;
    }
    const poll = () =>
      apiRef.current
        .get<{ unread: number }>('/notifications/count')
        .then((r) => setUnread(r.unread))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 60_000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && poll());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [user, server]);

  const saveServers = async (list: SavedServer[]) => {
    setServers(list);
    await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(list));
  };

  const startSession = async (res: { user: User; token?: string }) => {
    if (!res.token) {
      throw new Error('This server runs an older OurTube that the app can’t sign in to. Ask its admin to update to 1.5 or newer.');
    }
    await SecureStore.setItemAsync(tokenKey(server), res.token);
    setToken(res.token);
    setUser(res.user);
  };

  const signIn = async (username: string, password: string) => {
    const res = await new Api(server).post<{ user: User; token?: string }>('/auth/login', { username: username.trim(), password, return_token: true });
    await startSession(res);
  };

  const register = async (input: RegisterInput) => {
    const res = await new Api(server).post<{ user?: User; token?: string; pending?: boolean; message?: string }>('/auth/register', {
      ...input,
      username: input.username.trim(),
      return_token: true,
    });
    if (res.pending) return { pending: true, message: res.message };
    await startSession(res as { user: User; token?: string });
    return {};
  };

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => {});
    await SecureStore.deleteItemAsync(tokenKey(server)).catch(() => {});
    setToken(null);
    setUser(null);
  };

  const addServer = async (input: string) => {
    const url = normalizeServerUrl(input);
    const s = await probeServer(url);
    const entry = { url, name: s.site_name };
    const list = servers.some((x) => x.url === url) ? servers.map((x) => (x.url === url ? entry : x)) : [...servers, entry];
    await saveServers(list);
    return entry;
  };

  const switchServer = async (url: string) => {
    const tok = await SecureStore.getItemAsync(tokenKey(url)).catch(() => null);
    setServer(url);
    setToken(tok);
    setUser(null);
    setSite(null);
    setUnread(0);
    await load(url, tok);
  };

  const removeServer = async (url: string) => {
    const tok = await SecureStore.getItemAsync(tokenKey(url)).catch(() => null);
    if (tok) await new Api(url, tok).post('/auth/logout').catch(() => {});
    await SecureStore.deleteItemAsync(tokenKey(url)).catch(() => {});
    const list = servers.filter((x) => x.url !== url);
    await saveServers(list);
    if (!list.length) {
      // Nothing left: back to choosing a server.
      await SecureStore.deleteItemAsync(MAIN_KEY).catch(() => {});
      setMainState(null);
      setServer('');
      setToken(null);
      setUser(null);
      setSite(null);
      setNeedsSetup(true);
      return;
    }
    let home = main;
    if (url === main || !home) {
      home = list[0].url;
      await SecureStore.setItemAsync(MAIN_KEY, home);
      setMainState(home);
    }
    if (url === server) await switchServer(home);
  };

  const setMain = async (input: string) => {
    const url = normalizeServerUrl(input);
    if (!servers.some((x) => x.url === url)) await addServer(url);
    await SecureStore.setItemAsync(MAIN_KEY, url);
    setMainState(url);
    setNeedsSetup(false);
    if (url !== server) await switchServer(url);
  };

  const value: Session = {
    ready,
    needsSetup,
    main,
    server,
    servers,
    site,
    siteError,
    user,
    api,
    unread,
    setUnread,
    refresh,
    signIn,
    register,
    signOut,
    addServer,
    switchServer,
    removeServer,
    setMain,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
