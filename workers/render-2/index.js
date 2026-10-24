import express from 'express';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { createClaimer } from './lib/claim.js';

const REQUIRED_ENV = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];

const WORKER_ID = `render-${randomUUID()}`;
const SELF_URL = process.env.SELF_URL;
const VERCEL_API_URL = process.env.VERCEL_API_URL;
const OWNER_TOKEN = process.env.OWNER_TOKEN;

const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60 seconds
const LEASE_MS = 5 * 60 * 1000; // 5 minute lease
const POLL_INTERVAL_MS = 2000;
const TURN_TIMEOUT_MS = 85_000;
const SHUTDOWN_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exitSoon(message) {
  console.error(message);
  console.error(`Worker ${WORKER_ID} will exit in ${SHUTDOWN_DELAY_MS / 1000}s.`);
  setTimeout(() => process.exit(1), SHUTDOWN_DELAY_MS);
}

async function runTurn(claim) {
  const res = await fetch(`${VERCEL_API_URL}/api/copilotkit/agent/${claim.dotId || 'default'}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(OWNER_TOKEN ? { Authorization: `Bearer ${OWNER_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      threadId: claim.threadId,
      messages: [{ role: 'user', content: claim.prompt }],
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vercel API returned ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json().catch(() => null);
  const text =
    typeof data?.text === 'string' && data.text.length > 0 ? data.text : data ? JSON.stringify(data) : '';
  return { text, sources: [], sample: false };
}

async function main() {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });

  if (!VERCEL_API_URL) {
    console.warn('VERCEL_API_URL is not set; every run will fail until it is provided.');
  }

  const claimer = createClaimer({
    adminDb: getFirestore(),
    workerId: WORKER_ID,
    leaseMs: LEASE_MS,
  });

  // Self-ping to stay awake on Render free tier
  if (SELF_URL) {
    setInterval(async () => {
      try {
        await fetch(`${SELF_URL}/api/ping`);
      } catch {
        // ignore ping failures
      }
    }, PING_INTERVAL_MS);
  } else {
    console.warn('SELF_URL is not set; self-ping disabled (service may spin down on Render free tier).');
  }

  async function loop() {
    while (true) {
      let claim = null;
      try {
        claim = await claimer.claimTask();
      } catch (e) {
        console.error('worker loop error:', e instanceof Error ? e.message : String(e));
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (!claim) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Keep the lease alive while the turn is in flight.
      const heartbeat = setInterval(() => {
        claimer.heartbeat(claim.id).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);

      try {
        const result = await runTurn(claim);
        const settled = await claimer.settleSuccess(claim, result);
        if (!settled) {
          console.error('worker loop error: lease no longer held; run result discarded');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        try {
          const settled = await claimer.settleFailure(claim, message);
          if (!settled) {
            console.error('worker loop error: lease no longer held; failure not recorded');
          }
        } catch (se) {
          console.error('worker loop error:', se instanceof Error ? se.message : String(se));
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  const app = express();
  app.get('/api/ping', (_req, res) =>
    res.json({ ok: true, worker: WORKER_ID, at: new Date().toISOString() }),
  );
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      worker: WORKER_ID,
      uptimeSeconds: Math.round(process.uptime()),
      at: new Date().toISOString(),
    }),
  );

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`Worker ${WORKER_ID} listening on ${PORT}`);
    void loop();
  });
}

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  exitSoon(
    `Missing required environment variables: ${missing.join(', ')}. ` +
      'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY before starting the worker.',
  );
} else {
  main().catch((e) => exitSoon(`Worker startup failed: ${e instanceof Error ? e.message : String(e)}`));
}
