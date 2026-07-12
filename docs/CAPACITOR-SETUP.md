# RouteReady mobile — Capacitor native shell (Phase 2)

Wraps the existing driver PWA (`app/`) in a Capacitor native shell so iOS and
Android can do what a PWA cannot: **APNs / PushKit / CallKit** on iOS,
**high-priority FCM + foreground services** on Android, and background audio.
~90% of the code stays shared — this is a shell around `app/`, not a rewrite.

> **What's already in the repo (this phase):**
> - `capacitor.config.json` — app id `com.gorouteready.driver`, `webDir: app`.
> - `app/comms-native.js` — the capability bridge (`window.RRNative`). Inert in
>   the plain PWA; on the native shell it registers APNs/FCM and streams the
>   token + notification taps back to `app.js`.
> - `app/app.js` — `ensurePushSubscription()` now takes the native path when
>   `RRNative.isNative()`, registering the device token via the
>   `driver_device_push_register` RPC (migration 0473) instead of Web Push.
> - `index.html` loads `comms-native.js` before `app.js`.
>
> **What must be done on a Mac / in Android Studio (this doc):** generate the
> native projects, install plugins, configure APNs/FCM, and — for live
> calls/PTT in Phases 3–4 — add the PushKit/CallKit plugin.

---

## 0. Prerequisites

| Need | For |
|---|---|
| Node 18+ | Capacitor CLI |
| Xcode 15+ + CocoaPods (macOS) | iOS build |
| Android Studio (Giraffe+) + JDK 17 | Android build |
| Apple Developer Program ($99/yr) | APNs, PushKit, distribution |
| Google Play Console ($25 one-time) | Play distribution, FCM project |
| A Firebase project | FCM (Android push) |

---

## 1. Install Capacitor + generate the native projects

From the repo root (where `capacitor.config.json` lives):

```bash
npm install          # pulls @capacitor/* declared in package.json
npx cap add ios
npx cap add android
npx cap sync         # copies app/ into the native projects + installs plugins
```

`ios/` and `android/` are generated locally. Commit them (or keep them local and
regenerate in CI — team's choice; they're large but standard to commit).

Whenever `app/` changes: `npx cap copy` (fast) or `npx cap sync` (also updates
native deps). No rebuild of the web code is needed — `app/` is already the
shipped artifact.

---

## 2. Plugins

```bash
npm install @capacitor/push-notifications @capacitor/app \
            @capacitor/splash-screen @capacitor/status-bar \
            @capacitor/haptics @capawesome/capacitor-badge
npx cap sync
```

`comms-native.js` already feature-detects each of these (`PushNotifications`,
`Haptics`, `Badge`) — no code change needed once installed.

---

## 3. iOS — APNs (messages + voice notes)

1. **Capabilities** (Xcode → target → Signing & Capabilities):
   - **Push Notifications**
   - **Background Modes** → check **Remote notifications**, **Audio** (for voice
     playback in background), and later **Voice over IP** (Phase 3).
2. **APNs auth key**: Apple Developer → Keys → new key with APNs enabled →
   download the `.p8`. Put its contents + Key ID + Team ID into Supabase secrets
   (`APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`) for the `push-fanout` /
   `apns-voip` edge functions (Phase 2 backend, see the architecture RFC §2.2).
3. **Token flow** is already wired: on launch `RRNative.registerPush()` fires,
   the `registration` event yields the APNs token, and `app.js` stores it via
   `driver_device_push_register(kind:'apns')`.

> **PushKit vs. APNs (important):** APNs *alert* pushes are for chat + voice
> notes ("🎤 Sent you a voice message"). Live **calls/PTT** must use a **PushKit
> VoIP** push that is answered by a **CallKit** `reportNewIncomingCall` every
> single time, or Apple throttles/revokes the VoIP topic. That is a custom
> native plugin — see §6. Do **not** send VoIP pushes for chat.

---

## 4. Android — FCM + high-priority + foreground service

1. **Firebase**: create/download `google-services.json` → `android/app/`.
2. **Push token** is already wired via `RRNative.registerPush()` →
   `driver_device_push_register(kind:'fcm')`.
3. **Runtime permission**: Android 13+ requires `POST_NOTIFICATIONS`. The
   `@capacitor/push-notifications` plugin requests it via `requestPermissions()`
   (already called in the bridge).
4. **High-priority notifications**: send FCM messages with `priority: high` and a
   notification channel of `IMPORTANCE_HIGH` so they wake the screen. For
   incoming **calls/PTT**, use a **full-screen intent** notification (requires the
   `USE_FULL_SCREEN_INTENT` permission, gated to calling/alarm apps) so it rings
   over the lock screen.
5. **Foreground service** (live audio / PTT so the OS won't kill the mic):
   declare a service with `foregroundServiceType="microphone"` and a persistent
   notification. Added in Phase 4 alongside the audio engine.

---

## 5. Store-compliance checklist

| Rule | What to do |
|---|---|
| Apple — PushKit must ring | Every VoIP push → `CXProvider.reportNewIncomingCall` in the same launch, no exceptions. Use VoIP pushes only for real live calls/PTT. |
| Apple — background audio | Declare only the background modes you use (audio, voip). Don't hold the audio session when idle. |
| Google — foreground service | Declare the `microphone`/`phoneCall` service type, show a user-visible notification, and complete the Play Console foreground-service disclosure. |
| Google — full-screen intent | `USE_FULL_SCREEN_INTENT` is restricted; a dispatch calling app qualifies — declare the use in the Play listing. |
| Both — notification permission | Ask contextually (the app already defers the ask to first chat engagement), honor per-channel mute + OS Do-Not-Disturb. |

---

## 6. Phase 3–4 native plugin (VoIP / CallKit) — outline

Live 1:1 calls and walkie-talkie need a small custom Capacitor plugin (`RRVoip`)
that the bridge already feature-detects (`RRNative.registerVoip`,
`RRNative.plugin('RRVoip')`):

- **iOS**: register with **PushKit** (`PKPushRegistry`) for the `voip` token →
  store via `driver_device_push_register(kind:'voip')`. On a VoIP push, call
  **CallKit** `reportNewIncomingCall` immediately, then join the LiveKit room.
- **Android**: on a high-priority data message, post a **full-screen intent** /
  `ConnectionService` call UI and start the foreground audio service.

The signaling, room tokens, and audio (LiveKit) are backend/web work covered by
Phases 3–4 in the architecture RFC — this plugin is only the OS-integration
sliver that a WebView can't reach.

---

## 7. Build & run

```bash
npx cap open ios       # → run on device/simulator from Xcode
npx cap open android   # → run from Android Studio
```

Live-reload against a dev server (optional) by adding a `server.url` to
`capacitor.config.json` while developing; remove it for release builds so the
app serves the bundled `app/`.

---

## 8. How this maps to the roadmap

- **Phase 2 (now):** shell + APNs/FCM alert push → chat & voice-note
  notifications on a locked phone, deep-linking into the thread. The
  **`push-fanout` edge function** (in `supabase/functions/push-fanout`) delivers
  to `device_push_tokens` and is fired alongside `send-driver-push` by migration
  0474. Deploy it and set the APNs/FCM secrets:

  ```bash
  supabase functions deploy push-fanout --no-verify-jwt
  # then set the secrets it reads (all optional; a missing channel is skipped):
  supabase secrets set APNS_KEY_P8="$(cat AuthKey_XXXX.p8)" \
    APNS_KEY_ID=XXXXXXXXXX APNS_TEAM_ID=YYYYYYYYYY \
    APNS_BUNDLE_ID=com.gorouteready.driver APNS_ENV=production
  supabase secrets set FCM_SERVICE_ACCOUNT="$(cat service-account.json)"
  ```

  Until the secrets are set, `push-fanout` returns `{ ok:true, skipped:N }` and
  Web Push keeps delivering — nothing breaks.
- **Phase 3:** `RRVoip` plugin + PushKit/CallKit → live 1:1 calls ring on lock screen.
- **Phase 4:** foreground audio service + full-screen intent → background PTT.
