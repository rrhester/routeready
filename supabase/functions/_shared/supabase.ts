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
