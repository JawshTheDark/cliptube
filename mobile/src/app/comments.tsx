import { useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CommentsView } from '@/components/Comments';
import { seekCurrent } from '@/lib/playback';
import { useLinkedApi } from '@/lib/scope';

/** A video's comments over its watch page. A time in a comment jumps the video there and goes back to it. */
export default function Comments() {
  const params = useLocalSearchParams<{ path: string; title?: string; server?: string; owner?: string }>();
  const { api, foreign } = useLinkedApi(params.server);
  const [count, setCount] = useState<number | null>(null);
  const seek = (t: number) => {
    if (seekCurrent(t) && router.canGoBack()) router.back();
  };
  return (
    <>
      <Stack.Screen options={{ title: `Comments${count !== null ? ` · ${count}` : ''}` }} />
      <CommentsView api={api} foreign={foreign} path={params.path} onSeek={seek} onCount={setCount} />
    </>
  );
}
