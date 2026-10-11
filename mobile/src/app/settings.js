import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { createApi } from '../core/api.js';
import { normalizeSettings } from '../core/settings.js';
import { useRecorder } from '../native/RecorderContext.js';
import { Button, Card, Segmented, useTheme } from '../native/ui.js';

const TRANSCRIBE_CHOICES = [
  { value: false, label: 'On server' },
  { value: true, label: 'Locally' },
];

export default function Settings() {
  const r = useRecorder();
  const { colors, styles } = useTheme();
  const [form, setForm] = useState({ serverUrl: '', token: '', deviceId: '' });
  const [errors, setErrors] = useState([]);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (r.settings) {
      setForm({ serverUrl: r.settings.serverUrl ?? '', token: r.settings.token ?? '', deviceId: r.settings.deviceId ?? '' });
    }
  }, [r.settings]);

  const field = (key, label, extra) => (
    <>
      <Text style={styles.h2}>{label}</Text>
      <TextInput
        style={styles.input}
        value={form[key]}
        onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
        autoCapitalize="none"
        autoCorrect={false}
        {...extra}
      />
    </>
  );

  const check = () => {
    const res = normalizeSettings(form);
    setErrors(res.ok ? [] : res.errors);
    return res;
  };

  const test = async () => {
    const res = check();
    if (!res.ok) return;
    setStatus('Checking…');
    try {
      const h = await createApi(res.settings).health();
      setStatus(`Connected to phone-server v${h.version}`);
    } catch (err) {
      setStatus(`Could not reach the server: ${err?.message ?? err}`);
    }
  };

  const save = async () => {
    const res = check();
    if (!res.ok) return;
    await r.updateSettings(res.settings);
    router.back();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={styles.h2}>Transcribe locally</Text>
        <Segmented
          options={TRANSCRIBE_CHOICES}
          value={r.transcribeLocally}
          onChange={(v) => r.updateSettings({ transcribeLocally: v })}
        />
        <Text style={styles.muted}>
          {r.transcribeLocally
            ? 'Clip stays on the phone — no server, no upload, no laptop dependency.'
            : 'Clip uses your server when one is set up below, falling back to the phone if it is not reachable.'}
        </Text>
        {r.transcribeLocally && !r.nativeTranscriptionAvailable && (
          <Text style={styles.error}>
            This build can't actually transcribe on-device yet (needs a dev-client build, not Expo Go) — clips will save
            audio only until then.
          </Text>
        )}
      </Card>

      <Card>
        <Text style={styles.muted}>Optional — clips are saved on the phone either way. Fill this in only if you also want them transcribed on your own machine.</Text>
        {field('serverUrl', 'Server URL', { placeholder: 'http://100.x.x.x:8787', keyboardType: 'url' })}
        <Text style={styles.muted}>Your machine's Tailscale address and PHONE_PORT. The phone needs Tailscale on too.</Text>
        {field('token', 'Token', { placeholder: 'PHONE_TOKEN from the server .env', secureTextEntry: true })}
        {field('deviceId', 'Device id')}
        <Text style={styles.muted}>Names this phone's folder on the server. Changing it starts a new history.</Text>
        {errors.map((e) => (
          <Text key={e} style={styles.error}>
            {e}
          </Text>
        ))}
        {status && <Text style={[styles.body, { color: status.startsWith('Connected') ? colors.ok : colors.danger }]}>{status}</Text>}
        <Button title="Test connection" kind="secondary" onPress={test} />
        <Button title="Save" onPress={save} />
      </Card>
    </ScrollView>
  );
}
