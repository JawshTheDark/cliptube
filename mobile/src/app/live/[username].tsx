import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { ServerTag } from '@/components/ServerTag';
import { Avatar, Button, Empty, ErrorBox, Icon, IconButton, LiveBadge, Loading, toast } from '@/components/ui';
import { f } from '@/components/VideoForm';
import { Api } from '@/lib/api';
import { ago, compact, hostOf } from '@/lib/format';
import { ApiScope, useLinkedApi, withServer } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { useLayout } from '@/lib/layout';
import { useOnePlayerAtATime } from '@/lib/playback';
import { openEvents } from '@/lib/sse';
import { colors, fonts } from '@/lib/theme';
import type { LivePage, LiveStream, PartyMessage } from '@/lib/types';

type Bubble = { key: number; emoji: string; left: number };

/**
 * A channel's live stream (OurTube 1.9): low-latency HLS through the channel's server, with live chat,
 * reactions and the viewer count over its event stream. Watching needs no account; chatting needs one on that
 * server, or a guest name.
 */
export default function LiveScreen() {
  const { username, server } = useLocalSearchParams<{ username: string; server?: string }>();
  const scope = useLinkedApi(server);
  const { api, foreign } = scope;
  const session = useSession();
  const signedIn = !!session.user && !foreign;
  const base = foreign || session.server;
  const insets = useSafeAreaInsets();
  const typing = useKeyboardState((k) => k.isVisible);
  const layout = useLayout();
  const wide = layout.wide;
  const storeKey = `live_${`${base}_${username}`.replace(/[^A-Za-z0-9]/g, '_')}`;

  const [page, setPage] = useState<LivePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<LiveStream | null>(null);
  const [viewers, setViewers] = useState(0);
  const [messages, setMessages] = useState<PartyMessage[]>([]);
  const [reactions, setReactions] = useState<string[]>([]);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [guestToken, setGuestToken] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const list = useRef<FlatList>(null);

  useEffect(() => {
    if (signedIn) return setGuestToken(null);
    SecureStore.getItemAsync(storeKey)
      .then((t) => setGuestToken(t))
      .catch(() => setGuestToken(null));
  }, [signedIn, storeKey]);
  const headers = useMemo<Record<string, string>>(() => (!signedIn && guestToken ? { 'x-room-member': guestToken } : ({} as Record<string, string>)), [signedIn, guestToken]);
  const canChat = signedIn || !!guestToken;

  const load = useCallback(() => {
    setError(null);
    api
      .req<LivePage>(`/live/${encodeURIComponent(username)}`, { headers })
      .then((p) => {
        setPage(p);
        setStream(p.stream);
        setViewers(p.stream?.viewers || 0);
      })
      .catch((e) => setError(e.status === 404 ? 'This server has no live streaming, or the channel doesn’t exist.' : e.message));
  }, [api, username, headers]);
  useEffect(() => {
    if (guestToken !== undefined) load();
  }, [load, guestToken]);

  // Chat, reactions and the viewer count. Anyone can follow it, signed in or not.
  useEffect(() => {
    if (guestToken === undefined || !page?.enabled) return;
    const url = `${api.base}/api/live/${encodeURIComponent(username)}/events`;
    return openEvents(url, { ...headers, ...(api.authFor(url) || {}) }, {
      onEvent: (event, data) => {
        switch (event) {
          case 'hello':
            setMessages(data.messages || []);
            setReactions(data.reactions || []);
            setViewers(data.viewers || 0);
            if (data.stream !== undefined) setStream(data.stream);
            break;
          case 'live':
            setStream(data.stream);
            break;
          case 'live_ended':
            setStream(null);
            load();
            break;
          case 'viewers':
            setViewers(data.viewers);
            break;
          case 'chat':
            setMessages((m) => [...m, data].slice(-200));
            break;
          case 'chat_deleted':
            setMessages((m) => m.filter((x) => x.id !== data.id));
            break;
          case 'react': {
            const key = Date.now() + Math.random();
            setBubbles((b) => [...b.slice(-12), { key, emoji: data.emoji, left: 10 + Math.random() * 70 }]);
            setTimeout(() => setBubbles((b) => b.filter((x) => x.key !== key)), 2600);
            break;
          }
        }
      },
      onRefused: () => false,
    });
  }, [api, username, headers, guestToken, page?.enabled, load]);

  const call = (path: string, method = 'POST', body?: unknown) => api.req(`/live/${encodeURIComponent(username)}${path}`, { method, body, headers });

  const join = async () => {
    try {
      const r = await api.req<{ token: string }>(`/live/${encodeURIComponent(username)}/join`, { method: 'POST', body: { name: name.trim() } });
      await SecureStore.setItemAsync(storeKey, r.token);
      setGuestToken(r.token);
    } catch (e: any) {
      toast(e.message);
    }
  };

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

  // Streamer and moderators remove anything and ban; everyone removes their own.
  const mod = !!page?.is_owner || (signedIn && !!session.user?.is_moderator);
  const manage = (m: PartyMessage) => {
    const own = !!page?.you && m.member_id === page.you.id;
    if (!own && !mod) return;
    const buttons: any[] = [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove message', style: 'destructive', onPress: () => call(`/chat/${m.id}`, 'DELETE').catch((e: any) => toast(e.message)) }];
    if (mod && !own) {
      buttons.push({
        text: `Ban ${m.name}`,
        style: 'destructive',
        onPress: () =>
          call('/ban', 'POST', { member_id: m.member_id })
            .then(() => toast(`${m.name} can’t chat here any more`))
            .catch((e: any) => toast(e.message)),
      });
    }
    Alert.alert(m.name, m.body.slice(0, 140), buttons);
  };

  const share = () => Share.share({ message: `${base}/live/${username}` }).catch(() => {});
  const top = (
    <View style={[s.topBar, { paddingTop: insets.top + 4 }]}>
      <IconButton name="arrow-back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <Text style={s.topTitle} numberOfLines={1}>
        {page?.channel.display_name || username}
      </Text>
      <IconButton name="share" label="Share" onPress={share} />
    </View>
  );

  if (error) {
    return (
      <View style={s.screen}>
        {top}
        <ErrorBox message={error} onRetry={load} />
      </View>
    );
  }
  if (!page) {
    return (
      <View style={s.screen}>
        {top}
        <Loading />
      </View>
    );
  }

  const channelHref = withServer(`/c/${encodeURIComponent(page.channel.username)}`, foreign);

  if (!stream || !stream.hls_url) {
    const last = page.last;
    return (
      <View style={s.screen}>
        {top}
        <Empty icon="live-tv" title={page.enabled ? `${page.channel.display_name} isn’t live right now` : 'Live streaming is off on this server'}>
          <View style={{ gap: 10, alignItems: 'center', marginTop: 4 }}>
            {!!last && <Text style={s.hint}>{`Last live ${ago(last.ended_at || last.started_at)}: “${last.title}”`}</Text>}
            {!!last?.video_id && <Button title="Watch the recording" icon="play-arrow" kind="primary" onPress={() => router.push(withServer(`/watch/${encodeURIComponent(last.video_id!)}`, foreign) as any)} />}
            <Button title="Open channel" icon="person" onPress={() => router.push(channelHref as any)} />
          </View>
        </Empty>
      </View>
    );
  }

  return (
    // Wide: the stream and its details on the left, the chat on the right.
    <KeyboardAvoidingView style={[s.screen, wide && { flexDirection: 'row' }]} behavior="padding">
      <View style={wide ? { width: layout.leftPane } : null}>
      {top}
      <View>
        <LivePlayer key={stream.id} stream={stream} api={api} compact={typing && !wide} width={wide ? layout.leftPane : undefined} />
        <View style={s.bubbles} pointerEvents="none">
          {bubbles.map((b) => (
            <Text key={b.key} style={[s.bubble, { left: `${b.left}%` }]}>
              {b.emoji}
            </Text>
          ))}
        </View>
      </View>

      {(!typing || wide) && (
        <View style={s.info}>
          <View style={s.liveRow}>
            <LiveBadge />
            <Text style={s.hint}>{`${compact(viewers)} watching · started ${ago(stream.started_at)}`}</Text>
          </View>
          <Text style={s.title} numberOfLines={2}>
            {stream.title}
          </Text>
          <Pressable style={s.channel} onPress={() => router.push(channelHref as any)}>
            <Avatar uri={api.abs(page.channel.avatar_url)} name={page.channel.display_name} size={30} />
            <Text style={s.channelName}>{page.channel.display_name}</Text>
            {!!stream.game && <Text style={s.game}>{stream.game.name}</Text>}
          </Pressable>
          {/* The server this stream lives on, as the website shows it; one outside a network is named by its address. */}
          <ApiScope value={scope}>
            <ServerTag fallback={foreign ? <Text style={s.hint}>{`on ${hostOf(foreign)}`}</Text> : null} />
          </ApiScope>
        </View>
      )}
      </View>

      <View style={[{ flex: 1 }, wide && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.hairline, paddingTop: insets.top }]}>
      <FlatList
        ref={list}
        style={{ flex: 1 }}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}
        ListEmptyComponent={<Text style={[s.hint, { textAlign: 'center', marginTop: 12 }]}>Live chat shows up here.</Text>}
        renderItem={({ item: m }) => (
          <Pressable onLongPress={() => manage(m)}>
            <Text style={s.msg}>
              <Text style={s.msgName}>{m.name} </Text>
              {m.body}
            </Text>
          </Pressable>
        )}
      />

      {canChat ? (
        <>
          {reactions.length > 0 && (
            <View style={s.reactions}>
              {reactions.map((e) => (
                <Pressable key={e} onPress={() => call('/react', 'POST', { emoji: e }).catch((err: any) => toast(err.message))} style={{ padding: 4 }} accessibilityLabel={`React ${e}`}>
                  <Text style={{ fontSize: 20 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={[s.composer, { paddingBottom: 8 + insets.bottom }]}>
            <TextInput value={text} onChangeText={setText} placeholder="Chat" placeholderTextColor={colors.text2} style={s.input} maxLength={500} onSubmitEditing={send} returnKeyType="send" />
            <IconButton name="send" label="Send" onPress={send} color={text.trim() ? colors.link : colors.text2} />
          </View>
        </>
      ) : (
        <View style={[s.joinBox, { paddingBottom: 8 + insets.bottom }]}>
          <TextInput value={name} onChangeText={setName} placeholder="Pick a name to chat" placeholderTextColor={colors.text2} style={[f.input, { flex: 1 }]} maxLength={32} onSubmitEditing={join} />
          <Button title="Join chat" onPress={join} disabled={name.trim().length < 2} />
          {!foreign && <IconButton name="login" label="Sign in" onPress={() => router.push('/login')} />}
        </View>
      )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** The live player: low-latency HLS from the channel's server, with the native controls. */
function LivePlayer({ stream, api, compact, width: paneWidth }: { stream: LiveStream; api: Api; compact: boolean; width?: number }) {
  const window = useWindowDimensions();
  const width = paneWidth ?? window.width;
  const height = window.height;
  const url = api.abs(stream.hls_url)!;
  const source = useMemo<VideoSource>(
    () => ({ uri: url, headers: api.authFor(url), contentType: 'hls', metadata: { title: stream.title, artist: stream.channel.display_name } }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const player = useVideoPlayer(source, (p) => p.play());
  useOnePlayerAtATime(player);
  const h = Math.min(width * (9 / 16), height * (compact ? 0.2 : paneWidth ? 0.6 : 0.4));
  return (
    <View style={{ width, height: h, backgroundColor: '#000' }}>
      <VideoView player={player} style={{ width: '100%', height: '100%' }} nativeControls contentFit="contain" allowsPictureInPicture fullscreenOptions={{ enable: true, orientation: 'landscape' }} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4, backgroundColor: colors.bg },
  topTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  hint: { color: colors.text2, fontSize: 13 },
  info: { paddingHorizontal: 12, paddingTop: 10, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline, paddingBottom: 10 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.text, fontSize: 19, fontFamily: fonts.display, fontWeight: '800', letterSpacing: -0.3 },
  channel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  channelName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  game: { color: colors.text2, fontSize: 12, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  bubbles: { position: 'absolute', left: 0, right: 0, bottom: 50, height: 60 },
  bubble: { position: 'absolute', bottom: 0, fontSize: 30 },
  msg: { color: colors.text, fontSize: 14, lineHeight: 19 },
  msgName: { color: colors.link, fontWeight: '700' },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 6, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingTop: 6 },
  input: { flex: 1, color: colors.text, fontSize: 15, backgroundColor: colors.surface2, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  joinBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
});
