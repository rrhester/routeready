// Shared HTTP/crypto helpers for edge functions (project-review PR#59/60/67).
// Deliberately dependency-free (no supabase-js import) so the unit tests in
// http_test.ts run offline and in CI's `deno test` step.

// ── CORS ─────────────────────────────────────────────────────────────
// One definition instead of the ~37 hand-copied CORS constants that had
// already drifted (different allow-headers lists per function). `extraHeaders`
// covers the odd custom header (x-apply-secret etc.).
export function corsHeaders(extraHeaders = ""): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, authorization, apikey, x-client-info" +
      (extraHeaders ? ", " + extraHeaders : ""),
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
}

// ── Constant-time comparison ─────────────────────────────────────────
// For webhook signatures and shared-secret bearers. `===` short-circuits on
// the first differing byte; this always walks the full length. Length
// differences still return false (they must), but only after a full pass
// over the longer input.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

// ── fetch with a deadline ────────────────────────────────────────────
// Nearly every outbound call (Twilio, Resend, Anthropic, Cal.com, APNs/FCM)
// used bare fetch — one hung upstream stalled a whole queue drain and left
// rows stranded in 'sending'. Default 25s fits inside the edge runtime's
// wall clock while giving slow providers room; pass a smaller value for
// interactive paths.
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 25_000,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Safe JSON parse of a provider response ───────────────────────────
// `await resp.json()` throwing on a non-JSON body (provider 5xx HTML, empty
// body) was a stuck-'sending' cause in the send queues. Never throws.
export async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch (_) {
    return null;
  }
}
