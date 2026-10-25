// HTTP client for one ClipTube server. Signs in with a bearer token (ClipTube 1.5+), never cookies,
// and only ever sends that token to the server it belongs to.
import { File, UploadType } from 'expo-file-system';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** "clips.irc.so" or "https://clips.irc.so/watch/x" -> "https://clips.irc.so" */
export function normalizeServerUrl(input: string): string {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a server address');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`"${input}" is not a valid address`);
  }
  if (!u.hostname) throw new Error(`"${input}" is not a valid address`);
  return `${u.protocol}//${u.host}`.toLowerCase();
}

/** Plain http to anything but this device or a LAN address sends the password in the clear. */
export function isInsecure(base: string): boolean {
  try {
    const u = new URL(base);
    if (u.protocol === 'https:') return false;
    return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch {
    return true;
  }
}

type ReqOpts = { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> };

export type UploadFile = { uri: string; name: string; type: string };

export class Api {
  readonly base: string;
  readonly token: string | null;

  constructor(base: string, token: string | null = null) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  /** Absolute URL for a path the server returned (local media is relative, network media absolute). */
  abs(path: string | null | undefined): string | null {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** The Authorization header, only for URLs on this server. */
  authFor(url: string | null | undefined): Record<string, string> | undefined {
    if (!this.token || !url) return undefined;
    const abs = this.abs(url);
    if (!abs) return undefined;
    try {
      if (new URL(abs).origin !== new URL(this.base).origin) return undefined;
    } catch {
      return undefined;
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  async req<T = any>(path: string, { method = 'GET', body, signal, headers: extra }: ReqOpts = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload: any;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      // credentials: 'omit' keeps React Native's cookie jar out of it: the token is the only sign-in.
      res = await fetch(`${this.base}/api${path}`, { method, headers, body: payload, signal, credentials: 'omit' });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      throw new ApiError(0, `Can't reach ${hostLabel(this.base)}. Check your connection.`);
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
    return data as T;
  }

  get<T = any>(path: string, signal?: AbortSignal) {
    return this.req<T>(path, { signal });
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.req<T>(path, { method: 'POST', body });
  }
  patch<T = any>(path: string, body: unknown = {}) {
    return this.req<T>(path, { method: 'PATCH', body });
  }
  put<T = any>(path: string, body: unknown = {}) {
    return this.req<T>(path, { method: 'PUT', body });
  }
  del<T = any>(path: string, body?: unknown) {
    return this.req<T>(path, { method: 'DELETE', body });
  }

  /**
   * Multipart upload with progress, through expo-file-system's native uploader. It streams the file from
   * its content:// or file:// URI in large chunks; React Native's own networking wraps upload bodies in a
   * stream that writes one byte at a time, which made a 10 MB clip take over a minute on a fast link.
   */
  upload<T = any>(path: string, fields: Record<string, string>, file: UploadFile, onProgress?: (sent: number, total: number) => void) {
    let cancelled = false;
    const task = new File(file.uri).createUploadTask(`${this.base}/api${path}`, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: file.type,
      parameters: fields,
      headers: { Accept: 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      onProgress: ({ bytesSent, totalBytes }) => onProgress?.(bytesSent, totalBytes),
    });
    const promise = task.uploadAsync().then(
      (r) => {
        let data: any = null;
        try {
          data = JSON.parse(r.body);
        } catch {
          /* not JSON */
        }
        if (r.status >= 200 && r.status < 300) return data as T;
        throw new ApiError(r.status, data?.error || `Upload failed (${r.status})`);
      },
      (e) => {
        throw new ApiError(0, cancelled ? 'Upload cancelled' : `The upload was interrupted (${e?.message || 'network error'}). Check your connection and try again.`);
      },
    );
    return {
      promise,
      abort: () => {
        cancelled = true;
        task.cancel();
      },
    };
  }
}

export function hostLabel(base: string): string {
  return base.replace(/^https?:\/\//, '');
}

/** "r-3-abc" (a clip from another instance in the network) -> { peer: '3', remote: 'abc' } */
export function parseRemoteId(id: string): { peer: string; remote: string } | null {
  const m = /^r-(\d+)-(.+)$/.exec(id);
  return m ? { peer: m[1], remote: m[2] } : null;
}

/** The app route for a video from a list (local clips and network clips have different pages). */
export function videoHref(v: { id: string; remote?: { peer_id: number; remote_id: string } }): string {
  if (v.remote) return `/n/${v.remote.peer_id}/${encodeURIComponent(v.remote.remote_id)}`;
  const r = parseRemoteId(v.id);
  return r ? `/n/${r.peer}/${encodeURIComponent(r.remote)}` : `/watch/${encodeURIComponent(v.id)}`;
}
