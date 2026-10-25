export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

/** PUTs one piece of an upload with progress; a refusal carries where the server has the upload (`upload`). */
function putPiece(id, offset, blob, onSent, setXhr) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    setXhr(xhr);
    xhr.open('PUT', `/api/uploads/${id}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* a proxy's error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new ApiError(xhr.status, data?.error || `Upload failed (${xhr.status})`);
      err.upload = data?.upload;
      reject(err);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
    xhr.send(blob);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a file in pieces (/api/uploads) that carry on after a dropped connection, so it also gets through proxies
 * that cap a request's size, such as Cloudflare's 100 MB. Picks up an unfinished upload of the same file (or
 * `resume`) where it stopped. Resolves with the finished upload's id, to pass on as upload_id.
 * onRetry(n) says it is trying again for the nth time, and onRetry(0) that it is going again.
 * Returns { promise, abort(keep) }: abort gives the upload up, unless keep is true.
 */
export function sendInPieces(file, { kind = 'video', resume, onStart, onProgress, onRetry } = {}) {
  let xhr = null;
  let stopped = false;
  let keepIt = false;
  let id = null;
  const fingerprint = String(file.lastModified || '');
  const promise = (async () => {
    const { uploads } = await api('/uploads');
    let up = uploads.find((u) => (resume ? u.id === resume : u.kind === kind && u.name === file.name && u.size === file.size && u.fingerprint === fingerprint));
    if (!up) up = (await api('/uploads', { method: 'POST', body: { kind, name: file.name, size: file.size, fingerprint } })).upload;
    id = up.id;
    if (stopped) {
      if (!keepIt) api(`/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
      throw new ApiError(0, 'Upload cancelled');
    }
    onStart?.(id);
    let offset = up.offset;
    let piece = up.chunk_size;
    let fails = 0;
    onProgress?.(offset, file.size);
    while (offset < file.size) {
      if (stopped) throw new ApiError(0, 'Upload cancelled');
      const at = offset;
      try {
        const r = await putPiece(id, at, file.slice(at, Math.min(file.size, at + piece)), (sent) => onProgress?.(at + sent, file.size), (x) => (xhr = x));
        offset = r.upload.offset;
        if (fails) onRetry?.(0); // going again
        fails = 0;
      } catch (e) {
        if (stopped) throw new ApiError(0, 'Upload cancelled');
        if (e.status === 409 && e.upload) {
          offset = e.upload.offset;
          continue;
        }
        // A proxy in the way that takes smaller requests than that.
        if (e.status === 413 && piece > 1048576) {
          piece = Math.max(1048576, Math.floor(piece / 2));
          continue;
        }
        // Still taking an earlier piece (409), or a proxy or server hiccup: wait, ask where it stands, go on.
        if (e.status >= 400 && e.status < 500 && ![408, 409, 429].includes(e.status)) throw e;
        if (++fails > 8) throw e;
        onRetry?.(fails);
        await wait(Math.min(30_000, 1000 * 2 ** fails));
        offset = await api(`/uploads/${id}`).then((r) => r.upload.offset, () => offset);
      }
    }
    return id;
  })();
  const abort = (keep = false) => {
    stopped = true;
    keepIt = keep;
    xhr?.abort();
    if (id && !keep) api(`/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
  };
  return { promise, abort };
}
