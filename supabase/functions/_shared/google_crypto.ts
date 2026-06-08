// AES-GCM encrypt/decrypt for OAuth tokens at rest, plus stateless signed
// OAuth `state`. The encryption key lives only in the edge runtime
// (GOOGLE_TOKEN_ENC_KEY, base64 32 bytes) so ciphertext in the DB is useless
// on its own.

function keyBytes(): Uint8Array {
  const b64 = Deno.env.get("GOOGLE_TOKEN_ENC_KEY");
  if (!b64) throw new Error("GOOGLE_TOKEN_ENC_KEY not set");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("GOOGLE_TOKEN_ENC_KEY must be 32 bytes (base64)");
  return raw;
}
async function aesKey() {
  return crypto.subtle.importKey("raw", keyBytes(), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(plain: string): Promise<{ ct: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), data));
  return { ct: b64(ct), iv: b64(iv) };
}
export async function decryptSecret(ctB64: string, ivB64: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(ivB64) }, await aesKey(), unb64(ctB64),
  );
  return new TextDecoder().decode(pt);
}

// Stateless, signed OAuth state (CSRF + binds the connection to a dsp/user).
export async function signState(payload: Record<string, unknown>): Promise<string> {
  const secret = Deno.env.get("OAUTH_STATE_SECRET") || "";
  const body = b64(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64(sig)}`;
}
export async function verifyState(state: string): Promise<Record<string, unknown> | null> {
  const secret = Deno.env.get("OAUTH_STATE_SECRET") || "";
  const [body, sig] = (state || "").split(".");
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", key, unb64(sig), new TextEncoder().encode(body)); }
  catch { return null; }
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(unb64(body)));
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}
