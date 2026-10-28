import { useMemo } from 'react';
import { View } from 'react-native';
import { useVideoPlayer, VideoView, type VideoPlayer, type VideoSource } from 'expo-video';
import type { Api } from '@/lib/api';
import { useOnePlayerAtATime } from '@/lib/playback';
import type { Video } from '@/lib/types';

/** A player for `video` that doesn't start by itself, signed in to its own server. */
export function usePreviewPlayer(video: Video, api: Api): VideoPlayer {
  const url = api.abs(video.hls_url || video.video_url);
  const source = useMemo<VideoSource>(
    () => (url ? { uri: url, headers: api.authFor(url), contentType: video.hls_url ? 'hls' : 'progressive' } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url],
  );
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });
  // The current player while its screen is on top: the Now buttons read it and Play seeks it.
  useOnePlayerAtATime(player);
  return player;
}

/** The video on the details page, with the native controls. */
export function PreviewPlayer({ player, video }: { player: VideoPlayer; video: Video }) {
  const aspect = video.width && video.height ? video.width / video.height : 16 / 9;
  return (
    <View style={{ width: '100%', aspectRatio: Math.max(aspect, 3 / 4), backgroundColor: '#000', borderRadius: 12, overflow: 'hidden' }}>
      <VideoView player={player} style={{ width: '100%', height: '100%' }} nativeControls contentFit="contain" fullscreenOptions={{ enable: true, orientation: aspect >= 1 ? 'landscape' : 'portrait' }} />
    </View>
  );
}
