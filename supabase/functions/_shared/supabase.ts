// Shared service-role client for edge functions. Each function imports
// this and gets a fully-privileged client that bypasses RLS — only use
// it server-side, behind a webhook signature check or env-gated cron.
import { createClient, SupabaseClient } from "@supabase/supabase-js";

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

// message-attachments is a PRIVATE bucket (migration 0447). Turn a stored
// attachment — either the new { path } form or a legacy { url } public URL —
// into a fresh signed URL that an unauthenticated external fetcher (Twilio
// MMS MediaUrl, Resend attachment path) can read for `ttlSeconds`. Signed via
// the service role, so it bypasses RLS. Returns null on ANY failure so the
// caller can skip the attachment WITHOUT failing the whole send.
export async function signMessageAttachment(
  supa: SupabaseClient,
  att: { path?: string | null; url?: string | null } | null | undefined,
  ttlSeconds = 86400,
): Promise<string | null> {
  try {
    let path = att?.path ?? null;
    if (!path && att?.url) {
      const m = String(att.url).match(/\/object\/(?:public|sign)\/message-attachments\/([^?]+)/);
      if (m) path = decodeURIComponent(m[1]);
    }
    if (!path) return null;
    const { data, error } = await supa.storage
      .from("message-attachments")
      .createSignedUrl(path, ttlSeconds);
    if (error || !data || !data.signedUrl) return null;
    return data.signedUrl;
  } catch (_) {
    return null;
  }
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
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const fit = Deno.env.get("FUNCTION_INTERNAL_TOKEN")   || "";
  const candidates = [srk, fit].filter((v) => v.length > 0);
  if (candidates.length === 0) {
    return jsonResponse({ error: "service_key_not_configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") || "";
  const fromAuth = auth.replace(/^Bearer\s+/i, "");
  const fromApiKey = req.headers.get("apikey") || "";
  const match = candidates.some(c => c === fromAuth || c === fromApiKey);
  if (!match) {
    // One-time diagnostic so a 401 carries enough fingerprint info to
    // tell us which side is wrong without ever leaking full key values.
    // Logged prefix is 16 chars (longer than the "sb_secret_" identifier
    // but well short of the random tail) and length so we can confirm
    // the env var is the full key, not truncated, with a typo, etc.
    console.log("auth_failed", JSON.stringify({
      auth_prefix:     fromAuth.slice(0, 16),
      auth_len:        fromAuth.length,
      apikey_prefix:   fromApiKey.slice(0, 16),
      apikey_len:      fromApiKey.length,
      srk_prefix:      srk.slice(0, 16),
      srk_len:         srk.length,
      srk_set:         srk.length > 0,
      fit_prefix:      fit.slice(0, 16),
      fit_len:         fit.length,
      fit_set:         fit.length > 0,
    }));
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
