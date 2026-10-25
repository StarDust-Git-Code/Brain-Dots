# OpenDots background workers

`render-1/` and `render-2/` are byte-identical, independently deployable Node.js web
services. Each contains its own runtime, claim library, dependencies and tests; service
imports stay inside its Render Root Directory. Use Node.js 20 or newer.

```
workers/
  lib/claim.js                 synchronized reference copy of the claim library
  render-1/                   Render web service #1
  render-2/                   Render web service #2
    lib/                      local claim, request/cancellation and scheduling code
    test/                     node:test regressions, safe checks, emulator integration
  test/double-claim.test.mjs   synchronized emulator test and helper reference copies
```

## Queue, leases and run records

- Every poll transactionally sweeps expired `running` leases. The transaction re-reads
  the task and its run before writing, so a heartbeat, completion, pause or cancellation
  that wins the race is preserved. Expiry records `interrupted` on the task and run and
  writes an event. Legacy running records without `task.runId` are resolved in the same
  transaction.
- Fresh `queued` jobs and overdue `completed` recurring jobs alternate after successful
  claims, oldest first within each class. Both workers can race a candidate; only one
  transaction can claim it. Interrupted jobs are **never automatically retried**. An
  explicit user action must put an interrupted job back into `queued` after effects
  have been reviewed.
- A claim atomically creates one stable `runId`, lease and start event. The task stores
  its current `runId`, `workerId`, `lease` and `leaseUntil`; the run stores the same
  ownership. The lease lasts five minutes and is heartbeated every 60 seconds.
- Before the request and every 15 seconds during it, the worker checks current task/run
  ownership. A revoked, expired or unverifiable lease aborts the agent request. Every
  heartbeat and settlement requires a currently `running` task/run, matching worker,
  lease and run ID, and an unexpired lease. Stale workers cannot revive or overwrite
  paused, cancelled, completed or reclaimed work.
- Completion transactionally persists the result, completed run and event. Only
  nonempty successful text is accepted. Recurrence is scheduled from the task's current
  positive `intervalSeconds`; previous run results remain in their own records.
- SIGTERM/SIGINT cancels queue sleeps, ownership/heartbeat scheduling and self-pings,
  aborts the request, interrupts an owned in-flight run, and closes the HTTP server.
  Shutdown is capped at five seconds. If Firestore is unavailable during interruption,
  the remaining lease is left for an expired-lease sweep.

## Vercel worker request contract

```
POST /api/copilotkit/agent/{dotId}/run
Authorization: Bearer OWNER_TOKEN
Content-Type: application/json

{
  "threadId": "task.threadId",
  "messages": [{ "role": "user", "content": "task.prompt" }],
  "taskId": "task.id",
  "lease": "claim.lease"
}
```

These are the only body fields. Missing/blank dot ID, thread ID, prompt or proof is
rejected before sending. The API validates the live running task/lease and matching
dot/thread, derives `userId` from that task, and uses that user's memories. Interactive
user requests continue to authenticate with Firebase ID tokens. Worker turns require
a successful HTTP response with a nonempty `text`; error JSON is not a brief. The
85-second deadline covers fetch and response parsing, and caller cancellation reaches
the request signal.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | yes | Firebase project ID for the service account. |
| `FIREBASE_CLIENT_EMAIL` | yes | Service account email. |
| `FIREBASE_PRIVATE_KEY` | yes | Service account private key; literal `\n` escapes are unescaped at startup. |
| `VERCEL_API_URL` | yes | HTTP(S) base URL of the Vercel app. |
| `OWNER_TOKEN` | yes | Must match Vercel's worker authentication token. |
| `WORKER_POLL_INTERVAL_MS` | no | Positive integer idle polling interval in milliseconds; default **30000**. |
| `SELF_URL` | no | This service's own public URL; enables the 10-minute self-ping with a 10-second deadline. |
| `PORT` | no | HTTP port; Render injects it, default 3000. |
| `FIRESTORE_EMULATOR_HOST` | no | Local development only. Routes SDK calls to the Firestore emulator. |

Missing required variables or an invalid poll interval/port produce a startup error
and exit code 1. Health responses contain no credentials, request proofs or prompts.

Two workers making three empty queries every 30 seconds use approximately **17,280
minimum document reads/day**. Returned documents, transaction/run reads and other app
traffic add to this shared Firebase Spark usage. A two-second idle interval would
already exceed 50,000 reads/day for the empty queries alone.

## Render operation

Configure two Node web services with Root Directories `workers/render-1` and
`workers/render-2`, build command `npm ci` and start command `npm start`. Set the required
environment variables on each service and its own `SELF_URL` if self-ping is desired.
The example files use the same placeholder URL; actual service URLs differ.

`GET /api/ping` reports the worker ID and current time. `GET /api/health` reports uptime,
busy/stopping state, whether self-ping is enabled, and `lastSuccessfulPingAt` (ISO time
or `null` until a successful outbound ping). Ping failures do not advance that time.

Free Render services can spin down or be stopped. A self-ping only runs while this
process is running; it cannot recover a stopped process or guarantee always-on service.
Two free services can both be unavailable. Lease expiry makes unfinished work visible
as interrupted after a worker resumes polling; it does not automatically rerun effects.

### Firestore composite indexes

Production Firestore needs the following `tasks` indexes; the emulator does not enforce
them. Query failures include a console link to create the missing index.

- `status ASC, nextRunAt ASC`
- `status ASC, leaseUntil ASC`
- `status ASC, createdAt ASC`

## Verification

From either service Root Directory:

```powershell
npm test
npm run check
```

The default suite uses an in-memory optimistic transaction store and stubbed agent
requests; it never contacts Firestore. It exercises simultaneous claims, stable retry
IDs, stale heartbeat/settlement, expired-sweep races, cancel/late completion, explicit
interrupted retries, recurring run records, fair claims, deadlines and graceful
shutdown. The HTTP checks use loopback only. `check` runs `node --check` on the runtime
and test modules and imports the runtime/helpers with fetch blocked and no Firebase app.

For actual Firestore transaction integration, start a local emulator in a separate
shell from the repo root, then run the integration suite from either service:

```powershell
firebase emulators:start --only firestore --project demo-opendots-workers

# In a second shell, from workers/render-1 or workers/render-2:
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
npm run test:emulator
```

The integration helper requires an explicit loopback emulator host, checks reachability
with a three-second deadline and uses a unique `demo-*` project. It ignores live
Firebase project/credential variables and cleans up its seeded tasks/runs/events. No
Firebase credentials are needed for this test. Importing either test helper performs
no Firebase initialization or network I/O.
