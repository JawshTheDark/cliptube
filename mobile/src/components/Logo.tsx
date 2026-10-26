import { StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { Text } from './Text';

/**
 * The OurTube mark, the website's 32×32 logo drawn with views: a purple circle (cx 13, r 11) over a fainter one
 * (cx 21, r 9), with a white play triangle (M10 11.2v9.6l7.6-4.8z).
 */
export function LogoMark({ size = 30, color = colors.accent }: { size?: number; color?: string }) {
  const k = size / 32;
  const circle = (cx: number, r: number, opacity: number) => ({
    position: 'absolute' as const,
    left: (cx - r) * k,
    top: (16 - r) * k,
    width: 2 * r * k,
    height: 2 * r * k,
    borderRadius: r * k,
    backgroundColor: color,
    opacity,
  });
  return (
    <View style={{ width: size, height: size }} accessible={false}>
      <View style={circle(21, 9, 0.45)} />
      <View style={circle(13, 11, 1)} />
      <View
        style={{
          position: 'absolute',
          left: 10 * k,
          top: 11.2 * k,
          width: 0,
          height: 0,
          borderTopWidth: 4.8 * k,
          borderBottomWidth: 4.8 * k,
          borderLeftWidth: 7.6 * k,
          borderTopColor: 'transparent',
          borderBottomColor: 'transparent',
          borderLeftColor: '#fff',
        }}
      />
    </View>
  );
}

/** A server still called OurTube gets the two-tone wordmark; any other name is shown as it is. */
export const isOurTube = (name: string | null | undefined) => /^\s*ourtube\s*$/i.test(name || '');

export function Wordmark({ name, size = 22, style }: { name: string; size?: number; style?: StyleProp<TextStyle> }) {
  const ours = isOurTube(name);
  return (
    <Text style={[s.word, { fontSize: size, letterSpacing: -0.045 * size }, style]} numberOfLines={1}>
      {ours ? (
        <>
          <Text style={[s.word, { fontSize: size, color: colors.accentText }]}>our</Text>
          tube
        </>
      ) : (
        name
      )}
    </Text>
  );
}

const s = StyleSheet.create({
  word: { fontFamily: fonts.display, fontWeight: '800', color: colors.text, includeFontPadding: false },
});
