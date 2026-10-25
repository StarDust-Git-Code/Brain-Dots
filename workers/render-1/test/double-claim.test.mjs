import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaimer } from '../lib/claim.js';
import { createEmulatorFixture } from './helpers/emulator.mjs';
import { seedTask } from './helpers/memory-firestore.mjs';

const data = async (ref) => (await ref.get()).data();
const result = (text) => ({ text, sources: [], sample: false });

// Explicit loopback emulator only; the fixture always uses an isolated demo-*
// project and never loads production credentials/project configuration.
test('Firestore emulator lease/race/settlement integration', { timeout: 60_000 }, async (t) => {
  const { db, cleanup } = await createEmulatorFixture();
  t.after(cleanup);
  let now = Date.now();
  const make = (workerId, clock = () => now, adminDb = db) =>
    createClaimer({ adminDb, workerId, leaseMs: 60_000, clock });
  const a = make('worker-a');
  const b = make('worker-b');
  const owner = (claim) => claim.workerId === 'worker-a' ? a : b;
  const queued = await seedTask(db, 'queued', {}, now);
  const recurring = await seedTask(db, 'recurring', {
    status: 'completed', intervalSeconds: 300, nextRunAt: now - 1,
  }, now);
  let queuedClaim;
  let recurringClaim;

  await t.test('simultaneous fresh/recurring claim has one stable run and lease each', async () => {
    const claims = await Promise.all([a.claimTask(), b.claimTask()]);
    assert.deepEqual(claims.map((claim) => claim.id).sort(), ['queued', 'recurring']);
    queuedClaim = claims.find((claim) => claim.id === queued.id);
    recurringClaim = claims.find((claim) => claim.id === recurring.id);
    for (const [ref, claim] of [[queued, queuedClaim], [recurring, recurringClaim]]) {
      const task = await data(ref);
      assert.equal(task.status, 'running');
      assert.equal(task.runId, claim.runId);
      assert.equal(task.lease, claim.lease);
      assert.equal(task.workerId, claim.workerId);
      assert.equal((await ref.collection('runs').get()).size, 1);
      assert.equal((await ref.collection('events').get()).size, 1);
    }
  });

  await t.test('cancel then late heartbeat/completion cannot overwrite parent action', async () => {
    const run = queued.collection('runs').doc(queuedClaim.runId);
    await db.runTransaction(async (tx) => {
      await tx.get(queued);
      await tx.get(run);
      tx.update(queued, { status: 'cancelled', workerId: null, lease: null, leaseUntil: null });
      tx.update(run, { status: 'cancelled', finishedAt: now });
    });
    assert.equal(await owner(queuedClaim).heartbeat(queuedClaim), false);
    assert.equal(await owner(queuedClaim).settleSuccess(queuedClaim, result('late')), false);
    assert.equal(await owner(queuedClaim).settleFailure(queuedClaim, 'late failure'), false);
    assert.equal((await data(queued)).status, 'cancelled');
    assert.equal((await data(run)).status, 'cancelled');
    assert.equal((await queued.collection('events').get()).size, 1);
  });

  await t.test('recurring success persists independent completed records and events', async () => {
    assert.equal(await owner(recurringClaim).settleSuccess(recurringClaim, result('first')), true);
    const firstRun = await data(recurring.collection('runs').doc(recurringClaim.runId));
    now = (await data(recurring)).nextRunAt;
    const claims = (await Promise.all([a.claimTask(), b.claimTask()])).filter(Boolean);
    assert.equal(claims.length, 1);
    const [second] = claims;
    assert.notEqual(second.runId, recurringClaim.runId);
    assert.notEqual(second.lease, recurringClaim.lease);
    assert.equal(await owner(second).heartbeat(second), true);
    assert.equal(await owner(second).settleSuccess(second, result('second')), true);
    assert.deepEqual(await data(recurring.collection('runs').doc(recurringClaim.runId)), firstRun);
    assert.equal((await recurring.collection('runs').get()).size, 2);
    assert.equal((await recurring.collection('events').get()).size, 4);
    assert.equal((await data(recurring)).result.text, 'second');
    await recurring.update({ status: 'paused', nextRunAt: null });
  });

  let interrupted;
  let expiredClaim;
  await t.test('competing sweeps atomically interrupt a run and do not retry it', async () => {
    interrupted = await seedTask(db, 'interrupted', { intervalSeconds: 300 }, now);
    expiredClaim = await a.claimTask();
    now = expiredClaim.leaseUntil;
    assert.equal(await a.heartbeat(expiredClaim), false);
    const counts = await Promise.all([a.sweepExpiredLeases(), b.sweepExpiredLeases()]);
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
    assert.equal((await data(interrupted)).status, 'interrupted');
    assert.equal((await data(interrupted.collection('runs').doc(expiredClaim.runId))).status, 'interrupted');
    assert.equal((await interrupted.collection('events').get()).size, 2);
    await interrupted.update({ nextRunAt: now - 1 });
    assert.equal(await a.claimTask(), null);
    assert.equal(await b.claimTask(), null);
  });

  await t.test('explicit retry creates a new run; the old heartbeat/result stays stale', async () => {
    await interrupted.update({ status: 'queued' });
    const retry = await b.claimTask();
    assert.notEqual(retry.runId, expiredClaim.runId);
    assert.notEqual(retry.lease, expiredClaim.lease);
    assert.equal(await a.heartbeat(expiredClaim), false);
    assert.equal(await a.settleSuccess(expiredClaim, result('late')), false);
    assert.equal(await b.settleSuccess(retry, result('reviewed retry')), true);
    assert.equal((await interrupted.collection('runs').get()).size, 2);
    assert.equal((await data(interrupted.collection('runs').doc(expiredClaim.runId))).status, 'interrupted');
    await interrupted.update({ status: 'paused', nextRunAt: null });
  });

  await t.test('a heartbeat committing after the expired query is not overwritten by the sweep', async () => {
    const ref = await seedTask(db, 'sweep-race', {}, now);
    const claim = await a.claimTask();
    now = claim.leaseUntil;
    // Model a heartbeat authorized just before expiry but committed after the
    // sweep's candidate query. All subsequent reads/commits are real Firestore.
    const pendingHeartbeat = make(claim.workerId, () => claim.leaseUntil - 1);
    let injected = false;
    function wrap(query, expiredQuery = false) {
      return {
        where: (field, op, value) => wrap(query.where(field, op, value), expiredQuery || field === 'leaseUntil'),
        orderBy: (...args) => wrap(query.orderBy(...args), expiredQuery),
        limit: (...args) => wrap(query.limit(...args), expiredQuery),
        doc: (...args) => query.doc(...args),
        get: async () => {
          const snapshot = await query.get();
          if (expiredQuery && !injected) {
            injected = true;
            assert.equal(await pendingHeartbeat.heartbeat(claim), true);
          }
          return snapshot;
        },
      };
    }
    const sweeper = make('sweeper', () => now, {
      collection: (name) => wrap(db.collection(name)),
      runTransaction: (...args) => db.runTransaction(...args),
    });
    assert.equal(await sweeper.sweepExpiredLeases(), 0);
    assert.equal(injected, true);
    assert.equal((await data(ref)).status, 'running');
    assert.equal((await data(ref.collection('runs').doc(claim.runId))).status, 'running');
    assert.equal((await ref.collection('events').get()).size, 1);
    assert.equal(await a.settleInterrupted(claim, 'Test cleanup interruption.'), true);
  });
});
