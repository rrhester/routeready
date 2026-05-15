// dashboard/voice.js — RouteReady dashboard softphone (Twilio Voice SDK).
//
// Loads the Twilio Voice SDK from CDN on demand, fetches a short-lived
// access token from the `voice-token` edge function, registers the
// device, and exposes a small `window.RR.voice` API for the rest of
// the dashboard to call into:
//
//   RR.voice.ready()              → Promise<boolean>   (does the operator have voice?)
//   RR.voice.dial(phone, label?)  → starts an outbound call to a driver
//   RR.voice.hangup()             → ends the active call
//   RR.voice.mute(boolean)        → mute/unmute
//
// The dock UI in dashboard/index.html (#rr-voice-dock) hosts the
// status indicator + hangup/mute/keypad controls.  Module wires up
// its event handlers when the SDK is ready.

const SDK_URL = "https://sdk.twilio.com/js/voice/releases/2.11.4/twilio.min.js";

const STATE = {
  loaded: false,        // SDK script loaded
  device: null,         // Twilio.Device instance
  call: null,           // active Call (Twilio terminology), or null
  identity: null,
  tokenExpiresAt: 0,    // ms epoch
  registering: null,    // Promise during initial register
  available: null,      // null=unknown, true=voice configured, false=not
};

function $(id) { return document.getElementById(id); }

// ── Load the SDK once ────────────────────────────────────────────
function loadSdk() {
  if (STATE.loaded) return Promise.resolve(true);
  if (window.Twilio?.Device) { STATE.loaded = true; return Promise.resolve(true); }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => { STATE.loaded = true; resolve(true); };
    s.onerror = () => reject(new Error("voice_sdk_load_failed"));
    document.head.appendChild(s);
  });
}

// ── Token fetch ──────────────────────────────────────────────────
async function fetchToken() {
  const RR = window.RR || {};
  const cfg = window.RR_CONFIG;
  const sb = RR.sb;
  if (!cfg) throw new Error("config_missing");
  if (!sb?.auth) throw new Error("supabase_not_available");
  const { data: sess } = await sb.auth.getSession();
  const accessToken = sess?.session?.access_token;
  if (!accessToken) throw new Error("not_authenticated");
  const url = String(cfg.SUPABASE_URL).replace(/\/$/, "") + "/functions/v1/voice-token";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${accessToken}`,
      "apikey": cfg.SUPABASE_ANON_KEY,
    },
    body: "{}",
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    if (resp.status === 503) throw new Error("twilio_not_configured");
    throw new Error(`voice_token_${resp.status}:${txt.slice(0, 80)}`);
  }
  return resp.json();
}

// ── Register (or refresh) the device ────────────────────────────
async function register() {
  if (STATE.registering) return STATE.registering;
  STATE.registering = (async () => {
    await loadSdk();
    const { token, identity, expires_at } = await fetchToken();
    STATE.identity = identity;
    STATE.tokenExpiresAt = new Date(expires_at).getTime();
    if (!STATE.device) {
      STATE.device = new window.Twilio.Device(token, {
        codecPreferences: ["opus", "pcmu"],
        logLevel: "warn",
      });
      bindDeviceEvents(STATE.device);
      await STATE.device.register();
    } else {
      STATE.device.updateToken(token);
    }
    STATE.available = true;
    setDockStatus("ready");
  })().catch((err) => {
    STATE.available = false;
    if (String(err.message).includes("twilio_not_configured")) {
      setDockStatus("not-configured");
    } else {
      setDockStatus("error", err.message);
    }
    throw err;
  }).finally(() => { STATE.registering = null; });
  return STATE.registering;
}

function bindDeviceEvents(device) {
  device.on("error", (e) => {
    setDockStatus("error", e?.message || "error");
  });
  device.on("incoming", (call) => {
    // Inbound from driver — for v1 we just present a prompt; future
    // pass: full inbound queue UI with answer/decline buttons.
    if (!confirm(`Incoming call from ${call.parameters?.From || "unknown"} — answer?`)) {
      call.reject();
      return;
    }
    STATE.call = call;
    bindCallEvents(call);
    call.accept();
  });
  device.on("tokenWillExpire", () => { register().catch(() => {}); });
}

function bindCallEvents(call) {
  call.on("accept", () => setDockStatus("active", "Connected"));
  call.on("ringing", () => setDockStatus("ringing", "Ringing…"));
  call.on("disconnect", () => {
    STATE.call = null;
    setDockStatus("ready");
    closeDockPanel();
  });
  call.on("cancel", () => {
    STATE.call = null;
    setDockStatus("ready");
    closeDockPanel();
  });
  call.on("error", (e) => {
    setDockStatus("error", e?.message || "error");
    STATE.call = null;
  });
}

// ── Dock UI ─────────────────────────────────────────────────────
function setDockStatus(state, msg) {
  const dock = $("rr-voice-dock");
  if (!dock) return;
  dock.dataset.state = state;
  const label = $("rr-voice-dock-status");
  if (label) {
    label.textContent = ({
      "loading": "Connecting…",
      "ready": "Ready",
      "ringing": msg || "Ringing…",
      "active": msg || "On call",
      "not-configured": "Voice not set up",
      "error": msg ? `Error · ${msg}` : "Error",
    })[state] || state;
  }
  const labelTarget = $("rr-voice-dock-target");
  if (labelTarget && (state === "ready" || state === "not-configured" || state === "error")) {
    labelTarget.textContent = "";
  }
}

function openDockPanel(target) {
  const dock = $("rr-voice-dock");
  if (!dock) return;
  dock.classList.add("open");
  const labelTarget = $("rr-voice-dock-target");
  if (labelTarget) labelTarget.textContent = target || "";
}

function closeDockPanel() {
  const dock = $("rr-voice-dock");
  if (!dock) return;
  dock.classList.remove("open");
}

// ── Public API ──────────────────────────────────────────────────
async function dial(phone, label) {
  if (!phone) throw new Error("no_number");
  const clean = String(phone).replace(/[^0-9+]/g, "");
  if (!/^\+?\d{10,15}$/.test(clean)) {
    throw new Error("invalid_phone_format");
  }
  const e164 = clean.startsWith("+") ? clean :
               clean.length === 10 ? `+1${clean}` :
               `+${clean}`;

  setDockStatus("loading");
  openDockPanel(label || e164);

  await register();
  if (!STATE.device) throw new Error("device_not_ready");

  if (STATE.call) {
    // Hang up an existing call before starting a new one.
    try { STATE.call.disconnect(); } catch (_) {}
    STATE.call = null;
  }

  const call = await STATE.device.connect({ params: { To: e164 } });
  STATE.call = call;
  bindCallEvents(call);
  setDockStatus("ringing", `Dialing ${label || e164}…`);
}

function hangup() {
  if (STATE.call) {
    try { STATE.call.disconnect(); } catch (_) {}
    STATE.call = null;
  }
  closeDockPanel();
  setDockStatus("ready");
}

function mute(on) {
  if (!STATE.call) return;
  try { STATE.call.mute(!!on); } catch (_) {}
}

async function ready() {
  if (STATE.available !== null) return STATE.available;
  try {
    await register();
    return STATE.available === true;
  } catch (_e) {
    return false;
  }
}

// ── Auto-init when the DOM is ready ─────────────────────────────
function init() {
  // Wire dock buttons
  const hangBtn = $("rr-voice-dock-hangup");
  const muteBtn = $("rr-voice-dock-mute");
  if (hangBtn) hangBtn.addEventListener("click", hangup);
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      const isMuted = muteBtn.dataset.muted === "1";
      mute(!isMuted);
      muteBtn.dataset.muted = isMuted ? "0" : "1";
      muteBtn.textContent = isMuted ? "Mute" : "Unmute";
    });
  }

  // Click-to-call delegation across the whole dashboard — any element
  // with [data-rr-voice-call="<e164>"] (or [data-rr-voice-phone="<raw>"])
  // becomes a dial trigger, with optional [data-rr-voice-label].
  document.addEventListener("click", (ev) => {
    const trigger = ev.target.closest("[data-rr-voice-call], [data-rr-voice-phone]");
    if (!trigger) return;
    ev.preventDefault();
    const phone = trigger.getAttribute("data-rr-voice-call") ||
                  trigger.getAttribute("data-rr-voice-phone");
    const label = trigger.getAttribute("data-rr-voice-label") || "";
    dial(phone, label).catch((err) => {
      const msg = String(err.message || err);
      if (msg.includes("twilio_not_configured")) {
        alert("Voice calling isn't set up yet. Ask an admin to configure Twilio.");
      } else if (msg.includes("invalid_phone")) {
        alert("That number isn't in a format we can dial.");
      } else {
        alert(`Couldn't start the call: ${msg}`);
      }
    });
  });
}

window.RR = window.RR || {};
window.RR.voice = { dial, hangup, mute, ready };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
