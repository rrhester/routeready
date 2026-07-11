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
} from "/dashboard/meet-core.js?v=dev";

const SUPABASE_ESM_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

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

const state = {
  code: null,          // canonical "xxx-xxxx-xxx"
  meeting: null,       // meet_lookup/meet_create payload
  session: null,       // supabase auth session (null for guests)
  isHost: false,
  name: "",
  peerKey: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
  joinedAt: 0,
  mic: true,
  cam: true,
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
  pinnedKey: null,
  hand: false,
  activeSpeaker: null,
  lastSpeakerSwitch: 0,
  sinkId: "",          // chosen output device ("" = default)
  statsTimer: null,
  levelTimer: null,
};

const peers = new Map(); // key → {pc, polite, makingOffer, ignoreOffer, isSettingRemoteAnswerPending, pending:[], stream}
const tiles = new Map(); // key → tile element (reused across renders; recreating <video> kills playback)

// ─── supabase (lazy — never imported in local mode) ───────────────────────

let _sbPromise = null;
function getSb() {
  if (!_sbPromise) {
    _sbPromise = import(SUPABASE_ESM_URL).then(({ createClient }) =>
      // Same project + default storage key as dashboard/live.js, so an
      // operator already signed in to the dashboard is signed in here.
      createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      }));
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
    this.channel = sb.channel("rr-meet:" + code.replace(/-/g, ""), {
      config: { broadcast: { self: false }, presence: { key } },
    });
  }
  join(meta, handlers) {
    const ch = this.channel;
    this.lastMeta = meta;
    ch.on("broadcast", { event: "signal" }, ({ payload }) => {
      if (payload && payload.to === this.key) handlers.onSignal(payload.from, payload.data);
    });
    ch.on("broadcast", { event: "chat" }, ({ payload }) => handlers.onEvent("chat", payload));
    ch.on("broadcast", { event: "react" }, ({ payload }) => handlers.onEvent("react", payload));
    ch.on("broadcast", { event: "ended" }, ({ payload }) => handlers.onEvent("ended", payload));
    ch.on("presence", { event: "sync" }, () => handlers.onPresence(ch.presenceState()));
    return new Promise((resolve, reject) => {
      ch.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          // Fires again after every websocket drop/rejoin — re-announce
          // our presence so the roster heals without a manual refresh.
          await ch.track(this.lastMeta);
          if (!this.joined) { this.joined = true; resolve(); }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (!this.joined) reject(new Error("realtime_" + status.toLowerCase()));
        }
      });
    });
  }
  track(meta) { this.lastMeta = meta; return this.channel.track(meta); }
  send(event, payload) { return this.channel.send({ type: "broadcast", event, payload }); }
  signal(to, data) { return this.send("signal", { from: this.key, to, data }); }
  async leave() { try { await this.channel.untrack(); } catch { /* leaving anyway */ } try { await this.sb.removeChannel(this.channel); } catch { /* leaving anyway */ } }
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

const GUM_VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" };
const GUM_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

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
  const tries = [
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
      if (!state.sharing) replaceOutgoingVideo(track);
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

// The video track peers should currently receive.
function currentVideoTrack() {
  return state.screenTrack || state.camTrack;
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

  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
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

// Apply the mesh send policy (meet-core sendPolicy) to one peer's video
// sender: cap bitrate + downscale as the roster grows so upload stays
// inside a normal uplink, keep full quality for screen shares, prefer
// framerate for camera motion and resolution for shared text.
function tunePeerSenders(p) {
  const policy = sendPolicy(Math.max(state.roster.length, peers.size + 1), state.sharing);
  for (const sender of p.pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = policy.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = policy.scaleResolutionDownBy;
      params.degradationPreference = policy.degradationPreference;
      sender.setParameters(params).catch(() => { /* pre-negotiation — retried on connect */ });
    } catch { /* pre-negotiation — retried on connect */ }
  }
}

function tuneAllSenders() {
  for (const p of peers.values()) tunePeerSenders(p);
}

async function handleSignal(from, data) {
  if (state.left || !data) return;
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
        await pc.setLocalDescription();
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
  const prevByKey = new Map(state.roster.map((r) => [r.key, r]));
  state.roster = sortRoster(entries);
  const nowKeys = new Set(entries.map((r) => r.key));

  for (const ent of state.roster) {
    // Raised-hand rising edge → toast, for remote peers only.
    const prev = prevByKey.get(ent.key);
    if (ent.key !== state.peerKey && ent.hand && prev && !prev.hand) {
      toast(`✋ ${ent.name || "Someone"} raised their hand`);
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
  tuneAllSenders(); // roster size changed → re-apply the mesh send policy
  renderGrid();
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

// ─── join/leave chime ─────────────────────────────────────────────────────
// Two soft sine blips, synthesized — no audio asset to load or cache.

function chime(up = true) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  for (const [i, freq] of (up ? [523, 784] : [784, 523]).entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.12);
    osc.stop(t0 + i * 0.12 + 0.3);
  }
}

// ─── presence meta ────────────────────────────────────────────────────────

function myMeta() {
  return {
    name: state.name,
    mic: state.mic,
    cam: state.cam,
    screen: state.sharing,
    hand: state.hand,
    host: state.isHost,
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
  grid.classList.toggle("has-stage", !!stageKey);

  for (const [key, tile] of tiles) {
    if (!nowKeys.has(key)) { tile.remove(); tiles.delete(key); }
  }

  const { cols, rows } = gridDims(stageKey ? Math.max(1, roster.length - 1) : roster.length);
  grid.style.setProperty("--cols", cols);
  grid.style.setProperty("--rows", rows);

  for (const entry of roster) {
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
  const stagedEntry = roster.find((r) => r.key === stageKey);
  const ordered = stagedEntry
    ? [stagedEntry, ...roster.filter((r) => r.key !== stageKey)]
    : roster;
  for (const entry of ordered) {
    const tile = tiles.get(entry.key);
    if (tile) grid.appendChild(tile);
  }

  $("people-count").textContent = String(roster.length);
  const viewBtn = $("btn-view");
  if (viewBtn) viewBtn.classList.toggle("on", state.view === "speaker");
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
  replaceOutgoingVideo(state.camTrack);
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
}

async function copyInvite() {
  const url = LOCAL_MODE
    ? location.origin + "/dashboard/meet.html?local=1&m=" + state.code
    : buildMeetUrl(cfg.PUBLIC_BASE_URL || location.origin, state.code);
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
  if (!self && !state.chatOpen) { state.unread++; syncControls(); }
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

async function enterRoom() {
  state.name = ($("name-input").value || "").trim() || "Guest";
  try { localStorage.setItem("rr_meet_name", state.name); } catch { /* private mode */ }
  state.joinedAt = Date.now();
  state.left = false;

  let transport;
  if (LOCAL_MODE) {
    transport = new LocalTransport(state.code, state.peerKey);
  } else {
    const sb = await getSb();
    transport = new SupabaseTransport(sb, state.code, state.peerKey);
  }
  state.transport = transport;

  show("room");
  $("room-title").textContent = state.meeting?.title || "RouteReady meeting";
  $("room-code").textContent = state.code;

  try {
    await transport.join(myMeta(), {
      onSignal: handleSignal,
      onPresence: handlePresence,
      onEvent: (type, payload) => {
        if (type === "chat" && payload && payload.from !== state.peerKey) appendChat(payload);
        if (type === "react" && payload && payload.from !== state.peerKey) showReaction(payload.from, payload.emoji);
        if (type === "ended") handleEndedEvent();
      },
    });
  } catch (err) {
    console.error("transport join failed", err);
    show("lobby");
    toast("Couldn't connect to the meeting service — try again.");
    return;
  }

  state.timerId = setInterval(() => {
    $("room-timer").textContent = fmtDuration(Date.now() - state.joinedAt);
  }, 1000);
  $("btn-end").style.display = state.isHost ? "" : "none";
  getAudioCtx();      // resume within the Join-click gesture
  monitorLocalMic();
  startLevelLoop();
  startStatsLoop();
  syncControls();
  renderGrid();
}

function teardown() {
  state.left = true;
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
}

function endLocally(message) {
  teardown();
  $("done-msg").textContent = message;
  $("btn-rejoin").style.display = message.includes("ended") ? "none" : "";
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

async function openLobby() {
  show("lobby");
  $("lobby-title").textContent = state.meeting?.title || "RouteReady meeting";
  $("lobby-code").textContent = state.code;
  let stored = "";
  try { stored = localStorage.getItem("rr_meet_name") || ""; } catch { /* private mode */ }
  if (!$("name-input").value) $("name-input").value = stored || state.prefillName || "";

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

async function newMeeting() {
  const btn = $("btn-new");
  btn.disabled = true;
  try {
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
    await openLobby();
  } catch (err) {
    console.error("meet_create failed", err);
    toast(err?.message === "forbidden" ? "Your account can't start meetings." : "Couldn't start a meeting — try again.");
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
    await openLobby();
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
      $("btn-new").style.display = "";
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
  $("btn-new").onclick = newMeeting;
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
  $("btn-end").onclick = endForAll;
  $("btn-rejoin").onclick = () => { location.reload(); };
  $("btn-home").onclick = () => { location.href = location.pathname + (LOCAL_MODE ? "?local=1" : ""); };
  if (!("getDisplayMedia" in (navigator.mediaDevices || {}))) $("btn-share").style.display = "none";

  // zoom-quality pass
  $("btn-view").onclick = () => {
    state.view = state.view === "gallery" ? "speaker" : "gallery";
    renderGrid();
  };
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
  document.addEventListener("click", (e) => {
    // Popovers dismiss on outside click.
    if (!e.target.closest("#settings-pop") && !e.target.closest("#btn-settings")) $("settings-pop").hidden = true;
    if (!e.target.closest("#react-pop") && !e.target.closest("#btn-react")) $("react-pop").hidden = true;
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
    else if (k === "escape") { toggleReactPop(false); $("settings-pop").hidden = true; }
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
  if (LOCAL_MODE) {
    $("btn-new").style.display = "";
    $("home-signin").style.display = "none";
  }
  const code = normalizeMeetCode(location.href);
  hydrateAuth(); // deliberately not awaited — guests shouldn't wait on it
  if (code) await resolveCode(code);
  else show("home");
}

boot();
