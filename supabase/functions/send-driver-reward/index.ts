// send-driver-reward · Dispatcher sends a digital reward to a driver.
//
// POST body (JWT in Authorization):
//   {
//     driver_id:   uuid,
//     amount_cents: int,       // 1 – 10000  ($0.01 – $100)
//     reward_type: string,     // amazon | visa | walmart | gas_card | restaurant | general
//     reason:      string,     // perfect_attendance | great_rescue | safety | …
//     note?:       string      // optional, max 400 chars
//   }
//
// Flow:
//   1. Validate caller (dispatcher of some DSP via app_users).
//   2. Validate driver belongs to caller's DSP.
//   3. Insert pending driver_rewards row.
//   4. Call the configured provider via getProvider().
//   5. Update row: success → sent + provider_reward_id + claim_url,
//      failure → failed + failure_reason.
//   6. Return { ok, reward: { id, status, claim_url, provider, mode } }.
//
// Provider is swappable via the REWARD_PROVIDER env var.  Defaults to
// the mock provider so a fresh deploy works end-to-end without any
// third-party credentials.  See supabase/functions/_shared/rewards/
// for the abstraction.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { getProviderForDsp } from "../_shared/rewards/index.ts";
import type { RewardType } from "../_shared/rewards/types.ts";

const CORS = {
  "access-control-allow-origin":  "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const ALLOWED_TYPES = new Set(["amazon","visa","walmart","gas_card","restaurant","general"]);
const ALLOWED_REASONS = new Set([
  "perfect_attendance","great_rescue","safety","customer_feedback",
  "teamwork","peak_performance","above_and_beyond","custom",
]);
const ALLOWED_ROLES = new Set(["dispatcher","ops","owner","platform_admin"]);
const MIN_CENTS = 1;
const MAX_CENTS = 100_00;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return badRequest("method_not_allowed", 405);

  let body: {
    driver_id?:   string;
    amount_cents?: number;
    reward_type?: string;
    reason?:      string;
    note?:        string;
  };
  try { body = await req.json(); }
  catch { return badRequest("invalid_json"); }

  const driverId   = (body.driver_id || "").trim();
  const amount     = Number(body.amount_cents);
  const rewardType = (body.reward_type || "").trim();
  const reason     = (body.reason || "").trim();
  const note       = (body.note || "").trim().slice(0, 400) || null;

  if (!driverId)                                  return badRequest("driver_required");
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) return badRequest("amount_required");
  if (amount < MIN_CENTS || amount > MAX_CENTS)   return badRequest("amount_out_of_range");
  if (!ALLOWED_TYPES.has(rewardType))             return badRequest("reward_type_invalid");
  if (!ALLOWED_REASONS.has(reason))               return badRequest("reason_invalid");

  const url  = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return badRequest("server_misconfigured", 500);

  // 1. Resolve caller.
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth:   { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return badRequest("not_authenticated", 401);

  const admin = serviceClient();
  const { data: caller, error: callerErr } = await admin
    .from("app_users")
    .select("id, dsp_id, role, active, full_name, email")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (callerErr || !caller) return badRequest("no_profile", 403);
  if (!caller.active)       return badRequest("inactive_caller", 403);
  if (!ALLOWED_ROLES.has(caller.role)) return badRequest("insufficient_role", 403);

  // 2. Validate driver belongs to caller's DSP and pull contact info.
  const { data: driver, error: drvErr } = await admin
    .from("drivers")
    .select("id, dsp_id, full_name, preferred_name, email, phone, status")
    .eq("id", driverId)
    .maybeSingle();
  if (drvErr || !driver) return badRequest("driver_not_found", 404);
  if (driver.dsp_id !== caller.dsp_id) return badRequest("cross_dsp_forbidden", 403);
  if (driver.status === "archived" || driver.status === "removed") {
    return badRequest("driver_inactive", 409);
  }

  // 3. Pull the DSP name for the recipient-facing sender string.
  const { data: dsp } = await admin
    .from("dsps")
    .select("name")
    .eq("id", caller.dsp_id)
    .maybeSingle();
  const dspName = (dsp?.name as string) || "Your team";

  // 4. Insert the pending row.  We do this BEFORE calling the provider
  // so if the provider call succeeds and the DB write fails, we don't
  // double-charge by retrying.  status=pending is filtered out of every
  // user-facing surface.
  const { data: pending, error: insErr } = await admin
    .from("driver_rewards")
    .insert({
      dsp_id:       caller.dsp_id,
      driver_id:    driver.id,
      amount_cents: amount,
      currency:     "USD",
      reward_type:  rewardType,
      reason,
      note,
      status:       "pending",
      sent_by:      caller.id,
    })
    .select("id")
    .single();
  if (insErr || !pending?.id) {
    console.error("rewards insert failed", insErr);
    return badRequest("db_insert_failed", 500);
  }

  // 5. Resolve the provider for this DSP (per-DSP OAuth-granted
  // Tremendous account; falls back to mock if the DSP hasn't connected
  // yet).
  const resolved = await getProviderForDsp(caller.dsp_id);
  const provider = resolved.provider;
  const recipientName = (driver.preferred_name as string)?.trim()
    || (driver.full_name as string)?.trim()
    || "Driver";
  const senderName = (caller.full_name as string)?.trim()
    || (caller.email as string)
    || "A teammate";

  const result = await provider.send({
    externalId:  pending.id,
    amountCents: amount,
    currency:    "USD",
    rewardType:  rewardType as RewardType,
    recipient: {
      name:  recipientName,
      email: (driver.email as string) || null,
      phone: (driver.phone as string) || null,
    },
    sender: { name: senderName, dspName },
    message: note,
  });

  // 6. Persist provider result.
  const nowIso = new Date().toISOString();
  if (result.ok) {
    const { error: updErr } = await admin
      .from("driver_rewards")
      .update({
        status:             "sent",
        provider:           result.provider,
        provider_reward_id: result.providerRewardId,
        claim_url:          result.claimUrl,
        sent_at:            nowIso,
        metadata:           { provider_raw: result.raw || {}, provider_mode: provider.mode },
      })
      .eq("id", pending.id);
    if (updErr) console.warn("reward update after provider success failed", updErr);

    // Stamp last_used_at on the integration so the dashboard's Rewards
    // setup card can show "last used X ago".  Service-role-only RPC.
    if (!resolved.fellBackToMock) {
      await admin.rpc("dsp_reward_integration_mark_used", { p_dsp_id: caller.dsp_id })
        .then(() => {}, (e) => console.warn("mark_used failed", e));
    }

    return jsonResponse({
      ok: true,
      reward: {
        id:         pending.id,
        status:     "sent",
        claim_url:  result.claimUrl,
        provider:   result.provider,
        provider_reward_id: result.providerRewardId,
        mode:       provider.mode,
      },
      provider_status: resolved.fellBackToMock ? "mock" : "connected",
    });
  }

  const { error: updErr } = await admin
    .from("driver_rewards")
    .update({
      status:         "failed",
      provider:       result.provider,
      failure_reason: result.message,
      metadata:       { provider_raw: result.raw || {}, provider_mode: provider.mode, error_code: result.code },
    })
    .eq("id", pending.id);
  if (updErr) console.warn("reward update after provider failure failed", updErr);

  return jsonResponse({
    ok: false,
    reward: { id: pending.id, status: "failed" },
    error: result.message,
    code:  result.code,
  }, { status: 502 });
});
