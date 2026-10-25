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
  name: string;
  description: string;
  createdAt: number;
}

export interface Dot {
  id: string;
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  spaceId: string;
  spaceIds: string[];
}

export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskResult {
  text: string;
  sources: { title: string; url: string; excerpt: string }[];
  sample: boolean;
}

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  error: string | null;
  result: TaskResult | null;
  threadId?: string | null;
  dotId?: string | null;
  updatedAt?: number;
}

export interface Run {
  id: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result?: TaskResult | null;
}

export interface TaskEvent {
  id: string;
  text: string;
  createdAt: number;
}

export interface TaskDetail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}

export interface Conversation {
  id: string;
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
