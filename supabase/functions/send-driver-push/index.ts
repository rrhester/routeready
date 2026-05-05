// send-driver-push · Sends an encrypted Web Push to every active
// subscription for a driver, signed with VAPID. The payload is
// encrypted per RFC 8291 (aes128gcm) so iOS Safari delivers it
// reliably — payloadless pushes look "delivered" at the APNs layer
// but the SW never fires on iOS PWAs.
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
function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.byteLength; }
  return out;
}


// ── VAPID JWT signing (RFC 8292) ───────────────────────────────────────
async function importVapidPrivateKey(privateRawB64url: string, publicRawB64url: string): Promise<CryptoKey> {
  const priv = b64urlToBytes(privateRawB64url);
  const pub  = b64urlToBytes(publicRawB64url);
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
  return `${header}.${payload}.${bytesToB64url(sig)}`;
}


// ── Web Push payload encryption (RFC 8291 · aes128gcm) ─────────────────
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function encryptWebPushPayload(
  plaintext: Uint8Array,
  recipientP256dh: Uint8Array, // 65 bytes uncompressed
  recipientAuth: Uint8Array,   // 16 bytes
): Promise<Uint8Array> {
  // 1. Ephemeral sender keypair
  const senderKp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const senderPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", senderKp.publicKey));

  // 2. ECDH shared secret with recipient public key
  const recipientPubKey = await crypto.subtle.importKey(
    "raw", recipientP256dh, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPubKey }, senderKp.privateKey, 256,
  ));

  // 3. Random salt (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 4. HKDF cascade per RFC 8291 §3.4
  const prkKey = await hmacSha256(recipientAuth, ecdh);
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\0"),
    recipientP256dh,
    senderPubRaw,
  );
  const ikm = await hmacSha256(prkKey, concat(keyInfo, new Uint8Array([0x01])));

  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(
    prk, concat(new TextEncoder().encode("Content-Encoding: aes128gcm\0"), new Uint8Array([0x01])),
  )).slice(0, 16);
  const nonce = (await hmacSha256(
    prk, concat(new TextEncoder().encode("Content-Encoding: nonce\0"), new Uint8Array([0x01])),
  )).slice(0, 12);

  // 5. AES-128-GCM encrypt: plaintext || 0x02 (last-record delimiter, RFC 8188)
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded,
  ));

  // 6. Build aes128gcm body: salt(16) | rs(4 BE) | idlen(1) | sender_pub(idlen) | ciphertext
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false);
  return concat(
    salt,
    rsBytes,
    new Uint8Array([senderPubRaw.byteLength]),
    senderPubRaw,
    ciphertext,
  );
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
  const driverId: string | undefined = body?.driver_id;
  const messageId: string | undefined = body?.message_id;
  if (!driverId) return badRequest("driver_id_required");

  const supa = serviceClient();

  // Subscriptions for this driver
  const { data: subs, error: subsErr } = await supa
    .from("driver_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("driver_id", driverId);
  if (subsErr) return badRequest(subsErr.message, 500);
  if (!subs || subs.length === 0) return jsonResponse({ sent: 0, total: 0 });

  // Build the notification payload from the triggering message + unread count.
  let title  = "Dispatch";
  let bodyText = "New message from dispatch";

  if (messageId) {
    const { data: msg } = await supa
      .from("driver_messages")
      .select("body")
      .eq("id", messageId)
      .single();
    if (msg?.body) {
      const txt = String(msg.body);
      bodyText = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
    }
  }

  // Unread count = dispatch messages newer than the driver's last_read.
  const { data: conv } = await supa
    .from("driver_conversations")
    .select("driver_last_read_at")
    .eq("driver_id", driverId)
    .maybeSingle();
  let unreadQuery = supa.from("driver_messages")
    .select("id", { count: "exact", head: true })
    .eq("driver_id", driverId)
    .eq("sender_kind", "dispatch");
  if (conv?.driver_last_read_at) {
    unreadQuery = unreadQuery.gt("created_at", conv.driver_last_read_at);
  }
  const { count: unreadCount } = await unreadQuery;
  const unread = unreadCount ?? 1;

  const plaintext = new TextEncoder().encode(JSON.stringify({
    title, body: bodyText, unread, url: "/app/#/chat",
  }));

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

      const recipientPub  = b64urlToBytes(sub.p256dh);
      const recipientAuth = b64urlToBytes(sub.auth);
      const cipherBody = await encryptWebPushPayload(plaintext, recipientPub, recipientAuth);

      resp = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Authorization":     `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
          "Content-Encoding":  "aes128gcm",
          "Content-Type":      "application/octet-stream",
          "TTL":               "60",
          "Urgency":           "high",
        },
        body: cipherBody,
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
