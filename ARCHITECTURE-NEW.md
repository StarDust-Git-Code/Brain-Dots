# OpenDots on Vercel + Firebase + 2x Render Workers

## Stack
| Service | Role |
|---------|------|
| Vercel | Next.js web app + API routes |
| Firebase | Auth, Firestore (tasks, pages, dots, spaces, memories) |
| Render (x2) | Background workers polling Firestore for queued tasks |
| NVIDIA NIM | AI model provider (OpenAI-compatible) |

## Folder layout
```
apps/vercel/      # Next.js app (Vercel deployment): API routes + full web UI
apps/mobile/      # Expo app (iOS/Android): chat, pages, tasks
workers/render-1/ # Background worker 1 (Render)
workers/render-2/ # Background worker 2 (Render) — identical code
firebase/         # firestore.rules, firestore.indexes.json, setup runbook
```

## Setup runbooks
- Firebase project + rules + indexes: `firebase/README.md`
- Render workers + double-claim emulator test: `workers/README.md`
- Mobile app config: `apps/mobile/README.md`

## Setup

### 1. Firebase
- Create a Firebase project
- Enable Firestore (start in test mode, then secure rules)
- Generate a service account key (Project Settings > Service Accounts)
- Add `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` to all env files

### 2. NVIDIA NIM
- Get an API key from https://build.nvidia.com
- Set `NVIDIA_NIM_API_KEY` in Vercel env
- Optional: set `NVIDIA_NIM_MODEL` (default: `nvidia/llama-3.1-nemotron-70b-instruct`)

### 3. Deploy Vercel
```bash
cd apps/vercel
npm install
vercel deploy
```
Set env vars in Vercel dashboard:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `NVIDIA_NIM_API_KEY`
- `NVIDIA_NIM_BASE_URL`
- `NVIDIA_NIM_MODEL`
- `OWNER_TOKEN` (24+ chars)

### 4. Deploy Render workers
- Connect your GitHub repo to Render
- Create two Web Services from `workers/render-1` and `workers/render-2`
- Set env vars for each (see `.env.example`)
- Set `SELF_URL` to each service's Render URL
- Start command: `npm start`

### 5. Firestore collections used
- `tasks` — queued/running/completed/failed background jobs
- `spaces`, `dots`, `pages`, `memories`, `conversations` — workspace data

## How it works
1. User creates a task via Vercel API (`POST /api/tasks`)
2. Task is written to Firestore with `status: 'queued'`
3. Both Render workers poll Firestore every 2 seconds
4. Workers use Firestore transactions to atomically claim a task (only one worker gets it)
5. Worker calls Vercel API (`POST /api/copilotkit/agent/:dotId/run`) which calls NVIDIA NIM
6. Result is written back to Firestore (`status: 'completed'` or `'failed'`)
7. Each worker pings its own `/api/ping` endpoint every 10 minutes to stay alive on Render free tier
