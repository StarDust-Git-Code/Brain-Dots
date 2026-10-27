# Render hosting plan — full-cloud OpenDots

Goal: personal second brain. All 5 Dots, Telegram in/out, voice notes, 3 shared
computer boxes, $0/month on Render's free tier.

## Topology

| Service      | Account | Free-tier role                       | Data                     |
| ------------ | ------- | ------------------------------------ | ------------------------ |
| opendots-app | key 1   | UI + API + SQLite + Telegram + voice | SQLite (ephemeral disk!) |
| dot-box-1    | key 2   | computer stack (browser/files/shell) | shared workspace         |
| dot-box-2    | key 3   | computer stack                       | shared workspace         |
| dot-box-3    | key 4   | computer stack                       | shared workspace         |
| (spare)      | key 5   | overflow / box-4 if ever needed      | —                        |

One service per account so each fits its own 750 free instance-hours (730 h
needed at 24/7). Services keep each other warm:

- Each service exposes `/healthz` and runs an internal 10-minute timer that
  pings the other three in turn. Inbound traffic keeps instances hot.
- Honest limits: pings do not protect against redeploys, crashes, or Render
  maintenance — the ephemeral filesystem wipes on restart. Free tier gives
  0.1 CPU / 512 MB per service.

## Durability insurance (mandatory)

SQLite is the memories. Snapshot on change + nightly:

1. Compress the store (`store.db` + WAL) to `backup-<ts>.zst`.
2. Push to the owner's **private GitHub repo** (free, off-Render) via a
   fine-grained PAT stored only in service env.
3. `restore.mjs` rebuilds state from the latest snapshot into a fresh service.

## App code changes (required before any deploy)

1. **Multi-computer routing** (`src/server/computer-service.ts`,
   `platform-config.ts`, `index.ts`) — **implemented**:
   - `COMPUTER_REMOTES` JSON: name, url, optional token. The token is the
     box's access secret; when omitted the per-Dot derived HMAC token is
     sent (matches one-Dot boxes like box-1 as deployed). Dots may share a
     box by presenting that box's token — the upstream computer service
     authorizes exactly one fixed secret (`matchesToken`) and separates
     sessions by the `x-openbot-bot-id` header.
   - Per-Dot assignment: store field + `PATCH /api/dots/:id/computer/assignment`.
     Explicit assignment wins; a Dot whose assigned box is no longer
     configured falls back to the first remote. **Deliberate deviation from
     the hash-default idea below:** there is NO avalanche-hash default,
     because hash-routing could send a Dot to a box that does not recognize
     its token and make every action 401. Boxes only host Dots they were
     provisioned with.
2. **Telegram channel** (`src/server/telegram-channel.ts`, mirroring
   `slack-channel.ts`):
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_IDS` (owner allowlist),
     webhook route with Telegram `secret_token` check.
   - All Dots reachable: `/coder <msg>` routes to that Dot's agent
     (`TELEGRAM_DOT_ROUTES` map), no prefix → general Dot. Any Dot may post
     proactive updates (scheduled tasks, finished work).
   - Voice notes both ways: inbound OGG/Opus → Gemini transcription (server
     side, same AI Studio key) → text to the Dot; reply as voice note via
     server-side Gemini TTS where appropriate.
3. Tests for routing precedence, validator cases, auth header, Telegram
   owner scoping.

## Provisioning (`deployment/render/`)

- `Dockerfile` — Node 24 app build (existing repo pipeline, `dist/`).
- `Dockerfile.computer` — Node + Chromium; runs the pinned OpenBot computer
  service (revision `b6932d31…`) directly on port 4100 **without** a
  supervisor; basic-auth middleware in front; `/healthz`.
- `provision.mjs` — reads `.env.render` (`RENDER_API_KEY_1..5`, git-ignored),
  creates the 4 services, sets env, prints the `COMPUTER_REMOTES` snippet.
- `keepalive` logic baked into each service's server entry.

## Agent → box mapping (5 agents)

| Box   | Agents                             | Rationale          |
| ----- | ---------------------------------- | ------------------ |
| box-1 | Coder + one more (spawned)         | shell-heavy pair   |
| box-2 | research Dot + research Dot #2     | browser-heavy pair |
| box-3 | general Dot + Telegram/general Dot | general pair       |

Two missing Dots get spawned via `POST /api/dots` (memory + research enabled).
Sharing a box shares its browser profile/files — grouping is deliberate.
VERIFIED in upstream `agent-computer/src/shell.ts`: the terminal tool is a
plain local `/bin/bash -c` spawn — no Docker dependency. On Render the service
container is the isolation boundary, and the pinned image (ubuntu:24.04) ships
full bash. Remaining spike checks are sandbox-level only.

## Phase 0 spike (deploy box-1 alone first)

Status: **executed on 2026-10-26.** Box = repurposed suspended Docker service
`headless-browser-xiuu` (`srv-da1u13bl550s73api4u0`, deployed from
`CopilotKit/OpenBot` main at `ef13020`).

Verified live:

- standalone computer service boots on Render without Docker-in-Docker — but
  note: Render ignored PATCHed `dockerfilePath`, so it built the repo-root
  monolith image including the s6-managed `computer` service on port 4100;
- port binding: app bind = Docker healthcheck = Render probe must agree;
  `PORT=4100` everywhere is what made the rollout go live;
- auth: app Bearer = derived HMAC token = box `COMPUTER_TOKEN` env worked;
- shell (`/exec`) runs commands on the pod end to end through the app;
- browser (`/navigate`) reaches real sites after an egress policy is pushed.

App code (`src/server/computer-service.ts`):

- URL trailing-slash fix: `running()` returns the remote origin as a plain
  string — a URL object stringifies with a trailing slash and produced
  `//exec` (box 404);
- self-healing egress policy: `ensureRemotePolicy()` re-pushes
  `{ policy: { mode: 'allow_all' } }` to `PUT /egress-policy` when stale
  (>5 min), awaited before remote actions and fire-and-forget in `status()`
  — free-tier instances lose in-memory policies on cold start, and the
  push-on-act pattern mirrors what upstream's API server does.

An alternative skip-the-filter route was evaluated and dropped: Render's
`EGRESS_POLICY_REQUIRED=0` env var never appeared in the container process
env across two deploys (while earlier PUTs did), so the policy push above is
the dependable path. If a future change ever needs box env vars, verify
their arrival with `printenv` in the box shell before trusting a deploy.

Known follow-ups: nothing failed left on box-1; Render PATCH won't convert
a Node service to Docker runtime (reuse Docker services); Render also wants
a payment card on file before creating brand-new services (reuse existing
free services instead); Curl in the box shell inherits the egress filter
proxy (`HTTP_PROXY=127.0.0.1:<filterport>`) — network checks in shell have
no proxy credentials, so they fail before a policy is pushed.
FAILURE here sends us to box alternative (Fly.io socket machines, Railway,
or paid Render boxes) with the same app code.

## Environment (app)

```
COMPUTER_REMOTES=[{"name":"box-1","url":"https://…","username":…,"password":…,"tokenPerDot":…}]
TELEGRAM_BOT_TOKEN=…          # Owner provides, never pasted in chat
TELEGRAM_OWNER_CHAT_IDS=…     # detected on first message
APP_ORIGIN=https://opendots-app.onrender.com
OWNER_TOKEN=…                 # existing
NVIDIA + CPK keys, VOICE_PROVIDER=gemini, VOICE_MODEL, VOICE_API_KEY, VOICE_NAME
GITHUB_BACKUP_PAT=…
```

## Order of execution

1. App code: multi-computer routing + Telegram channel + tests.
2. Phase 0 spike: box-1 alone.
3. Provision remaining 3 services; wire `COMPUTER_REMOTES`.
4. Spawn missing Dots, assign to boxes, verify (file isolation across boxes,
   persistence, wrong-password rejection, voice note round trip).
5. Second-brain loop: Spaces as knowledge store, scheduled daily Telegram
   digest, memory on all Dots.

## Cloud app deployment (2026-10-26)

- Account 2 (`Another Star_Dust's workspace`, key saved as `RENDER_APP_KEY`
  in git-ignored temp `.env.render`): single service `opendots-worker-2`
  (`srv-dbesm53ncjis73fb04b0`), Node runtime, region singapore,
  https://opendots-worker-2.onrender.com — repurposed as the main app.
- Code ships from `StarDust-Git-Code/Brain-Dots` branch **`opendots-app`**
  (that repo's `main` holds the owner's separate mobile/Firebase project and
  must NOT be force-pushed over; the app lives on its own branch).
- Free-tier instances have 512 MB, too tight for `vite build` on-instance,
  so `dist/` (client + server) is prebuilt locally and committed; Render
  build stays `npm ci --omit=dev`, start `npm start`; Node pinned via
  `.nvmrc` ("22") + `NODE_VERSION` env.
- App env: secrets were PUSHED from the local git-ignored `.env` by script
  (`deploy-app.mjs`, names only printed in chat): CPK intelligence key,
  NVIDIA chat (`OPENAI_*`), voice (`VOICE_*`, gemini), `COMPUTER_TOKEN`
  master + `COMPUTER_REMOTES` (box-1) so the cloud app can drive Render
  boxes, `HOST=0.0.0.0`, and a generated `OWNER_TOKEN` (required by the
  app for external binding; stored at temp `render-owner-token.txt`,
  never pasted in chat).
- App additions for deployment: public `/healthz` + `/api/health` probes
  (exempt from the owner-token gate; the latter answers services whose
  health check predates this app and unblocks Render's deploy probe).

Verified live: cloud app ⇄ box-1 — status (`running`), `exec`
(`echo cloud-app-to-box` on the box pod) and egress-policy auto-push all
work through `https://opendots-worker-2.onrender.com` with the owner token;
box-1 auth switched to the per-box token pattern (`COMPUTER_TOKEN` = fixed
secret, sent via the `token` field of `COMPUTER_REMOTES` on both apps).

Deployment gotchas hit and fixed:

- service had a stale Root Directory `render-2` → cleared (instant
  build failures were invisible without logs);
- service health check pointed at `/api/health` from a previous app → the
  app now answers that path directly;
- `ownerToken` scripts must read the temp token file BY LINE (the file has
  a trailing note line; a whole-file `.trim()` pushed the note into the env
  value and broke auth until rotated);
- behind Render's TLS proxy the app sees itself as `http://`, so POSTs
  carrying `Origin: https://...` 403'd ("Cross-origin requests are not
  allowed") while GETs passed — UI loaded but chat sends failed; fixed by
  setting `APP_ORIGIN=https://opendots-worker-2.onrender.com` on the
  service (must stay in the env for every future app deploy);
- free tier = ephemeral disk: every redeploy wipes SQLite and reseeds ONE
  new default Dot (ids change each deploy). No redeploys after this point
  until the backup/restore (`restore.mjs`) or a persistent disk is in place.

Owner access: UI unlock token at temp `render-owner-token.txt` (line 1).
Render keys used in chat must be rotated (both accounts).

## Per-chat model picker (2026-10-26)

- Catalog: `src/shared/chat-models.ts` builds from env at boot.
  `default` = `OPENAI_MODEL` at `OPENAI_BASE_URL` (NVIDIA MiniMax);
  `gemini-flash` / `gemini-pro` added automatically when `VOICE_API_KEY`
  exists (Google OpenAI-compatible endpoint); any further
  OpenAI-compatible provider via `CHAT_MODELS` JSON
  (`[{id,label,model,baseUrl,apiKeyEnv}]`, ids lowercase, invalid
  catalogs throw at boot by design).
- Storage: `thread_bindings.model` column (workspace migration list);
  `PATCH /api/conversations/:id {model|null}`, optional `model` on
  `POST /api/conversations`, `GET /api/models` lists the catalog.
  Unknown model ids → 400; `dot-agent.ts` resolves the conversation's
  model into the tanstack adapter per run.
- UI: model `<select>` lives in the composer note row (below the input,
  centered pill; deliberately NOT inside the compose row after a
  placement complaint). List loads once in `App` via `/api/models` and
  is passed to `Chat` as a prop — a mount-time fetch inside `Chat`
  broke api-mock ordering in `chat-run-error.test.tsx`.
- Cloud catalog: 18 options — default MiniMax, 2 Gemini, plus the
  NVIDIA free-endpoint chat models shipped via `CHAT_MODELS` on the
  service env (Nemotron Bolt/Super VL/Ultra/Lightning, Step 5 Preview,
  DeepSeek V4.1 Flash, GLM 5.3 Flash, Kimi K2.6, Muse Glimmer 30B,
  Laguna XS 2.1, DiffusionGemma 26B, Gemma 4 31B, GPT-OSS 20B,
  Llama 3.2 90B Vision, Mistral Large 2). `z-ai/glm-5.3` excluded
  (upper-listed deprecation in 2 days).
- Tests: `tests/chat-models.test.ts` (catalog resolution, malformed
  `CHAT_MODELS`, per-thread override persistence).

## Persistence decision (deferred)

## Supabase Storage snapshot persistence (2026-10-27, implemented)

- Module: `src/server/supabase-snapshot.ts` — plain Supabase Storage
  REST over `fetch` (no SDK, no new dependency).
- Boot restore: when the SQLite file (`data/opendots.sqlite`) is
  missing or zero bytes, `index.ts` restores the newest snapshot
  (padded-epoch newest, filtered by pre-existing connections) BEFORE
  the stores open. No snapshot → fresh seed.
- Snapshot cycle: runs once right after `serve` starts, then every
  `SUPABASE_SNAPSHOT_INTERVAL_MS` (default 4 min, floor 60 s).
  `PRAGMA wal_checkpoint(TRUNCATE)` then uploads the main db file as
  `snap-<epoch>.sqlite`; keeps the 3 newest, prunes older (DELETE with
  auth-only headers — Supabase 400s on json content-type + no body).
  Shutdown: `stopPlatform` piggybacks one final flush before
  `platform.stop()`.
- Object list API gotcha: POST body REQUIRES `prefix` (even empty);
  omitting it 400s despite the docs examples.
- Env contract: only active when `SUPABASE_SNAPSHOT_ENABLED` is truthy
  AND `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present (incomplete
  - enabled throws at boot). `SUPABASE_BUCKET` defaults `dots-backup`.
    Deliberate design: keys are in every `.env`, but only the cloud
    service gets `SUPABASE_SNAPSHOT_ENABLED=true` (deploy script), so
    local dev machines cannot race the deployment that owns the bucket.
- Supabase project: `ilkekzrftdefgurmtpnz` (`opendots-dots`, free tier,
  private bucket `dots-backup`). Live E2E verified round-trip on the
  real bucket (seed temp db → snapshot → missing target → restore →
  row content matches).
- Data-loss window: worst case one snapshot interval (~4 min) for a
  hard kill; graceful redeploy loses nothing (final flush on SIGTERM).
- Remaining risk: none known; restore only when the disk file is
  empty, so it never overwrites a healthy boot.

## Owner checklist (nothing in chat)

- [ ] `.env.render` with the 5 Render keys (git-ignored first).
- [ ] BotFather bot created; `TELEGRAM_BOT_TOKEN` into `.env` self-serve; press Start in the bot chat.
- [ ] Rotate the previously exposed Google + NVIDIA keys.
- [ ] GitHub repo for backups + fine-grained PAT.
