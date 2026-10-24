# OpenDots background workers

Two **identical** Node.js workers (`render-1/`, `render-2/`) run as Render free-tier web
services. They poll the Firestore `tasks` collection, atomically claim due tasks with a
transaction + lease, call the Vercel API (NVIDIA NIM agent turn), and write results back.

```
workers/
  lib/claim.js                 claim/settle/heartbeat logic (side-effect-free import)
  render-1/                    deployed as Render web service #1
  render-2/                    deployed as Render web service #2 (byte-identical to render-1)
  test/double-claim.test.mjs   emulator test (byte-identical copies live in render-*/test/
                               so `npm run test:emulator` resolves from each package)
```

Claim priority per poll: (1) sweep expired leases → mark `interrupted`; (2) claim due
recurring tasks (`status='completed'`, `nextRunAt<=now`); (3) claim fresh `queued` tasks
(oldest first). Every claim creates a run doc in `tasks/{taskId}/runs` and an event in
`tasks/{taskId}/events`, and takes a 5-minute lease that is heartbeated every 60s while a
turn is in flight, so a crashed worker's task is freed by the other worker's sweep.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | yes | Firebase project id for the service account. |
| `FIREBASE_CLIENT_EMAIL` | yes | Service account email. |
| `FIREBASE_PRIVATE_KEY` | yes | Service account private key (`\n` escapes are unescaped at startup). |
| `VERCEL_API_URL` | yes | Base URL of the Vercel app, e.g. `https://your-app.vercel.app`. Missing vars make every run fail. |
| `OWNER_TOKEN` | no | Sent as `Authorization: Bearer ...` to the Vercel API when set. |
| `SELF_URL` | no | This service's own public URL; enables the 10-minute self-ping. |
| `PORT` | no | HTTP port (Render injects it; defaults to 3000). |
| `FIRESTORE_EMULATOR_HOST` | no | e.g. `localhost:8080` — routes all Firestore traffic to the emulator (local dev/test only). |

If any `FIREBASE_*` var is unset the worker logs a clear startup error and exits with code 1
after 5 seconds.

## Deploying on Render

1. Create **two** web services from the same repo:
   - Service `opendots-worker-1`: Root Directory `workers/render-1`
   - Service `opendots-worker-2`: Root Directory `workers/render-2`
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
3. Add the env vars above to **both** services. `SELF_URL` differs per service:
   `https://opendots-worker-1.onrender.com` and `https://opendots-worker-2.onrender.com`.
4. Free-tier caveat: a Render free service spins down after ~15 min without inbound HTTP.
   Each worker self-pings `${SELF_URL}/api/ping` every 10 minutes to stay (or spin back)
   up; the first request after a spin-down can take ~50s, and pinging a spun-down service
   is what wakes it, so occasional gaps are normal. `render-2` exists so a spin-down or
   deploy on one instance never stalls the queue.

### Firestore composite indexes

Production Firestore needs these composite indexes (the emulator does not enforce them;
the console error after the first query includes a one-click create link):

- `tasks`: `status ASC, nextRunAt ASC` (recurring claim query)
- `tasks`: `status ASC, leaseUntil ASC` (expired-lease sweep)
- `tasks`: `status ASC, createdAt ASC` (queued claim query)

## Local development with the Firestore emulator

```powershell
# from the repo root
firebase emulators:start --only firestore   # Firestore UI/API on localhost:8080

# in a second shell, from workers/render-1 (or render-2)
$env:FIRESTORE_EMULATOR_HOST = "localhost:8080"
$env:FIREBASE_PROJECT_ID    = "opendots-emulator-test"
$env:FIREBASE_CLIENT_EMAIL  = "test@example.com"
$env:FIREBASE_PRIVATE_KEY   = "-----BEGIN PRIVATE KEY-----`nMIIB`n-----END PRIVATE KEY-----`n"  # dummy OK against emulator
npm start
```

The Firebase Admin SDK honors `FIRESTORE_EMULATOR_HOST`, so all task reads/writes hit the
emulator and dummy `FIREBASE_*` values are fine.

## Double-claim test

```powershell
# emulator running as above, then from workers/render-1 or workers/render-2:
npm run test:emulator
```

The test seeds one `queued` task and one overdue recurring task, then runs **two
claimers** (different `workerId`s, same Firestore) concurrently via `Promise.all`. It
asserts that:

1. exactly one claimer wins the queued task,
2. exactly one claimer wins the recurring task (the transaction's re-read-and-verify
   makes the loser fall through instead of double-starting),
3. each claimed task doc ends up `running` under a lease with **exactly one** run doc in
   `status='running'` in its `runs` subcollection.

Seeded docs (and their run/event subcollections) are deleted afterwards. PASS/FAIL is
printed per assertion and the exit code is `0` only when all assertions pass.
