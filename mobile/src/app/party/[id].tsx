import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Share, StyleSheet, Switch, View, useWindowDimensions } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { Button, Empty, ErrorBox, Icon, IconButton, Loading, toast, type IconName } from '@/components/ui';
import { f } from '@/components/VideoForm';
import { Api } from '@/lib/api';
import { duration } from '@/lib/format';
import { refFromLink } from '@/lib/refs';
import { useLinkedApi } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { openEvents } from '@/lib/sse';
import { colors } from '@/lib/theme';
import type { Party, PartyState, PlaylistItem, PlaylistSummary } from '@/lib/types';

type Tab = 'chat' | 'queue' | 'people';
type Bubble = { key: number; emoji: string; name: string; left: number };

/** The server's clock minus this phone's, from the quickest of a few round trips. */
async function measureOffset(api: Api, id: string, headers: Record<string, string>) {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const r = await api.req<{ now: number }>(`/parties/${encodeURIComponent(id)}/time`, { headers });
    const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: r.now - (t0 + (t1 - t0) / 2) };
  }
  return best?.offset || 0;
}

/**
 * A watch party (OurTube 1.8): everyone sees the same video at the same moment, with chat and reactions. The
 * server keeps the playback state; every player works out where it should be and corrects itself. The host
 * steers (or everyone, if the host allows it, or anyone while the host is away); others can step out and back.
 */
export default function PartyScreen() {
  const { id, server } = useLocalSearchParams<{ id: string; server?: string }>();
  const { api, foreign } = useLinkedApi(server);
  const session = useSession();
  const signedIn = !!session.user && !foreign;
  const base = foreign || session.server;
  const insets = useSafeAreaInsets();
  const storeKey = `party_${`${base}_${id}`.replace(/[^A-Za-z0-9]/g, '_')}`;

  const [guestToken, setGuestToken] = useState<string | null | undefined>(undefined);
  const [party, setParty] = useState<Party | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [following, setFollowing] = useState(true);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [name, setName] = useState('');
  const offset = useRef(0);
  const stateRef = useRef<PartyState | null>(null);
  // While typing, the player shrinks and the title and tabs step aside, so the chat stays in view.
  const typing = useKeyboardState((k) => k.isVisible);

  // People without an account on this server join as guests, with a token kept per party.
  useEffect(() => {
    if (signedIn) return setGuestToken(null);
    SecureStore.getItemAsync(storeKey)
      .then((t) => setGuestToken(t))
      .catch(() => setGuestToken(null));
  }, [signedIn, storeKey]);
  const member = signedIn || !!guestToken;
  const headers = useMemo<Record<string, string>>(() => (!signedIn && guestToken ? { 'x-room-member': guestToken } : ({} as Record<string, string>)), [signedIn, guestToken]);

  const call = useCallback(
    <T,>(path: string, method = 'POST', body?: unknown) => api.req<T>(`/parties/${encodeURIComponent(id)}${path}`, { method, body, headers }),
    [api, id, headers],
  );

  // The party's details (enough for the join screen), and the clock offset.
  useEffect(() => {
    if (guestToken === undefined) return;
    api
      .req<{ party: Party }>(`/parties/${encodeURIComponent(id)}`, { headers })
      .then((r) => {
        setParty((p) => p || r.party);
        stateRef.current = stateRef.current || r.party.state;
      })
      .catch((e) => setError(e.status === 404 ? 'This watch party has ended, or the link is wrong.' : e.message));
    measureOffset(api, id, headers)
      .then((o) => (offset.current = o))
      .catch(() => {});
  }, [api, id, headers, guestToken]);

  // The live stream of what happens in the party.
  useEffect(() => {
    if (!member) return;
    const url = `${api.base}/api/parties/${encodeURIComponent(id)}/events`;
    return openEvents(url, { ...headers, ...(api.authFor(url) || {}) }, {
      onEvent: (event, data) => {
        switch (event) {
          case 'hello':
            stateRef.current = data.state;
            setParty(data);
            break;
          case 'state':
            stateRef.current = data;
            setParty((p) => (p ? { ...p, state: data } : p));
            break;
          case 'members':
            setParty((p) => (p ? { ...p, members: data.members } : p));
            break;
          case 'queue':
            setParty((p) => (p ? { ...p, queue: data.queue } : p));
            break;
          case 'chat':
            setParty((p) => (p ? { ...p, messages: [...p.messages, data].slice(-200) } : p));
            break;
          case 'chat_deleted':
            setParty((p) => (p ? { ...p, messages: p.messages.filter((m) => m.id !== data.id) } : p));
            break;
          case 'settings':
            setParty((p) => (p ? { ...p, ...data } : p));
            break;
          case 'react': {
            const key = Date.now() + Math.random();
            setBubbles((b) => [...b.slice(-12), { key, emoji: data.emoji, name: data.name, left: 10 + Math.random() * 70 }]);
            setTimeout(() => setBubbles((b) => b.filter((x) => x.key !== key)), 2600);
            break;
          }
          case 'ended':
            setEnded(true);
            break;
        }
      },
      onRefused: (status, message) => {
        if (status === 401 && !signedIn) {
          // The guest token is gone (the party restarted or was cleaned up): join again.
          SecureStore.deleteItemAsync(storeKey).catch(() => {});
          setGuestToken(null);
        } else if (status === 404) setEnded(true);
        else setError(message || `Can't follow this party (${status})`);
        return false;
      },
    });
  }, [api, id, member, headers, signedIn, storeKey]);

  const join = async () => {
    try {
      const r = await api.req<{ token: string }>(`/parties/${encodeURIComponent(id)}/join`, { method: 'POST', body: { name: name.trim() } });
      await SecureStore.setItemAsync(storeKey, r.token);
      setGuestToken(r.token);
    } catch (e: any) {
      toast(e.message);
    }
  };

  const top = (
    <View style={[s.topBar, { paddingTop: insets.top + 4 }]}>
      <IconButton name="arrow-back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <Text style={s.topTitle} numberOfLines={1}>
        {party?.title || 'Watch party'}
      </Text>
      {party && <IconButton name="share" label="Share the party link" onPress={() => Share.share({ message: `${base}/party/${id}` }).catch(() => {})} />}
    </View>
  );

  if (ended) {
    return (
      <View style={s.screen}>
        {top}
        <Empty icon="groups" title="This watch party has ended">
          <Button title="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        </Empty>
      </View>
    );
  }
  if (error) {
    return (
      <View style={s.screen}>
        {top}
        <ErrorBox message={error} />
      </View>
    );
  }
  if (!party || guestToken === undefined) {
    return (
      <View style={s.screen}>
        {top}
        <Loading />
      </View>
    );
  }
  if (!member) {
    return (
      <View style={s.screen}>
        {top}
        <View style={{ padding: 20, gap: 12 }}>
          <Text style={s.joinTitle}>Join “{party.title}”</Text>
          <Text style={s.hint}>
            {party.host ? `${party.host.display_name} is hosting. ` : ''}Pick a name to watch along and chat, or sign in on this server to join as yourself.
          </Text>
          {party.locked ? (
            <Text style={[s.hint, { color: colors.warn }]}>The host locked this party, so nobody new can join.</Text>
          ) : (
            <>
              <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.text2} style={f.input} maxLength={32} onSubmitEditing={join} />
              <Button title="Join" kind="primary" onPress={join} disabled={name.trim().length < 2} />
            </>
          )}
          {!foreign && <Button title="Sign in instead" onPress={() => router.push('/login')} />}
        </View>
      </View>
    );
  }

  const you = party.you;
  const hostOnline = !!party.host && party.members.some((m) => m.id === party.host!.member_id);
  const canControl = !!you && (you.is_host || party.control === 'everyone' || !hostOnline);
  const index = party.queue.findIndex((q) => q.id === party.state.item_id);
  const current = index >= 0 ? party.queue[index] : null;

  const control = (action: string, extra: Record<string, unknown> = {}) => call('/control', 'POST', { action, ...extra }).catch((e: any) => toast(e.message));

  return (
    <KeyboardAvoidingView style={s.screen} behavior="padding">
      {top}
      <View>
        {current?.video?.video_url ? (
          <PartyPlayer
            key={current.id}
            item={current}
            api={api}
            stateRef={stateRef}
            offset={offset}
            following={following}
            canControl={canControl}
            hasPrev={index > 0}
            hasNext={index >= 0 && index < party.queue.length - 1}
            onControl={control}
            onStepOut={() => setFollowing((x) => !x)}
            compact={typing}
          />
        ) : (
          <View style={s.noVideo}>
            <Icon name="videocam-off" size={36} color={colors.text2} />
            <Text style={s.hint}>{party.queue.length ? 'This video is no longer available.' : 'The queue is empty.'}</Text>
          </View>
        )}
        <View style={s.bubbles} pointerEvents="none">
          {bubbles.map((b) => (
            <Text key={b.key} style={[s.bubble, { left: `${b.left}%` }]}>
              {b.emoji}
            </Text>
          ))}
        </View>
      </View>

      {!typing && (
        <>
          <View style={s.infoRow}>
            <Text style={s.nowTitle} numberOfLines={1}>
              {current ? current.video?.community?.title || current.title : 'Nothing playing'}
            </Text>
            <Text style={s.hint}>{`${party.members.length} watching${!following ? ' · you stepped out' : ''}`}</Text>
          </View>

          <View style={s.tabs}>
            {(['chat', 'queue', 'people'] as Tab[]).map((t) => (
              <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]}>
                <Text style={[s.tabText, tab === t && { color: colors.text }]}>
                  {t === 'chat' ? 'Chat' : t === 'queue' ? `Queue · ${party.queue.length}` : `People · ${party.members.length}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <View style={{ flex: 1 }}>
        {tab === 'chat' ? (
          <Chat party={party} call={call} bottom={insets.bottom} />
        ) : tab === 'queue' ? (
          <Queue party={party} call={call} canControl={canControl} onControl={control} api={api} signedIn={signedIn} />
        ) : (
          <People party={party} call={call} base={base} onEnded={() => setEnded(true)} />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ---- the player ------------------------------------------------------------------------------------------

function PartyPlayer({
  item,
  api,
  stateRef,
  offset,
  following,
  canControl,
  hasPrev,
  hasNext,
  onControl,
  onStepOut,
  compact = false,
}: {
  item: PlaylistItem;
  api: Api;
  stateRef: React.MutableRefObject<PartyState | null>;
  offset: React.MutableRefObject<number>;
  following: boolean;
  canControl: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onControl: (action: string, extra?: Record<string, unknown>) => void;
  onStepOut: () => void;
  compact?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const view = useRef<VideoView>(null);
  const v = item.video!;
  const url = api.abs(v.video_url)!;
  const source = useMemo<VideoSource>(() => ({ uri: url, headers: api.authFor(url), contentType: 'progressive', metadata: { title: v.title } }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEventListener(player, 'statusChange', ({ status }) => setReady(status === 'readyToPlay'));
  useEventListener(player, 'timeUpdate', ({ currentTime }) => setTime(currentTime));
  useEventListener(player, 'playingChange', ({ isPlaying }) => setPlaying(isPlaying));
  useEventListener(player, 'playToEnd', () => {
    if (canControl) onControl('ended', { item_id: item.id, position: player.currentTime });
  });

  // Keep the player where the party is: seek when far off, nudge the speed when a little off.
  useEffect(() => {
    if (!following || !ready) return;
    const sync = () => {
      const s = stateRef.current;
      if (!s || s.item_id !== item.id) return;
      const serverNow = Date.now() + offset.current;
      let want = s.playing ? s.position + (serverNow - s.at) / 1000 : s.position;
      if (player.duration) want = Math.min(want, player.duration);
      if (s.playing && !player.playing) player.play();
      else if (!s.playing && player.playing) player.pause();
      const drift = player.currentTime - want;
      if (Math.abs(drift) > 1 || (!s.playing && Math.abs(drift) > 0.3)) {
        player.currentTime = Math.max(0, want);
        player.playbackRate = 1;
      } else if (s.playing && Math.abs(drift) > 0.15) player.playbackRate = drift > 0 ? 0.95 : 1.05;
      else if (player.playbackRate !== 1) player.playbackRate = 1;
    };
    sync();
    const t = setInterval(sync, 500);
    return () => clearInterval(t);
  }, [following, ready, player, item.id, stateRef, offset]);

  const aspect = v.width && v.height ? v.width / v.height : 16 / 9;
  const h = Math.min(width / aspect, height * (compact ? 0.2 : 0.42));
  const total = player.duration || v.duration || 0;
  const seek = (to: number) => onControl('seek', { position: Math.max(0, Math.min(total || to, to)) });
  // Out of step: the viewer's own play button.
  const local = !following;

  const btn = (icon: IconName, label: string, onPress: () => void, disabled = false) => (
    <IconButton name={icon} label={label} onPress={disabled ? () => {} : onPress} color={disabled ? colors.surface3 : '#fff'} size={26} />
  );

  return (
    <View style={{ backgroundColor: '#000' }}>
      <View style={{ width, height: h }}>
        <VideoView ref={view} player={player} style={{ width: '100%', height: '100%' }} nativeControls={false} contentFit="contain" fullscreenOptions={{ enable: true, orientation: aspect >= 1 ? 'landscape' : 'portrait' }} />
      </View>
      <Pressable
        style={s.track}
        disabled={!canControl || !total}
        onPress={(e) => seek((e.nativeEvent.locationX / width) * total)}
        accessibilityLabel="Seek"
      >
        <View style={[s.fill, { width: `${total ? Math.min(100, (time / total) * 100) : 0}%` }]} />
      </Pressable>
      <View style={s.controls}>
        <Text style={s.time}>{`${duration(time)} / ${duration(total)}`}</Text>
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center' }}>
          {canControl ? (
            <>
              {btn('skip-previous', 'Previous video', () => onControl('prev'), !hasPrev)}
              {btn('replay-10', 'Back 10 seconds', () => seek(player.currentTime - 10))}
              {btn(playing ? 'pause' : 'play-arrow', playing ? 'Pause for everyone' : 'Play for everyone', () => onControl(playing ? 'pause' : 'play', { position: player.currentTime }))}
              {btn('forward-10', 'Forward 10 seconds', () => seek(player.currentTime + 10))}
              {btn('skip-next', 'Next video', () => onControl('next'), !hasNext)}
            </>
          ) : local ? (
            btn(playing ? 'pause' : 'play-arrow', playing ? 'Pause' : 'Play', () => (playing ? player.pause() : player.play()))
          ) : null}
        </View>
        {!canControl && (
          <Pressable onPress={onStepOut} style={s.stepOut}>
            <Text style={s.stepText}>{following ? 'Step out' : 'Back in sync'}</Text>
          </Pressable>
        )}
        <IconButton name="fullscreen" label="Fullscreen" onPress={() => view.current?.enterFullscreen()} color="#fff" size={24} />
      </View>
    </View>
  );
}

// ---- chat ------------------------------------------------------------------------------------------------

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

function Chat({ party, call, bottom }: { party: Party; call: Call; bottom: number }) {
  const [text, setText] = useState('');
  const list = useRef<FlatList>(null);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      await call('/chat', 'POST', { body });
    } catch (e: any) {
      toast(e.message);
      setText(body);
    }
  };
  const remove = (msgId: number) =>
    Alert.alert('Remove this message?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => call(`/chat/${msgId}`, 'DELETE').catch((e: any) => toast(e.message)) },
    ]);
  const you = party.you;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        data={party.messages}
        keyExtractor={(m) => String(m.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.hint, { textAlign: 'center', marginTop: 16 }]}>Say hi. Messages show up for everyone here.</Text>}
        renderItem={({ item: m }) => (
          <Pressable onLongPress={() => you && (you.is_host || m.member_id === you.member_id) && remove(m.id)}>
            <Text style={s.msg}>
              <Text style={[s.msgName, m.member_id === party.host?.member_id && { color: colors.warn }]}>{m.name} </Text>
              {m.body}
            </Text>
          </Pressable>
        )}
      />
      <View style={s.reactions}>
        {party.reactions.map((e) => (
          <Pressable key={e} onPress={() => call('/react', 'POST', { emoji: e }).catch((err: any) => toast(err.message))} style={s.reaction} accessibilityLabel={`React ${e}`}>
            <Text style={{ fontSize: 20 }}>{e}</Text>
          </Pressable>
        ))}
      </View>
      <View style={[s.composer, { paddingBottom: 8 + bottom }]}>
        <TextInput value={text} onChangeText={setText} placeholder="Message" placeholderTextColor={colors.text2} style={s.input} maxLength={500} onSubmitEditing={send} returnKeyType="send" />
        <IconButton name="send" label="Send" onPress={send} color={text.trim() ? colors.link : colors.text2} />
      </View>
    </View>
  );
}

// ---- queue -----------------------------------------------------------------------------------------------

function Queue({ party, call, canControl, onControl, api, signedIn }: { party: Party; call: Call; canControl: boolean; onControl: (a: string, e?: Record<string, unknown>) => void; api: Api; signedIn: boolean }) {
  const [link, setLink] = useState('');
  const [lists, setLists] = useState<PlaylistSummary[]>([]);
  useEffect(() => {
    if (!canControl || !signedIn) return;
    api
      .get<{ playlists: PlaylistSummary[] }>('/playlists/mine')
      .then((r) => setLists(r.playlists.filter((p) => p.item_count > 0)))
      .catch(() => {});
  }, [api, canControl, signedIn]);

  const act = (p: Promise<unknown>, done?: string) =>
    p.then(() => done && toast(done)).catch((e: any) => toast(e.message));
  const add = () => {
    const ref = refFromLink(link);
    if (!ref) return toast('Paste a link to a video on this server, or one from its network');
    setLink('');
    act(call('/queue', 'POST', { ref }), 'Added to the queue');
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= party.queue.length) return;
    const ids = party.queue.map((q) => q.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    act(call('/queue/order', 'PUT', { item_ids: ids }));
  };

  return (
    <FlatList
      data={party.queue}
      keyExtractor={(q) => String(q.id)}
      contentContainerStyle={{ paddingVertical: 6, paddingBottom: 24 }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => {
        const playing = item.id === party.state.item_id;
        return (
          <Pressable
            onPress={() => canControl && !playing && item.available && onControl('select', { item_id: item.id })}
            style={[s.qRow, playing && { backgroundColor: colors.surface }, !item.available && { opacity: 0.5 }]}
          >
            <Icon name={playing ? 'equalizer' : 'play-arrow'} size={20} color={playing ? colors.accent : colors.text2} />
            <Text style={s.qTitle} numberOfLines={2}>
              {item.video?.community?.title || item.title}
            </Text>
            {canControl && (
              <>
                <IconButton name="keyboard-arrow-up" size={20} label="Move up" onPress={() => move(index, index - 1)} color={colors.text2} />
                <IconButton name="keyboard-arrow-down" size={20} label="Move down" onPress={() => move(index, index + 1)} color={colors.text2} />
                <IconButton name="close" size={20} label="Remove from the queue" onPress={() => act(call(`/queue/${item.id}`, 'DELETE'))} color={colors.text2} />
              </>
            )}
          </Pressable>
        );
      }}
      ListFooterComponent={
        canControl ? (
          <View style={{ padding: 12, gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput value={link} onChangeText={setLink} placeholder="Paste a video link" placeholderTextColor={colors.text2} style={[f.input, { flex: 1 }]} autoCapitalize="none" onSubmitEditing={add} />
              <Button title="Add" icon="add" onPress={add} disabled={!link.trim()} />
            </View>
            {lists.length > 0 && <Text style={s.section}>Add one of your playlists</Text>}
            {lists.map((p) => (
              <Pressable key={p.id} style={s.listRow} onPress={() => act(call('/queue', 'POST', { playlist_id: p.id }), `${p.title} added to the queue`)}>
                <Icon name="playlist-add" size={20} color={colors.text2} />
                <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
                  {p.title}
                </Text>
                <Text style={s.hint}>{p.item_count}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={[s.hint, { padding: 12 }]}>The host picks what plays.</Text>
        )
      }
    />
  );
}

// ---- people and settings ---------------------------------------------------------------------------------

function People({ party, call, base, onEnded }: { party: Party; call: Call; base: string; onEnded: () => void }) {
  const you = party.you;
  const isHost = !!you?.is_host;
  const settings = (body: Record<string, unknown>) => {
    call('', 'PATCH', body).catch((e: any) => toast(e.message));
  };
  const kick = (memberId: string, name: string) =>
    Alert.alert(`Remove ${name}?`, 'They leave the party and can’t come back.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => call('/kick', 'POST', { member_id: memberId }).catch((e: any) => toast(e.message)) },
    ]);
  const end = () =>
    Alert.alert('End the watch party?', 'Everyone is told, and its chat and queue are gone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End it',
        style: 'destructive',
        onPress: () =>
          call('', 'DELETE')
            .then(onEnded)
            .catch((e: any) => toast(e.message)),
      },
    ]);
  return (
    <FlatList
      data={party.members}
      keyExtractor={(m) => m.id}
      contentContainerStyle={{ paddingBottom: 24 }}
      ListHeaderComponent={
        isHost ? (
          <View style={{ padding: 12, gap: 10 }}>
            <View style={s.setting}>
              <Text style={s.settingText}>Everyone can control playback</Text>
              <Switch value={party.control === 'everyone'} onValueChange={(on) => settings({ control: on ? 'everyone' : 'host' })} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" />
            </View>
            <View style={s.setting}>
              <Text style={s.settingText}>Lock: nobody new can join</Text>
              <Switch value={party.locked} onValueChange={(on) => settings({ locked: on })} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button title="Invite" icon="share" small onPress={() => Share.share({ message: `${base}/party/${party.id}` }).catch(() => {})} />
              <Button title="End party" icon="close" small kind="danger" onPress={end} />
            </View>
          </View>
        ) : undefined
      }
      renderItem={({ item: m }) => (
        <View style={s.person}>
          <Icon name={m.guest ? 'person-outline' : 'person'} size={22} color={colors.text2} />
          <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
            {m.name}
            {m.username ? <Text style={s.hint}>{`  @${m.username}`}</Text> : null}
            {m.guest ? <Text style={s.hint}>  guest</Text> : null}
          </Text>
          {m.id === party.host?.member_id && <Icon name="star" size={18} color={colors.warn} />}
          {isHost && m.id !== you?.member_id && <IconButton name="person-remove" size={20} label={`Remove ${m.name}`} onPress={() => kick(m.id, m.name)} color={colors.text2} />}
        </View>
      )}
    />
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4, backgroundColor: colors.bg },
  topTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  joinTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  hint: { color: colors.text2, fontSize: 13 },
  noVideo: { aspectRatio: 16 / 9, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 8 },
  track: { height: 14, justifyContent: 'center', backgroundColor: '#000' },
  fill: { height: 3, backgroundColor: colors.accent },
  controls: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#000', paddingHorizontal: 6, paddingBottom: 4 },
  time: { color: '#ddd', fontSize: 12, width: 86 },
  stepOut: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.15)' },
  stepText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  bubbles: { position: 'absolute', left: 0, right: 0, bottom: 40, height: 60 },
  bubble: { position: 'absolute', bottom: 0, fontSize: 30 },
  infoRow: { paddingHorizontal: 12, paddingTop: 8, gap: 2 },
  nowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline, marginTop: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.text },
  tabText: { color: colors.text2, fontSize: 13, fontWeight: '600' },
  msg: { color: colors.text, fontSize: 14, lineHeight: 19 },
  msgName: { color: colors.link, fontWeight: '700' },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 6, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  reaction: { padding: 4 },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingTop: 6 },
  input: { flex: 1, color: colors.text, fontSize: 15, backgroundColor: colors.surface2, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  qRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 4, paddingVertical: 4 },
  qTitle: { flex: 1, color: colors.text, fontSize: 14 },
  section: { color: colors.text2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: 6 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, backgroundColor: colors.surface },
  setting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingText: { color: colors.text, fontSize: 14 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
});
