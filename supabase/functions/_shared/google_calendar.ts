// Google Calendar API helpers: keep a valid (refreshed, cached) access token
// and create/update/delete events. All server-side, service-role only.
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { encryptSecret, decryptSecret } from "./google_crypto.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_BASE  = "https://www.googleapis.com/calendar/v3/calendars";

export interface GCalAccount {
  dsp_id: string; google_email: string; calendar_id: string;
  refresh_token_enc: string; refresh_token_iv: string;
  access_token_enc: string | null; access_token_iv: string | null;
  access_token_expires_at: string | null;
}

export interface EventInput {
  title: string; description: string;
  startsAt: string; endsAt: string | null; timezone?: string | null;
}

// Returns a valid access token, refreshing + caching when needed.
export async function getAccessToken(supa: SupabaseClient, acct: GCalAccount): Promise<string> {
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
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error("token_refresh_failed: " + (tok.error_description || tok.error || res.status));

  const enc = await encryptSecret(tok.access_token);
  await supa.from("google_calendar_accounts").update({
    access_token_enc: enc.ct, access_token_iv: enc.iv,
    access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("dsp_id", acct.dsp_id);

  return tok.access_token as string;
}

function eventBody(ev: EventInput) {
  const start = new Date(ev.startsAt);
  const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 30 * 60_000);
  const tz = ev.timezone || "UTC";
  return {
    summary: ev.title,
    description: ev.description || "",
    start: { dateTime: start.toISOString(), timeZone: tz },
    end:   { dateTime: end.toISOString(),   timeZone: tz },
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
  if (!res.ok) throw new Error(`gcal_${method}_failed: ${json?.error?.message || res.status}`);
  return json;
}

export const gcalCreate = (t: string, cal: string, ev: EventInput) =>
  call(t, `${CAL_BASE}/${encodeURIComponent(cal)}/events`, "POST", eventBody(ev));
export const gcalUpdate = (t: string, cal: string, id: string, ev: EventInput) =>
  call(t, `${CAL_BASE}/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, "PATCH", eventBody(ev));
export const gcalDelete = (t: string, cal: string, id: string) =>
  call(t, `${CAL_BASE}/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, "DELETE");

export interface GCalListItem {
  id: string; title: string;
  start: string | null; end: string | null;
  allDay: boolean; htmlLink: string | null;
}

// List a calendar's events in [timeMin, timeMax]. singleEvents expands
// recurring series into instances. Cancelled instances are dropped.
export async function gcalListEvents(
  t: string, cal: string, timeMin: string, timeMax: string,
): Promise<GCalListItem[]> {
  const qs = new URLSearchParams({
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });
  const json = await call(t, `${CAL_BASE}/${encodeURIComponent(cal)}/events?${qs}`, "GET");
  // deno-lint-ignore no-explicit-any
  return ((json.items || []) as any[])
    .filter((it) => it.status !== "cancelled")
    .map((it) => ({
      id: String(it.id),
      title: it.summary || "(no title)",
      start: it.start?.dateTime || it.start?.date || null,
      end: it.end?.dateTime || it.end?.date || null,
      allDay: !!(it.start && it.start.date && !it.start.dateTime),
      htmlLink: it.htmlLink || null,
    }));
}
