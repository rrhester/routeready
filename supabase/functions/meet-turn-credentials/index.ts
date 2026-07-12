// meet-turn-credentials · Mints short-lived Cloudflare Realtime TURN
// credentials so Meet calls connect on hostile networks (strict NAT / VPN /
// corporate Wi-Fi) where a direct peer-to-peer path can't be punched.
//
// Cloudflare hands out ephemeral credentials (they expire), so they can't be
// pasted statically into app_settings like a coturn/Metered relay — this
// function generates a fresh set per join and Meet merges them on top of the
// STUN + default-relay list from meet_ice_servers.
//
// JWT-gated (deployed WITHOUT --no-verify-jwt): only an authenticated
// RouteReady user can mint credentials, so the relay quota can't be burned by
// anonymous callers. Anon interview guests fall back to the default relay.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   CF_TURN_KEY_ID     · the TURN key's ID from the Cloudflare dashboard
//   CF_TURN_API_TOKEN  · that key's API token
//
// Returns { ok:false } (never an error) when unconfigured, so Meet degrades
// gracefully to the existing STUN + Open Relay default.
import { jsonResponse, badRequest } from "../_shared/supabase.ts";

const TURN_TTL_SECONDS = 24 * 60 * 60; // 24h — comfortably longer than a call

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const keyId = Deno.env.get("CF_TURN_KEY_ID");
  const token = Deno.env.get("CF_TURN_API_TOKEN");
  if (!keyId || !token) return jsonResponse({ ok: false, reason: "not_configured" });

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`cf turn generate failed status=${res.status} body=${body.slice(0, 300)}`);
      return jsonResponse({ ok: false, reason: "cf_error", status: res.status });
    }
    const data = await res.json();
    // Cloudflare returns { iceServers: { urls:[...], username, credential } }.
    const ice = data?.iceServers;
    if (!ice) return jsonResponse({ ok: false, reason: "no_ice" });
    const list = Array.isArray(ice) ? ice : [ice];
    return jsonResponse({ ok: true, ice_servers: list });
  } catch (err) {
    console.warn("cf turn exception:", String(err));
    return jsonResponse({ ok: false, reason: "exception" });
  }
});
