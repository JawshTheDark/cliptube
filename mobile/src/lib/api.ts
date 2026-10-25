// HTTP client for one ClipTube server. Signs in with a bearer token (ClipTube 1.5+), never cookies,
// and only ever sends that token to the server it belongs to.
import { File, FileMode, UploadType } from 'expo-file-system';
import { fetch as nativeFetch } from 'expo/fetch';

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

export type UploadFile = { uri: string; name: string; type: string; size?: number | null; lastModified?: number | null };

/** An upload in pieces on the server (ClipTube 1.10+). */
export type ServerUpload = { id: string; kind: string; name: string; size: number; offset: number; chunk_size: number; fingerprint: string | null };

const MiB = 1024 * 1024;
// Pieces of 8 MiB: little to resend after a dropped phone connection, far under Cloudflare's 100 MB request cap.
const PIECE = 8 * MiB;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type UploadProgress = (sent: number, total: number, resumedFrom?: number) => void;

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
   * Uploads a video and creates it with `fields`. On ClipTube 1.10+ the file goes up in pieces that survive a
   * dropped connection: each piece can be sent again, the server skips bytes it already has, and choosing the
   * same file again later picks up where it stopped. Older servers (no /api/uploads) get it in one request.
   */
  uploadVideo<T = any>(fields: Record<string, string>, file: UploadFile, onProgress?: UploadProgress) {
    const state = { cancelled: false, abortPiece: null as null | (() => void), uploadId: null as string | null };
    const cancelled = () => new ApiError(0, 'Upload cancelled');
    const promise = (async (): Promise<T> => {
      const size = file.size || 0;
      let up: ServerUpload | null = null;
      if (size > 0) {
        try {
          up = await this.findOrStartUpload(file, size);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e; // 404: a server before 1.10
        }
      }
      if (!up) {
        const once = this.upload<T>('/videos', fields, file, onProgress);
        state.abortPiece = once.abort;
        return once.promise;
      }
      state.uploadId = up.id;
      await this.sendPieces(up, file, size, onProgress, state);
      if (state.cancelled) throw cancelled();
      // A refusal here (a game not in the list, the quota) keeps the upload: trying again skips the sending.
      return this.post<T>('/videos', {
        upload_id: up.id,
        title: fields.title,
        description: fields.description,
        tags: fields.tags,
        game: fields.game,
        visibility: fields.visibility,
        allow_clips: fields.allow_clips === 'true',
      });
    })();
    return {
      promise,
      abort: () => {
        state.cancelled = true;
        state.abortPiece?.();
        if (state.uploadId) this.del(`/uploads/${encodeURIComponent(state.uploadId)}`).catch(() => {});
      },
    };
  }

  /** An unfinished upload of this same file (to resume), or a new one. */
  private async findOrStartUpload(file: UploadFile, size: number): Promise<ServerUpload> {
    const fingerprint = `app:${file.lastModified || 0}:${size}`;
    const { uploads } = await this.get<{ uploads: ServerUpload[] }>('/uploads');
    const same = uploads.find((u) => u.kind === 'video' && u.name === file.name && u.size === size && u.fingerprint === fingerprint);
    if (same) return same;
    const r = await this.post<{ upload: ServerUpload }>('/uploads', { kind: 'video', name: file.name, size, fingerprint });
    return r.upload;
  }

  private async sendPieces(
    up: ServerUpload,
    file: UploadFile,
    size: number,
    onProgress: UploadProgress | undefined,
    state: { cancelled: boolean; abortPiece: null | (() => void) },
  ) {
    const url = `${this.base}/api/uploads/${encodeURIComponent(up.id)}`;
    let offset = up.offset;
    let piece = Math.min(up.chunk_size || PIECE, PIECE);
    let failures = 0;
    onProgress?.(offset, size, offset > 0 ? offset : undefined);
    if (offset >= size) return;
    const handle = new File(file.uri).open(FileMode.ReadOnly);
    // After a drop: wait longer each time, then ask the server how much arrived.
    const recover = async (why: string) => {
      failures += 1;
      if (failures > 8) throw new ApiError(0, `${why} Try again later: the upload picks up where it stopped.`);
      await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
      try {
        offset = (await this.get<{ upload: ServerUpload }>(`/uploads/${encodeURIComponent(up.id)}`)).upload.offset;
      } catch {
        /* still offline: try the same piece again */
      }
    };
    try {
      while (offset < size) {
        if (state.cancelled) return;
        handle.offset = offset;
        const bytes = await handle.readBytes(Math.min(piece, size - offset));
        if (!bytes.length) throw new ApiError(0, 'The file couldn’t be read. Choose it again.');
        const ctrl = new AbortController();
        state.abortPiece = () => ctrl.abort();
        let res: Response;
        try {
          res = (await nativeFetch(url, {
            method: 'PUT',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/octet-stream',
              'Upload-Offset': String(offset),
              ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            },
            body: bytes,
            signal: ctrl.signal,
          })) as unknown as Response;
        } catch {
          if (state.cancelled) return;
          await recover('The connection keeps dropping.');
          continue;
        }
        let data: any = null;
        try {
          data = await res.json();
        } catch {
          /* not JSON */
        }
        if (res.ok && data?.upload) {
          offset = data.upload.offset;
          failures = 0;
          onProgress?.(offset, size);
        } else if (res.status === 409 && data?.upload) {
          offset = data.upload.offset; // the server has a different idea of where this continues
        } else if (res.status === 413 && piece > MiB) {
          piece = Math.max(MiB, Math.floor(piece / 2)); // a proxy with a smaller request limit
        } else if (res.status >= 500 || res.status === 429 || res.status === 408) {
          await recover(data?.error || `The server keeps answering ${res.status}.`);
        } else {
          throw new ApiError(res.status, data?.error || `Upload failed (${res.status})`);
        }
      }
    } finally {
      handle.close();
    }
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
