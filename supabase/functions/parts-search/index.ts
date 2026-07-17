// parts-search · live supplier search proxy for Parts Intelligence.
//
// Real parts APIs need a secret key AND block browser calls (CORS), so the
// search runs here, server-side. Keys live in Supabase edge secrets — never in
// the browser or the database. The function fans out to whichever providers
// have credentials configured, normalizes each provider's results into the
// RouteReady offer shape, and returns them; the browser then scores fitment
// (with the vehicle context it holds) and persists via parts_offer_save.
//
// Providers implemented:
//   · ebay  — eBay Browse API (official, free developer account).
//             Env: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET  [+ optional EBAY_MARKETPLACE_ID]
// Add more providers by dropping another entry in PROVIDERS below (each is a
// pure fetch+normalize unit) and giving it its own secret — the core never
// hardcodes a supplier.
//
// Safety: only fixed, hardcoded provider hosts are ever contacted (no
// user-supplied URLs → no SSRF). All provider text is untrusted — returned
// verbatim as data, never executed. Caller JWT is validated in-function;
// gateway verify_jwt is off (config.toml). Deploy with --no-verify-jwt.
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Validate the caller's RouteReady session.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return json({ error: "server_misconfigured" }, 500);
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: ures, error: uerr } = await userClient.auth.getUser(token);
  if (uerr || !ures?.user) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as {
    query?: string; part_number?: string; limit?: number; sources?: string[];
  };
  const term = String(body.part_number || body.query || "").trim().slice(0, 120);
  if (!term) return json({ error: "query_required" }, 400);
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const want = Array.isArray(body.sources) && body.sources.length ? new Set(body.sources) : null;

  const offers: unknown[] = [];
  const source_status: Record<string, unknown> = {};

  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (want && !want.has(key)) continue;
    const started = Date.now();
    try {
      const res = await provider(term, limit);
      if (res.status === "ok") offers.push(...res.offers.map((o) => ({ ...o, provider: key })));
      source_status[key] = { ...res, ms: Date.now() - started, offers: undefined };
    } catch (e) {
      source_status[key] = { status: "error", error: String(e).slice(0, 160), ms: Date.now() - started };
    }
  }

  return json({ offers, source_status });
});

// ── Provider registry ──────────────────────────────────────────────────
type ProviderResult =
  | { status: "ok"; offers: Record<string, unknown>[]; count: number }
  | { status: "no_credentials" | "empty"; count?: number };

const PROVIDERS: Record<string, (term: string, limit: number) => Promise<ProviderResult>> = {
  ebay: ebaySearch,
};

// ── eBay Browse API ────────────────────────────────────────────────────
let _ebayToken: { value: string; exp: number } | null = null;

async function ebayToken(): Promise<string | null> {
  const id = Deno.env.get("EBAY_CLIENT_ID"), secret = Deno.env.get("EBAY_CLIENT_SECRET");
  if (!id || !secret) return null;
  const now = Date.now();
  if (_ebayToken && _ebayToken.exp > now + 60_000) return _ebayToken.value;
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${id}:${secret}`),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("ebay_oauth_" + res.status);
  const j = await res.json();
  _ebayToken = { value: j.access_token, exp: now + (Number(j.expires_in) || 7200) * 1000 };
  return _ebayToken.value;
}

async function ebaySearch(term: string, limit: number): Promise<ProviderResult> {
  const tok = await ebayToken();
  if (!tok) return { status: "no_credentials" };
  const mkt = Deno.env.get("EBAY_MARKETPLACE_ID") || "EBAY_US";
  // category_ids 6030 = eBay Motors › Parts & Accessories › Car & Truck Parts.
  const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  u.searchParams.set("q", term);
  u.searchParams.set("category_ids", "6030");
  u.searchParams.set("limit", String(limit));
  const res = await fetch(u.toString(), {
    headers: { authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": mkt },
  });
  if (!res.ok) throw new Error("ebay_search_" + res.status);
  const j = await res.json();
  const items = Array.isArray(j.itemSummaries) ? j.itemSummaries : [];
  const offers = items.map(normalizeEbayItem);
  return offers.length ? { status: "ok", offers, count: offers.length } : { status: "empty", count: 0 };
}

const toCents = (v: unknown) => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
function mapEbayCondition(c: string): string {
  const s = (c || "").toLowerCase();
  if (/certified|refurb- ?ished|refurbished|renewed/.test(s)) return "refurbished";
  if (/remanufactured|rebuilt/.test(s)) return "remanufactured";
  if (/new old stock|nos/.test(s)) return "nos";
  if (/for parts|not working/.test(s)) return "used";
  if (/used|pre-owned|seller refurbished/.test(s)) return "used";
  if (/new/.test(s)) return "new";
  return "unknown";
}
function normalizeEbayItem(it: Record<string, any>): Record<string, unknown> {
  const price = it?.price?.value;
  const ship = it?.shippingOptions?.[0]?.shippingCost?.value;
  const fb = parseFloat(String(it?.seller?.feedbackPercentage ?? ""));
  return {
    seller_name: it?.seller?.username || "eBay seller",
    seller_part_number: it?.mpn || null,
    product_title: String(it?.title || "").slice(0, 300), // factual title only
    product_url: it?.itemWebUrl || null,
    condition: mapEbayCondition(it?.condition || ""),
    is_oem: /\boem\b|genuine/i.test(String(it?.title || "")),
    price_cents: toCents(price),
    shipping_cents: ship != null ? toCents(ship) : null,
    availability: "in_stock",
    seller_rating: Number.isFinite(fb) ? Math.round((fb / 100) * 5 * 10) / 10 : null,
    raw_source_id: it?.itemId || null,
    currency: it?.price?.currency || "USD",
  };
}
