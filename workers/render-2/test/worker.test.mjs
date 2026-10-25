import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { getApps } from 'firebase-admin/app';
import { createHttpApp } from '../index.js';
import { createClaimer } from '../lib/claim.js';
import { closeHttpServer } from '../lib/control.js';
import { createWorker, DEFAULT_POLL_INTERVAL_MS, PING_INTERVAL_MS, pollIntervalFromEnv } from '../lib/worker.js';
import { emulatorHostFromEnv } from './helpers/emulator.mjs';
import { createMemoryFirestore, seedTask } from './helpers/memory-firestore.mjs';

const logger = { error() {}, warn() {} };
const result = { text: 'A completed brief', sources: [], sample: false };
const data = async (ref) => (await ref.get()).data();
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 1000; i += 1) {
    if (await predicate()) return;
    await delay(1);
  }
  throw new Error('Expected condition was not reached.');
}
async function fixture() {
  const db = createMemoryFirestore();
  const ref = await seedTask(db, 'task', {}, Date.now());
  const claimer = createClaimer({ adminDb: db, workerId: 'worker', leaseMs: 60_000 });
  return { db, ref, claimer };
}
function workerFor(t, options) {
  const worker = createWorker({ logger, pollIntervalMs: 10_000, ownershipIntervalMs: 10,
    heartbeatIntervalMs: 20, ownershipTimeoutMs: 500, shutdownTimeoutMs: 500,
    turnTimeoutMs: 2000, ...options });
  t.after(() => worker.stop());
  return worker;
}

test('module imports are inert and idle polling defaults to 30s with a 10-minute ping', () => {
  assert.equal(getApps().length, 0);
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 30_000);
  assert.equal(PING_INTERVAL_MS, 600_000);
  assert.equal(pollIntervalFromEnv({}), 30_000);
  assert.equal(pollIntervalFromEnv({ WORKER_POLL_INTERVAL_MS: '45000' }), 45_000);
  for (const value of ['0', '-1', '2s', 'Infinity', '2147483648']) {
    assert.throws(() => pollIntervalFromEnv({ WORKER_POLL_INTERVAL_MS: value }), /WORKER_POLL_INTERVAL_MS/);
  }
  assert.throws(() => emulatorHostFromEnv({}), /explicitly/);
  assert.throws(() => emulatorHostFromEnv({ FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }), /loopback/);
  assert.equal(emulatorHostFromEnv({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), '127.0.0.1:8080');
});

test('periodic ownership checks abort a revoked turn and discard its late response', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const started = deferred();
  const aborted = deferred();
  const response = deferred();
  const worker = workerFor(t, { claimer: f.claimer, runTurn: (claim, { signal }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    started.resolve({ claim, signal });
    return response.promise;
  } });
  worker.start();
  const { claim, signal } = await started.promise;
  const run = f.ref.collection('runs').doc(claim.runId);
  await f.ref.update({ status: 'cancelled', workerId: null, lease: null, leaseUntil: null });
  await run.update({ status: 'cancelled', finishedAt: Date.now() });
  const beforeTask = await data(f.ref);
  const beforeRun = await data(run);
  await aborted.promise;
  assert.equal(signal.aborted, true);
  assert.equal(await worker.stop(), true);
  response.resolve(result);
  await tick();
  assert.deepEqual(await data(f.ref), beforeTask);
  assert.deepEqual(await data(run), beforeRun);
  assert.equal((await f.ref.collection('events').get()).size, 1);
});

test('SIGTERM/SIGINT shutdown aborts requests/pings, interrupts owned runs and stops scheduling', { timeout: 5000 }, async (t) => {
  for (const signalName of ['SIGTERM', 'SIGINT']) {
    await t.test(signalName, async (t) => {
      const f = await fixture();
      const started = deferred();
      const pingStarted = deferred();
      const calls = { claim: 0, heartbeat: 0, ping: 0 };
      const claimer = { ...f.claimer,
        claimTask: (...args) => { calls.claim += 1; return f.claimer.claimTask(...args); },
        heartbeat: (...args) => { calls.heartbeat += 1; return f.claimer.heartbeat(...args); },
      };
      const worker = workerFor(t, { claimer, pingIntervalMs: 5,
        runTurn: (claim, { signal }) => { started.resolve({ claim, signal }); return new Promise(() => {}); },
        ping: ({ signal }) => { calls.ping += 1; pingStarted.resolve(signal); return new Promise(() => {}); },
      });
      worker.start();
      const { claim, signal } = await started.promise;
      const pingSignal = await pingStarted.promise;
      assert.equal(await worker.stop(`Received ${signalName}.`), true);
      assert.equal(signal.aborted, true);
      assert.equal(pingSignal.aborted, true);
      const task = await data(f.ref);
      const run = await data(f.ref.collection('runs').doc(claim.runId));
      assert.equal(task.status, 'interrupted');
      assert.equal(task.lease, null);
      assert.match(task.error, new RegExp(signalName));
      assert.equal(run.status, 'interrupted');
      assert.ok(run.finishedAt);
      assert.equal((await f.ref.collection('events').get()).size, 2);
      const stoppedCalls = { ...calls };
      await delay(40);
      assert.deepEqual(calls, stoppedCalls);
      assert.deepEqual(await data(f.ref), task);
    });
  }
});

test('a claim commit already in flight at shutdown is interrupted without an agent request', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const claim = await f.claimer.claimTask();
  const entered = deferred();
  const pending = deferred();
  let turns = 0;
  const worker = workerFor(t, {
    claimer: { ...f.claimer, claimTask: () => { entered.resolve(); return pending.promise; } },
    runTurn: async () => { turns += 1; return result; },
  });
  worker.start();
  await entered.promise;
  const stopping = worker.stop('SIGTERM.');
  pending.resolve(claim);
  assert.equal(await stopping, true);
  assert.equal(turns, 0);
  assert.equal((await data(f.ref)).status, 'interrupted');
  assert.equal((await data(f.ref.collection('runs').doc(claim.runId))).status, 'interrupted');
});

test('shutdown during failure settlement interrupts the owned run and rejects the late failure', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const settling = deferred();
  const release = deferred();
  const worker = workerFor(t, {
    claimer: { ...f.claimer, settleFailure: async (claim, error, options) => {
      settling.resolve(options.signal);
      await release.promise;
      return f.claimer.settleFailure(claim, error, options);
    } },
    runTurn: async () => { throw new Error('HTTP 500'); },
  });
  worker.start();
  const signal = await settling.promise;
  assert.equal(await worker.stop('SIGTERM during failure persistence.'), true);
  assert.equal(signal.aborted, true);
  const task = await data(f.ref);
  assert.equal(task.status, 'interrupted');
  assert.match(task.error, /SIGTERM/);
  assert.equal((await data(f.ref.collection('runs').doc(task.runId))).status, 'interrupted');
  assert.equal((await f.ref.collection('events').get()).size, 2);
  release.resolve();
  await tick();
  assert.deepEqual(await data(f.ref), task);
});

test('shutdown cancels an idle 30s sleep and bounds an unresponsive claim RPC', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const idle = workerFor(t, { pollIntervalMs: 30_000,
    claimer: { ...f.claimer, claimTask: async () => null }, runTurn: async () => result });
  idle.start();
  await tick();
  assert.equal(await idle.stop(), true);
  const blocked = workerFor(t, { shutdownTimeoutMs: 30,
    claimer: { ...f.claimer, claimTask: () => new Promise(() => {}) }, runTurn: async () => result });
  blocked.start();
  assert.equal(await blocked.stop(), false);
  assert.equal(blocked.health().stopping, true);
});

test('a turn timeout records interrupted/unconfirmed work without automatically retrying it', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const worker = workerFor(t, { claimer: f.claimer, turnTimeoutMs: 30,
    runTurn: () => new Promise(() => {}) });
  worker.start();
  await until(async () => (await data(f.ref)).status === 'interrupted');
  assert.match((await data(f.ref)).error, /timed out.*unconfirmed/);
  assert.equal(await f.claimer.claimTask(), null);
  assert.equal(await worker.stop(), true);
});

test('health records only successful self-pings and shutdown cancels a pending ping', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const failed = deferred();
  const secondStarted = deferred();
  const succeed = deferred();
  const thirdStarted = deferred();
  let calls = 0;
  const worker = workerFor(t, {
    claimer: { ...f.claimer, claimTask: async () => null }, runTurn: async () => result,
    pingIntervalMs: 10,
    ping: ({ signal }) => {
      calls += 1;
      if (calls === 1) { failed.resolve(); throw new Error('HTTP 503'); }
      if (calls === 2) { secondStarted.resolve(); return succeed.promise; }
      thirdStarted.resolve(signal);
      return new Promise(() => {});
    },
  });
  worker.start();
  await failed.promise;
  await tick();
  assert.equal(worker.health().lastSuccessfulPingAt, null);
  await secondStarted.promise;
  succeed.resolve();
  await until(() => worker.health().lastSuccessfulPingAt !== null);
  const at = worker.health().lastSuccessfulPingAt;
  assert.ok(Number.isFinite(Date.parse(at)));
  const signal = await thirdStarted.promise;
  assert.equal(await worker.stop(), true);
  assert.equal(signal.aborted, true);
  assert.equal(worker.health().lastSuccessfulPingAt, at);
  const stoppedCalls = calls;
  await delay(25);
  assert.equal(calls, stoppedCalls);
});

test('HTTP health exposes uptime/ping history without task proofs or configuration secrets', { timeout: 3000 }, async (t) => {
  const f = await fixture();
  const worker = workerFor(t, { claimer: f.claimer, runTurn: async () => result });
  const publicWorker = { health: () => ({ ...worker.health(), OWNER_TOKEN: 'do-not-expose', lease: 'do-not-expose' }) };
  const server = createHttpApp({ worker: publicWorker, workerId: 'test-worker' }).listen(0, '127.0.0.1');
  t.after(() => closeHttpServer(server));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.equal(health.worker, 'test-worker');
  assert.ok(Number.isInteger(health.uptimeSeconds));
  assert.equal(health.lastSuccessfulPingAt, null);
  assert.equal(JSON.stringify(health).includes('do-not-expose'), false);
  assert.equal((await fetch(`${url}/api/ping`)).status, 200);
  await worker.stop();
  assert.equal((await fetch(`${url}/api/health`)).status, 503);
  assert.equal(await closeHttpServer(server), true);
  assert.equal(server.listening, false);
});

test('HTTP shutdown force-closes a stuck connection within its deadline', { timeout: 3000 }, async () => {
  const entered = deferred();
  const server = createServer(() => entered.resolve());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = fetch(`http://127.0.0.1:${server.address().port}`).catch(() => undefined);
  await entered.promise;
  const closed = once(server, 'close');
  assert.equal(await closeHttpServer(server, 30), false);
  await closed;
  await request;
  assert.equal(server.listening, false);
});
