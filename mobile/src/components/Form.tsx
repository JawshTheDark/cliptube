import { useState, type ComponentProps, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '@/lib/theme';
import { Text, TextInput } from './Text';
import { Icon, type IconName } from './ui';

/**
 * The pieces settings and admin screens are built from, matching the website's cards, fields, checkboxes and
 * selects: a Section is a card with a heading, a Field a label with a hint, a Toggle a checkbox, a Select a
 * dropdown that opens a list.
 */

export function Section({ title, hint, right, children, style }: { title?: string; hint?: ReactNode; right?: ReactNode; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[s.section, style]}>
      {(!!title || !!right) && (
        <View style={s.sectionHead}>
          {!!title && <Text style={s.sectionTitle}>{title}</Text>}
          {right}
        </View>
      )}
      {typeof hint === 'string' ? <Text style={s.hint}>{hint}</Text> : hint}
      {children}
    </View>
  );
}

export function Field({ label, hint, children, style }: { label?: string; hint?: ReactNode; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      {!!label && <Text style={s.label}>{label}</Text>}
      {children}
      {typeof hint === 'string' ? <Text style={s.hint}>{hint}</Text> : hint}
    </View>
  );
}

/** Fields side by side on a wide screen, one under the other on a narrow one. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <View style={s.fieldRow}>{children}</View>;
}

export function Input({ style, multiline, ...props }: ComponentProps<typeof TextInput>) {
  return <TextInput {...props} multiline={multiline} style={[s.input, multiline && { minHeight: 96, textAlignVertical: 'top' }, style]} />;
}

/** A number box that hands back the text, as the website's number inputs do (the server parses it). */
export function NumberInput({ value, onChangeText, ...props }: Omit<ComponentProps<typeof TextInput>, 'value'> & { value: string | number | null | undefined }) {
  return <Input {...props} value={value === null || value === undefined ? '' : String(value)} onChangeText={onChangeText} keyboardType="numeric" />;
}

export function Toggle({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Pressable onPress={() => !disabled && onChange(!value)} style={[s.toggle, disabled && { opacity: 0.5 }]} accessibilityRole="switch" accessibilityState={{ checked: value, disabled }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        {!!hint && <Text style={s.hint}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" />
    </Pressable>
  );
}

/** "true"/"false" settings strings, as the server stores them. */
export const isOn = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
export const onOff = (b: boolean) => (b ? 'true' : 'false');

export type Option<T extends string> = { value: T; label: string; hint?: string };

/** A dropdown: shows the chosen option, and opens the list of them in a sheet. */
export function Select<T extends string>({ value, options, onChange, disabled, placeholder, small }: { value: T | null | undefined; options: Option<T>[]; onChange: (v: T) => void; disabled?: boolean; placeholder?: string; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} disabled={disabled} style={[s.input, s.select, small && s.selectSmall, disabled && { opacity: 0.5 }]} accessibilityRole="combobox" accessibilityValue={{ text: current?.label }}>
        <Text style={[s.selectText, small && { fontSize: 13 }, !current && { color: colors.text2 }]} numberOfLines={1}>
          {current?.label || placeholder || 'Choose…'}
        </Text>
        <Icon name="expand-more" size={small ? 18 : 22} color={colors.text2} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent navigationBarTranslucent>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[s.sheet, { paddingBottom: 12 + insets.bottom }]} onPress={() => {}}>
            <ScrollView style={{ maxHeight: 460 }}>
              {options.map((o) => {
                const on = o.value === value;
                return (
                  <Pressable
                    key={o.value}
                    onPress={() => {
                      setOpen(false);
                      if (!on) onChange(o.value);
                    }}
                    style={({ pressed }) => [s.option, pressed && { backgroundColor: colors.surface2 }]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <Icon name={on ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={on ? colors.accent : colors.text2} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.optionText}>{o.label}</Text>
                      {!!o.hint && <Text style={s.hint}>{o.hint}</Text>}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** A sheet that rises from the bottom of the screen, over a dimmed backdrop: menus and short choices. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={[s.sheet, { paddingBottom: 12 + insets.bottom }]} onPress={() => {}}>
          {!!title && <Text style={s.sheetTitle}>{title}</Text>}
          <ScrollView style={{ maxHeight: 520 }}>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export type MenuItem = { label: string; onPress: () => void; destructive?: boolean; icon?: IconName; hint?: string; checked?: boolean };

/** A list of actions in a Sheet; picking one closes it first. */
export function ActionSheet({ visible, onClose, title, items }: { visible: boolean; onClose: () => void; title?: string; items: MenuItem[] }) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {items.map((it) => (
        <Pressable
          key={it.label}
          onPress={() => {
            onClose();
            it.onPress();
          }}
          style={({ pressed }) => [s.option, pressed && { backgroundColor: colors.surface2 }]}
          accessibilityRole={it.checked === undefined ? 'button' : 'radio'}
          accessibilityState={it.checked === undefined ? undefined : { checked: it.checked }}
        >
          {it.checked !== undefined ? (
            <Icon name={it.checked ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={it.checked ? colors.accent : colors.text2} />
          ) : (
            !!it.icon && <Icon name={it.icon} size={22} color={it.destructive ? colors.err : colors.text} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={[s.optionText, it.destructive && { color: colors.err }]}>{it.label}</Text>
            {!!it.hint && <Text style={s.hint}>{it.hint}</Text>}
          </View>
        </Pressable>
      ))}
    </Sheet>
  );
}

/** The website's "more" menu (a ⋮ button): a list of actions in a sheet. */
export function MoreMenu({ items, label = 'More', title }: { items: MenuItem[]; label?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={8} style={{ padding: 6 }} accessibilityRole="button" accessibilityLabel={label}>
        <Icon name="more-vert" size={22} color={colors.text2} />
      </Pressable>
      <ActionSheet visible={open} onClose={() => setOpen(false)} title={title} items={items} />
    </>
  );
}

/** The website's stat tiles: a big number over a label. */
export function Stats({ items }: { items: { n: ReactNode; l: string }[] }) {
  return (
    <View style={s.stats}>
      {items.map((x) => (
        <View key={x.l} style={s.stat}>
          <Text style={s.statN} numberOfLines={1}>
            {x.n}
          </Text>
          <Text style={s.statL}>{x.l}</Text>
        </View>
      ))}
    </View>
  );
}

/** A label and its value on one line, for diagnostics. */
export function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.infoValue, mono && { fontFamily: 'monospace', fontSize: 12.5 }]} selectable>
        {value === null || value === undefined || value === '' ? '—' : value}
      </Text>
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'accent' }) {
  const c = { neutral: colors.text2, ok: colors.ok, warn: colors.warn, err: colors.err, accent: colors.accentText }[tone];
  return (
    <View style={[s.badge, { borderColor: c }]}>
      <Text style={[s.badgeText, { color: c }]}>{text}</Text>
    </View>
  );
}

export function Notice({ icon = 'info-outline', tone = 'neutral', children }: { icon?: IconName; tone?: 'neutral' | 'warn' | 'ok' | 'err'; children: ReactNode }) {
  const c = { neutral: colors.accentText, warn: colors.warn, ok: colors.ok, err: colors.err }[tone];
  return (
    <View style={[s.notice, { borderColor: c }]}>
      <Icon name={icon} size={20} color={c} />
      <View style={{ flex: 1 }}>{typeof children === 'string' ? <Text style={{ color: colors.text, lineHeight: 20 }}>{children}</Text> : children}</View>
    </View>
  );
}

/** One item in a list inside a Section: a title, a line under it, and actions on the right. */
export function ListItem({ title, sub, right, onPress, left }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onPress?: () => void; left?: ReactNode }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.item, pressed && onPress && { backgroundColor: colors.surface2 }]}>
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === 'string' ? (
          <Text style={s.itemTitle} numberOfLines={2}>
            {title}
          </Text>
        ) : (
          title
        )}
        {typeof sub === 'string' ? <Text style={s.hint}>{sub}</Text> : sub}
      </View>
      {right}
    </Pressable>
  );
}

export const s = StyleSheet.create({
  section: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.hairline, padding: 14, gap: 12 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { flex: 1, color: colors.text, fontSize: 18, fontFamily: fonts.display, fontWeight: '800', letterSpacing: -0.3 },
  label: { color: colors.text2, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.text2, fontSize: 12.5, lineHeight: 17 },
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  input: { color: colors.text, fontSize: 15, backgroundColor: colors.bg2, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10 },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectSmall: { paddingVertical: 6, paddingHorizontal: 10 },
  selectText: { flex: 1, color: colors.text, fontSize: 15 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  toggleLabel: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 12 },
  optionText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sheetTitle: { color: colors.text2, fontSize: 13, fontWeight: '700', paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { flexGrow: 1, flexBasis: 140, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.hairline, padding: 12, gap: 2 },
  statN: { color: colors.text, fontSize: 22, fontFamily: fonts.display, fontWeight: '800' },
  statL: { color: colors.text2, fontSize: 12.5 },
  infoRow: { flexDirection: 'row', gap: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  infoLabel: { color: colors.text2, fontSize: 13, width: 130 },
  infoValue: { flex: 1, color: colors.text, fontSize: 13.5 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11.5, fontWeight: '700' },
  notice: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, backgroundColor: colors.surface },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  itemTitle: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
});
