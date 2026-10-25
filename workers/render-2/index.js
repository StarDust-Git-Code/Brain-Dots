import express from 'express';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaimer } from './lib/claim.js';
import { closeHttpServer, errorMessage } from './lib/control.js';
import { pingSelf, runTurn } from './lib/turn.js';
import { createWorker, pollIntervalFromEnv, SHUTDOWN_TIMEOUT_MS } from './lib/worker.js';

const REQUIRED_ENV = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  'VERCEL_API_URL', 'OWNER_TOKEN'];
const LEASE_MS = 5 * 60 * 1000;

export function createHttpApp({ worker, workerId, clock = Date.now }) {
  const app = express();
  app.get('/api/ping', (_req, res) =>
    res.json({ ok: true, worker: workerId, at: new Date(clock()).toISOString() }),
  );
  app.get('/api/health', (_req, res) => {
    const health = worker.health();
    res.status(health.stopping ? 503 : 200).json({
      ok: !health.stopping, worker: workerId, uptimeSeconds: Math.floor(process.uptime()),
      lastSuccessfulPingAt: health.lastSuccessfulPingAt, selfPingEnabled: health.selfPingEnabled,
      busy: health.busy, stopping: health.stopping, at: new Date(clock()).toISOString(),
    });
  });
  return app;
}

export async function main(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}.`);
  const pollIntervalMs = pollIntervalFromEnv(env);
  const port = env.PORT ? Number(env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const workerId = `render-${randomUUID()}`;
  const firebaseApp = initializeApp({
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  const claimer = createClaimer({
    adminDb: getFirestore(firebaseApp), workerId,
    leaseMs: LEASE_MS,
  });
  const worker = createWorker({
    claimer, pollIntervalMs,
    runTurn: (claim, { signal }) => runTurn(claim, {
      apiUrl: env.VERCEL_API_URL, ownerToken: env.OWNER_TOKEN, signal,
    }),
    ping: env.SELF_URL ? ({ signal }) => pingSelf(env.SELF_URL, { signal }) : null,
  });
  const server = createHttpApp({ worker, workerId }).listen(port);
  try { await once(server, 'listening'); } catch (error) {
    await deleteApp(firebaseApp);
    throw error;
  }
  let shutdownPromise;
  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    console.log(`Worker ${workerId} received ${signal}; shutting down.`);
    const hardDeadline = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    shutdownPromise = Promise.all([
      worker.stop(`Received ${signal}.`), closeHttpServer(server, SHUTDOWN_TIMEOUT_MS),
    ]).then(async ([workerStopped, serverClosed]) => {
      if (!workerStopped || !serverClosed) console.warn('Shutdown reached a deadline; any remaining lease will expire.');
      await deleteApp(firebaseApp);
      clearTimeout(hardDeadline);
      process.exit(0);
    }).catch((error) => {
      console.error(`Worker shutdown error: ${errorMessage(error)}`);
      clearTimeout(hardDeadline);
      process.exit(1);
    });
    return shutdownPromise;
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  if (!env.SELF_URL) console.warn('SELF_URL is not set; self-ping disabled.');
  console.log(`Worker ${workerId} listening on ${port}; idle poll ${pollIntervalMs}ms.`);
  worker.start();
  return { worker, server };
}

// Module/syntax checks and tests can import the service without credentials or I/O.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Worker startup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
