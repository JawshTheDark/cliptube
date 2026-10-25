import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { itemHref } from '@/lib/refs';
import { withServer } from '@/lib/scope';
import { colors } from '@/lib/theme';
import type { Api } from '@/lib/api';
import type { Playlist, PlaylistItem } from '@/lib/types';
import { IconButton } from './ui';

// Kept for the whole session, like the website's preferences: loop and autoplay, and each list's shuffled order.
const prefs = { loop: false, autoplay: true };
const shuffled = new Map<string, number[]>();

function shuffledOrder(listId: string, ids: number[]): number[] {
  let order = shuffled.get(listId);
  if (!order) {
    order = [...ids];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    shuffled.set(listId, order);
  }
  // Clips added since go at the end.
  const known = new Set(order);
  return [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !known.has(id))];
}

export type PlaylistNav = { next: PlaylistItem | null; goNext: () => void; autoplay: boolean };

/**
 * The playlist a clip is playing from: where it is in the list, what's next, shuffle, loop and autoplay.
 * Reports what plays next to the watch screen, which moves on when the clip ends.
 */
export function PlaylistBar({
  api,
  foreign,
  listId,
  currentRef,
  shuffle: shuffleParam,
  onNav,
}: {
  api: Api;
  foreign: string | null;
  listId: string;
  currentRef: string | null;
  shuffle: boolean;
  onNav: (nav: PlaylistNav) => void;
}) {
  const [p, setP] = useState<Playlist | null>(null);
  const [shuffle, setShuffle] = useState(shuffleParam);
  const [loop, setLoop] = useState(prefs.loop);
  const [autoplay, setAutoplay] = useState(prefs.autoplay);

  useEffect(() => {
    api
      .get<{ playlist: Playlist }>(`/playlists/${encodeURIComponent(listId)}`)
      .then((r) => setP(r.playlist))
      .catch(() => setP(null));
  }, [api, listId]);

  const items = useMemo(() => {
    const ok = (p?.items || []).filter((it) => it.available);
    if (!shuffle) return ok;
    const byId = new Map(ok.map((it) => [it.id, it]));
    return shuffledOrder(listId, ok.map((it) => it.id))
      .map((id) => byId.get(id))
      .filter((x): x is PlaylistItem => !!x);
  }, [p, shuffle, listId]);

  const index = items.findIndex((it) => it.ref === currentRef);
  const next = index >= 0 && index + 1 < items.length ? items[index + 1] : loop && items.length ? items[0] : null;
  const go = (it: PlaylistItem) => router.replace(withServer(itemHref(it, listId, shuffle), foreign) as any);

  useEffect(() => {
    onNav({ next, autoplay, goNext: () => next && go(next) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.id, autoplay, shuffle]);

  if (!p) return null;
  return (
    <View style={s.bar}>
      <Pressable style={{ flex: 1 }} onPress={() => router.push(withServer(`/playlist/${encodeURIComponent(p.id)}`, foreign) as any)}>
        <Text style={s.title} numberOfLines={1}>
          {p.title}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {index >= 0 ? `${index + 1} of ${items.length}` : `${items.length} clips`}
          {next ? ` · Next: ${next.video?.community?.title || next.title}` : ' · End of the list'}
        </Text>
      </Pressable>
      <IconButton name="shuffle" size={20} label="Shuffle" color={shuffle ? colors.accent : colors.text2} onPress={() => setShuffle((x) => !x)} />
      <IconButton
        name="repeat"
        size={20}
        label="Loop the playlist"
        color={loop ? colors.accent : colors.text2}
        onPress={() => setLoop((x) => (prefs.loop = !x))}
      />
      <IconButton
        name={autoplay ? 'play-circle-filled' : 'play-circle-outline'}
        size={20}
        label="Play the next clip automatically"
        color={autoplay ? colors.accent : colors.text2}
        onPress={() => setAutoplay((x) => (prefs.autoplay = !x))}
      />
      {next && <IconButton name="skip-next" size={22} label="Next clip" onPress={() => go(next)} />}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, marginHorizontal: 12, marginTop: 10, paddingLeft: 12, paddingRight: 4, paddingVertical: 6, borderRadius: 12, backgroundColor: colors.surface },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.text2, fontSize: 12 },
});

