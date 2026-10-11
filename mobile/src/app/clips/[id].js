import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  getLocalClip,
  localClipFiles,
  localClipSizes,
} from '../../native/local-clips';
import { clipTranscriptFileName } from '../../core/local-transcript.js';
import { formatBytes } from '../../core/format.js';
import {
  deleteLocalClipAudio,
  deleteLocalClipTranscript,
  downloadModel,
  getClipTranscript,
  hasModel,
  nativeTranscriptionAvailable,
  redoLocalClip,
  transcribeClip,
  updateLocalClipTranscript,
} from '../../native/ondevice-transcribe';
import { useRecorder } from '../../native/RecorderContext.js';
import { Button, Card, confirm, useTheme } from '../../native/ui.js';

const POLL_MS = 3000;
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Edit button + (when open) a multiline text box with Save/Cancel. Shared shape for local and server clips. */
function EditTranscript({ editing, setEditing, markdown, onSave, busy }) {
  const { styles } = useTheme();
  const [text, setText] = useState(markdown ?? '');

  if (!editing) {
    return <Button small kind="secondary" title="Edit" onPress={() => { setText(markdown ?? ''); setEditing(true); }} disabled={busy} />;
  }
  return (
    <>
      <TextInput
        style={[styles.input, { minHeight: 160, textAlignVertical: 'top' }]}
        value={text}
        onChangeText={setText}
        multiline
        autoCapitalize="sentences"
      />
      <View style={styles.row}>
        <Button
          small
          title="Save"
          onPress={async () => {
            await onSave(text);
            setEditing(false);
          }}
          disabled={busy}
        />
        <Button small kind="secondary" title="Cancel" onPress={() => setEditing(false)} disabled={busy} />
      </View>
    </>
  );
}

/** A server clip id is numeric; a local one is `local-<id>` (RecorderContext.clip()). */
function LocalClip({ id }) {
  const { styles } = useTheme();
  const [clip] = useState(() => getLocalClip(Number(id.slice('local-'.length))));
  const [transcript, setTranscript] = useState(null);
  const nativeReady = nativeTranscriptionAvailable();
  const [modelReady, setModelReady] = useState(hasModel);
  const [downloading, setDownloading] = useState(false);
  const [modelError, setModelError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [filesVersion, setFilesVersion] = useState(0); // bumped after deleteLocalClipAudio so the segment list re-reads the (now empty) folder
  const [editingText, setEditingText] = useState(false);
  const files = clip ? localClipFiles(clip) : [];
  const sizes = clip ? localClipSizes(clip) : { audioSizeBytes: 0, textSizeBytes: 0 };

  // Kick the queue (idempotent — already-done chunks are skipped) and poll
  // while anything is still pending, so relaunching after an app kill, or
  // just downloading the model after the clip was made, both resume here.
  useEffect(() => {
    if (!clip || !nativeReady || !modelReady) return undefined;
    let cancelled = false;
    let timer = null;
    transcribeClip(clip).catch((err) => !cancelled && setModelError(err?.message ?? String(err)));
    const poll = () => {
      const t = getClipTranscript(clip);
      if (cancelled) return;
      setTranscript(t);
      if (t.progress.done < t.progress.total) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, nativeReady, modelReady, filesVersion]);

  const getModel = async () => {
    setDownloading(true);
    setModelError(null);
    try {
      await downloadModel();
      setModelReady(true);
    } catch (err) {
      setModelError(err?.message ?? String(err));
    } finally {
      setDownloading(false);
    }
  };

  const saveEdit = async (text) => {
    updateLocalClipTranscript(clip, text);
    setTranscript((t) => ({ markdown: text, progress: t?.progress ?? { done: 0, total: 0 } }));
  };

  const redo = () =>
    confirm('Re-transcribe this clip from its audio? Any manual edit will be lost.', async () => {
      setBusy(true);
      setActionError(null);
      try {
        await redoLocalClip(clip);
        setTranscript(getClipTranscript(clip));
      } catch (err) {
        setActionError(err?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    }, { title: 'Redo transcription?', confirmLabel: 'Redo' });

  const deleteAudio = () =>
    confirm("Delete this clip's audio? The current transcript is kept, but can no longer be redone.", () => {
      deleteLocalClipAudio(clip);
      setTranscript(getClipTranscript(clip));
      setFilesVersion((v) => v + 1);
    }, { title: 'Delete audio?' });

  const deleteText = () =>
    confirm('Delete this transcript? The audio is kept — re-open the clip or tap Redo to transcribe it again.', () => {
      deleteLocalClipTranscript(clip);
      setTranscript(getClipTranscript(clip));
    }, { title: 'Delete transcript?' });

  const share = (uri, name) => Sharing.shareAsync(uri, { mimeType: 'audio/mp4', dialogTitle: name });

  if (!clip) return <Text style={styles.error}>Clip not found.</Text>;
  return (
    <>
      <Card>
        <Text style={styles.h2}>
          {time(clip.fromMs)} → {time(clip.toMs)}
        </Text>
        <Text style={styles.muted}>
          Saved on this phone. {files.length} minute{files.length === 1 ? '' : 's'} · audio {formatBytes(sizes.audioSizeBytes)} · text{' '}
          {formatBytes(sizes.textSizeBytes)}
        </Text>
      </Card>

      {!nativeReady ? (
        <Card>
          <Text style={styles.body}>
            On-device transcription isn't available in this build — it needs the native modules (a dev-client build). This
            clip's transcript comes from your server instead; find it under Saved clips.
          </Text>
        </Card>
      ) : !modelReady ? (
        <Card>
          <Text style={styles.body}>No local transcription model yet (~75 MB, downloaded once, used for every clip after).</Text>
          <Button title={downloading ? 'Downloading…' : 'Download model'} onPress={getModel} disabled={downloading} />
          {modelError && <Text style={styles.error}>{modelError}</Text>}
        </Card>
      ) : (
        <Card>
          {transcript && transcript.progress.done < transcript.progress.total && (
            <View style={[styles.row, { alignItems: 'center' }]}>
              <ActivityIndicator />
              <Text style={styles.muted}>
                Transcribing on this phone… {transcript.progress.done}/{transcript.progress.total}
              </Text>
            </View>
          )}
          {modelError && <Text style={styles.error}>{modelError}</Text>}
          {actionError && <Text style={styles.error}>{actionError}</Text>}
          {!editingText && (
            <Text selectable style={styles.body}>
              {transcript?.markdown || 'No transcript yet.'}
            </Text>
          )}
          <View style={styles.row}>
            <EditTranscript editing={editingText} setEditing={setEditingText} markdown={transcript?.markdown} onSave={saveEdit} busy={busy} />
            {!editingText && sizes.audioSizeBytes > 0 && <Button small kind="secondary" title="Redo" onPress={redo} disabled={busy} />}
            {!editingText && sizes.audioSizeBytes > 0 && <Button small kind="danger" title="Delete audio" onPress={deleteAudio} disabled={busy} />}
            {!editingText && transcript?.markdown && <Button small kind="danger" title="Delete text" onPress={deleteText} disabled={busy} />}
          </View>
        </Card>
      )}

      {files.map((f, i) => (
        <Card key={f.name}>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <Text style={styles.body}>
              Segment {i + 1} · {time(f.startedAt)} ({Math.round(f.durationMs / 1000)}s)
            </Text>
            <Button small kind="secondary" title="Share" onPress={() => share(f.uri, f.name)} />
          </View>
        </Card>
      ))}
    </>
  );
}

function ServerClip({ id }) {
  const r = useRecorder();
  const { styles } = useTheme();
  const [clip, setClip] = useState(null);
  const [error, setError] = useState(null);
  const [translated, setTranslated] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [editingText, setEditingText] = useState(false);

  const needsTranslation = clip?.state === 'ready' && clip.language && clip.language !== 'en' && clip.hasAudio;

  // Already translated in an earlier session: load it without a button tap —
  // the server just returns its cache, no Whisper rerun.
  useEffect(() => {
    if (clip?.translated && !translated) translate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.translated]);

  const translate = async () => {
    setTranslating(true);
    setTranslateError(null);
    try {
      const { translatedMarkdown } = await r.api.translateClip(id);
      setTranslated(translatedMarkdown);
    } catch (err) {
      setTranslateError(err?.message ?? String(err));
    } finally {
      setTranslating(false);
    }
  };

  // Poll until the server has transcribed every minute in the clip.
  useEffect(() => {
    if (!r.api) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const c = await r.api.getClip(id);
        if (cancelled) return;
        setClip(c);
        setError(null);
        if (c.state !== 'ready') timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message ?? String(err));
        timer = setTimeout(poll, POLL_MS * 2);
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [r.api, id]);

  const saveEdit = async (text) => {
    await r.api.updateClipMarkdown(id, text);
    setClip((c) => ({ ...c, markdown: text, mdSizeBytes: text.length }));
  };

  const redo = () =>
    confirm('Re-transcribe this clip from its audio? Any manual edit (and any translation) will be lost.', async () => {
      setBusy(true);
      setActionError(null);
      try {
        const { markdown, language } = await r.api.redoClip(id);
        setClip((c) => ({ ...c, markdown, language, translated: false }));
        setTranslated(null);
      } catch (err) {
        setActionError(err?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    }, { title: 'Redo transcription?', confirmLabel: 'Redo' });

  const deleteAudio = () =>
    confirm("Delete this clip's audio on the server? The current transcript is kept, but can no longer be redone or translated.", async () => {
      setBusy(true);
      setActionError(null);
      try {
        await r.api.deleteClipAudio(id);
        setClip((c) => ({ ...c, hasAudio: false, audioSizeBytes: 0 }));
      } catch (err) {
        setActionError(err?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    }, { title: 'Delete audio?' });

  const deleteText = () =>
    confirm('Delete this transcript on the server? The audio is kept — tap Redo to transcribe it again.', async () => {
      setBusy(true);
      setActionError(null);
      try {
        await r.api.deleteClipText(id);
        setClip((c) => ({ ...c, markdown: null, mdSizeBytes: 0, translated: false }));
        setTranslated(null);
      } catch (err) {
        setActionError(err?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    }, { title: 'Delete transcript?' });

  const share = async (markdown, suffix) => {
    const name = clipTranscriptFileName(clip.fromMs, clip.toMs).replace(/\.md$/, `${suffix}.md`);
    if (Platform.OS === 'web') {
      // No file system or share sheet in the browser: download the file.
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const file = new File(Paths.cache, name);
    file.create({ overwrite: true });
    file.write(markdown);
    await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: 'Share transcript' });
  };

  return (
    <>
      {error && <Text style={styles.error}>{error}</Text>}
      {!clip || clip.state !== 'ready' ? (
        <Card>
          <ActivityIndicator />
          <Text style={styles.muted}>Transcribing on your server… this takes about a minute per few minutes of audio.</Text>
        </Card>
      ) : (
        <>
          <Card>
            <Text style={styles.muted}>
              Audio {formatBytes(clip.audioSizeBytes)} · text {formatBytes(clip.mdSizeBytes)}
            </Text>
          </Card>

          {needsTranslation && (
            <Card>
              <Text style={styles.body}>This clip is in "{clip.language}". Translate it to English?</Text>
              <Button
                kind="secondary"
                title={translating ? 'Translating…' : translated ? 'Re-translate' : 'Convert to English'}
                onPress={translate}
                disabled={translating}
              />
              {translateError && <Text style={styles.error}>{translateError}</Text>}
            </Card>
          )}

          {translated && (
            <Card>
              <View style={[styles.row, { alignItems: 'center' }]}>
                <Text style={styles.h2}>English</Text>
                <Button small kind="secondary" title={Platform.OS === 'web' ? 'Download' : 'Share'} onPress={() => share(translated, '-en')} />
              </View>
              <Text selectable style={styles.body}>
                {translated}
              </Text>
            </Card>
          )}

          <Card>
            {translated && <Text style={styles.h2}>Original{clip.language ? ` (${clip.language})` : ''}</Text>}
            {actionError && <Text style={styles.error}>{actionError}</Text>}
            {!editingText && (
              <Text selectable style={styles.body}>
                {clip.markdown || 'No transcript.'}
              </Text>
            )}
            <View style={styles.row}>
              {!editingText && clip.markdown && (
                <Button
                  small={!!translated}
                  kind="secondary"
                  title={Platform.OS === 'web' ? 'Download transcript' : 'Share transcript'}
                  onPress={() => share(clip.markdown, '')}
                />
              )}
              <EditTranscript editing={editingText} setEditing={setEditingText} markdown={clip.markdown} onSave={saveEdit} busy={busy} />
              {!editingText && clip.hasAudio && <Button small kind="secondary" title="Redo" onPress={redo} disabled={busy} />}
              {!editingText && clip.hasAudio && <Button small kind="danger" title="Delete audio" onPress={deleteAudio} disabled={busy} />}
              {!editingText && clip.markdown && <Button small kind="danger" title="Delete text" onPress={deleteText} disabled={busy} />}
            </View>
          </Card>
        </>
      )}
    </>
  );
}

export default function ClipScreen() {
  const { id } = useLocalSearchParams();
  const { styles } = useTheme();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {id.startsWith('local-') ? <LocalClip id={id} /> : <ServerClip id={id} />}
    </ScrollView>
  );
}
