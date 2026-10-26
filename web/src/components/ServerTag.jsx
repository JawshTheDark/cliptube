import { useAuth } from '../auth.jsx';

// No reds: red means live.
const COLORS = ['#f59e0b', '#22c55e', '#38bdf8', '#f472b6', '#a78bfa', '#2dd4bf', '#facc15', '#60a5fa', '#c084fc', '#fb923c'];

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

/** A server's color comes from its address, so it is the same on every server in the network. */
export function serverColor(host) {
  let h = 0;
  for (const c of host.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** What a server runs, for people: `software` from the site's network_peers (ourtube, peertube, mastodon ...). */
export function softwareName(software) {
  if (!software) return null;
  if (software === 'ourtube') return 'OurTube';
  if (software === 'peertube') return 'PeerTube';
  return software.charAt(0).toUpperCase() + software.slice(1);
}

/**
 * The server a video, channel or stream lives on: `remote` ({ peer_id, peer_name, peer_url }) for another server,
 * nothing for this one. This server is only named when it is part of a network.
 */
export function useServer(remote) {
  const { site } = useAuth();
  if (remote) {
    const peer = (site.network_peers || []).find((p) => p.id === remote.peer_id || p.url === remote.peer_url);
    return { name: remote.peer_name || hostOf(remote.peer_url), host: hostOf(remote.peer_url), local: false, software: peer?.software || null };
  }
  if (!site.federation || !(site.network_peers || []).length) return null;
  return { name: site.site_name, host: site.ap_host || window.location.host, local: true, software: 'ourtube' };
}

/** `after` follows the tag only when it shows (a separator, say). */
export function ServerTag({ remote, className = '', after = null }) {
  const s = useServer(remote);
  if (!s) return null;
  const tag = (
    <span
      className={`server-tag ${className}`}
      title={s.local ? `On this server (${s.host})` : `On ${s.host}${s.software ? `, a ${softwareName(s.software)} server` : ''}`}
    >
      <span className="server-dot" style={{ background: serverColor(s.host) }} />
      <span className="ellipsis">{s.name}</span>
    </span>
  );
  return after ? (
    <>
      {tag}
      {after}
    </>
  ) : (
    tag
  );
}
