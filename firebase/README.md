# OpenDots — Firebase Setup Runbook

This folder provisions **Firestore security rules** and **composite indexes**
for OpenDots (Next.js app on Vercel + two Render background workers + NVIDIA
NIM as the AI provider).

## Files in this folder

| File | Purpose |
| --- | --- |
| `firebase.json` | Firebase CLI config — wires `firestore.rules` and `firestore.indexes.json` |
| `firestore.rules` | Per-user isolation rules (deny-by-default) |
| `firestore.indexes.json` | Nine composite indexes; ordinary single-field indexes remain automatic |

## Data model recap

- `users/{uid}` — profile doc; the document id equals the Firebase Auth uid.
- `spaces`, `dots`, `pages`, `memories`, `conversations`, `tasks` — every doc
  carries a `userId` field equal to the owner's uid.
- `tasks/{taskId}/runs/{runId}` and `tasks/{taskId}/events/{eventId}` —
  protected via the parent task's `userId` (no `userId` needed inside them).
- `conversations/{conversationId}/messages/{messageId}` — protected via the
  parent conversation's `userId`.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com/>.
2. Click **Add project**, name it (e.g. `opendots-prod`), and follow the
   wizard (Google Analytics is optional).
3. When the project is ready, open it.

## 2. Enable Firestore (production mode)

1. Console → **Build → Firestore Database** → **Create database**.
2. Pick a location close to your users (e.g. `us-central1`).
3. Select **Start in production mode** (locked down by default — the rules in
   this folder replace the generated defaults on first deploy).

## 3. Enable Firebase Auth (Email/Password)

1. Console → **Build → Authentication** → **Get started**.
2. Under **Sign-in method**, enable **Email/Password** and click **Save**.
3. Optional: under **Authentication → Settings → Authorized domains**, add your
   Vercel production and preview domains so client sign-in works there.

## 4. Generate a service account key

1. Console → **Project Settings** (gear icon) → **Service accounts**.
2. Click **Generate new private key** → confirm → a JSON file downloads.
3. From that JSON you need exactly three values, which map to these
   environment variables:

| Env var | JSON field |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `project_id` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` |
| `FIREBASE_PRIVATE_KEY` | `private_key` |

> ⚠️ `FIREBASE_PRIVATE_KEY` contains literal `\n` escape sequences inside the
> `-----BEGIN PRIVATE KEY-----` block. Paste the whole value exactly as it
> appears in the JSON (including the `\n` sequences). If the Admin SDK fails
> to authenticate, either replace the `\n` with real newlines where the env var
> is consumed, or normalize it once at startup (`key.replace(/\\n/g, "\n")`).

**Where the three env vars go:**

- **apps/ (Vercel / Next.js):** Vercel Dashboard → Project → **Settings →
  Environment Variables** → add all three for Production, Preview, and
  Development environments.
- **Render worker #1 and Render worker #2:** Render Dashboard → each service →
  **Environment** → add all three.

(The browser bundle uses the separate Firebase **web SDK** config — apiKey,
authDomain, projectId, etc. That config is not a secret; only the service
account is.)

## 5. Deploy rules + indexes

Requires the Firebase CLI:

```bash
npm i -g firebase-tools
firebase login
```

Deploy from this folder (so `firebase.json` is picked up):

```bash
cd firebase
firebase deploy --only firestore:rules,firestore:indexes --project brain-dots-pvt
```

One-liner equivalent (bash / PowerShell 7+):

```bash
cd firebase && firebase deploy --only firestore:rules,firestore:indexes
```

If you manage multiple projects, select a target first:

```bash
firebase use --add   # pick your project, give it an alias, e.g. "prod"
firebase use prod
```

Composite index builds can take a few minutes; watch progress under
Console → **Firestore → Indexes**. Queries that need a still-building index
fail with `FAILED_PRECONDITION` until the build finishes.

## 6. Local emulator testing

Start the Auth + Firestore emulators:

```bash
cd firebase
firebase emulators:start --only auth,firestore
```

- Emulator UI: <http://localhost:4000>
- Firestore emulator: `localhost:8080`
- Auth emulator: `localhost:9099`

Point the client SDK at the emulators in dev (never in production):

```js
import { connectAuthEmulator } from "firebase/auth";
import { connectFirestoreEmulator } from "firebase/firestore";

connectAuthEmulator(auth, "http://127.0.0.1:9099");
connectFirestoreEmulator(db, "127.0.0.1", 8080);
```

Run rules unit tests (`@firebase/rules-unit-testing`) against the emulator and
exit when done:

```bash
firebase emulators:exec --only firestore "npm test"
```

For worker-side integration tests, point the Admin SDK at the emulator by
setting `FIRESTORE_EMULATOR_HOST=localhost:8080` (and
`FIREBASE_AUTH_EMULATOR_HOST=localhost:9099`) — then no real credentials are
needed locally.

## Security notes

- **Never commit service account keys.** The downloaded JSON is a full admin
  credential. Keep it out of git (add it to `.gitignore`), store it only in
  Vercel/Render environment settings or a secrets manager, and rotate the key
  immediately if it is ever exposed.
- **Rules enforce per-user reads.** Workspace documents carry their owner's
  `userId`; messages, runs and events inherit ownership from their parent.
  Workspace writes go through the Vercel API, which verifies Firebase ID tokens,
  validates references and applies page revision checks. Clients cannot forge
  worker leases, audit records or assistant messages. Profile documents remain
  writable by their own Firebase UID. Other access is denied by default.
- **Workers bypass rules by design.** The Render background workers use the
  Firebase Admin SDK with the service account, which ignores Firestore rules —
  that is intentional because workers are trusted server code (task claiming,
  lease sweeps, recurring scheduling). Never ship the service account or its
  env vars to the browser.
