import { useEffect } from 'react';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Welcome } from '@/components/Welcome';
import { SessionProvider, useSession } from '@/lib/session';
import { colors, fonts } from '@/lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});
SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg, primary: colors.accent, text: colors.text, border: colors.hairline, notification: colors.accent },
  // Headers, tab labels and the rest of the navigation chrome in the app's own font.
  fonts: {
    regular: { fontFamily: fonts.text, fontWeight: '400' as const },
    medium: { fontFamily: fonts.text, fontWeight: '600' as const },
    bold: { fontFamily: fonts.text, fontWeight: '700' as const },
    heavy: { fontFamily: fonts.text, fontWeight: '800' as const },
  },
};

function Root() {
  const { ready, needsSetup } = useSession();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return null;
  return (
    <>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.display, fontWeight: '800' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="watch/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="n/[peer]/[remote]" options={{ headerShown: false }} />
      <Stack.Screen name="c/[username]" options={{ title: '' }} />
      <Stack.Screen name="g/[id]" options={{ title: '' }} />
      <Stack.Screen name="comments" options={{ title: 'Comments', presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="login" options={{ title: 'Sign in', presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="servers" options={{ title: 'Servers', presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="library/[kind]" options={{ title: '' }} />
      <Stack.Screen name="edit/[id]" options={{ title: 'Edit video' }} />
      <Stack.Screen name="links" options={{ title: 'Linked accounts' }} />
      <Stack.Screen name="playlist/[id]" options={{ title: 'Playlist' }} />
      <Stack.Screen name="save" options={{ title: 'Save to', presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="party/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ title: 'App settings' }} />
      <Stack.Screen name="live/[username]" options={{ headerShown: false }} />
      <Stack.Screen name="shorts/[id]" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="shorts/n/[peer]/[remote]" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="comments-sheet" options={{ headerShown: false, presentation: 'transparentModal', animation: 'slide_from_bottom', contentStyle: { backgroundColor: 'transparent' } }} />
    </Stack>
    {/* No server chosen yet: pick one first. The navigator stays mounted underneath, so links still work after. */}
    {needsSetup && (
      <View style={StyleSheet.absoluteFill}>
        <Welcome />
      </View>
    )}
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* The app draws edge to edge, so the window doesn't shrink for the keyboard; this tracks it instead. */}
      <KeyboardProvider>
        <ThemeProvider value={theme}>
          <SessionProvider>
            <StatusBar style="light" />
            <Root />
          </SessionProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
