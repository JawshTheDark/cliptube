import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View, TextInput as RNTextInput } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, Button, Empty, ErrorBox, Icon, IconButton, Loading, toast } from '@/components/ui';
import type { Api } from '@/lib/api';
import { ago, duration, hostOf } from '@/lib/format';
import { currentTime } from '@/lib/playback';
import { knownServers, openProfile } from '@/lib/profiles';
import { commentTarget, openReport } from '@/lib/report';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Comment } from '@/lib/types';
import { RichText } from './RichText';
import { Text, TextInput } from './Text';

type Thread = { c: Comment; reply: boolean };
type CommentsResponse = { comments: Comment[]; comment_mode?: string; can_post?: boolean; host_name?: string };

/**
 * A video's comments and the box to add one. `path` is `/videos/<id>` or `/network/videos/<peer>/<id>` (comments
 * on videos from other servers, PeerTube's included, come through here). Times in comments call `onSeek`.
 */
export function CommentsView({
  api,
  foreign,
  path,
  onSeek,
  onCount,
  avoidKeyboard = true,
}: {
  api: Api;
  foreign: string | null;
  path: string;
  onSeek?: (seconds: number) => void;
  onCount?: (n: number) => void;
  /** False when the screen around it moves out of the keyboard's way itself (the sheet over Shorts). */
  avoidKeyboard?: boolean;
}) {
  const { user, servers, site } = useSession();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<ComponentRef<typeof RNTextInput>>(null);
  const known = useMemo(() => knownServers(servers, site), [servers, site]);

  const load = useCallback(() => {
    setError(null);
    api
      .get<CommentsResponse>(`${path}/comments`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [api, path]);
  useEffect(load, [load]);
  useEffect(() => {
    if (data) onCount?.(data.comments.length);
  }, [data, onCount]);

  // Top-level comments in order, each followed by its replies (threads are one level deep; a PeerTube thread's
  // replies all hang off its first comment).
  const threads = useMemo<Thread[]>(() => {
    const list = data?.comments || [];
    const ids = new Set(list.map((c) => c.id));
    const replies = new Map<string, Comment[]>();
    for (const c of list) if (c.parent_id && ids.has(c.parent_id)) replies.set(c.parent_id, [...(replies.get(c.parent_id) || []), c]);
    const out: Thread[] = [];
    for (const c of list) {
      if (c.parent_id && ids.has(c.parent_id)) continue;
      out.push({ c, reply: false });
      for (const r of replies.get(c.id) || []) out.push({ c: r, reply: true });
    }
    return out;
  }, [data]);

  const off = data?.comment_mode === 'off';
  const canPost = !!user && !foreign && !off && data?.can_post !== false;
  // Add time needs a video playing under the comments.
  const [hasVideo] = useState(() => currentTime() !== null);

  // Where the cursor is, so Add time goes there; null until the box has been touched (then it goes at the end).
  const sel = useRef<{ start: number; end: number } | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const insertTime = () => {
    const t = currentTime();
    if (t === null) return;
    const stamp = duration(Math.floor(t));
    const at = sel.current || { start: text.length, end: text.length };
    const before = text.slice(0, at.start);
    const after = text.slice(at.end);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const caret = before.length + pad.length + stamp.length + 1;
    setText(`${before}${pad}${stamp} ${after}`);
    sel.current = { start: caret, end: caret };
    setSelection({ start: caret, end: caret });
    input.current?.focus();
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const r = await api.post<{ comment: Comment; held?: boolean; held_reason?: string | null; pending?: boolean; host_name?: string }>(`${path}/comments`, {
        body,
        ...(replyTo ? { parent_id: replyTo.id } : {}),
      });
      setData((d) => (d ? { ...d, comments: [...d.comments, r.comment] } : d));
      setText('');
      sel.current = null;
      setReplyTo(null);
      if (r.held) toast(`Your comment is waiting for approval${r.held_reason ? `: ${r.held_reason}` : ''}`);
      else if (r.pending) toast(`Sent to ${r.host_name || 'its server'}; it shows once accepted`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSending(false);
    }
  };

  const remove = (c: Comment) =>
    Alert.alert('Delete comment?', c.body.slice(0, 140), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.del(`${path}/comments/${encodeURIComponent(c.id)}`);
            setData((d) => (d ? { ...d, comments: d.comments.filter((x) => x.id !== c.id && x.parent_id !== c.id) } : d));
          } catch (e: any) {
            toast(e.message);
          }
        },
      },
    ]);

  const approve = async (c: Comment) => {
    try {
      const r = await api.patch<{ comment: Comment }>(`${path}/comments/${encodeURIComponent(c.id)}`, { status: 'visible' });
      setData((d) => (d ? { ...d, comments: d.comments.map((x) => (x.id === c.id ? r.comment : x)) } : d));
    } catch (e: any) {
      toast(e.message);
    }
  };

  const renderItem = ({ item: { c, reply } }: { item: Thread }) => {
    const pending = c.status && c.status !== 'visible';
    // Someone on another server (a PeerTube account, say): their name opens their profile there.
    const profile = c.author.remote ? c.author.profile_url : null;
    return (
      <Pressable onLongPress={() => c.can_delete && remove(c)} style={[s.comment, reply && s.reply]}>
        <Pressable onPress={profile ? () => openProfile(profile, known) : undefined} disabled={!profile} hitSlop={4}>
          <Avatar uri={api.abs(c.author.avatar_url)} name={c.author.display_name} size={reply ? 26 : 34} />
        </Pressable>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.author} numberOfLines={1}>
            <Text style={s.author} onPress={profile ? () => openProfile(profile, known) : undefined}>
              {c.author.remote ? c.author.username : `@${c.author.username}`}
            </Text>
            {c.is_uploader ? <Text style={s.badge}>{c.linked_uploader ? '  uploader · linked account' : '  uploader'}</Text> : null}
            <Text style={s.when}>{`  ${ago(c.created_at)}`}</Text>
          </Text>
          {c.pinned && (
            <Text style={s.when}>
              <Icon name="push-pin" size={12} color={colors.text2} /> Pinned
            </Text>
          )}
          <RichText text={c.body} onSeek={onSeek} style={[s.body, pending && { color: colors.text2 }]} />
          {pending && (
            <Text style={[s.when, { color: colors.warn }]}>
              {c.status === 'held' ? `Held for approval${c.held_reason ? `: ${c.held_reason}` : ''}` : c.status === 'rejected' ? `Not accepted${c.status_reason ? `: ${c.status_reason}` : ''}` : 'Waiting for its server'}
            </Text>
          )}
          <View style={s.commentActions}>
            {c.hearted && <Icon name="favorite" size={14} color={colors.accent} />}
            {canPost && !reply && (
              <Pressable onPress={() => setReplyTo(c)} hitSlop={8}>
                <Text style={s.link}>Reply</Text>
              </Pressable>
            )}
            {c.status === 'held' && c.can_moderate && (
              <Pressable onPress={() => approve(c)} hitSlop={8}>
                <Text style={s.link}>Approve</Text>
              </Pressable>
            )}
            {c.can_delete && (
              <Pressable onPress={() => remove(c)} hitSlop={8}>
                <Text style={[s.link, { color: colors.text2 }]}>Delete</Text>
              </Pressable>
            )}
            {!!user && !foreign && !c.can_delete && (
              <Pressable onPress={() => openReport(commentTarget(path, c))} hitSlop={8} accessibilityLabel={`Report the comment by @${c.author.username}`}>
                <Text style={[s.link, { color: colors.text2 }]}>Report</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Pressable>
    );
  };

  const Box = avoidKeyboard ? KeyboardAvoidingView : View;
  return (
    <Box style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding" keyboardVerticalOffset={0}>
      {error ? (
        <ErrorBox message={error} onRetry={load} />
      ) : !data ? (
        <Loading />
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(t) => t.c.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingVertical: 8 }}
          ListEmptyComponent={<Empty icon="chat-bubble-outline" title={off ? 'Comments are off' : 'No comments yet'}>{off ? 'The uploader turned comments off for this video.' : canPost ? 'Be the first to say something.' : ''}</Empty>}
          keyboardShouldPersistTaps="handled"
        />
      )}
      <View style={[s.composer, { paddingBottom: 8 + insets.bottom }]}>
        {canPost ? (
          <>
            {replyTo && (
              <View style={s.replying}>
                <Text style={s.when} numberOfLines={1}>
                  Replying to {replyTo.author.display_name}
                </Text>
                <IconButton name="close" size={16} label="Cancel reply" onPress={() => setReplyTo(null)} />
              </View>
            )}
            <View style={s.inputRow}>
              <TextInput
                ref={input}
                value={text}
                onChangeText={setText}
                selection={selection}
                onSelectionChange={(e) => {
                  sel.current = e.nativeEvent.selection;
                  if (selection) setSelection(undefined);
                }}
                placeholder={replyTo ? 'Add a reply…' : 'Add a comment…'}
                style={s.input}
                multiline
                maxLength={2000}
              />
              {hasVideo && <IconButton name="more-time" label="Add the video's current time" onPress={insertTime} color={colors.text2} />}
              <IconButton name="send" label="Send" onPress={send} color={text.trim() && !sending ? colors.link : colors.text2} />
            </View>
          </>
        ) : foreign ? (
          <Text style={s.note}>Switch to {hostOf(foreign)} to comment here.</Text>
        ) : !user ? (
          <Button title="Sign in to comment" onPress={() => router.push('/login')} />
        ) : off ? null : data?.can_post === false ? (
          <Text style={s.note}>{data.host_name ? `${data.host_name} isn’t taking comments from this server right now.` : 'Comments from here aren’t accepted for this video.'}</Text>
        ) : null}
      </View>
    </Box>
  );
}

const s = StyleSheet.create({
  comment: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  reply: { paddingLeft: 56 },
  author: { color: colors.text2, fontSize: 12.5, fontWeight: '600' },
  badge: { color: colors.link, fontWeight: '600' },
  when: { color: colors.text2, fontSize: 12, fontWeight: '400' },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  commentActions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 2 },
  link: { color: colors.text, fontSize: 12.5, fontWeight: '600' },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 12, paddingTop: 8, backgroundColor: colors.bg },
  replying: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  input: { flex: 1, color: colors.text, fontSize: 15, backgroundColor: colors.surface2, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 120 },
  note: { color: colors.text2, textAlign: 'center', paddingVertical: 8 },
});
