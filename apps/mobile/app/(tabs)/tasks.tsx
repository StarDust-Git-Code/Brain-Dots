import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import type { Task } from '@/types';
import { colors, radius, spacing, statusColor } from '@/theme';

const INTERVALS: { label: string; value: number | null }[] = [
  { label: 'Off', value: null },
  { label: '5m', value: 300 },
  { label: '15m', value: 900 },
  { label: '1h', value: 3600 },
  { label: '1d', value: 86400 },
];

export default function TasksScreen() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [interval, setIntervalValue] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const activeRef = useRef(false);

  const load = useCallback(async () => {
    const list = await api<Task[]>('/tasks');
    setTasks(list);
  }, []);

  useEffect(() => {
    let active = true;
    load()
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load tasks.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    activeRef.current = tasks.some(
      (t) => t.status === 'queued' || t.status === 'running',
    );
    if (!activeRef.current) return;
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [tasks, load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  };

  const create = async () => {
    const text = prompt.trim();
    if (text.length < 3 || creating) return;
    setCreating(true);
    setError('');
    try {
      await api('/tasks', 'POST', { prompt: text, intervalSeconds: interval });
      setPrompt('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create task.');
    } finally {
      setCreating(false);
    }
  };

  if (loading)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );

  return (
    <View style={styles.screen}>
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
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="What should your dot do?"
            placeholderTextColor={colors.muted}
            multiline
            maxLength={4000}
            value={prompt}
            onChangeText={setPrompt}
          />
          <View style={styles.intervalRow}>
            {INTERVALS.map((opt) => (
              <Pressable
                key={opt.label}
                style={[
                 styles.chip,
                  interval === opt.value && styles.chipActive,
                ]}
                onPress={() => setIntervalValue(opt.value)}
              >
                <Text
                  style={[
                    styles.chipText,
                    interval === opt.value && styles.chipTextActive,
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              style={[styles.createBtn, creating && styles.disabled]}
              disabled={creating || prompt.trim().length < 3}
              onPress={() => void create()}
            >
              <Text style={styles.createText}>Run</Text>
            </Pressable>
          </View>
        </View>
        {tasks.map((task) => (
          <Pressable
            key={task.id}
            style={styles.row}
            onPress={() =>
              setExpanded((prev) => (prev === task.id ? null : task.id))
            }
          >
            <View style={styles.rowHeader}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: statusColor[task.status] ?? colors.muted },
                ]}
              />
              <Text style={styles.status}>{task.status}</Text>
              <Text style={styles.time}>
                {new Date(task.createdAt).toLocaleString()}
              </Text>
            </View>
            <Text style={styles.prompt} numberOfLines={expanded === task.id ? undefined : 2}>
              {task.prompt}
            </Text>
            {task.error ? (
              <Text style={styles.taskError} numberOfLines={2}>
                {task.error}
              </Text>
            ) : null}
            {expanded === task.id && (
              <View style={styles.detail}>
                {task.result?.text ? (
                  <Text style={styles.result}>{task.result.text}</Text>
                ) : (
                  <Text style={styles.muted}>No result yet.</Text>
                )}
                {task.nextRunAt ? (
                  <Text style={styles.muted}>
                    Next run: {new Date(task.nextRunAt).toLocaleString()}
                  </Text>
                ) : null}
              </View>
            )}
          </Pressable>
        ))}
        {!tasks.length && (
          <Text style={[styles.muted, styles.empty]}>
            No tasks yet. Schedule your first one above.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  list: { padding: spacing.lg, gap: spacing.sm },
  form: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  input: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 64,
    textAlignVertical: 'top',
  },
  intervalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chip: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  createBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
    marginLeft: 'auto',
  },
  createText: { color: colors.bg, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  row: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  status: { color: colors.muted, fontSize: 12, textTransform: 'uppercase' },
  time: { color: colors.muted, fontSize: 12, marginLeft: 'auto' },
  prompt: { color: colors.text, lineHeight: 19 },
  taskError: { color: colors.danger, fontSize: 12 },
  detail: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  result: { color: colors.text, lineHeight: 19 },
  muted: { color: colors.muted, fontSize: 12 },
  empty: { textAlign: 'center', marginTop: spacing.xl },
});
