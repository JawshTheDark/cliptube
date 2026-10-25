import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { formatDate } from '../util.js';

/** Public legal page: rules, terms, abuse and copyright contacts. */
export function Legal() {
  const [info, setInfo] = useState(null);
  useTitle('Rules and contact');
  useEffect(() => {
    api('/legal').then(setInfo).catch(() => setInfo({}));
  }, []);
  if (!info) return <div className="spinner" />;
  const nothing = !info.rules && !info.terms && !info.contact_email && !info.dmca_agent;
  return (
    <div className="page page-narrow legal">
      <h1>
        <Icon name="gavel" /> Rules and contact
      </h1>
      {nothing && <p className="muted">The admins of {info.site_name} haven't published rules or contact details yet.</p>}
      {info.rules && (
        <section>
          <h2>Rules</h2>
          <p className="pre">{info.rules}</p>
        </section>
      )}
      {info.terms && (
        <section>
          <h2>Terms</h2>
          <p className="pre">{info.terms}</p>
        </section>
      )}
      {(info.contact_email || info.dmca_agent) && (
        <section>
          <h2>Report abuse or copyright infringement</h2>
          <p>Signed-in people can use the flag button on any video, comment or channel. Otherwise:</p>
          {info.contact_email && (
            <p>
              Email <a href={`mailto:${info.contact_email}`}>{info.contact_email}</a>
            </p>
          )}
          {info.dmca_agent && (
            <>
              <h3>DMCA agent</h3>
              <p className="pre">{info.dmca_agent}</p>
            </>
          )}
          <p className="hint">
            A copyright notice should identify the work, the video's link, your contact details, and a statement that you believe the use isn't authorised.
            If your video was removed and you think it was a mistake, open it while signed in to send a counter-notice.
          </p>
        </section>
      )}
      {info.transparency_public && (
        <p>
          <Link to="/transparency">Transparency report</Link>
        </p>
      )}
    </div>
  );
}

export function Transparency() {
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  useTitle('Transparency report');
  useEffect(() => {
    api('/transparency').then(setT).catch(setError);
  }, []);
  if (error) return <div className="page page-narrow muted">This site doesn't publish a transparency report.</div>;
  if (!t) return <div className="spinner" />;
  const rows = [
    ['Copyright notices received', t.takedown_notices],
    ['Videos removed after a notice', t.videos_removed_for_copyright],
    ['Notices rejected as invalid', t.notices_rejected],
    ['Counter-notices received', t.counter_notices],
    ['Videos restored after a counter-notice', t.videos_restored],
    ['Reports received', t.reports_received],
    ['Reports acted on', t.reports_actioned],
    ['Accounts suspended or banned', t.accounts_suspended_or_banned],
  ];
  return (
    <div className="page page-narrow">
      <h1>Transparency report</h1>
      <p className="muted">All time{t.since ? `, since ${formatDate(t.since)}` : ''}.</p>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {rows.map(([label, n]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.notices?.length > 0 && (
        <>
          <h2 className="sub-h">Copyright notices</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>From</th>
                  <th>Work</th>
                  <th>Video</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {t.notices.map((n, i) => (
                  <tr key={i}>
                    <td>{formatDate(n.received_at)}</td>
                    <td>{n.claimant}</td>
                    <td>{n.work}</td>
                    <td>{n.video_title || '—'}</td>
                    <td>{n.status === 'restored' ? 'Restored after counter-notice' : { removed: 'Removed', none: 'No action', rejected: 'Rejected' }[n.action] || n.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
