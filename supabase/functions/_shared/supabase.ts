// Shared service-role client for edge functions. Each function imports
// this and gets a fully-privileged client that bypasses RLS — only use
// it server-side, behind a webhook signature check or env-gated cron.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

export function badRequest(msg: string, status = 400) {
  return jsonResponse({ error: msg }, { status });
}

// In-function bearer-token gate for server-to-server functions
// (send-email, send-sms) deployed with --no-verify-jwt so they accept
// the post-rotation sb_secret_… keys at the gateway. We still need an
// auth gate so they aren't open to the internet — this matches the
// caller's Authorization (or apikey) header against the auto-injected
// service role key. FUNCTION_INTERNAL_TOKEN is an optional manual
// override for when Supabase's auto-injected value drifts from what's
// stored in private.app_settings.service_role_key (belt-and-braces for
// post-key-rotation environments).
export function requireServiceKey(req: Request): Response | null {
  const candidates = [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    Deno.env.get("FUNCTION_INTERNAL_TOKEN"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (candidates.length === 0) {
    return jsonResponse({ error: "service_key_not_configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") || "";
  const fromAuth = auth.replace(/^Bearer\s+/i, "");
  const fromApiKey = req.headers.get("apikey") || "";
  if (!candidates.some(c => c === fromAuth || c === fromApiKey)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// Quiet hours (TCPA): never send between dsp.metadata.sms.quiet_hours.
// All times interpreted in the DSP's timezone.
export function isWithinQuietHours(now: Date, tz: string, startHHMM: string, endHHMM: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = parts.find(p => p.type === "hour")?.value ?? "00";
  const mm = parts.find(p => p.type === "minute")?.value ?? "00";
  const cur = `${hh}:${mm}`;
  // Window can wrap midnight (e.g. 21:00 → 08:00)
  if (startHHMM <= endHHMM) return cur >= startHHMM && cur < endHHMM;
  return cur >= startHHMM || cur < endHHMM;
}
