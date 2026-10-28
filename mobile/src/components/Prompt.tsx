import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { Text, TextInput } from './Text';
import { Button } from './ui';

/**
 * The website asks with window.prompt and window.confirm (a reason for a ban, a quota, "delete this?"). Android has
 * a confirm (Alert) but no prompt, so prompt() opens this dialog; PromptHost sits once at the root.
 */
type Ask = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  numeric?: boolean;
  multiline?: boolean;
  resolve: (v: string | null) => void;
};

let show: ((a: Ask) => void) | null = null;

/** Asks for a line of text. Resolves to null when cancelled. */
export function prompt(opts: Omit<Ask, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ ...opts, resolve });
  });
}

/** Yes or no. `destructive` paints the yes button as a warning. */
export function confirm(title: string, message?: string, { confirmLabel = 'OK', destructive = false }: { confirmLabel?: string; destructive?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

export function PromptHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    show = (a) => {
      setText(a.defaultValue ?? '');
      setAsk(a);
    };
    return () => {
      show = null;
    };
  }, []);
  const done = (v: string | null) => {
    ask?.resolve(v);
    setAsk(null);
  };
  return (
    <Modal visible={!!ask} transparent animationType="fade" onRequestClose={() => done(null)} statusBarTranslucent>
      <Pressable style={s.backdrop} onPress={() => done(null)}>
        <Pressable style={s.box} onPress={() => {}}>
          <Text style={s.title}>{ask?.title}</Text>
          {!!ask?.message && <Text style={s.message}>{ask.message}</Text>}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={ask?.placeholder}
            autoFocus
            keyboardType={ask?.numeric ? 'numeric' : 'default'}
            multiline={ask?.multiline}
            onSubmitEditing={() => !ask?.multiline && done(text)}
            style={[s.input, ask?.multiline && { minHeight: 80, textAlignVertical: 'top' }]}
          />
          <View style={s.buttons}>
            <Button title="Cancel" kind="ghost" onPress={() => done(null)} />
            <Button title={ask?.confirmLabel || 'OK'} kind="accent" onPress={() => done(text)} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  box: { width: '100%', maxWidth: 480, backgroundColor: colors.surface, borderRadius: 18, padding: 18, gap: 12, borderWidth: 1, borderColor: colors.border },
  title: { color: colors.text, fontSize: 18, fontFamily: fonts.display, fontWeight: '800' },
  message: { color: colors.text2, fontSize: 14, lineHeight: 20 },
  input: { color: colors.text, fontSize: 15, backgroundColor: colors.bg2, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
});
