import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { deleteAllLocalClips, deleteLocalClip, listLocalClips, localClipSizes } from '../../native/local-clips';
import { formatBytes } from '../../core/format.js';
import { useRecorder } from '../../native/RecorderContext.js';
import { Button, Card, confirm, useTheme } from '../../native/ui.js';

const time = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function Clips() {
  const r = useRecorder();
  const { colors, styles } = useTheme();
  const [clips, setClips] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const local = listLocalClips().map((c) => {
        const { audioSizeBytes, textSizeBytes } = localClipSizes(c);
        return { ...c, routeId: `local-${c.id}`, state: 'local', sizeBytes: audioSizeBytes + textSizeBytes };
      });
      const server = r.api
        ? (await r.api.listClips()).clips.map((c) => ({
            ...c,
            routeId: String(c.id),
            sizeBytes: (c.mdSizeBytes ?? 0) + (c.audioSizeBytes ?? 0),
          }))
        : [];
      setClips([...local, ...server].sort((a, b) => b.fromMs - a.fromMs));
      setError(null);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [r.api]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const deleteOne = (item) =>
    confirm(`Delete the clip from ${time(item.fromMs)}? This can't be undone.`, async () => {
      setBusy(true);
      try {
        if (item.state === 'local') deleteLocalClip(item.id);
        else await r.api.deleteClip(item.id);
        setClips((cs) => cs.filter((c) => c.routeId !== item.routeId));
      } catch (err) {
        setError(err?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    });

  const deleteAll = () =>
    confirm(`Delete all ${clips.length} saved clip${clips.length === 1 ? '' : 's'}? This can't be undone.`, async () => {
      setBusy(true);
      try {
        deleteAllLocalClips();
        if (r.api) await r.api.deleteAllClips();
        setClips([]);
      } catch (err) {
        setError(err?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    });

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={clips}
      keyExtractor={(c) => c.routeId}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      ListHeaderComponent={
        clips.length > 0 ? <Button small kind="danger" title="Delete all" onPress={deleteAll} disabled={busy} /> : null
      }
      ListEmptyComponent={<Text style={styles.muted}>{error ?? 'No clips yet. Use a Clip button on the home screen.'}</Text>}
      renderItem={({ item }) => (
        <Card>
          <Pressable onPress={() => router.push(`/clips/${item.routeId}`)}>
            <Text style={styles.h2}>
              {time(item.fromMs)} → {new Date(item.toMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </Text>
            <View style={styles.row}>
              <Text style={styles.muted}>{Math.round((item.toMs - item.fromMs) / 60_000)} min</Text>
              <Text style={styles.muted}>{item.state === 'ready' ? 'Transcribed' : item.state === 'local' ? 'On this phone' : 'Transcribing…'}</Text>
              <Text style={styles.muted}>{formatBytes(item.sizeBytes)}</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => deleteOne(item)} disabled={busy} hitSlop={8}>
            <Text style={[styles.muted, { color: colors.danger, alignSelf: 'flex-start' }]}>Delete</Text>
          </Pressable>
        </Card>
      )}
    />
  );
}
