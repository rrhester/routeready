// Verifies a Cloudflare Turnstile token for the public booking page
// (calendar 100-list #86) and mints the short-lived HMAC proof that
// book_interview_slot demands when the governing schedule sets
// require_captcha. Config-gated: without TURNSTILE_SECRET_KEY this returns
// 501 and the whole CAPTCHA layer stays off.
//
// POST { token: <applicant booking token>, captcha_token: <turnstile token> }
//   → { ok: true, proof: "<exp>.<hmac>" }
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return jsonResponse({ error: "not_configured" }, { status: 501, headers: CORS });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* fall through */ }
  const token = String(body.token || "");
  const captchaToken = String(body.captcha_token || "");
  if (!token || !captchaToken) return jsonResponse({ error: "token_and_captcha_required" }, { status: 400, headers: CORS });

  const form = new FormData();
  form.set("secret", secret);
  form.set("response", captchaToken);
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0];
  if (ip) form.set("remoteip", ip.trim());

  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", body: form,
  }).then((r) => r.json()).catch(() => ({ success: false }));
  if (!verify?.success) {
    return jsonResponse({ ok: false, error: "captcha_failed" }, { status: 400, headers: CORS });
  }

  const supa = serviceClient();
  const { data: proof, error } = await supa.rpc("captcha_mint", { p_token: token });
  if (error || !proof) {
    const msg = String(error?.message || "mint_failed");
    const status = /invalid_or_expired/i.test(msg) ? 404 : 500;
    return jsonResponse({ ok: false, error: msg }, { status, headers: CORS });
  }
  return jsonResponse({ ok: true, proof }, { headers: CORS });
});
