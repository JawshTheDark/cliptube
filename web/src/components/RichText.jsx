import { parseTimestamp } from '../util.js';

/**
 * Text from a description or a comment with clickable addresses, and timestamps ("1:23", "1:02:03") that jump
 * the video there when `onSeek` is given.
 */
export function RichText({ text, onSeek }) {
  const parts = [];
  const re = /(https?:\/\/[^\s<]+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      const href = m[1];
      parts.push(
        <a key={m.index} href={href} target="_blank" rel="nofollow ugc noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {href}
        </a>,
      );
    } else if (onSeek) {
      const ts = m[2];
      parts.push(
        <button
          key={m.index}
          type="button"
          className="ts"
          title={`Jump to ${ts}`}
          onClick={(e) => {
            e.stopPropagation();
            onSeek(parseTimestamp(ts));
          }}
        >
          {ts}
        </button>,
      );
    } else parts.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
