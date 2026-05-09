// invite-team-member · Dashboard-side "Invite member" flow.
//
// POST { email, full_name, role, target_dsp_id? } with the inviter's
// user JWT in the Authorization header.
//
//   - Regular case (caller is owner / ops):
//       The new member is invited into the CALLER'S dsp_id.  Allowed
//       roles: dispatcher / ops / owner.
//
//   - Platform-admin case (caller is platform_admin):
//       Caller MUST send `target_dsp_id`.  The new member is invited
//       into that DSP.  Allowed roles include `platform_admin` (so
//       another platform admin can be promoted) plus all the regular
//       roles.
//
// Response: { ok: true, kind: "invited" | "resent_magic_link", … }
//
// Required Supabase secrets (already set for the project):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

// Roles a regular owner/ops inviter is allowed to assign.  Drivers
// don't need dashboard access — they sign in via the driver PWA with
// a code, not a magic-link, so omit "driver" from this picker.
const TENANT_ALLOWED_ROLES = new Set(["dispatcher", "ops", "owner"]);

// Roles a platform_admin inviter can assign.  Adds platform_admin so
// the existing platform admin can promote a peer; everything else
// remains available too.
const ADMIN_ALLOWED_ROLES = new Set(["dispatcher", "ops", "owner", "platform_admin"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return badRequest("method_not_allowed", 405);

  let body: { email?: string; full_name?: string; role?: string; target_dsp_id?: string };
  try { body = await req.json(); }
  catch { return badRequest("invalid_json"); }

  const email        = (body.email || "").trim().toLowerCase();
  const fullName     = (body.full_name || "").trim();
  const role         = (body.role || "dispatcher").trim();
  const targetDspId  = (body.target_dsp_id || "").trim() || null;

  if (!email || !email.includes("@")) return badRequest("invalid_email");

  // 1. Resolve the caller — we need a user-context client to read
  // their JWT, then a service-role client for the privileged work.
  const url  = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return badRequest("server_misconfigured", 500);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return badRequest("not_authenticated", 401);

  const admin = serviceClient();
  const { data: callerProfile, error: callerErr } = await admin
    .from("app_users")
    .select("id, dsp_id, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (callerErr || !callerProfile) return badRequest("no_profile", 403);
  if (!callerProfile.active)       return badRequest("inactive_caller", 403);

  // Branch on caller role.  Platform admins can invite anyone into
  // any DSP at any of the staff roles (incl. platform_admin).  Owner
  // / ops can only invite into their own DSP, at the regular roles.
  let effectiveDspId: string;
  if (callerProfile.role === "platform_admin") {
    if (!targetDspId) return badRequest("target_dsp_id_required");
    if (!ADMIN_ALLOWED_ROLES.has(role)) return badRequest("invalid_role");
    // Confirm the target DSP exists.  RLS won't apply here (we're
    // using the service-role client) so this is a real existence
    // check, not an RLS bypass.
    const { data: targetDsp } = await admin
      .from("dsps")
      .select("id")
      .eq("id", targetDspId)
      .maybeSingle();
    if (!targetDsp) return badRequest("target_dsp_not_found", 404);
    effectiveDspId = targetDsp.id;
  } else if (callerProfile.role === "owner" || callerProfile.role === "ops") {
    if (!TENANT_ALLOWED_ROLES.has(role)) return badRequest("invalid_role");
    if (targetDspId && targetDspId !== callerProfile.dsp_id) {
      // Don't let a tenant owner accidentally (or intentionally) try
      // to invite someone into a different DSP via a forged request.
      return badRequest("cross_dsp_invite_forbidden", 403);
    }
    effectiveDspId = callerProfile.dsp_id;
  } else {
    return badRequest("insufficient_role", 403);
  }

  // 2. Block duplicates inside the EFFECTIVE DSP up-front so we can
  // return a clear error instead of a generic auth-side failure.
  const { data: existing } = await admin
    .from("app_users")
    .select("id, email, active")
    .eq("dsp_id", effectiveDspId)
    .eq("email", email)
    .maybeSingle();
  if (existing) return badRequest("already_on_team", 409);

  // 3. Send the invite.  The 0076 trigger reads invite_dsp_id +
  // invite_role from raw_user_meta_data and creates the app_users
  // row with those values, bypassing the gorouteready.com-only gate.
  const redirectTo = new URL("/dashboard/login.html", req.headers.get("origin") || url).toString();
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      invite_dsp_id: effectiveDspId,
      invite_role:   role,
      full_name:     fullName || null,
    },
    redirectTo,
  });

  if (inviteErr) {
    // Common case: user already exists in auth.users from a previous
    // sign-in.  Re-issue a magic link so they can re-enter — and
    // best-effort patch their app_users row to the chosen DSP/role.
    if (inviteErr.message?.toLowerCase().includes("already registered")) {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      });
      if (linkErr) return badRequest("invite_failed: " + linkErr.message);
      if (linkData?.user?.id) {
        await admin.from("app_users").upsert({
          id:        linkData.user.id,
          dsp_id:    effectiveDspId,
          email,
          full_name: fullName || email,
          role,
          active:    true,
        }, { onConflict: "id" });
      }
      return jsonResponse({ ok: true, kind: "resent_magic_link", action_link: linkData?.properties?.action_link ?? null }, { headers: CORS });
    }
    return badRequest("invite_failed: " + inviteErr.message);
  }

  return jsonResponse({ ok: true, kind: "invited", user_id: invited?.user?.id ?? null }, { headers: CORS });
});
