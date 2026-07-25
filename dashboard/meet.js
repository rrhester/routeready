// meet.js · RouteReady Meet — first-party instant video meetings
// (dashboard/meet.html). Replaces the rented meet.jit.si rooms with our
// own Zoom-style tool on our own domain.
//
// Architecture
//   · Calls are a WebRTC MESH: every pair of participants holds one
//     direct RTCPeerConnection (media never touches our servers). A
//     mesh is the right shape for interview/1:1/small-team calls; an
//     SFU is the day we outgrow it, not today.
//   · Signaling (offers/answers/ICE) rides a Supabase Realtime
//     broadcast channel, `rr-meet:<code>`; the roster rides the same
//     channel's presence. No new infrastructure.
//   · Negotiation uses the "perfect negotiation" pattern — BOTH sides
//     add their tracks and fire negotiationneeded; glare resolves by
//     politeness, a pure function of the two peer keys (meet-core.js).
//   · The `meetings` table (migration 0457) answers "is this code
//     real / ended / whose room is it" via meet_create / meet_lookup /
//     meet_end. Guests join with no account: meet_lookup is anon-
//     callable, and Realtime broadcast channels accept the anon key.
//
// Test seam: `?local=1` on localhost swaps the Supabase transport for a
// BroadcastChannel one (same-browser tabs signal each other directly)
// and skips all network — Playwright drives a real two-tab WebRTC call
// with Chromium's fake camera/mic, fully offline.
//
// Known limit (documented, deliberate): no TURN relay yet. Peers behind
// symmetric-NAT-vs-symmetric-NAT pairs (rare on consumer networks,
// more common on strict corporate VPNs) won't get media through; the
// tile shows "connecting" until they do. Adding a TURN server later is
// config, not surgery: append it to ICE_SERVERS.

import {
  genMeetCode, normalizeMeetCode, buildMeetUrl,
  isPolite, sortRoster, gridDims, fmtDuration, initials,
  sendPolicy, qualityLevel, pickActiveSpeaker,
} from "/dashboard/meet-core.js?v=5af00e53bb02";

const SUPABASE_ESM_URL = "./vendor/supabase-js-2.45.4.mjs";

const DEFAULT_ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];
// Replaced by meet_ice_servers(p_code) at join time (migration 0458):
// operators can add a TURN relay with one app_settings INSERT and every
// subsequent join picks it up — no deploy.
let iceServers = DEFAULT_ICE;

const cfg = window.RR_CONFIG || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─── state ────────────────────────────────────────────────────────────────

const LOCAL_MODE = new URLSearchParams(location.search).has("local")
  && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// ?embed=1 · chromeless room for the dashboard's interview panel: the
// host page already shows the title/invite/end controls, so the inner
// header would be a "screen in a screen". Timer, count, REC and the
// header buttons relocate into the bottom control bar instead.
const EMBED = new URLSearchParams(location.search).has("embed");

// ?debug=1 · on-screen connection readout. Diagnostic only — surfaces the
// Realtime channel, subscribe status, presence count and errors so a
// two-party "we can't see each other" report can be localized without dev
// tools. No effect on behavior; the panel only renders when the flag is on.
const DEBUG = new URLSearchParams(location.search).has("debug");

// ?ptt=1 · Push-to-talk "dispatch radio" mode. Same mesh room, but: audio
// only (no camera), the mic joins MUTED, and a big hold-to-talk button keys
// the mic on press & hold (releasing re-mutes). Purpose-built for a small
// crew (2–6) on an always-on channel — everything else in this file is
// untouched, so normal video calls are unaffected. See docs.
const PTT = new URLSearchParams(location.search).has("ptt");
// ?call=1 · direct 1:1 call from RouteReady Messages (rrPlaceCall). ON A
// PHONE-SIZED VIEWPORT ONLY (operator request 2026-07-13 — desktop keeps
// the traditional meeting view): while exactly two people are in the room
// and nobody is screen-sharing, the room renders FaceTime-style — the
// other person fills the window, my own camera rides along as a small
// draggable picture-in-picture tile (tap it to trade places with the
// stage), and the header floats over the video and fades out while idle.
// A third participant or a screen share falls back to the normal meeting
// layout. mqCallPhone is the SAME 760px breakpoint the call-mode CSS in
// meet.html is scoped to — keep them in lockstep or layout and style
// disagree. The radio (?ptt=1) and embedded (?embed=1) surfaces never
// get any of this.
const CALL = new URLSearchParams(location.search).has("call") && !PTT;
const mqCallPhone = matchMedia("(max-width: 760px)");
// #dtok=<driver session token> · the driver PWA embeds Meet as an anonymous
// guest (drivers aren't Supabase-authenticated), so it passes its opaque
// session token here. It's used ONLY to mint the driver a TURN relay via the
// anon-callable meet-turn-driver function — without it a driver on cellular
// can't punch a direct path and the call never connects. Never logged / shown.
// Carried in the URL FRAGMENT so it stays out of server/proxy logs and is
// unreadable by same-page third-party scripts that inspect location.search;
// legacy ?dtok= links are still accepted, and both forms are scrubbed from
// the address bar immediately after reading.
const DTOK = (() => {
  let t = "";
  try {
    const h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    t = h.get("dtok") || "";
    const q = new URLSearchParams(location.search);
    const legacy = q.get("dtok") || "";
    if (!t) t = legacy;
    if (t) {
      h.delete("dtok"); q.delete("dtok");
      const qs = q.toString(), hs = h.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + (hs ? "#" + hs : ""));
    }
  } catch (_) {}
  return t;
})();
const dbg = { chan: "", status: "", err: "", presence: 0, authed: false, bcastRx: 0 };
function renderDebug() {
  if (!DEBUG) return;
  const el = document.getElementById("rr-debug");
  if (!el) return;
  el.hidden = false;
  const verdict = dbg.bcastRx > 0
    ? "REALTIME MSGS: WORKING"
    : (dbg.status === "SUBSCRIBED" ? "REALTIME MSGS: waiting… (rx 0)" : "REALTIME MSGS: —");
  el.textContent = [
    `>> ${verdict} <<`,
    "",
    `code:   ${state.code || "-"}`,
    `chan:   ${dbg.chan || "-"}`,
    `status: ${dbg.status || "-"}`,
    `role:   ${state.isHost ? "host" : "guest"}  authed:${dbg.authed ? "yes" : "no"}`,
    `SEEN:   ${dbg.presence}   peers:${peers.size}   roster:${state.roster.length}`,
    `bcast-rx: ${dbg.bcastRx}`,
    dbg.err ? `err:    ${dbg.err}` : "",
  ].filter(Boolean).join("\n");
}

const state = {
  code: null,          // canonical "xxx-xxxx-xxx"
  meeting: null,       // meet_lookup/meet_create payload
  session: null,       // supabase auth session (null for guests)
  isHost: false,
  name: "",
  peerKey: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
  joinedAt: 0,
  // Radio mode joins listening (mic muted) with no camera; a normal call
  // joins mic+cam on as before.
  mic: !PTT,
  cam: !PTT,
  sharing: false,
  localStream: null,   // what we SEND (camera/mic; video swapped during share)
  camTrack: null,
  micTrack: null,
  screenTrack: null,
  screenAudioTrack: null,
  transport: null,
  roster: [],          // sorted presence entries incl. self
  chatOpen: false,
  unread: 0,
  timerId: null,
  left: false,
  // zoom-quality pass
  view: "gallery",     // "gallery" | "speaker"
  hideSelf: false,     // View menu · drop my own tile from the grid
  hideNonVideo: false, // View menu · drop camera-off tiles (audio-only)
  hideTimers: false,   // View menu · hide the call-duration timer
  pipCorner: "br",     // FaceTime pip corner (?call=1): tl | tr | bl | br
  ftSwapped: false,    // FaceTime swap (?call=1): true = I hold the stage, they ride in the pip
  pinnedKey: null,
  hand: false,
  activeSpeaker: null,
  lastSpeakerSwitch: 0,
  sinkId: "",          // chosen output device ("" = default)
  statsTimer: null,
  levelTimer: null,
  // waiting room
  knock: false,        // I'm a guest awaiting admission
  waiting: [],         // (hosts) guests currently knocking
  rec: false,          // I'm recording (mirrored to presence meta)
  instant: false,      // host started an instant meeting → show the ready card
};

const peers = new Map(); // key → {pc, polite, makingOffer, ignoreOffer, isSettingRemoteAnswerPending, pending:[], stream}
const tiles = new Map(); // key → tile element (reused across renders; recreating <video> kills playback)

// ─── supabase (lazy — never imported in local mode) ───────────────────────

let _sbPromise = null;
function getSb() {
  if (!_sbPromise) {
    _sbPromise = import(SUPABASE_ESM_URL).then(({ createClient }) => {
      // Same project + default storage key as dashboard/live.js, so an
      // operator already signed in to the dashboard is signed in here.
      const client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
      // Authenticate the Realtime socket, exactly like the dashboard
      // (live.js). Since the key rotation the publishable key is NOT a
      // JWT, so an un-authed socket subscribes but its presence/broadcast
      // never reaches peers — two participants join the same room yet
      // never link. Fires on INITIAL_SESSION (restored login) and every
      // token refresh so a staff host's socket carries a valid JWT.
      client.auth.onAuthStateChange((_evt, session) => {
        if (session?.access_token) client.realtime.setAuth(session.access_token);
      });
      return client;
    });
  }
  return _sbPromise;
}

// ─── transports ───────────────────────────────────────────────────────────
// Both expose: join(meta, handlers) / track(meta) / send(event, payload) /
// signal(toKey, data) / leave(). handlers: onSignal(from, data),
// onPresence({key: [meta,…]}), onEvent(type, payload).

class SupabaseTransport {
  constructor(sb, code, key) {
    this.sb = sb;
    this.key = key;
    this.lastMeta = null;
    this.joined = false;
    this.topic = "rr-meet:" + code.replace(/-/g, "");
    this.channel = sb.channel(this.topic, {
      config: { broadcast: { self: false }, presence: { key } },
    });
    dbg.chan = this.topic;
    renderDebug();
  }
  join(meta, handlers) {
    const ch = this.channel;
    this.lastMeta = meta;
    this.handlers = handlers;
    this.rosterPeers = new Map(); // key → meta, built from broadcast (not presence)
    ch.on("broadcast", { event: "signal" }, ({ payload }) => {
      if (payload && payload.to === this.key) handlers.onSignal(payload.from, payload.data);
    });
    // ONE list for every forwarded app event. Supabase needs a
    // subscription per event name, unlike LocalTransport which forwards
    // anything — an event wired into onEvent but missing here works in
    // local tests and silently never arrives in production (that exact
    // gap shipped admit/deny broken to review). Keep this list complete.
    for (const evt of ["chat", "react", "ended", "admit", "deny"]) {
      ch.on("broadcast", { event: evt }, ({ payload }) => handlers.onEvent(evt, payload));
    }
    // ?debug=1 broadcast health probe: count pings received FROM OTHER
    // clients (self:false means our own never echo back). If two devices
    // both show bcast-rx > 0, broadcast works and only presence is broken;
    // if it stays 0 on both, the whole Realtime message path is blocked.
    if (DEBUG) {
      ch.on("broadcast", { event: "dbgping" }, ({ payload }) => {
        if (payload && payload.from !== this.key) { dbg.bcastRx++; renderDebug(); }
      });
    }
    // Roster over BROADCAST, not Presence. Supabase Presence silently
    // delivers nothing on this project (confirmed live: SUBSCRIBED, authed,
    // but presenceState stays empty even for self — a Realtime-authorization
    // quirk of the new publishable keys), so two participants never saw each
    // other. Broadcast works, so mirror LocalTransport's hello/state/bye
    // handshake instead: announce on join, answer a peer's hello with our
    // current meta, drop on bye. Same {key: [meta]} shape handlePresence
    // already consumes.
    ch.on("broadcast", { event: "peer" }, ({ payload }) => {
      if (!payload || payload.from === this.key) return;
      if (payload.kind === "hello") {
        this.rosterPeers.set(payload.from, payload.meta);
        this._sendPeer("state"); // so the newcomer learns about us
        this._emitRoster();
      } else if (payload.kind === "state") {
        this.rosterPeers.set(payload.from, payload.meta);
        this._emitRoster();
      } else if (payload.kind === "bye") {
        this.rosterPeers.delete(payload.from);
        this._emitRoster();
      }
    });
    return new Promise((resolve, reject) => {
      ch.subscribe(async (status, err) => {
        dbg.status = status;
        if (err) dbg.err = String(err.message || err);
        renderDebug();
        if (status === "SUBSCRIBED") {
          // Announce ourselves. Re-sent on every (re)subscribe so the roster
          // heals after a socket drop; a delayed second hello covers the rare
          // both-subscribe-at-once race where the first hello is missed.
          this._sendPeer("hello");
          setTimeout(() => { if (!this._left) this._sendPeer("hello"); }, 800);
          this._emitRoster();
          if (DEBUG && !this._pingTimer) {
            this._pingTimer = setInterval(() => {
              ch.send({ type: "broadcast", event: "dbgping", payload: { from: this.key } });
            }, 2500);
          }
          if (!this.joined) { this.joined = true; resolve(); }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (!this.joined) reject(new Error("realtime_" + status.toLowerCase()));
        }
      });
    });
  }
  _sendPeer(kind) {
    return this.channel.send({ type: "broadcast", event: "peer", payload: { kind, from: this.key, meta: this.lastMeta } });
  }
  _emitRoster() {
    const map = { [this.key]: [this.lastMeta] };
    for (const [k, m] of this.rosterPeers) map[k] = [m];
    dbg.presence = Object.keys(map).length;
    renderDebug();
    if (this.handlers) this.handlers.onPresence(map);
  }
  track(meta) { this.lastMeta = meta; this._sendPeer("state"); this._emitRoster(); return Promise.resolve(); }
  send(event, payload) { return this.channel.send({ type: "broadcast", event, payload }); }
  signal(to, data) { return this.send("signal", { from: this.key, to, data }); }
  async leave() {
    this._left = true;
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    try { await this._sendPeer("bye"); } catch { /* leaving anyway */ }
    try { await this.sb.removeChannel(this.channel); } catch { /* leaving anyway */ }
  }
}

// Same-browser-tabs transport for the hermetic test mode. Emulates just
// enough of presence: everyone announces on join ("hello"), answers
// with their current meta ("state"), and posts "bye" on leave.
class LocalTransport {
  constructor(code, key) {
    this.key = key;
    this.bc = new BroadcastChannel("rr-meet-" + code.replace(/-/g, ""));
    this.peers = new Map();
    this.meta = null;
    this.handlers = null;
  }
  _emitPresence() {
    const map = { [this.key]: [this.meta] };
    for (const [k, m] of this.peers) map[k] = [m];
    this.handlers.onPresence(map);
  }
  join(meta, handlers) {
    this.meta = meta;
    this.handlers = handlers;
    this.bc.onmessage = ({ data: msg }) => {
      if (!msg || msg.from === this.key) return;
      if (msg.kind === "hello") {
        this.peers.set(msg.from, msg.meta);
        this.bc.postMessage({ kind: "state", from: this.key, meta: this.meta });
        this._emitPresence();
      } else if (msg.kind === "state") {
        this.peers.set(msg.from, msg.meta);
        this._emitPresence();
      } else if (msg.kind === "bye") {
        this.peers.delete(msg.from);
        this._emitPresence();
      } else if (msg.kind === "signal") {
        if (msg.to === this.key) this.handlers.onSignal(msg.from, msg.data);
      } else if (msg.kind === "event") {
        this.handlers.onEvent(msg.event, msg.payload);
      }
    };
    this.bc.postMessage({ kind: "hello", from: this.key, meta });
    this._emitPresence();
    return Promise.resolve();
  }
  track(meta) {
    this.meta = meta;
    this.bc.postMessage({ kind: "state", from: this.key, meta });
    this._emitPresence();
    return Promise.resolve();
  }
  send(event, payload) { this.bc.postMessage({ kind: "event", from: this.key, event, payload }); }
  signal(to, data) { this.bc.postMessage({ kind: "signal", from: this.key, to, data }); }
  async leave() { try { this.bc.postMessage({ kind: "bye", from: this.key }); this.bc.close(); } catch { /* leaving anyway */ } }
}

// ─── media ────────────────────────────────────────────────────────────────

// Capture at 1080p when the camera offers it; the sender caps the actual
// sent resolution per roster size (meet-core sendPolicy), so a 1:1 gets
// full 1080p while bigger calls downscale. `ideal` (not min/exact) means
// a 720p webcam still works — it just caps there.
const GUM_VIDEO = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, facingMode: "user" };
const GUM_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// Opus tuning applied to every outgoing audio track's SDP. WebRTC's
// default voice bitrate (~32kbps) sounds thin; 64kbps mono with in-band
// FEC (packet-loss concealment) and DTX (silence suppression) is the
// fuller-but-still-cheap sweet spot for interviews.
const OPUS_BITRATE = 64000;
function tuneOpusSdp(sdp) {
  if (!sdp || !/\bopus\b/i.test(sdp)) return sdp;
  const pt = (sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`(a=fmtp:${pt} )([^\\r\\n]*)`), (m, head, params) => {
    const kv = Object.fromEntries(params.split(";").filter(Boolean).map((p) => {
      const [k, v] = p.split("="); return [k.trim(), v];
    }));
    kv.maxaveragebitrate = String(OPUS_BITRATE);
    kv.stereo = "0";
    kv.useinbandfec = "1";
    kv.usedtx = "1";
    return head + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(";");
  });
}

// Remembered device choices (settings popover). `ideal` not `exact`:
// an unplugged headset must never block the join.
function devicePrefs() {
  try { return JSON.parse(localStorage.getItem("rr_meet_devices") || "{}"); } catch { return {}; }
}
function saveDevicePref(kind, deviceId) {
  const prefs = devicePrefs();
  prefs[kind] = deviceId;
  try { localStorage.setItem("rr_meet_devices", JSON.stringify(prefs)); } catch { /* private mode */ }
}
function gumVideo() {
  const prefs = devicePrefs();
  return prefs.cam ? { ...GUM_VIDEO, deviceId: { ideal: prefs.cam } } : GUM_VIDEO;
}
function gumAudio() {
  const prefs = devicePrefs();
  return prefs.mic ? { ...GUM_AUDIO, deviceId: { ideal: prefs.mic } } : GUM_AUDIO;
}

// Tiered acquisition: cam+mic → mic only → cam only → nothing. Joining
// with zero devices is legal (recvonly listener), same as Zoom.
async function acquireMedia() {
  // Radio mode is audio-only — never open the camera.
  const tries = PTT
    ? [ { video: false, audio: gumAudio() } ]
    : [
    { video: gumVideo(), audio: gumAudio() },
    { video: false, audio: gumAudio() },
    { video: gumVideo(), audio: false },
  ];
  for (const constraints of tries) {
    try { return await navigator.mediaDevices.getUserMedia(constraints); }
    catch { /* fall through to the next tier */ }
  }
  return null;
}

function adoptStream(stream) {
  state.localStream = stream || new MediaStream();
  state.camTrack = state.localStream.getVideoTracks()[0] || null;
  state.micTrack = state.localStream.getAudioTracks()[0] || null;
  if (!state.camTrack) state.cam = false;
  if (!state.micTrack) state.mic = false;
  if (state.camTrack) { state.camTrack.enabled = state.cam; state.camTrack.contentHint = "motion"; }
  if (state.micTrack) { state.micTrack.enabled = state.mic; state.micTrack.contentHint = "speech"; }
}

// Swap the live microphone or camera mid-call (settings popover).
// Replaces the track in the local stream, in every sender, in the
// preview, and in the level monitor — without renegotiating.
async function switchDevice(kind, deviceId) {
  saveDevicePref(kind, deviceId);
  try {
    if (kind === "mic") {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { ...GUM_AUDIO, deviceId: { exact: deviceId } } });
      const track = s.getAudioTracks()[0];
      track.contentHint = "speech";
      track.enabled = state.mic;
      const old = state.micTrack;
      state.micTrack = track;
      if (old) { try { state.localStream.removeTrack(old); old.stop(); } catch { /* replaced */ } }
      state.localStream.addTrack(track);
      for (const p of peers.values()) {
        const sender = p.pc.getSenders().find((se) => se.track === old || (se.track && se.track.kind === "audio" && se.track !== state.screenAudioTrack));
        if (sender) sender.replaceTrack(track).catch(() => {});
        // No audio sender = we joined mic-less (denied/unplugged) —
        // add one so peers already in the call hear the new mic too.
        else p.pc.addTrack(track, state.localStream); // renegotiates
      }
      monitorLocalMic();
    } else if (kind === "cam") {
      const s = await navigator.mediaDevices.getUserMedia({ video: { ...GUM_VIDEO, deviceId: { exact: deviceId } } });
      const track = s.getVideoTracks()[0];
      track.contentHint = "motion";
      track.enabled = state.cam;
      const old = state.camTrack;
      state.camTrack = track;
      if (old) { try { state.localStream.removeTrack(old); old.stop(); } catch { /* replaced */ } }
      state.localStream.addTrack(track);
      if (blur.active && blur.srcVideo) {
        // Blur pipeline keeps flowing — just point it at the new camera.
        blur.srcVideo.srcObject = new MediaStream([track]);
        blur.srcVideo.play().catch(() => {});
      } else if (!state.sharing) {
        replaceOutgoingVideo(track);
      }
      const lv = $("lobby-video");
      if (lv && document.body.dataset.screen === "lobby") { lv.srcObject = localPreviewStream(); lv.play().catch(() => {}); }
    } else if (kind === "spk") {
      state.sinkId = deviceId;
      applySinkId();
    }
    renderGrid();
    syncControls();
  } catch (err) {
    console.warn("device switch failed", err);
    toast("Couldn't switch device — check it's connected.");
  }
}

// Route remote audio to the chosen output device (Chrome/Edge).
function applySinkId() {
  if (!("setSinkId" in HTMLMediaElement.prototype)) return;
  for (const tile of tiles.values()) {
    const v = tile.querySelector("video");
    if (v && !v.muted) v.setSinkId(state.sinkId || "").catch(() => {});
  }
}

// The video track peers should currently receive: a screen share wins,
// then the blurred camera composite, then the raw camera.
function currentVideoTrack() {
  return state.screenTrack || (blur.active && blur.track) || state.camTrack;
}

function replaceOutgoingVideo(track) {
  for (const p of peers.values()) {
    const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(track).catch(() => {});
    else if (track) p.pc.addTrack(track, state.localStream); // renegotiates automatically
  }
}

// ─── webrtc mesh (perfect negotiation) ────────────────────────────────────

function ensurePeer(key) {
  let p = peers.get(key);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers });
  p = {
    key, pc,
    polite: isPolite(state.peerKey, key),
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    pending: [],
    stream: new MediaStream(),
    prevStats: null, // {packetsLost, packetsReceived, at} for loss deltas
  };
  if (state.micTrack) pc.addTrack(state.micTrack, state.localStream);
  const v = currentVideoTrack();
  if (v) pc.addTrack(v, state.localStream);
  // Mid-share joiner: hand them the live tab/system audio too, not
  // just the screen video (stopShare removes it by track scan).
  if (state.screenAudioTrack) pc.addTrack(state.screenAudioTrack, state.localStream);

  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      // Explicit create → Opus-tune → setLocalDescription. Perfect
      // negotiation's glare handling is unchanged (it's about WHO applies
      // WHICH description WHEN, not implicit vs explicit); we just need
      // the SDP in hand to raise the audio bitrate before it's applied.
      const offer = await pc.createOffer();
      offer.sdp = tuneOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      // .toJSON(): plain {type, sdp} — live platform objects don't
      // survive BroadcastChannel's structured clone (local transport).
      state.transport.signal(key, { description: pc.localDescription.toJSON() });
    } catch (err) {
      console.warn("negotiationneeded failed", err);
    } finally {
      p.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.transport.signal(key, { candidate: candidate.toJSON() });
  };
  pc.ontrack = ({ track }) => {
    p.stream.addTrack(track);
    const tile = tiles.get(key);
    if (tile) {
      const video = tile.querySelector("video");
      if (video.srcObject !== p.stream) video.srcObject = p.stream;
      video.play().catch(() => { /* autoplay retries on next user gesture */ });
    }
    if (track.kind === "audio") monitorRemote(key, p.stream);
    renderGrid();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") pc.restartIce();
    if (pc.connectionState === "connected") tunePeerSenders(p);
    renderGrid();
  };
  peers.set(key, p);
  tunePeerSenders(p);
  return p;
}

// Test-only: the E2E suite reads the applied localDescription to assert
// the Opus tune landed. Guarded to local mode so it never exists in prod.
if (LOCAL_MODE) {
  window.__rrPeerProbe = () => { for (const p of peers.values()) return p.pc; return null; };
}

// Apply the mesh send policy (meet-core sendPolicy) to one peer's video
// sender: cap bitrate + downscale as the roster grows so upload stays
// inside a normal uplink, keep full quality for screen shares, prefer
// framerate for camera motion and resolution for shared text.
function tunePeerSenders(p) {
  const policy = sendPolicy(Math.max(state.roster.length, peers.size + 1), state.sharing);
  for (const sender of p.pc.getSenders()) {
    if (!sender.track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      if (sender.track.kind === "video") {
        params.encodings[0].maxBitrate = policy.maxBitrate;
        params.encodings[0].scaleResolutionDownBy = policy.scaleResolutionDownBy;
        params.degradationPreference = policy.degradationPreference;
      } else {
        // Belt-and-suspenders with the SDP fmtp: raise the Opus target
        // bitrate on the sender too (some browsers honour this more
        // reliably than maxaveragebitrate).
        params.encodings[0].maxBitrate = OPUS_BITRATE;
      }
      sender.setParameters(params).catch(() => { /* pre-negotiation — retried on connect */ });
    } catch { /* pre-negotiation — retried on connect */ }
  }
}

function tuneAllSenders() {
  for (const p of peers.values()) tunePeerSenders(p);
}

async function handleSignal(from, data) {
  if (state.left || state.knock || !data) return;
  const p = ensurePeer(from);
  const pc = p.pc;
  try {
    if (data.description) {
      const desc = data.description;
      const readyForOffer = !p.makingOffer
        && (pc.signalingState === "stable" || p.isSettingRemoteAnswerPending);
      const offerCollision = desc.type === "offer" && !readyForOffer;
      p.ignoreOffer = !p.polite && offerCollision;
      if (p.ignoreOffer) return;
      p.isSettingRemoteAnswerPending = desc.type === "answer";
      await pc.setRemoteDescription(desc);
      p.isSettingRemoteAnswerPending = false;
      while (p.pending.length) {
        await pc.addIceCandidate(p.pending.shift()).catch(() => {});
      }
      if (desc.type === "offer") {
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpusSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        state.transport.signal(from, { description: pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      if (!pc.remoteDescription) p.pending.push(data.candidate);
      else await pc.addIceCandidate(data.candidate).catch((err) => { if (!p.ignoreOffer) console.warn("addIceCandidate", err); });
    }
  } catch (err) {
    console.warn("signal handling failed", err);
  }
}

function removePeer(key) {
  const p = peers.get(key);
  if (p) { try { p.pc.close(); } catch { /* already closed */ } peers.delete(key); }
  dropMonitor(key);
  if (state.pinnedKey === key) state.pinnedKey = null;
  if (state.activeSpeaker === key) state.activeSpeaker = null;
  const tile = tiles.get(key);
  if (tile) { tile.remove(); tiles.delete(key); }
}

function handlePresence(stateMap) {
  if (state.left) return;
  const entries = [];
  for (const [key, metas] of Object.entries(stateMap || {})) {
    const meta = metas[metas.length - 1] || {};
    entries.push({ key, ...meta });
  }
  // Waiting room: knocking guests are held OUT of the mesh — no tiles,
  // no peer connections, no media — until a host admits them. This is a
  // cooperative gate (the invite code stays the security boundary), but
  // it gives interviews the Zoom flow: applicants wait, staff admit.
  const participants = entries.filter((e) => !e.knock);
  const knockers = sortRoster(entries.filter((e) => e.knock && e.key !== state.peerKey));
  const prevByKey = new Map(state.roster.map((r) => [r.key, r]));
  const prevWaitKeys = new Set(state.waiting.map((w) => w.key));
  state.roster = sortRoster(participants);
  state.waiting = knockers;
  const nowKeys = new Set(participants.map((r) => r.key));

  if (!state.knock) {
    for (const ent of state.roster) {
      // Raised-hand / recording rising edges → toast, remote peers only.
      const prev = prevByKey.get(ent.key);
      if (ent.key !== state.peerKey && ent.hand && prev && !prev.hand) {
        toast(`✋ ${ent.name || "Someone"} raised their hand`);
      }
      if (ent.key !== state.peerKey && prev && !prev.rec && ent.rec) {
        toast(`⏺ ${ent.name || "Someone"} is recording this meeting`);
        chime(true);
      }
      if (ent.key !== state.peerKey && prev && prev.rec && !ent.rec) {
        toast(`${ent.name || "Someone"} stopped recording`);
      }
      if (ent.key !== state.peerKey) {
        ensurePeer(ent.key);
        if (!prevByKey.has(ent.key) && prevByKey.size) {
          toast(`${ent.name || "Someone"} joined`);
          chime(true);
        }
      }
    }
    for (const key of [...peers.keys()]) {
      if (!nowKeys.has(key)) {
        removePeer(key);
        toast("A participant left");
        chime(false);
      }
    }
  }
  if (canAdmitGuests()) {
    for (const k of knockers) {
      if (!prevWaitKeys.has(k.key)) {
        toast(`${k.name || "Someone"} is waiting to join`);
        chime(true);
      }
    }
  }
  renderWaitingUI();
  tuneAllSenders(); // roster size changed → re-apply the mesh send policy
  renderGrid();
}

// ─── waiting room · host queue UI + admission events ─────────────────────

// Who gets the Admit/Deny queue? Hosts and staff. FAIL-SAFE: if nobody
// in the room advertises host powers (system-minted room where is_host
// detection failed, host on a stale client, migration not yet applied),
// every participant already inside gets it — field report 2026-07-11: a
// guest sat in the waiting room while the interviewer had no admit UI
// at all. A stuck waiting room is worse than a generous one; the
// unguessable invite code remains the actual security boundary.
function canAdmitGuests() {
  if (state.knock || document.body.dataset.screen !== "room") return false;
  if (state.isHost) return true;
  return !state.roster.some((r) => r.key !== state.peerKey && r.host);
}

// The "loud" admit alert: a persistent top-of-call banner, a pulsing
// header chip, a tab-title badge, and a repeating chime — so a host who
// stepped away can't miss that someone is knocking. Everything keys off
// canAdmitGuests(), so knocking guests and non-hosts never see it.
const BASE_TITLE = document.title;
let waitAlertTimer = null;

function updateWaitAlert(visible, q) {
  const banner = $("wait-banner");
  $("btn-waiting").classList.toggle("pulsing", visible);
  if (!visible) {
    if (banner) banner.hidden = true;
    if (waitAlertTimer) { clearInterval(waitAlertTimer); waitAlertTimer = null; }
    document.title = BASE_TITLE;
    return;
  }
  const n = q.length;
  if (banner) {
    $("wait-banner-text").textContent = n === 1
      ? `${q[0].name || "Someone"} is waiting to join`
      : `${n} people are waiting to join`;
    $("wait-banner-admit").textContent = n === 1 ? "Admit" : "Admit all";
    banner.hidden = false;
  }
  document.title = `(${n}) Waiting to join — ${BASE_TITLE}`;
  // Re-chime every 18s while anyone is still waiting — a one-time blip on
  // the first knock is easy to miss if the host is heads-down elsewhere.
  if (!waitAlertTimer) {
    waitAlertTimer = setInterval(() => {
      if (state.waiting.length && canAdmitGuests()) chime(true);
      else { clearInterval(waitAlertTimer); waitAlertTimer = null; }
    }, 18000);
  }
}

function admitAll() {
  for (const k of state.waiting.slice()) admitGuest(k.key, k.name);
}

function renderWaitingUI() {
  const btn = $("btn-waiting");
  if (!btn) return;
  const q = state.waiting;
  const visible = canAdmitGuests() && q.length > 0;
  btn.style.display = visible ? "" : "none";
  btn.textContent = q.length === 1 ? "1 waiting" : `${q.length} waiting`;
  updateWaitAlert(visible, q);
  const pop = $("waiting-pop");
  // Auto-open when someone new knocks — the chip alone was missable in
  // the field. Manual toggle still works; the pop closes itself when
  // the queue empties.
  const prevCount = renderWaitingUI._n || 0;
  renderWaitingUI._n = visible ? q.length : 0;
  if (!visible) { pop.hidden = true; return; }
  if (q.length > prevCount) pop.hidden = false;
  const list = $("waiting-list");
  list.innerHTML = "";
  for (const k of q) {
    const row = document.createElement("div");
    row.className = "wait-row";
    const name = document.createElement("span");
    name.className = "wait-name";
    name.textContent = k.name || "Guest"; // remote input — textContent only
    const admit = document.createElement("button");
    admit.type = "button";
    admit.className = "wait-admit";
    admit.textContent = "Admit";
    admit.onclick = () => admitGuest(k.key, k.name);
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "wait-deny";
    deny.textContent = "Deny";
    deny.onclick = () => denyGuest(k.key);
    row.append(name, admit, deny);
    list.appendChild(row);
  }
}

function admitGuest(key, name) {
  if (!state.transport) return;
  state.transport.send("admit", { to: key });
  toast(`Letting ${name || "them"} in…`);
}

function denyGuest(key) {
  if (!state.transport) return;
  state.transport.send("deny", { to: key });
}

function beAdmitted() {
  if (!state.knock || state.left) return;
  state.knock = false;
  state.joinedAt = Date.now(); // in-call clock starts at admission
  publishMeta();
  startInCall();
  toast("The host let you in");
}

// ─── audio levels · speaking rings + active speaker + lobby meter ─────────
// One AnalyserNode per participant (mic for self, remote stream for
// peers), sampled 4×/s. Levels drive the green speaking ring on tiles,
// the lobby mic meter, and — through meet-core's pickActiveSpeaker
// hysteresis — who holds the stage in speaker view.

let audioCtx = null;
const monitors = new Map(); // key → {source, analyser, data, track}

function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function attachMonitor(key, stream, track) {
  const ctx = getAudioCtx();
  if (!ctx || !track) return;
  const existing = monitors.get(key);
  if (existing) {
    if (existing.track === track) return;
    try { existing.source.disconnect(); } catch { /* replacing */ }
  }
  try {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    monitors.set(key, { source, analyser, data: new Uint8Array(analyser.fftSize), track });
    // A live recording mixes every participant — including ones who
    // join mid-recording — so each new monitor feeds the record bus.
    if (rec.active && rec.dest) { try { source.connect(rec.dest); } catch { /* mix is best-effort */ } }
  } catch { /* no audio in stream yet */ }
}

function monitorLocalMic() {
  if (!state.micTrack) return;
  attachMonitor(state.peerKey, new MediaStream([state.micTrack]), state.micTrack);
}

function monitorRemote(key, stream) {
  const track = stream.getAudioTracks()[0];
  if (track) attachMonitor(key, stream, track);
}

function dropMonitor(key) {
  const m = monitors.get(key);
  if (m) { try { m.source.disconnect(); } catch { /* gone */ } monitors.delete(key); }
}

function levelOf(mon) {
  mon.analyser.getByteTimeDomainData(mon.data);
  let sum = 0;
  for (let i = 0; i < mon.data.length; i++) {
    const v = (mon.data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / mon.data.length);
}

const SPEAK_THRESHOLD = 0.02;

function startLevelLoop() {
  if (state.levelTimer) return;
  state.levelTimer = setInterval(() => {
    const levels = {};
    for (const [key, mon] of monitors) {
      // A muted self mic still captures locally — gate it to zero so we
      // never show our own speaking ring while muted.
      if (key === state.peerKey && !(state.mic && state.micTrack)) { levels[key] = 0; continue; }
      levels[key] = levelOf(mon);
    }
    // Lobby meter
    if (document.body.dataset.screen === "lobby") {
      const meter = $("lobby-meter-fill");
      if (meter) meter.style.width = Math.min(100, Math.round((levels[state.peerKey] || 0) * 400)) + "%";
      return;
    }
    if (document.body.dataset.screen !== "room") return;
    for (const [key, tile] of tiles) {
      tile.classList.toggle("speaking", (levels[key] || 0) > SPEAK_THRESHOLD);
    }
    const next = pickActiveSpeaker(levels, state.activeSpeaker, state.lastSpeakerSwitch, Date.now());
    if (next !== state.activeSpeaker) {
      state.activeSpeaker = next;
      state.lastSpeakerSwitch = Date.now();
      if (state.view === "speaker" && !state.pinnedKey) renderGrid();
    }
  }, 250);
}

function stopLevelLoop() {
  clearInterval(state.levelTimer);
  state.levelTimer = null;
}

// ─── connection quality · per-tile bars from getStats ────────────────────
// RTT from the nominated candidate pair + incoming packet-loss delta,
// classified by meet-core qualityLevel into 0-3 bars every 3s.

function startStatsLoop() {
  if (state.statsTimer) return;
  state.statsTimer = setInterval(async () => {
    if (document.body.dataset.screen !== "room") return;
    for (const [key, p] of peers) {
      let rttMs = null, lost = 0, received = 0;
      try {
        const stats = await p.pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded" && s.currentRoundTripTime != null) {
            rttMs = s.currentRoundTripTime * 1000;
          }
          if (s.type === "inbound-rtp" && !s.isRemote) {
            lost += s.packetsLost || 0;
            received += s.packetsReceived || 0;
          }
        });
      } catch { continue; }
      const prev = p.prevStats || { lost: 0, received: 0 };
      const dLost = Math.max(0, lost - prev.lost);
      const dRecv = Math.max(0, received - prev.received);
      p.prevStats = { lost, received };
      const lossPct = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0;
      const level = p.pc.connectionState === "connected" ? qualityLevel(rttMs ?? 40, lossPct) : 0;
      const tile = tiles.get(key);
      if (tile) tile.querySelector(".qbars")?.setAttribute("data-level", String(level));
    }
  }, 3000);
}

function stopStatsLoop() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
}

// ─── recording (host) · canvas composite + mixed audio → .webm ───────────
// Local recording, Zoom-style: the host's browser composites the live
// gallery (or the screen-share stage) onto a 1280×720 canvas at ~30fps,
// mixes every participant's audio through a MediaStreamDestination bus,
// and MediaRecorder writes the file. Stopping downloads it — nothing is
// uploaded anywhere. Every participant sees a red REC pill + toast the
// moment it starts (presence meta.rec).

const rec = {
  active: false, recorder: null, chunks: [], canvas: null, cctx: null,
  drawTimer: null, dest: null, stream: null,
};
const REC_W = 1280, REC_H = 720;

function toggleRecording() {
  if (rec.active) stopRecording();
  else startRecording();
}

function startRecording() {
  const actx = getAudioCtx();
  if (!actx || !window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    toast("Recording isn't supported in this browser");
    return;
  }
  rec.canvas = document.createElement("canvas");
  rec.canvas.width = REC_W;
  rec.canvas.height = REC_H;
  rec.cctx = rec.canvas.getContext("2d");
  rec.dest = actx.createMediaStreamDestination();
  for (const mon of monitors.values()) {
    try { mon.source.connect(rec.dest); } catch { /* mix is best-effort */ }
  }
  const vTrack = rec.canvas.captureStream(30).getVideoTracks()[0];
  rec.stream = new MediaStream([vTrack, ...rec.dest.stream.getAudioTracks()]);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  try {
    rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
  } catch (err) {
    console.warn("MediaRecorder failed", err);
    toast("Recording isn't supported in this browser");
    cleanupRecording();
    return;
  }
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = finalizeRecording;
  rec.recorder.start(1000);
  rec.drawTimer = setInterval(drawRecFrame, 33);
  rec.active = true;
  state.rec = true;
  $("btn-record").classList.add("on");
  publishMeta();
  toast("Recording started — every participant sees the indicator");
}

function stopRecording() {
  if (!rec.active) return;
  rec.active = false;
  state.rec = false;
  $("btn-record").classList.remove("on");
  clearInterval(rec.drawTimer);
  try { rec.recorder.stop(); } catch { finalizeRecording(); }
  publishMeta();
}

function finalizeRecording() {
  if (rec.chunks.length) {
    const blob = new Blob(rec.chunks, { type: rec.chunks[0].type || "video/webm" });
    const ext = /mp4/.test(blob.type) ? "mp4" : "webm";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `RouteReady-Meet-${state.code || "call"}-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    toast("Recording saved to your downloads");
  }
  cleanupRecording();
}

function cleanupRecording() {
  clearInterval(rec.drawTimer);
  if (rec.dest) {
    for (const mon of monitors.values()) {
      try { mon.source.disconnect(rec.dest); } catch { /* already gone */ }
    }
  }
  if (rec.stream) for (const t of rec.stream.getTracks()) { try { t.stop(); } catch { /* stopped */ } }
  rec.recorder = null; rec.stream = null; rec.dest = null;
  rec.canvas = null; rec.cctx = null; rec.chunks = [];
}

function drawRecTile(entry, x, y, w, h, contain) {
  const c = rec.cctx;
  c.fillStyle = "#20242E";
  c.fillRect(x, y, w, h);
  const tile = tiles.get(entry.key);
  const video = tile && tile.querySelector("video");
  const me = entry.key === state.peerKey;
  const camOn = me ? (state.sharing || (state.cam && !!state.camTrack)) : (entry.cam || entry.screen);
  if (video && video.videoWidth && camOn) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (contain) {
      const s = Math.min(w / vw, h / vh);
      const dw = vw * s, dh = vh * s;
      c.fillStyle = "#000";
      c.fillRect(x, y, w, h);
      c.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const s = Math.max(w / vw, h / vh);
      const sw = w / s, sh = h / s;
      c.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
    }
  } else {
    c.fillStyle = "#333B4E";
    const r = Math.min(w, h) * 0.18;
    c.beginPath();
    c.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#E5E7EB";
    c.font = `700 ${Math.round(r * 0.8)}px Inter, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(initials(entry.name), x + w / 2, y + h / 2);
  }
  const label = (entry.name || "Guest") + (entry.key === state.peerKey ? " (you)" : "");
  c.font = "600 13px Inter, sans-serif";
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
  const tw = c.measureText(label).width;
  c.fillStyle = "rgba(10,12,16,.72)";
  c.fillRect(x + 8, y + h - 28, tw + 14, 20);
  c.fillStyle = "#F3F4F6";
  c.fillText(label, x + 15, y + h - 14);
}

function drawRecFrame() {
  if (!rec.cctx) return;
  const c = rec.cctx;
  c.fillStyle = "#111318";
  c.fillRect(0, 0, REC_W, REC_H);
  const roster = state.roster.length ? state.roster : [{ key: state.peerKey, ...myMeta() }];
  const sharer = roster.find((r) => r.screen);
  const GAP = 8;
  if (sharer) {
    const stripH = 132;
    drawRecTile(sharer, GAP, GAP, REC_W - GAP * 2, REC_H - stripH - GAP * 3, true);
    const rest = roster.filter((r) => r.key !== sharer.key);
    const tw = Math.round(stripH * 16 / 9);
    let x = GAP;
    for (const entry of rest) {
      if (x + tw > REC_W - GAP) break; // strip overflow — recorded layout stays clean
      drawRecTile(entry, x, REC_H - stripH - GAP, tw, stripH, false);
      x += tw + GAP;
    }
  } else {
    const { cols, rows } = gridDims(roster.length);
    const cw = (REC_W - GAP * (cols + 1)) / cols;
    const ch = (REC_H - GAP * (rows + 1)) / rows;
    roster.forEach((entry, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      drawRecTile(entry, GAP + col * (cw + GAP), GAP + row * (ch + GAP), cw, ch, false);
    });
  }
  // On-canvas REC marker so the file itself shows it was a recording.
  c.fillStyle = "#DC2626";
  c.beginPath();
  c.arc(REC_W - 74, 26, 6, 0, Math.PI * 2);
  c.fill();
  c.font = "700 14px Inter, sans-serif";
  c.textAlign = "left";
  c.fillText("REC", REC_W - 60, 31);
}

// ─── background blur · MediaPipe selfie segmentation ─────────────────────
// Camera → hidden <video> → per-frame person mask (MediaPipe tasks-vision,
// lazy-loaded from CDN only when toggled) → canvas composite (sharp person
// over blur(14px) background) → captureStream track replaces the outgoing
// camera. Segmentation runs on a downscaled frame (480px) for speed; the
// mask upscales with canvas smoothing. Everything degrades gracefully: if
// the CDN/model/GPU fails, the toggle flips back and the raw camera flows.

const blur = {
  active: false, loading: false, segmenter: null, srcVideo: null,
  canvas: null, cctx: null, small: null, sctx: null, maskCanvas: null,
  maskCtx: null, timer: null, track: null, lastTs: 0,
};
// ?blurbase= (local test mode only) points at a served copy of the
// @mediapipe/tasks-vision package + model so the blur pipeline is
// testable offline; production loads from the CDN.
const BLUR_BASE_OVERRIDE = LOCAL_MODE ? new URLSearchParams(location.search).get("blurbase") : null;
const BLUR_CDN = BLUR_BASE_OVERRIDE || "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const BLUR_MODEL = BLUR_BASE_OVERRIDE
  ? BLUR_BASE_OVERRIDE + "/selfie_segmenter.tflite"
  : "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const BLUR_SEG_W = 480;

async function loadSegmenter() {
  const vision = await import(BLUR_CDN + "/vision_bundle.mjs");
  const files = await vision.FilesetResolver.forVisionTasks(BLUR_CDN + "/wasm");
  return vision.ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: BLUR_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
}

function blurFrame() {
  const v = blur.srcVideo;
  if (!v || !v.videoWidth || !blur.segmenter) return;
  const W = blur.canvas.width = v.videoWidth;
  const H = blur.canvas.height = v.videoHeight;
  const sw = BLUR_SEG_W, sh = Math.max(2, Math.round(H * (BLUR_SEG_W / W)));
  blur.small.width = sw; blur.small.height = sh;
  blur.sctx.drawImage(v, 0, 0, sw, sh);
  let ts = performance.now();
  if (ts <= blur.lastTs) ts = blur.lastTs + 1; // segmentForVideo needs monotonic timestamps
  blur.lastTs = ts;
  let result;
  try {
    result = blur.segmenter.segmentForVideo(blur.small, ts);
  } catch (err) {
    console.warn("segmentation failed — disabling blur", err);
    stopBlur();
    toast("Background blur hit an error and was turned off");
    return;
  }
  const mask = result.categoryMask;
  if (mask) {
    const data = mask.getAsUint8Array();
    blur.maskCanvas.width = sw; blur.maskCanvas.height = sh;
    const img = blur.maskCtx.createImageData(sw, sh);
    for (let i = 0; i < data.length; i++) {
      // Selfie segmenter category mask: 0 = PERSON, non-zero = background
      // (verified against mediapipe-assets/portrait.jpg, and the inverse
      // shipped once — it blurred the person and kept the room sharp).
      img.data[i * 4 + 3] = data[i] > 0 ? 0 : 255;
    }
    blur.maskCtx.putImageData(img, 0, 0);
    mask.close();
  }
  result.close?.();
  const c = blur.cctx;
  c.save();
  c.globalCompositeOperation = "source-over";
  c.filter = "none";
  c.drawImage(v, 0, 0, W, H);                    // 1 · sharp frame
  c.globalCompositeOperation = "destination-in";
  c.imageSmoothingEnabled = true;
  c.drawImage(blur.maskCanvas, 0, 0, W, H);       // 2 · keep person pixels
  c.globalCompositeOperation = "destination-over";
  c.filter = "blur(14px)";
  c.drawImage(v, 0, 0, W, H);                    // 3 · blurred bg behind
  c.restore();
}

async function toggleBlur(on) {
  const want = on ?? !blur.active;
  if (want === blur.active || blur.loading) { syncBlurUI(); return; }
  if (!want) { stopBlur(); return; }
  if (!state.camTrack) { toast("Turn your camera on to blur the background"); syncBlurUI(); return; }
  blur.loading = true;
  syncBlurUI();
  try {
    blur.segmenter = blur.segmenter || await loadSegmenter();
    blur.canvas = document.createElement("canvas");
    blur.cctx = blur.canvas.getContext("2d");
    blur.small = document.createElement("canvas");
    blur.sctx = blur.small.getContext("2d", { willReadFrequently: false });
    blur.maskCanvas = document.createElement("canvas");
    blur.maskCtx = blur.maskCanvas.getContext("2d");
    blur.srcVideo = document.createElement("video");
    blur.srcVideo.muted = true;
    blur.srcVideo.playsInline = true;
    blur.srcVideo.srcObject = new MediaStream([state.camTrack]);
    await blur.srcVideo.play();
    blurFrame(); // paint a real frame before the capture stream starts
    blur.track = blur.canvas.captureStream(30).getVideoTracks()[0];
    blur.track.contentHint = "motion";
    blur.timer = setInterval(blurFrame, 33);
    blur.active = true;
    if (!state.sharing) replaceOutgoingVideo(blur.track);
    renderGrid();
    toast("Background blur on");
  } catch (err) {
    console.warn("blur unavailable", err);
    toast("Background blur couldn't load — check your connection and try again");
  }
  blur.loading = false;
  syncBlurUI();
}

function stopBlur() {
  clearInterval(blur.timer);
  blur.timer = null;
  if (blur.track) { try { blur.track.stop(); } catch { /* stopped */ } blur.track = null; }
  if (blur.srcVideo) { try { blur.srcVideo.srcObject = null; } catch { /* detached */ } blur.srcVideo = null; }
  const wasActive = blur.active;
  blur.active = false;
  if (wasActive && !state.sharing) replaceOutgoingVideo(state.camTrack);
  renderGrid();
  syncBlurUI();
}

function syncBlurUI() {
  const chk = $("chk-blur");
  if (!chk) return;
  chk.checked = blur.active;
  chk.disabled = blur.loading;
  $("blur-label").textContent = blur.loading ? "Blur my background (loading…)" : "Blur my background";
}

// ─── meeting sounds ─────────────────────────────────────────────────────────
// Subtle, synthesized cues — soft sine tones, no audio asset to load or cache.
// Muteable in Settings (gear icon), remembered per browser. Each cue is a
// little sequence of notes; gentle exponential attack/release keeps them
// professional rather than beepy.

const SOUNDS_KEY = "rr_meet_sounds";
function soundsOn() { try { return localStorage.getItem(SOUNDS_KEY) !== "off"; } catch { return true; } }
function setSoundsOn(on) { try { localStorage.setItem(SOUNDS_KEY, on ? "on" : "off"); } catch { /* private mode */ } }

// note: { f: Hz, t: start offset (s), d: duration (s), v: peak gain }
const SOUND_CUES = {
  selfJoin: [{ f: 523.25, t: 0, d: 0.30, v: 0.05 }, { f: 659.25, t: 0.10, d: 0.30, v: 0.05 }, { f: 783.99, t: 0.20, d: 0.40, v: 0.055 }], // C-E-G rising: "you're in"
  join:     [{ f: 587.33, t: 0, d: 0.26, v: 0.045 }, { f: 880.00, t: 0.11, d: 0.30, v: 0.045 }], // soft rise: someone joined
  leave:    [{ f: 659.25, t: 0, d: 0.26, v: 0.045 }, { f: 440.00, t: 0.11, d: 0.32, v: 0.045 }], // soft fall: someone left
  message:  [{ f: 880.00, t: 0, d: 0.16, v: 0.03 }], // single quiet blip: chat received
  end:      [{ f: 783.99, t: 0, d: 0.30, v: 0.05 }, { f: 587.33, t: 0.12, d: 0.32, v: 0.05 }, { f: 392.00, t: 0.24, d: 0.46, v: 0.05 }], // gentle descend: meeting ended
};

function sound(name) {
  if (!soundsOn()) return;
  const cue = SOUND_CUES[name];
  if (!cue) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  for (const n of cue) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = n.f;
    const s = t0 + n.t;
    gain.gain.setValueAtTime(0.0001, s);
    gain.gain.exponentialRampToValueAtTime(n.v, s + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, s + n.d);
    osc.connect(gain).connect(ctx.destination);
    osc.start(s);
    osc.stop(s + n.d + 0.05);
  }
}

// Back-compat wrapper for the existing remote join/leave call sites.
function chime(up = true) { sound(up ? "join" : "leave"); }

// ─── presence meta ────────────────────────────────────────────────────────

function myMeta() {
  return {
    name: state.name,
    mic: state.mic,
    cam: state.cam,
    screen: state.sharing,
    hand: state.hand,
    host: state.isHost,
    knock: state.knock,
    rec: state.rec,
    joined_at: state.joinedAt,
  };
}

function publishMeta() {
  if (state.transport) state.transport.track(myMeta()).catch?.(() => {});
  // Presence sync round-trips through the server; repaint our own tile
  // immediately so toggles feel instant.
  const mine = state.roster.find((r) => r.key === state.peerKey);
  if (mine) Object.assign(mine, myMeta());
  renderGrid();
}

// ─── ui · screens ─────────────────────────────────────────────────────────

function show(screen) {
  document.body.dataset.screen = screen;
  if (screen !== "room") { const np = document.getElementById("notes-panel"); if (np) np.hidden = true; }
  if (screen === "room" && PTT) mountPttUI();
}

// ─── Push-to-talk radio UI ─────────────────────────────────────────────────
// Injected only in ?ptt=1 rooms (meet.html is untouched). A big hold-to-talk
// button keys the mic on press & hold; releasing re-mutes. The rest of the
// mesh (peers, TURN, roster, audio) is exactly a normal Meet room.
function pttSetTalk(on) {
  if (!state.micTrack) { if (on) toast("No microphone detected"); return; }
  state.mic = !!on;
  state.micTrack.enabled = !!on;
  try { publishMeta(); } catch (_) {}
  try { if (typeof syncControls === "function") syncControls(); } catch (_) {}
  const btn = document.getElementById("rr-ptt-btn");
  const st  = document.getElementById("rr-ptt-status");
  if (btn) btn.classList.toggle("live", !!on);
  if (st)  st.textContent = on ? "You're live — talking" : "Listening — hold to talk";
}

function mountPttUI() {
  if (document.getElementById("rr-ptt-bar")) return; // once
  document.body.classList.add("rr-ptt-mode");

  const style = document.createElement("style");
  style.textContent = `
    body.rr-ptt-mode #btn-cam, body.rr-ptt-mode #btn-share,
    body.rr-ptt-mode #btn-mic { display:none !important; }
    #rr-ptt-bar{ position:fixed; left:0; right:0; bottom:0; z-index:60;
      display:flex; flex-direction:column; align-items:center; gap:10px;
      padding:16px 16px calc(20px + env(safe-area-inset-bottom));
      background:linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,0)); }
    #rr-ptt-status{ color:#fff; font-weight:600; font-size:15px; text-shadow:0 1px 2px rgba(0,0,0,.6) }
    #rr-ptt-btn{ width:118px; height:118px; border-radius:50%; border:0; cursor:pointer;
      background:#2f6bff; color:#fff; font-weight:800; font-size:15px; letter-spacing:.02em;
      box-shadow:0 8px 30px rgba(0,0,0,.45); touch-action:none; user-select:none;
      display:flex; align-items:center; justify-content:center; text-align:center;
      transition:transform .08s ease, background .12s ease; }
    #rr-ptt-btn:active{ transform:scale(.96) }
    #rr-ptt-btn.live{ background:#e5484d; box-shadow:0 0 0 10px rgba(229,72,77,.25), 0 8px 30px rgba(0,0,0,.45) }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "rr-ptt-bar";
  bar.innerHTML = `
    <div id="rr-ptt-status">Listening — hold to talk</div>
    <button id="rr-ptt-btn" type="button" aria-label="Hold to talk">HOLD<br>TO TALK</button>`;
  document.body.appendChild(bar);

  const btn = document.getElementById("rr-ptt-btn");
  const down = (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (_) {} pttSetTalk(true); };
  const up   = (e) => { if (e) e.preventDefault(); pttSetTalk(false); };
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("lostpointercapture", up);
  // Hold the SPACE bar to talk (desk dispatcher).
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && document.body.classList.contains("rr-ptt-mode")
        && document.body.dataset.screen === "room") { e.preventDefault(); pttSetTalk(true); }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && document.body.classList.contains("rr-ptt-mode")) { e.preventDefault(); pttSetTalk(false); }
  });
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

// ─── ui · room grid ───────────────────────────────────────────────────────

function tileFor(entry) {
  let tile = tiles.get(entry.key);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.key = entry.key;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="avatar"><span></span></div>
      <div class="hand-badge" aria-hidden="true">✋</div>
      <div class="reactions" aria-hidden="true"></div>
      <div class="qbars" data-level="3" aria-hidden="true"><i></i><i></i><i></i></div>
      <button class="pin-btn" type="button" title="Pin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 4h6l1 7 3 2H5l3-2 1-7z"/></svg>
      </button>
      <div class="plate">
        <span class="plate-mic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg></span>
        <span class="plate-name"></span>
      </div>
      <div class="tile-status"></div>`;
    const video = tile.querySelector("video");
    if (entry.key === state.peerKey) {
      video.muted = true; // never monitor our own audio
      video.srcObject = localPreviewStream();
      tile.querySelector(".qbars").style.display = "none"; // stats are for remote links
    } else {
      const p = peers.get(entry.key);
      if (p) video.srcObject = p.stream;
      if (state.sinkId && "setSinkId" in video) video.setSinkId(state.sinkId).catch(() => {});
    }
    tile.querySelector(".pin-btn").onclick = (e) => { e.stopPropagation(); togglePin(entry.key); };
    tile.addEventListener("dblclick", () => togglePin(entry.key));
    tiles.set(entry.key, tile);
    $("grid").appendChild(tile);
  }
  return tile;
}

function togglePin(key) {
  // No pinning while the FaceTime 1:1 layout owns the stage — a double-tap
  // on the pip is two swaps (back where you started), not a pin.
  if ($("grid").classList.contains("ft")) return;
  state.pinnedKey = state.pinnedKey === key ? null : key;
  renderGrid();
}

function localPreviewStream() {
  const s = new MediaStream();
  const v = currentVideoTrack();
  if (v) s.addTrack(v);
  return s;
}

function renderGrid() {
  if (document.body.dataset.screen !== "room") return;
  const grid = $("grid");
  const roster = state.roster.length
    ? state.roster
    : [{ key: state.peerKey, ...myMeta() }];
  const nowKeys = new Set(roster.map((r) => r.key));

  // Stage precedence (Zoom semantics): a screen share always wins, then
  // an explicit pin, then — in speaker view — the active speaker.
  const sharer = roster.find((r) => r.screen);
  let stageKey = null;
  if (sharer) stageKey = sharer.key;
  else if (state.pinnedKey && nowKeys.has(state.pinnedKey)) stageKey = state.pinnedKey;
  else if (state.view === "speaker" && roster.length > 1) {
    stageKey = (state.activeSpeaker && nowKeys.has(state.activeSpeaker))
      ? state.activeSpeaker
      : (roster.find((r) => r.key !== state.peerKey) || roster[0]).key;
  }
  // FaceTime layout (?call=1 on a phone-sized viewport, exactly two in
  // the room, nobody sharing): one tile owns the whole window, the other
  // rides in the pip — normally them big / me small, flipped while
  // state.ftSwapped (tap the pip to trade places, tap again to trade
  // back). Desktop call windows keep the traditional meeting layout.
  // Pin/speaker semantics resume with a third participant or a share.
  const ft = CALL && mqCallPhone.matches && !sharer && roster.length === 2;
  let pipKey = null;
  if (ft) {
    const remoteKey = (roster.find((r) => r.key !== state.peerKey) || roster[0]).key;
    stageKey = state.ftSwapped ? state.peerKey : remoteKey;
    pipKey   = state.ftSwapped ? remoteKey : state.peerKey;
  }
  grid.classList.toggle("ft", ft);

  // View-menu visibility filters (desktop meeting only — never in the
  // FaceTime pip layout, which needs both tiles). "Hide self view" drops my
  // own tile; "Hide non-video participants" drops camera-off tiles. The
  // stage tile is always kept (an audio-only active speaker still shows),
  // and we never blank the grid.
  const camOnFor = (e) => e.key === state.peerKey
    ? (state.sharing || (state.cam && !!state.camTrack))
    : (e.cam || e.screen);
  let visible = roster;
  if (!ft && state.hideSelf && roster.length > 1)
    visible = visible.filter((r) => r.key !== state.peerKey || r.key === stageKey);
  if (!ft && state.hideNonVideo)
    visible = visible.filter((r) => r.key === stageKey || camOnFor(r));
  if (!visible.length) visible = roster;
  const visKeys = new Set(visible.map((r) => r.key));

  if (CALL) {
    // The window is a call, not a meeting: title it after the far end,
    // like FaceTime (falls back to the room title while they connect).
    const remote = roster.find((r) => r.key !== state.peerKey);
    const peerName = remote?.name || "";
    const extra = roster.length > 2 ? " +" + (roster.length - 2) : "";
    $("room-title").textContent = peerName ? peerName + extra : ($("room-title").textContent || "RouteReady call");
    if (peerName) document.title = peerName + extra + " · RouteReady Call";
  }
  grid.classList.toggle("has-stage", !!stageKey);

  for (const [key, tile] of tiles) {
    if (!visKeys.has(key)) { tile.remove(); tiles.delete(key); }
  }

  const { cols, rows } = gridDims(stageKey ? Math.max(1, visible.length - 1) : visible.length);
  grid.style.setProperty("--cols", cols);
  grid.style.setProperty("--rows", rows);

  for (const entry of visible) {
    const tile = tileFor(entry);
    const me = entry.key === state.peerKey;
    const video = tile.querySelector("video");

    if (me) {
      const want = localPreviewStream();
      const cur = video.srcObject;
      const wantTrack = want.getVideoTracks()[0] || null;
      const curTrack = cur && cur.getVideoTracks ? (cur.getVideoTracks()[0] || null) : null;
      if (wantTrack !== curTrack) video.srcObject = want;
      video.play().catch(() => {});
    }

    const camOn = me ? (state.sharing || (state.cam && !!state.camTrack)) : (entry.cam || entry.screen);
    tile.classList.toggle("cam-off", !camOn);
    tile.classList.toggle("is-me", me);
    const isPip = ft && entry.key === pipKey;
    tile.classList.toggle("pip", isPip);
    if (isPip) applyPipCorner(tile);
    else tile.classList.remove("pip-tl", "pip-tr", "pip-bl", "pip-br");
    tile.classList.toggle("stage", stageKey === entry.key);
    // Screen content letterboxes (never crop shared text); camera stages crop-fill.
    tile.classList.toggle("stage-screen", !!sharer && stageKey === entry.key);
    tile.classList.toggle("pinned", state.pinnedKey === entry.key);
    tile.classList.toggle("hand-up", !!entry.hand);
    // Mirror our own camera like every meeting tool; never mirror a screen.
    video.classList.toggle("mirror", me && !state.sharing);

    tile.querySelector(".avatar span").textContent = initials(entry.name);
    tile.querySelector(".plate-name").textContent = (entry.name || "Guest") + (me ? " (you)" : "") + (entry.host ? " · host" : "");
    tile.querySelector(".plate-mic").classList.toggle("muted", me ? !(state.mic && state.micTrack) : !entry.mic);
    tile.querySelector(".pin-btn").title = state.pinnedKey === entry.key ? "Unpin" : "Pin";

    const p = me ? null : peers.get(entry.key);
    const connecting = p && p.pc.connectionState !== "connected" && !p.stream.getTracks().length;
    tile.querySelector(".tile-status").textContent = connecting ? "connecting…" : "";
  }

  // Keep DOM order = roster order (stage tile first) so CSS lays out
  // deterministically on every client.
  const stagedEntry = visible.find((r) => r.key === stageKey);
  const ordered = stagedEntry
    ? [stagedEntry, ...visible.filter((r) => r.key !== stageKey)]
    : visible;
  for (const entry of ordered) {
    const tile = tiles.get(entry.key);
    if (tile) grid.appendChild(tile);
  }

  $("people-count").textContent = String(roster.length);
  $("embed-count").textContent = String(roster.length);
  const recOn = roster.some((r) => r.rec);
  const pill = $("rec-pill");
  if (pill) pill.style.display = recOn ? "" : "none";
  const embedRec = $("embed-rec");
  if (embedRec) embedRec.style.display = recOn ? "" : "none";
}

// ─── ui · FaceTime call chrome (?call=1) ──────────────────────────────────

// The pip parks in one of four corners; renderGrid re-applies the class on
// every render so the choice survives tile reuse and roster churn.
function applyPipCorner(tile) {
  tile.classList.remove("pip-tl", "pip-tr", "pip-bl", "pip-br");
  tile.classList.add("pip-" + (state.pipCorner || "br"));
}

// Drag the pip anywhere while the pointer is down, then snap it to the
// nearest corner on release; a TAP (no real movement) swaps the pip with
// the stage and back — both FaceTime behaviors. Delegated on #grid so it
// survives tile recreation; buttons inside the pip are hidden in call mode
// so pointerdown on it is always a drag-or-tap.
const PIP_TAP_SLOP = 8; // px of movement that still counts as a tap
function wirePipDrag() {
  const grid = $("grid");
  let drag = null;
  grid.addEventListener("pointerdown", (e) => {
    const tile = e.target.closest(".tile.pip");
    if (!tile || e.button) return;
    const r = tile.getBoundingClientRect();
    const g = grid.getBoundingClientRect();
    drag = { tile, g, w: r.width, h: r.height, dx: e.clientX - r.left, dy: e.clientY - r.top,
             x0: e.clientX, y0: e.clientY, moved: false };
    try { tile.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  });
  grid.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < PIP_TAP_SLOP) return;
      drag.moved = true;
      drag.tile.classList.add("dragging");
    }
    const x = Math.min(Math.max(e.clientX - drag.g.left - drag.dx, 6), drag.g.width - drag.w - 6);
    const y = Math.min(Math.max(e.clientY - drag.g.top - drag.dy, 6), drag.g.height - drag.h - 6);
    drag.tile.style.left = x + "px"; drag.tile.style.top = y + "px";
    drag.tile.style.right = "auto"; drag.tile.style.bottom = "auto";
  });
  const end = () => {
    if (!drag) return;
    const t = drag.tile;
    if (!drag.moved) {
      // Tap → trade places with the stage (and back on the next tap).
      drag = null;
      state.ftSwapped = !state.ftSwapped;
      renderGrid();
      return;
    }
    const cx = (parseFloat(t.style.left) || 0) + drag.w / 2;
    const cy = (parseFloat(t.style.top) || 0) + drag.h / 2;
    state.pipCorner = (cy < drag.g.height / 2 ? "t" : "b") + (cx < drag.g.width / 2 ? "l" : "r");
    t.style.left = t.style.top = t.style.right = t.style.bottom = "";
    t.classList.remove("dragging");
    applyPipCorner(t);
    drag = null;
  };
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);
}

// Header + control pill fade out after a few idle seconds and wake on any
// pointer/key activity — FaceTime-style. Never hides while chat, a popover
// or the admit banner is open, and only fades opacity (pointer-events stay
// on, so the WCO drag region in the header keeps working while invisible;
// by the time you aim for a button, the move has already woken the chrome).
let _chromeTimer = 0;
let _overChrome = false; // pointer is resting on the header / control bar
function chromeWake() {
  document.body.classList.remove("chrome-hidden");
  clearTimeout(_chromeTimer);
  _chromeTimer = setTimeout(() => {
    if (document.body.dataset.screen !== "room") return;
    if (EMBED) return;               // embedded room: the dashboard owns chrome
    if (_overChrome) return;         // don't fade out from under the cursor
    if (state.chatOpen) return;
    if (document.querySelector(".pop:not([hidden])")) return;
    const wb = $("wait-banner");
    if (wb && !wb.hidden) return;
    document.body.classList.add("chrome-hidden");
  }, 3200);
}
function wireCallChrome() {
  ["pointermove", "pointerdown", "keydown", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, chromeWake, { passive: true }));
  // Keep chrome up while the pointer hovers it (a still cursor fires no
  // pointermove, so without this the bar could fade with the mouse on it).
  document.querySelectorAll(".room-head, .room-ctrls").forEach((el) => {
    el.addEventListener("mouseenter", () => { _overChrome = true; chromeWake(); });
    el.addEventListener("mouseleave", () => { _overChrome = false; chromeWake(); });
  });
  chromeWake();
}

// ─── ui · View dropdown (layout + visibility) ─────────────────────────────

// Mark the active layout + toggles and keep the Fullscreen label in sync.
function syncViewMenu() {
  document.querySelectorAll("#view-menu .vm-item").forEach((el) => {
    let on = false;
    if (el.dataset.view) on = state.view === el.dataset.view;
    else if (el.dataset.toggle) on = !!state[el.dataset.toggle];
    else if (el.dataset.action === "fullscreen") on = !!document.fullscreenElement;
    el.classList.toggle("on", on);
  });
  const fsl = $("vm-fs-label");
  if (fsl) fsl.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
}

// Anchor the (position:fixed) menu to the View button — drops below it in the
// header, flips above when the button sits low (embed mode moves it into the
// control bar), and clamps to the viewport.
function positionViewMenu() {
  const menu = $("view-menu"), btn = $("btn-view");
  if (!menu || !btn) return;
  const r = btn.getBoundingClientRect();
  const prevVis = menu.style.visibility, wasHidden = menu.hidden;
  menu.style.visibility = "hidden";
  menu.hidden = false;
  const mh = menu.offsetHeight, mw = menu.offsetWidth;
  menu.hidden = wasHidden;
  menu.style.visibility = prevVis;
  const openUp = r.bottom + 8 + mh > window.innerHeight - 8;
  let top = openUp ? r.top - 8 - mh : r.bottom + 8;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw;
  menu.style.top = Math.max(8, top) + "px";
  menu.style.left = Math.max(8, left) + "px";
}

function toggleViewMenu(force) {
  const menu = $("view-menu"), btn = $("btn-view");
  if (!menu) return;
  const open = force === undefined ? menu.hidden : force;
  if (open) { positionViewMenu(); syncViewMenu(); menu.hidden = false; }
  else menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else (document.documentElement.requestFullscreen || (() => {})).call(document.documentElement);
  } catch (_) { /* fullscreen blocked (permissions policy / iframe) */ }
}

// ─── ui · in-meeting notes (floating, draggable window) ───────────────────
// A pop-open notes window so notes can be taken WITHOUT leaving the call.
// Content autosaves to localStorage keyed by meeting code, so it survives a
// reload and is scoped per meeting. "Open in Notebook" copies the notes and
// opens the dashboard Notebook (host-only) to file them permanently.

function notesKey() { return "rr-meet-notes:" + (state.code || "_"); }

function loadNotes() {
  let v = "";
  try { v = localStorage.getItem(notesKey()) || ""; } catch { /* private mode */ }
  const ta = $("notes-text");
  if (ta) ta.value = v;
  setNotesStatus(v ? "Saved" : "");
}

function setNotesStatus(s) { const el = $("notes-status"); if (el) el.textContent = s; }

let _notesSaveT = 0;
function saveNotesSoon() {
  setNotesStatus("Saving…");
  clearTimeout(_notesSaveT);
  _notesSaveT = setTimeout(() => {
    try { localStorage.setItem(notesKey(), $("notes-text").value); setNotesStatus("Saved"); }
    catch { setNotesStatus("Couldn't save (private mode)"); }
  }, 500);
}

function toggleNotes(open) {
  const panel = $("notes-panel");
  if (!panel) return;
  const want = open === undefined ? panel.hidden : open;
  panel.hidden = !want;
  $("btn-notes").classList.toggle("on", want);
  $("btn-notes").setAttribute("aria-pressed", want ? "true" : "false");
  if (want) { loadNotes(); $("notes-text").focus(); }
}

// File the notes into the operator's Notebook and open it there. We hand the
// notes off through a localStorage "inbox" (same origin as the dashboard); the
// Notebook picks it up on load and writes a real page — one per meeting,
// updated in place — then opens it. Works whether the Notebook is backed by
// Supabase (signed in) or its local store.
function notesPageTitle() {
  const t = (state.meeting && state.meeting.title) || "RouteReady meeting";
  const d = new Date();
  const stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return t + " · " + stamp;
}
function notesToNotebook() {
  const text = $("notes-text").value;
  try {
    const KEY = "rr-notebook-inbox";
    let q = [];
    try { q = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { q = []; }
    q = q.filter((e) => e && e.code !== (state.code || "_")); // one entry per meeting
    q.push({ code: state.code || "_", title: notesPageTitle(), text, ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(q));
    toast("Saved to your Notebook");
  } catch {
    // Private mode: can't stage the hand-off — fall back to a clipboard copy.
    try { navigator.clipboard.writeText(text); toast("Notes copied — paste into your Notebook"); } catch { /* ignore */ }
  }
  openNotebook();
}
function openNotebook() {
  try { window.open("/dashboard/index.html#notebooks", "_blank", "noopener"); }
  catch (_) { location.href = "/dashboard/index.html#notebooks"; }
}

// Drag the window by its header (clamped to the viewport). Switches from the
// default right-anchored position to explicit left/top on first grab.
function wireNotesDrag() {
  const panel = $("notes-panel");
  if (!panel) return;
  const head = panel.querySelector(".notes-head");
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = r.left + "px";
    panel.style.top = r.top + "px";
    panel.style.right = "auto";
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    dragging = true;
    head.classList.add("dragging");
    try { head.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  });
  head.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
    nx = Math.max(8, Math.min(nx, window.innerWidth - w - 8));
    ny = Math.max(8, Math.min(ny, window.innerHeight - h - 8));
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove("dragging");
    try { head.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

// ─── ui · controls ────────────────────────────────────────────────────────

function syncControls() {
  const micOn = state.mic && !!state.micTrack;
  const camOn = state.cam && !!state.camTrack;
  $("btn-mic").classList.toggle("off", !micOn);
  $("btn-mic").title = state.micTrack ? (micOn ? "Mute" : "Unmute") : "No microphone";
  $("btn-cam").classList.toggle("off", !camOn);
  $("btn-cam").title = state.camTrack ? (camOn ? "Turn camera off" : "Turn camera on") : "No camera";
  $("btn-share").classList.toggle("on", state.sharing);
  $("btn-chat").classList.toggle("on", state.chatOpen);
  $("chat-unread").style.display = state.unread > 0 ? "" : "none";
  $("chat-unread").textContent = String(state.unread);
  $("lobby-mic").classList.toggle("off", !micOn);
  $("lobby-cam").classList.toggle("off", !camOn);
}

function toggleMic() {
  if (!state.micTrack) { toast("No microphone detected"); return; }
  state.mic = !state.mic;
  state.micTrack.enabled = state.mic;
  syncControls();
  publishMeta();
  syncLobbyPreview();
}

function toggleCam() {
  if (!state.camTrack) { toast("No camera detected"); return; }
  state.cam = !state.cam;
  state.camTrack.enabled = state.cam;
  syncControls();
  publishMeta();
  syncLobbyPreview();
}

async function toggleShare() {
  if (state.sharing) { stopShare(); return; }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,                    // tab/system audio when the browser offers it
      selfBrowserSurface: "exclude",  // don't offer the meeting tab itself (hall of mirrors)
      surfaceSwitching: "include",
      systemAudio: "include",
    });
  } catch {
    return; // user dismissed the picker
  }
  const track = display.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = "detail"; // shared text: sharpness beats smoothness
  state.screenTrack = track;
  state.sharing = true;
  track.onended = () => stopShare(); // browser's own "Stop sharing" bar
  replaceOutgoingVideo(track);
  // Tab/system audio rides along as an EXTRA track (music, videos, demos
  // stay audible remotely) — the mic track keeps flowing untouched.
  const audio = display.getAudioTracks()[0];
  if (audio) {
    state.screenAudioTrack = audio;
    for (const p of peers.values()) p.pc.addTrack(audio, state.localStream); // renegotiates
  }
  tuneAllSenders(); // switch the video sender to the screen policy
  syncControls();
  publishMeta();
}

function stopShare() {
  if (state.screenTrack) { try { state.screenTrack.stop(); } catch { /* already stopped */ } }
  state.screenTrack = null;
  if (state.screenAudioTrack) {
    for (const p of peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track === state.screenAudioTrack);
      if (sender) { try { p.pc.removeTrack(sender); } catch { /* renegotiates */ } }
    }
    try { state.screenAudioTrack.stop(); } catch { /* already stopped */ }
    state.screenAudioTrack = null;
  }
  state.sharing = false;
  replaceOutgoingVideo(blur.active ? blur.track : state.camTrack);
  tuneAllSenders(); // back to the camera policy for this roster size
  syncControls();
  publishMeta();
}

// ─── reactions + raise hand ───────────────────────────────────────────────

const REACTION_EMOJI = ["👍", "👏", "❤️", "😂", "🎉"];

function sendReaction(emoji) {
  if (!state.transport) return;
  state.transport.send("react", { from: state.peerKey, emoji });
  showReaction(state.peerKey, emoji); // self:false broadcast doesn't echo
  toggleReactPop(false);
}

function showReaction(key, emoji) {
  if (!REACTION_EMOJI.includes(emoji)) return; // whitelist — remote input
  const tile = tiles.get(key);
  if (!tile) return;
  const span = document.createElement("span");
  span.className = "reaction-float";
  span.textContent = emoji;
  span.style.left = 15 + Math.random() * 55 + "%";
  tile.querySelector(".reactions").appendChild(span);
  setTimeout(() => span.remove(), 2400);
}

function toggleHand() {
  state.hand = !state.hand;
  $("btn-hand").classList.toggle("on", state.hand);
  publishMeta();
  toggleReactPop(false);
}

function toggleReactPop(open) {
  const pop = $("react-pop");
  const want = open ?? pop.hidden;
  pop.hidden = !want;
  $("settings-pop").hidden = true;
}

// ─── settings popover · device pickers ────────────────────────────────────

async function toggleSettingsPop(open) {
  const pop = $("settings-pop");
  const want = open ?? pop.hidden;
  pop.hidden = !want;
  $("react-pop").hidden = true;
  if (!want) return;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* no device API */ }
  const prefs = devicePrefs();
  const fill = (selectId, kind, current) => {
    const sel = $(selectId);
    const list = devices.filter((d) => d.kind === kind);
    sel.innerHTML = "";
    if (!list.length) {
      sel.appendChild(new Option("None found", ""));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const [i, d] of list.entries()) {
      sel.appendChild(new Option(d.label || `${kind === "videoinput" ? "Camera" : kind === "audioinput" ? "Microphone" : "Speaker"} ${i + 1}`, d.deviceId));
    }
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  };
  fill("sel-mic", "audioinput", state.micTrack?.getSettings?.().deviceId || prefs.mic);
  fill("sel-cam", "videoinput", state.camTrack?.getSettings?.().deviceId || prefs.cam);
  fill("sel-spk", "audiooutput", state.sinkId || prefs.spk);
  $("spk-block").style.display = "setSinkId" in HTMLMediaElement.prototype ? "" : "none";
  $("chk-sounds").checked = soundsOn();
}

// The shareable link for the current room. Local test mode keeps the
// ?local=1 transport flag so a copied link joins the same in-browser mesh.
function meetInviteUrl() {
  return LOCAL_MODE
    ? location.origin + "/dashboard/meet.html?local=1&m=" + state.code
    : buildMeetUrl(cfg.PUBLIC_BASE_URL || location.origin, state.code);
}

async function copyInvite() {
  const url = meetInviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
  } catch {
    prompt("Copy this invite link:", url);
  }
}

// ─── ui · chat ────────────────────────────────────────────────────────────

function toggleChat(open) {
  state.chatOpen = open ?? !state.chatOpen;
  if (state.chatOpen) state.unread = 0;
  $("chat").classList.toggle("open", state.chatOpen);
  syncControls();
  if (state.chatOpen) $("chat-input").focus();
}

function appendChat({ name, text, self }) {
  const list = $("chat-list");
  const row = document.createElement("div");
  row.className = "chat-msg" + (self ? " self" : "");
  const who = document.createElement("div");
  who.className = "chat-who";
  who.textContent = self ? "You" : (name || "Guest");
  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text; // textContent — chat is remote-user input
  row.appendChild(who);
  row.appendChild(body);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  if (!self) {
    sound("message"); // soft blip on an incoming message
    if (!state.chatOpen) { state.unread++; syncControls(); }
  }
}

function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !state.transport) return;
  input.value = "";
  state.transport.send("chat", { from: state.peerKey, name: state.name, text });
  appendChat({ name: state.name, text, self: true }); // broadcast self:false doesn't echo
}

// ─── lifecycle ────────────────────────────────────────────────────────────

// Who lands in the waiting room? Only guests of a system-minted INTERVIEW
// room (host_id null → meet_lookup personal_host:false): applicants knock,
// staff admit. Hosts/staff always walk straight in, and guests of a
// person-created INSTANT meeting (personal_host:true) join directly — the
// unguessable code is the security boundary, like a Zoom link's passcode.
// In hermetic local mode knocking is opt-in (?knock=1) so signaling tests
// don't all need an admit step.
function shouldKnock() {
  if (state.isHost) return false;
  if (LOCAL_MODE) return new URLSearchParams(location.search).has("knock");
  if (state.meeting && state.meeting.personal_host) return false;
  return true;
}

async function enterRoom() {
  state.name = ($("name-input").value || "").trim() || "Guest";
  try { localStorage.setItem("rr_meet_name", state.name); } catch { /* private mode */ }
  state.joinedAt = Date.now();
  state.left = false;
  state.knock = shouldKnock();

  let transport;
  if (LOCAL_MODE) {
    transport = new LocalTransport(state.code, state.peerKey);
  } else {
    const sb = await getSb();
    // Set the Realtime token BEFORE subscribing — the onAuthStateChange
    // handler in getSb fires async, so a staff host could otherwise open
    // the channel on the un-authed publishable key and never link up.
    // Anon guests have no session and ride the public channel.
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session?.access_token) { sb.realtime.setAuth(session.access_token); dbg.authed = true; }
    } catch { /* anon guest — nothing to set */ }
    transport = new SupabaseTransport(sb, state.code, state.peerKey);
  }
  state.transport = transport;

  try {
    await transport.join(myMeta(), {
      onSignal: handleSignal,
      onPresence: handlePresence,
      onEvent: (type, payload) => {
        if (type === "chat" && payload && payload.from !== state.peerKey) appendChat(payload);
        if (type === "react" && payload && payload.from !== state.peerKey) showReaction(payload.from, payload.emoji);
        if (type === "admit" && payload && payload.to === state.peerKey) beAdmitted();
        if (type === "deny" && payload && payload.to === state.peerKey && state.knock) {
          endLocally("The host declined your request to join.");
        }
        if (type === "ended") handleEndedEvent();
      },
    });
  } catch (err) {
    console.error("transport join failed", err);
    show("lobby");
    toast("Couldn't connect to the meeting service — try again.");
    return;
  }

  if (state.knock) {
    $("waiting-title").textContent = state.meeting?.title || "RouteReady meeting";
    show("waiting");
    return;
  }
  startInCall();
}

function startInCall() {
  show("room");
  $("room-title").textContent = state.meeting?.title || "RouteReady meeting";
  $("room-code").textContent = state.code;
  clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    const t = fmtDuration(Date.now() - state.joinedAt);
    $("room-timer").textContent = t;
    $("embed-timer").textContent = t;
  }, 1000);
  $("btn-end").style.display = state.isHost ? "" : "none";
  $("btn-record").style.display = state.isHost ? "" : "none";
  $("btn-notes").style.display = state.isHost ? "" : "none";
  getAudioCtx();      // resume within the Join-click gesture
  sound("selfJoin");  // a soft "you're in" cue, like Google Meet
  monitorLocalMic();
  startLevelLoop();
  startStatsLoop();
  syncControls();
  renderWaitingUI();
  renderGrid();
  if (state.instant) showReadyCard();
  renderDebug();
}

function teardown() {
  state.left = true;
  if (rec.active) stopRecording(); // finalizes + downloads before we tear the mesh down
  if (blur.active) stopBlur();
  clearInterval(state.timerId);
  stopLevelLoop();
  stopStatsLoop();
  for (const key of [...peers.keys()]) removePeer(key);
  for (const key of [...monitors.keys()]) dropMonitor(key);
  if (state.transport) { state.transport.leave(); state.transport = null; }
  if (state.screenTrack) { try { state.screenTrack.stop(); } catch { /* already stopped */ } state.screenTrack = null; }
  if (state.screenAudioTrack) { try { state.screenAudioTrack.stop(); } catch { /* already stopped */ } state.screenAudioTrack = null; }
  if (state.localStream) for (const t of state.localStream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } }
  state.localStream = null; state.camTrack = null; state.micTrack = null;
  state.roster = [];
  state.sharing = false;
  state.hand = false;
  state.pinnedKey = null;
  state.activeSpeaker = null;
  state.knock = false;
  state.waiting = [];
  state.instant = false;
  const rc = $("ready-card");
  if (rc) rc.hidden = true;
  updateWaitAlert(false, []); // clear banner/chip/title + stop the re-chime
}

function endLocally(message) {
  const ended = message.includes("ended");
  teardown();
  if (ended) sound("end"); // gentle descending cue when the meeting is ended for you
  $("done-msg").textContent = message;
  $("btn-rejoin").style.display = ended ? "none" : "";
  show("done");
}

// An `ended` broadcast is NOT trusted on its own: the signaling channel
// is public to every invite holder, so any participant could forge one
// and kick the room, bypassing meet_end's host/staff gate. The gate
// lives server-side — confirm via meet_lookup (anon-callable) that the
// room is really ended before closing; a forged event is a no-op.
async function handleEndedEvent() {
  if (state.left) return;
  if (LOCAL_MODE) { endLocally("The host ended this meeting for everyone."); return; }
  try {
    const sb = await getSb();
    const { data } = await sb.rpc("meet_lookup", { p_code: state.code });
    if (data?.ok && data.ended) endLocally("The host ended this meeting for everyone.");
  } catch (err) {
    console.warn("could not verify ended event — staying in the call", err);
  }
}

function leaveMeeting() {
  endLocally("You left the meeting.");
}

async function endForAll() {
  if (!state.isHost) return;
  if (!LOCAL_MODE) {
    try {
      const sb = await getSb();
      await sb.rpc("meet_end", { p_code: state.code });
    } catch (err) {
      console.warn("meet_end failed", err);
    }
  }
  if (state.transport) state.transport.send("ended", { by: state.peerKey });
  endLocally("The host ended this meeting for everyone.");
}

window.addEventListener("pagehide", () => { if (state.transport) state.transport.leave(); });

// ─── lobby ────────────────────────────────────────────────────────────────

function syncLobbyPreview() {
  const video = $("lobby-video");
  const on = state.cam && !!state.camTrack;
  $("lobby-avatar").style.display = on ? "none" : "";
  $("lobby-avatar-initials").textContent = initials($("name-input").value || "");
  video.style.visibility = on ? "" : "hidden";
}

// Zoom-style connection test (lobby): gathers ICE candidates against the
// room's real server list and reports which paths work from THIS network.
// "Relay ✓" is the strict-firewall guarantee — it means this participant
// can connect even when no direct path can be punched.
async function runNetTest() {
  const btn = $("btn-nettest");
  const out = $("nettest-out");
  btn.disabled = true;
  const found = { host: false, srflx: false, relay: false };
  const ROWS = [
    ["host", "Local network"],
    ["srflx", "Internet (STUN)"],
    ["relay", "Relay (TURN) — strict firewalls"],
  ];
  const render = (final) => {
    out.innerHTML = "";
    for (const [key, label] of ROWS) {
      const row = document.createElement("div");
      row.className = "nt-row" + (found[key] ? " ok" : final ? " bad" : "");
      row.textContent = `${found[key] ? "✓" : final ? "✗" : "…"} ${label}`;
      out.appendChild(row);
    }
    if (final) {
      const sum = document.createElement("div");
      sum.className = "nt-sum";
      sum.textContent = found.relay
        ? "Excellent — you can connect from any network, including strict firewalls."
        : found.srflx
          ? "Good — typical networks connect fine; the strictest corporate firewalls may not reach you."
          : "Limited — this network is blocking most paths; try a different network if the call won't connect.";
      out.appendChild(sum);
    }
  };
  try {
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel("nettest");
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (found[e.candidate.type] === false) { found[e.candidate.type] = true; render(false); }
    };
    render(false);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 8000));
    pc.close();
    render(true);
  } catch (err) {
    console.warn("net test failed", err);
    out.textContent = "The test couldn't run in this browser.";
  }
  btn.disabled = false;
}

// `silent` sets up the lobby (media, preview, name) WITHOUT switching to
// it — used by instant meetings, which show a spinner and go straight to
// the room, but still want a fully-wired lobby to fall back to if the
// transport join fails.
async function openLobby({ silent = false } = {}) {
  if (!silent) show("lobby");
  $("lobby-title").textContent = state.meeting?.title || "RouteReady meeting";
  $("lobby-code").textContent = state.code;
  let stored = "";
  try { stored = localStorage.getItem("rr_meet_name") || ""; } catch { /* private mode */ }
  // ?name= (from the dashboard's embedded interview room) is the caller's
  // live identity — it beats a stale remembered name.
  const urlName = (new URLSearchParams(location.search).get("name") || "").trim().slice(0, 60);
  if (!$("name-input").value) $("name-input").value = urlName || stored || state.prefillName || "";

  const stream = await acquireMedia();
  adoptStream(stream);
  if (!stream) toast("Joining without camera or microphone — check browser permissions.");
  $("lobby-video").srcObject = localPreviewStream();
  $("lobby-video").play().catch(() => {});
  monitorLocalMic();
  startLevelLoop(); // drives the lobby mic meter
  syncControls();
  syncLobbyPreview();
}

// ─── home ─────────────────────────────────────────────────────────────────

// Mint a fresh room (meet_create, or a local code in test mode) and put
// its code in the URL, without joining. Shared by both host entry points:
// "Start an instant meeting" and "Create a meeting for later".
async function mintRoom() {
  if (LOCAL_MODE) {
    state.code = genMeetCode();
    state.meeting = { title: "Local test meeting", code: state.code };
    state.isHost = true;
  } else {
    const sb = await getSb();
    const { data, error } = await sb.rpc("meet_create", { p_title: null });
    if (error) throw error;
    state.code = data.code;
    state.meeting = data;
    state.isHost = true;
  }
  const q = new URLSearchParams(location.search);
  q.set("m", state.code);
  history.replaceState(null, "", location.pathname + "?" + q.toString());
}

// New-meeting menu (Google-Meet-style split: instant vs. for-later).
function toggleNewMenu(open) {
  const menu = $("new-menu");
  const want = open ?? menu.hidden;
  menu.hidden = !want;
  $("btn-new").setAttribute("aria-expanded", String(want));
}

// "Start an instant meeting": mint a room and drop the host straight into
// the live call — no lobby step. openLobby() still runs first so media,
// preview and name are set up (and so a failed transport join lands the
// host in a fully-working lobby to retry from); enterRoom() then joins
// immediately and startInCall() surfaces the "meeting's ready" share card.
async function startInstantMeeting() {
  toggleNewMenu(false);
  const btn = $("btn-new");
  btn.disabled = true;
  try {
    await mintRoom();
    state.instant = true;
    show("boot");
    await openLobby({ silent: true }); // wire the lobby (media/name) but stay on the spinner
    await enterRoom();                  // …then join straight away
  } catch (err) {
    console.error("instant meeting failed", err);
    state.instant = false;
    toast(err?.message === "forbidden" ? "Your account can't start meetings." : "Couldn't start a meeting — try again.");
  } finally {
    btn.disabled = false;
  }
}

// "Create a meeting for later": mint a room and show its shareable link
// without joining. The host can copy it now and start the call whenever.
async function createMeetingForLater() {
  toggleNewMenu(false);
  const btn = $("btn-new");
  btn.disabled = true;
  try {
    await mintRoom();
    $("later-link").textContent = meetInviteUrl();
    $("later-modal").hidden = false;
  } catch (err) {
    console.error("meet_create failed", err);
    toast(err?.message === "forbidden" ? "Your account can't start meetings." : "Couldn't start a meeting — try again.");
  } finally {
    btn.disabled = false;
  }
}

// In-room "Your meeting's ready" card — shown once when the host starts an
// instant meeting, so the invite link is one click from the empty room.
function showReadyCard() {
  const card = $("ready-card");
  if (!card || EMBED) return; // embedded interview room owns its own invite chrome
  $("ready-link").textContent = meetInviteUrl();
  card.hidden = false;
}

// ─── add people · email invites (instant meetings) ────────────────────────
// "Add others" opens a Google-Meet-style dialog: type emails into chips,
// optional note, Send. The actual mail goes out server-side via the
// meet_invite RPC (migration 0464) → email_messages → send-email, which
// only the host/staff of the room may call.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const inviteEmails = []; // pending chip addresses in the Add-people dialog

function openInviteModal() {
  inviteEmails.length = 0;
  $("invite-input").value = "";
  $("invite-note").value = "";
  $("invite-err").textContent = "";
  renderInviteChips();
  $("invite-modal").hidden = false;
  $("invite-input").focus();
}

function closeInviteModal() { $("invite-modal").hidden = true; }

function renderInviteChips() {
  const field = $("invite-field");
  const input = $("invite-input");
  field.querySelectorAll(".inv-chip").forEach((c) => c.remove());
  inviteEmails.forEach((email, i) => {
    const chip = document.createElement("span");
    chip.className = "inv-chip";
    const label = document.createElement("span");
    label.textContent = email; // user input — textContent only
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Remove " + email);
    x.textContent = "×";
    x.onclick = () => { inviteEmails.splice(i, 1); renderInviteChips(); };
    chip.append(label, x);
    field.insertBefore(chip, input);
  });
  $("invite-send").disabled = inviteEmails.length === 0;
}

// Fold a typed value into a chip. Returns false (and shows an error) only
// when the text is a non-empty, malformed address.
function addInviteEmail(raw) {
  const email = String(raw || "").trim().toLowerCase().replace(/[,;]+$/, "");
  if (!email) return true;
  if (!EMAIL_RE.test(email)) { $("invite-err").textContent = `"${email}" doesn't look like an email address.`; return false; }
  if (!inviteEmails.includes(email)) inviteEmails.push(email);
  $("invite-err").textContent = "";
  renderInviteChips();
  return true;
}

async function sendInvites() {
  const input = $("invite-input");
  addInviteEmail(input.value); // fold in whatever's still typed
  input.value = "";
  if (!inviteEmails.length) { $("invite-err").textContent = "Add at least one email address."; return; }
  const emails = inviteEmails.slice();
  const note = $("invite-note").value.trim();
  const btn = $("invite-send");
  btn.disabled = true;
  try {
    if (LOCAL_MODE) {
      await new Promise((r) => setTimeout(r, 120)); // hermetic mode has no backend
    } else {
      const sb = await getSb();
      const { data, error } = await sb.rpc("meet_invite", {
        p_code: state.code, p_emails: emails, p_message: note || null,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.reason || "invite_failed");
    }
    closeInviteModal();
    toast(emails.length === 1 ? "Invite sent" : `Invites sent to ${emails.length} people`);
  } catch (err) {
    console.error("meet_invite failed", err);
    $("invite-err").textContent = err?.message === "forbidden"
      ? "Only the host can invite people to this meeting."
      : "Couldn't send the invites — try again.";
    btn.disabled = false;
  }
}

async function joinByInput() {
  const code = normalizeMeetCode($("join-code").value);
  if (!code) { $("join-err").textContent = "That doesn't look like a meeting code or link."; return; }
  $("join-err").textContent = "";
  const q = new URLSearchParams(location.search);
  q.set("m", code);
  history.replaceState(null, "", location.pathname + "?" + q.toString());
  await resolveCode(code);
}

async function resolveCode(code) {
  state.code = code;
  if (LOCAL_MODE) {
    state.meeting = { title: "Local test meeting", code };
    state.isHost = new URLSearchParams(location.search).has("host");
    await openLobby();
    return;
  }
  show("boot");
  try {
    const sb = await getSb();
    const { data, error } = await sb.rpc("meet_lookup", { p_code: code });
    if (error) throw error;
    if (!data?.ok) {
      $("home-err").textContent = "We couldn't find that meeting — double-check the code or link.";
      show("home");
      return;
    }
    if (data.ended) {
      $("done-msg").textContent = "This meeting has ended.";
      $("btn-rejoin").style.display = "none";
      show("done");
      return;
    }
    // Locked room (0492): the host (or fellow staff) can enter and unlock;
    // everyone else is held at the door and can retry once it's opened up.
    if (data.locked && !data.is_host) {
      $("done-msg").textContent = "This meeting is locked by the host. Ask them to unlock it, then try again.";
      $("btn-rejoin").style.display = "";
      show("done");
      return;
    }
    state.meeting = data;
    state.isHost = !!data.is_host; // server-computed: auth.uid() = host_id
    // ICE config is DB-driven (migration 0458): STUN by default, TURN
    // the moment the operator adds relay credentials to app_settings.
    try {
      const { data: ice } = await sb.rpc("meet_ice_servers", { p_code: code });
      if (ice?.ok && Array.isArray(ice.ice_servers) && ice.ice_servers.length) {
        iceServers = ice.ice_servers;
      }
    } catch { /* STUN-only fallback */ }
    // Add fresh Cloudflare TURN credentials (short-lived, minted per join) on
    // TOP of the DB list. Strictly additive: if the Cloudflare secrets aren't
    // set or the mint fails, we keep STUN + the default relay. A driver (anon
    // guest carrying ?dtok) mints via the token-gated meet-turn-driver
    // function; authenticated staff use the JWT-gated meet-turn-credentials.
    // Without this, a driver on cellular / carrier-NAT gets STUN-only and the
    // call never connects (black tiles, "can't join the radio").
    try {
      const { data: cf } = DTOK
        ? await sb.functions.invoke("meet-turn-driver", { body: { token: DTOK } })
        : await sb.functions.invoke("meet-turn-credentials", { body: { code } });
      if (cf?.ok && Array.isArray(cf.ice_servers) && cf.ice_servers.length) {
        iceServers = [...(iceServers || DEFAULT_ICE), ...cf.ice_servers];
      }
    } catch { /* not configured / bad token — DB list stands */ }
    const q = new URLSearchParams(location.search);
    if (q.has("call") || PTT) {
      // Direct call (RouteReady Messages) OR the push-to-talk radio: skip the
      // lobby and drop straight into the room so it connects on open. Both the
      // caller and the callee open meet with ?call=1; a voice call passes
      // cam=0 so we join with the camera off. Radio (?ptt=1) joins audio-only
      // and muted. openLobby({silent}) still wires media/preview/name so a
      // failed join falls back to a working lobby.
      if (q.get("cam") === "0") state.cam = false;
      await openLobby({ silent: true });
      await enterRoom();
    } else {
      await openLobby();
    }
  } catch (err) {
    console.error("meet_lookup failed", err);
    $("home-err").textContent = "Couldn't reach the meeting service — check your connection and try again.";
    show("home");
  }
}

async function hydrateAuth() {
  if (LOCAL_MODE) return;
  try {
    const sb = await getSb();
    const { data: { session } } = await sb.auth.getSession();
    state.session = session;
    if (session) {
      $("new-wrap").style.display = "";
      $("home-signin").style.display = "none";
      const { data: me } = await sb.from("app_users").select("full_name").eq("id", session.user.id).maybeSingle();
      if (me?.full_name) state.prefillName = me.full_name;
      // Host detection for rooms we open by code later.
      state.userId = session.user.id;
      loadRecent(sb).catch(() => { /* recents are decorative */ });
    }
  } catch (err) {
    console.warn("auth hydrate failed", err); // guests proceed without it
  }
}

async function loadRecent(sb) {
  const { data } = await sb.from("meetings")
    .select("code,title,created_at,ended_at,host_id")
    .order("created_at", { ascending: false })
    .limit(5);
  if (!data?.length) return;
  const wrap = $("recent");
  wrap.innerHTML = "<h3>Recent meetings</h3>";
  for (const m of data) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "recent-row";
    row.innerHTML = `<span class="recent-title">${esc(m.title)}</span>
      <span class="recent-meta">${esc(m.code)}${m.ended_at ? " · ended" : ""}</span>`;
    row.disabled = !!m.ended_at;
    row.onclick = () => { $("join-code").value = m.code; joinByInput(); };
    wrap.appendChild(row);
  }
  wrap.style.display = "";
}

// ─── boot ─────────────────────────────────────────────────────────────────

function wire() {
  $("btn-new").onclick = () => toggleNewMenu();
  $("mi-instant").onclick = startInstantMeeting;
  $("mi-later").onclick = createMeetingForLater;
  $("ready-close").onclick = () => { $("ready-card").hidden = true; };
  $("ready-copy").onclick = copyInvite;
  $("ready-add").onclick = openInviteModal;
  $("invite-cancel").onclick = closeInviteModal;
  $("invite-send").onclick = sendInvites;
  $("invite-modal").addEventListener("click", (e) => { if (e.target === $("invite-modal")) closeInviteModal(); });
  $("invite-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (addInviteEmail(e.target.value)) e.target.value = ""; }
    else if (e.key === "Backspace" && !e.target.value && inviteEmails.length) { inviteEmails.pop(); renderInviteChips(); }
    else if (e.key === "Escape") { e.preventDefault(); closeInviteModal(); }
  });
  $("invite-input").addEventListener("blur", () => {
    const v = $("invite-input").value.trim();
    if (v && addInviteEmail(v)) $("invite-input").value = "";
  });
  $("later-copy").onclick = copyInvite;
  $("later-done").onclick = () => { $("later-modal").hidden = true; show("home"); };
  $("later-join").onclick = async () => { $("later-modal").hidden = true; await openLobby(); };
  $("btn-join").onclick = joinByInput;
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinByInput(); });
  $("btn-enter").onclick = enterRoom;
  $("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") enterRoom(); });
  $("name-input").addEventListener("input", syncLobbyPreview);
  $("lobby-mic").onclick = toggleMic;
  $("lobby-cam").onclick = toggleCam;
  $("btn-mic").onclick = toggleMic;
  $("btn-cam").onclick = toggleCam;
  $("btn-share").onclick = toggleShare;
  $("btn-chat").onclick = () => toggleChat();
  $("chat-close").onclick = () => toggleChat(false);
  $("chat-send").onclick = sendChat;
  $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  $("btn-invite").onclick = copyInvite;
  $("room-code").onclick = copyInvite;
  $("btn-leave").onclick = leaveMeeting;
  $("btn-wait-leave").onclick = leaveMeeting;
  $("btn-waiting").onclick = () => { const pop = $("waiting-pop"); pop.hidden = !pop.hidden; };
  $("wait-banner-admit").onclick = admitAll;
  $("wait-banner-view").onclick = () => { $("waiting-pop").hidden = false; };
  $("btn-record").onclick = toggleRecording;
  $("btn-nettest").onclick = runNetTest;
  $("btn-end").onclick = endForAll;
  $("btn-rejoin").onclick = () => { location.reload(); };
  $("btn-home").onclick = () => { location.href = location.pathname + (LOCAL_MODE ? "?local=1" : ""); };
  if (!("getDisplayMedia" in (navigator.mediaDevices || {}))) $("btn-share").style.display = "none";

  // zoom-quality pass · View dropdown (layout + visibility options)
  $("btn-view").onclick = () => toggleViewMenu();
  $("view-menu").addEventListener("click", (e) => {
    const item = e.target.closest(".vm-item");
    if (!item) return;
    if (item.dataset.view) {
      state.view = item.dataset.view;
      state.pinnedKey = null;        // an explicit layout choice clears a manual pin
      renderGrid();
      toggleViewMenu(false);
    } else if (item.dataset.toggle) {
      state[item.dataset.toggle] = !state[item.dataset.toggle];
      if (item.dataset.toggle === "hideTimers")
        document.body.classList.toggle("hide-timers", state.hideTimers);
      else renderGrid();
      syncViewMenu();                // toggles stay open so several can flip at once
    } else if (item.dataset.action === "fullscreen") {
      toggleFullscreen();
      toggleViewMenu(false);
    }
  });
  document.addEventListener("fullscreenchange", syncViewMenu);
  // Notes → pop open the in-meeting notes window (take notes without leaving)
  $("btn-notes").onclick = () => toggleNotes();
  $("notes-close").onclick = () => toggleNotes(false);
  $("notes-text").oninput = saveNotesSoon;
  $("notes-open-nb").onclick = notesToNotebook;
  wireNotesDrag();
  $("btn-settings").onclick = () => toggleSettingsPop();
  $("btn-react").onclick = () => toggleReactPop();
  $("btn-hand").onclick = toggleHand;
  const emojiWrap = $("react-emojis");
  for (const emoji of REACTION_EMOJI) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = emoji;
    b.onclick = () => sendReaction(emoji);
    emojiWrap.appendChild(b);
  }
  $("sel-mic").onchange = (e) => switchDevice("mic", e.target.value);
  $("sel-cam").onchange = (e) => switchDevice("cam", e.target.value);
  $("sel-spk").onchange = (e) => switchDevice("spk", e.target.value);
  $("chk-blur").onchange = (e) => toggleBlur(e.target.checked);
  $("chk-sounds").onchange = (e) => { setSoundsOn(e.target.checked); if (e.target.checked) sound("join"); };
  document.addEventListener("click", (e) => {
    // Popovers dismiss on outside click.
    if (!e.target.closest("#settings-pop") && !e.target.closest("#btn-settings")) $("settings-pop").hidden = true;
    if (!e.target.closest("#react-pop") && !e.target.closest("#btn-react")) $("react-pop").hidden = true;
    if (!e.target.closest("#view-menu") && !e.target.closest("#btn-view")) toggleViewMenu(false);
    if (!e.target.closest("#new-menu") && !e.target.closest("#btn-new")) toggleNewMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (document.body.dataset.screen !== "room") return;
    if (e.target.closest("input,textarea,select,[contenteditable]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "m") { toggleMic(); }
    else if (k === "v") { toggleCam(); }
    else if (k === "c") { toggleChat(); }
    else if (k === "h") { toggleHand(); }
    else if (k === "n" && state.isHost) { toggleNotes(); }
    else if (k === "escape") { toggleReactPop(false); $("settings-pop").hidden = true; toggleViewMenu(false); }
  });
  // Network changed (wifi → hotspot, VPN toggled): restart ICE on every
  // link instead of waiting for the failure timeout.
  window.addEventListener("online", () => {
    for (const p of peers.values()) { try { p.pc.restartIce(); } catch { /* closed */ } }
  });
}

async function boot() {
  wire();
  state.sinkId = devicePrefs().spk || "";
  if (CALL && !EMBED) {
    document.body.classList.add("call");
    wirePipDrag();
    // Crossing the phone breakpoint (resize / rotate) re-evaluates the
    // FaceTime layout and un-fades the chrome for the traditional view.
    try {
      mqCallPhone.addEventListener("change", () => {
        document.body.classList.remove("chrome-hidden");
        renderGrid();
      });
    } catch { /* older engines: layout settles on next render */ }
  }
  if (EMBED) {
    document.body.classList.add("embed");
    // The header is hidden in embed mode — its controls (View menu,
    // waiting-room queue) move into the control bar so hosts can still
    // pick a layout / admit applicants from the embedded interview room.
    const bar = document.querySelector(".room-ctrls");
    bar.insertBefore($("view-wrap"), $("btn-end"));
    bar.insertBefore($("btn-waiting"), $("btn-end"));
  } else {
    // Auto-hide the header + control bar after a few idle seconds on desktop
    // meetings (phone-call mode keeps its own header-only fade). Guests and
    // hosts both get it; embedded rooms opt out (the dashboard owns chrome).
    wireCallChrome();
  }
  if (LOCAL_MODE) {
    $("new-wrap").style.display = "";
    $("home-signin").style.display = "none";
  }
  const code = normalizeMeetCode(location.href);
  hydrateAuth(); // deliberately not awaited — guests shouldn't wait on it
  if (code) await resolveCode(code);
  else show("home");
}

boot();
