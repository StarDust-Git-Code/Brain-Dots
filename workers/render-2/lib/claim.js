import { randomUUID } from 'node:crypto';

const LEASE_EXPIRED_ERROR = 'Worker lease expired. Review completed effects before retrying.';
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

// Importing this module never initializes Firebase or contacts Firestore.
export function createClaimer({ adminDb, workerId, leaseMs, clock = Date.now }) {
  if (!adminDb) throw new Error('createClaimer requires an adminDb (Firestore) instance.');
  if (!nonempty(workerId)) throw new Error('createClaimer requires a workerId.');
  if (!positive(leaseMs)) throw new Error('createClaimer requires a positive leaseMs.');
  if (typeof clock !== 'function') throw new Error('createClaimer requires a clock function.');

  const tasks = adminDb.collection('tasks');
  let preferredKind = 'queued';

  function validClaim(claim) {
    return claim && nonempty(claim.id) && nonempty(claim.runId) && nonempty(claim.lease) &&
      claim.workerId === workerId;
  }

  function ownsTask(data, claim, now) {
    return data.status === 'running' && data.workerId === workerId &&
      data.lease === claim.lease && data.runId === claim.runId &&
      Number.isFinite(data.leaseUntil) && data.leaseUntil > now;
  }

  function ownsRun(data, claim, now) {
    return data?.status === 'running' && data.id === claim.runId && data.taskId === claim.id &&
      data.workerId === workerId && data.lease === claim.lease &&
      Number.isFinite(data.leaseUntil) && data.leaseUntil > now;
  }

  async function readOwned(tx, claim, signal) {
    if (signal?.aborted) return null;
    const taskRef = tasks.doc(claim.id);
    const task = await tx.get(taskRef);
    if (!task.exists || signal?.aborted) return null;
    const data = task.data();
    if (!ownsTask(data, claim, clock())) return null;
    const runRef = taskRef.collection('runs').doc(claim.runId);
    const run = await tx.get(runRef);
    // Recompute time on every transaction retry, after the reads, not before the RPC.
    const now = clock();
    if (signal?.aborted || !ownsTask(data, claim, now) || !ownsRun(run.data(), claim, now)) {
      return null;
    }
    return { taskRef, runRef, data, now };
  }

  async function sweepExpiredLeases({ signal } = {}) {
    if (signal?.aborted) return 0;
    const snapshot = await tasks.where('status', '==', 'running')
      .where('leaseUntil', '<=', clock()).orderBy('leaseUntil', 'asc').limit(20).get();
    let count = 0;
    for (const candidate of snapshot.docs) {
      if (signal?.aborted) break;
      const eventId = randomUUID();
      const interrupted = await adminDb.runTransaction(async (tx) => {
        const task = await tx.get(candidate.ref);
        if (!task.exists || signal?.aborted) return false;
        const data = task.data();
        if (data.status !== 'running' || !Number.isFinite(data.leaseUntil) ||
            data.leaseUntil > clock()) return false;

        // Old workers did not persist task.runId or ownership in run docs. Resolve
        // their running records under the same transaction before writing anything.
        const runs = nonempty(data.runId)
          ? [await tx.get(candidate.ref.collection('runs').doc(data.runId))]
          : (await tx.get(candidate.ref.collection('runs')
            .where('status', '==', 'running').limit(20))).docs;
        const now = clock();
        if (signal?.aborted || data.leaseUntil > now) return false;
        tx.update(candidate.ref, {
          status: 'interrupted', workerId: null, lease: null, leaseUntil: null,
          nextRunAt: null, result: null, error: LEASE_EXPIRED_ERROR, updatedAt: now,
        });
        for (const run of runs) {
          const record = run.data();
          if (record?.status === 'running' &&
              (record.workerId == null || record.workerId === data.workerId) &&
              (record.lease == null || record.lease === data.lease)) {
            tx.update(run.ref, {
              status: 'interrupted', finishedAt: now, result: null, error: LEASE_EXPIRED_ERROR,
            });
          }
        }
        tx.set(candidate.ref.collection('events').doc(eventId), {
          id: eventId, taskId: candidate.id, runId: data.runId ?? null,
          text: 'Run interrupted: worker lease expired.', createdAt: now,
        });
        return true;
      });
      if (interrupted) count += 1;
    }
    return count;
  }

  async function claimCandidate(candidate, kind, signal) {
    // IDs live outside the retryable callback: one committed run, lease and event.
    const lease = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();
    return adminDb.runTransaction(async (tx) => {
      if (signal?.aborted) return null;
      const task = await tx.get(candidate.ref);
      if (!task.exists || signal?.aborted) return null;
      const data = task.data();
      const now = clock();
      const eligible = kind === 'queued' ? data.status === 'queued' :
        data.status === 'completed' && positive(data.intervalSeconds) &&
        Number.isFinite(data.nextRunAt) && data.nextRunAt <= now;
      if (!eligible) return null;
      const leaseUntil = now + leaseMs;
      tx.update(candidate.ref, {
        status: 'running', workerId, lease, runId, leaseUntil,
        nextRunAt: null, result: null, error: null, updatedAt: now,
      });
      tx.set(candidate.ref.collection('runs').doc(runId), {
        id: runId, taskId: candidate.id, workerId, lease, leaseUntil,
        status: 'running', startedAt: now, finishedAt: null, result: null, error: null,
      });
      tx.set(candidate.ref.collection('events').doc(eventId), {
        id: eventId, taskId: candidate.id, runId, createdAt: now,
        text: kind === 'queued' ? 'Worker started run.' : 'Recurring task due; starting run.',
      });
      return {
        id: candidate.id, prompt: data.prompt ?? '', threadId: data.threadId ?? null,
        dotId: data.dotId ?? null, intervalSeconds: data.intervalSeconds ?? null,
        userId: data.userId ?? null, workerId, lease, runId, leaseUntil,
      };
    });
  }

  async function claimTask({ signal } = {}) {
    await sweepExpiredLeases({ signal });
    // Alternate successful claims so an endless recurring backlog cannot starve
    // fresh jobs (or vice versa). Within each class, take the oldest due job first.
    for (const kind of [preferredKind, preferredKind === 'queued' ? 'recurring' : 'queued']) {
      if (signal?.aborted) return null;
      const query = kind === 'queued'
        ? tasks.where('status', '==', 'queued').orderBy('createdAt', 'asc')
        : tasks.where('status', '==', 'completed').where('nextRunAt', '<=', clock())
          .orderBy('nextRunAt', 'asc');
      const snapshot = await query.limit(5).get();
      for (const candidate of snapshot.docs) {
        if (signal?.aborted) return null;
        const claim = await claimCandidate(candidate, kind, signal);
        if (claim) {
          preferredKind = kind === 'queued' ? 'recurring' : 'queued';
          return claim;
        }
      }
    }
    return null;
  }

  async function checkOwnership(claim, { signal } = {}) {
    if (!validClaim(claim)) return false;
    return adminDb.runTransaction(async (tx) => Boolean(await readOwned(tx, claim, signal)));
  }

  async function heartbeat(claim, { signal } = {}) {
    if (!validClaim(claim)) return false;
    return adminDb.runTransaction(async (tx) => {
      const owned = await readOwned(tx, claim, signal);
      if (!owned) return false;
      const leaseUntil = Math.max(owned.data.leaseUntil, owned.now + leaseMs);
      tx.update(owned.taskRef, { leaseUntil, updatedAt: owned.now });
      tx.update(owned.runRef, { leaseUntil });
      return true;
    });
  }

  async function finish(claim, status, result, error, { signal } = {}) {
    if (!validClaim(claim)) return false;
    const eventId = randomUUID();
    return adminDb.runTransaction(async (tx) => {
      const owned = await readOwned(tx, claim, signal);
      if (!owned) return false;
      const { taskRef, runRef, data, now } = owned;
      const nextRunAt = status === 'completed' && positive(data.intervalSeconds)
        ? now + data.intervalSeconds * 1000 : null;
      tx.update(taskRef, {
        status, workerId: null, lease: null, leaseUntil: null,
        result, error, nextRunAt, updatedAt: now,
      });
      tx.update(runRef, { status, finishedAt: now, result, error });
      tx.set(taskRef.collection('events').doc(eventId), {
        id: eventId, taskId: claim.id, runId: claim.runId, createdAt: now,
        text: status === 'completed' ? 'Research brief ready.' :
          `Run ${status}: ${error.slice(0, 300)}`,
      });
      return true;
    });
  }

  async function settleSuccess(claim, result, options) {
    if (!nonempty(result?.text) || result.error || result.ok === false) {
      throw new Error('Cannot complete a task without a nonempty successful text result.');
    }
    return finish(claim, 'completed', result, null, options);
  }

  function settleFailure(claim, error, options) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    return finish(claim, 'failed', null, message, options);
  }

  function settleInterrupted(claim, error, options) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    return finish(claim, 'interrupted', null, message, options);
  }

  return { claimTask, sweepExpiredLeases, checkOwnership, heartbeat,
    settleSuccess, settleFailure, settleInterrupted };
}
