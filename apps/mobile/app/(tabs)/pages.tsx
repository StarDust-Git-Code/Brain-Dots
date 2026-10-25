import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { pageKey, pagesKey } from '@/lib/cache';
import { useDrafts, useOffline } from '@/lib/offline-context';
import { useCachedResource } from '@/lib/use-cached-resource';
import type { Page, Space } from '@/types';
import { colors, radius, spacing } from '@/theme';

export default function PagesScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { cache, queue, online } = useOffline();
  const { drafts } = useDrafts();
  const spacesResource = useCachedResource<Space[]>('/spaces', 'spaces');
  const spaces = spacesResource.data ?? [];
  const [selectedSpace, setSelectedSpace] = useState('');
  const spaceId = spaces.some((space) => space.id === selectedSpace) ? selectedSpace : spaces[0]?.id ?? '';
  const pagesResource = useCachedResource<Page[]>(
    spaceId ? `/spaces/${encodeURIComponent(spaceId)}/pages` : null,
    spaceId ? pagesKey(spaceId) : null,
  );
  const [showSpaceForm, setShowSpaceForm] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [actionError, setActionError] = useState('');

  const pages = useMemo(() => {
    const list = new Map((pagesResource.data ?? []).map((page) => [page.id, page]));
    for (const draft of Object.values(drafts)) {
      if (draft.base.spaceId !== spaceId) continue;
      const previous = list.get(draft.base.id);
      if (previous && (draft.status !== 'saved' || draft.base.revision >= previous.revision)) {
        list.set(draft.base.id, { ...draft.base, title: draft.title, content: draft.content });
      } else if (!previous && (pagesResource.data === null || draft.status !== 'saved')) {
        list.set(draft.base.id, { ...draft.base, title: draft.title, content: draft.content });
      }
    }
    return [...list.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [pagesResource.data, drafts, spaceId]);

  const createSpace = async () => {
    const name = spaceName.trim();
    if (!name || !user || !cache || !online || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setActionError('');
    try {
      const space = await api<Space>('/spaces', 'POST', { name, description: '' }, { uid: user.uid });
      setSpaceName('');
      setShowSpaceForm(false);
      setSelectedSpace(space.id);
      try { await cache.update<Space[]>('spaces', (list) => [space, ...(list ?? [])]); }
      catch { setActionError('Space created; could not update the device cache.'); }
      await spacesResource.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create space.');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const createPage = async () => {
    if (!spaceId || !user || !cache || !queue || !online || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setActionError('');
    const capturedSpace = spaceId;
    try {
      const page = await api<Page>(`/spaces/${encodeURIComponent(capturedSpace)}/pages`, 'POST', {
        title: 'Untitled page', content: '', parentId: null,
      }, { uid: user.uid });
      try {
        await cache.write(pageKey(capturedSpace, page.id), page);
        await cache.update<Page[]>(pagesKey(capturedSpace), (list) => [page, ...(list ?? [])]);
        await queue.open(page);
      } catch { setActionError('Page created; could not update the device cache.'); }
      router.push({ pathname: '/page-editor', params: { spaceId: capturedSpace, pageId: page.id } });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create page.');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const error = actionError || spacesResource.error || pagesResource.error;
  const refresh = async () => {
    setActionError('');
    await Promise.all([spacesResource.refresh(), pagesResource.refresh()]);
  };

  if (spacesResource.loading) return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.heading}>Pages</Text>
        <Pressable disabled={!online || creating} onPress={() => setShowSpaceForm((show) => !show)}><Text style={styles.link}>＋ Space</Text></Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.spaceRow} contentContainerStyle={styles.rowContent}>
        {spaces.map((space) => (
          <Pressable key={space.id} disabled={creating} style={[styles.chip, spaceId === space.id && styles.chipActive]} onPress={() => { setSelectedSpace(space.id); setActionError(''); }}>
            <Text style={[styles.chipText, spaceId === space.id && styles.chipTextActive]}>{space.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {showSpaceForm ? (
        <View style={styles.spaceForm}>
          <TextInput style={styles.input} placeholder="Space name" placeholderTextColor={colors.muted} value={spaceName} onChangeText={setSpaceName} maxLength={120} editable={!creating} />
          <Pressable disabled={creating || !spaceName.trim() || !online} onPress={() => void createSpace()}><Text style={styles.link}>{creating ? 'Creating…' : 'Create'}</Text></Pressable>
        </View>
      ) : null}
      {!online || spacesResource.fromCache || pagesResource.fromCache ? <Text style={styles.note}>{online ? 'Showing a downloaded copy' : 'Offline · downloaded pages and local drafts'}</Text> : null}
      {error ? <View style={styles.errorRow}><Text style={styles.error}>{error}</Text><Pressable onPress={() => void refresh()}><Text style={styles.link}>Retry</Text></Pressable></View> : null}
      <ScrollView contentContainerStyle={styles.list} refreshControl={<RefreshControl refreshing={spacesResource.refreshing || pagesResource.refreshing} onRefresh={() => void refresh()} tintColor={colors.accent} />}>
        {pagesResource.loading ? <ActivityIndicator color={colors.accent} /> : null}
        {pages.map((page) => {
          const draft = drafts[pageKey(spaceId, page.id)];
          return (
            <Pressable key={page.id} style={styles.row} onPress={() => router.push({ pathname: '/page-editor', params: { spaceId, pageId: page.id } })}>
              <Text style={styles.rowTitle} numberOfLines={1}>{page.title || 'Untitled page'}</Text>
              <Text style={styles.rowMeta}>{new Date(page.updatedAt).toLocaleDateString()} · rev {page.revision}</Text>
              {draft && draft.status !== 'saved' ? <Text style={draft.status === 'conflict' || draft.status === 'error' ? styles.error : styles.link}>{draft.status === 'conflict' ? 'Draft needs review' : draft.status === 'saving' ? 'Saving draft…' : 'Draft retained on device'}</Text> : null}
            </Pressable>
          );
        })}
        {!pages.length && !pagesResource.loading ? <Text style={[styles.muted, styles.empty]}>{spaces.length ? 'No pages in this space yet.' : 'Create a space to start collecting pages.'}</Text> : null}
      </ScrollView>
      <Pressable style={[styles.fab, (!spaceId || !online || creating) && styles.disabled]} disabled={!spaceId || !online || creating} onPress={() => void createPage()}>
        <Text style={styles.fabText}>{creating ? 'Creating…' : '＋ New page'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.lg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800' },
  link: { color: colors.accent, fontWeight: '600', fontSize: 12 },
  spaceRow: { maxHeight: 44 },
  rowContent: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  chip: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  spaceForm: { margin: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  input: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.panel, color: colors.text, padding: spacing.md },
  errorRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
  error: { color: colors.danger, fontSize: 12 },
  note: { color: colors.muted, fontSize: 12, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  list: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  row: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  rowTitle: { color: colors.text, fontWeight: '600', fontSize: 15 },
  rowMeta: { color: colors.muted, fontSize: 12 },
  empty: { textAlign: 'center', marginTop: spacing.xl },
  fab: { backgroundColor: colors.accent, margin: spacing.lg, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  fabText: { color: colors.bg, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  muted: { color: colors.muted },
});
