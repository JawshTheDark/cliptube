import { useEffect } from 'react';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SessionProvider, useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});
SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg, primary: colors.accent, text: colors.text, border: colors.hairline },
};

function Root() {
  const { ready } = useSession();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return null;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
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
      <Stack.Screen name="edit/[id]" options={{ title: 'Edit clip' }} />
    </Stack>
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
