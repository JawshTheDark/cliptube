import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);

const DEFAULT_SITE = { site_name: 'ClipTube', allow_registration: true, needs_setup: false, max_upload_mb: 8192 };

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined while loading
  const [site, setSite] = useState(DEFAULT_SITE);

  const refresh = useCallback(async () => {
    const [me, s] = await Promise.all([api('/auth/me'), api('/site')]);
    setUser(me.user);
    setSite(s);
  }, []);

  useEffect(() => {
    refresh().catch(() => setUser(null));
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const value = { user, setUser, site, setSite, refresh, logout, loading: user === undefined };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}

/** Sets the browser tab title as "<title> - <site name>". */
export function useTitle(title) {
  const { site } = useAuth();
  useEffect(() => {
    document.title = title ? `${title} - ${site.site_name}` : site.site_name;
  }, [title, site.site_name]);
}
