import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, api } from '@/lib/api';
import type { Page } from '@/types';
import { colors, radius, spacing } from '@/theme';

type Status = 'saved' | 'saving' | 'unsaved' | 'conflict' | 'error';

export default function PageEditor() {
  const { spaceId, pageId } = useLocalSearchParams<{
    spaceId: string;
    pageId: string;
  }>();
  const router = useRouter();
  const [page, setPage] = useState<Page | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('saved');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const loaded = await api<Page>(
          `/spaces/${spaceId}/pages/${pageId}`,
        );
        if (!active) return;
        setPage(loaded);
        revisionRef.current = loaded.revision;
        setTitle(loaded.title);
        setContent(loaded.content);
        dirtyRef.current = false;
        setStatus('saved');
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load page.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [spaceId, pageId]);

  const save = async (nextTitle: string, nextContent: string) => {
    if (!dirtyRef.current) return;
    setStatus('saving');
    try {
      const updated = await api<Page>(
        `/spaces/${spaceId}/pages/${pageId}`,
        'PATCH',
        {
          title: nextTitle,
          content: nextContent,
          expectedRevision: revisionRef.current,
        },
      );
      revisionRef.current = updated.revision;
      dirtyRef.current = false;
      setStatus('saved');
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setStatus('conflict');
        Alert.alert(
          'Conflict',
          'This page changed elsewhere. Reload and replace your draft?',
          [
            {
              text: 'Reload',
              style: 'destructive',
              onPress: () => {
                (async () => {
                  try {
                    const latest = await api<Page>(
                      `/spaces/${spaceId}/pages/${pageId}`,
                    );
                    revisionRef.current = latest.revision;
                    setTitle(latest.title);
                    setContent(latest.content);
                    dirtyRef.current = false;
                    setStatus('saved');
                  } catch {
                    setStatus('error');
                  }
                })();
              },
            },
            { text: 'Keep editing', style: 'cancel' },
          ],
        );
        return;
      }
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  const onEdit = (patch: { title?: string; content?: string }) => {
    dirtyRef.current = true;
    setStatus('unsaved');
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.content !== undefined) setContent(patch.content);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void save(patch.title ?? title, patch.content ?? content),
      800,
    );
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  if (loading)
    return (
      <View style={[styles.center, styles.screen]}>
        <Text style={styles.muted}>Loading page…</Text>
      </View>
    );

  const statusLabel: Record<Status, string> = {
    saved: 'All changes saved',
    saving: 'Saving…',
    unsaved: 'Unsaved changes',
    conflict: 'Changes need review',
    error: 'Could not save',
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.topbar}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text
          style={[
            styles.status,
            status === 'conflict' && styles.conflict,
            status === 'error' && styles.conflict,
          ]}
        >
          {statusLabel[status]}
        </Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.editor}>
        <TextInput
          style={styles.titleInput}
          placeholder="Untitled page"
          placeholderTextColor={colors.muted}
          value={title}
          maxLength={160}
          onChangeText={(t) => onEdit({ title: t })}
        />
        <TextInput
          style={styles.contentInput}
          placeholder="Start writing…"
          placeholderTextColor={colors.muted}
          multiline
          textAlignVertical="top"
          value={content}
          onChangeText={(c) => onEdit({ content: c })}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  status: { color: colors.muted, fontSize: 12 },
  conflict: { color: colors.danger },
  error: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  editor: { padding: spacing.lg, gap: spacing.md },
  titleInput: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    padding: 0,
  },
  contentInput: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minHeight: 400,
    padding: 0,
  },
  muted: { color: colors.muted },
});
