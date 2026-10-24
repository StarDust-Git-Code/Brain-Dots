# OpenDots Mobile (Expo)

Second-brain companion app: chat with your Dots, browse/edit Spaces pages, and
watch scheduled tasks — against the same Vercel + Firebase backend as the web app.

## Stack
- Expo SDK 51 + expo-router v3 (file-based routing)
- Firebase Auth (email/password) with AsyncStorage persistence
- Firestore with offline persistence (pages/tasks work offline, sync on reconnect)
- Chat messages stream live via Firestore `onSnapshot` (writes go through the
  Vercel API so the NVIDIA NIM turn runs server-side)

## Setup

1. **Fill in `app.json` → `expo.extra.firebase`** with your Firebase *web app*
   config (Console → Project settings → General → Your apps → Web app):
   - `apiKey`, `authDomain`, `projectId`, `appId`

2. **Point at your backend** in `src/config.ts`:
   - `API_BASE_URL = 'https://your-vercel-app.vercel.app'`

3. **Firebase console**: enable Authentication → Sign-in method →
   Email/Password. Firestore rules from `firebase/firestore.rules` already
   allow a signed-in user to read their own conversations' messages (required
   for the live chat subscription).

4. **Install and run**:
   ```sh
   cd apps/mobile
   npm install
   npx expo start
   ```
   Scan the QR code with Expo Go (Android) or the Camera app (iOS).

5. **Production build (optional)**:
   ```sh
   npm i -g eas-cli
   eas build --profile preview --platform android   # or ios
   ```

## Screens
| Route | Purpose |
|-------|---------|
| `/login` | Email/password sign in + account creation |
| `/(tabs)/chat` | Pick a Dot, pick/continue a conversation, live messages, send |
| `/(tabs)/pages` | Spaces → pages list, create page |
| `/page-editor` | Title + content editor, 800 ms autosave, revision conflict alerts |
| `/(tabs)/tasks` | Task list with status chips, create task (repeat intervals), auto-poll |

## Notes
- The first conversation for a Dot is auto-selected; use the thread chips to switch.
- Optimistic chat bubbles are reconciled against the Firestore snapshot by
  content match; failed sends roll back.
- Page conflicts (HTTP 409) surface an alert with Reload / Keep editing — the
  draft is never silently overwritten.
