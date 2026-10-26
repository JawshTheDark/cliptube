import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, Share, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Api, videoHref } from '@/lib/api';
import { compact, hostOf } from '@/lib/format';
import { useOnePlayerAtATime } from '@/lib/playback';
import { knownServers, openChannelLink } from '@/lib/profiles';
import { ApiScope, useLinkedApi, withServer } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';
import { usePaged } from '@/lib/usePaged';
import { ServerTag } from './ServerTag';
import { Text } from './Text';
import { Avatar, Empty, Icon, IconButton, Loading, toast } from './ui';

/** "v:<id>" for a video here, "n:<peer>:<remote id>" for one from another server. */
export const shortKey = (v: Pick<Video, 'id' | 'remote'>) => (v.remote ? `n:${v.remote.peer_id}:${v.remote.remote_id}` : `v:${v.id}`);
const apiBase = (v: Pick<Video, 'id' | 'remote'>) =>
  v.remote ? `/network/videos/${v.remote.peer_id}/${encodeURIComponent(v.remote.remote_id)}` : `/videos/${encodeURIComponent(v.id)}`;

// The Short a card was tapped on, so the viewer shows it at once instead of waiting for its page.
const stash = new Map<string, Video>();

/** The viewer's route for a Short, the website's /shorts paths. `scope` 'local' keeps it to this server's Shorts. */
export function shortsHref(v: Video, { scope, foreign }: { scope?: 'all' | 'local'; foreign?: string | null } = {}) {
  stash.set(shortKey(v), v);
  const path = v.remote ? `/shorts/n/${v.remote.peer_id}/${encodeURIComponent(v.remote.remote_id)}` : `/shorts/${encodeURIComponent(v.id)}`;
  return withServer(scope === 'local' ? `${path}?scope=local` : path, foreign || null);
}

type Detail = { my_like: number; likes: number; can_like: boolean; can_comment: boolean; comments: number | null };

/** What the side buttons need: my like, the like count, and whether likes and comments reach its server. */
async function loadDetail(api: Api, v: Pick<Video, 'id' | 'remote'>): Promise<{ video: Video; detail: Detail }> {
  const r = await api.get<any>(apiBase(v));
  const video: Video = r.video;
  return {
    video,
    detail: v.remote
      ? { my_like: r.my_like || 0, likes: video.likes || 0, can_like: !!r.interactions?.likes, can_comment: !!r.interactions?.comments, comments: null }
      : { my_like: video.my_like || 0, likes: video.likes || 0, can_like: true, can_comment: true, comments: video.comment_count ?? null },
  };
}

/** The player of the Short on screen and of the ones beside it. Only the visible one plays; it loops. */
function ShortPlayer({ v, api, active, muted }: { v: Video; api: Api; active: boolean; muted: boolean }) {
  const url = api.abs(v.video_url || v.hls_url)!;
  const source = useMemo<VideoSource>(
    () => ({ uri: url, headers: api.authFor(url), contentType: v.video_url ? 'progressive' : 'hls', metadata: { title: v.title, artist: v.uploader.display_name } }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = muted;
    p.timeUpdateEventInterval = 0.25;
  });
  useOnePlayerAtATime(player, { active });
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false); // paused by a tap
  useEffect(() => {
    if (active) {
      setPaused(false);
      player.play();
    } else {
      player.pause();
      player.currentTime = 0;
      setProgress(0);
    }
  }, [active, player]);
  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);
  useEventListener(player, 'timeUpdate', ({ currentTime }) => setProgress(player.duration ? currentTime / player.duration : 0));
  // A swipe to the next Short must not count as a tap.
  const downY = useRef(0);
  const toggle = () => {
    if (player.playing) {
      player.pause();
      setPaused(true);
    } else {
      player.play();
      setPaused(false);
    }
  };
  return (
    <>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit="cover" />
      {/* Taps go to this layer: the native view would keep them. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPressIn={(e) => (downY.current = e.nativeEvent.pageY)}
        onPress={(e) => Math.abs(e.nativeEvent.pageY - downY.current) < 12 && toggle()}
        accessibilityRole="button" accessibilityLabel={paused ? 'Play' : 'Pause'}>
        {active && paused && (
          <View style={s.center}>
            <View style={s.playBadge}>
              <Icon name="play-arrow" size={44} color="#fff" />
            </View>
          </View>
        )}
      </Pressable>
      <View style={s.progressTrack} pointerEvents="none">
        <View style={[s.progressFill, { width: `${progress * 100}%` }]} />
      </View>
    </>
  );
}

function Action({ icon, label, onPress, active, disabled, small }: { icon: any; label: string; onPress: () => void; active?: boolean; disabled?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[s.action, disabled && { opacity: 0.45 }]} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
      <View style={[s.actionIcon, small && { width: 40, height: 40, borderRadius: 20 }, active && { backgroundColor: colors.accent }]}>
        <Icon name={icon} size={small ? 22 : 26} color="#fff" />
      </View>
      <Text style={s.actionLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

type SlideProps = {
  v: Video;
  api: Api;
  W: number;
  H: number;
  active: boolean;
  near: boolean;
  muted: boolean;
  detail: Detail | null;
  bottomInset: number;
  onLike: (value: number) => void;
  onComments: () => void;
  onShare: () => void;
  onFull: () => void;
  onChannel: () => void;
};

/** One Short: the video in a frame of its own shape (no bars beside it), who made it, and the side buttons. */
const ShortSlide = memo(function ShortSlide({ v, api, W, H, active, near, muted, detail, bottomInset, onLike, onComments, onShare, onFull, onChannel }: SlideProps) {
  const aspect = v.width && v.height ? v.width / v.height : 9 / 16;
  let fw = W;
  let fh = W / aspect;
  if (fh > H) {
    fh = H;
    fw = H * aspect;
  }
  const thumb = api.abs(v.community?.thumbnail_url || v.thumbnail_url);
  // A short screen (a phone on its side): smaller buttons, lower down, beside the frame rather than over the title.
  const tight = H < 640;
  const title = v.community?.title || v.title;
  const u = v.uploader;
  return (
    <View style={{ width: W, height: H, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
      <View style={{ width: fw, height: fh, backgroundColor: '#000' }}>
        {thumb && <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" />}
        {near && !!(v.video_url || v.hls_url) && <ShortPlayer v={v} api={api} active={active} muted={muted} />}
      </View>
      {active && (
        <>
          <View style={[s.actions, { bottom: bottomInset + (tight ? 12 : 96) }, tight && { gap: 6 }]}>
            <Action icon={detail?.my_like === 1 ? 'thumb-up' : 'thumb-up-off-alt'} label={compact(detail ? detail.likes : v.likes)} small={tight} active={detail?.my_like === 1} disabled={!!detail && !detail.can_like} onPress={() => onLike(1)} />
            <Action icon={detail?.my_like === -1 ? 'thumb-down' : 'thumb-down-off-alt'} label="Dislike" small={tight} active={detail?.my_like === -1} disabled={!!detail && !detail.can_like} onPress={() => onLike(-1)} />
            <Action icon="chat-bubble-outline" label={detail?.comments ? compact(detail.comments) : 'Comments'} small={tight} disabled={!!detail && !detail.can_comment} onPress={onComments} />
            <Action icon="share" label="Share" small={tight} onPress={onShare} />
            <Action icon="open-in-full" label="Full page" small={tight} onPress={onFull} />
          </View>
          <View style={[s.info, { paddingBottom: bottomInset + 18 }]} pointerEvents="box-none">
            <View style={s.channelRow}>
              <Pressable style={s.channel} onPress={onChannel} accessibilityRole="link" accessibilityLabel={`${u.display_name}'s channel`}>
                <Avatar uri={api.abs(u.avatar_url)} name={u.display_name} size={32} />
                <Text style={s.channelName} numberOfLines={1}>
                  {u.display_name}
                </Text>
              </Pressable>
              <ServerTag remote={v.remote} style={s.tag} />
            </View>
            <Pressable onPress={onFull} accessibilityRole="link">
              <Text style={s.title} numberOfLines={2}>
                {title}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
});

type Props = { id?: string; peer?: string; remote?: string; server?: string | string[]; scope?: string };

/**
 * Shorts one at a time and full height, the way phones show them: swipe up for the next. Opened on a Short, it
 * starts there and goes on with the ones after it in the newest (or with all of them, when it isn't among the
 * first). Only the Short on screen and the ones beside it keep a player.
 */
export function ShortsScreen({ id, peer, remote, server, scope: scopeParam }: Props) {
  const linked = useLinkedApi(server);
  const { api, foreign } = linked;
  const session = useSession();
  const insets = useSafeAreaInsets();
  const scope = scopeParam === 'local' ? 'local' : 'all';
  const startKey = id ? `v:${id}` : peer && remote ? `n:${peer}:${remote}` : null;
  const stub = useMemo(
    () => (id ? { id, remote: undefined } : peer && remote ? { id: '', remote: { peer_id: Number(peer), remote_id: remote } as any } : null),
    [id, peer, remote],
  );

  const [start, setStart] = useState<Video | null | undefined>(() => (startKey ? stash.get(startKey) : null));
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const paged = usePaged<Video>(api, `/videos?sort=new&scope=${scope}&shape=vertical`);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(false);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const counted = useRef(new Set<string>());
  const listRef = useRef<FlatList<Video>>(null);
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    if (!stub) return;
    let dead = false;
    loadDetail(api, stub)
      .then(({ video, detail }) => {
        if (dead) return;
        setStart((s) => s || video);
        setDetails((x) => ({ ...x, [shortKey(video)]: detail }));
      })
      .catch(() => !dead && setStart((s) => s || null));
    return () => {
      dead = true;
    };
  }, [api, stub]);

  // The Short it was opened on, then the ones after it. Decided once, so the list doesn't shift as more load.
  const list = useMemo<Video[]>(() => {
    if (!start) return start === null ? paged.items : [];
    if (anchor.current === null && paged.items.length) anchor.current = paged.items.findIndex((v) => shortKey(v) === shortKey(start));
    const rest = anchor.current !== null && anchor.current >= 0 ? paged.items.slice(anchor.current + 1) : paged.items.filter((v) => shortKey(v) !== shortKey(start));
    return [start, ...rest];
  }, [start, paged.items]);
  const current = list[active];

  // The view counts once, on the server that hosts the Short; its likes load; more Shorts load near the end.
  useEffect(() => {
    if (!current) return;
    const key = shortKey(current);
    if (!details[key]) {
      loadDetail(api, current)
        .then(({ detail }) => setDetails((x) => ({ ...x, [key]: detail })))
        .catch(() => {});
    }
    if (!counted.current.has(key)) {
      counted.current.add(key);
      if (current.remote?.peer_url) {
        fetch(`${current.remote.peer_url}/api/videos/${encodeURIComponent(current.remote.remote_id)}/view`, { method: 'POST', credentials: 'omit' }).catch(() => {});
      } else if (!current.remote) {
        api.post(`/videos/${encodeURIComponent(current.id)}/view`, {}).catch(() => {});
      }
    }
    if (active >= list.length - 3 && paged.hasMore && !paged.loading) paged.loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current && shortKey(current), list.length, paged.hasMore, paged.loading]);

  const d = current ? details[shortKey(current)] || null : null;
  const base = foreign || session.server;

  const like = useCallback(
    async (value: number) => {
      if (!current) return;
      if (foreign) return toast(`Switch to ${hostOf(foreign)} to like`);
      if (!session.user) return router.push('/login');
      const key = shortKey(current);
      const was = details[key];
      const next = was?.my_like === value ? 0 : value;
      try {
        const r = await api.post<{ my_like?: number; likes?: number }>(`${apiBase(current)}/like`, { value: next });
        setDetails((x) => ({ ...x, [key]: { ...(x[key] || { likes: current.likes || 0, can_like: true, can_comment: true, comments: null }), my_like: r.my_like ?? next, likes: r.likes ?? x[key]?.likes ?? 0 } }));
      } catch (e: any) {
        toast(e.message);
      }
    },
    [api, current, details, foreign, session.user],
  );
  const openComments = useCallback(() => {
    if (!current) return;
    router.push({ pathname: '/comments-sheet', params: { path: apiBase(current), ...(foreign ? { server: foreign } : {}) } });
  }, [current, foreign]);
  const share = useCallback(() => {
    if (!current) return;
    const path = current.remote ? `/shorts/n/${current.remote.peer_id}/${encodeURIComponent(current.remote.remote_id)}` : `/shorts/${encodeURIComponent(current.id)}`;
    Share.share({ message: `${base}${path}` }).catch(() => {});
  }, [base, current]);
  const openFull = useCallback(() => current && router.push(withServer(videoHref(current), foreign) as any), [current, foreign]);
  const openChannel = useCallback(() => {
    if (!current) return;
    if (current.remote) {
      const url = current.uploader.url || current.remote.peer_url;
      if (url) openChannelLink(url, knownServers(session.servers, session.site));
    } else if (current.uploader.username) router.push(withServer(`/c/${encodeURIComponent(current.uploader.username)}`, foreign) as any);
  }, [current, foreign, session.servers, session.site]);

  // Turning the device changes the page height: stay on the same Short.
  useEffect(() => {
    if (size) listRef.current?.scrollToOffset({ offset: active * size.H, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size?.W, size?.H]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!size || size.W !== width || size.H !== height) setSize({ W: width, H: height });
  };
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <ApiScope value={linked}>
      <View style={{ flex: 1, backgroundColor: '#000' }} onLayout={onLayout}>
        {start === undefined || (!list.length && paged.loading) || !size ? (
          <Loading />
        ) : !list.length ? (
          <Empty icon="smart-display" title="No Shorts yet">
            Videos taller than they are wide show up here as people upload them.
          </Empty>
        ) : (
          <FlatList
            ref={listRef}
            data={list}
            keyExtractor={shortKey}
            renderItem={({ item, index }) => (
              <ShortSlide
                v={item}
                api={api}
                W={size.W}
                H={size.H}
                active={index === active}
                near={Math.abs(index - active) <= 1}
                muted={muted}
                detail={index === active ? d : null}
                bottomInset={insets.bottom}
                onLike={like}
                onComments={openComments}
                onShare={share}
                onFull={openFull}
                onChannel={openChannel}
              />
            )}
            extraData={`${active}:${muted}:${d?.my_like}:${d?.likes}:${d?.comments}`}
            pagingEnabled
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            getItemLayout={(_, i) => ({ length: size.H, offset: size.H * i, index: i })}
            onMomentumScrollEnd={(e) => setActive(Math.max(0, Math.min(list.length - 1, Math.round(e.nativeEvent.contentOffset.y / size.H))))}
            windowSize={3}
            initialNumToRender={2}
            maxToRenderPerBatch={2}
            removeClippedSubviews
          />
        )}
        <View style={[s.top, { paddingTop: insets.top + 4 }]} pointerEvents="box-none">
          <IconButton name="arrow-back" label="Back" onPress={back} color="#fff" />
          {/* On a short screen the side buttons reach the top: mute sits next to Back instead. */}
          {!(size && size.H < 640) && <View style={{ flex: 1 }} />}
          <IconButton name={muted ? 'volume-off' : 'volume-up'} label={muted ? 'Turn the sound on' : 'Mute'} onPress={() => setMuted((m) => !m)} color="#fff" />
        </View>
      </View>
    </ApiScope>
  );
}

const shadow = { textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 };
const s = StyleSheet.create({
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  center: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  playBadge: { width: 76, height: 76, borderRadius: 38, backgroundColor: 'rgba(14,13,22,0.6)', alignItems: 'center', justifyContent: 'center' },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  progressFill: { height: 3, backgroundColor: colors.accent },
  actions: { position: 'absolute', right: 8, alignItems: 'center', gap: 14 },
  action: { alignItems: 'center', gap: 4, width: 76 },
  actionIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(14,13,22,0.55)', alignItems: 'center', justifyContent: 'center' },
  actionLabel: { color: '#fff', fontSize: 11.5, fontWeight: '700', ...shadow },
  info: { position: 'absolute', left: 0, right: 80, bottom: 0, paddingHorizontal: 14, gap: 8 },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  channel: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '70%' },
  channelName: { color: '#fff', fontSize: 15, fontWeight: '800', ...shadow },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.overlay },
  title: { color: '#fff', fontSize: 15, fontWeight: '600', lineHeight: 20, ...shadow },
});
