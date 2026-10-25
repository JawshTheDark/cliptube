// A small server-sent events client. React Native has no EventSource, but expo/fetch streams response bodies,
// and unlike EventSource it can send headers (the sign-in token, or a watch party guest's token).
import { fetch as streamingFetch } from 'expo/fetch';

export type SseHandlers = {
  onEvent: (event: string, data: any) => void;
  onOpen?: () => void;
  /** A refusal (401, 403, 404...). The stream stops unless `retry` returns true. */
  onRefused?: (status: number, message: string | null) => boolean | void;
};

/** Incremental UTF-8 decoding, for chunks that may end in the middle of a character. */
class Utf8Stream {
  private pending: number[] = [];
  private native = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  decode(bytes: Uint8Array): string {
    if (this.native) return this.native.decode(bytes, { stream: true });
    const all = this.pending.length ? Uint8Array.from([...this.pending, ...bytes]) : bytes;
    // Keep an incomplete trailing sequence for the next chunk.
    let end = all.length;
    for (let k = 1; k <= 3 && k <= all.length; k++) {
      const b = all[all.length - k];
      if ((b & 0xc0) === 0x80) continue; // continuation byte
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (need > k) end = all.length - k;
      break;
    }
    this.pending = Array.from(all.slice(end));
    let out = '';
    for (let i = 0; i < end; ) {
      const b = all[i];
      let cp: number;
      if (b < 0x80) cp = all[i++];
      else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (all[i + 1] & 0x3f), (i += 2);
      else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((all[i + 1] & 0x3f) << 6) | (all[i + 2] & 0x3f), (i += 3);
      else cp = ((b & 0x07) << 18) | ((all[i + 1] & 0x3f) << 12) | ((all[i + 2] & 0x3f) << 6) | (all[i + 3] & 0x3f), (i += 4);
      out += String.fromCodePoint(cp);
    }
    return out;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Follows an event stream, reconnecting after drops like EventSource does. Returns a function that stops it. */
export function openEvents(url: string, headers: Record<string, string>, h: SseHandlers): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;

  const run = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await streamingFetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: ctrl.signal });
        if (!res.ok) {
          let message: string | null = null;
          try {
            message = JSON.parse(await res.text()).error || null;
          } catch {
            /* not JSON */
          }
          if (!h.onRefused?.(res.status, message)) return;
        } else if (res.body) {
          h.onOpen?.();
          const reader = res.body.getReader();
          const dec = new Utf8Stream();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            buf += dec.decode(value).replace(/\r\n/g, '\n');
            let cut: number;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              let event = 'message';
              const data: string[] = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              if (!data.length) continue;
              try {
                h.onEvent(event, JSON.parse(data.join('\n')));
              } catch {
                /* a bad message shouldn't end the stream */
              }
            }
          }
        }
      } catch {
        /* dropped: reconnect below */
      }
      if (!stopped) await sleep(3000);
    }
  };
  run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}
