// livekit-token · Mints a short-lived LiveKit access token so a RouteReady
// user (staff or driver) can join a live-audio room — 1:1 calls, group voice,
// and push-to-talk channels all use this as the single join credential.
//
// The token is a JWT signed HS256 with the LiveKit API secret (Web Crypto —
// no external deps), carrying a video grant scoped to ONE room. Identity is
// derived server-side from the caller's real RouteReady identity, so a client
// can never impersonate anyone, and rooms are namespaced by dsp_id so a token
// for one DSP can't join another's room.
//
// Auth (deployed --no-verify-jwt; gated in code):
//   • Driver → passes their opaque session token; validated via driver_me.
//   • Staff  → passes their Supabase auth JWT (Authorization: Bearer …);
//              validated via auth.getUser + app_users (must be active staff).
//
// Room naming (constructed by the client, enforced here):
//   "<dsp_id>|ptt|<channel_id>"      — a walkie-talkie channel
//   "<dsp_id>|group|<channel_id>"    — a group voice room
//   "<dsp_id>|direct|<callId>"       — a 1:1 call
// The function only checks the "<dsp_id>|" prefix matches the caller's DSP.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL (wss://…)
// Returns { ok:false, reason:"not_configured" } (never an error) when unset,
// so the client degrades gracefully until LiveKit is wired up.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signHS256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`)));
  return `${header}.${body}.${b64url(sig)}`;
}

const TTL = 60 * 60; // 1 hour — comfortably longer than any single join.

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const KEY    = Deno.env.get("LIVEKIT_API_KEY");
  const SECRET = Deno.env.get("LIVEKIT_API_SECRET");
  const URL    = Deno.env.get("LIVEKIT_URL");
  if (!KEY || !SECRET || !URL) {
    return jsonResponse({ ok: false, reason: "not_configured" });
  }

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse((await req.text()) || "{}"); } catch { /* ignore */ }
  const room  = String(parsed.room || "").trim();
  const dToken = parsed.token ? String(parsed.token) : "";
  if (!room) return badRequest("room_required");

  const supa = serviceClient();

  // ── Resolve the caller's real identity + DSP, server-side ──
  let identity = "";
  let displayName = "";
  let callerDsp = "";
  let canPublish = true;

  if (dToken) {
    // Driver: validate the opaque session token.
    const { data: me, error } = await supa.rpc("driver_me", { p_token: dToken });
    if (error || !me?.id) return badRequest("unauthorized", 401);
    identity    = "driver:" + me.id;
    displayName = String(me.name || me.full_name || "Driver");
    callerDsp   = String(me.dsp_id || "");
  } else {
    // Staff: validate the Supabase auth JWT.
    const auth = req.headers.get("authorization") || "";
    const jwt  = auth.replace(/^Bearer\s+/i, "");
    if (!jwt) return badRequest("unauthorized", 401);
    const { data: u, error: uErr } = await supa.auth.getUser(jwt);
    if (uErr || !u?.user?.id) return badRequest("unauthorized", 401);
    const { data: staff } = await supa
      .from("app_users")
      .select("dsp_id, role, active, full_name")
      .eq("id", u.user.id)
      .single();
    if (!staff || staff.active === false) return badRequest("forbidden", 403);
    if (!["dispatcher", "ops", "owner"].includes(String(staff.role))) {
      return badRequest("forbidden", 403);
    }
    identity    = "dispatch:" + u.user.id;
    displayName = String(staff.full_name || parsed.name || "Dispatch");
    callerDsp   = String(staff.dsp_id || "");
  }

  // ── Enforce DSP room isolation ──
  if (!callerDsp || !room.startsWith(callerDsp + "|")) {
    return badRequest("room_forbidden", 403);
  }

  // ── Mint the LiveKit access token ──
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: KEY,
    sub: identity,
    name: displayName,
    nbf: now,
    exp: now + TTL,
    video: {
      room,
      roomJoin: true,
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    },
  };
  const token = await signHS256(claims, SECRET);

  return jsonResponse({ ok: true, url: URL, token, identity, room });
});
