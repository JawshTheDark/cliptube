import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AccountTab } from '@/components/settings/AccountTab';
import { AppsTab } from '@/components/settings/AppsTab';
import { ChannelTab } from '@/components/settings/ChannelTab';
import { NotificationsTab, WatchingTab } from '@/components/settings/NotificationsTab';
import { Button, Chip, Empty, Loading, toast } from '@/components/ui';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const TABS = [
  ['channel', 'Channel'],
  ['notifications', 'Notifications'],
  ['watching', 'Watching'],
  ['account', 'Account'],
  ['apps', 'Apps'],
] as const;
type Tab = (typeof TABS)[number][0];

/** Settings, the website's /settings in the same tabs: Channel, Notifications, Watching, Account, Apps. */
export default function AccountSettings() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const { api, user } = useSession();
  const [tab, setTab] = useState<Tab>((TABS.find(([k]) => k === params.tab)?.[0] as Tab) || 'channel');
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (!user) return;
    api.get('/me/settings').then(setS).catch((e) => toast(e.message));
  }, [api, user]);
  const patch = useCallback(
    async (body: Record<string, unknown>, message?: string) => {
      try {
        await api.patch('/me', body);
        setS((x: any) => ({ ...x, ...body }));
        if (message) toast(message);
      } catch (e: any) {
        toast(e.message);
      }
    },
    [api],
  );
  if (!user) {
    return (
      <Empty icon="person-outline" title="Sign in to change your settings">
        <View style={{ marginTop: 8 }}>
          <Button title="Sign in" kind="accent" onPress={() => router.push('/login')} />
        </View>
      </Empty>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 10 }} style={{ flexGrow: 0 }}>
        {TABS.map(([k, label]) => (
          <Chip key={k} label={label} active={tab === k} onPress={() => setTab(k)} />
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={[{ padding: 16, paddingTop: 4, gap: 14, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled">
        {!s ? (
          <Loading />
        ) : tab === 'channel' ? (
          <ChannelTab s={s} patch={patch} setS={setS} />
        ) : tab === 'notifications' ? (
          <NotificationsTab />
        ) : tab === 'watching' ? (
          <WatchingTab s={s} patch={patch} />
        ) : tab === 'account' ? (
          <AccountTab s={s} />
        ) : (
          <AppsTab />
        )}
      </ScrollView>
    </View>
  );
}
