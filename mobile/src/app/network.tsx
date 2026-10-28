import { useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { Notice, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { VideoList } from '@/components/VideoList';
import { Button, Chip, Empty } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

/** The website's /network: videos from the other servers in this one's network and the fediverse servers it follows. */
export default function Network() {
  const { api, site, user } = useSession();
  const [peer, setPeer] = useState('');
  const [sort, setSort] = useState<'new' | 'views'>('new');
  const net = site?.network || {};
  // OurTube servers in the network first, then the fediverse servers followed from here.
  const all = site?.network_peers || [];
  const peers = [...all.filter((p) => p.software === 'ourtube'), ...all.filter((p) => p.software !== 'ourtube')];
  const firstFediverse = peers.find((p) => p.software !== 'ourtube');
  const current = peers.find((p) => String(p.id) === peer);
  const path = useMemo(() => (site?.federation ? `/videos?scope=network&sort=${sort}${peer ? `&peer=${peer}` : ''}` : null), [site?.federation, peer, sort]);
  const paged = usePaged<Video>(api, path);
  const pick = (p: string, by: 'new' | 'views') => {
    setPeer(p);
    setSort(by);
  };

  if (!site?.federation) {
    return (
      <Empty icon="public" title={net.role === 'member' ? 'Waiting for the network' : 'Not part of a network'}>
        <Text style={{ color: colors.text2, textAlign: 'center' }}>
          {net.role === 'member' ? "This site has asked to join a network and is waiting for the hub's approval." : 'This site is not connected to other OurTube servers.'}
        </Text>
        {user?.is_admin && (
          <View style={{ marginTop: 12 }}>
            <Button title="Network settings" kind="accent" onPress={() => router.push('/admin/network' as any)} />
          </View>
        )}
      </Empty>
    );
  }

  const header = (
    <View style={{ gap: 8, paddingBottom: 8 }}>
      <Text style={[fs.hint, { paddingHorizontal: 12, paddingTop: 8 }]}>
        Videos from the other OurTube servers in the network, and from the fediverse servers and channels followed here. Each one is still hosted and streamed by its own server.
      </Text>
      {!!net.announcement && (
        <View style={{ paddingHorizontal: 12 }}>
          <Notice icon="campaign">{net.announcement}</Notice>
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
        <Chip label="All servers" active={!peer && sort === 'new'} onPress={() => pick('', 'new')} />
        <Chip label="Most viewed" active={!peer && sort === 'views'} onPress={() => pick('', 'views')} />
        {peers.map((p) => (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {p === firstFediverse && <Text style={s.label}>Fediverse</Text>}
            <Chip label={p.name} active={peer === String(p.id)} onPress={() => pick(String(p.id), 'new')} />
          </View>
        ))}
      </ScrollView>
      {!!current && (
        <Text style={[fs.hint, { paddingHorizontal: 12 }]}>
          Showing clips from{' '}
          <Text style={{ color: colors.link }} onPress={() => Linking.openURL(current.url)}>
            {current.url}
          </Text>
        </Text>
      )}
    </View>
  );
  return (
    <>
      <Stack.Screen options={{ title: net.name || 'Network' }} />
      <VideoList paged={paged} header={header} empty={<Empty icon="public" title="No clips from other servers yet">New clips show up here after the next sync.</Empty>} />
    </>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  label: { color: colors.text2, fontSize: 12.5, fontWeight: '700', marginLeft: 4 },
});
