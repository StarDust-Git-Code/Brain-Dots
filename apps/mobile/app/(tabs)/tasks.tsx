import { useIsFocused } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useOffline } from '@/lib/offline-context';
import { useCachedResource } from '@/lib/use-cached-resource';
import type { Task, TaskDetail } from '@/types';
import { colors, radius, spacing, statusColor } from '@/theme';

const INTERVALS: { label: string; value: number | null }[] = [
  { label: 'Once', value: null }, { label: '5m', value: 300 },
  { label: '15m', value: 900 }, { label: '1h', value: 3600 }, { label: '1d', value: 86400 },
];

export default function TasksScreen() {
  const focused = useIsFocused();
  const { user } = useAuth();
  const { cache, online } = useOffline();
  const resource = useCachedResource<Task[]>('/tasks', 'tasks');
  const tasks = resource.data ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const detail = useCachedResource<TaskDetail>(expanded ? `/tasks/${encodeURIComponent(expanded)}` : null, expanded ? `task:${expanded}` : null);
  const [prompt, setPrompt] = useState('');
  const [interval, setIntervalValue] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const hasScheduled = tasks.some((task) => task.status === 'queued' || task.status === 'running' ||
    (task.nextRunAt !== null && task.status !== 'paused' && task.status !== 'cancelled'));

  useEffect(() => {
    if (!focused || !online || !hasScheduled) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void Promise.all([resource.refresh(), expanded ? detail.refresh() : Promise.resolve()])
        .finally(() => { inFlight = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [focused, online, hasScheduled, resource.refresh, detail.refresh, expanded]);

  const storeTask = async (task: Task) => {
    try {
      await cache?.update<Task[]>('tasks', (list) => {
        const previous = list ?? [];
        return previous.some((item) => item.id === task.id)
          ? previous.map((item) => item.id === task.id ? task : item)
          : [task, ...previous];
      });
      await cache?.update<TaskDetail>(`task:${task.id}`, (previous) => ({
        task, runs: previous?.runs ?? [], events: previous?.events ?? [],
      }));
    } catch { setActionError('Task updated online; could not update the device cache.'); }
  };

  const create = async () => {
    const text = prompt.trim();
    if (text.length < 3 || !online || !user || busyRef.current) return;
    busyRef.current = true;
    setCreating(true);
    setActionError('');
    try {
      // The backend resolves omitted dot/thread IDs to this user's defaults.
      const task = await api<Task>('/tasks', 'POST', { prompt: text, intervalSeconds: interval }, { uid: user.uid });
      setPrompt('');
      setExpanded(task.id);
      await storeTask(task);
      await resource.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create task.');
    } finally {
      busyRef.current = false;
      setCreating(false);
    }
  };

  const action = async (id: string, operation: 'run' | 'pause' | 'cancel') => {
    if (!online || !user || busyRef.current) return;
    busyRef.current = true;
    setActionBusy(id);
    setActionError('');
    try {
      const task = await api<Task>(`/tasks/${encodeURIComponent(id)}/actions`, 'POST', { action: operation }, { uid: user.uid });
      await storeTask(task);
      await Promise.all([resource.refresh(), detail.refresh()]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Task action failed.');
    } finally {
      busyRef.current = false;
      setActionBusy(null);
    }
  };

  const error = actionError || resource.error;
  if (resource.loading) return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;

  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>Tasks</Text>
      {!online || resource.fromCache ? <Text style={styles.note}>{online ? 'Showing downloaded tasks' : 'Offline · downloaded tasks and results'}</Text> : null}
      {error ? <View style={styles.errorRow}><Text style={styles.error}>{error}</Text><Pressable onPress={() => void resource.refresh()}><Text style={styles.link}>Retry</Text></Pressable></View> : null}
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={resource.refreshing} onRefresh={() => void resource.refresh()} tintColor={colors.accent} />}>
        <View style={styles.form}>
          <TextInput style={styles.input} placeholder="What should your dot do?" placeholderTextColor={colors.muted} multiline maxLength={4000} value={prompt} onChangeText={setPrompt} editable={!creating} />
          <Text style={styles.muted}>Repeat interval · your default Dot and chat</Text>
          <View style={styles.intervalRow}>
            {INTERVALS.map((option) => (
              <Pressable key={option.label} disabled={creating} style={[styles.chip, interval === option.value && styles.chipActive]} onPress={() => setIntervalValue(option.value)}>
                <Text style={[styles.chipText, interval === option.value && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            ))}
            <Pressable style={[styles.createBtn, (!online || creating || prompt.trim().length < 3) && styles.disabled]} disabled={!online || creating || prompt.trim().length < 3} onPress={() => void create()}><Text style={styles.createText}>{creating ? '…' : 'Run'}</Text></Pressable>
          </View>
        </View>
        {tasks.map((listedTask) => {
          const isExpanded = expanded === listedTask.id;
          const data = isExpanded && detail.data?.task.id === listedTask.id ? detail.data : null;
          const task = data && (data.task.updatedAt ?? 0) >= (listedTask.updatedAt ?? 0) ? data.task : listedTask;
          return (
            <View key={task.id} style={styles.row}>
              <Pressable onPress={() => setExpanded((previous) => previous === task.id ? null : task.id)}>
                <View style={styles.rowHeader}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor[task.status] ?? colors.muted }]} />
                  <Text style={styles.status}>{task.status}</Text>
                  <Text style={styles.time}>{new Date(task.createdAt).toLocaleString()}</Text>
                </View>
                <Text style={styles.prompt} numberOfLines={isExpanded ? undefined : 2}>{task.prompt}</Text>
              </Pressable>
              {task.error ? <Text style={styles.error}>{task.error}</Text> : null}
              {isExpanded ? (
                <View style={styles.detail}>
                  {detail.loading ? <ActivityIndicator color={colors.accent} /> : null}
                  {detail.error ? <Text style={styles.error}>{detail.error}</Text> : null}
                  <Text style={task.result?.text ? styles.result : styles.muted}>{task.result?.text || 'No result yet.'}</Text>
                  {task.nextRunAt ? <Text style={styles.muted}>Next run: {new Date(task.nextRunAt).toLocaleString()}</Text> : null}
                  <View style={styles.actions}>
                    <Pressable disabled={!online || actionBusy !== null || task.status === 'running'} onPress={() => void action(task.id, 'run')}><Text style={styles.link}>{task.status === 'paused' ? 'Resume / Run' : 'Run again'}</Text></Pressable>
                    <Pressable disabled={!online || actionBusy !== null || task.status === 'paused' || task.status === 'cancelled'} onPress={() => void action(task.id, 'pause')}><Text style={styles.link}>Pause</Text></Pressable>
                    <Pressable disabled={!online || actionBusy !== null || task.status === 'cancelled'} onPress={() => void action(task.id, 'cancel')}><Text style={styles.error}>Cancel</Text></Pressable>
                    {actionBusy === task.id ? <ActivityIndicator size="small" color={colors.accent} /> : null}
                  </View>
                  {data?.runs.length ? <Text style={styles.label}>Runs</Text> : null}
                  {data?.runs.map((run) => <Text key={run.id} style={run.error ? styles.error : styles.muted}>{new Date(run.startedAt).toLocaleString()} · {run.status}{run.error ? ` · ${run.error}` : ''}</Text>)}
                  {data?.events.length ? <Text style={styles.label}>Activity</Text> : null}
                  {data?.events.map((event) => <Text key={event.id} style={styles.muted}>{new Date(event.createdAt).toLocaleTimeString()} · {event.text}</Text>)}
                </View>
              ) : null}
            </View>
          );
        })}
        {!tasks.length ? <Text style={[styles.muted, styles.empty]}>No tasks yet. Schedule your first one above.</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', padding: spacing.lg },
  errorRow: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  error: { color: colors.danger, fontSize: 12 },
  note: { color: colors.muted, fontSize: 12, paddingHorizontal: spacing.lg },
  link: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  label: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: spacing.sm },
  list: { padding: spacing.lg, gap: spacing.sm },
  form: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  input: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, color: colors.text, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, minHeight: 64, textAlignVertical: 'top' },
  intervalRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  chip: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  createBtn: { backgroundColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs + 2, marginLeft: 'auto' },
  createText: { color: colors.bg, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  row: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  status: { color: colors.muted, fontSize: 12, textTransform: 'uppercase' },
  time: { color: colors.muted, fontSize: 11, marginLeft: 'auto' },
  prompt: { color: colors.text, lineHeight: 19, marginTop: spacing.sm },
  detail: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  result: { color: colors.text, lineHeight: 19 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  empty: { textAlign: 'center', marginTop: spacing.xl },
});
