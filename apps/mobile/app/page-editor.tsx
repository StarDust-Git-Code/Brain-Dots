import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { pageKey, pagesKey } from '@/lib/cache';
import { useDrafts, useOffline } from '@/lib/offline-context';
import type { Page } from '@/types';
import { colors, radius, spacing } from '@/theme';

export default function PageEditorRoute() {
  const { user, loading } = useAuth();
  const params = useLocalSearchParams<{ spaceId?: string; pageId?: string }>();
  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
  if (!user) return <Redirect href="/login" />;
  if (typeof params.spaceId !== 'string' || typeof params.pageId !== 'string')
    return <Redirect href="/(tabs)/pages" />;
  return <PageEditor key={`${user.uid}:${params.spaceId}:${params.pageId}`} uid={user.uid} spaceId={params.spaceId} pageId={params.pageId} />;
}

function PageEditor({ uid, spaceId, pageId }: { uid: string; spaceId: string; pageId: string }) {
  const router = useRouter();
  const { cache, queue, online } = useOffline();
  const snapshot = useDrafts();
  const key = pageKey(spaceId, pageId);
  const draft = snapshot.drafts[key];
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [reload, setReload] = useState(0);
  const [resolving, setResolving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // The provider's queue outlives this screen; leaving never drops a draft.
      void queue?.flush().catch(() => {});
    };
  }, [queue]);

  useEffect(() => {
    if (!queue || !cache) return;
    let active = true;
    const load = async () => {
      setLoadError('');
      try {
        await queue.ready();
        if (!active) return;
        if (!queue.getSnapshot().drafts[key]) {
          const cached = await cache.read<Page>(key) ??
            (await cache.read<Page[]>(pagesKey(spaceId)))?.find((page) => page.id === pageId);
          if (active && cached) await queue.open(cached);
        }
        if (!active) return;
        if (queue.getSnapshot().drafts[key]) setLoading(false);
        if (online) {
          const page = await api<Page>(`/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`, 'GET', undefined, { uid });
          if (!active) return;
          await cache.write(key, page);
          if (active) await queue.open(page); // Never overwrites a pending draft.
        } else if (!queue.getSnapshot().drafts[key]) {
          setLoadError('Offline. Open this page once online to download it.');
        }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load this page.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [queue, cache, key, spaceId, pageId, uid, online, reload]);

  const edit = (patch: { title?: string; content?: string }) => {
    if (!queue || resolving) return;
    setActionError('');
    // edit() updates the queue synchronously and persists every generation,
    // independently of the network debounce and React render closures.
    void queue.edit(key, patch).catch((error: unknown) => {
      if (mounted.current) setActionError(error instanceof Error ? error.message : 'Could not store the draft.');
    });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void queue.flush().catch(() => {}); }, 800);
  };

  const resolve = async (choice: 'keep-draft' | 'use-server') => {
    if (!queue || resolving) return;
    setResolving(true);
    setActionError('');
    try {
      await queue.resolve(key, choice);
      if (choice === 'keep-draft') await queue.flush();
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : 'Review failed. Your draft is retained.');
    } finally {
      if (mounted.current) setResolving(false);
    }
  };

  const review = (choice: 'keep-draft' | 'use-server') => {
    Alert.alert(
      choice === 'keep-draft' ? 'Save your draft?' : 'Reload the server version?',
      choice === 'keep-draft'
        ? 'Your draft will replace the latest server content using its revision. Any newer server change will raise another conflict.'
        : 'This replaces your local draft with the latest server version.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: choice === 'keep-draft' ? 'Save my draft' : 'Reload server', style: choice === 'use-server' ? 'destructive' : 'default', onPress: () => void resolve(choice) },
      ],
    );
  };

  const status = draft?.status ?? 'saved';
  const statusLabel = {
    saved: online ? 'All changes saved' : 'Saved · offline',
    saving: 'Saving…',
    unsaved: online ? 'Changes queued' : 'Draft queued offline',
    error: 'Draft retained · retry',
    conflict: 'Changes need review',
  }[status];
  const error = snapshot.storageError || actionError || draft?.error || loadError;

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.topbar}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/pages')}><Text style={styles.back}>‹ Back</Text></Pressable>
          <Text style={[styles.status, (status === 'conflict' || status === 'error') && styles.conflict]}>{statusLabel}</Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!online && draft ? <Text style={styles.note}>Editing a downloaded copy. Drafts are stored on this device and replayed on reconnect.</Text> : null}
        {(status === 'error' || status === 'unsaved') && online ? (
          <Pressable style={styles.retry} onPress={() => void queue?.flush().catch(() => {})}><Text style={styles.back}>Retry save</Text></Pressable>
        ) : null}
        {status === 'conflict' ? (
          <View style={styles.review}>
            <Text style={styles.reviewTitle}>Your draft is retained</Text>
            {draft.conflict ? <Text style={styles.note}>Server revision {draft.conflict.revision}: {draft.conflict.title}{'\n'}{draft.conflict.content.slice(0, 400)}</Text> : null}
            <View style={styles.actions}>
              <Pressable disabled={!online || resolving} onPress={() => review('use-server')}><Text style={styles.back}>Reload server</Text></Pressable>
              <Pressable disabled={!online || resolving} onPress={() => review('keep-draft')}><Text style={styles.back}>{resolving ? 'Reviewing…' : 'Save my draft'}</Text></Pressable>
            </View>
          </View>
        ) : null}
        {loading ? <View style={styles.center}><ActivityIndicator color={colors.accent} /></View> : !draft ? (
          <View style={styles.center}>
            <Text style={styles.note}>Page not available on this device.</Text>
            <Pressable onPress={() => { setLoading(true); setReload((value) => value + 1); }}><Text style={styles.back}>Retry loading</Text></Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.editor} keyboardShouldPersistTaps="handled">
            <TextInput style={styles.titleInput} placeholder="Untitled page" placeholderTextColor={colors.muted} value={draft.title} maxLength={160} editable={!resolving} onChangeText={(title) => edit({ title })} />
            <TextInput style={styles.contentInput} placeholder="Start writing…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" value={draft.content} editable={!resolving} onChangeText={(content) => edit({ content })} />
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  status: { color: colors.muted, fontSize: 12 },
  conflict: { color: colors.danger },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  retry: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  review: { backgroundColor: colors.panel, margin: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingVertical: spacing.md, gap: spacing.sm },
  reviewTitle: { color: colors.text, fontWeight: '600', paddingHorizontal: spacing.lg },
  actions: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.lg, gap: spacing.md },
  editor: { padding: spacing.lg, gap: spacing.md },
  titleInput: { color: colors.text, fontSize: 24, fontWeight: '800', padding: 0 },
  contentInput: { color: colors.text, fontSize: 15, lineHeight: 22, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', minHeight: 400, padding: 0 },
});
