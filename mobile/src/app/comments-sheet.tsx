import { useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommentsView } from '@/components/Comments';
import { Heading } from '@/components/Text';
import { IconButton } from '@/components/ui';
import { seekCurrent } from '@/lib/playback';
import { useLinkedApi } from '@/lib/scope';
import { colors } from '@/lib/theme';

/**
 * Comments as a sheet over the lower part of the screen, so the Short above keeps playing in view. A time in a
 * comment jumps it there; tapping above the sheet closes it.
 */
export default function CommentsSheet() {
  const params = useLocalSearchParams<{ path: string; server?: string }>();
  const { api, foreign } = useLinkedApi(params.server);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The sheet rides up with the keyboard, shrinking to stay below the status bar.
  const keyboard = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  const sheetHeight = Math.min(Math.round(height * 0.62), height - keyboard - insets.top - 48);
  const [count, setCount] = useState<number | null>(null);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <View style={{ flex: 1 }}>
      <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close comments" />
      <View style={[s.sheet, { height: sheetHeight, marginBottom: keyboard }]}>
        <View style={s.grip} />
        <View style={s.head}>
          <Heading style={s.title}>{`Comments${count !== null ? ` · ${count}` : ''}`}</Heading>
          <IconButton name="close" label="Close comments" onPress={close} />
        </View>
        <CommentsView api={api} foreign={foreign} path={params.path} onSeek={(t) => seekCurrent(t)} onCount={setCount} avoidKeyboard={false} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', borderTopWidth: 1, borderColor: colors.border },
  grip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.surface3, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4 },
  title: { flex: 1, fontSize: 18 },
});
