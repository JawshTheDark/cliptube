/**
 * Opens ClipTube web links in the app: https://<server>/watch/<id> becomes /watch/<id>?server=<server>,
 * so a link from another ClipTube server loads from that server.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (!/^https?:\/\//i.test(path)) return path;
    const u = new URL(path);
    if (/^\/(watch|c|n|g)\//.test(u.pathname)) return `${u.pathname}?server=${encodeURIComponent(u.origin)}`;
    return '/';
  } catch {
    return '/';
  }
}
