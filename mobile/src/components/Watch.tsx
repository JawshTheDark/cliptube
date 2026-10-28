import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, Pressable, ScrollView, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from './Text';
import { router } from 'expo-router';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Api } from '@/lib/api';
import { ApiScope, useLinkedApi, withServer } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { useLayout } from '@/lib/layout';
import { seekCurrent, useOnePlayerAtATime } from '@/lib/playback';
import { useDisplayed, usePrefs } from '@/lib/prefs';
import { ago, compact, hostOf, plural } from '@/lib/format';
import { colors, fonts } from '@/lib/theme';
import type { RemoteWatch, Video } from '@/lib/types';
import { knownServers, openChannelLink } from '@/lib/profiles';
import { refFromRoute } from '@/lib/refs';
import { PlaylistBar, type PlaylistNav } from './PlaylistBar';
import { RichText } from './RichText';
import { ServerTag } from './ServerTag';
import { VideoRow } from './VideoCard';
import { Avatar, Button, Empty, Icon, IconButton, Loading, toast } from './ui';

type Loaded = {
  video: Video;
  related: Video[];
  myLike: number;
  subscribed: boolean;
  subscriberCount: number | null;
  can: { likes: boolean; comments: boolean; subscriptions: boolean };
  commentsPath: string;
  shareUrl: string;
};

type Props = { id?: string; peer?: string; remote?: string; server?: string | string[]; list?: string; shuffle?: string };

export function WatchScreen({ id, peer, remote, server: serverParam, list, shuffle }: Props) {
  const scope = useLinkedApi(serverParam);
  const { api, foreign } = scope;
  const session = useSession();
  // Anonymous mode (Settings → Watching): views count as a signed-out viewer and nothing goes into the history.
  const anonymous = usePrefs().prefs.anonymous === 'on';
  const displayed = useDisplayed();
  const signedIn = !!session.user && !foreign;
  const base = foreign || session.server;
  const isRemote = !!peer && !!remote;
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (isRemote) {
        const r = await api.get<RemoteWatch>(`/network/videos/${peer}/${encodeURIComponent(remote!)}`);
        const v = r.video;
        setData({
          video: v,
          related: r.related,
          myLike: r.my_like,
          subscribed: r.subscribed,
          subscriberCount: null,
          can: r.interactions,
          commentsPath: `/network/videos/${peer}/${encodeURIComponent(remote!)}`,
          shareUrl: v.remote.watch_url || `${base}/n/${peer}/${encodeURIComponent(remote!)}`,
        });
        // The view counts on the server that hosts the video, anonymously, like the website does. (Network videos all
        // say origin_type "activitypub" since the network moved to ActivityPub, so this doesn't check it.)
        if (v.remote.peer_url) {
          fetch(`${v.remote.peer_url}/api/videos/${encodeURIComponent(v.remote.remote_id)}/view`, { method: 'POST', credentials: 'omit' }).catch(() => {});
        }
        api
          .get<{ subscriber_count: number | null; subscribed: boolean }>(`/network/channels/${peer}/${encodeURIComponent(v.uploader.username)}`)
          .then((c) => setData((d) => (d ? { ...d, subscriberCount: c.subscriber_count, subscribed: c.subscribed } : d)))
          .catch(() => {});
      } else {
        const [{ video }, rel] = await Promise.all([
          api.get<{ video: Video }>(`/videos/${encodeURIComponent(id!)}`),
          api.get<{ videos: Video[] }>(`/videos/${encodeURIComponent(id!)}/related`).catch(() => ({ videos: [] as Video[] })),
        ]);
        setData({
          video,
          related: rel.videos,
          myLike: video.my_like || 0,
          subscribed: !!video.subscribed,
          subscriberCount: video.uploader.subscriber_count ?? null,
          can: { likes: true, comments: true, subscriptions: true },
          commentsPath: `/videos/${encodeURIComponent(id!)}`,
          shareUrl: `${base}/watch/${encodeURIComponent(id!)}`,
        });
        if (video.status === 'ready') api.post(`/videos/${encodeURIComponent(id!)}/view`, { anonymous, from: 'app' }).catch(() => {});
      }
    } catch (e: any) {
      setError(e.status === 404 ? 'This video isn’t available. It may be private, or it was removed.' : e.message);
    }
  }, [api, id, peer, remote, isRemote, base]);

  useEffect(() => {
    setData(null);
    setExpanded(false);
    load();
  }, [load]);

  // Watch position, so "continue watching" works across the app and the website.
  const lastSent = useRef(0);
  const position = useRef(0);
  const reportProgress = useCallback(
    (t: number, force = false) => {
      position.current = t;
      if (!signedIn || anonymous || isRemote || !id) return;
      if (!force && Math.abs(t - lastSent.current) < 10) return;
      lastSent.current = t;
      api.post(`/videos/${encodeURIComponent(id)}/progress`, { position: Math.floor(t) }).catch(() => {});
    },
    [api, id, signedIn, isRemote, anonymous],
  );
  useEffect(() => () => reportProgress(position.current, true), [reportProgress]);

  const needSignIn = () => {
    if (foreign) {
      toast(`Switch to ${hostOf(foreign)} to do that`);
      return true;
    }
    if (!session.user) {
      router.push('/login');
      return true;
    }
    return false;
  };

  const like = async (value: 1 | -1) => {
    if (!data || needSignIn()) return;
    const next = data.myLike === value ? 0 : value;
    setBusy(true);
    try {
      if (isRemote) {
        const r = await api.post<{ likes: number; my_like: number }>(`${data.commentsPath}/like`, { value: next });
        setData({ ...data, myLike: r.my_like, video: { ...data.video, likes: r.likes } });
      } else {
        const r = await api.post<{ likes: number; dislikes: number | null; my_like: number }>(`${data.commentsPath}/like`, { value: next });
        setData({ ...data, myLike: r.my_like, video: { ...data.video, likes: r.likes, dislikes: r.dislikes } });
      }
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async () => {
    if (!data || needSignIn()) return;
    const u = data.video.uploader;
    setBusy(true);
    try {
      const method = data.subscribed ? 'DELETE' : 'POST';
      if (isRemote) {
        const r = await api.req<{ subscribed: boolean; subscriber_count: number | null }>(`/network/channels/${peer}/${encodeURIComponent(u.username)}/subscribe`, { method });
        setData({ ...data, subscribed: r.subscribed, subscriberCount: r.subscriber_count ?? data.subscriberCount });
        toast(r.subscribed ? `Subscribed to ${u.display_name}` : 'Subscription removed');
      } else {
        const r = await api.req<{ channel: { subscribed: boolean; subscriber_count: number } }>(`/users/${encodeURIComponent(u.username)}/subscribe`, { method });
        setData({ ...data, subscribed: r.channel.subscribed, subscriberCount: r.channel.subscriber_count });
        toast(r.channel.subscribed ? `Subscribed to ${u.display_name}` : 'Subscription removed');
      }
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Playing from a playlist: what comes next, and whether to move on by itself.
  const playlistNav = useRef<PlaylistNav | null>(null);
  const ref = refFromRoute({ id, peer, remote });

  const save = () => {
    if (needSignIn() || !ref) return;
    router.push({ pathname: '/save', params: { ref, title: data?.video.title || '' } });
  };

  const watchTogether = async () => {
    if (needSignIn() || !ref) return;
    try {
      const r = await api.post<{ party: { id: string } }>('/parties', { ref });
      router.push(`/party/${r.party.id}`);
    } catch (e: any) {
      toast(e.status === 404 ? 'Watch parties need OurTube 1.8 or newer on this server.' : e.message);
    }
  };

  const switchHere = async () => {
    if (!foreign) return;
    try {
      await session.addServer(foreign);
      await session.switchServer(foreign);
      toast(`Switched to ${hostOf(foreign)}`);
    } catch (e: any) {
      toast(e.message);
    }
  };

  const back = (
    <View style={[s.back, { top: insets.top + 4 }]} pointerEvents="box-none">
      <IconButton name="arrow-back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} color="#fff" />
    </View>
  );

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 48 }}>
        {back}
        <Empty icon="videocam-off" title="Can’t play this video">
          <Text style={{ color: colors.text2, textAlign: 'center' }}>{error}</Text>
          <View style={{ marginTop: 12 }}>
            <Button title="Try again" onPress={load} />
          </View>
        </Empty>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
        <View style={{ aspectRatio: 16 / 9, backgroundColor: '#000' }} />
        {back}
        <Loading />
      </View>
    );
  }

  const v = data.video;
  const u = v.uploader;
  const title = displayed(v).title;
  const channelHref = !isRemote && u.username ? withServer(`/c/${encodeURIComponent(u.username)}`, foreign) : null;
  // A network video's uploader: their channel on the server the video comes from (in the app when it's OurTube).
  const remoteChannel = isRemote ? u.url || v.remote?.peer_url || null : null;
  const openUploader = () => {
    if (channelHref) router.push(channelHref as any);
    else if (remoteChannel) openChannelLink(remoteChannel, knownServers(session.servers, session.site));
  };

  const info = (
    <View>
      {!!foreign && (
        <View style={s.banner}>
          <Icon name="public" size={18} color={colors.warn} />
          <Text style={s.bannerText}>
            This video is on {hostOf(foreign)}. You’re using {hostOf(session.server)}.
          </Text>
          <Button title="Switch" small onPress={switchHere} />
        </View>
      )}
      <Pressable onPress={() => setExpanded((x) => !x)} style={s.section}>
        <Text style={s.title}>{title}</Text>
        <ServerTag remote={isRemote ? v.remote : null} style={{ marginTop: 6, marginBottom: 2 }} />
        <Text style={s.meta}>
          {`${plural(v.views, 'view')} · ${ago(v.published_at || v.created_at)}`}
          {v.visibility !== 'public' ? ` · ${v.draft ? 'draft' : v.visibility}` : ''}
          {'  '}
          <Text style={{ color: colors.text, fontWeight: '600' }}>{expanded ? 'less' : '...more'}</Text>
        </Text>
      </Pressable>

      <View style={s.channelRow}>
        <Pressable style={s.channel} onPress={openUploader} disabled={!channelHref && !remoteChannel} accessibilityRole="link" accessibilityLabel={`${u.display_name}'s channel`}>
          <Avatar uri={api.abs(u.avatar_url)} name={u.display_name} size={40} />
          <View style={{ flexShrink: 1 }}>
            <Text style={s.channelName} numberOfLines={1}>
              {u.display_name}
            </Text>
            <Text style={s.meta} numberOfLines={1}>
              {data.subscriberCount !== null ? plural(data.subscriberCount, 'subscriber') : isRemote ? `@${u.username}` : ''}
            </Text>
          </View>
        </Pressable>
        {!v.can_edit && data.can.subscriptions && (
          <Button title={data.subscribed ? 'Subscribed' : 'Subscribe'} kind={data.subscribed ? 'secondary' : 'primary'} small onPress={subscribe} disabled={busy} />
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.actions}>
        {data.can.likes && (
          <View style={s.likePill}>
            <Pressable style={s.likeHalf} onPress={() => like(1)} disabled={busy} accessibilityLabel="Like">
              <Icon name={data.myLike === 1 ? 'thumb-up' : 'thumb-up-off-alt'} size={20} />
              <Text style={s.pillText}>{compact(v.likes || 0)}</Text>
            </Pressable>
            {!isRemote && (
              <>
                <View style={s.divider} />
                <Pressable style={s.likeHalf} onPress={() => like(-1)} disabled={busy} accessibilityLabel="Dislike">
                  <Icon name={data.myLike === -1 ? 'thumb-down' : 'thumb-down-off-alt'} size={20} />
                  {v.dislikes !== null && v.dislikes !== undefined && <Text style={s.pillText}>{compact(v.dislikes)}</Text>}
                </Pressable>
              </>
            )}
          </View>
        )}
        {(isRemote || (v.status === 'ready' && !!v.video_url)) && <Button title="Save" icon="playlist-add" small onPress={save} />}
        {(isRemote || (v.status === 'ready' && !!v.video_url && v.visibility !== 'private')) && <Button title="Watch together" icon="groups" small onPress={watchTogether} />}
        <Button title="Share" icon="share" small onPress={() => Share.share({ message: data.shareUrl }).catch(() => {})} />
        <Button title="Open in browser" icon="open-in-browser" small onPress={() => Linking.openURL(data.shareUrl)} />
        {v.can_edit && !foreign && <Button title="Edit" icon="edit" small onPress={() => router.push(`/edit/${encodeURIComponent(v.id)}`)} />}
      </ScrollView>

      {expanded && (
        <View style={s.descCard}>
          {!!v.game && (
            <Pressable onPress={() => router.push(withServer(`/g/${encodeURIComponent(v.game!.id)}`, foreign) as any)} style={s.gameChip}>
              <Icon name="sports-esports" size={16} color={colors.text2} />
              <Text style={{ color: colors.text, fontSize: 13 }}>{v.game.name}</Text>
            </Pressable>
          )}
          {/* Times in the description (1:23) jump the video there, as on the website. */}
          <RichText text={v.description?.trim() || 'No description.'} onSeek={(t) => seekCurrent(t)} style={s.desc} />
          {!!v.tags?.length && <Text style={[s.desc, { color: colors.link }]}>{v.tags.map((t) => `#${t}`).join('  ')}</Text>}
        </View>
      )}

      {!expanded && !!v.game && (
        <Pressable onPress={() => router.push(withServer(`/g/${encodeURIComponent(v.game!.id)}`, foreign) as any)} style={[s.gameChip, { marginHorizontal: 12, marginBottom: 6 }]}>
          <Icon name="sports-esports" size={16} color={colors.text2} />
          <Text style={{ color: colors.text, fontSize: 13 }}>{v.game.name}</Text>
        </Pressable>
      )}

      {!!list && <PlaylistBar api={api} foreign={foreign} listId={list} currentRef={ref} shuffle={shuffle === '1'} onNav={(n) => (playlistNav.current = n)} />}

      <Pressable
        style={s.commentsCard}
        onPress={() =>
          router.push({ pathname: '/comments', params: { path: data.commentsPath, title, ...(foreign ? { server: foreign } : {}), owner: v.can_edit ? '1' : '' } })
        }
        accessibilityRole="button"
      >
        <Text style={s.channelName}>
          Comments <Text style={s.meta}>{v.comment_count !== undefined ? compact(v.comment_count) : ''}</Text>
        </Text>
        <Text style={s.meta}>{data.can.comments ? 'Tap to read and add comments' : 'Tap to read comments'}</Text>
      </Pressable>

    </View>
  );
  const relatedTitle = data.related.length > 0 ? <Text style={s.sectionTitle}>More videos</Text> : null;
  const wide = layout.wide;

  return (
    <ApiScope value={scope}>
      {/*
        Upright: the player on top, then the details and more videos below. Wide (a tablet, or a phone on its side):
        the player and details on the left, more videos on the right. The player keeps its place in the tree either
        way, so turning the device doesn't restart the video.
      */}
      <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column', backgroundColor: colors.bg }}>
        <View style={wide ? { width: layout.leftPane } : null}>
          <View style={{ paddingTop: insets.top, backgroundColor: '#000' }}>
          <Player
            key={v.id}
            video={v}
            api={api}
            width={wide ? layout.leftPane : undefined}
            maxHeight={wide ? layout.height * 0.8 : undefined}
            resumeAt={signedIn && !list ? v.resume_at || 0 : 0}
            onTime={reportProgress}
            onEnd={() => {
              const n = playlistNav.current;
              if (n?.autoplay && n.next) n.goNext();
            }}
          />
          {back}
          </View>
          {wide && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
              {info}
            </ScrollView>
          )}
        </View>
        <FlatList
          style={wide ? { flex: 1, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.hairline } : undefined}
          contentContainerStyle={wide ? { paddingTop: insets.top, paddingRight: insets.right } : undefined}
          data={data.related}
          keyExtractor={(x) => x.id}
          renderItem={({ item }) => <VideoRow v={item} />}
          ListHeaderComponent={wide ? (relatedTitle ?? undefined) : <>{info}{relatedTitle}</>}
          ListFooterComponent={<View style={{ height: 24 + insets.bottom }} />}
        />
      </View>
    </ApiScope>
  );
}

/** The native player (Media3 on Android). Sends the sign-in header only to the video's own server. */
function Player({
  video,
  api,
  resumeAt,
  onTime,
  onEnd,
  width: paneWidth,
  maxHeight,
}: {
  video: Video;
  api: Api;
  resumeAt: number;
  onTime: (t: number) => void;
  onEnd?: () => void;
  width?: number;
  maxHeight?: number;
}) {
  const window = useWindowDimensions();
  const width = paneWidth ?? window.width;
  const height = window.height;
  const url = api.abs(video.hls_url || video.video_url);
  const source = useMemo<VideoSource>(
    () =>
      url
        ? {
            uri: url,
            headers: api.authFor(url),
            contentType: video.hls_url ? 'hls' : 'progressive',
            metadata: { title: video.title, artist: video.uploader.display_name, artwork: api.abs(video.thumbnail_url) || undefined },
          }
        : null,
    // The player is keyed by video id, so the source never needs to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 5;
    p.play();
  });
  // Opening another video from here pauses this one; Back picks it up again.
  useOnePlayerAtATime(player);
  const resumed = useRef(false);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && !resumed.current) {
      resumed.current = true;
      const d = video.duration || 0;
      if (resumeAt > 3 && (!d || resumeAt < d - 5)) player.currentTime = resumeAt;
    }
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => onTime(currentTime));
  useEventListener(player, 'playToEnd', () => onEnd?.());
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (!isPlaying) onTime(player.currentTime);
  });

  const aspect = video.width && video.height ? video.width / video.height : 16 / 9;
  const h = Math.min(width / aspect, maxHeight ?? height * 0.62);

  if (!url) {
    const processing = video.status !== 'ready';
    return (
      <View style={[s.noVideo, { width, height: width * (9 / 16) }]}>
        <Icon name={processing ? 'hourglass-top' : 'block'} size={40} color={colors.text2} />
        <Text style={{ color: colors.text, textAlign: 'center' }}>
          {video.status === 'failed'
            ? `Processing failed${video.error ? `: ${video.error}` : ''}`
            : processing
              ? `Processing${video.progress ? ` · ${Math.round(video.progress)}%` : ''}… pull back in a minute.`
              : video.moderation_status
                ? `This video was ${video.moderation_status} by a moderator${video.moderation_reason ? `: ${video.moderation_reason}` : ''}.`
                : 'This video can’t be played.'}
        </Text>
      </View>
    );
  }
  return (
    <View style={{ width, height: h, backgroundColor: '#000' }}>
      <VideoView
        player={player}
        style={{ width: '100%', height: '100%' }}
        nativeControls
        contentFit="contain"
        allowsPictureInPicture
        fullscreenOptions={{ enable: true, orientation: aspect >= 1 ? 'landscape' : 'portrait' }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  back: { position: 'absolute', left: 4 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, marginBottom: 0, padding: 10, borderRadius: 10, backgroundColor: 'rgba(255,209,102,0.1)' },
  bannerText: { color: colors.text, flex: 1, fontSize: 13 },
  section: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  title: { color: colors.text, fontSize: 20, fontFamily: fonts.display, fontWeight: '800', letterSpacing: -0.4, lineHeight: 25 },
  meta: { color: colors.text2, fontSize: 12.5, marginTop: 4 },
  channelRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  channel: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  channelName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  actions: { gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  likePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: 16, minHeight: 32 },
  likeHalf: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 32 },
  divider: { width: 1, height: 20, backgroundColor: colors.border },
  pillText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  descCard: { marginHorizontal: 12, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: colors.surface, gap: 8 },
  desc: { color: colors.text, fontSize: 14, lineHeight: 20 },
  gameChip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  commentsCard: { marginHorizontal: 12, marginVertical: 6, padding: 12, borderRadius: 12, backgroundColor: colors.surface, gap: 2 },
  sectionTitle: { color: colors.text, fontSize: 18, fontFamily: fonts.display, fontWeight: '800', paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
  noVideo: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20, backgroundColor: '#000' },
});
