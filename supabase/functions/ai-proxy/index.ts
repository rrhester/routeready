// ai-proxy · central Anthropic proxy so sync boxes never hold an API key.
//
// The desktop agent (on each DSP's box) points the Anthropic SDK at this
// function instead of api.anthropic.com. We:
//   1. Require a valid RouteReady user JWT that maps to an ACTIVE app_users
//      row, and resolve that member's dsp_id — only paying tenants spend the
//      central key, and every request is attributed to a DSP.
//   2. Enforce a path + model allow-list (Claude models on the Messages API
//      only) so the proxy can't be turned into an open relay for arbitrary
//      Anthropic endpoints or non-Claude spend.
//   3. Check + increment a per-DSP daily request cap (0469) before forwarding;
//      over-cap tenants get a 429.
//   4. Inject RouteReady's ANTHROPIC_API_KEY (a server-side edge secret),
//      forward, return the response verbatim, and best-effort record token
//      usage for the tenant.
//
// Result: no Anthropic key ever lives on a box, AI is billed centrally on one
// key, and usage is metered + capped per DSP.
//
// Gateway verify_jwt is OFF (see supabase/config.toml) — we validate the JWT
// in-function (matches the repo's other functions) so we control the 401s and
// CORS. Deploy with --no-verify-jwt.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
// + ANTHROPIC_API_KEY (set once via `supabase secrets set …`).
// Optional: AI_PROXY_DAILY_CAP (default 5000 requests/DSP/day).
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type, authorization, apikey, x-client-info, x-api-key, anthropic-version, anthropic-beta",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const ANTHROPIC = "https://api.anthropic.com";

// Only the Messages API (and its token counter) may be proxied — not the
// whole Anthropic surface. Keeps this from becoming an open relay.
const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const DEFAULT_DAILY_CAP = Number(Deno.env.get("AI_PROXY_DAILY_CAP") || "5000");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Authorize: the caller must be a real RouteReady user…
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);

  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  let dspId: string;
  try {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data?.user) return json({ error: "unauthorized" }, 401);
    // …who maps to an ACTIVE app_users row. Attribute spend to their DSP.
    const { data: au } = await svc
      .from("app_users")
      .select("dsp_id, active")
      .eq("id", data.user.id)
      .maybeSingle();
    if (!au || au.active !== true || !au.dsp_id) {
      return json({ error: "forbidden", message: "Not an active RouteReady member." }, 403);
    }
    dspId = au.dsp_id as string;
  } catch {
    return json({ error: "unauthorized" }, 401);
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "proxy_no_key", message: "ANTHROPIC_API_KEY is not set on the server." }, 500);

  // 2. Resolve + allow-list the target path. The SDK calls <baseURL>/v1/messages,
  //    so the path after "/ai-proxy" is the real Anthropic path.
  const url = new URL(req.url);
  const i = url.pathname.indexOf("/ai-proxy");
  let sub = i >= 0 ? url.pathname.slice(i + "/ai-proxy".length) : "";
  if (!sub) sub = "/v1/messages";
  if (!ALLOWED_PATHS.has(sub)) {
    return json({ error: "path_not_allowed", message: `Only ${[...ALLOWED_PATHS].join(", ")} may be proxied.` }, 403);
  }

  // Read the body once (forwarded verbatim) and validate the model.
  const body = await req.text();
  let parsed: { model?: unknown; stream?: unknown } = {};
  try { parsed = JSON.parse(body || "{}"); } catch { return json({ error: "invalid_json" }, 400); }
  const model = typeof parsed.model === "string" ? parsed.model : "";
  if (!model.startsWith("claude-")) {
    return json({ error: "model_not_allowed", message: "Only Claude models may be proxied." }, 400);
  }

  // 3. Per-DSP daily cap (atomic increment + check in the DB).
  try {
    const { data: quota, error: qErr } = await svc.rpc("ai_proxy_note_request", {
      p_dsp_id: dspId,
      p_default_cap: DEFAULT_DAILY_CAP,
    });
    if (!qErr && quota && quota.allowed === false) {
      return json({
        error: "rate_limited",
        message: `Daily AI request cap reached (${quota.cap}). Resets at midnight UTC.`,
      }, 429);
    }
    // A metering error must not hard-fail the proxy — log and proceed.
    if (qErr) console.error("ai_proxy_note_request error:", qErr.message);
  } catch (e) {
    console.error("ai_proxy_note_request threw:", (e as Error)?.message);
  }

  // 4. Forward to Anthropic.
  const target = ANTHROPIC + sub + url.search;
  const fwd = new Headers();
  fwd.set("content-type", "application/json");
  fwd.set("x-api-key", key);
  fwd.set("anthropic-version", req.headers.get("anthropic-version") || "2023-06-01");
  const beta = req.headers.get("anthropic-beta");
  if (beta) fwd.set("anthropic-beta", beta);

  let resp: Response;
  try {
    resp = await fetch(target, { method: "POST", headers: fwd, body });
  } catch (e) {
    return json({ error: "upstream_unreachable", message: String((e as Error)?.message || e) }, 502);
  }
  const text = await resp.text();

  // Best-effort token accounting for non-streaming JSON responses. Streaming
  // (SSE) responses carry usage across events; we skip those (request count
  // still meters them). Never let accounting failures affect the response.
  if (resp.ok && parsed.stream !== true) {
    try {
      const j = JSON.parse(text);
      const inTok = Number(j?.usage?.input_tokens ?? 0);
      const outTok = Number(j?.usage?.output_tokens ?? 0);
      if (inTok || outTok) {
        await svc.rpc("ai_proxy_note_tokens", { p_dsp_id: dspId, p_input: inTok, p_output: outTok });
      }
    } catch { /* not JSON / no usage — ignore */ }
  }

  return new Response(text, {
    status: resp.status,
    headers: { "content-type": resp.headers.get("content-type") || "application/json", ...CORS },
  });
});
