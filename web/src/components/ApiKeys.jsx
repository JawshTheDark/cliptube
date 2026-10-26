import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { formatDate } from '../util.js';

const VISIBILITY = { unlisted: 'Unlisted', public: 'Public', private: 'Private' };

/** A ShareX custom uploader (.sxcu) that sends recordings here with this key and copies the watch link. */
function downloadShareX(key, uploadUrl, siteName) {
  const config = {
    Version: '16.1.0',
    Name: siteName,
    DestinationType: 'FileUploader',
    RequestMethod: 'POST',
    RequestURL: uploadUrl,
    Headers: { Authorization: `Bearer ${key}` },
    Body: 'MultipartFormData',
    FileFormName: 'file',
    URL: '{json:url}',
    ErrorMessage: '{json:error}',
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
  a.download = `${siteName.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'OurTube'}.sxcu`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Your API keys: upload from ShareX, scripts or anything that can send a file with a header. */
export function ApiKeys() {
  const toast = useToast();
  const { site } = useAuth();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ name: '', visibility: 'unlisted', publish: true });
  const [fresh, setFresh] = useState(null); // the key just made: shown this once
  const load = () => api('/me/api-keys').then(setData).catch((e) => toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const create = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/me/api-keys', { method: 'POST', body: { ...draft, name: draft.name || 'ShareX' } });
      setFresh(r.key);
      setDraft({ ...draft, name: '' });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async (k) => {
    if (!window.confirm(`Delete the key "${k.name}"? Anything using it stops uploading.`)) return;
    try {
      await api(`/me/api-keys/${k.id}`, { method: 'DELETE' });
      toast('Key deleted');
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy; select it and copy it yourself');
    }
  };
  const uploadUrl = data?.upload_url || `${window.location.origin}/api/videos`;
  return (
    <section className="card-panel" id="api-keys">
      <h2>API keys</h2>
      <p className="hint">
        Upload from ShareX, a script or any tool that can send a file with a header. A key can only upload videos, as you, and the answer has the
        video&apos;s link. Each key sets what its uploads are when the upload doesn&apos;t say.
      </p>
      <form onSubmit={create}>
        <div className="field-row align-end">
          <div className="field grow">
            <label>Name</label>
            <input className="input" value={draft.name} maxLength={60} placeholder="ShareX" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Uploads are</label>
            <select className="select" value={draft.visibility} onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}>
              {Object.entries(VISIBILITY).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row-actions">
          <label className="check-row">
            <input type="checkbox" checked={draft.publish} onChange={(e) => setDraft({ ...draft, publish: e.target.checked })} /> Publish right away (off: they
            wait as drafts until you save their details)
          </label>
          <button className="btn btn-primary">Make a key</button>
        </div>
      </form>
      {fresh && (
        <div className="notice top-gap">
          <p>
            <b>Your new key.</b> It is shown only now: copy it or download the ShareX config before you leave this page.
          </p>
          <div className="copy-row">
            <code>{fresh}</code>
            <button className="btn btn-sm" onClick={() => copy(fresh)}>
              Copy
            </button>
            <button className="btn btn-sm btn-accent" onClick={() => downloadShareX(fresh, uploadUrl, site.site_name)}>
              <Icon name="download" /> ShareX config
            </button>
          </div>
          <p className="hint top-gap">
            In ShareX, open the downloaded <code>.sxcu</code> file, then pick it under <i>Destinations → File uploader</i>. Anything else can send a POST with
            the file as <code>file</code> (plus <code>title</code>, <code>description</code>, <code>visibility</code> or <code>tags</code> if you like):
          </p>
          <pre className="code-block">{`curl -H "Authorization: Bearer ${fresh}" -F "file=@video.mp4" ${uploadUrl}`}</pre>
        </div>
      )}
      {data === null ? (
        <div className="spinner" />
      ) : data.keys.length === 0 ? (
        <p className="muted">No keys yet.</p>
      ) : (
        <div className="fed-list">
          {data.keys.map((k) => (
            <div key={k.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  {k.name}
                  <code>{k.prefix}…</code>
                  <span className="badge">{VISIBILITY[k.visibility] || k.visibility}</span>
                  {!k.publish && <span className="badge">drafts</span>}
                </div>
                <div className="fed-sub">
                  Made {formatDate(k.created_at)} · {k.last_used_at ? `last used ${formatDate(k.last_used_at)}` : 'not used yet'}
                </div>
              </div>
              <div className="row-actions end">
                <button className="icon-btn" title="Delete key" onClick={() => remove(k)}>
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
