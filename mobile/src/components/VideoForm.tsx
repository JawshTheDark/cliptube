import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Game, Visibility } from '@/lib/types';

export type VideoFields = {
  title: string;
  description: string;
  tags: string;
  game: string;
  visibility: Visibility;
  allow_clips: boolean;
};

export const emptyFields: VideoFields = { title: '', description: '', tags: '', game: '', visibility: 'public', allow_clips: false };

const VIS: { key: Visibility; label: string; hint: string }[] = [
  { key: 'public', label: 'Public', hint: 'Everyone can find and watch it' },
  { key: 'unlisted', label: 'Unlisted', hint: 'Only people with the link' },
  { key: 'private', label: 'Private', hint: 'Only you' },
];

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={f.label}>{label}</Text>
      {children}
    </View>
  );
}

/** Title, description, tags, game, visibility: shared by the upload and edit screens. */
export function VideoForm({ value, onChange }: { value: VideoFields; onChange: (v: VideoFields) => void }) {
  const { api, user } = useSession();
  const [games, setGames] = useState<Game[]>([]);
  const [gameFocus, setGameFocus] = useState(false);
  const set = <K extends keyof VideoFields>(k: K, v: VideoFields[K]) => onChange({ ...value, [k]: v });

  useEffect(() => {
    api
      .get<{ games: Game[] }>('/games')
      .then((r) => setGames(r.games))
      .catch(() => {});
  }, [api]);

  const q = value.game.trim().toLowerCase();
  const matches = useMemo(
    () =>
      games
        .filter((g) => !q || g.name.toLowerCase().includes(q) || (g.short_name || '').toLowerCase().includes(q) || (g.aliases || []).some((a) => a.toLowerCase().includes(q)))
        .slice(0, 6),
    [games, q],
  );
  const exact = games.some((g) => g.name.toLowerCase() === q);

  return (
    <View style={{ gap: 16 }}>
      <Field label="Title">
        <TextInput value={value.title} onChangeText={(t) => set('title', t)} style={f.input} placeholder="What happened in this clip?" placeholderTextColor={colors.text2} maxLength={120} />
      </Field>
      <Field label="Description">
        <TextInput
          value={value.description}
          onChangeText={(t) => set('description', t)}
          style={[f.input, { minHeight: 90, textAlignVertical: 'top' }]}
          placeholder="Optional"
          placeholderTextColor={colors.text2}
          multiline
          maxLength={5000}
        />
      </Field>
      <Field label="Game">
        <TextInput
          value={value.game}
          onChangeText={(t) => set('game', t)}
          onFocus={() => setGameFocus(true)}
          onBlur={() => setTimeout(() => setGameFocus(false), 150)}
          style={f.input}
          placeholder="Search the game list"
          placeholderTextColor={colors.text2}
        />
        {gameFocus && !exact && matches.length > 0 && (
          <View style={f.suggest}>
            {matches.map((g) => (
              <Pressable key={g.id} onPress={() => set('game', g.name)} style={({ pressed }) => [f.suggestItem, pressed && { backgroundColor: colors.surface3 }]}>
                <Text style={{ color: colors.text }}>{g.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {!!q && !exact && !matches.length && !user?.is_moderator && <Text style={f.hint}>Not in this server’s game list. A moderator can add it.</Text>}
      </Field>
      <Field label="Tags">
        <TextInput value={value.tags} onChangeText={(t) => set('tags', t)} style={f.input} placeholder="ace, clutch, funny" placeholderTextColor={colors.text2} autoCapitalize="none" />
      </Field>
      <Field label="Visibility">
        <View style={{ gap: 8 }}>
          {VIS.map((x) => (
            <Pressable key={x.key} onPress={() => set('visibility', x.key)} style={[f.radio, value.visibility === x.key && f.radioOn]} accessibilityRole="radio" accessibilityState={{ checked: value.visibility === x.key }}>
              <View style={[f.dot, value.visibility === x.key && f.dotOn]} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>{x.label}</Text>
                <Text style={f.hint}>{x.hint}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </Field>
      <View style={f.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontWeight: '600' }}>Allow clipping</Text>
          <Text style={f.hint}>Others can cut their own clips from this one</Text>
        </View>
        <Switch value={value.allow_clips} onValueChange={(b) => set('allow_clips', b)} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" />
      </View>
    </View>
  );
}

export const f = StyleSheet.create({
  label: { color: colors.text2, fontSize: 13, fontWeight: '600' },
  input: { color: colors.text, fontSize: 15, backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.hairline, paddingHorizontal: 12, paddingVertical: 10 },
  hint: { color: colors.text2, fontSize: 12.5 },
  suggest: { backgroundColor: colors.surface2, borderRadius: 10, overflow: 'hidden' },
  suggestItem: { paddingHorizontal: 12, paddingVertical: 10 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  radioOn: { borderColor: colors.text },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.text2 },
  dotOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
