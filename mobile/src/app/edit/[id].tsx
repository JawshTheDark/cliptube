import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { Text } from '@/components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, ErrorBox, Loading, toast } from '@/components/ui';
import { VideoForm, type VideoFields } from '@/components/VideoForm';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

export default function EditVideo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const [video, setVideo] = useState<Video | null>(null);
  const [fields, setFields] = useState<VideoFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ video: Video }>(`/videos/${encodeURIComponent(id)}`)
      .then(({ video: v }) => {
        if (!v.can_edit) throw new Error('You can only edit your own videos.');
        setVideo(v);
        setFields({
          title: v.title,
          description: v.description || '',
          tags: (v.tags || []).join(', '),
          game: v.game?.name || '',
          // A draft keeps the visibility it will get once published.
          visibility: (v.draft ? v.draft_visibility : v.visibility) || 'public',
          allow_clips: !!v.allow_clips,
        });
      })
      .catch((e) => setError(e.message));
  }, [api, id]);

  if (error) return <ErrorBox message={error} />;
  if (!video || !fields) return <Loading />;

  const save = async () => {
    if (!fields.title.trim()) return toast('Give the video a title');
    setBusy(true);
    try {
      await api.patch(`/videos/${encodeURIComponent(id)}`, {
        title: fields.title.trim(),
        description: fields.description,
        tags: fields.tags,
        game: fields.game.trim(),
        visibility: fields.visibility,
        allow_clips: fields.allow_clips,
        // Saving a draft from the app publishes it, like Save details on the website.
        ...(video.draft ? { publish: true } : {}),
      });
      toast(video.draft ? 'Published' : 'Saved');
      router.back();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    Alert.alert('Delete this video?', `"${video.title}" and its comments are deleted for good.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.del(`/videos/${encodeURIComponent(id)}`);
            toast('Video deleted');
            router.dismissTo('/library/mine');
          } catch (e: any) {
            toast(e.message);
          }
        },
      },
    ]);

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {video.draft && <Text style={{ color: colors.warn }}>This video is a draft. Saving publishes it.</Text>}
        <VideoForm value={fields} onChange={setFields} />
        <Button title={video.draft ? 'Publish' : 'Save'} kind="primary" onPress={save} busy={busy} />
        <View style={{ height: 8 }} />
        <Button title="Delete video" kind="danger" icon="delete-outline" onPress={remove} />
        <Text style={{ color: colors.text2, fontSize: 12.5 }}>Trim, thumbnails and captions are on the website’s Studio.</Text>
    </KeyboardAwareScrollView>
  );
}
