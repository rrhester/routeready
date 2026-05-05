// send-driver-push · Sends a payloadless Web Push to every active
// subscription for a driver, signed with VAPID. The driver's service
// worker receives the push, fetches the latest chat data using a token
// stashed in IndexedDB at login, and renders the notification + sets
// the home-screen badge. We don't encrypt a payload here — keeping the
// crypto surface to VAPID JWT only — at the cost of one round-trip from
// the SW to fetch fresh state.
//
// Triggered by the AFTER INSERT trigger on driver_messages (only when
// sender_kind = 'dispatch').
//
// Env required:
//   VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point (0x04 || X || Y)
//   VAPID_PRIVATE_KEY  base64url, 32 raw bytes
//   VAPID_SUBJECT      e.g. mailto:support@gorouteready.com
//
// POST body: { driver_id: uuid, message_id?: uuid }
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";


// ── base64url helpers ──────────────────────────────────────────────────
function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function bytesToB64url(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}


// ── VAPID JWT signing ──────────────────────────────────────────────────
async function importVapidPrivateKey(privateRawB64url: string, publicRawB64url: string): Promise<CryptoKey> {
  const priv = b64urlToBytes(privateRawB64url);
  const pub  = b64urlToBytes(publicRawB64url);
  // Public key is uncompressed: 0x04 || X(32) || Y(32). Strip the 0x04 prefix.
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be 65 bytes uncompressed (0x04 || X || Y)");
  }
  if (priv.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY must be 32 raw bytes");
  }
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: bytesToB64url(priv),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

async function makeVapidJwt(audience: string, subject: string, key: CryptoKey): Promise<string> {
  const header  = strToB64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = strToB64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig  = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  // WebCrypto already returns raw r||s for ECDSA — that's the JWS format.
  return `${header}.${payload}.${bytesToB64url(sig)}`;
}


// ── Edge handler ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !VAPID_SUBJECT) {
    return badRequest("vapid_secrets_missing", 500);
  }

  const body = await req.json().catch(() => ({}));
  const driverId = body?.driver_id;
  if (!driverId) return badRequest("driver_id_required");

  const supa = serviceClient();
  const { data: subs, error } = await supa
    .from("driver_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("driver_id", driverId);
  if (error) return badRequest(error.message, 500);
  if (!subs || subs.length === 0) return jsonResponse({ sent: 0, total: 0 });

  let privateKey: CryptoKey;
  try {
    privateKey = await importVapidPrivateKey(VAPID_PRIVATE, VAPID_PUBLIC);
  } catch (err) {
    return badRequest(`vapid_key_invalid: ${(err as Error).message}`, 500);
  }

  let sent = 0, failed = 0, removed = 0;

  for (const sub of subs) {
    let url: URL;
    try { url = new URL(sub.endpoint); } catch { failed++; continue; }
    const audience = `${url.protocol}//${url.host}`;

    let resp: Response;
    try {
      const jwt = await makeVapidJwt(audience, VAPID_SUBJECT, privateKey);
      resp = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
          "TTL": "60",
          "Urgency": "high",
          "Content-Length": "0",
        },
      });
    } catch (err) {
      failed++;
      await supa.from("driver_push_subscriptions")
        .update({ last_failed_at: new Date().toISOString() })
        .eq("endpoint", sub.endpoint);
      continue;
    }

    if (resp.status >= 200 && resp.status < 300) {
      sent++;
      await supa.from("driver_push_subscriptions")
        .update({
          last_used_at:   new Date().toISOString(),
          last_failed_at: null,
          failure_count:  0,
        })
        .eq("endpoint", sub.endpoint);
    } else if (resp.status === 404 || resp.status === 410) {
      // Subscription is gone — clean up.
      await supa.from("driver_push_subscriptions")
        .delete()
        .eq("endpoint", sub.endpoint);
      removed++;
    } else {
      failed++;
      await supa.from("driver_push_subscriptions")
        .update({ last_failed_at: new Date().toISOString() })
        .eq("endpoint", sub.endpoint);
    }
  }

  return jsonResponse({ sent, failed, removed, total: subs.length });
});
