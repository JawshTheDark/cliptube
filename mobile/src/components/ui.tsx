import { type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, ToastAndroid, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { colors } from '@/lib/theme';

export type IconName = ComponentProps<typeof MaterialIcons>['name'];

export function Icon({ name, size = 22, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return <MaterialIcons name={name} size={size} color={color} />;
}

export function toast(message: string) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert(message);
}

export function Avatar({ uri, name, size = 36 }: { uri: string | null | undefined; name?: string; size?: number }) {
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  if (uri) return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surface2 }} contentFit="cover" />;
  return (
    <View style={[styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ color: colors.text, fontSize: size * 0.45, fontWeight: '600' }}>{letter}</Text>
    </View>
  );
}

type ButtonKind = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  kind = 'secondary',
  icon,
  disabled,
  busy,
  style,
  small,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const bg = { primary: colors.text, accent: colors.accent, secondary: colors.surface2, ghost: 'transparent', danger: '#5a1a1a' }[kind];
  const fg = kind === 'primary' ? colors.bg : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 },
        kind === 'ghost' && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={small ? 18 : 20} color={fg} /> : null}
      {!!title && <Text style={[styles.buttonText, small && { fontSize: 13 }, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function IconButton({ name, onPress, label, color = colors.text, size = 24 }: { name: IconName; onPress: () => void; label: string; color?: string; size?: number }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.surface2 }]}>
      <Icon name={name} size={size} color={color} />
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} accessibilityRole="button" accessibilityState={{ selected: !!active }}>
      <Text style={[styles.chipText, active && { color: colors.bg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Loading({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.center, { paddingVertical: 48 }, style]}>
      <ActivityIndicator color={colors.text2} size="large" />
    </View>
  );
}

export function Empty({ icon = 'video-library', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <View style={[styles.center, { paddingVertical: 56, paddingHorizontal: 32, gap: 10 }]}>
      <Icon name={icon} size={56} color={colors.text2} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {typeof children === 'string' ? <Text style={styles.emptyText}>{children}</Text> : children}
    </View>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.errorBox}>
      <Icon name="error-outline" size={20} color={colors.err} />
      <Text style={{ color: colors.err, flex: 1 }}>{message}</Text>
      {onRetry && <Button title="Retry" small onPress={onRetry} />}
    </View>
  );
}

export const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  avatarFallback: { backgroundColor: '#5c6bc0', alignItems: 'center', justifyContent: 'center' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 18,
    paddingHorizontal: 16,
    minHeight: 40,
  },
  buttonSmall: { minHeight: 32, paddingHorizontal: 12, borderRadius: 16 },
  buttonText: { fontSize: 14, fontWeight: '600' },
  iconButton: { padding: 8, borderRadius: 20 },
  chip: { backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  chipActive: { backgroundColor: colors.text },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '500' },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  emptyText: { color: colors.text2, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    margin: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,107,107,0.1)',
  },
});
