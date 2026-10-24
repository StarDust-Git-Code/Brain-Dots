'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/client';
import type { Run, Task, TaskEvent } from '../lib/types';
import { Button, EmptyState, Spinner, StatusChip, relativeTime } from './ui';

interface TaskDetailResponse {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}

interface TasksViewProps {
  initialTasks: Task[];
  onTasksChange: (tasks: Task[]) => void;
}

const INTERVAL_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Run once', value: 'off' },
  { label: 'Every 5 minutes', value: '5' },
  { label: 'Every 15 minutes', value: '15' },
  { label: 'Every hour', value: '60' },
  { label: 'Every day', value: '1440' },
];

export function TasksView({ initialTasks, onTasksChange }: TasksViewProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [loading, setLoading] = useState(initialTasks.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [intervalKey, setIntervalKey] = useState('off');
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const list = await api<Task[]>('/tasks');
        setTasks(list);
        onTasksChange(list);
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : 'Could not load tasks.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [onTasksChange],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = tasks.some((t) => t.status === 'queued' || t.status === 'running');
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      void refresh(true);
    }, 5000);
    return () => clearInterval(id);
  }, [hasActive, refresh]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (!expandedId) {
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api<TaskDetailResponse>(`/tasks/${expandedId}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setDetailError(err instanceof Error ? err.message : 'Could not load task detail.');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedId]);

  const createTask = async () => {
    const trimmed = prompt.trim();
    if (trimmed.length < 3 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const intervalSeconds = intervalKey === 'off' ? null : Number(intervalKey) * 60;
      await api<Task>('/tasks', 'POST', { prompt: trimmed, intervalSeconds });
      setPrompt('');
      setIntervalKey('off');
      await refresh(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the task.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="tasks">
      <header className="view-head">
        <h1 className="view-title">Activity</h1>
        <p className="view-sub">Research and automation tasks</p>
      </header>

      <form
        className="new-task"
        onSubmit={(event) => {
          event.preventDefault();
          void createTask();
        }}
      >
        <textarea
          className="new-task-prompt"
          value={prompt}
          maxLength={4000}
          rows={2}
          placeholder="Describe a task, e.g. “Check my inbox for urgent mail”"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="new-task-row">
          <label className="new-task-interval">
            <span className="form-label">Repeat</span>
            <select
              className="select"
              value={intervalKey}
              onChange={(event) => setIntervalKey(event.target.value)}
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" small disabled={prompt.trim().length < 3 || creating}>
            {creating ? 'Creating…' : 'New task'}
          </Button>
        </div>
      </form>

      {error ? <p className="view-error view-error--padded">{error}</p> : null}

      {loading ? (
        <div className="tasks-loading">
          <Spinner />
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState title="No tasks yet" hint="Create a task above to get started." />
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id} className={`task-row${expandedId === task.id ? ' expanded' : ''}`}>
              <button
                className="task-row-main"
                onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
              >
                <StatusChip status={task.status} />
                <span className="task-prompt">{task.prompt}</span>
                <span className="task-time">{relativeTime(task.createdAt)}</span>
              </button>
              {task.error ? <p className="task-error">{task.error}</p> : null}
              {task.result ? (
                <details className="task-result">
                  <summary>Result</summary>
                  <p>{task.result.text}</p>
                </details>
              ) : null}
              {expandedId === task.id ? (
                <div className="task-detail">
                  {detailLoading ? (
                    <Spinner />
                  ) : detailError ? (
                    <p className="view-error">{detailError}</p>
                  ) : detail ? (
                    <>
                      <p className="task-detail-line">
                        Runs: {detail.runs.length}
                        {detail.task.intervalSeconds
                          ? ` · every ${Math.round(detail.task.intervalSeconds / 60)} min`
                          : ''}
                      </p>
                      {detail.events.length === 0 ? (
                        <p className="task-detail-muted">No events yet.</p>
                      ) : (
                        <ul className="task-events">
                          {detail.events.map((event) => (
                            <li key={event.id}>
                              <span>{event.text}</span>
                              <span className="task-time">{relativeTime(event.createdAt)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
