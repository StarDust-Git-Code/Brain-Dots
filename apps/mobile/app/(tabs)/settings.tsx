import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { API_BASE_URL, FIREBASE_CONFIG } from '@/config';
import { useAuth } from '@/lib/auth-context';
import { signOutUser } from '@/lib/firebase';
import { useDrafts, useOffline } from '@/lib/offline-context';
import { colors, radius, spacing } from '@/theme';

export default function SettingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { online, queue } = useOffline();
  const { drafts, storageError } = useDrafts();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const pending = Object.values(drafts).filter((draft) => draft.status !== 'saved');

  const logout = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await queue?.storePending();
      await signOutUser();
      router.replace('/login');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not sign out.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Settings</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Signed in</Text>
        <Text style={styles.text}>{user?.email ?? 'Firebase account'}</Text>
        <Pressable style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => void logout()}>
          {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.buttonText}>Sign out</Text>}
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Offline & sync</Text>
        <Text style={styles.text}>{online ? 'Connected' : 'Offline'} · {pending.length} pending page {pending.length === 1 ? 'draft' : 'drafts'}</Text>
        <Text style={styles.note}>Downloaded spaces, pages and tasks are cached on this device. Page drafts are retained under your account when you leave the editor or sign out.</Text>
        {storageError ? <Text style={styles.error}>{storageError}</Text> : null}
        <Pressable disabled={!online} onPress={() => void queue?.flush().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Sync failed.'))}>
          <Text style={styles.link}>Sync pending saves</Text>
        </Pressable>
        {pending.map((draft) => (
          <Pressable key={`${draft.base.spaceId}:${draft.base.id}`} style={styles.draft} onPress={() => router.push({ pathname: '/page-editor', params: { spaceId: draft.base.spaceId, pageId: draft.base.id } })}>
            <Text style={styles.text} numberOfLines={1}>{draft.title || 'Untitled page'}</Text>
            <Text style={draft.status === 'conflict' || draft.status === 'error' ? styles.error : styles.note}>{draft.status === 'conflict' ? 'Needs review' : draft.status}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Brain-Dots · Expo SDK 51</Text>
        <Text style={styles.note}>Shared backend: {API_BASE_URL}</Text>
        <Text style={styles.note}>Firebase project: {FIREBASE_CONFIG.projectId}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800' },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.lg, gap: spacing.md },
  label: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  text: { color: colors.text, fontSize: 15 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 12 },
  link: { color: colors.accent, fontWeight: '600' },
  button: { backgroundColor: colors.accent, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center' },
  buttonText: { color: colors.bg, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  draft: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md, gap: spacing.xs },
});
