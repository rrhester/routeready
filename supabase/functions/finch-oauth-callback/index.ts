// Finch redirects here after the DSP authorizes their ADP account (public;
// deploy with --no-verify-jwt). Security = the HMAC-signed `state` (verifies
// origin + binds to dsp/user) and the server-side code→token exchange. Stores
// the encrypted token, then 302s to a dashboard-hosted page that posts the
// result to the opener and closes. Mirrors google-oauth-callback.
import { serviceClient } from "../_shared/supabase.ts";
import { verifyState, exchangeCode, introspect, encryptSecret } from "../_shared/finch.ts";

function closePage(ok: boolean, msg: string) {
  const base = (Deno.env.get("DASHBOARD_URL") || "https://gorouteready.com/dashboard").replace(/\/+$/, "");
  const url = `${base}/finch-callback.html?ok=${ok ? "1" : "0"}` + (msg ? `&msg=${encodeURIComponent(msg)}` : "");
  return new Response(null, { status: 302, headers: { location: url } });
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const err = u.searchParams.get("error");
  if (err) return closePage(false, "Authorization cancelled: " + err);

  const code = u.searchParams.get("code") || "";
  const state = await verifyState(u.searchParams.get("state") || "");
  if (!code || !state) return closePage(false, "Invalid or expired authorization. Please retry.");

  let token: string;
  try {
    token = await exchangeCode(code);
  } catch (e) {
    return closePage(false, "Could not connect to ADP via Finch: " + (e instanceof Error ? e.message : String(e)));
  }

  // Identify the connected provider/company (best-effort; sync works regardless).
  const info = await introspect(token);
  const providerId = (info.payroll_provider_id as string) || (info.provider_id as string) || "";
  const companyId  = (info.company_id as string) || "";
  const accountId  = (info.account_id as string) || "";

  const supa = serviceClient();
  const enc = await encryptSecret(token);
  const { error } = await supa.from("finch_connections").upsert({
    dsp_id: state.dsp_id,
    provider_id: providerId || null,
    provider_name: prettyProvider(providerId),
    finch_account_id: accountId || null,
    finch_company_id: companyId || null,
    access_token_enc: enc.ct,
    access_token_iv: enc.iv,
    status: "connected",
    last_error: null,
    connected_by: state.user_id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "dsp_id" });

  return error ? closePage(false, "Storage error: " + error.message) : closePage(true, "ok");
});

// Map Finch's provider id → a human label for the connected banner.
function prettyProvider(id: string): string {
  if (!id) return "ADP";
  const map: Record<string, string> = {
    adp_workforce_now: "ADP Workforce Now",
    adp_run: "ADP RUN",
    adp_comprehensive_services: "ADP Comprehensive Services",
    adp_totalsource: "ADP TotalSource",
  };
  if (map[id]) return map[id];
  // Fallback: title-case the id (e.g. "gusto" → "Gusto").
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
