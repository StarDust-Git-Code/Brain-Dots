export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export interface Space {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface Dot {
  id: string;
  userId: string;
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  createdAt: number;
}

export interface Page {
  id: string;
  userId: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
}

export interface Memory {
  id: string;
  userId: string;
  text: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  userId: string;
  dotId: string;
  title: string;
  createdAt: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface Source {
  title: string;
  url: string;
  excerpt: string;
}

export interface TaskResult {
  text: string;
  sources: Source[];
  sample: boolean;
}

export interface Task {
  id: string;
  userId: string;
  prompt: string;
  status: TaskStatus;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  threadId: string | null;
  dotId: string | null;
  workerId: string | null;
  lease: string | null;
  leaseUntil: number | null;
  runId?: string | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  result: TaskResult | null;
}

export interface Run {
  id: string;
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt: number | null;
  result: TaskResult | null;
  error: string | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  text: string;
  createdAt: number;
}

export interface SetupStatus {
  model: boolean;
  missing: string[];
}
