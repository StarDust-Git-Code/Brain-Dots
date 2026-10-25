'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, useScopedApi } from '../lib/client';
import type { Dot, Run, Task, TaskEvent } from '../lib/types';
import { Button, EmptyState, Spinner, StatusChip, relativeTime } from './ui';
import { useBeforeUnload, type RegisterLeaveGuard } from './useLeaveGuard';

interface TaskDetailResponse {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}

interface TasksViewProps {
  initialTasks: Task[];
  dots: Dot[];
  selectedDotId: string | null;
  onTasksChange: (tasks: Task[]) => void;
  registerLeaveGuard: RegisterLeaveGuard;
}

const INTERVAL_OPTIONS = [
  { label: 'Run once', value: 'off' },
  { label: 'Every 5 minutes', value: '5' },
  { label: 'Every 15 minutes', value: '15' },
  { label: 'Every hour', value: '60' },
  { label: 'Every day', value: '1440' },
];

export function TasksView({ initialTasks, dots, selectedDotId, onTasksChange, registerLeaveGuard }: TasksViewProps) {
  const api = useScopedApi();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [loading, setLoading] = useState(initialTasks.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [intervalKey, setIntervalKey] = useState('off');
  const [dotId, setDotId] = useState(selectedDotId ?? '');
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const mountedRef = useRef(false);
  const tasksRef = useRef(tasks);
  const promptRef = useRef(prompt);
  const expandedRef = useRef(expandedId);
  const listRequestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const mutationRef = useRef<AbortController | null>(null);
  const refreshPendingRef = useRef(false);
  const detailPendingRef = useRef(false);
  promptRef.current = prompt;
  expandedRef.current = expandedId;

  const applyTasks = useCallback((list: Task[]) => {
    tasksRef.current = list;
    setTasks(list);
    onTasksChange(list);
  }, [onTasksChange]);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (mutationRef.current) return;
    if (silent && detailPendingRef.current && expandedRef.current === id) return;
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    detailPendingRef.current = true;
    if (!silent) setDetailLoading(true);
    try {
      const data = await api<TaskDetailResponse>(`/tasks/${encodeURIComponent(id)}`, 'GET', undefined, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted || detailRequestRef.current !== controller || expandedRef.current !== id) return;
      if (data.task.id !== id) throw new Error('The server returned detail for a different task.');
      setDetail(data);
      setDetailError(null);
      applyTasks(tasksRef.current.map((task) => task.id === id ? data.task : task));
    } catch (err) {
      if (mountedRef.current && !controller.signal.aborted && expandedRef.current === id && detailRequestRef.current === controller && !isAbortError(err)) setDetailError(err instanceof Error ? err.message : 'Could not refresh task detail.');
    } finally {
      if (detailRequestRef.current === controller) detailPendingRef.current = false;
      if (mountedRef.current && !controller.signal.aborted && expandedRef.current === id && detailRequestRef.current === controller) setDetailLoading(false);
    }
  }, [applyTasks, api]);

  const refresh = useCallback(async (silent = false) => {
    if (mutationRef.current) return;
    if (silent && refreshPendingRef.current) return;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    refreshPendingRef.current = true;
    if (!silent) setLoading(true);
    try {
      const list = await api<Task[]>('/tasks', 'GET', undefined, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted || listRequestRef.current !== controller) return;
      applyTasks(list);
      setRefreshError(null);
      setLastRefreshedAt(Date.now());
      // Polling and manual refresh update the expanded runs/events as well as the list.
      const id = expandedRef.current;
      if (id && list.some((task) => task.id === id)) await loadDetail(id, true);
      else if (id) { expandedRef.current = null; setExpandedId(null); setDetail(null); }
    } catch (err) {
      if (mountedRef.current && !controller.signal.aborted && listRequestRef.current === controller && !isAbortError(err)) setRefreshError(err instanceof Error ? err.message : 'Could not refresh tasks.');
    } finally {
      if (listRequestRef.current === controller) refreshPendingRef.current = false;
      if (mountedRef.current && !controller.signal.aborted && listRequestRef.current === controller) setLoading(false);
    }
  }, [applyTasks, loadDetail, api]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      listRequestRef.current?.abort();
      detailRequestRef.current?.abort();
      mutationRef.current?.abort();
    };
  }, [refresh]);

  const shouldPoll = expandedId !== null || tasks.some((task) => task.status === 'queued' || task.status === 'running'
    || (task.intervalSeconds !== null && (task.status as string) !== 'paused' && task.status !== 'cancelled' && task.status !== 'interrupted'));
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => { void refresh(true); }, 5000);
    return () => clearInterval(timer);
  }, [shouldPoll, refresh]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setReviewedKey(null);
    if (expandedId) void loadDetail(expandedId);
    else { detailRequestRef.current?.abort(); setDetailLoading(false); }
  }, [expandedId, loadDetail]);

  useEffect(() => {
    registerLeaveGuard(() => {
      if (mutationRef.current) { setError('Wait for the current task action to finish before leaving.'); return false; }
      return !promptRef.current || window.confirm('Discard your new task draft and leave Tasks?');
    });
    return () => registerLeaveGuard(null);
  }, [registerLeaveGuard]);
  useBeforeUnload(prompt !== '' || creating || actionTaskId !== null);

  const createTask = async () => {
    const raw = promptRef.current;
    if (raw.trim().length < 3 || mutationRef.current) return;
    const controller = new AbortController();
    mutationRef.current = controller;
    listRequestRef.current?.abort();
    detailRequestRef.current?.abort();
    refreshPendingRef.current = false;
    detailPendingRef.current = false;
    setCreating(true);
    setLoading(false);
    setError(null);
    const repeat = intervalKey;
    try {
      const payload: { prompt: string; intervalSeconds: number | null; dotId?: string } = {
        prompt: raw.trim(), intervalSeconds: repeat === 'off' ? null : Number(repeat) * 60,
      };
      if (dotId && dots.some((dot) => dot.id === dotId)) payload.dotId = dotId;
      const created = await api<Task>('/tasks', 'POST', payload, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      applyTasks([created, ...tasksRef.current.filter((task) => task.id !== created.id)]);
      setPrompt((current) => current === raw ? '' : current);
      setIntervalKey((current) => current === repeat ? 'off' : current);
    } catch (err) {
      if (mountedRef.current && !controller.signal.aborted && !isAbortError(err)) setError(err instanceof Error ? err.message : 'Could not create the task. Your draft is preserved.');
    } finally {
      if (mutationRef.current === controller) mutationRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) { setCreating(false); void refresh(true); }
    }
  };

  const taskAction = async (task: Task, action: 'run' | 'pause' | 'cancel') => {
    if (mutationRef.current) return;
    const reviewKey = `${task.id}:${detail?.runs[0]?.id ?? task.updatedAt}`;
    const interrupted = task.status === 'interrupted' || detail?.runs[0]?.status === 'interrupted';
    if (action === 'run' && interrupted && reviewedKey !== reviewKey) return;
    if (action === 'cancel' && !window.confirm('Cancel this task? It will no longer be scheduled.')) return;
    const controller = new AbortController();
    mutationRef.current = controller;
    listRequestRef.current?.abort();
    detailRequestRef.current?.abort();
    refreshPendingRef.current = false;
    detailPendingRef.current = false;
    setActionTaskId(task.id);
    setError(null);
    try {
      const updated = await api<Task>(`/tasks/${encodeURIComponent(task.id)}/actions`, 'POST', { action }, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      applyTasks(tasksRef.current.map((item) => item.id === task.id ? updated : item));
      setDetail((current) => current?.task.id === task.id ? { ...current, task: updated } : current);
      setReviewedKey(null);
    } catch (err) {
      if (mountedRef.current && !controller.signal.aborted && !isAbortError(err)) setError(err instanceof Error ? err.message : 'Could not update the task.');
    } finally {
      if (mutationRef.current === controller) mutationRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) { setActionTaskId(null); void refresh(true); }
    }
  };

  return (
    <div className="tasks">
      <header className="view-head view-head--actions">
        <div><h1 className="view-title">Tasks</h1><p className="view-sub">Run a prompt once or on a schedule with one of your Dots.</p></div>
        <Button small variant="ghost" disabled={creating || actionTaskId !== null || loading} onClick={() => void refresh()}>Refresh</Button>
      </header>
      <form className="new-task" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>
        <label className="form-field">
          <span className="form-label">Task prompt</span>
          <textarea className="new-task-prompt" value={prompt} maxLength={4000} rows={2}
            placeholder="e.g. Summarize what I learned today and suggest next steps."
            onChange={(event) => { promptRef.current = event.target.value; setPrompt(event.target.value); }} />
        </label>
        <div className="new-task-row">
          <label className="new-task-interval"><span className="form-label">Repeat</span>
            <select className="select" aria-label="Repeat" value={intervalKey} onChange={(event) => setIntervalKey(event.target.value)}>
              {INTERVAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="new-task-dot"><span className="form-label">Dot</span>
            <select className="select" aria-label="Dot" value={dotId} onChange={(event) => setDotId(event.target.value)}>
              <option value="">Account default</option>
              {dots.map((dot) => <option key={dot.id} value={dot.id}>{dot.name}</option>)}
            </select>
          </label>
          <Button type="submit" small disabled={prompt.trim().length < 3 || creating || actionTaskId !== null}>{creating ? 'Creating…' : 'Create task'}</Button>
        </div>
      </form>
      {error ? <p className="view-error view-error--padded" role="alert">{error}</p> : null}
      {refreshError ? <div className="tasks-refresh-error"><p className="form-error" role="alert">{refreshError}</p><Button small variant="ghost" onClick={() => void refresh()} disabled={creating || actionTaskId !== null}>Retry refresh</Button></div> : null}
      {lastRefreshedAt ? <p className="tasks-refresh-status" role="status">Last refreshed {new Date(lastRefreshedAt).toLocaleTimeString()}{shouldPoll ? ' · Updates every 5 seconds' : ''}</p> : null}
      {loading ? <div className="tasks-loading"><Spinner label="Loading tasks…" /></div> : tasks.length === 0 ? <EmptyState title="No tasks yet" hint="Create a task above to get started." /> : (
        <ul className="task-list">
          {tasks.map((rowTask) => {
            const expanded = expandedId === rowTask.id;
            const task = expanded && detail?.task.id === rowTask.id ? detail.task : rowTask;
            const paused = (task.status as string) === 'paused';
            const active = task.status === 'queued' || task.status === 'running';
            const recurring = Boolean(task.intervalSeconds);
            const interrupted = task.status === 'interrupted' || (expanded && detail?.runs[0]?.status === 'interrupted');
            const reviewKey = `${task.id}:${detail?.runs[0]?.id ?? task.updatedAt}`;
            const actionBusy = creating || actionTaskId !== null;
            return (
              <li key={task.id} className={`task-row${expanded ? ' expanded' : ''}`}>
                <button className="task-row-main" aria-expanded={expanded} onClick={() => { expandedRef.current = expanded ? null : task.id; setExpandedId(expanded ? null : task.id); }}>
                  <StatusChip status={task.status} /><span className="task-prompt">{task.prompt}</span><span className="task-time">{relativeTime(task.createdAt)}</span>
                </button>
                {task.error ? <p className="task-error">{task.error}</p> : null}
                {task.result ? <details className="task-result"><summary>Latest result</summary><p>{task.result.text}</p></details> : null}
                {expanded ? (
                  <div className="task-detail">
                    {detailLoading ? <Spinner label="Loading task history…" /> : null}
                    {detailError ? <div className="inline-error"><p className="form-error" role="alert">{detailError}</p><Button small variant="ghost" disabled={actionBusy} onClick={() => void loadDetail(task.id)}>Retry detail</Button></div> : null}
                    {detail?.task.id === task.id ? (
                      <>
                        <p className="task-detail-line">{dots.find((dot) => dot.id === task.dotId)?.name ?? 'Account default Dot'} · {recurring ? `Every ${Math.round(task.intervalSeconds! / 60)} min` : 'One-time task'}{task.nextRunAt && !paused ? ` · Next: ${new Date(task.nextRunAt).toLocaleString()}` : ''}</p>
                        {interrupted ? (
                          <div className="task-review">
                            <p>An interrupted run may have completed some work. Review its results and events before retrying to avoid repeating that work.</p>
                            <label className="space-check"><input type="checkbox" checked={reviewedKey === reviewKey} onChange={(event) => setReviewedKey(event.target.checked ? reviewKey : null)} /><span>I’ve reviewed the run history and events.</span></label>
                          </div>
                        ) : null}
                        <div className="task-actions">
                          {!active ? <Button small disabled={actionBusy || Boolean(detailError) || (Boolean(interrupted) && reviewedKey !== reviewKey)} onClick={() => void taskAction(task, 'run')}>
                            {actionTaskId === task.id ? 'Updating…' : paused ? 'Resume recurring' : interrupted ? 'Retry after review' : task.status === 'failed' ? 'Retry task' : 'Run again'}
                          </Button> : null}
                          {recurring && !paused && task.status !== 'cancelled' ? <Button small variant="ghost" disabled={actionBusy || task.status === 'running'} onClick={() => void taskAction(task, 'pause')}>Pause recurring</Button> : null}
                          {task.status !== 'completed' && task.status !== 'cancelled' ? <Button small variant="danger" disabled={actionBusy} onClick={() => void taskAction(task, 'cancel')}>Cancel task</Button> : null}
                        </div>
                        {paused ? <p className="form-hint">Paused tasks stay off the schedule until you resume them.</p> : recurring && task.status === 'running' ? <p className="form-hint">You can pause the schedule after the current run finishes.</p> : null}
                        <h3 className="panel-title">Run history ({detail.runs.length})</h3>
                        {detail.runs.length === 0 ? <p className="task-detail-muted">No runs yet.</p> : (
                          <ul className="task-runs">{detail.runs.map((run) => <li key={run.id}>
                            <div className="task-run-head"><StatusChip status={run.status} /><span className="form-hint">Started {new Date(run.startedAt).toLocaleString()}{run.finishedAt ? ` · Finished ${new Date(run.finishedAt).toLocaleString()}` : ''}</span></div>
                            {run.error ? <p className="task-error">{run.error}</p> : null}
                            {run.result ? <details className="task-result"><summary>Run result</summary><p>{run.result.text}</p></details> : null}
                          </li>)}</ul>
                        )}
                        <h3 className="panel-title">Events</h3>
                        {detail.events.length === 0 ? <p className="task-detail-muted">No events yet.</p> : <ul className="task-events">{detail.events.map((event) => <li key={event.id}><span>{event.text}</span><span className="task-time">{relativeTime(event.createdAt)}</span></li>)}</ul>}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
