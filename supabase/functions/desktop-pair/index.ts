// desktop-pair · "Connect from browser" pairing for the RouteReady desktop app.
//
// Two actions:
//   POST { action: "mint" }    + Authorization: Bearer <dashboard user JWT>
//        → mints a short-lived, single-use code keyed to that user.
//        Called by the logged-in dashboard when the operator clicks
//        "Connect desktop app".
//
//   POST { action: "redeem", code: "<code>" }   (no user JWT)
//        → validates the code (exists, unused, unexpired), marks it used,
//        and returns a fresh Supabase session { access_token, refresh_token }
//        for that user. Called by the installed desktop app after it
//        receives routeready://connect?code=… . The app hands those tokens
//        to its dashboard window (sb.auth.setSession) so the window is
//        signed in as the same DSP.
//
// Deploy with --no-verify-jwt (redeem must be callable without a user JWT).
// mint is gated in-function: it requires a valid user access token.
//
// Env (auto-injected): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

// A connect key is good for 24h, single use. The desktop app now redeems it
// from an in-app field (paste once), so the old 2-minute window — sized for an
// automatic deep-link hand-off — just caused races where the key expired before
// the operator finished. 24h removes that without making the key long-lived
// standing access (still single-use; the redeemed session is what persists).
const CODE_TTL_SECONDS = 24 * 60 * 60;

function newCode(): string {
  // ~244 bits of entropy; opaque, single-use, short-lived.
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload.action !== "string") return badRequest("invalid_request");

  const supa = serviceClient();

  // ── mint: the logged-in dashboard asks for a pairing code ──────────
  if (payload.action === "mint") {
    const authz = req.headers.get("authorization") || "";
    const jwt = authz.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return badRequest("missing_authorization", 401);

    // Validate the caller's access token and resolve the user server-side.
    const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
    if (userErr || !userData?.user?.email) return badRequest("invalid_session", 401);
    const user = userData.user;

    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
    const { error: insErr } = await supa.from("desktop_pairings").insert({
      code, user_id: user.id, email: user.email, expires_at: expiresAt,
    });
    if (insErr) return json({ error: insErr.message }, 500);

    return json({ ok: true, code, expires_in: CODE_TTL_SECONDS });
  }

  // ── redeem: the desktop app trades a code for a session ────────────
  if (payload.action === "redeem") {
    const code = typeof payload.code === "string" ? payload.code.trim() : "";
    if (!code) return badRequest("missing_code");

    // Atomically claim the code: mark used only if currently unused +
    // unexpired, so a replay or race can't redeem it twice.
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supa
      .from("desktop_pairings")
      .update({ used_at: nowIso })
      .eq("code", code)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .select("email")
      .maybeSingle();
    if (claimErr) return json({ error: claimErr.message }, 500);
    if (!claimed?.email) return badRequest("invalid_or_expired_code", 401);

    const email = claimed.email;

    // Mint a session for that user without sending an email: generate a
    // magic-link token (admin), then verify it server-side to get tokens.
    const { data: linkData, error: linkErr } = await supa.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const tokenHash = (linkData as any)?.properties?.hashed_token;
    if (linkErr || !tokenHash) return json({ error: linkErr?.message || "link_failed" }, 500);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: verified, error: verErr } = await anon.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });
    const session = verified?.session;
    if (verErr || !session?.access_token || !session?.refresh_token) {
      return json({ error: verErr?.message || "verify_failed" }, 500);
    }

    return json({
      ok: true,
      email,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at ?? null,
    });
  }

  return badRequest("unknown_action");
});
