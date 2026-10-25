import { Tabs } from 'expo-router';
import { Icon, type IconName } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const icon =
  (name: IconName, active: IconName = name) =>
  ({ color, focused }: { color: unknown; focused: boolean }) => <Icon name={focused ? active : name} color={String(color)} size={26} />;

export default function TabsLayout() {
  const { unread, user } = useSession();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.text2,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.hairline },
        tabBarLabelStyle: { fontSize: 11 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('home') }} />
      <Tabs.Screen name="explore" options={{ title: 'Explore', tabBarIcon: icon('explore') }} />
      <Tabs.Screen name="upload" options={{ title: 'Upload', tabBarIcon: icon('add-circle-outline', 'add-circle') }} />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: icon('notifications-none', 'notifications'),
          tabBarBadge: user && unread ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent, color: '#fff', fontSize: 10 },
        }}
      />
      <Tabs.Screen name="you" options={{ title: 'You', tabBarIcon: icon('person-outline', 'person') }} />
    </Tabs>
  );
}
