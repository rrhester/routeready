// vin-decode · decode a VIN into normalized vehicle configuration.
//
// Provider abstraction: today it proxies the free public NHTSA vPIC API
// (no key, US-gov). The provider is isolated behind decodeWithProvider() so a
// paid/commercial decoder can be swapped in later without changing callers.
//
// Why a server function (not a direct browser fetch):
//   1. SSRF-safety — the browser never controls the outbound URL. We build a
//      fixed host + path and only interpolate a STRICTLY validated VIN
//      (^[A-HJ-NPR-Z0-9]{17}$, no I/O/Q), so there is no user-controlled URL.
//   2. Central place to add caching / rate limits / a commercial key later.
//   3. Treats the decoder response as untrusted data (parsed, whitelisted
//      fields only — never eval'd, never reflected as HTML).
//
// Auth: the caller's RouteReady user JWT (validated in-function via
// auth.getUser). Gateway verify_jwt is off (see config.toml) so we own the
// 401s + CORS; deploy with --no-verify-jwt.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (auto-injected).
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

// VIN: 17 chars, no I/O/Q (ISO 3779). This is the ONLY user input that reaches
// the outbound URL, and it is constrained to this alphabet — no scheme, host,
// path traversal, or query injection is possible.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

// Allowlisted provider host. Outbound is pinned to this — the request builder
// never accepts a caller-supplied URL.
const NHTSA_HOST = "https://vpic.nhtsa.dot.gov";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ── Auth: validate the caller's RouteReady session ──
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return json({ error: "server_misconfigured" }, 500);
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: ures, error: uerr } = await userClient.auth.getUser(token);
  if (uerr || !ures?.user) return json({ error: "unauthorized" }, 401);

  // ── Input ──
  const body = (await req.json().catch(() => ({}))) as { vin?: string };
  const vin = String(body?.vin || "").toUpperCase().trim();
  if (!VIN_RE.test(vin)) return json({ error: "invalid_vin" }, 400);

  // ── Decode (provider-isolated, timeout-bounded) ──
  try {
    const decoded = await decodeWithProvider(vin);
    return json(decoded, 200);
  } catch (e) {
    console.log("vin_decode_failed", JSON.stringify({ vin_prefix: vin.slice(0, 8), err: String(e).slice(0, 200) }));
    return json({ error: "decode_failed", detail: String(e).slice(0, 200) }, 502);
  }
});

async function decodeWithProvider(vin: string) {
  // Fixed host + path; only the validated VIN is interpolated.
  const target = `${NHTSA_HOST}/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(target, { signal: ctrl.signal, headers: { "user-agent": "RouteReady/parts-vin-decode" } });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error("provider_status_" + res.status);
  const payload = await res.json();
  const r = (payload?.Results && payload.Results[0]) || {};
  const s = (v: unknown) => {
    const t = String(v ?? "").trim();
    return t && t !== "Not Applicable" && t !== "0" ? t : null;
  };
  // Whitelisted, normalized fields only. We NEVER fabricate fitment-critical
  // options (heated/power/BLIS) that a VIN can't reliably reveal — those stay
  // for explicit verification. required_features/connector are left empty so
  // the fitment engine treats them as "unknown", not "matched".
  const config = {
    make: s(r.Make), model: s(r.Model), year: s(r.ModelYear),
    trim: s(r.Trim) || s(r.Series),
    body_class: s(r.BodyClass),
    drive_type: s(r.DriveType),
    engine: [s(r.DisplacementL) ? s(r.DisplacementL) + "L" : null, s(r.EngineCylinders) ? "V" + s(r.EngineCylinders) : null]
      .filter(Boolean).join(" ") || s(r.EngineModel),
    wheelbase: s(r.WheelBaseShort) || s(r.WheelBaseLong) || s(r.WheelBaseInches),
    plant_country: s(r.PlantCountry),
    gvwr: s(r.GVWR),
    required_features: {},
    required_connector: null,
    error_text: s(r.ErrorText),
  };
  return { ok: true, vin, source: "nhtsa_vpic", config };
}
