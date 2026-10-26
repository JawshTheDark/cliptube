import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { formatDate } from '../util.js';

/** Your webhooks: your new videos and live streams, sent to your bots, bridges or chat channels. */
export function Webhooks() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ url: '', format: 'json', secret: '', events: ['video.published', 'live.started'] });
  const load = () => api('/me/webhooks').then(setData).catch((e) => toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (fn, done) => {
    try {
      await fn();
      if (done) toast(done);
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const create = (e) => {
    e.preventDefault();
    act(async () => {
      await api('/me/webhooks', { method: 'POST', body: draft });
      setDraft({ ...draft, url: '', secret: '' });
    }, 'Webhook added');
  };
  const test = (h) =>
    act(async () => {
      const r = await api(`/me/webhooks/${h.id}/test`, { method: 'POST' });
      toast(r.ok ? `Test sent: the other end answered ${r.status}` : `Test failed: ${r.error}`);
    });
  const toggleEvent = (ev) => setDraft((d) => ({ ...d, events: d.events.includes(ev) ? d.events.filter((x) => x !== ev) : [...d.events, ev] }));
  return (
    <section className="card-panel" id="webhooks">
      <h2>Webhooks</h2>
      <p className="hint">
        Tell a bot, a bridge or a chat channel when you publish a video or go live. JSON sends the whole event; Discord and Slack send a message with the
        link. With a secret, each delivery is signed in <code>X-OurTube-Signature</code> (also sent as <code>X-ClipTube-Signature</code>).
      </p>
      <form onSubmit={create}>
        <div className="field-row align-end">
          <div className="field grow">
            <label>Address</label>
            <input className="input" value={draft.url} required placeholder="https://bot.example.com/ourtube" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </div>
          <div className="field">
            <label>Format</label>
            <select className="select" value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>
              {Object.entries(data?.formats || { json: 'JSON' }).map(([k, label]) => (
                <option key={k} value={k}>
                  {label.split(':')[0]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Secret (optional)</label>
            <input className="input" value={draft.secret} maxLength={200} autoComplete="off" onChange={(e) => setDraft({ ...draft, secret: e.target.value })} />
          </div>
        </div>
        <div className="row-actions">
          {Object.entries(data?.events || {}).map(([ev, label]) => (
            <label key={ev} className="check-row">
              <input type="checkbox" checked={draft.events.includes(ev)} onChange={() => toggleEvent(ev)} /> {label}
            </label>
          ))}
          <button className="btn btn-primary" disabled={!draft.events.length}>
            Add
          </button>
        </div>
      </form>
      {data === null ? (
        <div className="spinner" />
      ) : data.webhooks.length === 0 ? (
        <p className="muted">No webhooks yet.</p>
      ) : (
        <div className="fed-list">
          {data.webhooks.map((h) => (
            <div key={h.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  <code>{h.url}</code>
                  <span className="badge">{h.format}</span>
                  {!h.enabled && <span className="badge">off</span>}
                  {h.has_secret && <span className="badge">signed</span>}
                </div>
                <div className="fed-sub">
                  {h.events.join(', ')}
                  {h.last_attempt_at
                    ? h.last_error
                      ? ` · failed ${formatDate(h.last_attempt_at)}: ${h.last_error}`
                      : ` · delivered ${formatDate(h.last_attempt_at)}`
                    : ' · nothing sent yet'}
                </div>
              </div>
              <div className="row-actions end">
                <button className="btn btn-sm" onClick={() => test(h)}>
                  Test
                </button>
                <button className="btn btn-sm" onClick={() => act(() => api(`/me/webhooks/${h.id}`, { method: 'PATCH', body: { enabled: !h.enabled } }))}>
                  {h.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button
                  className="icon-btn"
                  title="Delete webhook"
                  onClick={() => window.confirm(`Delete the webhook to ${h.url}?`) && act(() => api(`/me/webhooks/${h.id}`, { method: 'DELETE' }), 'Webhook deleted')}
                >
                  <Icon name="delete" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
