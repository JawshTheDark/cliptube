import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Comments } from '../components/Comments.jsx';
import { Icon } from '../components/Icons.jsx';
import { ServerTag } from '../components/ServerTag.jsx';
import { useToast } from '../components/Toast.jsx';
import { Empty, shortsPath } from '../components/VideoCard.jsx';
import { cameFrom, compact, copyText, displayed, isAnonymous, usePaged, usePref } from '../util.js';

const keyOf = (v) => (v.remote ? `n:${v.remote.peer_id}:${v.remote.remote_id}` : `v:${v.id}`);
const watchPath = (v) => (v.remote ? `/n/${v.remote.peer_id}/${encodeURIComponent(v.remote.remote_id)}` : `/watch/${v.id}`);
const apiBase = (v) => (v.remote ? `/network/videos/${v.remote.peer_id}/${encodeURIComponent(v.remote.remote_id)}` : `/videos/${v.id}`);

/** What the side buttons need: my like, the like count, and whether likes and comments reach its server. */
async function loadDetail(v) {
  const r = await api(apiBase(v));
  return v.remote
    ? { video: r.video, my_like: r.my_like || 0, likes: r.video.likes, can_like: !!r.interactions?.likes, can_comment: !!r.interactions?.comments, comments: null }
    : { video: r.video, my_like: r.video.my_like || 0, likes: r.video.likes, can_like: true, can_comment: true, comments: r.video.comment_count };
}

function Action({ icon, label, title, active = false, disabled = false, onClick }) {
  return (
    <button className={`short-action ${active ? 'active' : ''}`} onClick={onClick} disabled={!!disabled} title={title}>
      <span className="short-action-icon">
        <Icon name={icon} />
      </span>
      {label}
    </button>
  );
}

/** One Short: the video in a frame of its own shape, who made it, and a progress line. */
function ShortSlide({ video: v, active, near, muted, onMuted, videoRef }) {
  const [communityPref] = usePref('community');
  const shown = displayed(v, communityPref);
  const ref = useRef(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const u = v.uploader;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!active) {
      el.pause();
      el.currentTime = 0;
      return;
    }
    videoRef.current = el;
    el.muted = muted;
    el.play()
      .then(() => setPaused(false))
      .catch(() => {
        // The browser wants a tap before playing with sound: start without it.
        if (el.muted) return setPaused(true);
        el.muted = true;
        onMuted(true);
        el.play().catch(() => setPaused(true));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, near]);
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play().then(() => setPaused(false)).catch(() => {});
    else {
      el.pause();
      setPaused(true);
    }
  };
  const seek = (e) => {
    const el = ref.current;
    if (!el?.duration) return;
    const box = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - box.left) / box.width) * el.duration;
  };
  const ratio = v.width > 0 && v.height > 0 ? `${v.width} / ${v.height}` : '9 / 16';

  return (
    <div className="short-frame" style={{ aspectRatio: ratio }}>
      {near && v.video_url ? (
        <video
          ref={ref}
          src={v.video_url}
          poster={shown.thumbnail_url || undefined}
          loop
          playsInline
          preload="auto"
          onClick={toggle}
          onPause={() => setPaused(true)}
          onPlay={() => setPaused(false)}
          onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
        />
      ) : (
        shown.thumbnail_url && <img src={shown.thumbnail_url} alt="" loading="lazy" />
      )}
      {active && paused && (
        <button className="short-paused" onClick={toggle} aria-label="Play">
          <Icon name="play" size={40} />
        </button>
      )}
      <button className="short-mute" onClick={() => onMuted(!muted)} aria-label={muted ? 'Turn the sound on' : 'Mute'} title={muted ? 'Sound on (m)' : 'Mute (m)'}>
        <Icon name={muted ? 'volume_off' : 'volume'} />
      </button>
      <div className="short-info">
        <div className="short-channel">
          {v.remote ? (
            <a href={u.url || v.remote.peer_url} target="_blank" rel="noopener noreferrer">
              <Avatar user={u} size={32} />
              <span className="ellipsis">{u.display_name}</span>
            </a>
          ) : (
            <Link to={`/c/${u.username}`}>
              <Avatar user={u} size={32} />
              <span className="ellipsis">{u.display_name}</span>
            </Link>
          )}
          <ServerTag remote={v.remote} />
        </div>
        <Link to={watchPath(v)} className="short-title" title={shown.community ? `Community title. Original: ${v.title}` : v.title}>
          {shown.title}
        </Link>
      </div>
      <div className="short-progress" onClick={seek}>
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Shorts, one at a time and full height, the way phones show them: scroll, swipe or use the arrow keys for the
 * next one. Opened on a Short, it starts there and goes on with the newest.
 */
export default function Shorts() {
  const { id, peerId, remoteId } = useParams();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const scope = params.get('scope') === 'local' ? 'local' : 'all';
  const startKey = id ? `v:${id}` : peerId ? `n:${peerId}:${remoteId}` : null;

  const [start, setStart] = useState(startKey ? undefined : null); // undefined while loading
  const [details, setDetails] = useState({});
  const { items, hasMore, loading, loadMore } = usePaged(`/videos?sort=new&scope=${scope}&shape=vertical`, 12);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const feedRef = useRef(null);
  const videoRef = useRef(null);
  const counted = useRef(new Set());
  const anchor = useRef(null);

  useEffect(() => {
    if (!startKey) return;
    let dead = false;
    const stub = id ? { id } : { remote: { peer_id: peerId, remote_id: remoteId } };
    loadDetail(stub)
      .then((d) => {
        if (dead) return;
        setStart(d.video);
        setDetails((x) => ({ ...x, [keyOf(d.video)]: d }));
      })
      .catch(() => !dead && setStart(null));
    return () => {
      dead = true;
    };
  }, [startKey, id, peerId, remoteId]);

  // The Short it was opened on, then the ones after it in the newest (or all of them, when it isn't among
  // the first few). Decided once, so the list doesn't shift as more load.
  const list = useMemo(() => {
    if (!start) return start === null ? items : [];
    if (anchor.current === null && items.length) anchor.current = items.findIndex((v) => keyOf(v) === keyOf(start));
    const rest = anchor.current >= 0 ? items.slice(anchor.current + 1) : items.filter((v) => keyOf(v) !== keyOf(start));
    return [start, ...rest];
  }, [start, items]);
  const current = list[active];
  useTitle(current ? displayed(current).title : 'Shorts');

  // Which Short is on screen: most of it in view.
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number(e.target.dataset.index));
      },
      { root: feed, threshold: 0.6 },
    );
    for (const el of feed.children) io.observe(el);
    return () => io.disconnect();
  }, [list.length]);

  // The address follows along (so it can be shared), the view is counted once, and more load near the end.
  useEffect(() => {
    if (!current) return;
    const key = keyOf(current);
    window.history.replaceState(window.history.state, '', `${shortsPath(current)}${scope === 'local' ? '?scope=local' : ''}`);
    if (!details[key]) {
      loadDetail(current)
        .then((d) => setDetails((x) => ({ ...x, [key]: d })))
        .catch(() => {});
    }
    if (!counted.current.has(key)) {
      counted.current.add(key);
      if (current.remote) fetch(`${current.remote.peer_url}/api/videos/${encodeURIComponent(current.remote.remote_id)}/view`, { method: 'POST', mode: 'no-cors' }).catch(() => {});
      else api(`/videos/${current.id}/view`, { method: 'POST', body: { anonymous: isAnonymous(), from: cameFrom(), ref: document.referrer || '' } }).catch(() => {});
    }
    if (active >= list.length - 3 && hasMore && !loading) loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current && keyOf(current), list.length, hasMore, loading]);

  const go = useCallback(
    (step) => {
      const next = feedRef.current?.children[Math.max(0, Math.min(list.length - 1, active + step))];
      next?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [active, list.length],
  );

  // One turn of the wheel (or swipe on a touchpad, momentum and all) is one Short.
  const goRef = useRef(go);
  goRef.current = go;
  const hasList = list.length > 0;
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    let quietUntil = 0;
    let sum = 0;
    const onWheel = (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const t = Date.now();
      if (t < quietUntil) {
        quietUntil = Math.max(quietUntil, t + 200);
        return;
      }
      sum += e.deltaY;
      if (Math.abs(sum) < 30) return;
      goRef.current(sum > 0 ? 1 : -1);
      sum = 0;
      quietUntil = t + 500;
    };
    feed.addEventListener('wheel', onWheel, { passive: false });
    return () => feed.removeEventListener('wheel', onWheel);
  }, [hasList]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (['ArrowDown', 'PageDown'].includes(e.key)) go(1);
      else if (['ArrowUp', 'PageUp'].includes(e.key)) go(-1);
      else if (e.key === 'm') setMuted((m) => !m);
      else if (e.key === ' ' || e.key === 'k') {
        const el = videoRef.current;
        if (el) el.paused ? el.play().catch(() => {}) : el.pause();
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const d = current ? details[keyOf(current)] : null;
  const like = async (value) => {
    if (!user) return nav('/login', { state: { from: shortsPath(current) } });
    if (!d) return;
    const key = keyOf(current);
    const next = d.my_like === value ? 0 : value;
    try {
      const r = await api(`${apiBase(current)}/like`, { method: 'POST', body: { value: next } });
      setDetails((x) => ({ ...x, [key]: { ...x[key], my_like: r.my_like ?? next, likes: r.likes ?? x[key].likes } }));
    } catch (e) {
      toast(e.message);
    }
  };
  const seek = (secs) => {
    const el = videoRef.current;
    if (!el || secs == null) return;
    el.currentTime = secs;
    el.play().catch(() => {});
  };
  const share = () => copyText(`${window.location.origin}${shortsPath(current)}`).then(() => toast('Link copied'));

  if (start === undefined || (!list.length && loading)) return <div className="spinner" />;
  if (!list.length) {
    return (
      <Empty icon="shorts" title="No Shorts yet">
        <p>Vertical videos show up here as people upload them.</p>
      </Empty>
    );
  }

  return (
    <div className={`shorts-page ${commentsOpen ? 'with-comments' : ''}`}>
      <div className="shorts-feed" ref={feedRef}>
        {list.map((v, i) => (
          <section key={keyOf(v)} className="short-slide" data-index={i}>
            <div className="short-stage">
              <ShortSlide video={v} active={i === active} near={Math.abs(i - active) <= 1} muted={muted} onMuted={setMuted} videoRef={videoRef} />
              {i === active && (
                <div className="short-actions">
                  <Action icon="thumb_up" label={compact(d ? d.likes : v.likes)} title="I like this" active={d?.my_like === 1} disabled={d && !d.can_like} onClick={() => like(1)} />
                  <Action icon="thumb_down" label="Dislike" title="I dislike this" active={d?.my_like === -1} disabled={d && !d.can_like} onClick={() => like(-1)} />
                  <Action icon="comment" label={d?.comments ? compact(d.comments) : 'Comments'} title="Comments" active={commentsOpen} onClick={() => setCommentsOpen((o) => !o)} />
                  <Action icon="share" label="Share" title="Copy the link" onClick={share} />
                  <Link className="short-action" to={watchPath(v)} title="Open the full page">
                    <span className="short-action-icon">
                      <Icon name="open" />
                    </span>
                    Full page
                  </Link>
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
      <div className="shorts-nav">
        <button className="btn btn-icon" onClick={() => go(-1)} disabled={active === 0} aria-label="Previous Short" title="Previous (↑)">
          <Icon name="arrow_up" />
        </button>
        <button className="btn btn-icon" onClick={() => go(1)} disabled={active >= list.length - 1} aria-label="Next Short" title="Next (↓)">
          <Icon name="arrow_down" />
        </button>
      </div>
      {commentsOpen && current && (
        <aside className="shorts-comments">
          <div className="shorts-comments-head">
            <b>Comments</b>
            <button className="btn btn-icon btn-ghost" onClick={() => setCommentsOpen(false)} aria-label="Close comments">
              <Icon name="close" />
            </button>
          </div>
          {d && !d.can_comment ? (
            <p className="muted">Comments between instances are turned off on this network.</p>
          ) : (
            <Comments
              key={keyOf(current)}
              base={apiBase(current)}
              initialCount={d?.comments || 0}
              onSeek={seek}
              getTime={() => videoRef.current?.currentTime}
              reportTarget={(c) =>
                current.remote
                  ? {
                      type: 'remote_comment',
                      id: `${current.remote.peer_id}:${current.remote.remote_id}:${c.id}`,
                      label: `"${c.body.slice(0, 120)}" by @${c.author.username}`,
                      extra: { comment_excerpt: c.body.slice(0, 200), comment_author: c.author.username },
                    }
                  : { type: 'comment', id: c.id, label: `"${c.body.slice(0, 120)}" by @${c.author.username}` }
              }
            />
          )}
        </aside>
      )}
    </div>
  );
}
