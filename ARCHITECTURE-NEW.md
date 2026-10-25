# Brain-Dots deployment

Brain-Dots is a personal second brain using Firebase for workspace data and
conversation history, NVIDIA NIM for responses, and two Render services for
durable background-task orchestration.

## Services

| Service | Deployment directory | Endpoint |
| --- | --- | --- |
| Vercel web app/API | `apps/vercel` | https://brain-dots.vercel.app |
| Render worker, account 1 | `workers/render-1` | https://opendots-worker-1.onrender.com |
| Render worker, account 2 | `workers/render-2` | https://opendots-worker-2.onrender.com |
| Firebase Auth/Firestore | `firebase` | Project `brain-dots-pvt` |

The workers are deployed in separate Render workspaces. Both use the same
Firestore task queue. Each service directory has its own package and lockfile.

## Request flow

1. Web/mobile signs in with Firebase Email/Password and sends a Firebase ID token
   to the Vercel API. Ownership is derived from the verified token.
2. Interactive chat loads the Dot's instructions, recent persisted conversation,
   user-managed memories and relevant authorized saved notes.
3. Vercel calls NVIDIA NIM at `https://integrate.api.nvidia.com/v1` using
   **`openai/gpt-oss-20b`**. This model was verified against NVIDIA's hosted API.
4. Scheduled tasks are persisted with an owned Dot/conversation. Missing optional
   selections resolve to the user's default Dot and a dedicated conversation.
5. Either Render worker transactionally claims a task, obtains a lease and records
   a run. Its API request carries the server token, task ID and current lease.
6. Vercel validates the active assignment and executes with the task owner's
   permissions and context. Assistant writes are fenced by the active lease.
7. The worker transactionally saves the result, run history, events and next due
   time. Revoked/expired work cannot overwrite a newer task state.

Conversation messages live in `conversations/{id}/messages`; runs and events live
under `tasks/{id}`. Firestore client access is read-only for workspace/worker data;
authenticated API endpoints enforce mutations and page revisions. The original
OpenDots source remains available as a reference in `src/`.

## Web and mobile

The web app provides account onboarding, Spaces, Dots, saved pages, Memories,
conversations and scheduled-task controls. Page saves are serialized and retain
drafts through errors and revision conflicts.

`apps/mobile` is the Expo SDK 51 companion. It shares the live API/Firebase project,
supports live chat and keeps UID-scoped page/task caches and pending page edits in
AsyncStorage. Reconnect replay is revision checked. Its Android JS/assets export
is verified; an installable EAS binary additionally needs an Expo account and a
linked EAS project. See `apps/mobile/README.md` for device compatibility and builds.

## Configuration

Vercel production requires:

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (public web configuration).
- `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_BASE_URL`, `NVIDIA_NIM_MODEL`.
- `OWNER_TOKEN`, shared only with the trusted worker services.

**`FIREBASE_PRIVATE_KEY` is the JSON key's `private_key` PEM value, not the entire
service-account JSON.** Neither Firebase service-account credentials nor NIM or
worker tokens belong in browser/mobile bundles or Git.

Render requires the three Firebase service-account variables, `OWNER_TOKEN`,
`VERCEL_API_URL=https://brain-dots.vercel.app` and the service's own `SELF_URL`.
The runtime uses a 30-second idle poll, five-minute lease, 60-second heartbeat and
10-minute self-ping. Pings run only while the process is alive. Render quotas and
restarts still apply; both workers share Firebase's quota.

## Deploy and verify

From `apps/vercel`:

```sh
npm ci
npm run typecheck
npx playwright install chromium --only-shell
npm test
vercel deploy --prod --yes
```

From each worker directory:

```sh
npm ci
npm test
npm run check
```

Use `npm ci --omit=dev` as the Render build command and `npm start` as its start
command. `/api/health` reports uptime, busy/stopping state and the last successful
self-ping without exposing credentials. Deploy each worker in its respective
Render workspace; the root `render.yaml` is a single-workspace blueprint.

From `firebase`:

```sh
firebase deploy --only firestore:rules,firestore:indexes --project brain-dots-pvt
```

Runbooks: [Firebase](firebase/README.md), [workers](workers/README.md),
[mobile](apps/mobile/README.md). GitHub Actions checks the web client, both worker
packages and the mobile TypeScript/tests/export in addition to the upstream checks.
