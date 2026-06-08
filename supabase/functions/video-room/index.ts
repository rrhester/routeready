// video-room · Mints a Whereby room on demand and returns its URL. JWT-gated
// (deployed WITH jwt verification) so only an authenticated operator can call
// it; used by the dashboard's full-page event editor so the join link can be
// shown in the invite body immediately (the room exists before the event is
// saved). Called from the browser via supabase.functions.invoke → needs CORS.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const WHEREBY_API = "https://api.whereby.com/v1/meetings";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  // Require a valid signed-in user (the gateway already verifies the JWT, but
  // double-check so this can't be called with just the anon key).
  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });

  const key = Deno.env.get("WHEREBY_API_KEY");
  if (!key) return jsonResponse({ error: "no_key" }, { status: 500, headers: CORS });

  const { ends_at, group } = await req.json().catch(() => ({}));
  // Room stays open until ~2h after the meeting end (or 3h from now as a fallback).
  const end = ends_at ? new Date(new Date(ends_at).getTime() + 2 * 60 * 60_000) : new Date(Date.now() + 3 * 60 * 60_000);

  try {
    const res = await fetch(WHEREBY_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.trim()}`,
        "content-type": "application/json",
        "accept": "application/json",
        // A real UA — Deno's default UA is blocked by Whereby's WAF (403 HTML).
        "user-agent": "RouteReady/1.0 (+https://gorouteready.com)",
      },
      body: JSON.stringify({ endDate: end.toISOString(), roomMode: group ? "group" : "normal", fields: ["hostRoomUrl"] }),
    });
    const raw = await res.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(raw); } catch { /* non-JSON error body */ }
    if (!res.ok || !j.roomUrl) {
      // Bubble up the exact status + body so the operator can see WHY (e.g. a
      // 401 means the WHEREBY_API_KEY is missing/invalid).
      return jsonResponse(
        { error: "whereby_failed", status: res.status, statusText: res.statusText, body: raw.slice(0, 400) },
        { status: 502, headers: CORS },
      );
    }
    return jsonResponse({ url: j.roomUrl, host_url: j.hostRoomUrl || null }, { headers: CORS });
  } catch (e) {
    return jsonResponse({ error: String(e) }, { status: 500, headers: CORS });
  }
});
