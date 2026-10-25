# Brain-Dots Mobile (Expo SDK 51)

Dark-layout companion for chatting with Dots, editing Spaces pages, and managing
scheduled tasks. Mobile and web use the same **brain-dots-pvt** Firebase project
and **https://brain-dots.vercel.app** backend. API calls attach the signed-in
user's Firebase ID token as `Authorization: Bearer …`; provider keys stay on the
server.

## Install and verify

Run from `apps/mobile` (Node 22 was used for the checks):

```sh
npm ci
npm run typecheck
npm test
npx expo install --check
npx expo export --platform android --output-dir dist
npx expo start
```

Dependencies and `package-lock.json` stay on Expo SDK 51 / React Native 0.74.5 /
React 18.2. Native package versions match Expo 51's compatibility list. The Android
Metro export writes to gitignored `dist/` and does **not** require an Android SDK.
TypeScript, the regression tests, compatibility check, and a real Android export
have passed in this Windows workspace. An export is a JS/assets build, not an APK
or a production EAS build.

### Expo Go compatibility

This app requires an **SDK 51-compatible Expo Go**. The latest Expo Go release is
not compatible with SDK 51. Android historical builds are available from
[expo.dev/go](https://expo.dev/go); select SDK 51. Physical iOS devices cannot use
an older App Store Expo Go, so use a compatible development build. A matching
simulator Expo Go is another option on macOS. Platform-specific device testing was
not performed in this headless Windows run.

## Configuration and auth

- `app.json` → `expo.extra.firebase` contains the public Firebase web app config
  for `brain-dots-pvt`.
- `expo.extra.apiBaseUrl` selects the backend; `src/config.ts` has the same default.
- Enable Firebase Email/Password authentication. Direct live chat subscriptions
  require Firestore rules permitting the user to read their own conversation
  messages. Authenticated message polling is available through the API if live
  subscriptions fail.
- Native Firebase Auth uses `getReactNativePersistence(AsyncStorage)` and restores
  its session before routing. Web uses browser-local auth persistence. Login and
  account creation redirect to Chat. Tabs and editor deep links wait for auth and
  redirect signed-out users to Login. Settings provides logout.

Firebase 10's React Native auth export has browser-only root TypeScript typings;
`src/firebase-auth.d.ts` supplies its actual SDK signature. Metro selects the
native persistence module for Android/iOS.

## Offline behavior

**Firestore's JavaScript SDK has no native IndexedDB/disk persistence here.** Its
chat listener uses memory. Offline functionality is an explicit, UID-scoped
AsyncStorage cache:

| Data/action | Behavior |
| --- | --- |
| Spaces, page lists and pages | Last downloaded copies are available offline. A page's content can also be opened from a cached page list. |
| Tasks and opened task details | Last downloaded statuses, results, runs and events remain readable. |
| Editing an existing downloaded page | Each title/content edit is written to a local draft independently of the 800 ms autosave debounce. Drafts remain when leaving the editor or signing out, and reappear for the same account. |
| Reconnecting | Pending page saves replay serially on connectivity restoration, app foregrounding, and a 15-second foreground retry loop. Each PATCH includes `expectedRevision`. Settings also has manual sync. |
| Save failure | The draft and error are retained; automatic/manual retry remains available. A failed local-storage write is shown explicitly and prevents sending that unpersisted draft. |
| Revision conflict (409) | Replay stops for that page and retains its draft and conflict state. Review the server preview, then explicitly reload the server version or save your draft against a freshly fetched revision. Another server change raises another conflict. |
| New spaces/pages, task creation/actions, chat | Require connectivity. These operations are not queued offline. Chat messages and chat retry drafts are in-memory, not a persistent offline history. |

Older save acknowledgements advance the base revision without clearing newer
edits. The queue outlives the editor and maintains one writer per account. A
committed page save whose response was lost is reconciled when replay finds an
identical server version.

Automated tests verify cache rehydration using a storage adapter, UID isolation,
offline draft replay, overlapping-save protection, persisted errors/conflicts,
lost-response acknowledgement, storage failures, and stale-scope guards. Native
airplane-mode, app-kill recovery, and a real account's login restoration still
need device smoke testing. Durability assumes AsyncStorage writes succeed; errors
are surfaced rather than presented as saved changes.

## Screens

| Route | Features |
| --- | --- |
| `/login` | Email/password sign-in and account creation, auth-aware redirect |
| `/(tabs)/chat` | Dot and thread selection, New Chat, live messages with REST fallback, optimistic send, retained failed messages and Retry |
| `/(tabs)/pages` | Cached Spaces/pages, create Space/page, draft indicators |
| `/page-editor` | Cached editor, serialized autosave, offline replay, explicit conflict review |
| `/(tabs)/tasks` | Cached list/details, repeat intervals, run/pause/cancel, paused status, run history/events, focused polling |
| `/(tabs)/settings` | Account/logout, connection status, pending-draft links and manual sync |

Task creation omits optional Dot/thread IDs; the backend resolves the signed-in
user's defaults. Task actions use `/tasks/{id}/actions`.

Chat merges API and Firestore messages by server identity. Optimistic turns use
the pre-send identity set plus bounded request timestamps, with one-to-one
reconciliation so older repeated text cannot consume a new bubble. Thread/Dot
switches invalidate prior fetches and subscription callbacks, including switching
away and back. Failed-turn Retry checks persisted history first to recover a turn
whose HTTP response was lost. The run API has no idempotency key: retrying a turn
with only its user message persisted can append another real server user message.
Exactly-once retries require backend support.

## Android APK builds

The app is linked to **@star_dust_911/brain-dots**, EAS project
`217a9716-d82b-499f-9b23-b993adfc3534`. Its Android application ID is
`com.stardust.braindots`; the `preview` profile creates an installable APK.

From an authenticated Expo/EAS session:

```sh
npx eas-cli build --profile preview --platform android
```

For the `development` profile, install the SDK-51-compatible `expo-dev-client`
with `npx expo install expo-dev-client` before creating the development build.
