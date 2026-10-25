import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { AdminTabs } from './Admin.jsx';
import { timeAgo } from '../util.js';

const ACTIONS = {
  video: [
    ['hide_video', 'Hide video'],
    ['remove_video', 'Remove video'],
    ['strike_user', 'Strike uploader'],
    ['suspend_user', 'Suspend uploader'],
  ],
  comment: [
    ['delete_comment', 'Delete comment'],
    ['suspend_user', 'Suspend author'],
    ['block_instance', 'Block their instance'],
  ],
  user: [
    ['strike_user', 'Add strike'],
    ['suspend_user', 'Suspend'],
    ['ban_user', 'Ban'],
  ],
  remote_video: [
    ['hide_remote_video', 'Hide here'],
    ['block_instance', 'Block instance'],
  ],
  remote_comment: [['block_instance', 'Block instance']],
};

function TargetSummary({ r }) {
  const t = r.target;
  if (!t.exists) return <div className="muted">The reported item no longer exists.</div>;
  switch (r.target_type) {
    case 'video':
      return (
        <div className="mq-target">
          {t.thumbnail_url && <img src={t.thumbnail_url} alt="" />}
          <div>
            <Link to={`/watch/${t.video_id}`}>{t.title}</Link>
            <div className="muted">
              by @{t.owner}
              {t.moderation_status ? ` · currently ${t.moderation_status}` : ''}
            </div>
          </div>
        </div>
      );
    case 'comment':
      return (
        <div>
          <blockquote className="mq-quote">{t.body}</blockquote>
          <div className="muted">
            @{t.author} on <Link to={`/watch/${t.video_id}`}>{t.video_title}</Link>
            {t.status === 'held' ? ' · held' : ''}
          </div>
        </div>
      );
    case 'user':
      return (
        <div>
          <Link to={`/c/${t.username}`}>{t.display_name}</Link> <span className="muted">@{t.username}</span>
          <div className="muted">
            {t.status !== 'active' ? `${t.status} · ` : ''}
            {t.strikes} active strike{t.strikes === 1 ? '' : 's'}
          </div>
        </div>
      );
    default:
      return (
        <div>
          {r.target_url ? <Link to={r.target_url}>{t.title}</Link> : t.title}
          <div className="muted">
            on {t.instance_name}
            {t.hidden ? ' · hidden here' : ''}
            {t.instance_blocked ? ' · instance blocked' : ''}
          </div>
        </div>
      );
  }
}

function ReportCard({ r, onChanged }) {
  const toast = useToast();
  const [notes, setNotes] = useState(r.notes || '');
  const [busy, setBusy] = useState(false);

  const act = async (action, label) => {
    const reason = action === 'dismiss' || action === 'resolve' ? '' : window.prompt(`${label}: reason (shown to the person affected where it applies)`, r.reason_label);
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await api(`/mod/reports/${r.id}/action`, { method: 'POST', body: { action, reason } });
      toast(res.message);
      onChanged();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async () => {
    try {
      await api(`/mod/reports/${r.id}`, { method: 'PATCH', body: { notes } });
      toast('Notes saved');
    } catch (e) {
      toast(e.message);
    }
  };

  return (
    <div className="mq-card">
      <div className="mq-head">
        <span className={`badge ${r.reason === 'illegal' || r.reason === 'copyright' ? 'err' : 'warn'}`}>{r.reason_label}</span>
        <span className="muted">
          {r.target_type.replace('_', ' ')} · reported by {r.reporter || 'someone'}
          {r.from_instance ? ` (via ${r.from_instance})` : ''} · {timeAgo(r.created_at)}
        </span>
        {r.status !== 'open' && (
          <span className="badge">
            {r.status}: {r.resolution} {r.handled_by ? `by @${r.handled_by}` : ''}
          </span>
        )}
      </div>
      <TargetSummary r={r} />
      {r.details && <p className="mq-details">“{r.details}”</p>}
      {r.status === 'open' && (
        <div className="row-actions top-gap">
          {(ACTIONS[r.target_type] || []).map(([a, label]) => (
            <button key={a} className="btn btn-sm" disabled={busy || !r.target.exists} onClick={() => act(a, label)}>
              {label}
            </button>
          ))}
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act('resolve', 'Resolve')}>
            Mark handled
          </button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act('dismiss', 'Dismiss')}>
            Dismiss
          </button>
        </div>
      )}
      <div className="mq-notes">
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Private moderator notes" />
        {notes !== (r.notes || '') && (
          <button className="btn btn-sm" onClick={saveNotes}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}

function Reports() {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const load = useCallback(() => api(`/mod/reports?status=${status}`).then((r) => setReports(r.reports)).catch(() => setReports([])), [status]);
  useEffect(() => {
    setReports(null);
    load();
  }, [load]);
  return (
    <>
      <div className="chips flat">
        {['open', 'resolved', 'dismissed', 'all'].map((s) => (
          <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {reports === null ? <div className="spinner" /> : reports.length === 0 ? <p className="muted">Nothing here.</p> : reports.map((r) => <ReportCard key={r.id} r={r} onChanged={load} />)}
    </>
  );
}

export function HeldComments({ endpoint = '/mod/comments/held' }) {
  const toast = useToast();
  const [comments, setComments] = useState(null);
  const load = useCallback(() => api(endpoint).then((r) => setComments(r.comments)).catch(() => setComments([])), [endpoint]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (c, approve) => {
    try {
      if (approve) await api(`/videos/${c.video_id}/comments/${c.id}`, { method: 'PATCH', body: { status: 'visible' } });
      else await api(`/videos/${c.video_id}/comments/${c.id}`, { method: 'DELETE' });
      setComments((list) => list.filter((x) => x.id !== c.id));
      toast(approve ? 'Approved' : 'Deleted');
    } catch (e) {
      toast(e.message);
    }
  };
  if (comments === null) return <div className="spinner" />;
  if (!comments.length) return <p className="muted">No comments are waiting for review.</p>;
  return comments.map((c) => (
    <div key={c.id} className="mq-card">
      <div className="mq-head">
        <span className="badge warn">{c.held_reason || 'Held'}</span>
        <span className="muted">
          @{c.author.username}
          {c.author.remote ? ' (another instance)' : ''} on <Link to={`/watch/${c.video_id}`}>{c.video_title}</Link> · {timeAgo(c.created_at)}
        </span>
      </div>
      <blockquote className="mq-quote">{c.body}</blockquote>
      <div className="row-actions">
        <button className="btn btn-sm btn-primary" onClick={() => act(c, true)}>
          Approve
        </button>
        <button className="btn btn-sm" onClick={() => act(c, false)}>
          Delete
        </button>
      </div>
    </div>
  ));
}

function CounterNotices() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = useCallback(() => api('/mod/counter-notices').then((r) => setList(r.counter_notices)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  const decide = async (cn, decision) => {
    if (!window.confirm(decision === 'accept' ? 'Restore the video?' : 'Keep the video removed?')) return;
    try {
      await api(`/mod/counter-notices/${cn.id}`, { method: 'POST', body: { decision } });
      toast(decision === 'accept' ? 'Video restored' : 'Counter-notice rejected');
      load();
    } catch (e) {
      toast(e.message);
    }
  };
  if (list === null) return <div className="spinner" />;
  if (!list.length) return <p className="muted">No counter-notices or appeals yet.</p>;
  return list.map((cn) => (
    <div key={cn.id} className="mq-card">
      <div className="mq-head">
        <span className={`badge ${cn.status === 'pending' ? 'warn' : cn.status === 'accepted' ? 'ok' : ''}`}>{cn.status}</span>
        <span className="muted">
          @{cn.username} about <Link to={`/watch/${cn.video_id}`}>{cn.video_title || cn.video_id}</Link> · {timeAgo(cn.created_at)}
        </span>
      </div>
      {cn.claimant && (
        <div className="muted">
          Original notice from {cn.claimant}: {cn.work}
        </div>
      )}
      <blockquote className="mq-quote">{cn.statement}</blockquote>
      {cn.contact && <div className="muted">Contact: {cn.contact}</div>}
      {cn.status === 'pending' && (
        <div className="row-actions top-gap">
          <button className="btn btn-sm btn-primary" onClick={() => decide(cn, 'accept')}>
            Accept and restore
          </button>
          <button className="btn btn-sm" onClick={() => decide(cn, 'reject')}>
            Reject
          </button>
        </div>
      )}
    </div>
  ));
}

function Log() {
  const [actions, setActions] = useState(null);
  useEffect(() => {
    api('/mod/log?limit=200').then((r) => setActions(r.actions)).catch(() => setActions([]));
  }, []);
  if (actions === null) return <div className="spinner" />;
  if (!actions.length) return <p className="muted">No moderation actions yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Target</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.id}>
              <td>{timeAgo(a.created_at)}</td>
              <td>{a.actor_label}</td>
              <td>{a.action}</td>
              <td>{a.target_label || a.target_id || ''}</td>
              <td className="muted">{a.details || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpamSettings() {
  const toast = useToast();
  const [s, setS] = useState(null);
  useEffect(() => {
    api('/mod/settings').then((r) => setS(r.settings)).catch(() => {});
  }, []);
  if (!s) return <div className="spinner" />;
  const save = async (patch) => {
    try {
      const r = await api('/mod/settings', { method: 'PATCH', body: patch });
      setS(r.settings);
      toast('Saved');
    } catch (e) {
      toast(e.message);
    }
  };
  const toggle = (key, label, hint) => (
    <label className="toggle-row">
      <span className="toggle-text">
        <b>{label}</b>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={s[key] === 'true'} onChange={(e) => save({ [key]: e.target.checked })} />
    </label>
  );
  return (
    <div className="card-panel">
      <h2>Comment spam controls</h2>
      <p className="hint">These apply to everyone, including people commenting from other instances. Uploaders and moderators are never held.</p>
      {toggle('spam_hold_first_comments', "Hold a person's first comment", 'Their first comment waits for the uploader or a moderator; after that they post freely.')}
      {toggle('spam_hold_links_new_accounts', 'Hold links from new accounts')}
      {toggle('spam_check_impersonation', "Hold names that imitate the uploader", 'Catches lookalike names such as "Jawsh" vs "Jawsh_" or "J4wsh".')}
      <div className="field-row top-gap">
        <div className="field">
          <label>New account period (hours)</label>
          <input className="input" type="number" min={0} defaultValue={s.spam_new_account_hours} onBlur={(e) => save({ spam_new_account_hours: e.target.value })} />
        </div>
        <div className="field">
          <label>Comments per 10 minutes</label>
          <input className="input" type="number" min={1} defaultValue={s.spam_rate_per_10min} onBlur={(e) => save({ spam_rate_per_10min: e.target.value })} />
        </div>
        <div className="field">
          <label>…for new accounts</label>
          <input className="input" type="number" min={1} defaultValue={s.spam_rate_new_per_10min} onBlur={(e) => save({ spam_rate_new_per_10min: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

const TABS = [
  ['reports', 'Reports'],
  ['held', 'Held comments'],
  ['counter', 'Appeals'],
  ['log', 'Audit log'],
  ['spam', 'Spam settings'],
];

export default function AdminModeration() {
  const { user } = useAuth();
  const [tab, setTab] = useState('reports');
  const [summary, setSummary] = useState(null);
  useTitle('Moderation');
  useEffect(() => {
    api('/mod/summary').then(setSummary).catch(() => {});
  }, [tab]);
  const count = { reports: summary?.open_reports, held: summary?.held_comments, counter: summary?.pending_counter_notices };
  return (
    <div className="page page-wide">
      {user.is_admin && <AdminTabs />}
      <h1>
        <Icon name="gavel" /> Moderation
      </h1>
      {summary?.pending_accounts > 0 && user.is_admin && (
        <div className="notice">
          {summary.pending_accounts} new account{summary.pending_accounts === 1 ? ' is' : 's are'} waiting for approval under <Link to="/admin">Overview → Users</Link>.
        </div>
      )}
      <div className="tabs flat-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
            {count[k] ? <span className="tab-count">{count[k]}</span> : null}
          </button>
        ))}
      </div>
      <div className="mq">
        {tab === 'reports' && <Reports />}
        {tab === 'held' && <HeldComments />}
        {tab === 'counter' && <CounterNotices />}
        {tab === 'log' && <Log />}
        {tab === 'spam' && <SpamSettings />}
      </div>
    </div>
  );
}
