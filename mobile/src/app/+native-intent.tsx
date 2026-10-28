/**
 * Opens OurTube web links in the app: https://<server>/watch/<id> becomes /watch/<id>?server=<server>,
 * so a link from another OurTube server loads from that server.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (!/^https?:\/\//i.test(path)) return path;
    const u = new URL(path);
    if (/^\/(watch|shorts|c|n|g|playlist|party|live)\//.test(u.pathname)) return `${u.pathname}?server=${encodeURIComponent(u.origin)}`;
    // A comparison someone shared.
    if (u.pathname === '/compare') return '/compare' + u.search + (u.search ? '&' : '?') + 'server=' + encodeURIComponent(u.origin);
    // The links in password-reset and confirmation emails.
    const token = u.searchParams.get('token');
    if (token && (u.pathname === '/reset-password' || u.pathname === '/verify-email')) {
      return `/forgot-password?token=${encodeURIComponent(token)}&mode=${u.pathname === '/verify-email' ? 'verify' : 'reset'}&server=${encodeURIComponent(u.origin)}`;
    }
    return '/';
  } catch {
    return '/';
  }
}
