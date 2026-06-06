// ai-proxy · central Anthropic proxy so sync boxes never hold an API key.
//
// The desktop agent (on each DSP's box) points the Anthropic SDK at this
// function instead of api.anthropic.com. We:
//   1. Require a valid RouteReady user JWT (the box's paired DSP session) so
//      only our customers can spend the central key.
//   2. Inject RouteReady's ANTHROPIC_API_KEY (a server-side edge secret) and
//      forward the request to Anthropic, returning the response verbatim.
//
// Result: no Anthropic key ever lives on a box, AI is billed centrally on one
// key, and we can later meter/cap usage per DSP here.
//
// Gateway verify_jwt is OFF (see supabase/config.toml) — we validate the JWT
// in-function (matches the repo's other functions) so we control the 401s and
// CORS. Deploy with --no-verify-jwt.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (auto-injected) + ANTHROPIC_API_KEY
// (set once: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-…` or the dashboard).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type, authorization, apikey, x-client-info, x-api-key, anthropic-version, anthropic-beta",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const ANTHROPIC = "https://api.anthropic.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Authorize: must be a real RouteReady user (the box's DSP session).
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return json({ error: "unauthorized" }, 401);
  } catch {
    return json({ error: "unauthorized" }, 401);
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "proxy_no_key", message: "ANTHROPIC_API_KEY is not set on the server." }, 500);

  // 2. Forward to Anthropic. The SDK calls <baseURL>/v1/messages, so the path
  //    after "/ai-proxy" is the real Anthropic path.
  const url = new URL(req.url);
  const i = url.pathname.indexOf("/ai-proxy");
  let sub = i >= 0 ? url.pathname.slice(i + "/ai-proxy".length) : "";
  if (!sub) sub = "/v1/messages";
  const target = ANTHROPIC + sub + url.search;

  const fwd = new Headers();
  fwd.set("content-type", "application/json");
  fwd.set("x-api-key", key);
  fwd.set("anthropic-version", req.headers.get("anthropic-version") || "2023-06-01");
  const beta = req.headers.get("anthropic-beta");
  if (beta) fwd.set("anthropic-beta", beta);

  const body = await req.text();
  let resp: Response;
  try {
    resp = await fetch(target, { method: "POST", headers: fwd, body });
  } catch (e) {
    return json({ error: "upstream_unreachable", message: String((e as Error)?.message || e) }, 502);
  }
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "content-type": resp.headers.get("content-type") || "application/json", ...CORS },
  });
});
