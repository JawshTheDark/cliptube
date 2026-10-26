import { Linking, type StyleProp, type TextStyle } from 'react-native';
import { colors } from '@/lib/theme';
import { Text } from './Text';

/** "1:23" or "1:02:03" -> seconds. */
export function parseStamp(s: string): number | null {
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// The website's pattern (web/src/components/RichText.jsx): addresses, and times like 1:23 or 1:02:03.
const PATTERN = /(https?:\/\/[^\s<]+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g;

/**
 * A description or comment with tappable addresses, and times ("1:23", "1:02:03") that jump the video there when
 * `onSeek` is given.
 */
export function RichText({ text, onSeek, style }: { text: string; onSeek?: (seconds: number) => void; style?: StyleProp<TextStyle> }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let tappable = false; // text with nothing to tap stays selectable for copying
  for (const m of text.matchAll(PATTERN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    if (m[1]) {
      tappable = true;
      const href = m[1];
      parts.push(
        <Text key={at} style={{ color: colors.link }} onPress={() => Linking.openURL(href).catch(() => {})} accessibilityRole="link">
          {href}
        </Text>,
      );
    } else if (onSeek) {
      tappable = true;
      const stamp = m[2];
      const secs = parseStamp(stamp);
      parts.push(
        <Text
          key={at}
          style={{ color: colors.link, fontWeight: '700' }}
          onPress={() => secs !== null && onSeek(secs)}
          accessibilityRole="button"
          accessibilityLabel={`Jump to ${stamp}`}
        >
          {stamp}
        </Text>,
      );
    } else parts.push(m[2]);
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <Text style={style} selectable={!tappable}>
      {parts}
    </Text>
  );
}
