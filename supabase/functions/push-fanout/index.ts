// push-fanout · Native push delivery (APNs + FCM) for the communications
// system. Complements send-driver-push (Web Push / VAPID): that function
// notifies browsers + installed PWAs; THIS one notifies the Capacitor native
// apps by fanning out to the device tokens registered in device_push_tokens
// (migration 0473) via driver_device_push_register / device_push_register.
//
// Fired alongside send-driver-push from the same driver_messages trigger
// (see migration 0473_push_fanout_trigger). It is purely additive: if no
// native tokens exist (pure-PWA install base) or the APNs/FCM secrets aren't
// configured, it is a graceful no-op — Web Push still delivers.
//
// POST body (service-role gated):
//   { driver_id: uuid, message_id?: uuid }         → notify one driver's devices
//   { user_id: uuid,   title, body, data? }         → notify one staff user
//   { driver_id|user_id, call: {...} }              → VoIP/high-priority (Phase 3)
//
// Secrets (Supabase → Edge Functions → Secrets) — all OPTIONAL; a missing
// channel is skipped, never fatal:
//   APNs   · APNS_KEY_P8 (the .p8 contents), APNS_KEY_ID, APNS_TEAM_ID,
//            APNS_BUNDLE_ID, APNS_ENV ('production' | 'sandbox', default prod)
//   FCM    · FCM_SERVICE_ACCOUNT (the service-account JSON string)
import { serviceClient, jsonResponse, badRequest, requireServiceKey } from "../_shared/supabase.ts";
import { fetchWithTimeout } from "../_shared/http.ts";

// ── crypto helpers (Web Crypto, no external deps) ────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function pemToBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, "")
                  .replace(/-----END [^-]+-----/g, "")
                  .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// APNs: ES256 (ECDSA P-256) JWT. Cached ~50 min (Apple wants <1h, >20m).
let _apnsJwt: { token: string; at: number } | null = null;
async function apnsJwt(): Promise<string | null> {
  const p8   = Deno.env.get("APNS_KEY_P8");
  const kid  = Deno.env.get("APNS_KEY_ID");
  const team = Deno.env.get("APNS_TEAM_ID");
  if (!p8 || !kid || !team) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_apnsJwt && now - _apnsJwt.at < 3000) return _apnsJwt.token;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8", pemToBytes(p8),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    const header = b64urlStr(JSON.stringify({ alg: "ES256", kid }));
    const claims = b64urlStr(JSON.stringify({ iss: team, iat: now }));
    const sig = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key,
      new TextEncoder().encode(`${header}.${claims}`),
    ));
    const token = `${header}.${claims}.${b64url(sig)}`;
    _apnsJwt = { token, at: now };
    return token;
  } catch (e) {
    console.warn("apns jwt sign failed:", (e as Error).message);
    return null;
  }
}

// FCM: RS256 service-account JWT → OAuth2 access token. Cached ~55 min.
let _fcmTok: { token: string; exp: number } | null = null;
let _fcmProject: string | null = null;
async function fcmAccessToken(): Promise<string | null> {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_fcmTok && _fcmTok.exp - now > 120) return _fcmTok.token;
  try {
    const sa = JSON.parse(raw);
    _fcmProject = sa.project_id || _fcmProject;
    const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64urlStr(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now, exp: now + 3600,
    }));
    const key = await crypto.subtle.importKey(
      "pkcs8", pemToBytes(sa.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", key,
      new TextEncoder().encode(`${header}.${claims}`),
    ));
    const assertion = `${header}.${claims}.${b64url(sig)}`;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    });
    if (!res.ok) { console.warn("fcm token exchange failed:", res.status); return null; }
    const j = await res.json();
    _fcmTok = { token: j.access_token, exp: now + (j.expires_in || 3600) };
    return _fcmTok.token;
  } catch (e) {
    console.warn("fcm token failed:", (e as Error).message);
    return null;
  }
}

// ── senders ──────────────────────────────────────────────────────────────
type Note = { title: string; body: string; data: Record<string, string>; badge?: number };

async function sendApns(token: string, note: Note, jwt: string): Promise<"ok" | "gone" | "fail"> {
  const host = (Deno.env.get("APNS_ENV") === "sandbox")
    ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const topic = Deno.env.get("APNS_BUNDLE_ID") || "com.gorouteready.driver";
  const payload = {
    aps: {
      alert: { title: note.title, body: note.body },
      sound: "default",
      badge: note.badge,
      "mutable-content": 1,
    },
    ...note.data,
  };
  try {
    const res = await fetchWithTimeout(`https://${host}/3/device/${token}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 200) return "ok";
    const bodyTxt = await res.text().catch(() => "");
    if (res.status === 410 || /BadDeviceToken|Unregistered/.test(bodyTxt)) return "gone";
    console.warn(`apns ${res.status}: ${bodyTxt.slice(0, 200)}`);
    return "fail";
  } catch (e) {
    console.warn("apns send error:", (e as Error).message);
    return "fail";
  }
}

async function sendFcm(token: string, note: Note, accessToken: string): Promise<"ok" | "gone" | "fail"> {
  const project = _fcmProject;
  if (!project) return "fail";
  const message = {
    message: {
      token,
      notification: { title: note.title, body: note.body },
      data: note.data,
      android: { priority: "HIGH", notification: { sound: "default", default_vibrate_timings: true } },
    },
  };
  try {
    const res = await fetchWithTimeout(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
      method: "POST",
      headers: { "authorization": `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (res.ok) return "ok";
    const bodyTxt = await res.text().catch(() => "");
    if (res.status === 404 || /UNREGISTERED|InvalidRegistration|NotRegistered/.test(bodyTxt)) return "gone";
    console.warn(`fcm ${res.status}: ${bodyTxt.slice(0, 200)}`);
    return "fail";
  } catch (e) {
    console.warn("fcm send error:", (e as Error).message);
    return "fail";
  }
}

// ── notification copy ─────────────────────────────────────────────────────
// Mirrors send-driver-push so native + Web Push read identically, incl. the
// voice-note line requested in the spec.
function copyFromMessage(msg: { body?: string | null; attachment_mime?: string | null; link_url?: string | null } | null): Note {
  let body = "New message from dispatch";
  const mime = String(msg?.attachment_mime || "");
  if (msg?.body) {
    const t = String(msg.body);
    body = t.length > 80 ? t.slice(0, 80) + "…" : t;
  } else if (mime.startsWith("audio/")) body = "🎤 Sent you a voice message";
  else if (mime.startsWith("image/")) body = "📷 Sent you a photo";
  else if (mime) body = "📎 Sent you an attachment";
  const data: Record<string, string> = { type: "message", url: String(msg?.link_url || "/app/#/chat") };
  return { title: "Dispatch", body, data };
}

// ── handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  const gate = requireServiceKey(req);
  if (gate) return gate;

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse((await req.text()) || "{}"); } catch { /* ignore */ }

  const driverId = parsed.driver_id as string | undefined;
  const userId   = parsed.user_id   as string | undefined;
  const messageId = parsed.message_id as string | undefined;
  if (!driverId && !userId) return badRequest("driver_id_or_user_id_required");

  const supa = serviceClient();

  // Collect the target's native tokens.
  const q = supa.from("device_push_tokens").select("id, token, kind, failure_count")
    .in("kind", ["apns", "fcm"]);
  const { data: toks, error: tErr } = driverId
    ? await q.eq("driver_id", driverId)
    : await q.eq("user_id", userId as string);
  if (tErr) return badRequest(tErr.message, 500);
  if (!toks || toks.length === 0) return jsonResponse({ ok: true, sent: 0, reason: "no_native_tokens" });

  // Build the notification.
  let note: Note;
  if (parsed.title || parsed.body) {
    note = {
      title: String(parsed.title || "RouteReady"),
      body:  String(parsed.body  || ""),
      data:  (parsed.data as Record<string, string>) || { type: "message", url: "/app/#/chat" },
    };
  } else if (messageId) {
    const { data: msg } = await supa.from("driver_messages")
      .select("body, attachment_mime, link_url").eq("id", messageId).single();
    note = copyFromMessage(msg);
  } else {
    note = copyFromMessage(null);
  }

  // Lazily mint per-channel credentials only if that channel has tokens.
  const hasApns = toks.some((t) => t.kind === "apns");
  const hasFcm  = toks.some((t) => t.kind === "fcm");
  const jwt = hasApns ? await apnsJwt() : null;
  const fcmTok = hasFcm ? await fcmAccessToken() : null;

  let sent = 0, gone = 0, failed = 0, skipped = 0;
  const deadIds: string[] = [];

  const failures: { token_id: string; kind: string }[] = [];
  for (const t of toks) {
    let r: "ok" | "gone" | "fail";
    const attempt = () => t.kind === "apns" ? sendApns(t.token, note, jwt!) : sendFcm(t.token, note, fcmTok!);
    if (t.kind === "apns" && !jwt) { skipped++; continue; }
    if (t.kind === "fcm" && !fcmTok) { skipped++; continue; }
    r = await attempt();
    if (r === "fail") {
      // One retry with a short backoff absorbs transient provider blips —
      // previously a single failed attempt just dropped the notification.
      await new Promise((res) => setTimeout(res, 750));
      r = await attempt();
    }
    if (r === "ok") sent++;
    else if (r === "gone") { gone++; deadIds.push(t.id); }
    else { failed++; failures.push({ token_id: t.id, kind: t.kind }); }
  }

  // Persist terminal failures so an outage is visible and replayable
  // (project-review PR#65). Table lands in migration 0502; until then this
  // logs structured JSON instead of silently returning counts.
  if (failures.length) {
    const rows = failures.map((f) => ({
      driver_id: driverId ?? null,
      token_id: f.token_id,
      kind: f.kind,
      title: note.title,
      body: note.body,
      data: note.data,
    }));
    const { error: dlqErr } = await supa.from("push_delivery_failures").insert(rows);
    if (dlqErr) console.error("push_delivery_failures insert failed (migration 0502 pending?):", dlqErr.message, JSON.stringify(rows).slice(0, 500));
  }

  // Prune tokens the OS reported as dead so we stop paying to retry them.
  if (deadIds.length) {
    await supa.from("device_push_tokens").delete().in("id", deadIds);
  }

  return jsonResponse({ ok: true, sent, gone, failed, skipped });
});
