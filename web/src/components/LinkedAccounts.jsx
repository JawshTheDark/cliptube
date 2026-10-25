import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { copyText, timeAgo } from '../util.js';

/** Settings: link this account with the same person's accounts on other sites. A link counts once both list each other. */
export function LinkedAccounts() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/me/links')
      .then(setS)
      .catch(() => setS(null));
  }, []);

  const run = async (fn, done) => {
    setBusy(true);
    try {
      const r = await fn();
      setS(r);
      if (done) toast(typeof done === 'function' ? done(r) : done);
      return true;
    } catch (err) {
      toast(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const link = (h) =>
    run(
      () => api('/me/links', { method: 'POST', body: { handle: h } }),
      (r) => (r.added?.verified ? `Linked with ${r.added.handle}` : `Added ${r.added?.handle}. Now link this account from there too.`),
    );

  if (!s) return null;
  const full = s.links.length >= s.max;
  return (
    <section className="card-panel" id="linked-accounts">
      <h2>
        <Icon name="link" /> Linked accounts
      </h2>
      <p className="hint">
        Have accounts on other ClipTube sites, or on Mastodon? Link them and every site shows them as one person: <em>Also on</em> on your channel, your
        comments from any of them marked as the uploader&apos;s, and one button to subscribe to all of them. A link counts once both accounts list each other,
        so nobody can claim an account that isn&apos;t theirs.
      </p>
      {!s.enabled && <div className="notice warn-box">Linking needs ActivityPub and this site&apos;s Public URL. Ask an admin to turn them on.</div>}

      {s.suggestions.length > 0 && (
        <>
          <h4>These accounts say they&apos;re you</h4>
          <div className="fed-list">
            {s.suggestions.map((x) => (
              <div key={x.actor} className="fed-item">
                <div className="fed-main">
                  <div className="fed-name">{x.name || x.handle}</div>
                  <div className="fed-sub">{x.handle}</div>
                </div>
                <button className="btn btn-sm" disabled={busy || full || !s.enabled} onClick={() => link(x.actor)}>
                  <Icon name="link" /> Link back
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <form
        className="follow-form top-gap"
        onSubmit={(e) => {
          e.preventDefault();
          link(handle.trim()).then((ok) => ok && setHandle(''));
        }}
      >
        <input
          className="input"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="@you@other-site.example"
          aria-label="Your account on another site"
          disabled={!s.enabled || full}
        />
        <button className="btn" disabled={busy || !handle.trim() || !s.enabled || full}>
          Link
        </button>
      </form>
      <p className="hint small">
        Then, on the other site, link this account: <code>{s.handle}</code>{' '}
        <button type="button" className="link-btn" onClick={() => copyText(s.handle).then(() => toast('Copied'))}>
          Copy
        </button>
        . On Mastodon, add it under Preferences, Account, <em>Moving from a different account</em>, as an account alias (it moves nothing).
        {full && ` An account can be linked to up to ${s.max} others.`}
      </p>

      {s.links.length > 0 && (
        <div className="fed-list top-gap">
          {s.links.map((l) => (
            <div key={l.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  <a href={l.url} target="_blank" rel="me noopener noreferrer">
                    {l.name || l.handle}
                  </a>
                  {l.verified ? (
                    <span className="badge ok" title={`Checked ${timeAgo(l.checked_at)}`}>
                      <Icon name="check" /> Linked both ways
                    </span>
                  ) : (
                    <span className="badge warn">
                      <Icon name="hourglass" /> Waiting for it to link back
                    </span>
                  )}
                </div>
                <div className="fed-sub">
                  {l.handle}
                  {l.channel ? ' · has a channel' : ''}
                </div>
                {l.error && <div className="fed-err">{l.error}</div>}
              </div>
              <button
                className="icon-btn"
                title="Unlink"
                disabled={busy}
                onClick={() => window.confirm(`Unlink ${l.handle}?`) && run(() => api(`/me/links/${l.id}`, { method: 'DELETE' }), 'Unlinked')}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          {s.links.some((l) => !l.verified) && (
            <div>
              <button className="btn btn-sm" disabled={busy || !s.enabled} onClick={() => run(() => api('/me/links/check', { method: 'POST' }), 'Checked again')}>
                Check again
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
