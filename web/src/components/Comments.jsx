import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { ReportButton } from './ReportDialog.jsx';
import { timeAgo } from '../util.js';

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** Links to a local channel, or out to a person's home instance for people from elsewhere. */
function AuthorLink({ author, className, children }) {
  if (author.profile_url) {
    return (
      <a href={author.profile_url} className={className} target="_blank" rel="noopener noreferrer" title={`Profile on ${new URL(author.profile_url).host}`}>
        {children}
      </a>
    );
  }
  return (
    <Link to={`/c/${author.username}`} className={className}>
      {children}
    </Link>
  );
}

function CommentForm({ user, onSubmit, placeholder, autoFocus = false, onCancel, submitLabel = 'Comment' }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(autoFocus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const cancel = () => {
    setText('');
    setFocused(false);
    setError(null);
    if (ref.current) ref.current.style.height = 'auto';
    onCancel?.();
  };

  const submit = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
      cancel();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="comment-form" onSubmit={submit}>
      <Avatar user={user} size={autoFocus ? 24 : 40} />
      <div className="comment-field">
        <textarea
          ref={ref}
          className="comment-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow(e.target);
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
          }}
        />
        {error && <div className="form-error">{error}</div>}
        {(focused || text) && (
          <div className="comment-actions">
            <button type="button" className="btn btn-ghost" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!text.trim() || busy}>
              {submitLabel}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

function CommentItem({ c, replies = [], user, canPost, onReply, onDelete, onUpdate, reportTarget, isReply = false, hostName = null }) {
  const [replying, setReplying] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  // held: waiting for review here; pending: sent to another instance, not shown there yet; rejected: it refused.
  const held = c.status === 'held' || c.status === 'pending' || c.status === 'rejected';
  return (
    <div className={`comment ${isReply ? 'reply' : ''} ${held ? 'held' : ''}`} id={`c-${c.id}`}>
      <AuthorLink author={c.author}>
        <Avatar user={c.author} size={isReply ? 24 : 40} />
      </AuthorLink>
      <div className="cbody">
        {c.pinned && (
          <div className="cpinned">
            <Icon name="pin" size={14} /> Pinned by the uploader
          </div>
        )}
        <div className="chead">
          <AuthorLink author={c.author} className={`cauthor ${c.is_uploader ? 'uploader' : ''}`}>
            @{c.author.username}
          </AuthorLink>
          {c.linked_uploader ? (
            <Icon name="link" className="inline-icon muted" title="The uploader, from a linked account on another site" />
          ) : (
            c.author.remote && <Icon name="public" className="inline-icon muted" title="From another instance" />
          )}
          <span className="ctime">{timeAgo(c.created_at)}</span>
          {c.status === 'held' && (
            <span className="badge warn" title={c.held_reason || ''}>
              <Icon name="hourglass" /> Held for review{c.held_reason ? `: ${c.held_reason}` : ''}
            </span>
          )}
          {c.status === 'pending' && (
            <span className="badge warn" title="It shows up here once the other instance accepts it">
              <Icon name="hourglass" /> Waiting for {hostName || 'the other instance'}
            </span>
          )}
          {c.status === 'rejected' && (
            <span className="badge err" title={c.status_reason || ''}>
              <Icon name="warning" /> Not accepted{c.status_reason ? `: ${c.status_reason}` : ''}
            </span>
          )}
        </div>
        <div className="ctext">{c.body}</div>
        <div className="cfoot">
          {c.status === 'held' && c.can_moderate && (
            <button className="btn approve" onClick={() => onUpdate(c, { status: 'visible' }, 'Comment approved')}>
              <Icon name="check" size={16} /> Approve
            </button>
          )}
          {user && canPost && !held && (
            <button className="btn" onClick={() => setReplying((r) => !r)}>
              Reply
            </button>
          )}
          {c.hearted && (
            <span className="cheart" title="The uploader loved this">
              <Icon name="heart" size={14} />
            </span>
          )}
          {c.can_pin && !held && (
            <>
              <button className={`btn ${c.hearted ? 'active' : ''}`} onClick={() => onUpdate(c, { hearted: !c.hearted })} title={c.hearted ? 'Remove heart' : 'Heart this comment'}>
                <Icon name="heart" size={16} />
              </button>
              {!isReply && (
                <button className="btn" onClick={() => onUpdate(c, { pinned: !c.pinned }, c.pinned ? 'Comment unpinned' : 'Comment pinned')} title={c.pinned ? 'Unpin' : 'Pin to the top'}>
                  <Icon name="pin" size={16} /> {c.pinned ? 'Unpin' : 'Pin'}
                </button>
              )}
            </>
          )}
          {c.can_delete && (
            <button className="btn" onClick={() => onDelete(c)} title="Delete comment">
              <Icon name="delete" size={16} /> Delete
            </button>
          )}
          {reportTarget && user && !c.can_delete && <ReportButton target={reportTarget(c)} className="btn" label="Report" />}
        </div>
        {replying && user && (
          <CommentForm
            user={user}
            autoFocus
            placeholder={`Reply to @${c.author.username}`}
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await onReply(body);
              setShowReplies(true);
            }}
          />
        )}
        {replies.length > 0 && (
          <>
            <button className="replies-toggle" onClick={() => setShowReplies((s) => !s)}>
              {showReplies ? '▲' : '▼'} {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </button>
            {showReplies && (
              <div className="replies">
                {replies.map((r) => (
                  <CommentItem key={r.id} c={r} user={user} canPost={canPost} onReply={onReply} onDelete={onDelete} onUpdate={onUpdate} reportTarget={reportTarget} hostName={hostName} isReply />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Comment thread. `base` is the API path that owns the comments: `/videos/<id>` for local videos,
 * `/network/videos/<instance>/<id>` for videos on other instances (comments are stored there).
 */
export function Comments({ base, initialCount = 0, reportTarget, isOwner = false }) {
  const { user } = useAuth();
  const toast = useToast();
  const [comments, setComments] = useState(null);
  const [meta, setMeta] = useState({ can_post: true, host_name: null, error: null, mode: 'open' });

  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    setComments(null);
    setRefreshes(0);
    let dead = false;
    api(`${base}/comments`)
      .then((r) => {
        if (dead) return;
        setComments(r.comments);
        setMeta({ can_post: r.can_post !== false && r.comment_mode !== 'off', host_name: r.host_name || null, error: null, mode: r.comment_mode || 'open' });
      })
      .catch((e) => {
        if (dead) return;
        setComments([]);
        setMeta((m) => ({ ...m, error: e.message }));
      });
    return () => {
      dead = true;
    };
  }, [base]);

  // A comment sent to another instance waits for its answer: look again a few times.
  const waiting = (comments || []).some((c) => c.status === 'pending');
  useEffect(() => {
    if (!waiting || refreshes >= 10) return undefined;
    const t = setTimeout(() => {
      api(`${base}/comments`)
        .then((r) => setComments(r.comments))
        .catch(() => {})
        .finally(() => setRefreshes((n) => n + 1));
    }, 3000);
    return () => clearTimeout(t);
  }, [waiting, refreshes, base]);

  const add = async (body, parentId) => {
    const r = await api(`${base}/comments`, { method: 'POST', body: { body, parent_id: parentId } });
    if (r.pending) {
      toast(`Sent. It shows up once ${r.host_name || 'the other instance'} accepts it.`);
      setRefreshes(0);
      setComments((cs) => [...(cs || []), r.comment]);
      return;
    }
    if (r.held) {
      toast(`Your comment is held for review${r.held_reason ? ` (${r.held_reason})` : ''}. Only you can see it until it's approved.`);
      // Held comments on other instances can't be shown here, so only keep local ones.
      if (r.comment.status !== 'held' || r.comment.can_delete) setComments((cs) => [...(cs || []), { ...r.comment, status: 'held', held_reason: r.held_reason }]);
      return;
    }
    setComments((cs) => [...(cs || []), r.comment]);
  };

  const update = async (c, body, message) => {
    try {
      const r = await api(`${base}/comments/${c.id}`, { method: 'PATCH', body });
      setComments((cs) =>
        cs.map((x) => {
          if (x.id === c.id) return { ...x, ...r.comment };
          if (body.pinned && x.pinned) return { ...x, pinned: false };
          return x;
        }),
      );
      if (message) toast(message);
    } catch (e) {
      toast(e.message);
    }
  };

  const remove = async (c) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await api(`${base}/comments/${c.id}`, { method: 'DELETE' });
      setComments((cs) => cs.filter((x) => x.id !== c.id && x.parent_id !== c.id));
      toast('Comment deleted');
    } catch (e) {
      toast(e.message);
    }
  };

  const list = comments || [];
  const roots = list
    .filter((c) => !c.parent_id)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.created_at - a.created_at);
  const repliesOf = (id) => list.filter((c) => c.parent_id === id);
  const count = comments ? comments.filter((c) => !['held', 'pending', 'rejected'].includes(c.status)).length : initialCount;
  const heldCount = comments ? comments.filter((c) => c.status === 'held' && c.can_moderate).length : 0;

  return (
    <section className="comments">
      <div className="comments-head">
        {count} {count === 1 ? 'Comment' : 'Comments'}
        {meta.host_name && <span className="comments-host">on {meta.host_name}</span>}
        {heldCount > 0 && <span className="badge warn comments-held">{heldCount} waiting for review</span>}
      </div>
      {meta.error && <div className="error">{meta.error}</div>}
      {meta.mode === 'off' ? (
        <p className="comment-login">Comments are turned off for this video.</p>
      ) : !meta.can_post ? (
        <p className="comment-login">Comments from other instances are turned off for this video.</p>
      ) : user ? (
        <CommentForm user={user} placeholder="Add a comment..." onSubmit={(body) => add(body, null)} />
      ) : (
        <p className="comment-login">
          <Link to="/login">Sign in</Link> to join the conversation.
        </p>
      )}
      {comments === null ? (
        <div className="spinner" />
      ) : (
        roots.map((c) => (
          <CommentItem
            key={c.id}
            c={c}
            replies={repliesOf(c.id)}
            user={user}
            canPost={meta.can_post && meta.mode !== 'off'}
            onDelete={remove}
            onUpdate={update}
            reportTarget={reportTarget}
            hostName={meta.host_name}
            onReply={(body) => add(body, c.id)}
          />
        ))
      )}
      {isOwner && meta.mode === 'hold_all' && <p className="hint">You review every comment on this video before it appears.</p>}
    </section>
  );
}
