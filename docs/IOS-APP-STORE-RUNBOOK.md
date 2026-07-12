# RouteReady Driver — iOS App Store runbook

Start-to-store guide for shipping the driver app as a **native iOS app** on the
**App Store**. This is the tailored, do-this-in-order companion to the more
technical `CAPACITOR-SETUP.md`.

**Where you are:** the driver app (`app/`) is already a Capacitor project
(`capacitor.config.json`, app id `com.gorouteready.driver`). Making it a native
Apple app is a **build + configure** exercise, not a rewrite — ~90% of the code
is the web app you already ship. You have a Mac; you don't have an Apple
Developer account yet.

**The one hard rule:** building and submitting *any* iOS app requires a **Mac
with Xcode** (true for Capacitor and native Swift alike). You have that, so
you're good.

---

## Step 0 — Enroll in the Apple Developer Program (do this first, today)

Approval can take **24–48 hours**, so start it before anything else.

1. Go to <https://developer.apple.com/programs/enroll/> and sign in with your
   Apple ID.
2. Enroll as the appropriate entity:
   - **Individual** — fastest, listed under your personal name. Fine to start.
   - **Organization** — listed under your company name (needs a D-U-N-S number,
     takes longer). You can migrate later; don't let it block you.
3. Pay the **$99/year** fee. Wait for the "Welcome" email.

While you wait, do Steps 1–2 below (they don't need the account).

---

## Step 1 — Generate the iOS project (on the Mac, one time)

Install prerequisites once:

- **Xcode 15+** from the Mac App Store, then open it once to install components.
- **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`).
- **Node 18+**: `brew install node` if you don't have it.

Then, from the repo root:

```bash
npm install            # pulls the @capacitor/* deps already in package.json
npx cap add ios        # generates the ios/ Xcode project (macOS only)
npx cap sync ios       # copies app/ in + installs the native plugin pods
```

Commit the generated `ios/` folder so future builds are reproducible.

> After any change to `app/`, run `npx cap copy ios` (fast) — no web rebuild
> needed; `app/` is the shipped artifact.

---

## Step 2 — App icon (fix the alpha-channel gotcha)

**Apple rejects app icons that contain transparency/alpha.** Your source
`app/Icon.png` is 1024×1024 **RGBA** (has alpha), so flatten it and let Capacitor
generate the full icon set:

```bash
npm install -D @capacitor/assets
# Flatten the App Store icon onto an opaque background (removes alpha):
mkdir -p assets
sips -s format png --setProperty hasAlpha false app/Icon.png --out assets/icon.png 2>/dev/null || cp app/Icon.png assets/icon.png
# Optional splash: reuse your brand color background
npx @capacitor/assets generate --ios --iconBackgroundColor '#0b1220' --splashBackgroundColor '#0b1220'
npx cap sync ios
```

Verify in Xcode that `App/Assets.xcassets/AppIcon` has no transparent corners.

---

## Step 3 — Signing (needs the Developer account from Step 0)

1. `npx cap open ios` to open the workspace in Xcode.
2. Select the **App** target → **Signing & Capabilities**.
3. Check **Automatically manage signing** and pick your **Team** (appears once
   the Developer enrollment is approved).
4. Confirm the **Bundle Identifier** is `com.gorouteready.driver`.

---

## Step 4 — Capabilities & permission strings (required or Apple rejects)

Your app uses microphone, camera, location, and push. Add these in Xcode.

### 4a. Capabilities (Signing & Capabilities → "+ Capability")

- **Push Notifications**
- **Background Modes** → check **Remote notifications**
  (add **Audio** and **Voice over IP** only when the live-call/PTT plugin lands —
  Phase 3–4 in `CAPACITOR-SETUP.md`; don't declare unused modes.)

### 4b. Info.plist usage strings

Add these keys to `ios/App/App/Info.plist` (Xcode: right-click Info.plist → Open
As → Source Code, paste inside the top-level `<dict>`). Wording is what Apple
shows the driver in the permission prompt — keep it specific and truthful:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>RouteReady uses the microphone for push-to-talk and voice messages with your dispatcher.</string>

<key>NSCameraUsageDescription</key>
<string>RouteReady uses the camera to scan documents, capture receipts, and attach photos to your routes.</string>

<key>NSPhotoLibraryAddUsageDescription</key>
<string>RouteReady saves scanned documents and captured photos to your library when you choose to.</string>

<key>NSLocationWhenInUseUsageDescription</key>
<string>RouteReady uses your location to confirm stop arrivals and share ETAs with dispatch.</string>
```

> These four are derived from your actual code: `getUserMedia`/`MediaRecorder`
> (mic + voice notes), `capture="environment"`/`facingMode` (camera scan/photo),
> and `navigator.geolocation` (arrival/ETA). If you later add
> **Always** location tracking, you'll also need
> `NSLocationAlwaysAndWhenInUseUsageDescription`.

---

## Step 5 — Backend: APNs push (so notifications ring on a locked iPhone)

Native push uses **APNs**, not Web Push. The token flow is already wired
(`comms-native.js` → `driver_device_push_register(kind:'apns')`), you just need
the Apple key and the edge-function secrets:

1. Apple Developer → **Keys** → **+** → enable **Apple Push Notifications
   service (APNs)** → download the `.p8` (you can only download it once).
2. Deploy the fan-out function and set its secrets (from `CAPACITOR-SETUP.md §8`):

   ```bash
   supabase functions deploy push-fanout --no-verify-jwt
   supabase secrets set APNS_KEY_P8="$(cat AuthKey_XXXX.p8)" \
     APNS_KEY_ID=XXXXXXXXXX APNS_TEAM_ID=YYYYYYYYYY \
     APNS_BUNDLE_ID=com.gorouteready.driver APNS_ENV=production
   ```

Until the secrets are set, `push-fanout` no-ops and Web Push keeps working —
nothing breaks. Not a launch blocker; do it before the store review so
reviewers see notifications work.

---

## Step 6 — Run on your own iPhone (sanity check before the store)

1. Plug in your iPhone, trust the Mac.
2. In Xcode, pick your device in the run-target dropdown → **▶ Run**.
3. Walk the driver flows: log in, scan a doc (camera prompt), record a voice
   note (mic prompt), a stop check-in (location prompt), receive a push.

---

## Step 7 — App Store Connect: create the listing

1. <https://appstoreconnect.apple.com> → **Apps → +** → **New App**.
   - Platform **iOS**, Bundle ID `com.gorouteready.driver`, SKU e.g.
     `routeready-driver`, your app name.
2. Fill the required metadata:
   - **Privacy Policy URL**: `https://gorouteready.com/privacy` (you already have
     `privacy.html`).
   - **App Privacy** questionnaire: declare Location, Audio, Camera/Photos, and
     any account/contact data — match what the app actually collects.
   - **Category**: Business (or Navigation).
   - Screenshots (6.7" and 6.5" iPhone at minimum), description, keywords,
     support URL.
3. **Sign in for review**: dispatch apps are login-gated, so provide a **demo
   driver account** (username + password) in App Review notes, or reviewers will
   reject for "can't access the app."

---

## Step 8 — Archive, upload, TestFlight, submit

```bash
npx cap copy ios       # ensure latest app/ is bundled
```

In Xcode:

1. Set the run destination to **Any iOS Device (arm64)**.
2. **Product → Archive**.
3. In the Organizer: **Distribute App → App Store Connect → Upload**.
4. In App Store Connect the build appears under **TestFlight** in a few minutes
   (after processing). Add yourself/your drivers as testers and install via the
   **TestFlight** app — this is the real-device proof before public release.
5. When happy: attach that build to the App Store version → **Submit for
   Review**. First review is typically 24–48h.

---

## Likely-rejection checklist (clear these before submitting)

| Risk | Fix |
|---|---|
| Icon has alpha/transparency | Step 2 — flatten `Icon.png`, no transparent corners. |
| Missing permission strings | Step 4b — all four usage strings present and specific. |
| Reviewer can't log in | Step 7 — demo driver account in review notes. |
| Declared background mode not used | Step 4a — only Remote notifications for now; add Audio/VoIP with the Phase 3–4 plugin. |
| Privacy answers don't match behavior | Step 7 — App Privacy must list location, mic, camera, and any account data. |
| "Just a website" (Guideline 4.2) | Push/CallKit/camera native integration is your defense — make sure notifications + camera work in the review build. |

---

## What I (Claude) can and can't do from here

- **Can, from this Linux session:** everything in `app/` (features, the native
  bridge, the `push-fanout` backend), config, icons/splash source assets, and
  this runbook.
- **Can't, from here:** run `npx cap add ios`, open Xcode, archive, or upload —
  those are macOS-only. Bring me the output of any command in this doc and I'll
  help debug it.
