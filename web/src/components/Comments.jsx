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

function CommentItem({ c, replies = [], user, onReply, onDelete, isReply = false }) {
  const [replying, setReplying] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  return (
    <div className={`comment ${isReply ? 'reply' : ''}`}>
      <Link to={`/c/${c.author.username}`}>
        <Avatar user={c.author} size={isReply ? 24 : 40} />
      </Link>
      <div className="cbody">
        <div className="chead">
          <Link to={`/c/${c.author.username}`} className={`cauthor ${c.is_uploader ? 'uploader' : ''}`}>
            @{c.author.username}
          </Link>
          <span className="ctime">{timeAgo(c.created_at)}</span>
        </div>
        <div className="ctext">{c.body}</div>
        <div className="cfoot">
          {user && (
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
                  <CommentItem key={r.id} c={r} user={user} onReply={onReply} onDelete={onDelete} isReply />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function Comments({ videoId, initialCount = 0 }) {
  const { user } = useAuth();
  const toast = useToast();
  const [comments, setComments] = useState(null);

  useEffect(() => {
    setComments(null);
    let dead = false;
    api(`/videos/${videoId}/comments`)
      .then((r) => !dead && setComments(r.comments))
      .catch(() => !dead && setComments([]));
    return () => {
      dead = true;
    };
  }, [videoId]);

  const add = async (body, parentId) => {
    const { comment } = await api(`/videos/${videoId}/comments`, { method: 'POST', body: { body, parent_id: parentId } });
    setComments((cs) => [...(cs || []), comment]);
  };

  const remove = async (c) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await api(`/videos/${videoId}/comments/${c.id}`, { method: 'DELETE' });
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
      </div>
      {user ? (
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
          <CommentItem key={c.id} c={c} replies={repliesOf(c.id)} user={user} onDelete={remove} onReply={(body) => add(body, c.id)} />
        ))
      )}
    </section>
  );
}
