// invite-team-member · Dashboard-side "Invite member" flow.
//
// POST { email, full_name, role } with the inviter's user JWT in the
// Authorization header. We:
//   1. Resolve the caller's app_users row (id, dsp_id, role).
//   2. Confirm they have authority to invite (owner or ops).
//   3. Call auth.admin.inviteUserByEmail with metadata that the
//      0076 trigger uses to land the new user in the right DSP.
//
// Returns { ok: true } on success, or { error: string } with a 4xx.
//
// Required Supabase secrets (already set for the project):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const ALLOWED_ROLES = new Set(["dispatcher", "ops", "owner"]);
// Drivers don't need dashboard access — they sign in via the driver PWA
// with a code, not a magic-link, so omit "driver" from this picker.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return badRequest("method_not_allowed", 405);

  let body: { email?: string; full_name?: string; role?: string };
  try { body = await req.json(); }
  catch { return badRequest("invalid_json"); }

  const email     = (body.email || "").trim().toLowerCase();
  const fullName  = (body.full_name || "").trim();
  const role      = (body.role || "dispatcher").trim();

  if (!email || !email.includes("@"))   return badRequest("invalid_email");
  if (!ALLOWED_ROLES.has(role))         return badRequest("invalid_role");

  // 1. Resolve the caller — we need a user-context client to read
  // their JWT, then a service-role client for the privileged work.
  const url = Deno.env.get("SUPABASE_URL");
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
  if (!["owner", "ops"].includes(callerProfile.role)) {
    return badRequest("insufficient_role", 403);
  }

  // 2. Block duplicates inside the same DSP up-front so we can return a
  // clear error instead of a generic auth-side failure.
  const { data: existing } = await admin
    .from("app_users")
    .select("id, email, active")
    .eq("dsp_id", callerProfile.dsp_id)
    .eq("email", email)
    .maybeSingle();
  if (existing) return badRequest("already_on_team", 409);

  // 3. Send the invite. The 0076 trigger reads invite_dsp_id +
  // invite_role from raw_user_meta_data and creates the app_users row
  // with those values, bypassing the gorouteready.com-only gate.
  const redirectTo = new URL("/dashboard/login.html", req.headers.get("origin") || url).toString();
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      invite_dsp_id: callerProfile.dsp_id,
      invite_role:   role,
      full_name:     fullName || null,
    },
    redirectTo,
  });

  if (inviteErr) {
    // Common case: user already exists in auth.users from a previous
    // sign-in. Re-issue a magic link so they can re-enter — and best-
    // effort patch their app_users row to the chosen DSP/role.
    if (inviteErr.message?.toLowerCase().includes("already registered")) {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      });
      if (linkErr) return badRequest("invite_failed: " + linkErr.message);
      // The trigger only fires on insert; if their app_users row
      // already exists for a *different* DSP we leave it alone.
      // Otherwise create it now so they land in this DSP on next login.
      if (linkData?.user?.id) {
        await admin.from("app_users").upsert({
          id:        linkData.user.id,
          dsp_id:    callerProfile.dsp_id,
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
