import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Section, s as fs } from './Form';
import { Text } from './Text';
import { Button, Loading, toast } from './ui';
import { ago } from '@/lib/format';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const watch = (id: string) => router.push(`/watch/${encodeURIComponent(id)}` as any);

/** Quoted text from a comment or a report, with a bar down its side. */
export const Quote = ({ text }: { text: string }) => (
  <View style={{ borderLeftWidth: 3, borderLeftColor: colors.surface3, paddingLeft: 10 }}>
    <Text style={{ color: colors.text, lineHeight: 20 }} selectable>
      {text}
    </Text>
  </View>
);

/** Comments waiting for review. The studio's held comments use the same list with its own endpoint. */
export function HeldComments({ endpoint = '/mod/comments/held' }: { endpoint?: string }) {
  const { api } = useSession();
  const [comments, setComments] = useState<any[] | null>(null);
  const load = useCallback(
    () =>
      api
        .get<{ comments: any[] }>(endpoint)
        .then((r) => setComments(r.comments))
        .catch(() => setComments([])),
    [api, endpoint],
  );
  useEffect(() => {
    load();
  }, [load]);
  const act = async (c: any, approve: boolean) => {
    try {
      if (approve) await api.patch(`/videos/${c.video_id}/comments/${c.id}`, { status: 'visible' });
      else await api.del(`/videos/${c.video_id}/comments/${c.id}`);
      setComments((list) => (list || []).filter((x) => x.id !== c.id));
      toast(approve ? 'Approved' : 'Deleted');
    } catch (e: any) {
      toast(e.message);
    }
  };
  if (comments === null) return <Loading />;
  if (!comments.length) return <Text style={fs.hint}>No comments are waiting for review.</Text>;
  return (
    <>
      {comments.map((c) => (
        <Section key={c.id}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Badge text={c.held_reason || 'Held'} tone="warn" />
            <Text style={fs.hint}>
              {`@${c.author.username}${c.author.remote ? ' (another instance)' : ''} on `}
              <Text style={{ color: colors.link }} onPress={() => watch(c.video_id)}>
                {c.video_title}
              </Text>
              {` · ${ago(c.created_at)}`}
            </Text>
          </View>
          <Quote text={c.body} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button title="Approve" small kind="accent" onPress={() => act(c, true)} />
            <Button title="Delete" small onPress={() => act(c, false)} />
          </View>
        </Section>
      ))}
    </>
  );
}
