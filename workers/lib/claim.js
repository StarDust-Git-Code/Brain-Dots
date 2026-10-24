import { randomUUID } from 'node:crypto';

const LEASE_EXPIRED_ERROR = 'Worker lease expired. Review completed effects before retrying.';

// Pure claim/settle logic for the task queue. Side-effect-free at import time:
// it never initializes firebase-admin itself, it only uses the adminDb handed in.
export function createClaimer({ adminDb, workerId, leaseMs }) {
  if (!adminDb) {
    throw new Error('createClaimer requires an adminDb (Firestore) instance.');
  }
  if (!workerId) {
    throw new Error('createClaimer requires a workerId.');
  }
  if (!leaseMs || leaseMs <= 0) {
    throw new Error('createClaimer requires a positive leaseMs.');
  }

  const tasks = adminDb.collection('tasks');

  function eventDoc(taskId, eventId, text, now) {
    return tasks.doc(taskId).collection('events').doc(eventId).set({
      id: eventId,
      taskId,
      text,
      createdAt: now,
    });
  }

  async function sweepExpiredLeases(now) {
    const snap = await tasks
      .where('status', '==', 'running')
      .where('leaseUntil', '<=', now)
      .get();
    if (snap.empty) return 0;
    const batch = adminDb.batch();
    let count = 0;
    snap.forEach((doc) => {
      batch.update(doc.ref, {
        status: 'interrupted',
        workerId: null,
        lease: null,
        leaseUntil: null,
        error: LEASE_EXPIRED_ERROR,
        updatedAt: now,
      });
      const eventId = randomUUID();
      batch.set(tasks.doc(doc.id).collection('events').doc(eventId), {
        id: eventId,
        taskId: doc.id,
        text: 'Run interrupted: worker lease expired.',
        createdAt: now,
      });
      count += 1;
    });
    await batch.commit();
    return count;
  }

  async function claimRecurringTask(doc, now) {
    const taskRef = tasks.doc(doc.id);
    const lease = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();
    return adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(taskRef);
      if (!cur.exists) return null;
      const data = cur.data();
      const stillDue =
        data.status === 'completed' &&
        typeof data.nextRunAt === 'number' &&
        data.nextRunAt <= now;
      if (!stillDue) return null;
      tx.update(taskRef, {
        status: 'running',
        workerId,
        lease,
        leaseUntil: now + leaseMs,
        nextRunAt: null,
        updatedAt: now,
      });
      tx.set(taskRef.collection('runs').doc(runId), {
        id: runId,
        taskId: doc.id,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        result: null,
        error: null,
      });
      tx.set(taskRef.collection('events').doc(eventId), {
        id: eventId,
        taskId: doc.id,
        text: 'Recurring task due; starting run.',
        createdAt: now,
      });
      return {
        id: doc.id,
        prompt: data.prompt,
        threadId: data.threadId ?? null,
        dotId: data.dotId ?? null,
        intervalSeconds: data.intervalSeconds ?? null,
        userId: data.userId ?? null,
        lease,
        runId,
      };
    });
  }

  async function claimQueuedTask(doc, now) {
    const taskRef = tasks.doc(doc.id);
    const lease = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();
    return adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(taskRef);
      if (!cur.exists) return null;
      const data = cur.data();
      if (data.status !== 'queued') return null;
      tx.update(taskRef, {
        status: 'running',
        workerId,
        lease,
        leaseUntil: now + leaseMs,
        updatedAt: now,
      });
      tx.set(taskRef.collection('runs').doc(runId), {
        id: runId,
        taskId: doc.id,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        result: null,
        error: null,
      });
      tx.set(taskRef.collection('events').doc(eventId), {
        id: eventId,
        taskId: doc.id,
        text: 'Worker started run.',
        createdAt: now,
      });
      return {
        id: doc.id,
        prompt: data.prompt,
        threadId: data.threadId ?? null,
        dotId: data.dotId ?? null,
        intervalSeconds: data.intervalSeconds ?? null,
        userId: data.userId ?? null,
        lease,
        runId,
      };
    });
  }

  async function claimTask() {
    const now = Date.now();

    await sweepExpiredLeases(now);

    const dueSnap = await tasks
      .where('status', '==', 'completed')
      .where('nextRunAt', '<=', now)
      .orderBy('nextRunAt', 'asc')
      .limit(5)
      .get();
    for (const doc of dueSnap.docs) {
      const claim = await claimRecurringTask(doc, now);
      if (claim) return claim;
    }

    const queuedSnap = await tasks
      .where('status', '==', 'queued')
      .orderBy('createdAt', 'asc')
      .limit(5)
      .get();
    for (const doc of queuedSnap.docs) {
      const claim = await claimQueuedTask(doc, now);
      if (claim) return claim;
    }

    return null;
  }

  async function settleSuccess(claim, result) {
    const now = Date.now();
    const taskRef = tasks.doc(claim.id);
    const runRef = taskRef.collection('runs').doc(claim.runId);
    const eventId = randomUUID();
    return adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(taskRef);
      if (!cur.exists) return false;
      const data = cur.data();
      if (data.lease !== claim.lease) return false;
      tx.update(taskRef, {
        status: 'completed',
        workerId: null,
        lease: null,
        leaseUntil: null,
        result,
        error: null,
        updatedAt: now,
        nextRunAt: claim.intervalSeconds ? now + claim.intervalSeconds * 1000 : null,
      });
      tx.update(runRef, { status: 'completed', finishedAt: now, result });
      tx.set(taskRef.collection('events').doc(eventId), {
        id: eventId,
        taskId: claim.id,
        text: 'Research brief ready.',
        createdAt: now,
      });
      return true;
    });
  }

  async function settleFailure(claim, errorMessage) {
    const now = Date.now();
    const message = errorMessage instanceof Error ? errorMessage.message : String(errorMessage);
    const taskRef = tasks.doc(claim.id);
    const runRef = taskRef.collection('runs').doc(claim.runId);
    const eventId = randomUUID();
    return adminDb.runTransaction(async (tx) => {
      const cur = await tx.get(taskRef);
      if (!cur.exists) return false;
      const data = cur.data();
      if (data.lease !== claim.lease) return false;
      tx.update(taskRef, {
        status: 'failed',
        workerId: null,
        lease: null,
        leaseUntil: null,
        error: message,
        updatedAt: now,
      });
      tx.update(runRef, { status: 'failed', finishedAt: now, error: message });
      tx.set(taskRef.collection('events').doc(eventId), {
        id: eventId,
        taskId: claim.id,
        text: `Run failed: ${message.slice(0, 300)}`,
        createdAt: now,
      });
      return true;
    });
  }

  async function heartbeat(taskId) {
    await tasks.doc(taskId).update({ leaseUntil: Date.now() + leaseMs });
  }

  return { claimTask, settleSuccess, settleFailure, heartbeat };
}
