// invite-team-member · Dashboard-side "Invite member" flow.
//
// (Touch 2026-05-09 to force redeploy — PR #622's workflow run
// silently failed to deploy this function because the bash for-loop
// in deploy-migrations.yml swallowed the per-function failure.
// PR fixing the workflow ships alongside this comment update.)
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
// Email delivery: we DO NOT use auth.admin.inviteUserByEmail (which
// auto-sends Supabase's default magic-link template via whatever
// SMTP Auth has configured — historically the rate-limited default).
// Instead we generate the action_link via auth.admin.generateLink
// (which returns the URL without auto-sending) and queue our own
// branded HTML into public.email_messages.  The existing 0007
// trigger fires send-email on insert; send-email delivers via Resend
// using the project's RESEND_API_KEY + per-DSP "From" branding.
//
// Response: { ok: true, kind: "invited" | "resent_magic_link", … }

import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const TENANT_ALLOWED_ROLES = new Set(["dispatcher", "ops", "owner"]);
const ADMIN_ALLOWED_ROLES  = new Set(["dispatcher", "ops", "owner", "platform_admin"]);

const ROLE_LABEL: Record<string, string> = {
  dispatcher: "Dispatcher",
  ops:        "Ops",
  owner:      "Owner",
  platform_admin: "Platform admin",
};

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

  const url  = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return badRequest("server_misconfigured", 500);

  // 1. Resolve the caller via their JWT.
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

  // 2. Branch on caller role.
  let effectiveDspId: string;
  if (callerProfile.role === "platform_admin") {
    if (!targetDspId) return badRequest("target_dsp_id_required");
    if (!ADMIN_ALLOWED_ROLES.has(role)) return badRequest("invalid_role");
    const { data: targetDsp } = await admin.from("dsps").select("id").eq("id", targetDspId).maybeSingle();
    if (!targetDsp) return badRequest("target_dsp_not_found", 404);
    effectiveDspId = targetDsp.id;
  } else if (callerProfile.role === "owner" || callerProfile.role === "ops") {
    if (!TENANT_ALLOWED_ROLES.has(role)) return badRequest("invalid_role");
    if (targetDspId && targetDspId !== callerProfile.dsp_id) {
      return badRequest("cross_dsp_invite_forbidden", 403);
    }
    effectiveDspId = callerProfile.dsp_id;
  } else {
    return badRequest("insufficient_role", 403);
  }

  // 3. Block duplicates inside the EFFECTIVE DSP up-front.
  const { data: existingInDsp } = await admin
    .from("app_users")
    .select("id, email, active")
    .eq("dsp_id", effectiveDspId)
    .eq("email", email)
    .maybeSingle();
  if (existingInDsp) return badRequest("already_on_team", 409);

  // 4. Look up the target DSP for email branding + welcome copy.
  const { data: targetDspMeta } = await admin
    .from("dsps")
    .select("id, name, short_code, status")
    .eq("id", effectiveDspId)
    .maybeSingle();
  const dspName      = (targetDspMeta?.name      as string) || "your RouteReady workspace";
  const dspShortCode = (targetDspMeta?.short_code as string) || "";
  const dspIsPending = (targetDspMeta?.status as string) === "pending";

  // 5. Generate the magic-link URL WITHOUT auto-sending an email.
  // For new users we use type='invite' which creates the auth.users
  // row + returns the action_link.  For returning users (already
  // have an auth account from a prior signin) we fall back to
  // type='magiclink'.  Neither sends an email — Supabase only
  // auto-sends from inviteUserByEmail / signUp / etc.
  const redirectTo = new URL("/dashboard/login.html", req.headers.get("origin") || url).toString();
  let actionLink: string | null = null;
  let kind: "invited" | "resent_magic_link" = "invited";
  let inviteeUserId: string | null = null;

  const inviteResp = await admin.auth.admin.generateLink({
    type:  "invite",
    email,
    options: {
      data: {
        invite_dsp_id: effectiveDspId,
        invite_role:   role,
        full_name:     fullName || null,
      },
      redirectTo,
    },
  });

  if (inviteResp.error) {
    const msg = (inviteResp.error.message || "").toLowerCase();
    if (msg.includes("already") && (msg.includes("registered") || msg.includes("exist"))) {
      // Returning auth user — issue a magic link instead.
      const linkResp = await admin.auth.admin.generateLink({
        type:  "magiclink",
        email,
        options: { redirectTo },
      });
      if (linkResp.error) return badRequest("invite_failed: " + linkResp.error.message);
      actionLink   = linkResp.data?.properties?.action_link ?? null;
      inviteeUserId = linkResp.data?.user?.id ?? null;
      kind = "resent_magic_link";

      // Patch / create the app_users row.  CRITICAL: app_users.id is
      // the primary key and there's exactly one row per auth user
      // (the schema doesn't model multi-DSP membership today).  An
      // unconditional upsert would silently MOVE the user out of
      // their existing DSP into this one — the bug that put Ryan
      // into "Fart Face Logistics" on 2026-05-09 and locked him out
      // of his real workspace.  Refuse instead, with a clear error
      // the caller can surface.
      if (inviteeUserId) {
        const { data: existingMembership } = await admin
          .from("app_users")
          .select("id, dsp_id, email")
          .eq("id", inviteeUserId)
          .maybeSingle();

        if (existingMembership && existingMembership.dsp_id && existingMembership.dsp_id !== effectiveDspId) {
          return badRequest("already_in_other_dsp", 409);
        }

        // Either no app_users row yet, or already in this DSP.
        // Safe to upsert (creates if missing, updates email/role if
        // present).
        await admin.from("app_users").upsert({
          id:        inviteeUserId,
          dsp_id:    effectiveDspId,
          email,
          full_name: fullName || email,
          role,
          active:    true,
        }, { onConflict: "id" });
      }
    } else {
      return badRequest("invite_failed: " + inviteResp.error.message);
    }
  } else {
    actionLink   = inviteResp.data?.properties?.action_link ?? null;
    inviteeUserId = inviteResp.data?.user?.id ?? null;
  }

  if (!actionLink) return badRequest("link_generation_failed", 500);

  // 6. Queue our custom welcome email via the existing pipeline.
  // The 0007 fire_message_send trigger fires send-email on insert;
  // send-email delivers via Resend with per-DSP "From" branding.
  const isOwnerOnboarding = role === "owner" && dspIsPending;
  const subject = isOwnerOnboarding
    ? `Welcome to RouteReady — finish setup in 5 minutes`
    : `You're invited to ${dspName} on RouteReady`;
  const html = renderInviteHtml({
    role,
    dspName,
    dspShortCode,
    fullName: fullName || null,
    actionLink,
    isOwnerOnboarding,
  });
  const text = renderInviteText({
    role,
    dspName,
    fullName: fullName || null,
    actionLink,
    isOwnerOnboarding,
  });

  const { error: queueErr } = await admin.from("email_messages").insert({
    dsp_id:    effectiveDspId,
    direction: "outbound",
    status:    "queued",
    to_email:  email,
    subject,
    body_html: html,
    body_text: text,
  });
  if (queueErr) {
    // The auth user is already created at this point; surface the
    // queue failure so the operator can manually trigger a resend.
    return badRequest("queue_failed: " + queueErr.message);
  }

  return jsonResponse({ ok: true, kind, user_id: inviteeUserId, queued: true }, { headers: CORS });
});

// ── Email templates ───────────────────────────────────────────────────────
// Inline-style HTML that survives Outlook + Gmail.  Plain-text version
// is the same content rendered for clients that don't render HTML
// (or that hide remote content by default).

interface InviteCtx {
  role:               string;
  dspName:            string;
  dspShortCode?:      string;
  fullName:           string | null;
  actionLink:         string;
  isOwnerOnboarding:  boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;"  :
    c === ">" ? "&gt;"  :
    c === '"' ? "&quot;" : "&#39;"
  );
}

function renderInviteHtml(ctx: InviteCtx): string {
  const greeting = ctx.fullName
    ? `Hi ${escapeHtml(ctx.fullName.split(/\s+/)[0])},`
    : `Welcome aboard.`;

  const intro = ctx.isOwnerOnboarding
    ? `Your RouteReady workspace for <strong>${escapeHtml(ctx.dspName)}</strong> is provisioned and waiting for you. To finish activation, sign in below and complete a short onboarding.`
    : `You've been invited to join <strong>${escapeHtml(ctx.dspName)}</strong> on RouteReady as ${escapeHtml(ROLE_LABEL[ctx.role] || ctx.role)}.  Click the button below to set up your account and sign in.`;

  const buttonLabel = ctx.isOwnerOnboarding ? "Activate workspace" : "Set up your account";

  const stepsBlock = ctx.isOwnerOnboarding ? `
    <table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;width:100%">
      <tr><td style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:13px;color:#475569;line-height:1.6">
        <strong style="color:#111827">What happens next:</strong><br>
        1. Confirm your company details and primary contact<br>
        2. Set up billing (you can pause anytime during the trial period)<br>
        3. Land in your live dashboard with your routes, drivers, and dispatch tools ready to use
      </td></tr>
    </table>
    <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:13px;color:#475569;line-height:1.6;margin:16px 0 0 0">
      The onboarding takes about five minutes. Your link is valid for 7 days.
    </p>
  ` : "";

  // Desktop / "Owner App" callout · the same dashboard, packaged as
  // a native Electron app for Mac / Windows / Linux.  Optional but
  // many DSP owners prefer it for daily ops.  Hidden for non-owner
  // invites (a dispatcher doesn't need to be marketed to about the
  // installer; they can find it from inside the dashboard).
  const desktopAppBlock = ctx.isOwnerOnboarding ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:28px 0 0 0;background:#F8FAFC;border:1px solid rgba(15,23,42,.06);border-radius:10px">
      <tr><td style="padding:18px 20px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="vertical-align:top;padding-right:14px">
              <div style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:13px;font-weight:700;color:#111827;letter-spacing:-.005em">Prefer a desktop app?</div>
              <div style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:12px;color:#475569;line-height:1.5;margin-top:4px">
                RouteReady Desktop is the same workspace, packaged as a native app for Mac, Windows, and Linux.&nbsp;Always-on background sync with your Amazon DSP portal.
              </div>
            </td>
            <td style="vertical-align:top;text-align:right;white-space:nowrap">
              <a href="https://gorouteready.com/download" target="_blank" rel="noopener" style="display:inline-block;background:#ffffff;color:#111827;text-decoration:none;font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:12px;font-weight:600;padding:8px 14px;border-radius:6px;border:1px solid rgba(15,23,42,.16);letter-spacing:.005em">
                Get the app →
              </a>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  ` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ctx.isOwnerOnboarding ? "Welcome to RouteReady" : "You're invited to RouteReady")}</title>
</head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,'Segoe UI',Inter,sans-serif;color:#111827">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F9FAFB;padding:32px 16px">
    <tr><td align="center">

      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border:1px solid rgba(15,23,42,.10);border-radius:14px;overflow:hidden">

        <!-- Header -->
        <tr><td style="padding:28px 32px 16px 32px;border-bottom:1px solid rgba(15,23,42,.05)">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right:12px;vertical-align:middle">
                <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#2563EB 0%,#2563EB 100%);color:#fff;text-align:center;line-height:40px;font-weight:700;font-size:14px;letter-spacing:.04em">RR</div>
              </td>
              <td style="vertical-align:middle">
                <div style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:15px;font-weight:700;letter-spacing:-.005em;color:#111827">RouteReady</div>
                <div style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:11px;font-weight:500;color:#94A3B8;letter-spacing:.04em;text-transform:uppercase;margin-top:1px">Operations platform for Amazon DSPs</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 32px">
          <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:18px;font-weight:700;color:#111827;margin:0 0 8px 0;letter-spacing:-.005em">
            ${greeting}
          </p>
          <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:14px;color:#475569;line-height:1.6;margin:0">
            ${intro}
          </p>

          <!-- CTA button -->
          <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px 0">
            <tr><td>
              <a href="${escapeHtml(ctx.actionLink)}" target="_blank" rel="noopener" style="display:inline-block;background:linear-gradient(135deg,#2563EB 0%,#2563EB 100%);color:#ffffff;text-decoration:none;font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;letter-spacing:.005em">
                ${buttonLabel} →
              </a>
            </td></tr>
          </table>

          <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:12px;color:#94A3B8;line-height:1.5;margin:0">
            Or copy + paste this URL into your browser:<br>
            <span style="color:#475569;word-break:break-all">${escapeHtml(ctx.actionLink)}</span>
          </p>

          ${stepsBlock}
          ${desktopAppBlock}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 32px 24px 32px;border-top:1px solid rgba(15,23,42,.05)">
          <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:12px;color:#94A3B8;line-height:1.6;margin:0">
            If you have questions before you sign in, reply to this email or reach us at
            <a href="mailto:support@gorouteready.com" style="color:#1D4ED8;text-decoration:none">support@gorouteready.com</a>.
          </p>
          <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:12px;color:#94A3B8;line-height:1.6;margin:8px 0 0 0">
            — The RouteReady team
          </p>
        </td></tr>

      </table>

      <p style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:11px;color:#94A3B8;text-align:center;margin:18px 0 0 0;letter-spacing:.02em">
        Encrypted in transit · gorouteready.com
      </p>

    </td></tr>
  </table>
</body>
</html>`;
}

function renderInviteText(ctx: InviteCtx): string {
  const greeting = ctx.fullName
    ? `Hi ${ctx.fullName.split(/\s+/)[0]},`
    : `Welcome aboard.`;
  const lines: string[] = [greeting, ""];
  if (ctx.isOwnerOnboarding) {
    lines.push(`Your RouteReady workspace for ${ctx.dspName} is provisioned and waiting for you.  To finish activation, sign in below and complete a short onboarding.`);
    lines.push("");
    lines.push(ctx.actionLink);
    lines.push("");
    lines.push(`What happens next:`);
    lines.push(`  1. Confirm your company details and primary contact`);
    lines.push(`  2. Set up billing (you can pause anytime during the trial period)`);
    lines.push(`  3. Land in your live dashboard with your routes, drivers, and dispatch tools ready to use`);
    lines.push("");
    lines.push(`The onboarding takes about five minutes.  Your link is valid for 7 days.`);
    lines.push("");
    lines.push(`Prefer a desktop app?  RouteReady Desktop is the same workspace, packaged as a native app for Mac, Windows, and Linux:`);
    lines.push(`  https://gorouteready.com/download`);
  } else {
    lines.push(`You've been invited to join ${ctx.dspName} on RouteReady as ${ROLE_LABEL[ctx.role] || ctx.role}.  Open the link below to set up your account and sign in.`);
    lines.push("");
    lines.push(ctx.actionLink);
  }
  lines.push("");
  lines.push(`Questions?  Reply to this email or reach us at support@gorouteready.com.`);
  lines.push("");
  lines.push(`— The RouteReady team`);
  return lines.join("\n");
}
