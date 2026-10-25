import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../auth.jsx';

const REASONS = [
  ['copyright', 'Copyright', "It uses someone's work without permission"],
  ['spam', 'Spam or scam', 'Misleading, repetitive or a scam'],
  ['harassment', 'Harassment or hate', 'Targets a person or group'],
  ['illegal', 'Illegal content', 'Breaks the law'],
  ['other', 'Something else', ''],
];

/**
 * Report a video, comment or channel. `target` = { type, id, label, extra } where type is one of
 * video, comment, user, remote_video, remote_comment.
 */
export function ReportDialog({ target, onClose }) {
  const toast = useToast();
  const { site } = useAuth();
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (!reason) return setError('Pick a reason');
    setBusy(true);
    setError(null);
    try {
      await api('/reports', { method: 'POST', body: { target_type: target.type, target_id: target.id, reason, details, ...(target.extra || {}) } });
      toast('Thanks. The moderators will take a look.');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remote = target.type.startsWith('remote_');
  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-label="Report">
        <h2>
          Report {target.type === 'user' ? 'channel' : target.type.replace('remote_', '')}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </h2>
        {target.label && <p className="muted report-target">{target.label}</p>}
        <div className="report-reasons">
          {REASONS.map(([value, label, hint]) => (
            <label key={value} className={`report-reason ${reason === value ? 'active' : ''}`}>
              <input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} />
              <span>
                <b>{label}</b>
                {hint && <span className="hint">{hint}</span>}
              </span>
            </label>
          ))}
        </div>
        <div className="field">
          <label>Details (optional)</label>
          <textarea className="textarea" rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything that helps the moderators" />
        </div>
        {reason === 'copyright' && (
          <p className="hint">
            If you own the work, a formal notice is handled fastest through the contact details on the{' '}
            <Link to="/legal" onClick={onClose}>
              legal page
            </Link>
            .
          </p>
        )}
        {remote && <p className="hint">This report goes to the moderators here and to the instance that hosts it.</p>}
        {site.has_legal && reason !== 'copyright' && (
          <p className="hint">
            See the{' '}
            <Link to="/legal" onClick={onClose}>
              rules
            </Link>{' '}
            for what's allowed here.
          </p>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row-actions end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !reason}>
            {busy ? 'Sending…' : 'Report'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A small flag button that opens the report dialog (signed-in people only). */
export function ReportButton({ target, className = 'btn', label = 'Report', iconOnly = false }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Report">
        <Icon name="flag" size={iconOnly ? 18 : undefined} />
        {!iconOnly && label}
      </button>
      {open && <ReportDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
