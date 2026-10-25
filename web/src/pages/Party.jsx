import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Player } from '../components/Player.jsx';
import { Icon } from '../components/Icons.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Empty } from '../components/VideoCard.jsx';
import { useToast } from '../components/Toast.jsx';
import { copyText, timeAgo } from '../util.js';

const tokenKey = (id) => `ct_party_${id}`;

/** A video on this site (a /watch/ or /n/ link) as a playlist reference. */
function refFromLink(text) {
  try {
    const u = new URL(String(text).trim(), window.location.origin);
    if (u.origin !== window.location.origin) return null;
    let m = /^\/watch\/([A-Za-z0-9_-]+)/.exec(u.pathname);
    if (m) return `v:${m[1]}`;
    m = /^\/n\/(\d+)\/(.+)$/.exec(u.pathname);
    if (m) return `n:${m[1]}:${decodeURIComponent(m[2])}`;
  } catch {}
  return null;
}

/** The difference between the server's clock and this browser's, from the quickest of a few round trips. */
async function measureOffset(id) {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const r = await api(`/parties/${id}/time`);
    const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: r.now - (t0 + (t1 - t0) / 2) };
  }
  return best.offset;
}

/** Starts a watch party with a video ('v:..' / 'n:..') or a playlist, and opens it. */
export function useStartParty() {
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  return async (body) => {
    if (!user) return nav('/login', { state: { from: window.location.pathname + window.location.search } });
    try {
      const r = await api('/parties', { method: 'POST', body });
      nav(`/party/${r.party.id}`);
    } catch (e) {
      toast(e.message);
    }
  };
}

function JoinForm({ id, onJoined }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const join = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/parties/${id}/join`, { method: 'POST', body: { name } });
      try {
        localStorage.setItem(tokenKey(id), r.token);
      } catch {}
      onJoined(r.token);
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <form className="party-join card-panel" onSubmit={join}>
      <h2>
        <Icon name="group" /> Join the watch party
      </h2>
      <p className="muted">Pick a name the others will see. No account needed.</p>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={32} autoFocus aria-label="Your name" />
      <button className="btn btn-primary" disabled={name.trim().length < 2}>
        Join
      </button>
      <p className="muted small">
        Have an account here? <Link to="/login" state={{ from: `/party/${id}` }}>Sign in</Link> to join as yourself.
      </p>
    </form>
  );
}

/**
 * A watch party: the player follows the party's playback state, corrected against the server's clock (a jump
 * when more than a second off, a slightly faster or slower speed for smaller drift), with the queue, chat,
 * reactions and the people watching.
 */
export default function Party() {
  const { id } = useParams();
  const { user, loading } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(tokenKey(id)) || '';
    } catch {
      return '';
    }
  });
  const headers = !user && token ? { 'x-room-member': token } : {};
  const [party, setParty] = useState(null);
  const [error, setError] = useState(null);
  const [you, setYou] = useState(null);
  const [state, setState] = useState(null);
  const [queue, setQueue] = useState([]);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [video, setVideo] = useState(null);
  const [floats, setFloats] = useState([]);
  const [following, setFollowing] = useState(true);
  const [needsTap, setNeedsTap] = useState(false);
  const [chatText, setChatText] = useState('');
  const [addText, setAddText] = useState('');
  const [myLists, setMyLists] = useState([]);
  const offset = useRef(0);
  const videoRef = useRef(null);
  const ours = useRef(0); // until when player events are our own corrections, not the viewer's
  const stateRef = useRef(null);
  stateRef.current = state;
  const chatEnd = useRef(null);
  useTitle(party?.title ? `${party.title} · Watch party` : 'Watch party');

  const member = !!user || !!token;
  const hostOnline = !!party?.host && members.some((m) => m.id === party.host.member_id);
  const isHost = !!you?.is_host;
  const canControl = !!you && (isHost || party?.control === 'everyone' || (members.length > 0 && !hostOnline));

  // The party, and whether we're in it.
  useEffect(() => {
    if (loading) return;
    api(`/parties/${id}`, { headers })
      .then((r) => {
        setParty(r.party);
        setQueue(r.party.queue);
        setMessages(r.party.messages);
        setState(r.party.state);
        setYou(r.party.you);
      })
      .catch((e) => setError(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token, user?.id, loading]);

  // Live updates once we're a member.
  useEffect(() => {
    if (!party?.id || !member || ended) return undefined;
    measureOffset(id)
      .then((o) => (offset.current = o))
      .catch(() => {});
    const es = new EventSource(`/api/parties/${id}/events${!user && token ? `?member=${encodeURIComponent(token)}` : ''}`);
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on('hello', (d) => {
      setParty(d);
      setQueue(d.queue);
      setMessages(d.messages);
      setState(d.state);
      setYou(d.you);
      setConnected(true);
    });
    on('state', setState);
    on('queue', (d) => setQueue(d.queue));
    on('chat', (m) => setMessages((list) => [...list.slice(-199), m]));
    on('chat_deleted', (d) => setMessages((list) => list.filter((m) => m.id !== d.id)));
    on('members', (d) => setMembers(d.members));
    on('settings', (d) => setParty((p) => ({ ...p, ...d })));
    on('react', (d) => {
      const key = Math.random();
      setFloats((f) => [...f, { key, emoji: d.emoji, left: 8 + Math.random() * 84 }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.key !== key)), 2600);
    });
    on('ended', () => {
      setEnded(true);
      es.close();
    });
    es.onerror = () => setConnected(false); // it reconnects by itself
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.id, member, ended]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  useEffect(() => {
    if (user) api('/playlists/mine').then((r) => setMyLists(r.playlists.filter((p) => p.item_count > 0))).catch(() => {});
  }, [user]);

  // The current video, with its full details (quality levels, captions).
  const current = queue.find((it) => it.id === state?.item_id) || null;
  useEffect(() => {
    if (!current) {
      setVideo(null);
      return undefined;
    }
    let dead = false;
    const ref = current.ref;
    const m = /^n:(\d+):(.+)$/.exec(ref);
    const load = ref.startsWith('v:') ? api(`/videos/${ref.slice(2)}`).then((r) => r.video) : api(`/network/videos/${m[1]}/${encodeURIComponent(m[2])}`).then((r) => r.video);
    load.then((v) => !dead && setVideo(v)).catch(() => !dead && setVideo(current.video));
    ours.current = Date.now() + 2500; // the player starts by itself; that isn't the viewer
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Keep the player where the party is.
  const sync = () => {
    const el = videoRef.current;
    const s = stateRef.current;
    if (!el || !s || !following || el.readyState < 1) return;
    const serverNow = Date.now() + offset.current;
    let want = s.playing ? s.position + (serverNow - s.at) / 1000 : s.position;
    if (el.duration) want = Math.min(want, el.duration);
    const mark = () => (ours.current = Date.now() + 800);
    if (s.playing && el.paused && !el.ended) {
      mark();
      el.play().catch(() => setNeedsTap(true));
    } else if (!s.playing && !el.paused) {
      mark();
      el.pause();
    }
    const drift = el.currentTime - want;
    if (Math.abs(drift) > 1 || (!s.playing && Math.abs(drift) > 0.3)) {
      mark();
      el.currentTime = Math.max(0, want);
      el.playbackRate = 1;
    } else if (s.playing && Math.abs(drift) > 0.15) {
      el.playbackRate = drift > 0 ? 0.95 : 1.05;
    } else if (el.playbackRate !== 1) {
      el.playbackRate = 1;
    }
  };
  useEffect(() => {
    sync();
    const t = setInterval(sync, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, video?.id, following]);

  const control = (action, extra = {}) =>
    api(`/parties/${id}/control`, { method: 'POST', headers, body: { action, position: videoRef.current?.currentTime || 0, ...extra } }).catch((e) => toast(e.message));

  // What the viewer does with the player: steer the party, or (without control) step out of it for a while.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    const mine = () => Date.now() > ours.current;
    const onPlay = () => mine() && (canControl ? control('play') : setFollowing(true));
    const onPause = () => mine() && !el.ended && (canControl ? control('pause') : setFollowing(false));
    const onSeeked = () => mine() && canControl && control('seek');
    const onEnded = () => canControl && control('ended', { item_id: stateRef.current?.item_id, position: el.currentTime });
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, canControl]);

  const act = async (fn, done) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast(e.message);
    }
  };
  const sendChat = (e) => {
    e.preventDefault();
    const body = chatText.trim();
    if (!body) return;
    setChatText('');
    act(() => api(`/parties/${id}/chat`, { method: 'POST', headers, body: { body } }));
  };
  const addVideo = (e) => {
    e.preventDefault();
    const ref = refFromLink(addText);
    if (!ref) return toast('Paste a link to a video on this site (or one from Network)');
    setAddText('');
    act(() => api(`/parties/${id}/queue`, { method: 'POST', headers, body: { ref } }), 'Added to the queue');
  };
  const moveItem = (from, to) => {
    if (to < 0 || to >= queue.length) return;
    const ids = queue.map((it) => it.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    act(() => api(`/parties/${id}/queue/order`, { method: 'PUT', headers, body: { item_ids: ids } }));
  };
  const settings = (body) => act(() => api(`/parties/${id}`, { method: 'PATCH', headers, body }));
  const end = () =>
    window.confirm('End the watch party for everyone?') &&
    act(async () => {
      await api(`/parties/${id}`, { method: 'DELETE', headers });
      nav('/');
    });

  if (error) return <Empty icon="group" title={error.status === 404 ? 'This watch party has ended' : error.message} />;
  if (ended) {
    return (
      <Empty icon="group" title="The host ended this watch party">
        <Link to="/">Back home</Link>
      </Empty>
    );
  }
  if (!party || loading) return <div className="spinner" />;
  if (!member) return <JoinForm id={id} onJoined={setToken} />;

  const index = queue.findIndex((it) => it.id === state?.item_id);
  return (
    <div className="party">
      <div className="party-main">
        <div className="player-wrap party-player">
          {video ? (
            <Player video={video} videoRef={videoRef} />
          ) : (
            <div className="player">
              <div className="processing-panel">
                <Icon name="group" size={48} />
                <h2>Nothing in the queue</h2>
                {canControl && <p className="muted">Add a video below to start watching.</p>}
              </div>
            </div>
          )}
          <div className="party-floats" aria-hidden="true">
            {floats.map((f) => (
              <span key={f.key} className="party-float" style={{ left: `${f.left}%` }}>
                {f.emoji}
              </span>
            ))}
          </div>
          {needsTap && (
            <button
              className="party-tap btn btn-primary"
              onClick={() => {
                setNeedsTap(false);
                videoRef.current?.play().catch(() => {});
              }}
            >
              <Icon name="play" /> Join the playback
            </button>
          )}
        </div>

        <div className="party-bar">
          <div className="party-bar-text">
            <h1>{party.title}</h1>
            <div className="muted small">
              Hosted by {party.host?.display_name} · {members.length} watching
              {!connected && ' · reconnecting…'}
              {canControl && !isHost && ' · you can steer'}
            </div>
          </div>
          <div className="party-bar-tools">
            {!following && (
              <button className="btn btn-primary" onClick={() => setFollowing(true)}>
                Back to the party
              </button>
            )}
            {canControl && (
              <>
                <button className="btn btn-icon" title="Previous video" disabled={index <= 0} onClick={() => control('prev')}>
                  <Icon name="first" />
                </button>
                <button className="btn btn-icon" title="Next video" disabled={index < 0 || index >= queue.length - 1} onClick={() => control('next')}>
                  <Icon name="last" />
                </button>
              </>
            )}
            <button className="btn" onClick={async () => toast((await copyText(window.location.href)) ? 'Invite link copied' : 'Could not copy the link')}>
              <Icon name="link" /> Invite
            </button>
            {isHost && (
              <details className="more-menu">
                <summary className="btn btn-icon" title="Party settings">
                  <Icon name="settings" />
                </summary>
                <div className="menu">
                  <label className="menu-item">
                    <input type="checkbox" checked={party.control === 'everyone'} onChange={(e) => settings({ control: e.target.checked ? 'everyone' : 'host' })} /> Everyone can
                    steer
                  </label>
                  <label className="menu-item">
                    <input type="checkbox" checked={!!party.locked} onChange={(e) => settings({ locked: e.target.checked })} /> Lock: nobody new joins
                  </label>
                  <button className="menu-item" onClick={end}>
                    <Icon name="close" /> End the party
                  </button>
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="party-reactions">
          {(party.reactions || []).map((e) => (
            <button key={e} className="party-reaction" onClick={() => act(() => api(`/parties/${id}/react`, { method: 'POST', headers, body: { emoji: e } }))} title={`React ${e}`}>
              {e}
            </button>
          ))}
        </div>

        <section className="party-queue">
          <h2>Queue</h2>
          <ol>
            {queue.map((it, i) => (
              <li key={it.id} className={it.id === state?.item_id ? 'current' : ''}>
                <button className="party-queue-item" disabled={!canControl || !it.available} onClick={() => control('select', { item_id: it.id })} title={canControl ? 'Play this now' : ''}>
                  <span className="playlist-row-n">{it.id === state?.item_id ? '▶' : i + 1}</span>
                  <span className="playlist-row-thumb">{it.thumbnail_url ? <img src={it.thumbnail_url} alt="" loading="lazy" /> : <Icon name="video" />}</span>
                  <span className="playlist-row-text">
                    <span className="playlist-row-title">{it.title}</span>
                    <span className="muted small">{it.available ? it.video?.uploader?.display_name : 'No longer available'}</span>
                  </span>
                </button>
                {canControl && (
                  <span className="playlist-item-tools">
                    <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => moveItem(i, i - 1)}>
                      <Icon name="arrow_up" />
                    </button>
                    <button className="icon-btn" title="Move down" disabled={i === queue.length - 1} onClick={() => moveItem(i, i + 1)}>
                      <Icon name="arrow_down" />
                    </button>
                    <button className="icon-btn" title="Remove from the queue" onClick={() => act(() => api(`/parties/${id}/queue/${it.id}`, { method: 'DELETE', headers }))}>
                      <Icon name="close" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          {canControl && (
            <div className="party-add">
              <form className="follow-form" onSubmit={addVideo}>
                <input className="input" value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Paste a link to a video on this site" aria-label="Video link" />
                <button className="btn" disabled={!addText.trim()}>
                  <Icon name="add" /> Add
                </button>
              </form>
              {myLists.length > 0 && (
                <select
                  className="input"
                  value=""
                  onChange={(e) => e.target.value && act(() => api(`/parties/${id}/queue`, { method: 'POST', headers, body: { playlist_id: e.target.value } }), 'Playlist added to the queue')}
                  aria-label="Add one of your playlists"
                >
                  <option value="">Add one of your playlists…</option>
                  {myLists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.item_count})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="party-side">
        <section className="party-members">
          <h2>Watching ({members.length})</h2>
          <ul>
            {members.map((m) => (
              <li key={m.id}>
                <Avatar user={{ display_name: m.name, username: m.username || m.name, avatar_url: m.avatar_url }} size={28} />
                <span className="party-member-name">{m.name}</span>
                {m.id === party.host?.member_id && <Icon name="star" size={14} className="party-host-star" title="Host" />}
                {m.guest && <span className="badge">guest</span>}
                {isHost && m.id !== you?.member_id && (
                  <button className="icon-btn" title={`Remove ${m.name}`} onClick={() => window.confirm(`Remove ${m.name} from the party?`) && act(() => api(`/parties/${id}/kick`, { method: 'POST', headers, body: { member_id: m.id } }))}>
                    <Icon name="close" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="party-chat">
          <h2>Chat</h2>
          <div className="party-messages">
            {messages.length === 0 && <p className="muted small">Say hi!</p>}
            {messages.map((m) => (
              <div key={m.id} className={`party-message ${m.member_id === you?.member_id ? 'mine' : ''}`}>
                <span className="party-message-name">{m.name}</span> <span className="party-message-body">{m.body}</span>
                <span className="muted small"> · {timeAgo(m.created_at)}</span>
                {(isHost || m.member_id === you?.member_id) && (
                  <button className="link-btn small" onClick={() => act(() => api(`/parties/${id}/chat/${m.id}`, { method: 'DELETE', headers }))}>
                    remove
                  </button>
                )}
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          <form className="party-chat-form" onSubmit={sendChat}>
            <input className="input" value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Message" maxLength={500} aria-label="Chat message" />
            <button className="btn btn-icon" title="Send" disabled={!chatText.trim()}>
              <Icon name="send" />
            </button>
          </form>
        </section>
      </aside>
    </div>
  );
}
