import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createClaimer } from '../lib/claim.js';

// Standalone double-claim test against the Firestore emulator. No test framework.
// Run from workers/render-1 or workers/render-2:  npm run test:emulator
// Requires the Firestore emulator on FIRESTORE_EMULATOR_HOST (default localhost:8080).

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'opendots-emulator-test';

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
}

async function emulatorReachable() {
  try {
    await fetch(`http://${EMULATOR_HOST}/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function deleteTaskCompletely(db, ref) {
  for (const sub of ['runs', 'events']) {
    const snap = await ref.collection(sub).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await ref.delete();
}

async function main() {
  if (!(await emulatorReachable())) {
    console.error(`Firestore emulator unreachable at ${EMULATOR_HOST}.`);
    console.error('Start the emulator first, then re-run this test:');
    console.error('  1. From the repo root: firebase emulators:start --only firestore');
    console.error('     (Firestore emulator listens on localhost:8080 by default.)');
    console.error('  2. From workers/render-1 or workers/render-2: npm run test:emulator');
    process.exit(1);
  }

  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  const tasks = db.collection('tasks');

  const now = Date.now();
  const baseDoc = (overrides = {}) => ({
    userId: 'test-user',
    prompt: 'double-claim test prompt',
    status: 'queued',
    intervalSeconds: null,
    nextRunAt: null,
    threadId: 'test-thread',
    dotId: 'test-dot',
    workerId: null,
    lease: null,
    leaseUntil: null,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    error: null,
    result: null,
    ...overrides,
  });

  const queuedRef = tasks.doc(`test-queued-${randomUUID()}`);
  const recurringRef = tasks.doc(`test-recurring-${randomUUID()}`);
  await queuedRef.set(baseDoc());
  await recurringRef.set(
    baseDoc({ status: 'completed', intervalSeconds: 300, nextRunAt: now - 1_000 }),
  );

  const claimerA = createClaimer({ adminDb: db, workerId: 'test-worker-a', leaseMs: 60_000 });
  const claimerB = createClaimer({ adminDb: db, workerId: 'test-worker-b', leaseMs: 60_000 });

  try {
    const [claimA, claimB] = await Promise.all([claimerA.claimTask(), claimerB.claimTask()]);
    const claims = [claimA, claimB];

    const queuedClaims = claims.filter((c) => c && c.id === queuedRef.id);
    report(
      'exactly one claimer won the queued task',
      queuedClaims.length === 1,
      `queued claims: ${queuedClaims.length}`,
    );

    const recurringClaims = claims.filter((c) => c && c.id === recurringRef.id);
    report(
      'exactly one claimer won the recurring task (no double-start)',
      recurringClaims.length === 1,
      `recurring claims: ${recurringClaims.length}`,
    );

    const queuedDoc = await queuedRef.get();
    const q = queuedDoc.data() ?? {};
    report(
      'queued task doc is running under a lease',
      queuedDoc.exists && q.status === 'running' && !!q.lease && !!q.workerId,
      `status=${q.status} workerId=${q.workerId ?? 'null'}`,
    );

    const qRuns = await queuedRef.collection('runs').where('status', '==', 'running').get();
    report('queued task has exactly 1 running run', qRuns.size === 1, `running runs: ${qRuns.size}`);

    const recurringDoc = await recurringRef.get();
    const r = recurringDoc.data() ?? {};
    report(
      'recurring task doc is running under a lease',
      recurringDoc.exists && r.status === 'running' && !!r.lease,
      `status=${r.status}`,
    );

    const rRunsAll = await recurringRef.collection('runs').get();
    report('recurring task has exactly 1 run total', rRunsAll.size === 1, `runs: ${rRunsAll.size}`);
    const rRunsRunning = await recurringRef
      .collection('runs')
      .where('status', '==', 'running')
      .get();
    report(
      'recurring task has exactly 1 running run',
      rRunsRunning.size === 1,
      `running runs: ${rRunsRunning.size}`,
    );
  } finally {
    await deleteTaskCompletely(db, queuedRef).catch(() => {});
    await deleteTaskCompletely(db, recurringRef).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? 'ALL TESTS PASSED' : `${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('test error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
