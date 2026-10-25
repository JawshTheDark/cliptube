import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
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

function CommentItem({ c, replies = [], user, canPost, onReply, onDelete, isReply = false }) {
  const [replying, setReplying] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  return (
    <div className={`comment ${isReply ? 'reply' : ''}`}>
      <AuthorLink author={c.author}>
        <Avatar user={c.author} size={isReply ? 24 : 40} />
      </AuthorLink>
      <div className="cbody">
        <div className="chead">
          <AuthorLink author={c.author} className={`cauthor ${c.is_uploader ? 'uploader' : ''}`}>
            @{c.author.username}
          </AuthorLink>
          {c.author.remote && <Icon name="public" className="inline-icon muted" title="From another instance" />}
          <span className="ctime">{timeAgo(c.created_at)}</span>
        </div>
        <div className="ctext">{c.body}</div>
        <div className="cfoot">
          {user && canPost && (
            <button className="btn" onClick={() => setReplying((r) => !r)}>
              Reply
            </button>
          )}
          {c.can_delete && (
            <button className="btn" onClick={() => onDelete(c)} title="Delete comment">
              <Icon name="delete" size={16} /> Delete
            </button>
          )}
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
                  <CommentItem key={r.id} c={r} user={user} canPost={canPost} onReply={onReply} onDelete={onDelete} isReply />
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
export function Comments({ base, initialCount = 0 }) {
  const { user } = useAuth();
  const toast = useToast();
  const [comments, setComments] = useState(null);
  const [meta, setMeta] = useState({ can_post: true, host_name: null, error: null });

  useEffect(() => {
    setComments(null);
    let dead = false;
    api(`${base}/comments`)
      .then((r) => {
        if (dead) return;
        setComments(r.comments);
        setMeta({ can_post: r.can_post !== false, host_name: r.host_name || null, error: null });
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

  const add = async (body, parentId) => {
    const { comment } = await api(`${base}/comments`, { method: 'POST', body: { body, parent_id: parentId } });
    setComments((cs) => [...(cs || []), comment]);
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
  const roots = list.filter((c) => !c.parent_id).sort((a, b) => b.created_at - a.created_at);
  const repliesOf = (id) => list.filter((c) => c.parent_id === id);
  const count = comments ? comments.length : initialCount;

  return (
    <section className="comments">
      <div className="comments-head">
        {count} {count === 1 ? 'Comment' : 'Comments'}
        {meta.host_name && <span className="comments-host">on {meta.host_name}</span>}
      </div>
      {meta.error && <div className="error">{meta.error}</div>}
      {!meta.can_post ? (
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
            canPost={meta.can_post}
            onDelete={remove}
            onReply={(body) => add(body, c.id)}
          />
        ))
      )}
    </section>
  );
}
