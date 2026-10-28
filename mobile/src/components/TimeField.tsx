import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { parseStamp } from './RichText';
import { s as fs } from './Form';
import { Text, TextInput } from './Text';
import { currentTime } from '@/lib/playback';
import { precise } from '@/lib/time';
import { colors } from '@/lib/theme';

/**
 * A time like 1:05.3, with buttons a tenth of a second either way and Now (the playing video's position), as in the
 * website's clip and segment dialogs.
 */
export function TimeField({ label, value, onChange, now = true }: { label: string; value: number; onChange: (t: number) => void; now?: boolean }) {
  const [text, setText] = useState(precise(value));
  useEffect(() => setText(precise(value)), [value]);
  const commit = () => {
    const v = parseStamp(text.trim());
    if (v === null || !Number.isFinite(v)) setText(precise(value));
    else onChange(v);
  };
  return (
    <View style={{ gap: 6, flexGrow: 1, flexBasis: 220 }}>
      <Text style={fs.label}>{label}</Text>
      <View style={s.row}>
        <Pressable style={s.step} onPress={() => onChange(value - 0.1)} accessibilityLabel={`${label} back a tenth of a second`}>
          <Text style={s.stepText}>−</Text>
        </Pressable>
        <TextInput value={text} onChangeText={setText} onBlur={commit} onSubmitEditing={commit} style={[fs.input, s.input]} keyboardType="numbers-and-punctuation" accessibilityLabel={label} selectTextOnFocus />
        <Pressable style={s.step} onPress={() => onChange(value + 0.1)} accessibilityLabel={`${label} forward a tenth of a second`}>
          <Text style={s.stepText}>+</Text>
        </Pressable>
        {now && (
          <Pressable
            style={[s.step, { paddingHorizontal: 12, width: undefined }]}
            onPress={() => {
              const t = currentTime();
              if (t !== null) onChange(t);
            }}
            accessibilityLabel={`${label} at the video's current position`}
          >
            <Text style={[s.stepText, { fontSize: 13.5 }]}>Now</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: { flex: 1, textAlign: 'center', fontVariant: ['tabular-nums'] },
  step: { width: 40, height: 42, borderRadius: 10, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.text, fontSize: 18, fontWeight: '700' },
});
