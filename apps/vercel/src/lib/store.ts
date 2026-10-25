import { randomUUID } from 'crypto';
import type { DocumentData, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { ApiError } from './auth';
import { adminDb } from './firebase-admin';
import type {
  Conversation,
  Dot,
  Memory,
  Message,
  Page,
  Run,
  SetupStatus,
  Space,
  Task,
  TaskEvent,
  TaskResult,
  TaskStatus,
} from './types';

const db = adminDb;
const spacesCol = db.collection('spaces');
const dotsCol = db.collection('dots');
const pagesCol = db.collection('pages');
const memoriesCol = db.collection('memories');
const conversationsCol = db.collection('conversations');
const tasksCol = db.collection('tasks');

const REQUIRED_ENV = ['NVIDIA_NIM_API_KEY', 'NVIDIA_NIM_BASE_URL', 'NVIDIA_NIM_MODEL'] as const;

function hydrate<T>(id: string, data: DocumentData): T {
  return { ...data, id } as T;
}

// Per-user lists are small, so equality filters are combined without orderBy
// (which would require composite indexes) and sorted in memory instead.
function sorted<T extends { createdAt: number }>(docs: T[], order: 'asc' | 'desc'): T[] {
  return [...docs].sort((a, b) => (order === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
}

async function ownedDoc<T>(
  col: FirebaseFirestore.CollectionReference,
  userId: string,
  id: string,
  notFoundMessage: string,
): Promise<T & { createdAt: number }> {
  const snap = await col.doc(id).get();
  const data = snap.data();
  if (!snap.exists || !data || data.userId !== userId) {
    throw new ApiError(404, notFoundMessage);
  }
  return hydrate<T>(id, data) as T & { createdAt: number };
}

async function assertSpacesExist(userId: string, spaceIds: string[]): Promise<void> {
  const ids = Array.from(new Set(spaceIds));
  if (ids.length === 0) {
    throw new ApiError(400, 'Create a space before adding dots.');
  }
  let found = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const snap = await spacesCol.where('__name__', 'in', chunk).get();
    found += snap.docs.filter((d) => d.data()?.userId === userId).length;
  }
  if (found < ids.length) {
    throw new ApiError(400, 'One or more spaces do not exist.');
  }
}

// ---------- Spaces ----------

async function listSpaces(userId: string): Promise<Space[]> {
  const snap = await spacesCol.where('userId', '==', userId).get();
  return sorted(snap.docs.map((d) => hydrate<Space>(d.id, d.data())), 'asc');
}

async function createSpace(userId: string, input: { name: string; description: string }): Promise<Space> {
  const doc = {
    userId,
    name: input.name,
    description: input.description,
    createdAt: Date.now(),
  };
  const ref = await spacesCol.add(doc);
  return { id: ref.id, ...doc };
}

// ---------- Dots ----------

interface DotInput {
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  spaceId: string;
  spaceIds: string[];
}

interface DotPatch extends Partial<Omit<DotInput, 'spaceId' | 'spaceIds'>> {
  spaceId?: string;
  spaceIds?: string[];
}

async function listDots(userId: string): Promise<Dot[]> {
  const snap = await dotsCol.where('userId', '==', userId).get();
  return sorted(snap.docs.map((d) => hydrate<Dot>(d.id, d.data())), 'asc');
}

async function getDot(userId: string, dotId: string): Promise<Dot> {
  return ownedDoc<Dot>(dotsCol, userId, dotId, 'Dot not found.');
}

function assertDotFields(name: string, instructions: string): void {
  if (name.length < 1 || name.length > 40) {
    throw new ApiError(400, 'Dot name must be between 1 and 40 characters.');
  }
  if (instructions.length < 3 || instructions.length > 2000) {
    throw new ApiError(400, 'Dot instructions must be between 3 and 2000 characters.');
  }
}

async function createDot(userId: string, input: DotInput): Promise<Dot> {
  assertDotFields(input.name, input.instructions);
  if (!input.spaceIds.includes(input.spaceId)) {
    throw new ApiError(400, 'spaceIds must include spaceId.');
  }
  await assertSpacesExist(userId, input.spaceIds);
  const doc = {
    userId,
    name: input.name,
    instructions: input.instructions,
    researchAllowed: input.researchAllowed,
    memoryAllowed: input.memoryAllowed,
    spaceId: input.spaceId,
    spaceIds: Array.from(new Set(input.spaceIds)),
    createdAt: Date.now(),
  };
  const ref = await dotsCol.add(doc);
  return { id: ref.id, ...doc };
}

async function updateDot(userId: string, dotId: string, patch: DotPatch): Promise<Dot> {
  const existing = await getDot(userId, dotId);
  const next = {
    name: patch.name ?? existing.name,
    instructions: patch.instructions ?? existing.instructions,
    researchAllowed: patch.researchAllowed ?? existing.researchAllowed,
    memoryAllowed: patch.memoryAllowed ?? existing.memoryAllowed,
    spaceId: patch.spaceId ?? existing.spaceId,
    spaceIds: patch.spaceIds ?? existing.spaceIds,
  };
  assertDotFields(next.name, next.instructions);
  if (!next.spaceIds.includes(next.spaceId)) {
    throw new ApiError(400, 'spaceIds must include spaceId.');
  }
  if (patch.spaceId !== undefined || patch.spaceIds !== undefined) {
    await assertSpacesExist(userId, next.spaceIds);
  }
  await dotsCol.doc(dotId).update(next);
  return { ...existing, ...next };
}

// ---------- Pages ----------

interface PageInput {
  title: string;
  content: string;
  parentId: string | null;
}

interface PagePatch {
  title?: string;
  content?: string;
  parentId?: string | null;
}

async function assertSpaceExists(userId: string, spaceId: string): Promise<void> {
  const snap = await spacesCol.doc(spaceId).get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new ApiError(404, 'Space not found.');
  }
}

async function assertPageInSpace(userId: string, spaceId: string, pageId: string): Promise<Page> {
  const snap = await pagesCol.doc(pageId).get();
  const data = snap.data();
  if (!snap.exists || !data || data.userId !== userId || data.spaceId !== spaceId) {
    throw new ApiError(400, 'Parent page not found in this space.');
  }
  return hydrate<Page>(pageId, data);
}

async function listPages(userId: string, spaceId: string): Promise<Page[]> {
  await assertSpaceExists(userId, spaceId);
  const snap = await pagesCol.where('userId', '==', userId).where('spaceId', '==', spaceId).get();
  return sorted(snap.docs.map((d) => hydrate<Page>(d.id, d.data())), 'asc');
}

async function getPage(userId: string, spaceId: string, pageId: string): Promise<Page> {
  const snap = await pagesCol.doc(pageId).get();
  const data = snap.data();
  if (!snap.exists || !data || data.userId !== userId || data.spaceId !== spaceId) {
    throw new ApiError(404, 'Page not found.');
  }
  return hydrate<Page>(pageId, data);
}

async function createPage(userId: string, spaceId: string, input: PageInput): Promise<Page> {
  if (input.title.length < 1 || input.title.length > 160) {
    throw new ApiError(400, 'Page title must be between 1 and 160 characters.');
  }
  if (input.content.length > 100_000) {
    throw new ApiError(400, 'Page content is too long.');
  }
  await assertSpaceExists(userId, spaceId);
  if (input.parentId !== null) {
    await assertPageInSpace(userId, spaceId, input.parentId);
  }
  const now = Date.now();
  const doc = {
    userId,
    spaceId,
    parentId: input.parentId,
    title: input.title,
    content: input.content,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    sourceThreadId: null,
  };
  const ref = await pagesCol.add(doc);
  return { id: ref.id, ...doc };
}

// Rejects parentId if walking up its parent chain reaches pageId (i.e. the
// target parent is inside the page's own subtree).
async function assertNotOwnDescendant(
  tx: Transaction,
  startParentId: string,
  pageId: string,
): Promise<void> {
  const seen = new Set<string>();
  let currentId: string | null = startParentId;
  while (currentId) {
    if (currentId === pageId) {
      throw new ApiError(400, 'A page cannot be moved under one of its own children.');
    }
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const snap: DocumentSnapshot = await tx.get(pagesCol.doc(currentId));
    const data = snap.data();
    if (!data) break;
    currentId = (data as Page).parentId ?? null;
  }
}

async function updatePage(
  userId: string,
  spaceId: string,
  pageId: string,
  patch: PagePatch & { expectedRevision: number },
): Promise<Page> {
  const ref = pagesCol.doc(pageId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || !data) {
      throw new ApiError(404, 'Page not found.');
    }
    const page = hydrate<Page>(pageId, data);
    if (page.userId !== userId || page.spaceId !== spaceId) {
      throw new ApiError(404, 'Page not found.');
    }
    if (page.revision !== patch.expectedRevision) {
      throw new ApiError(409, 'This page changed. Reload the latest revision before saving.');
    }
    let parentId = page.parentId;
    if (patch.parentId !== undefined) {
      parentId = patch.parentId;
      if (parentId !== null) {
        if (parentId === pageId) {
          throw new ApiError(400, 'A page cannot be nested inside itself.');
        }
        await assertPageInSpace(userId, spaceId, parentId);
        await assertNotOwnDescendant(tx, parentId, pageId);
      }
    }
    const nextTitle = patch.title ?? page.title;
    const nextContent = patch.content ?? page.content;
    if (nextTitle.length < 1 || nextTitle.length > 160) {
      throw new ApiError(400, 'Page title must be between 1 and 160 characters.');
    }
    if (nextContent.length > 100_000) {
      throw new ApiError(400, 'Page content is too long.');
    }
    const next = {
      title: nextTitle,
      content: nextContent,
      parentId,
      revision: page.revision + 1,
      updatedAt: Date.now(),
    };
    tx.update(ref, next);
    return { ...page, ...next };
  });
}

// ---------- Memories ----------

interface MemoryInput {
  id?: string;
  text: string;
}

async function listMemories(userId: string): Promise<Memory[]> {
  const snap = await memoriesCol.where('userId', '==', userId).get();
  return sorted(snap.docs.map((d) => hydrate<Memory>(d.id, d.data())), 'asc');
}

async function saveMemory(userId: string, input: MemoryInput): Promise<Memory> {
  if (input.text.length < 1 || input.text.length > 2000) {
    throw new ApiError(400, 'Memory text must be between 1 and 2000 characters.');
  }
  if (input.id) {
    const ref = memoriesCol.doc(input.id);
    const snap = await ref.get();
    if (snap.exists && snap.data()?.userId !== userId) {
      throw new ApiError(404, 'Memory not found.');
    }
    const doc = {
      userId,
      text: input.text,
      createdAt: snap.exists ? (snap.data() as Memory).createdAt : Date.now(),
    };
    await ref.set(doc);
    return { id: input.id, ...doc };
  }
  const doc = { userId, text: input.text, createdAt: Date.now() };
  const ref = await memoriesCol.add(doc);
  return { id: ref.id, ...doc };
}

async function deleteMemory(userId: string, id: string): Promise<void> {
  const snap = await memoriesCol.doc(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new ApiError(404, 'Memory not found.');
  }
  await memoriesCol.doc(id).delete();
}

// ---------- Conversations ----------

interface ConversationInput {
  dotId: string;
  title: string;
}

async function listConversations(userId: string): Promise<Conversation[]> {
  const snap = await conversationsCol.where('userId', '==', userId).get();
  return sorted(snap.docs.map((d) => hydrate<Conversation>(d.id, d.data())), 'desc');
}

async function getConversation(userId: string, conversationId: string): Promise<Conversation> {
  return ownedDoc<Conversation>(conversationsCol, userId, conversationId, 'Conversation not found.');
}

async function createConversation(userId: string, input: ConversationInput): Promise<Conversation> {
  if (input.title.length < 1 || input.title.length > 120) {
    throw new ApiError(400, 'Conversation title must be between 1 and 120 characters.');
  }
  const snap = await dotsCol.doc(input.dotId).get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new ApiError(404, 'Dot not found.');
  }
  const doc = {
    userId,
    dotId: input.dotId,
    title: input.title,
    createdAt: Date.now(),
  };
  const ref = await conversationsCol.add(doc);
  return { id: ref.id, ...doc };
}

async function appendMessage(
  userId: string,
  conversationId: string,
  input: { role: Message['role']; content: string },
): Promise<Message> {
  await getConversation(userId, conversationId);
  const message: Message = {
    id: randomUUID(),
    role: input.role,
    content: input.content,
    createdAt: Date.now(),
  };
  await conversationsCol
    .doc(conversationId)
    .collection('messages')
    .doc(message.id)
    .set({ role: message.role, content: message.content, createdAt: message.createdAt });
  return message;
}

async function getMessages(userId: string, conversationId: string, limit = 100): Promise<Message[]> {
  await getConversation(userId, conversationId);
  const snap = await conversationsCol
    .doc(conversationId)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => hydrate<Message>(d.id, d.data())).reverse();
}

async function getRecentMessages(
  userId: string,
  conversationId: string,
  limit: number,
): Promise<Message[]> {
  await getConversation(userId, conversationId);
  const snap = await conversationsCol
    .doc(conversationId)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs
    .map((d) => hydrate<Message>(d.id, d.data()))
    .reverse();
}

// ---------- Tasks (API side; workers handle claiming) ----------

interface TaskInput {
  prompt: string;
  intervalSeconds?: number | null;
  threadId?: string | null;
  dotId?: string | null;
}

async function listTasks(userId: string): Promise<Task[]> {
  const snap = await tasksCol.where('userId', '==', userId).orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map((d) => hydrate<Task>(d.id, d.data()));
}

async function getTask(userId: string, taskId: string): Promise<Task> {
  return ownedDoc<Task>(tasksCol, userId, taskId, 'Task not found.');
}

async function createTask(userId: string, input: TaskInput): Promise<Task> {
  let dotId = input.dotId ?? null;
  let threadId = input.threadId ?? null;
  if (threadId) {
    const conversation = await getConversation(userId, threadId);
    if (dotId && conversation.dotId !== dotId) {
      throw new ApiError(400, 'Choose a conversation belonging to the selected Dot.');
    }
    dotId = conversation.dotId;
    await getDot(userId, dotId);
  } else {
    const dot = dotId ? await getDot(userId, dotId) : (await listDots(userId))[0];
    if (!dot) throw new ApiError(400, 'Create a Dot before scheduling a task.');
    dotId = dot.id;
    const conversation = await createConversation(userId, {
      dotId,
      title: input.prompt.trim().slice(0, 120),
    });
    threadId = conversation.id;
  }
  const now = Date.now();
  const doc = {
    userId,
    prompt: input.prompt,
    status: 'queued' as TaskStatus,
    intervalSeconds: input.intervalSeconds ?? null,
    nextRunAt: null,
    threadId,
    dotId,
    workerId: null,
    lease: null,
    leaseUntil: null,
    runId: null,
    createdAt: now,
    updatedAt: now,
    error: null,
    result: null as TaskResult | null,
  };
  const ref = await tasksCol.add(doc);
  return { id: ref.id, ...doc };
}

async function activeWorkerTask(
  taskId: string,
  lease: string,
  dotId: string,
  threadId: string,
): Promise<Task> {
  const snapshot = await tasksCol.doc(taskId).get();
  const task = snapshot.data();
  if (!snapshot.exists || !task || task.status !== 'running' ||
      task.lease !== lease || !task.workerId ||
      typeof task.leaseUntil !== 'number' || task.leaseUntil <= Date.now()) {
    throw new ApiError(409, 'This task no longer has an active worker lease.');
  }
  if (task.dotId !== dotId || task.threadId !== threadId ||
      typeof task.userId !== 'string' || !task.userId) {
    throw new ApiError(403, 'The worker request does not match its assigned task.');
  }
  return hydrate<Task>(snapshot.id, task);
}

async function appendWorkerAssistant(
  userId: string,
  taskId: string,
  lease: string,
  dotId: string,
  threadId: string,
  content: string,
): Promise<Message> {
  const message: Message = { id: randomUUID(), role: 'assistant', content, createdAt: Date.now() };
  return db.runTransaction(async (tx) => {
    const task = (await tx.get(tasksCol.doc(taskId))).data();
    const conversation = (await tx.get(conversationsCol.doc(threadId))).data();
    if (!task || task.status !== 'running' || task.lease !== lease ||
        typeof task.leaseUntil !== 'number' || task.leaseUntil <= Date.now()) {
      throw new ApiError(409, 'This task no longer has an active worker lease.');
    }
    if (task.userId !== userId || task.dotId !== dotId || task.threadId !== threadId ||
        conversation?.userId !== userId || conversation?.dotId !== dotId) {
      throw new ApiError(403, 'The worker request does not match its assigned task.');
    }
    tx.set(conversationsCol.doc(threadId).collection('messages').doc(message.id), {
      role: message.role, content: message.content, createdAt: message.createdAt,
    });
    return message;
  });
}

async function actionTask(
  userId: string,
  taskId: string,
  action: 'run' | 'pause' | 'cancel',
): Promise<Task> {
  const ref = tasksCol.doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || !data) {
      throw new ApiError(404, 'Task not found.');
    }
    const task = hydrate<Task>(taskId, data);
    if (task.userId !== userId) {
      throw new ApiError(404, 'Task not found.');
    }
    let status: TaskStatus;
    let error: string | null;
    if (action === 'run') {
      if (!['failed', 'cancelled', 'interrupted', 'completed', 'paused'].includes(task.status)) {
        throw new ApiError(400, 'Task is already queued or running.');
      }
      status = 'queued';
      error = null;
    } else if (action === 'pause') {
      status = 'paused';
      error = null;
    } else {
      if (task.status === 'completed' && !task.nextRunAt) {
        throw new ApiError(400, 'Completed tasks cannot be cancelled.');
      }
      status = 'cancelled';
      error = 'Task cancelled.';
    }
    const patch = {
      status,
      error,
      workerId: null,
      lease: null,
      leaseUntil: null,
      nextRunAt: null,
      updatedAt: Date.now(),
    };
    if (task.status === 'running' && task.lease) {
      const running = task.runId
        ? [await tx.get(ref.collection('runs').doc(task.runId))]
        : (await tx.get(ref.collection('runs').where('status', '==', 'running').limit(20))).docs;
      for (const run of running) {
        if (!run.exists || run.data()?.status !== 'running') continue;
        tx.update(run.ref, {
          status: 'interrupted',
          finishedAt: Date.now(),
          error: 'Run interrupted by its owner. Review completed effects before retrying.',
        });
      }
    }
    tx.update(ref, patch);
    tx.set(ref.collection('events').doc(), {
      taskId,
      text: action === 'run' ? 'Task queued for an explicit run.' : `Task ${status} by its owner.`,
      createdAt: Date.now(),
    });
    return { ...task, ...patch };
  });
}

async function getTaskDetail(
  userId: string,
  taskId: string,
): Promise<{ task: Task; runs: Run[]; events: TaskEvent[] }> {
  const task = await getTask(userId, taskId);
  const [runsSnap, eventsSnap] = await Promise.all([
    tasksCol.doc(taskId).collection('runs').orderBy('startedAt', 'desc').limit(20).get(),
    tasksCol.doc(taskId).collection('events').orderBy('createdAt', 'asc').limit(50).get(),
  ]);
  return {
    task,
    runs: runsSnap.docs.map((d) => hydrate<Run>(d.id, d.data())),
    events: eventsSnap.docs.map((d) => hydrate<TaskEvent>(d.id, d.data())),
  };
}

// ---------- Setup ----------

function getSetupStatus(): SetupStatus {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  return {
    model: !!process.env.NVIDIA_NIM_API_KEY,
    missing: [...missing],
  };
}

async function brainContext(userId: string, spaceIds: string[], query: string) {
  const snapshot = await pagesCol.where('userId', '==', userId).limit(200).get();
  const words = Array.from(new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  return snapshot.docs
    .map((doc) => hydrate<Page>(doc.id, doc.data()))
    .filter((page) => spaceIds.includes(page.spaceId))
    .map((page) => {
      const title = page.title.toLowerCase();
      const text = page.content.toLowerCase();
      const score = words.reduce((sum, word) => sum + (title.includes(word) ? 4 : 0) + (text.includes(word) ? 1 : 0), 0);
      return { page, score };
    })
    .sort((left, right) => right.score - left.score || right.page.updatedAt - left.page.updatedAt)
    .slice(0, 4)
    .map(({ page }) => ({ id: page.id, title: page.title, content: page.content.slice(0, 4000) }));
}

export const store = {
  spaces: {
    list: listSpaces,
    create: createSpace,
  },
  dots: {
    list: listDots,
    get: getDot,
    create: createDot,
    update: updateDot,
  },
  pages: {
    list: listPages,
    get: getPage,
    create: createPage,
    update: updatePage,
    brainContext,
  },
  memories: {
    list: listMemories,
    save: saveMemory,
    delete: deleteMemory,
  },
  conversations: {
    list: listConversations,
    get: getConversation,
    create: createConversation,
    appendMessage,
    appendWorkerAssistant,
    getMessages,
    getRecentMessages,
  },
  tasks: {
    list: listTasks,
    get: getTask,
    create: createTask,
    action: actionTask,
    detail: getTaskDetail,
    activeWorkerTask,
  },
  setup: {
    status: getSetupStatus,
  },
};
