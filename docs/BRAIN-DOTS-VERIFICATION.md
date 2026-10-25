# Brain-Dots verification — October 25, 2026

## Live deployments

- **Web/API:** https://brain-dots.vercel.app
- **Vercel deployment:** `dpl_FCtuS7hkgrwQtdPdqK83wCJFoAMj` — READY.
- **Firebase:** `brain-dots-pvt`, default Firestore database, deployed rules and
  nine composite indexes.
- **NVIDIA NIM:** `https://integrate.api.nvidia.com/v1`, `openai/gpt-oss-20b`.
- **Render account 1:** https://opendots-worker-1.onrender.com — live,
  `workers/render-1`.
- **Render account 2:** https://opendots-worker-2.onrender.com — live,
  `workers/render-2`.
- **Worker source:** both services ran commit
  `26f69bb97314ce7c08a34f5f14203e40293fb37b`.
- **Android build:** `dd2fd5f4-7012-4c37-b82b-cd296e27490c` — FINISHED, preview APK.
- **Android app ID:** `com.stardust.braindots`, version 1.0.0, build 1.

Both Render services reported successful automatic self-pings after more than ten
minutes of uptime. Self-ping is best-effort: process restarts and free-tier quotas
still apply.

## Android download

[Download Brain-Dots APK](https://expo.dev/artifacts/eas/-wYSiKuRXH_Wwp3fjBi-jQk1lcbjREafw2H9fy6nKSw.apk)

[EAS build page](https://expo.dev/accounts/star_dust_911/projects/brain-dots/builds/dd2fd5f4-7012-4c37-b82b-cd296e27490c)

The download returned HTTP 200, contained an APK/ZIP archive header, and was
64,793,765 bytes (approximately 65 MB). Download it on Android and open it to
install. Android may ask to allow installation from the downloading browser.
Sign in or create a Firebase account; web and mobile use the same workspace.

The APK was built and its download checked. Physical-device installation and
airplane-mode/app-kill smoke tests remain device-side checks.

## Automated checks

- Web TypeScript passed; 17 tests passed, including six real browser flows using
  Firebase/REST fixtures and serialized-draft and worker-token regressions.
- Mobile TypeScript passed; 21 cache, offline-save, conflict, identity and stale
  response tests passed. Expo dependency compatibility and Android Metro export
  passed.
- Each independently deployable worker passed 50 regression tests, syntax checks
  and side-effect-free module imports. Worker source/config/test pairs matched.
- Root formatting and Git whitespace checks passed.

These are **138 automated tests** in the new deployment packages. The local
Firestore emulator was unavailable, so emulator integration is distinct from the
live checks below.

## Live end-to-end checks

Thirteen live checks passed against the real Firebase, Vercel, Render and NVIDIA
services:

1. Public health and the authenticated API boundary.
2. Real Firebase Email/Password account creation.
3. Authenticated workspace bootstrap.
4. Space, Dot and memory creation.
5. Revision-controlled pages and stale-write rejection.
6. Cross-user page access rejection.
7. NIM responses grounded in the latest saved note and the owner's memory, with
   conversation messages persisted.
8. Cross-user conversation and task-binding rejection.
9. Worker requests without a current task lease rejected before execution/writes.
10. Distinct healthy Render worker services.
11. Tasks without explicit thread selection bound to an owned default context.
12. Four real background tasks completed with one run each, saved results and audit
    events through Render → Vercel → NVIDIA NIM → Firestore.
13. Both Render workers processed the shared queue.

Temporary test accounts and documents created by these checks were removed.
NIM's typographic hyphens were normalized by the verifier when checking its
synthetic project-code answer; production output was not altered.

## Vercel coding-agent onboarding

Vercel CLI 56.2.0 is authenticated. The documented Vercel plugin requires OpenCode
2; this machine runs OpenCode 1.17.18, so the supported fallback installed nine
Vercel standalone skills globally.

The global config `~/.config/opencode/opencode.jsonc` contains the shared Vercel MCP
endpoint `https://mcp.vercel.com`, with `vercel_*` tool confirmation set to `ask`.
Existing provider/model configuration was preserved. `opencode mcp list` validates
the entry and reports **needs authentication**. Authenticated MCP tools were not
available in this session. Quit and restart OpenCode, then sign in to Vercel from
its MCP server list to finish that optional coding-agent connection.
