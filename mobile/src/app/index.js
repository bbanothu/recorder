import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { CLIP_CHOICES, WINDOW_CHOICES } from '../core/chunks.js';
import { useRecorder } from '../native/RecorderContext.js';
import { Button, Card, formatAgo, Segmented, useTheme } from '../native/ui.js';

const LONG_RECORDING_MS = 3 * 3_600_000;

export default function Home() {
  const r = useRecorder();
  const { colors, styles } = useTheme();
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [, tick] = useState(0);

  // Refresh the "since" / "ago" labels.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (!r.ready) {
    return (
      <View style={[styles.screen, { justifyContent: 'center' }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const run = async (label, fn) => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const onClip = (preset) =>
    run('clip', async () => {
      const id = await r.clip(preset);
      router.push(`/clips/${id}`);
    });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {!r.configured && (
        <Card>
          <Text style={styles.h2}>Transcription is optional</Text>
          <Text style={styles.muted}>
            Recording and clipping work on the phone alone. Set a server URL and token in Settings only if you also want
            clips transcribed there.
          </Text>
          <Link href="/settings" asChild>
            <Button title="Open settings" />
          </Link>
        </Card>
      )}

      {r.recording && Date.now() - r.since > LONG_RECORDING_MS && (
        <Card>
          <Text style={styles.h2}>Still listening</Text>
          <Text style={styles.muted}>
            You've been recording for {Math.round((Date.now() - r.since) / 3_600_000)}+ hours. Clip what you want to keep,
            then stop — older audio outside your window is deleted either way.
          </Text>
        </Card>
      )}

      <Card>
        <View style={[styles.row, { alignItems: 'center' }]}>
          <View style={[styles.dot, { backgroundColor: r.recording ? colors.danger : colors.line }]} />
          <Text style={styles.h1}>{r.recording ? 'Listening' : 'Not recording'}</Text>
        </View>
        {r.recording && <Text style={styles.muted}>Since {new Date(r.since).toLocaleTimeString()} · keep this screen open (background recording comes next)</Text>}
        <Text style={styles.muted}>
          {r.pending} minute{r.pending === 1 ? '' : 's'} waiting to upload
          {r.lastUpload
            ? r.lastUpload.error
              ? ` · last upload failed ${formatAgo(r.lastUpload.at)}`
              : ` · last upload ${formatAgo(r.lastUpload.at)} (${r.lastUpload.sent})`
            : ''}
        </Text>
        {r.recording ? (
          <Button title="Stop" kind="danger" onPress={() => run('stop', r.stop)} disabled={!!busy} />
        ) : (
          <Button title="Start listening" onPress={() => run('start', r.start)} disabled={!!busy} />
        )}
      </Card>

      <Card>
        <Text style={styles.h2}>Keep the last</Text>
        <Segmented
          options={WINDOW_CHOICES.map((w) => ({ value: w.minutes, label: w.label }))}
          value={r.windowMinutes}
          onChange={(minutes) => run('window', () => r.updateSettings({ windowMinutes: minutes }))}
          disabled={!!busy}
        />
        <Text style={styles.muted}>Older audio and transcripts are deleted on the phone and the server unless you clip them.</Text>
      </Card>

      <Card>
        <Text style={styles.h2}>Clip</Text>
        <Text style={styles.muted}>Save what was just heard, right on the phone.</Text>
        <View style={styles.row}>
          {CLIP_CHOICES.map((c) => (
            <Button key={String(c.value)} small kind="secondary" title={c.label} onPress={() => onClip(c.value)} disabled={!!busy} />
          ))}
        </View>
        {busy === 'clip' && <Text style={styles.muted}>Saving…</Text>}
      </Card>

      <View style={styles.row}>
        <Button small kind="secondary" title="Upload now" onPress={() => run('upload', r.uploadNow)} disabled={!r.configured || !!busy} />
        <Link href="/clips" asChild>
          <Button small kind="secondary" title="Saved clips" />
        </Link>
        <Link href="/settings" asChild>
          <Button small kind="secondary" title="Settings" />
        </Link>
      </View>

      {(message || r.error || r.lastUpload?.error) && (
        <Card>
          {message && <Text style={styles.error}>{message}</Text>}
          {r.error && <Text style={styles.error}>{r.error}</Text>}
          {r.lastUpload?.error && <Text style={styles.error}>Upload: {r.lastUpload.error}</Text>}
        </Card>
      )}

      <Text style={styles.muted}>
        Recording a conversation without everyone's consent is illegal in some places (for example California and
        other two-party-consent states). Audio is only sent to your own server.
      </Text>
    </ScrollView>
  );
}
