import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaimer } from '../lib/claim.js';
import { createMemoryFirestore, seedTask } from './helpers/memory-firestore.mjs';

const result = (text = 'A completed brief') => ({ text, sources: [], sample: false });
const data = async (ref) => (await ref.get()).data();
const records = async (ref, collection) => (await ref.collection(collection).get()).docs.map((doc) => doc.data());

function fixture() {
  let now = 1_000_000;
  const db = createMemoryFirestore();
  const make = (workerId) => createClaimer({ adminDb: db, workerId, leaseMs: 60_000, clock: () => now });
  const a = make('worker-a');
  const b = make('worker-b');
  return { db, a, b, make, now: () => now, advance: (ms) => { now += ms; },
    setNow: (value) => { now = value; }, owner: (claim) => claim.workerId === 'worker-a' ? a : b };
}

test('simultaneous claimers create exactly one owned run for a queued or due recurring task', async (t) => {
  for (const kind of ['queued', 'recurring']) {
    await t.test(kind, async () => {
      const f = fixture();
      const ref = await seedTask(f.db, 'task', kind === 'queued' ? {} : {
        status: 'completed', intervalSeconds: 60, nextRunAt: f.now() - 1,
      });
      const claims = (await Promise.all([f.a.claimTask(), f.b.claimTask()])).filter(Boolean);
      assert.equal(claims.length, 1);
      const [claim] = claims;
      const task = await data(ref);
      assert.equal(task.status, 'running');
      assert.equal(task.workerId, claim.workerId);
      assert.equal(task.lease, claim.lease);
      assert.equal(task.runId, claim.runId);
      assert.equal(task.nextRunAt, null);
      const runs = await records(ref, 'runs');
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, claim.runId);
      assert.equal(runs[0].lease, claim.lease);
      assert.equal(runs[0].workerId, claim.workerId);
      assert.equal(runs[0].status, 'running');
      assert.equal((await records(ref, 'events')).length, 1);
    });
  }
});

test('two workers concurrently claim different fresh and recurring jobs without duplicates', async () => {
  const f = fixture();
  const queued = await seedTask(f.db, 'queued');
  const recurring = await seedTask(f.db, 'recurring', {
    status: 'completed', intervalSeconds: 60, nextRunAt: f.now() - 1,
  });
  const claims = await Promise.all([f.a.claimTask(), f.b.claimTask()]);
  assert.deepEqual(claims.map((claim) => claim.id).sort(), ['queued', 'recurring']);
  for (const ref of [queued, recurring]) {
    assert.equal((await records(ref, 'runs')).length, 1);
    assert.equal((await records(ref, 'events')).length, 1);
  }
});

test('transaction retries keep the same runId, lease and start event', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task');
  const attempts = [];
  f.db.beforeCommit = async (tx) => {
    const write = tx.writes.find((entry) => entry.path === ref.path && entry.data.status === 'running');
    if (!write) return;
    attempts.push({ runId: write.data.runId, lease: write.data.lease,
      event: tx.writes.find((entry) => entry.path.includes('/events/')).path });
    if (attempts.length === 1) await ref.update({ updatedAt: f.now() + 1 });
  };
  const claim = await f.a.claimTask();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(claim.runId, attempts[0].runId);
  assert.equal((await records(ref, 'runs')).length, 1);
  assert.equal((await records(ref, 'events')).length, 1);
});

test('a stale heartbeat cannot extend an explicitly retried run, even with the same workerId', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task');
  const old = await f.a.claimTask();
  assert.equal(await f.a.settleInterrupted(old, 'Stopped; review effects before retrying.'), true);
  await ref.update({ status: 'queued' });
  const current = await f.a.claimTask();
  assert.notEqual(current.runId, old.runId);
  assert.notEqual(current.lease, old.lease);
  f.advance(5000);
  const before = await data(ref);
  assert.equal(await f.a.heartbeat(old), false);
  assert.equal(await f.a.heartbeat(old.id), false);
  assert.equal(await f.b.heartbeat(current), false);
  assert.deepEqual(await data(ref), before);
  assert.equal(await f.a.heartbeat(current), true);
  assert.equal((await data(ref)).leaseUntil, f.now() + 60_000);
  assert.equal((await data(ref.collection('runs').doc(current.runId))).leaseUntil, f.now() + 60_000);
  assert.equal((await data(ref.collection('runs').doc(old.runId))).status, 'interrupted');
});

test('expired ownership cannot be heartbeated or settled, including on a transaction retry', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task');
  const claim = await f.a.claimTask();
  f.db.beforeCommit = async (tx) => {
    if (!tx.writes.some((write) => write.path === ref.path && write.data.leaseUntil)) return;
    f.db.beforeCommit = null;
    f.setNow(claim.leaseUntil);
    await ref.update({ updatedAt: f.now() });
  };
  assert.equal(await f.a.heartbeat(claim), false);
  const before = await data(ref);
  assert.equal(before.leaseUntil, claim.leaseUntil);
  assert.equal(await f.a.checkOwnership(claim), false);
  assert.equal(await f.a.heartbeat(claim), false);
  assert.equal(await f.a.settleSuccess(claim, result()), false);
  assert.equal(await f.a.settleFailure(claim, 'late failure'), false);
  assert.equal(await f.a.settleInterrupted(claim, 'late interruption'), false);
  assert.deepEqual(await data(ref), before);
  assert.equal((await records(ref, 'events')).length, 1);
});

test('heartbeat and settlement require running task AND matching task/run ownership', async (t) => {
  const changes = [
    ['paused with retained lease', 'task', { status: 'paused' }],
    ['cancelled with retained lease', 'task', { status: 'cancelled' }],
    ['different task worker', 'task', { workerId: 'worker-b' }],
    ['different task lease', 'task', { lease: 'replacement-lease' }],
    ['different task run', 'task', { runId: 'replacement-run' }],
    ['finished run', 'run', { status: 'completed' }],
    ['different run worker', 'run', { workerId: 'worker-b' }],
    ['different run lease', 'run', { lease: 'replacement-lease' }],
    ['expired run lease', 'run', { leaseUntil: 1_000_000 }],
  ];
  for (const [name, target, changeset] of changes) {
    await t.test(name, async () => {
      const f = fixture();
      const ref = await seedTask(f.db, 'task');
      const claim = await f.a.claimTask();
      const run = ref.collection('runs').doc(claim.runId);
      await (target === 'task' ? ref : run).update(changeset);
      const beforeTask = await data(ref);
      const beforeRun = await data(run);
      assert.equal(await f.a.checkOwnership(claim), false);
      assert.equal(await f.a.heartbeat(claim), false);
      assert.equal(await f.a.settleSuccess(claim, result()), false);
      assert.equal(await f.a.settleFailure(claim, 'late failure'), false);
      assert.equal(await f.a.settleInterrupted(claim, 'late interruption'), false);
      assert.deepEqual(await data(ref), beforeTask);
      assert.deepEqual(await data(run), beforeRun);
      assert.equal((await records(ref, 'events')).length, 1);
    });
  }
});

test('expired sweep re-reads tasks changed by a heartbeat or completion after query/read', async (t) => {
  for (const boundary of ['query', 'commit']) {
    for (const action of ['heartbeat', 'completion']) {
      await t.test(`${action} wins at ${boundary} boundary`, async () => {
        const f = fixture();
        const ref = await seedTask(f.db, 'task');
        const claim = await f.a.claimTask();
        const runRef = ref.collection('runs').doc(claim.runId);
        f.setNow(claim.leaseUntil);
        const mutate = async () => {
          // An independent writer has committed after the stale sweep snapshot.
          await f.db.runTransaction(async (tx) => {
            await tx.get(ref);
            await tx.get(runRef);
            if (action === 'heartbeat') {
              tx.update(ref, { leaseUntil: f.now() + 60_000 });
              tx.update(runRef, { leaseUntil: f.now() + 60_000 });
            } else {
              tx.update(ref, { status: 'completed', lease: null, leaseUntil: null,
                workerId: null, result: result() });
              tx.update(runRef, { status: 'completed', finishedAt: f.now(), result: result() });
            }
          });
        };
        if (boundary === 'query') {
          f.db.afterQuery = async (query) => {
            if (!query.filters.some(([field]) => field === 'leaseUntil')) return;
            f.db.afterQuery = null;
            await mutate();
          };
        } else {
          f.db.beforeCommit = async (tx) => {
            if (!tx.writes.some((write) => write.path === ref.path && write.data.status === 'interrupted')) return;
            f.db.beforeCommit = null;
            await mutate();
          };
        }
        assert.equal(await f.b.sweepExpiredLeases(), 0);
        assert.equal((await data(ref)).status, action === 'heartbeat' ? 'running' : 'completed');
        assert.equal((await data(runRef)).status, action === 'heartbeat' ? 'running' : 'completed');
        assert.equal((await records(ref, 'events')).length, 1);
      });
    }
  }
});

test('competing expired sweeps interrupt the task, its run and one event atomically', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task', { intervalSeconds: 60 });
  const claim = await f.a.claimTask();
  f.setNow(claim.leaseUntil);
  const counts = await Promise.all([f.a.sweepExpiredLeases(), f.b.sweepExpiredLeases()]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
  const task = await data(ref);
  const run = await data(ref.collection('runs').doc(claim.runId));
  assert.equal(task.status, 'interrupted');
  assert.equal(task.lease, null);
  assert.equal(task.workerId, null);
  assert.equal(task.nextRunAt, null);
  assert.match(task.error, /Review completed effects before retrying/);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.finishedAt, f.now());
  assert.equal(run.error, task.error);
  const events = await records(ref, 'events');
  assert.equal(events.length, 2);
  assert.equal(events.filter((event) => event.text.includes('lease expired')).length, 1);
  assert.equal(await f.a.sweepExpiredLeases(), 0);
  await ref.update({ nextRunAt: f.now() - 1 });
  assert.equal(await f.a.claimTask(), null);
  assert.equal(await f.b.claimTask(), null);
});

test('expiry also closes a legacy running record without task.runId or run ownership fields', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'legacy', {
    status: 'running', workerId: 'old-worker', lease: 'old-lease', leaseUntil: f.now() - 1,
  });
  const run = ref.collection('runs').doc('legacy-run');
  await run.set({ id: run.id, taskId: ref.id, status: 'running', startedAt: f.now() - 1000 });
  assert.equal(await f.b.sweepExpiredLeases(), 1);
  assert.equal((await data(ref)).status, 'interrupted');
  assert.equal((await data(run)).status, 'interrupted');
  assert.equal((await records(ref, 'events')).length, 1);
});

test('cancel then late completion/failure never overwrites parent task actions', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task');
  const claim = await f.a.claimTask();
  const run = ref.collection('runs').doc(claim.runId);
  await ref.update({ status: 'cancelled', lease: null, leaseUntil: null, workerId: null });
  await run.update({ status: 'cancelled', finishedAt: f.now() });
  const beforeTask = await data(ref);
  const beforeRun = await data(run);
  assert.equal(await f.a.heartbeat(claim), false);
  assert.equal(await f.a.settleSuccess(claim, result()), false);
  assert.equal(await f.a.settleFailure(claim, 'late error'), false);
  assert.deepEqual(await data(ref), beforeTask);
  assert.deepEqual(await data(run), beforeRun);
  assert.equal((await records(ref, 'events')).length, 1);
});

test('a cancellation racing the completion transaction wins its re-read', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task');
  const claim = await f.a.claimTask();
  f.db.beforeCommit = async (tx) => {
    if (!tx.writes.some((write) => write.path === ref.path && write.data.status === 'completed')) return;
    f.db.beforeCommit = null;
    await ref.update({ status: 'cancelled', lease: null, leaseUntil: null, workerId: null });
  };
  assert.equal(await f.a.settleSuccess(claim, result()), false);
  assert.equal((await data(ref)).status, 'cancelled');
  assert.equal((await data(ref.collection('runs').doc(claim.runId))).status, 'running');
  assert.equal((await records(ref, 'events')).length, 1);
});

test('interrupted jobs require an explicit queued retry and preserve the interrupted run', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task', { intervalSeconds: 60 });
  const first = await f.a.claimTask();
  assert.equal(await f.a.settleInterrupted(first, 'SIGTERM; review effects before retrying.'), true);
  await ref.update({ nextRunAt: f.now() - 1000 });
  assert.equal(await f.b.claimTask(), null);
  assert.equal(await f.a.claimTask(), null);
  await ref.update({ status: 'queued' });
  const second = await f.b.claimTask();
  assert.notEqual(second.runId, first.runId);
  assert.notEqual(second.lease, first.lease);
  assert.equal(await f.a.settleSuccess(first, result('late result')), false);
  assert.equal(await f.b.settleSuccess(second, result('reviewed retry')), true);
  const runs = await records(ref, 'runs');
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.id === first.runId).status, 'interrupted');
  assert.equal(runs.find((run) => run.id === second.runId).result.text, 'reviewed retry');
  assert.equal((await records(ref, 'events')).length, 4);
});

test('recurring completions persist separate run results/events and schedule from current task settings', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task', { intervalSeconds: 60 });
  const first = await f.a.claimTask();
  f.advance(1000);
  assert.equal(await f.a.settleSuccess(first, result('first brief')), true);
  const firstRun = await data(ref.collection('runs').doc(first.runId));
  assert.equal((await data(ref)).nextRunAt, f.now() + 60_000);
  f.advance(59_999);
  assert.equal(await f.b.claimTask(), null);
  f.advance(1);
  const claims = (await Promise.all([f.a.claimTask(), f.b.claimTask()])).filter(Boolean);
  assert.equal(claims.length, 1);
  const [second] = claims;
  assert.notEqual(second.runId, first.runId);
  assert.notEqual(second.lease, first.lease);
  assert.equal((await data(ref)).nextRunAt, null);
  await ref.update({ intervalSeconds: 120 });
  f.advance(500);
  assert.equal(await f.owner(second).settleSuccess(second, result('second brief')), true);
  assert.equal((await data(ref)).nextRunAt, f.now() + 120_000);
  assert.equal((await data(ref)).result.text, 'second brief');
  assert.deepEqual(await data(ref.collection('runs').doc(first.runId)), firstRun);
  const runs = await records(ref, 'runs');
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.status === 'completed' && run.finishedAt !== null && run.error === null));
  assert.equal(runs.find((run) => run.id === second.runId).result.text, 'second brief');
  const events = await records(ref, 'events');
  assert.equal(events.length, 4);
  assert.equal(events.filter((event) => event.runId === second.runId).length, 2);
});

test('fresh and recurring claiming is fair and oldest-first within each class', async () => {
  const f = fixture();
  await seedTask(f.db, 'queued-old', { createdAt: f.now() - 200 });
  await seedTask(f.db, 'queued-new', { createdAt: f.now() - 100 });
  await seedTask(f.db, 'recurring-old', {
    status: 'completed', intervalSeconds: 30, nextRunAt: f.now() - 200,
  });
  await seedTask(f.db, 'recurring-new', {
    status: 'completed', intervalSeconds: 30, nextRunAt: f.now() - 100,
  });
  const order = [];
  for (let i = 0; i < 4; i += 1) order.push((await f.a.claimTask()).id);
  assert.deepEqual(order, ['queued-old', 'recurring-old', 'queued-new', 'recurring-new']);
});

test('success settlement rejects empty or error-shaped results without writing anything', async () => {
  const f = fixture();
  const ref = await seedTask(f.db, 'task');
  const claim = await f.a.claimTask();
  for (const invalid of [{ error: 'failure' }, { text: '  ' }, { text: 'brief', error: 'failure' }]) {
    await assert.rejects(f.a.settleSuccess(claim, invalid), /nonempty successful text/);
  }
  assert.equal((await data(ref)).status, 'running');
  assert.equal((await records(ref, 'events')).length, 1);
});
