// meet-turn-driver · Mints short-lived Cloudflare Realtime TURN credentials
// for a DRIVER joining a Meet room (radio or a 1:1 call).
//
// Why a separate function from meet-turn-credentials: that one is JWT-gated so
// only authenticated staff can burn the relay quota. Drivers aren't Supabase-
// authenticated — they carry an opaque session token — so they open Meet as
// anonymous guests and could never obtain a relay. Without TURN, a driver on
// cellular / carrier-NAT can't punch a direct path and the call never connects
// (black tiles, "can't join the radio"). This endpoint is anon-callable
// (deploy WITHOUT --no-verify-jwt is NOT set here; deploy WITH --no-verify-jwt)
// but gated by a valid driver token, so the quota is just as protected.
//
// Body (JSON): { token: <driver session token> }
//
// Secrets (shared with meet-turn-credentials):
//   CF_TURN_KEY_ID     · the TURN key's ID from the Cloudflare dashboard
//   CF_TURN_API_TOKEN  · that key's API token
//
// Returns { ok:false } (never a hard error) when unconfigured or the token is
// bad, so Meet degrades gracefully to STUN + the default relay.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-client-info, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
};
const respond = (body: unknown, status = 200) =>
  jsonResponse(body, { status, headers: CORS });

const TURN_TTL_SECONDS = 24 * 60 * 60; // 24h — comfortably longer than a call

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  let token = "";
  try { token = String((await req.json())?.token ?? ""); } catch { /* ignore */ }
  if (!token) return respond({ ok: false, reason: "token_required" });

  // Validate the driver's session token via the same RPC the app uses.
  const supa = serviceClient();
  const { data: me, error: meErr } = await supa.rpc("driver_me", { p_token: token });
  if (meErr || !me?.id) return respond({ ok: false, reason: "invalid_or_expired_token" });

  const keyId = Deno.env.get("CF_TURN_KEY_ID");
  const apiToken = Deno.env.get("CF_TURN_API_TOKEN");
  if (!keyId || !apiToken) return respond({ ok: false, reason: "not_configured" });

  return respond(await mintCloudflareTurn(keyId, apiToken));
});

// Mint short-lived Cloudflare TURN credentials. Tries the current documented
// endpoint (/credentials/generate-ice-servers → { iceServers: [STUN, TURN] })
// first, falling back to the legacy /credentials/generate (→ { iceServers: {…} })
// only on a 404. Kept in sync with meet-turn-credentials (edge functions bundle
// separately, so it can't be shared without importing the other's Deno.serve).
async function mintCloudflareTurn(keyId: string, token: string) {
  const paths = ["generate-ice-servers", "generate"];
  let lastStatus = 0;
  for (const path of paths) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/${path}`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        },
      );
      if (res.status === 404) { lastStatus = 404; continue; }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`cf turn (driver) ${path} failed status=${res.status} body=${body.slice(0, 300)}`);
        return { ok: false, reason: "cf_error", status: res.status };
      }
      const data = await res.json();
      const ice = data?.iceServers;
      if (!ice) return { ok: false, reason: "no_ice" };
      const list = Array.isArray(ice) ? ice : [ice];
      return { ok: true, ice_servers: list };
    } catch (err) {
      console.warn(`cf turn (driver) ${path} exception:`, String(err));
      return { ok: false, reason: "exception" };
    }
  }
  return { ok: false, reason: "cf_error", status: lastStatus };
}
