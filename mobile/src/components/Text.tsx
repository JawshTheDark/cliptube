import { type ComponentProps } from 'react';
import { Text as RNText, TextInput as RNTextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '@/lib/theme';

/**
 * React Native's Text and TextInput with OurTube's text font. Every screen imports these instead of the plain ones,
 * since Android has no app-wide default font for React Native text.
 */
export function Text({ style, ...props }: ComponentProps<typeof RNText>) {
  return <RNText {...props} style={[base.text, style]} />;
}

export function TextInput({ style, ...props }: ComponentProps<typeof RNTextInput>) {
  return <RNTextInput placeholderTextColor={colors.text2} selectionColor={colors.accent} cursorColor={colors.accentText} {...props} style={[base.text, style]} />;
}

/** Headings and the wordmark. */
export function Heading({ style, ...props }: ComponentProps<typeof RNText>) {
  return <RNText {...props} style={[base.heading, style]} />;
}

const base = StyleSheet.create({
  text: { fontFamily: fonts.text },
  heading: { fontFamily: fonts.display, fontWeight: '800', letterSpacing: -0.4, color: colors.text },
});
