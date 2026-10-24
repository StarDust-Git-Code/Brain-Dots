import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import type { Page, Space } from '@/types';
import { colors, radius, spacing } from '@/theme';

export default function PagesScreen() {
  const router = useRouter();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadSpaces = useCallback(async () => {
    const list = await api<Space[]>('/spaces');
    setSpaces(list);
    setSpaceId((prev) => prev || list[0]?.id || '');
  }, []);

  const loadPages = useCallback(async (id: string) => {
    if (!id) return [];
    return api<Page[]>(`/spaces/${id}/pages`);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadSpaces();
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load spaces.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadSpaces]);

  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    loadPages(spaceId)
      .then((list) => {
        if (active) setPages(list);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load pages.');
      });
    return () => {
      active = false;
    };
  }, [spaceId, loadPages]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadSpaces();
      if (spaceId) setPages(await loadPages(spaceId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  };

  const createPage = async () => {
    if (!spaceId) return;
    try {
      const page = await api<Page>(`/spaces/${spaceId}/pages`, 'POST', {
        title: 'Untitled page',
        content: '',
        parentId: null,
      });
      router.push({
        pathname: '/page-editor',
        params: { spaceId, pageId: page.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create page.');
    }
  };

  if (loading)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );

  if (!spaces.length)
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>
          No spaces yet. Create one in the web app first.
        </Text>
      </View>
    );

  return (
    <View style={styles.screen}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.spaceRow}
        contentContainerStyle={styles.rowContent}
      >
        {spaces.map((space) => (
          <Pressable
            key={space.id}
            style={[styles.chip, spaceId === space.id && styles.chipActive]}
            onPress={() => setSpaceId(space.id)}
          >
            <Text
              style={[
                styles.chipText,
                spaceId === space.id && styles.chipTextActive,
              ]}
            >
              {space.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.accent}
          />
        }
      >
        {pages.map((page) => (
          <Pressable
            key={page.id}
            style={styles.row}
            onPress={() =>
              router.push({
                pathname: '/page-editor',
                params: { spaceId, pageId: page.id },
              })
            }
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {page.title}
            </Text>
            <Text style={styles.rowMeta}>
              {new Date(page.updatedAt).toLocaleDateString()} · rev{' '}
              {page.revision}
            </Text>
          </Pressable>
        ))}
        {!pages.length && (
          <Text style={[styles.muted, styles.empty]}>
            No pages in this space yet.
          </Text>
        )}
      </ScrollView>
      <Pressable style={styles.fab} onPress={() => void createPage()}>
        <Text style={styles.fabText}>＋ New page</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  spaceRow: { maxHeight: 52, marginTop: spacing.sm },
  rowContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  chip: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  error: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  list: { padding: spacing.lg, gap: spacing.sm },
  row: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowTitle: { color: colors.text, fontWeight: '600', fontSize: 15 },
  rowMeta: { color: colors.muted, fontSize: 12 },
  empty: { textAlign: 'center', marginTop: spacing.xl },
  fab: {
    backgroundColor: colors.accent,
    margin: spacing.lg,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  fabText: { color: colors.bg, fontWeight: '700' },
  muted: { color: colors.muted },
});
