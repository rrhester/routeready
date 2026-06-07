// box-ingest · authenticated applicant intake for sync boxes.
//
// The desktop agent uploads crawled rows here using the box's PAIRING SESSION
// (the DSP's Supabase JWT) — no shared apply-secret and no DSP short code on
// the box. We:
//   1. Validate the caller's JWT (the box's DSP session).
//   2. Resolve the box's DSP server-side via an RLS-scoped select (so the box
//      can't spoof which DSP it writes to).
//   3. Call intake_applicant() for that DSP (same RPC as the public
//      webhook-apply intake), keyed/deduped by the RPC.
//
// This makes boxes fully zero-config for upload: pair, and data flows to the
// right DSP. Gateway verify_jwt is off (see config.toml); we validate the JWT
// in-function. Deploy with --no-verify-jwt.
//
// NOTE: unlike webhook-apply, this does NOT auto-send a screening SMS — crawled
// applicants land in the pipeline quietly; staff trigger screening as usual.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return badRequest("unauthorized", 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Validate the box's session.
  const { data: ures, error: uerr } = await userClient.auth.getUser(token);
  if (uerr || !ures?.user) return badRequest("unauthorized", 401);

  // 2. Resolve the box's DSP from its OWN app_users row — the box account's
  //    actual tenant (same source as private.current_dsp_id()). The previous
  //    `from("dsps").limit(1)` relied on RLS returning exactly one DSP, which is
  //    true for a normal DSP login but NOT for a platform-admin / multi-DSP
  //    account: it can see every DSP, so .limit(1) grabbed an arbitrary (wrong)
  //    tenant and applicants landed in someone else's pipeline. We look this up
  //    with the service client keyed by the already-validated user id, so the
  //    box still can't spoof which DSP it writes to.
  const supa = serviceClient();
  const { data: me, error: meErr } = await supa
    .from("app_users").select("dsp_id").eq("id", ures.user.id).eq("active", true).maybeSingle();
  if (meErr) return badRequest("dsp_lookup_failed: " + meErr.message, 400);
  const dspId = me?.dsp_id;
  if (!dspId) return badRequest("no_dsp_for_box", 403);
  const { data: dspRow, error: derr } = await supa
    .from("dsps").select("short_code").eq("id", dspId).maybeSingle();
  if (derr) return badRequest("dsp_lookup_failed: " + derr.message, 400);
  const shortCode = dspRow?.short_code;
  if (!shortCode) return badRequest("no_dsp_for_box", 403);

  const body = await req.json().catch(() => null);
  if (!body) return badRequest("invalid_json");

  // Server stamps dsp_short_code from the authenticated DSP; box can't spoof it.
  const payload = { ...body, dsp_short_code: shortCode, source: body.source || "agent" };

  const { data: applicant, error } = await supa.rpc("intake_applicant", { p_payload: payload });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400, headers: { "content-type": "application/json", ...CORS },
    });
  }

  return jsonResponse({ ok: true, applicant_id: applicant?.id }, { headers: CORS });
});
