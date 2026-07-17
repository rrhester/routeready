// Microsoft Graph helpers for the Outlook calendar push (calendar 100-list
// #63): keep a valid (refreshed, cached) access token and create/update/
// delete events. Mirrors _shared/google_calendar.ts; tokens are encrypted at
// rest with the same AES key helpers (google_crypto.ts — the key is a
// runtime-wide secret, not a Google-specific one).
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { encryptSecret, decryptSecret } from "./google_crypto.ts";

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

export interface MsCalAccount {
  dsp_id: string; ms_email: string;
  refresh_token_enc: string; refresh_token_iv: string;
  access_token_enc: string | null; access_token_iv: string | null;
  access_token_expires_at: string | null;
}

export interface MsEventInput {
  title: string; description: string;
  startsAt: string; endsAt: string | null; timezone?: string | null;
}

export async function getMsAccessToken(supa: SupabaseClient, acct: MsCalAccount): Promise<string> {
  const fresh = acct.access_token_enc && acct.access_token_iv && acct.access_token_expires_at &&
    new Date(acct.access_token_expires_at).getTime() - 60_000 > Date.now();
  if (fresh) return decryptSecret(acct.access_token_enc!, acct.access_token_iv!);

  const refresh = await decryptSecret(acct.refresh_token_enc, acct.refresh_token_iv);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: Deno.env.get("MS_CLIENT_ID")!,
      client_secret: Deno.env.get("MS_CLIENT_SECRET")!,
      scope: "offline_access User.Read Calendars.ReadWrite",
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error("ms_token_refresh_failed: " + (tok.error_description || tok.error || res.status));

  const enc = await encryptSecret(tok.access_token);
  const upd: Record<string, unknown> = {
    access_token_enc: enc.ct, access_token_iv: enc.iv,
    access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Microsoft rotates refresh tokens — persist the new one when handed back.
  if (tok.refresh_token) {
    const rt = await encryptSecret(tok.refresh_token);
    upd.refresh_token_enc = rt.ct; upd.refresh_token_iv = rt.iv;
  }
  await supa.from("ms_calendar_accounts").update(upd).eq("dsp_id", acct.dsp_id);
  return tok.access_token as string;
}

function eventBody(ev: MsEventInput) {
  const start = new Date(ev.startsAt);
  const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 30 * 60_000);
  const tz = ev.timezone || "UTC";
  return {
    subject: ev.title,
    body: { contentType: "text", content: ev.description || "" },
    start: { dateTime: start.toISOString().replace(/Z$/, ""), timeZone: "UTC" },
    end:   { dateTime: end.toISOString().replace(/Z$/, ""),   timeZone: "UTC" },
    // Graph renders in the viewer's zone; originalStartTimeZone is advisory.
    originalStartTimeZone: tz,
  };
}

async function call(token: string, url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`msgraph_${method}_failed: ${json?.error?.message || res.status}`);
  return json;
}

export const msEventCreate = (t: string, ev: MsEventInput) =>
  call(t, `${GRAPH}/me/calendar/events`, "POST", eventBody(ev));
export const msEventUpdate = (t: string, id: string, ev: MsEventInput) =>
  call(t, `${GRAPH}/me/events/${encodeURIComponent(id)}`, "PATCH", eventBody(ev));
export const msEventDelete = (t: string, id: string) =>
  call(t, `${GRAPH}/me/events/${encodeURIComponent(id)}`, "DELETE");
