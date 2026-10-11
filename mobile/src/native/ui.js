import { useMemo } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

/** Small shared UI pieces so the screens stay readable, light and dark. */

/** Native: a real confirm dialog. Web: Alert.alert has nothing to render there. */
export function confirm(message, onConfirm, { title = 'Are you sure?', confirmLabel = 'Delete' } = {}) {
  if (Platform.OS === 'web') {
    if (window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}

const palettes = {
  light: {
    bg: '#F6F7F9',
    card: '#FFFFFF',
    text: '#111418',
    muted: '#5B6470',
    line: '#E3E6EA',
    accent: '#1F6FEB',
    danger: '#D1242F',
    ok: '#1A7F37',
  },
  dark: {
    bg: '#0B0D10',
    card: '#1B1E22',
    text: '#EDEFF2',
    muted: '#9AA3AD',
    line: '#2E3338',
    accent: '#5B9CFF',
    danger: '#FF6B6B',
    ok: '#3FC97A',
  },
};

function buildStyles(colors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, gap: 12 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line },
    h1: { fontSize: 22, fontWeight: '700', color: colors.text },
    h2: { fontSize: 16, fontWeight: '600', color: colors.text },
    body: { fontSize: 15, color: colors.text },
    muted: { fontSize: 13, color: colors.muted },
    error: { fontSize: 14, color: colors.danger },
    row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    button: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center' },
    buttonSmall: { paddingVertical: 10, paddingHorizontal: 12 },
    buttonOutline: { borderWidth: 1, borderColor: colors.accent },
    buttonText: { fontSize: 16, fontWeight: '600' },
    buttonTextSmall: { fontSize: 14 },
    segmented: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: 'hidden' },
    segment: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: colors.card },
    segmentSelected: { backgroundColor: colors.accent },
    segmentText: { fontSize: 14, color: colors.text },
    segmentTextSelected: { color: '#FFFFFF', fontWeight: '600' },
    input: {
      borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
      fontSize: 15, color: colors.text, backgroundColor: colors.card,
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
  });
}

/** `{ colors, styles }` for the system's current light/dark setting. */
export function useTheme() {
  const scheme = useColorScheme();
  const colors = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const styles = useMemo(() => buildStyles(colors), [colors]);
  return { colors, styles };
}

export function Card({ children, style }) {
  const { styles } = useTheme();
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({ title, onPress, kind = 'primary', disabled, small }) {
  const { colors, styles } = useTheme();
  const bg = kind === 'danger' ? colors.danger : kind === 'secondary' ? colors.card : colors.accent;
  const fg = kind === 'secondary' ? colors.accent : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        kind === 'secondary' && styles.buttonOutline,
      ]}
    >
      <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Segmented({ options, value, onChange, disabled }) {
  const { styles } = useTheme();
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={[styles.segment, selected && styles.segmentSelected, disabled && { opacity: 0.5 }]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function formatAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

