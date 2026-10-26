import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Player } from '../components/Player.jsx';
import { Icon } from '../components/Icons.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { ServerTag } from '../components/ServerTag.jsx';
import { Empty } from '../components/VideoCard.jsx';
import { GameField } from '../components/GameField.jsx';
import { useToast } from '../components/Toast.jsx';
import { copyText, plural, timeAgo } from '../util.js';

const tokenKey = (username) => `ct_live_${username}`;

function LiveBadge({ viewers }) {
  return (
    <span className="live-badge">
      <span className="live-dot" /> LIVE{viewers != null ? ` · ${plural(viewers, 'viewer')}` : ''}
    </span>
  );
}

/** The live streams on this server and the rest of the network, for Home. Nothing when nobody is live. */
export function LiveNow() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let dead = false;
    const load = () =>
      api('/live/now')
        .then((r) => !dead && setData(r))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);
  const all = [...(data?.live || []), ...(data?.network || [])];
  if (!all.length) return null;
  return (
    <section className="live-now">
      <h2>
        <Icon name="live" /> Live now
      </h2>
      <div className="live-row">
        {all.map((s) => {
          const inner = (
            <>
              <span className="live-card-top">
                <Avatar user={{ display_name: s.channel.display_name, username: s.channel.username, avatar_url: s.channel.avatar_url }} size={44} />
                <LiveBadge viewers={s.viewers} />
              </span>
              <span className="live-card-title">{s.title}</span>
              <span className="muted small">
                {s.channel.display_name}
                {s.game ? ` · ${s.game.name}` : ''}
              </span>
              <ServerTag remote={s.remote} />
            </>
          );
          return s.remote ? (
            <a key={`${s.remote.peer_id}-${s.id}`} className="live-card" href={s.url} target="_blank" rel="noopener noreferrer">
              {inner}
            </a>
          ) : (
            <Link key={s.id} className="live-card" to={`/live/${s.channel.username}`}>
              {inner}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** Settings: going live with OBS, the stream key, and what the next stream is called. */
export function LiveSettings() {
  const toast = useToast();
  const { user } = useAuth();
  const [s, setS] = useState(null);
  const [form, setForm] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const load = () =>
    api('/live/me')
      .then((r) => {
        setS(r);
        setForm(r.settings);
      })
      .catch(() => setS(null));
  useEffect(() => {
    load();
  }, []);
  if (!s) return null;
  const copy = async (text, what) => toast((await copyText(text)) ? `${what} copied` : 'Could not copy');
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('/live/me', { method: 'PATCH', body: form });
      toast('Saved');
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const newKey = async () => {
    if (!window.confirm('Make a new stream key? The old one stops working, so update OBS afterwards.')) return;
    try {
      await api('/live/me/key', { method: 'POST' });
      toast('New stream key made');
      setShowKey(true);
      load();
    } catch (e) {
      toast(e.message);
    }
  };
  return (
    <section className="card-panel" id="live">
      <h2>
        <Icon name="live" /> Live streaming
      </h2>
      {!s.enabled ? (
        <p className="muted">Live streaming isn't set up on this server. An admin can turn it on (see the wiki's Live Streaming page).</p>
      ) : (
        <>
          {s.stream?.status === 'live' ? (
            <div className="notice live-notice">
              <LiveBadge viewers={s.stream.viewers} /> You're live: <Link to={`/live/${user.username}`}>{s.stream.title}</Link>
            </div>
          ) : (
            <p className="hint">
              Stream from OBS (or any app that streams over RTMP): in OBS, Settings, Stream, pick <b>Custom</b> and paste these two. Your stream shows at{' '}
              <Link to={`/live/${user.username}`}>/live/{user.username}</Link>, and your subscribers hear about it.
            </p>
          )}
          <div className="field">
            <label>Server</label>
            <div className="copy-row">
              <code>{s.server_url}</code>
              <button type="button" className="btn btn-sm" onClick={() => copy(s.server_url, 'Server')}>
                Copy
              </button>
            </div>
          </div>
          <div className="field">
            <label>Stream key</label>
            <div className="copy-row">
              <code>{showKey ? s.stream_key : '•'.repeat(24)}</code>
              <button type="button" className="btn btn-sm" onClick={() => setShowKey((x) => !x)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => copy(s.stream_key, 'Stream key')}>
                Copy
              </button>
              <button type="button" className="btn btn-sm" onClick={newKey}>
                New key
              </button>
            </div>
            <p className="hint small">Anyone with the key can stream as you. Keep it secret, and make a new one if it gets out.</p>
          </div>
          {s.srt_url && (
            <div className="field">
              <label>SRT (optional)</label>
              <div className="copy-row">
                <code>{showKey ? s.srt_url : 'srt://…'}</code>
                <button type="button" className="btn btn-sm" onClick={() => copy(s.srt_url, 'SRT address')}>
                  Copy
                </button>
              </div>
            </div>
          )}
          <form onSubmit={save} className="live-form">
            <div className="field">
              <label>Title</label>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={`${user.display_name} is live`} maxLength={120} />
            </div>
            <div className="field">
              <label>Description</label>
              <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="field">
              <label>Game</label>
              <GameField value={form.game} onChange={(game) => setForm({ ...form, game })} />
            </div>
            <div className="field">
              <label>Who can watch</label>
              <select className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                <option value="public">Public: on Home and the network, and subscribers are told</option>
                <option value="unlisted">Unlisted: only people with the link</option>
              </select>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={!!form.save_recording} onChange={(e) => setForm({ ...form, save_recording: e.target.checked })} /> Keep each stream as a draft video when it
              ends
            </label>
            <div className="row-actions top-gap">
              <button className="btn btn-primary">Save</button>
            </div>
            <p className="hint small">Changes here reach a stream that is on right now too.</p>
          </form>
        </>
      )}
    </section>
  );
}

/** A channel's live page: the stream (low-latency HLS), the chat beside it, or when it was last live. */
export default function Live() {
  const { username } = useParams();
  const { user, loading } = useAuth();
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [stream, setStream] = useState(null);
  const [viewers, setViewers] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [floats, setFloats] = useState([]);
  const [you, setYou] = useState(null);
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(tokenKey(username)) || '';
    } catch {
      return '';
    }
  });
  const [text, setText] = useState('');
  const [guestName, setGuestName] = useState('');
  const videoRef = useRef(null);
  const chatEnd = useRef(null);
  const headers = !user && token ? { 'x-room-member': token } : {};
  useTitle(stream ? `${stream.title} · Live` : info ? `${info.channel.display_name} · Live` : 'Live');

  useEffect(() => {
    if (loading) return;
    api(`/live/${encodeURIComponent(username)}`, { headers })
      .then((r) => {
        setInfo(r);
        setStream(r.stream);
      })
      .catch((e) => setError(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, loading, user?.id]);

  useEffect(() => {
    if (!info) return undefined;
    const es = new EventSource(`/api/live/${encodeURIComponent(username)}/events${!user && token ? `?member=${encodeURIComponent(token)}` : ''}`);
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on('hello', (d) => {
      setStream(d.stream);
      setMessages(d.messages);
      setReactions(d.reactions);
      setViewers(d.viewers);
      setYou(d.you);
    });
    on('live', (d) => setStream(d.stream));
    on('live_ended', () => setStream(null));
    on('viewers', (d) => setViewers(d.viewers));
    on('chat', (m) => setMessages((list) => [...list.slice(-199), m]));
    on('chat_deleted', (d) => setMessages((list) => list.filter((m) => m.id !== d.id)));
    on('react', (d) => {
      const key = Math.random();
      setFloats((f) => [...f, { key, emoji: d.emoji, left: 8 + Math.random() * 84 }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.key !== key)), 2600);
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.channel?.username, token, user?.id]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  if (error) return <Empty icon="live" title="This channel doesn't exist" />;
  if (!info) return <div className="spinner" />;

  const canChat = !!user || !!token;
  const moderate = !!user && (info.is_owner || user.is_moderator || user.is_admin);
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  const send = (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    act(() => api(`/live/${username}/chat`, { method: 'POST', headers, body: { body } }));
  };
  const join = (e) => {
    e.preventDefault();
    act(async () => {
      const r = await api(`/live/${username}/join`, { method: 'POST', body: { name: guestName } });
      try {
        localStorage.setItem(tokenKey(username), r.token);
      } catch {}
      setToken(r.token);
    });
  };
  const ch = info.channel;

  return (
    <div className="party live-page">
      <div className="party-main">
        <div className="player-wrap party-player">
          {stream?.hls_url ? (
            <Player video={{ id: `live-${stream.id}`, hls_url: stream.hls_url, video_url: null, thumbnail_url: null }} videoRef={videoRef} live />
          ) : (
            <div className="player">
              <div className="processing-panel">
                <Avatar user={ch} size={72} />
                <h2>{ch.display_name} isn't live right now</h2>
                {info.last && (
                  <p className="muted">
                    Last live {timeAgo(info.last.ended_at || info.last.started_at)}: {info.last.title}
                    {info.last.video_id && (
                      <>
                        {' '}
                        · <Link to={`/watch/${info.last.video_id}`}>watch it</Link>
                      </>
                    )}
                  </p>
                )}
                {info.is_owner && <Link to="/settings#live">Set up OBS to go live</Link>}
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
        </div>
        <div className="party-bar">
          <div className="party-bar-text">
            <h1>{stream ? stream.title : `${ch.display_name} · Live`}</h1>
            <div className="muted small live-meta">
              {stream && <LiveBadge viewers={viewers} />}
              <Link to={`/c/${ch.username}`}>{ch.display_name}</Link>
              {stream?.game && <span> · {stream.game.name}</span>}
              {stream && <span> · started {timeAgo(stream.started_at)}</span>}
            </div>
            {stream?.description && <p className="pre">{stream.description}</p>}
          </div>
          <div className="party-bar-tools">
            <button className="btn" onClick={async () => toast((await copyText(window.location.href)) ? 'Link copied' : 'Could not copy the link')}>
              <Icon name="share" /> Share
            </button>
            {info.is_owner && (
              <Link className="btn" to="/settings#live">
                <Icon name="settings" /> Stream settings
              </Link>
            )}
          </div>
        </div>
        {stream && canChat && (
          <div className="party-reactions">
            {reactions.map((e) => (
              <button key={e} className="party-reaction" onClick={() => act(() => api(`/live/${username}/react`, { method: 'POST', headers, body: { emoji: e } }))}>
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
      <aside className="party-side">
        <section className="party-chat">
          <h2>Live chat</h2>
          <div className="party-messages">
            {messages.length === 0 && <p className="muted small">{stream ? 'Say hi!' : 'The chat opens with the stream.'}</p>}
            {messages.map((m) => (
              <div key={m.id} className={`party-message ${m.member_id === you?.member_id ? 'mine' : ''}`}>
                <span className="party-message-name">{m.name}</span> <span className="party-message-body">{m.body}</span>
                {(moderate || m.member_id === you?.member_id) && (
                  <button className="link-btn small" onClick={() => act(() => api(`/live/${username}/chat/${m.id}`, { method: 'DELETE', headers }))}>
                    remove
                  </button>
                )}
                {moderate && m.member_id !== you?.member_id && (
                  <button className="link-btn small" onClick={() => window.confirm(`Remove ${m.name} from the chat?`) && act(() => api(`/live/${username}/ban`, { method: 'POST', body: { member_id: m.member_id } }))}>
                    ban
                  </button>
                )}
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          {canChat ? (
            <form className="party-chat-form" onSubmit={send}>
              <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" maxLength={500} aria-label="Chat message" disabled={!stream} />
              <button className="btn btn-icon" title="Send" disabled={!text.trim() || !stream}>
                <Icon name="send" />
              </button>
            </form>
          ) : (
            <form className="party-chat-form" onSubmit={join}>
              <input className="input" value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Pick a name to chat" maxLength={32} aria-label="Your name" />
              <button className="btn" disabled={guestName.trim().length < 2}>
                Join
              </button>
            </form>
          )}
        </section>
      </aside>
    </div>
  );
}
