# RouteReady Communications System — Technical Architecture

**Status:** Design / RFC · **Date:** 2026-07-12 · **Author:** Claude (for RouteReady)

A WhatsApp-/FaceTime-class communications system for RouteReady: real-time text,
voice notes, live 1:1 and group voice, and a commercial-dispatch-radio
(push-to-talk) experience — **entirely over IP**, tied to authenticated
RouteReady accounts, with **no phone numbers and no carrier/PSTN dependency**.

> **The most important finding up front.** RouteReady already ships roughly
> two-thirds of this system. We have VAPID Web Push for both drivers and staff
> (`send-driver-push`, `send-staff-push`, migrations 0056/0074/0470), dispatch↔driver
> and group-channel messaging with instant Realtime broadcast delivery
> (`driver_messages`, `driver_channel_messages`, migration 0467), first-party
> WebRTC calling with a call-history log and Cloudflare TURN (RouteReady Meet,
> migrations 0457–0466, 0471, `meet-turn-credentials`), and a mature multi-tenant
> Supabase backend with RLS keyed on `dsp_id`. **This document is therefore an
> *extension* plan, not a greenfield rebuild.** The genuinely new pieces are:
> (1) a media/SFU layer for **group voice + push-to-talk** (LiveKit), (2) **voice
> notes**, and (3) a **Capacitor native wrapper** to unlock iOS PushKit/CallKit
> and Android high-priority FCM + foreground services for the "ringing on a
> locked phone" experience a PWA physically cannot deliver on iOS.

---

## Table of contents

1. [Overall system architecture](#1-overall-system-architecture)
2. [Backend services](#2-backend-services)
3. [Mobile architecture](#3-mobile-architecture)
4. [Notification flow](#4-notification-flow)
5. [Voice-call flow (1:1 live)](#5-voice-call-flow-11-live)
6. [Walkie-talkie flow (push-to-talk)](#6-walkie-talkie-flow-push-to-talk)
7. [Voice-note flow](#7-voice-note-flow)
8. [Database schema](#8-database-schema)
9. [Security model](#9-security-model)
10. [Recommended technology stack](#10-recommended-technology-stack)
11. [Cost estimates](#11-cost-estimates)
12. [Scalability considerations](#12-scalability-considerations)
13. [PWA vs. Capacitor vs. fully native](#13-pwa-vs-capacitor-vs-fully-native)
14. [Implementation roadmap: MVP → production](#14-implementation-roadmap-mvp--production)

---

## 1. Overall system architecture

Four planes, each independently scalable. The design principle throughout:
**Supabase owns identity, state, and signaling; a dedicated media plane
(LiveKit + TURN) owns the audio; the OS push networks (APNs/FCM) own the
"wake the device" job.** Never route media through the database, and never try
to make Web Push do a VoIP wake-up on iOS — that's the mistake that makes
these systems feel unreliable.

```
                         ┌──────────────────────────────────────────────┐
                         │                 CLIENTS                       │
                         │  Capacitor app (iOS/Android)  ·  PWA (web)    │
                         │  ─ shared web codebase (app/) ─               │
                         └───────┬───────────────┬──────────────┬────────┘
                                 │ HTTPS/WSS     │ WebRTC/media │ OS push
                                 ▼               ▼              ▼
   ┌───────────────────┐   ┌──────────────┐  ┌────────────┐  ┌──────────────────┐
   │  SUPABASE          │   │  REALTIME    │  │  MEDIA     │  │  PUSH NETWORKS   │
   │  (control plane)   │   │  (signaling) │  │  PLANE     │  │                  │
   │                    │   │              │  │            │  │  APNs  (+PushKit)│
   │ · Postgres + RLS   │   │ · broadcast  │  │ · LiveKit  │  │  FCM   (data+HP) │
   │ · Auth (staff)     │   │   channels   │  │   SFU      │  │  Web Push (VAPID)│
   │ · driver tokens    │   │ · presence   │  │ · TURN     │  └────────┬─────────┘
   │ · Edge Functions   │   │ · postgres_  │  │   (CF)     │           │
   │ · Storage (voice)  │   │   changes    │  │ · SIP-free │   fan-out via
   └─────────┬──────────┘   └──────┬───────┘  └─────┬──────┘   Edge Functions
             │                     │                │                  ▲
             └─────────────────────┴────────────────┴──────────────────┘
                        all state changes → triggers → push
```

**Message-vs-media split (the load-bearing decision):**

| Concern | Plane | Why |
|---|---|---|
| Who am I / what channels / message history | Supabase Postgres + RLS | Already the system of record; multi-tenant isolation is solved here. |
| "New message" / "incoming call" real-time nudge | Supabase Realtime (broadcast) | Already used app-wide (`rr-driver-live-<id>`, migration 0467). Sub-second, not RLS-limited. |
| Wake a **closed / locked** device | APNs / FCM / Web Push | Only the OS push networks can wake a suspended app. |
| Live audio (1:1, group, PTT) | **LiveKit SFU** + TURN | Group/PTT can't be pure mesh WebRTC; needs a selective-forwarding server. |
| Voice-note audio blobs | Supabase Storage | Durable, RLS-signed, cheap. |

---

## 2. Backend services

Everything lives in the existing Supabase project. New work is additive.

### 2.1 Reuse (already in production)

| Service | Where | Role in comms |
|---|---|---|
| `send-driver-push` | `supabase/functions/send-driver-push` | VAPID Web Push to drivers; triggered on message insert. |
| `send-staff-push` | `supabase/functions/send-staff-push` | VAPID Web Push to dispatchers (migration 0470). |
| Realtime broadcast pings | migration 0467 (`private.driver_live_ping`) | Instant in-app delivery without RLS-filtered `postgres_changes`. |
| `meet-turn-credentials` | edge function | Mints short-lived Cloudflare TURN creds per call. |
| `meet_ice_servers` | migration 0458 | Anon-safe ICE server list (STUN + relay) for a valid room. |
| `call_log_event` / `calls` | migration 0471 | Call history, missed-call surfacing, click-to-call-back. |

### 2.2 New edge functions

| Function | JWT? | Purpose |
|---|---|---|
| `push-fanout` | service-role (trigger-called) | **Unified** fan-out: given an event (`message` / `voice_note` / `call_invite` / `ptt_start`), select every recipient's device tokens across **APNs, PushKit, FCM, and Web Push** and dispatch with the right priority. Generalizes today's `send-driver-push`. |
| `livekit-token` | JWT (staff) + token (driver) | Mints a short-lived LiveKit access token (JWT signed with the LiveKit API secret) scoped to one room + participant identity = the RouteReady user/driver id. This is the join credential for **all** live audio. |
| `call-invite` | JWT/token | Creates a `call_sessions` row, then triggers `push-fanout` with a **VoIP/PushKit** payload (iOS) or **high-priority data** payload (Android/web) so the callee rings even when closed. |
| `voice-note-finalize` | JWT/token | Called after the client uploads audio to Storage; writes the `voice_notes` row, computes duration/waveform, triggers the "sent you a voice message" push. |
| `apns-voip` (thin) | service-role | Signs and posts PushKit payloads to APNs over HTTP/2 with the VoIP topic (`<bundle>.voip`). Kept separate because PushKit has its own certificate/topic and **must** be answered by a CallKit call or Apple penalizes the app. |

> **Note on APNs from Deno.** Supabase Edge Functions run Deno. APNs requires an
> HTTP/2 client with token-based (`.p8` key) JWT auth (`ES256`). Deno's `fetch`
> speaks HTTP/2, so we sign an `ES256` JWT with the APNs auth key and POST to
> `api.push.apple.com`. FCM v1 is a normal HTTPS POST with an OAuth2 bearer from
> the service-account key. Both are ~80 lines; no third-party push vendor
> required (though see §10 for the "buy vs. build" call).

### 2.3 Signaling

We already have two proven signaling substrates and should **not** add a third:

- **Supabase Realtime broadcast** (`rr-meet:<code>`, `rr-driver-live-<id>`) — SDP/ICE
  exchange for 1:1 P2P and all "something changed, re-fetch" nudges. Keep for 1:1.
- **LiveKit's own signaling** (WebSocket to the SFU) — used automatically once a
  client joins a LiveKit room with a token. This is how group voice + PTT signal.

---

## 3. Mobile architecture

**One codebase, two shells.** The web app in `app/` (PWA) is wrapped by
**Capacitor** to produce the iOS and Android binaries. ~90% of code is shared;
the native-only slivers are isolated behind a thin capability interface.

```
app/ (shared web UI + logic)
 ├─ messaging, presence, voice-note record/play  → 100% shared (Web APIs)
 ├─ LiveKit client (livekit-client JS SDK)        → 100% shared (WebRTC)
 └─ comms/native-bridge.ts  ← capability interface, two implementations:
        ├─ web:       Web Push, Notification API, getUserMedia   (PWA)
        └─ capacitor: PushKit/CallKit/APNs, FCM, foreground svc  (native plugins)
```

### 3.1 Capability interface (the seam)

```ts
interface CommsPlatform {
  registerForPush(): Promise<{ apns?: string; voip?: string; fcm?: string; web?: PushSubscription }>;
  presentIncomingCall(inv: CallInvite): Promise<'accept' | 'decline'>; // CallKit / ConnectionService / in-app UI
  startForegroundAudio(reason: 'call' | 'ptt'): Promise<void>;         // Android foreground service / iOS bg audio
  stopForegroundAudio(): Promise<void>;
  playAlert(kind: 'call' | 'ptt' | 'message'): void;                    // loud sound + haptics
}
```

- **iOS (Capacitor):** `@capacitor-community/*` + a small custom plugin that bridges
  **PushKit** (VoIP token) → **CallKit** (`CXProvider` reports the incoming call).
  Live audio holds an `AVAudioSession` with `.playAndRecord`; the app declares the
  `voip` and `audio` background modes.
- **Android (Capacitor):** FCM via the Firebase plugin. Incoming calls use a
  **high-priority data message** → a `ConnectionService`/full-screen intent for the
  "phone ringing" UI. Live audio + PTT run under a **foreground service** with a
  `microphone`/`phoneCall` type so the OS won't kill mic access.
- **Web (PWA):** Web Push wakes the service worker, which shows a notification.
  Live audio uses `getUserMedia` while a tab/PWA window is alive. (Limitations: §13.)

### 3.2 Offline & reliability layer (shared)

- **Outbox:** messages and voice notes are written to IndexedDB first, rendered
  optimistically, then synced. On failure they retry with exponential backoff —
  same discipline already used for push acks and the driver poll fallback.
- **Reconnect:** LiveKit client auto-reconnects (ICE restart) after network flaps;
  Supabase Realtime re-subscribes on `SIGNED_IN`/visibility change. On reconnect the
  client re-fetches through the token-gated RPCs (existing pattern from 0467).
- **Delivery/read receipts:** per-recipient status rows updated via RPC; synced on
  reconnect so receipts survive a dropped connection.

---

## 4. Notification flow

The core rule: **choose the push channel by payload type, not by platform
convenience.** iOS punishes a plain APNs alert used for calls and *requires*
PushKit→CallKit for VoIP; Android wants high-priority data for the same.

```
Event (message / voice note / call / PTT)
      │
      ▼
Postgres trigger  ──►  push-fanout edge function
      │                        │
      │                        ├─ pick recipients (channel membership, mute, presence)
      │                        └─ per device, pick channel + priority:
      │
      ├─ MESSAGE / VOICE NOTE ─────────────────────────────────────────────
      │     iOS native  → APNs alert push (mutable-content, sound, badge)
      │     Android     → FCM high-priority notification
      │     Web/PWA     → Web Push (VAPID) → SW shows notification
      │     Copy: "Dispatch sent you a voice message." → deep-links to thread
      │
      └─ CALL INVITE / PTT ────────────────────────────────────────────────
            iOS native  → APNs **VoIP push (PushKit)** → app wakes → CallKit rings
            Android     → FCM **high-priority data** → full-screen intent rings
            Web/PWA     → Web Push with `requireInteraction` (best effort; §13)
            Copy: "Dispatch is calling." / "Dispatch (PTT) — hold to reply."
```

**Notification behavior matrix (app closed / locked / background):**

| Requirement | iOS native | Android native | PWA (iOS) | PWA (Android) |
|---|---|---|---|---|
| Wake when app closed | ✅ APNs/PushKit | ✅ FCM | ⚠️ Web Push* | ✅ Web Push |
| Loud sound on locked screen | ✅ CallKit ringtone | ✅ full-screen intent | ❌ (silent-ish) | ⚠️ limited |
| Vibration | ✅ | ✅ | ❌ | ⚠️ |
| Full-screen incoming-call UI | ✅ CallKit | ✅ ConnectionService | ❌ | ❌ |
| Tap → open exact message | ✅ | ✅ | ✅ | ✅ |

\* iOS Web Push (16.4+) only works for a **home-screen-installed** PWA, is throttled,
and cannot trigger a VoIP-style ringtone. This is the single biggest reason live
calling needs the native wrapper on iOS (§13).

**Permissions:** request notification permission contextually (after the user
first sends/receives, not on cold launch); on iOS, PushKit needs no user prompt
but CallKit calls must be reported promptly or Apple throttles the VoIP topic.

---

## 5. Voice-call flow (1:1 live)

Reuses the existing Meet/`calls` machinery, upgraded from "P2P only" to
"P2P with LiveKit fallback," and wired to PushKit/CallKit for the ring.

```
Caller (dispatch)                 Backend                    Callee (driver)
   │  tap "Call"                     │                            │
   ├─ call-invite() ───────────────► create call_sessions row      │
   │                                 ├─ push-fanout (VoIP/HP data) ►│ device wakes
   │                                 │                            ├─ CallKit / full-screen UI rings
   │  join LiveKit room ◄── livekit-token ──────────────────────► │  (loud sound + vibration)
   │  (or P2P via rr-meet signaling) │                            │  accept → livekit-token → join
   ▼                                 ▼                            ▼
   └──────── audio flows peer↔SFU↔peer (Opus), TURN if NAT-blocked ─────────┘
   │                                                              │
   └─ call_log_event('answered') ◄──────────────────────────────►│  ended → call_log_event
```

- **Path selection:** 1:1 can stay **P2P WebRTC** (lowest latency, no SFU cost) using
  the existing `rr-meet` broadcast signaling + Cloudflare TURN, **or** route through
  LiveKit for uniformity and recording. Recommendation: **P2P for 1:1, SFU for 3+**.
- **CallKit correctness:** every PushKit wake **must** call `reportNewIncomingCall`
  within the launch window or iOS kills the app and eventually revokes the VoIP topic.
  The bridge plugin guarantees this even if the JS layer is slow to boot.
- **Reconnect:** ICE restart on network change; if the callee's device slept, the
  call rings again via a re-sent VoIP push (idempotent on `call_sessions.id`).

---

## 6. Walkie-talkie flow (push-to-talk)

The dispatch-radio experience. Built on a **persistent LiveKit room per channel**
that members stay subscribed to; PTT just toggles the local mic track publish.
This is what makes it feel "instant" — there's no call setup on each transmission.

```
Channel "Route A" = one long-lived LiveKit room. All on-shift drivers + dispatch
are joined (subscribed, mic muted) whenever the app is foregrounded or a
foreground service holds the session.

Dispatcher PRESS & HOLD:
   │  publish local mic track  ──► LiveKit SFU ──► fan out to all subscribers
   │  broadcast "ptt_start {who}" on the room  ──► others show "Dispatch talking…"
   │  (for members whose app is backgrounded/closed:)
   │      push-fanout → high-priority data/VoIP "Dispatch is calling on Route A"
   │      → foreground service spins up → auto-joins room → audio plays
   ▼
Dispatcher RELEASE:
   │  unpublish mic track ──► floor is free
   │
Driver PRESS & HOLD to reply:  same, in reverse. Optional "floor control" RPC
   prevents two people keying up at once (first-come lock in call_sessions).
```

**Design choices that make it feel like a radio, not a phone call:**

- **Always-joined rooms** (while on shift) → transmission latency is one RTT to the
  SFU (~100–300 ms), not a full call-setup handshake.
- **Half-duplex floor control** (optional): a lightweight `ptt_floor` lock so only one
  speaker at a time, mirroring commercial radio; last-key-wins or dispatch-priority.
- **Barge-in for dispatch:** dispatcher can always take the floor (priority tier).
- **Background survival:** foreground service (Android) / background-audio mode (iOS)
  keeps the room joined so a keyed transmission plays without a cold wake. When fully
  closed, the first PTT sends a wake push, then subsequent audio is live.
- **Battery:** rooms use Opus DTX (discontinuous transmission) — near-zero uplink when
  no one is talking. Subscribers only decode when a track is active.

> **Latency budget target:** press-to-audible < 400 ms warm (already joined),
> < 2.5 s cold (requires a push wake). WhatsApp/Zello sit in this range.

---

## 7. Voice-note flow

Asynchronous, Storage-backed. No SFU needed.

```
Sender:
  record (MediaRecorder, Opus/webm or AAC/m4a)
    → optimistic bubble in thread (outbox)
    → upload blob to Supabase Storage: voice-notes/<dsp_id>/<msg_id>.webm  (RLS-signed)
    → voice-note-finalize(): insert voice_notes row (duration, waveform peaks)
    → trigger → push-fanout
Recipient:
  push: "Dispatch sent you a voice message."  (APNs alert / FCM / Web Push)
    → tap → deep-link opens the thread at that message
    → tap play → signed URL streams the blob; mark read → read receipt
```

- **Format:** record Opus (`audio/webm;codecs=opus`) on Android/web; on iOS Safari
  fall back to `audio/mp4`/AAC. Store as-is; transcode server-side only if needed.
- **Waveform + duration** computed client-side (Web Audio) and stored so the UI can
  render the bar without downloading the blob first.
- **Retention:** configurable per DSP; blobs in Storage with lifecycle cleanup.

---

## 8. Database schema

New tables, all `dsp_id`-scoped with RLS mirroring existing conventions
(`private.current_dsp_id()`, `private.is_staff()`, driver-token gating). Existing
`calls`, `driver_messages`, `driver_channel_messages`, `*_push_subscriptions`,
`meetings` stay as-is; the following are added.

```sql
-- Device push tokens beyond Web Push (APNs alert, PushKit VoIP, FCM).
create table if not exists public.device_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  user_id      uuid references public.app_users(id) on delete cascade, -- staff
  driver_id    uuid references public.drivers(id)   on delete cascade, -- driver
  platform     text not null,          -- 'ios' | 'android'
  kind         text not null,          -- 'apns' | 'voip' | 'fcm'
  token        text not null,
  app_version  text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  failure_count int not null default 0,
  unique (kind, token)
);

-- Live audio sessions: 1:1 calls, group calls, and PTT channels.
create table if not exists public.call_sessions (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  kind          text not null,         -- 'direct' | 'group' | 'ptt'
  livekit_room  text not null unique,  -- room name = identity for the SFU
  channel_id    uuid references public.driver_channels(id) on delete cascade, -- group/ptt
  initiator     text,                  -- user_id or driver_id (as text)
  status        text not null default 'active', -- active | ended
  created_at    timestamptz not null default now(),
  ended_at      timestamptz
);
create index if not exists call_sessions_dsp_idx on public.call_sessions(dsp_id, created_at desc);

-- Per-participant state within a live session (join/leave, mute, talking).
create table if not exists public.call_participants (
  session_id  uuid not null references public.call_sessions(id) on delete cascade,
  party_kind  text not null,           -- 'driver' | 'dispatch'
  party_id    text not null,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  primary key (session_id, party_kind, party_id)
);

-- Optional half-duplex floor control for PTT (one speaker at a time).
create table if not exists public.ptt_floor (
  session_id  uuid primary key references public.call_sessions(id) on delete cascade,
  holder_kind text,
  holder_id   text,
  acquired_at timestamptz,
  expires_at  timestamptz              -- auto-expire so a dropped key frees the floor
);

-- Voice notes (async audio messages) attached to a thread/channel.
create table if not exists public.voice_notes (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  conversation  uuid,                  -- driver_conversations.id OR channel id
  scope         text not null,         -- 'direct' | 'channel'
  sender_kind   text not null,         -- 'dispatch' | 'driver'
  sender_id     text not null,
  storage_path  text not null,         -- voice-notes/<dsp>/<id>.webm
  duration_ms   int,
  waveform      jsonb,                 -- downsampled peaks for the UI
  created_at    timestamptz not null default now()
);

-- Per-recipient delivery / read receipts (messages + voice notes).
create table if not exists public.message_receipts (
  message_id    uuid not null,
  message_kind  text not null,         -- 'text' | 'voice_note'
  recipient_kind text not null,        -- 'driver' | 'dispatch'
  recipient_id  text not null,
  delivered_at  timestamptz,
  read_at       timestamptz,
  primary key (message_id, message_kind, recipient_kind, recipient_id)
);
```

All tables: `alter table … enable row level security;` + a tenant-read policy
(`using (dsp_id = private.current_dsp_id())`) for staff, plus driver-token-gated
RPCs for driver reads (mirroring migration 0467's rationale — drivers have no
`auth.uid()`, so driver-facing reads go through `security definer` RPCs, and
instant delivery rides Realtime **broadcast**, not RLS-filtered `postgres_changes`).

---

## 9. Security model

Built on RouteReady's existing dual-identity model — **do not invent a new one.**

| Aspect | Approach |
|---|---|
| **Identity** | Staff = Supabase Auth users (`auth.uid()`); drivers = opaque token (existing). LiveKit participant identity is minted server-side from that identity — a client can never claim to be someone else. |
| **Tenant isolation** | Every table `dsp_id`-scoped; RLS via `private.current_dsp_id()`. LiveKit room names are namespaced by `dsp_id` so a token for one DSP can't join another's room. |
| **Join credentials** | LiveKit access tokens are short-lived JWTs (≤ 1 h) signed by the `livekit-token` edge function with the API secret held only in Supabase secrets. TURN creds are ephemeral (existing `meet-turn-credentials`, 24 h TTL). |
| **Media encryption** | WebRTC is **DTLS-SRTP encrypted in transit** end-to-end to the SFU. For true E2EE group audio, LiveKit supports insertable-streams E2EE (optional, phase 3) — dispatch radio typically does not require it. |
| **Voice-note storage** | Storage bucket private; access via short-lived signed URLs scoped to a recipient who passes the RLS/RPC check. Path includes `dsp_id`. |
| **Push payload hygiene** | Following the existing 0467 principle: pushes carry a **content-free or minimal** hint (`{ kind, sender_name }`), never message bodies, so a leaked token/endpoint reveals nothing. The client re-fetches the real content through a gated RPC. |
| **Abuse / quota** | `livekit-token` and `call-invite` are rate-limited per identity; TURN minting is JWT-gated so anon callers can't burn relay quota (already true for Meet). |
| **Compliance data** | Call/PTT metadata logged in `calls`/`call_sessions` for audit; voice-note retention configurable per DSP for records-retention obligations. |

---

## 10. Recommended technology stack

| Layer | Choice | Rationale |
|---|---|---|
| **App shell** | **Capacitor** wrapping the `app/` PWA | Shares ~90% of the existing web codebase; unlocks PushKit/CallKit/FCM/foreground services that a PWA cannot. Preferred per requirements. |
| **Live audio (group + PTT)** | **LiveKit** (SFU) | Purpose-built WebRTC SFU with a first-class JS/Swift/Kotlin client, server-side token auth, DTX, and self-host **or** LiveKit Cloud. Handles group/PTT that mesh WebRTC can't. |
| **1:1 audio/video** | **Native WebRTC** (existing Meet) + Cloudflare TURN | Already built; lowest latency; no per-minute SFU cost. Promote to LiveKit only for 3+ parties or recording. |
| **NAT traversal** | **Cloudflare Realtime TURN** (existing) | Already integrated (`meet-turn-credentials`); pay-as-you-go, global. |
| **Control plane / DB / auth / storage** | **Supabase** (existing) | System of record; RLS multi-tenancy already solved. |
| **Signaling** | **Supabase Realtime broadcast** (1:1) + **LiveKit WS** (group/PTT) | Both already available; no new infra. |
| **Push — iOS** | **APNs** (alerts) + **PushKit/CallKit** (VoIP) | Only path to locked-screen ringing on iOS. |
| **Push — Android** | **FCM** (high-priority data + notifications) | Standard; supports full-screen intents + foreground services. |
| **Push — web** | **Web Push (VAPID)** (existing) | Already shipping for drivers + staff. |
| **Push dispatch** | Custom edge functions (`push-fanout`, `apns-voip`) | ~150 LOC total; avoids a paid push vendor. *Buy option:* OneSignal/Courier if you'd rather not maintain APNs/FCM plumbing — costs in §11. |

**Build vs. buy on the SFU:** start on **LiveKit Cloud** (no ops, per-minute
billing) for MVP; migrate to **self-hosted LiveKit** on a VM once minutes are
high enough that fixed-cost hosting wins (crossover ≈ a few hundred concurrent
active audio-hours/month — see §11).

---

## 11. Cost estimates

Assumptions: a mid-size DSP customer = ~50 drivers + 5 dispatchers; "active"
audio = time actually keyed/talking, not idle-joined (DTX makes idle ≈ free).
Order-of-magnitude, USD/month.

### Per-service unit economics

| Service | Pricing shape | Notes |
|---|---|---|
| Supabase | Pro ~$25 + usage | Already paid for; comms adds marginal DB/storage. |
| LiveKit Cloud | ~$0.006–0.012 / participant-minute of **published** audio | Idle subscribers with DTX are cheap; PTT bursts are short. |
| Self-hosted LiveKit | ~$40–160 / mo per VM (handles 100s of concurrent) | Fixed cost; wins at scale. |
| Cloudflare TURN | ~$0.05 / GB relayed (only ~15–20% of calls relay) | Most audio goes P2P/SFU-direct; Opus ≈ 0.5–1 MB/min. |
| APNs / FCM / Web Push | **Free** | You pay only for the edge-function compute to send. |
| Supabase Storage (voice notes) | ~$0.021 / GB-mo | Opus voice note ≈ 0.5 MB/min; negligible. |
| Push vendor (optional) | OneSignal free ≤ 10k subs; Courier ~$0–0.005/msg | Only if you skip building `apns-voip`. |

### Illustrative monthly totals

| Scenario | Est. cost / mo | Driver of cost |
|---|--:|---|
| **MVP** (messaging + voice notes + Web Push, 1 pilot DSP) | **~$25–40** | Basically just Supabase; audio not yet on. |
| **1 DSP live** (50 drivers, PTT + calls, LiveKit Cloud) | **~$60–150** | LiveKit participant-minutes + TURN. |
| **10 DSPs** (~500 drivers, LiveKit Cloud) | **~$400–900** | Linear in active audio-minutes. |
| **10 DSPs** (self-hosted LiveKit, 2 VMs + TURN) | **~$150–350** | Fixed SFU cost beats per-minute here. |
| **50 DSPs** (self-hosted LiveKit cluster + Supabase scale) | **~$1.5k–4k** | SFU VMs + DB tier + storage + TURN. |

**Takeaway:** messaging/voice-notes are nearly free (ride existing Supabase +
free push). The only usage-metered cost is **live audio**, and self-hosting
LiveKit caps it once you have real volume. Apple Developer ($99/yr) + Google
Play ($25 once) are the fixed platform costs.

---

## 12. Scalability considerations

| Dimension | Strategy |
|---|---|
| **Messaging throughput** | Already sharded by `dsp_id`; Realtime broadcast is O(subscribers per topic), not O(all users). Per-driver/per-channel topics keep fan-out bounded. |
| **Push fan-out** | `push-fanout` batches APNs (HTTP/2 multiplexing) and FCM (multicast); dead tokens pruned by `failure_count` (existing pattern). Move to a queue (pg-boss / Supabase queue) if a single channel ever exceeds ~1k recipients. |
| **Live audio** | LiveKit scales by adding SFU nodes; rooms are independent. A PTT channel of N members = N subscribers on one node — comfortably hundreds per node. Shard huge channels across nodes via LiveKit's built-in distribution. |
| **TURN** | Cloudflare is globally distributed and elastic; self-hosted coturn can be added regionally if relay volume justifies. |
| **Presence** | Supabase Realtime presence per channel; for very large channels, sample/aggregate presence rather than per-member events. |
| **Storage** | Voice notes are immutable blobs; lifecycle rules archive/delete per DSP retention. CDN-fronted signed URLs for playback. |
| **DB hot paths** | Receipts and presence are the highest-write tables; keep them narrow, index on `(recipient_id)` / `(session_id)`, and consider partitioning receipts by month at scale. |
| **Regional latency** | PTT latency is SFU-distance-bound; deploy SFU nodes near driver populations (US regions first). |

---

## 13. PWA vs. Capacitor vs. fully native

The central platform question. **Verdict: ship the PWA for web/desktop reach,
and wrap it in Capacitor for the mobile apps — a fully-native rewrite is not
justified.**

### Feature-by-feature support matrix

| Feature | PWA (Android) | PWA (iOS) | Capacitor (both) | Fully native |
|---|:--:|:--:|:--:|:--:|
| Real-time text messaging | ✅ | ✅ | ✅ | ✅ |
| Push when app **open/background** | ✅ | ⚠️ installed-only | ✅ | ✅ |
| Push when app **closed/locked** | ✅ Web Push | ⚠️ throttled, installed-only | ✅ APNs/FCM | ✅ |
| **Loud ringtone on locked screen** | ⚠️ limited | ❌ | ✅ CallKit / full-screen intent | ✅ |
| **VoIP incoming-call UI** (PushKit/CallKit) | ❌ | ❌ | ✅ | ✅ |
| Voice notes (record/play) | ✅ | ✅ | ✅ | ✅ |
| Live 1:1 / group voice (WebRTC) | ✅ | ✅ (foreground) | ✅ | ✅ |
| **Background/locked live audio** | ⚠️ tab must live | ❌ | ✅ foreground svc / bg audio | ✅ |
| **Push-to-talk while backgrounded** | ❌ | ❌ | ✅ | ✅ |
| Vibration API | ✅ | ❌ | ✅ | ✅ |
| Code shared with web | 100% | 100% | ~90% | ~0% |

### The three hard lines

1. **PushKit/CallKit — native only.** iOS gives *no* web API for a VoIP push or a
   system incoming-call screen. Any "phone is ringing on the lock screen" experience
   on iOS **requires** a native container. This alone forces Capacitor for the
   dispatch-radio use case on iPhone.
2. **Background/closed live audio — native only on iOS.** iOS suspends web content;
   a PWA cannot keep a mic/audio session alive when backgrounded or locked. PTT that
   works with the app closed needs the native audio background mode + PushKit wake.
3. **High-priority, loud, locked-screen alerts — native strongly preferred.** Android
   PWA can approximate; iOS PWA cannot. CallKit/full-screen intents are the only
   reliable path to "loud + vibrate + lock screen."

### What the PWA *is* sufficient for

- Full **messaging + voice notes + receipts** on Android and desktop.
- **Foreground** live calls/PTT on all platforms.
- Dispatcher web dashboard (dispatchers are usually at a desk with the tab open —
  the PWA + `send-staff-push` already covers "ring a closed dashboard," migration 0470).

### Recommendation

> **Capacitor, single codebase.** Keep the PWA as the web/desktop product and the
> shared source of truth; wrap it with Capacitor for iOS + Android to unlock
> PushKit/CallKit, FCM high-priority, foreground services, and background audio.
> A fully-native rewrite buys marginally better audio-session polish for ~10× the
> code and two separate teams — not worth it for RouteReady's stage. Revisit only
> if profiling shows Capacitor's WebView audio latency misses the PTT budget (§6),
> in which case drop *only* the audio engine to native behind the existing
> capability seam (§3.1), not the whole app.

**Compliance notes baked into this choice:**
- **Apple:** PushKit VoIP pushes **must** result in a CallKit `reportNewIncomingCall`
  every time, or Apple throttles/revokes the VoIP topic. Our bridge enforces this. Use
  VoIP pushes *only* for real live calls/PTT — never for chat (that's an APNs alert).
- **Google Play:** foreground-service types must be declared (`microphone`/`phoneCall`)
  with a user-visible notification and a Play Console disclosure; full-screen-intent
  permission is gated to calling/alarm apps — dispatch calling qualifies.
- **Notifications:** request permission contextually; honor per-channel mute (already
  modeled in channel membership) and OS Do-Not-Disturb (CallKit integrates with it).

---

## 14. Implementation roadmap: MVP → production

Each phase is independently shippable and leans on what already exists.

### Phase 0 — Foundations (≈ 1 week) — *mostly done*
- ✅ Web Push (driver + staff), messaging, channels, Meet calling, TURN, `calls` log.
- 🔨 Add `device_push_tokens`, `call_sessions`, `voice_notes`, `message_receipts`
  tables + RLS (migration). Stand up `push-fanout` (generalize `send-driver-push`).

### Phase 1 — MVP: rock-solid messaging + voice notes (≈ 2–3 weeks)
- Voice notes end-to-end (record → Storage → finalize → push → play), §7.
- Delivery + read receipts (`message_receipts`), synced on reconnect.
- Offline outbox (IndexedDB) + retry/backoff.
- Ship on **PWA** (Android + desktop) — no native needed yet. **First usable release.**

### Phase 2 — Capacitor wrapper + real push (≈ 3–4 weeks)
- Capacitor shell for iOS + Android; capability seam (§3.1).
- APNs alerts + FCM high-priority for messages/voice notes → "sent you a voice
  message" on a locked phone, deep-linking to the thread.
- App Store / Play Store first submissions (TestFlight / internal track).

### Phase 3 — Live voice: 1:1 calls with PushKit/CallKit (≈ 4–5 weeks)
- `livekit-token` + `call-invite` functions; LiveKit Cloud.
- 1:1 calling: P2P (reuse Meet) with LiveKit fallback; **PushKit→CallKit** ring on
  iOS, full-screen intent on Android. "Dispatch is calling."
- Reconnect/ICE-restart hardening; call quality metrics.

### Phase 4 — Walkie-talkie / dispatch radio (≈ 4–6 weeks)
- Persistent per-channel LiveKit rooms; always-joined-while-on-shift model (§6).
- Press-and-hold PTT, floor control, dispatch barge-in/priority.
- Foreground service (Android) + background audio (iOS) so PTT survives lock/close.
- Group voice channels (3+ parties on the SFU).
- Latency tuning to hit the < 400 ms warm budget.

### Phase 5 — Production hardening & scale (ongoing)
- Self-host LiveKit once minutes justify it (§11 crossover).
- E2EE option (insertable streams) for DSPs that require it.
- Observability: call-quality dashboards, push-delivery success, PTT latency SLOs.
- Retention/compliance controls per DSP; App Store/Play compliance review.

### Suggested sequencing rationale
Ship **value that needs no app-store review first** (PWA messaging + voice notes),
because it's fast, free, and already 70% built. Introduce the native wrapper only
when the feature *requires* it (push on locked iPhone → Phase 2; VoIP calling →
Phase 3). Defer the hardest, most compliance-sensitive piece (background PTT) to
Phase 4 when the native foundation is proven. This front-loads user value and
back-loads risk.

---

## Appendix A — Mapping requirements → this design

| Requirement | Solution | Phase |
|---|---|---|
| No phone numbers / no PSTN | All IP; identity = RouteReady account | ✅ inherent |
| Tied to authenticated accounts | Existing staff Auth + driver tokens; LiveKit identity minted server-side | ✅/1 |
| Real-time text + sync + secure store | `driver_messages`/channels + Realtime + RLS (exists) | ✅ |
| Push on new message | `push-fanout` (APNs/FCM/Web Push) | 2 |
| Delivery + read receipts | `message_receipts` | 1 |
| Voice notes + immediate push + deep-link | §7, Storage + `voice-note-finalize` | 1–2 |
| Live 1:1 voice | §5, P2P/LiveKit + CallKit | 3 |
| Group voice channels | §6, LiveKit rooms | 4 |
| Push-to-talk / dispatch radio | §6, persistent rooms + floor control | 4 |
| Dispatcher↔driver both directions | Symmetric channels; barge-in priority | 3–4 |
| Notify when closed/locked/background | PushKit/CallKit (iOS) + FCM HP + foreground svc (Android) | 2–4 |
| Loud sound / vibration / lock screen | CallKit + full-screen intent | 3–4 |
| WhatsApp/Teams-class reliability | Reconnect, retry, outbox, offline sync (§3.2) | 1+ |
| Battery efficiency | Opus DTX, idle-cheap SFU, foreground-svc discipline | 4 |
| Apple/Google compliance | §13 compliance notes; correct PushKit/CallKit usage | 3–4 |

---

*This is a design RFC. No application code is changed by this document; it defines
the target architecture and the additive migrations/functions to build it. The
next concrete step is the Phase 0 migration (`device_push_tokens`, `call_sessions`,
`voice_notes`, `message_receipts`) plus generalizing `send-driver-push` into
`push-fanout`.*
