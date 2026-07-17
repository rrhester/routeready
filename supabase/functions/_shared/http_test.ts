// Offline unit tests for _shared/http.ts — run by edge-functions-check's
// `deno test` step (and locally: `deno test supabase/functions/_shared/`).
import { corsHeaders, fetchWithTimeout, safeJson, timingSafeEqual } from "./http.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("assert failed: " + msg);
}

Deno.test("timingSafeEqual: equal strings", () => {
  assert(timingSafeEqual("abc123", "abc123"), "equal should match");
  assert(timingSafeEqual("", ""), "empty strings match");
  const sig = "wXyZ0+/=".repeat(8);
  assert(timingSafeEqual(sig, sig), "base64-ish match");
});

Deno.test("timingSafeEqual: differing strings", () => {
  assert(!timingSafeEqual("abc123", "abc124"), "last-char diff");
  assert(!timingSafeEqual("abc123", "Abc123"), "case diff");
  assert(!timingSafeEqual("abc", "abcd"), "length diff");
  assert(!timingSafeEqual("abcd", "abc"), "length diff reversed");
  assert(!timingSafeEqual("", "a"), "empty vs non-empty");
});

Deno.test("corsHeaders: base + extra headers", () => {
  const base = corsHeaders();
  assert(base["access-control-allow-origin"] === "*", "origin *");
  assert(base["access-control-allow-headers"].includes("authorization"), "auth header allowed");
  const extra = corsHeaders("x-apply-secret");
  assert(extra["access-control-allow-headers"].endsWith(", x-apply-secret"), "extra appended");
});

Deno.test("fetchWithTimeout: aborts a hung request", async () => {
  // A TCP connect to a blackhole address hangs; the timeout must fire.
  const started = Date.now();
  let threw = false;
  try {
    await fetchWithTimeout("http://10.255.255.1:81/", {}, 300);
  } catch (_) {
    threw = true;
  }
  assert(threw, "should throw on timeout");
  assert(Date.now() - started < 5000, "should abort promptly, not hang");
});

Deno.test("safeJson: tolerates non-JSON bodies", async () => {
  const bad = new Response("<html>upstream 502</html>", { status: 502 });
  assert((await safeJson(bad)) === null, "html body -> null");
  const good = new Response(JSON.stringify({ ok: true }));
  const parsed = await safeJson(good) as { ok?: boolean };
  assert(parsed?.ok === true, "json body parses");
});
