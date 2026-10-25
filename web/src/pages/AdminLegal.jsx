import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { AdminTabs } from './Admin.jsx';
import { formatDate } from '../util.js';

const EMPTY_NOTICE = { video: '', claimant: '', claimant_contact: '', work: '', url: '', received_at: '', action: 'removed', notes: '' };

export default function AdminLegal() {
  const { refresh } = useAuth();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(EMPTY_NOTICE);
  const [busy, setBusy] = useState(false);
  useTitle('Legal');

  const apply = (s) => {
    setState(s);
    setForm(s.settings);
  };
  useEffect(() => {
    api('/admin/legal').then(apply).catch((e) => toast(e.message));
  }, [toast]);

  if (!state || !form) {
    return (
      <div className="page page-wide">
        <AdminTabs />
        <div className="spinner" />
      </div>
    );
  }
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(state.settings);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      apply(await api('/admin/legal', { method: 'PATCH', body: form }));
      refresh().catch(() => {});
      toast('Saved');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const record = async (e) => {
    e.preventDefault();
    if (notice.action === 'removed' && !window.confirm('Record this notice and remove the video now?')) return;
    setBusy(true);
    try {
      apply(await api('/admin/legal/takedowns', { method: 'POST', body: notice }));
      setNotice(EMPTY_NOTICE);
      toast(notice.action === 'removed' ? 'Notice recorded and video removed' : 'Notice recorded');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-wide">
      <AdminTabs />
      <h1>
        <Icon name="gavel" /> Legal
      </h1>
      <p className="page-sub flush">
        Background, not legal advice: in the US, the DMCA safe harbors expect a registered DMCA agent, quick action on valid notices and a repeat-infringer
        policy. The README has more. Talk to a lawyer before opening an instance to strangers.
      </p>

      <div className="admin-grid">
        <section className="card-panel">
          <h2>Legal page</h2>
          <p className="hint">
            Shown at <Link to="/legal">/legal</Link>, linked from the sidebar, watch pages and sign-up.
          </p>
          <form onSubmit={save}>
            <div className="field">
              <label>Contact email for abuse and copyright</label>
              <input className="input" type="email" value={form.legal_contact_email} onChange={(e) => set({ legal_contact_email: e.target.value })} />
            </div>
            <div className="field">
              <label>DMCA agent</label>
              <textarea className="textarea" rows={3} value={form.legal_dmca_agent} onChange={(e) => set({ legal_dmca_agent: e.target.value })} placeholder="Name, address, phone and email as registered with the US Copyright Office" />
            </div>
            <div className="field">
              <label>Rules</label>
              <textarea className="textarea" rows={6} value={form.legal_rules} onChange={(e) => set({ legal_rules: e.target.value })} placeholder="What's allowed here" />
            </div>
            <div className="field">
              <label>Terms people accept at sign-up</label>
              <textarea className="textarea" rows={4} value={form.legal_terms} onChange={(e) => set({ legal_terms: e.target.value })} placeholder="Leave empty to skip the checkbox at sign-up" />
            </div>
            <label className="toggle-row">
              <span className="toggle-text">
                <b>Publish a transparency report</b>
                <span className="hint">Counts of notices, removals and restored videos at /transparency.</span>
              </span>
              <input type="checkbox" className="switch" checked={form.legal_transparency_public === 'true'} onChange={(e) => set({ legal_transparency_public: e.target.checked ? 'true' : 'false' })} />
            </label>

            <h3 className="sub-h">Repeat infringers</h3>
            <label className="toggle-row">
              <span className="toggle-text">
                <b>Strike the uploader when a notice removes a video</b>
              </span>
              <input type="checkbox" className="switch" checked={form.strike_on_takedown === 'true'} onChange={(e) => set({ strike_on_takedown: e.target.checked ? 'true' : 'false' })} />
            </label>
            <div className="field-row top-gap">
              <div className="field">
                <label>Strikes that suspend an account</label>
                <input className="input" type="number" min={0} value={form.strike_threshold} onChange={(e) => set({ strike_threshold: e.target.value })} />
                <span className="hint">0 turns automatic suspension off</span>
              </div>
              <div className="field">
                <label>Strikes expire after (days)</label>
                <input className="input" type="number" min={0} value={form.strike_expiry_days} onChange={(e) => set({ strike_expiry_days: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Keep removed videos' files for (days)</label>
              <input className="input" type="number" min={1} value={form.removed_retention_days} onChange={(e) => set({ removed_retention_days: e.target.value })} />
              <span className="hint">Long enough for a counter-notice; the files are deleted afterwards.</span>
            </div>
            <button className="btn btn-primary" disabled={!dirty || busy}>
              Save
            </button>
          </form>
        </section>

        <section className="card-panel">
          <h2>Record a takedown notice</h2>
          <form onSubmit={record}>
            <div className="field">
              <label>Video link or id</label>
              <input className="input" value={notice.video} onChange={(e) => setNotice({ ...notice, video: e.target.value })} placeholder="https://.../watch/abc123" />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Claimant</label>
                <input className="input" value={notice.claimant} onChange={(e) => setNotice({ ...notice, claimant: e.target.value })} required />
              </div>
              <div className="field">
                <label>Claimant contact</label>
                <input className="input" value={notice.claimant_contact} onChange={(e) => setNotice({ ...notice, claimant_contact: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Copyrighted work</label>
              <textarea className="textarea" rows={2} value={notice.work} onChange={(e) => setNotice({ ...notice, work: e.target.value })} required />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Received</label>
                <input className="input" type="date" value={notice.received_at} onChange={(e) => setNotice({ ...notice, received_at: e.target.value })} />
              </div>
              <div className="field">
                <label>Action</label>
                <select className="select" value={notice.action} onChange={(e) => setNotice({ ...notice, action: e.target.value })}>
                  <option value="removed">Remove the video</option>
                  <option value="none">Record only</option>
                  <option value="rejected">Reject (invalid notice)</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Notes</label>
              <textarea className="textarea" rows={2} value={notice.notes} onChange={(e) => setNotice({ ...notice, notes: e.target.value })} />
            </div>
            <button className="btn btn-primary" disabled={busy}>
              Record notice
            </button>
          </form>

          <h3 className="sub-h">Takedown log ({state.notices.length})</h3>
          {state.notices.length === 0 ? (
            <p className="muted">No notices yet.</p>
          ) : (
            <div className="fed-list">
              {state.notices.map((n) => (
                <div key={n.id} className="fed-item">
                  <div className="fed-main">
                    <div className="fed-name">
                      {n.video_id ? <Link to={`/watch/${n.video_id}`}>{n.video_title || n.video_id}</Link> : n.url || 'No video'}
                      <span className={`badge ${n.action === 'removed' ? 'err' : ''}`}>{n.action}</span>
                      {n.status !== 'closed' && <span className="badge warn">{n.status}</span>}
                    </div>
                    <div className="fed-sub">
                      {n.claimant} · {formatDate(n.received_at)} · {n.work}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
