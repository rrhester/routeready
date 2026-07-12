# RouteReady comms — real-device test checklist

Everything below was built this session and passes CI (syntax, smoke, e2e,
migration replay), but the **media / push / live** paths can't be exercised in
CI — they need a real microphone, a second device, and a locked phone. Run this
once on **an iPhone and an Android** (installed PWA) + the **dispatcher
dashboard** in a desktop browser. Check the box, or note what broke.

## 0. Prerequisites (do these first)

- [ ] **Run the three migrations** in Supabase → SQL Editor (pasted in chat; all idempotent):
  - `0473` (comms foundation tables) · `0474` (push-fanout trigger) · `0475` (delivery receipts — **required for the "Delivered" tick**)
- [ ] **Confirm the new build loaded.** Driver app → Settings → the support footer shows a build id. Fully close & reopen the installed app (iOS may need one extra open). Dashboard → hard-refresh (Cmd/Ctrl+Shift+R).
- [ ] Two accounts ready: one **dispatcher** (dashboard) and one **driver** (installed PWA) in the same DSP.

---

## 1. Voice notes — the headline feature

**Driver → dispatch**
- [ ] Driver app → Dispatch chat. With the message box **empty**, the round send button shows a **🎤 mic**.
- [ ] Tap it → a big **Recording** bar appears (red dot, live timer, ✓ Send / ✕ Cancel).
- [ ] Tap **✓** → note sends; appears in the thread as a **waveform player** (not a raw audio bar).
- [ ] Type a letter → the button flips back to the **send arrow**.
- [ ] On the **dashboard**, the same note appears as a waveform player and **plays**.

**Dispatch → driver**
- [ ] Dashboard driver chat → tap the **🎤** in the composer → record → send.
- [ ] Driver receives it, plays it.

**Player controls (both sides)**
- [ ] **Tap the waveform** to scrub to a spot.
- [ ] Tap the **1× / 1.5× / 2×** button — playback speed changes.
- [ ] Start one note, then another — the **first stops** (one at a time).

**Formats (the risky bit — different codecs per platform)**
- [ ] Record on **iPhone**, play on **Android + dashboard**. ✅ plays?
- [ ] Record on **Android**, play on **iPhone + dashboard**. ✅ plays?

---

## 2. Push notifications (locked / closed phone)

- [ ] Driver app installed to home screen, **notifications allowed** (it asks after first chat use).
- [ ] **Lock the phone.** Dispatcher sends a **text** → driver gets a push.
- [ ] Dispatcher sends a **voice note** → push reads **"🎤 Sent you a voice message."**
- [ ] **Tap the notification** → opens straight to the chat thread.
- [ ] **Android / desktop:** the notification shows **Reply** and **Mark read** buttons. "Mark read" clears the badge without opening the app.
- [ ] **iPhone:** the notification still appears normally (no action buttons is expected — iOS ignores them; it must NOT be missing entirely).

> iOS Web Push only works for a **home-screen-installed** PWA and is throttled — don't expect a loud ring; a normal banner is the correct result.

---

## 3. Delivery + read receipts (needs migration 0475)

On the **dashboard**, watch the pill under your last sent message:
- [ ] Right after sending (driver offline/closed): **✓ Sent** (grey).
- [ ] When the driver's phone **receives the push** (still not opened): flips to **✓✓ Delivered** (grey).
- [ ] When the driver **opens the thread**: flips to **✓✓ Read** (blue).

---

## 4. Live indicators

- [ ] Driver starts typing → dashboard shows **"typing…"**.
- [ ] Driver **holds the mic to record** → dashboard shows **"recording audio…"**.
- [ ] Reverse: dispatcher typing/recording → driver sees **"Dispatch is typing…" / "…recording audio…"**.

---

## 5. Offline outbox (reliability)

- [ ] Driver: turn on **Airplane mode**. Type a message, hit send → bubble shows **"queued · sends when you're back online."**
- [ ] **Force-close the app** while still offline, reopen — the queued message is still there.
- [ ] Turn networking back on → it **sends automatically** and the dispatcher receives it.

---

## 6. Presence (dashboard)

- [ ] With the driver app open, the dashboard shows the driver **online** (dot / "active now").
- [ ] Close the driver app → after a moment the dashboard shows **"last active …"**.

---

## What to report back

For anything that fails, note: **which device** (iPhone/Android, installed vs browser), **which step**, and **what happened**. That's enough for me to fix it precisely. Once this passes, push-to-talk (built on Meet) is the next build.
