import { randomUUID } from 'node:crypto';

// No Firebase initialization, environment mutation or network traffic on import.
export function emulatorHostFromEnv(env = process.env) {
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('Set FIRESTORE_EMULATOR_HOST explicitly to run emulator tests.');
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(host);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error('Emulator tests require a loopback FIRESTORE_EMULATOR_HOST with a valid port.');
  }
  return host;
}

export async function createEmulatorFixture(env = process.env) {
  const host = emulatorHostFromEnv(env);
  try {
    const response = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
  } catch {
    throw new Error(`Firestore emulator unreachable at ${host}; start it before running test:emulator.`);
  }
  // Ignore live project/credential variables. A unique demo project isolates the
  // two packages' integration tests even when they run concurrently.
  process.env.FIRESTORE_EMULATOR_HOST = host;
  const projectId = `demo-opendots-workers-${randomUUID().slice(0, 8)}`;
  const { initializeApp, deleteApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp({ projectId }, projectId);
  const db = getFirestore(app);
  db.settings({ host, ssl: false });
  return {
    db,
    async cleanup() {
      try {
        const tasks = await db.collection('tasks').get();
        for (const task of tasks.docs) await db.recursiveDelete(task.ref);
      } finally {
        await deleteApp(app);
      }
    },
  };
}
