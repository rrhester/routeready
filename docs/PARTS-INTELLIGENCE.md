# Parts Intelligence

A native Fleet feature for finding, verifying, comparing, and purchasing
replacement van parts across approved suppliers. It lives as a **Parts sub-tab
inside the Fleet page** (`#view-fleet2`) — no new top-level navigation.

## Where things live

| Concern | Location |
|---|---|
| Schema + RLS + RPCs | `supabase/migrations/0485_parts_intelligence.sql` |
| VIN decode (NHTSA vPIC proxy) | `supabase/functions/vin-decode/index.ts` (`config.toml` verify_jwt=false) |
| Decision math (pure, tested) | `dashboard/parts/parts-engine.js` |
| Supplier-adapter framework | `dashboard/parts/adapters/{base,manual,nhtsa,index}.js` |
| Fleet "Parts" tab UI | `dashboard/parts/parts-ui.js` (registers `window.RRParts`) |
| Tab wiring | `dashboard/views/view-fleet2.frag` + `dashboard/live.js` (`fleetSub('parts')`) |
| Tests | `scripts/test-parts-engine.mjs`, `scripts/test-parts-adapters.mjs` (in `npm test`) |
| Fixtures | `tests/fixtures/parts/{vehicles,parts,offers}.json` |

## Data model (all `dsp_id`-scoped, staff RLS, `security definer` RPCs)

`canonical_parts` · `supplier_sources` · `supplier_offers` · `price_observations`
· `vehicle_part_compatibility` · `part_searches` · `part_watchlists`
· `part_purchases` · `supplier_performance`. Money is stored in integer cents.
Purchases link to `vehicle_issues` / `repair_orders`. Supplier credentials are
**never** stored — a source names its edge secret in `auth_ref`.

## Fitment confidence (the most important part)

`scoreFitment(signals)` returns one of **exact / high / likely / verify /
incompatible** with a reason list. Hard rules:

- **Never Exact** without VIN-level OEM part-number evidence or a manual
  RouteReady verification.
- Year/make/model agreement alone can never exceed **Likely**.
- A required-attribute conflict (wrong connector, missing required feature)
  forces **Incompatible** regardless of all other evidence.
- Manual overrides win and are audit-logged (`parts_compat_override`).

AI may populate signals but must never assert a level.

## Ranking

`rankOffers(offers, {weights, oemPreference})` produces a 0–1 weighted score
over fitment / landed cost / delivery / availability / seller / warranty /
return, and awards recommendation labels (Best overall, Lowest landed, Fastest,
Best OEM, Best aftermarket, Lowest risk) — each with a shown rationale.
Incompatible offers are never recommended but are never discarded.

## Supplier adapters

Uniform contract in `adapters/base.js` with per-adapter rate limiting, retry +
exponential backoff, timeout, and a circuit breaker, so one supplier's failure
is isolated and never fails the whole search. New API/crawler adapters register
in `adapters/index.js` **only after** approved credentials + a completed terms
review. Crawling reuses the existing `crawl_tasks` + `box-ingest` framework — no
new browser automation, no anti-bot/paywall bypass.

## MVP status

Shipped: schema, engines (tested), Parts tab UI, manual-entry connector, NHTSA
VIN decode, fitment/landed/ranking, watchlist, purchases, Workbook/CSV export,
supplier health admin. Deferred: live API/crawler connectors (need credentials),
image-assisted part ID, price-alert delivery, supplier analytics.

## Connecting live suppliers

Real parts catalogs (eBay, RockAuto, Amazon, distributor feeds) require a key,
affiliate approval, or a business account — none return live data anonymously,
and RouteReady never scrapes or bypasses access controls. Live search runs
server-side in the `parts-search` edge function, which fans out to whichever
providers have credentials set and normalizes results into the offer shape; the
browser scores fitment and persists each offer. A provider failure never fails
the whole search (partial results are returned).

**One central account serves every DSP.** Provider keys are Supabase **edge
secrets** (platform-level, server-side) — the same model as `ai-proxy`'s central
Anthropic key. You set them once; every tenant's Parts tab can search. Each DSP
only toggles a source on/off in their own **Sources & health** panel; the
credential underneath is shared. There is no per-DSP supplier account.

### eBay (implemented — free developer account)
1. Create a free eBay developer account → an app → get the **production**
   Client ID + Client Secret (App ID / Cert ID).
2. Set them as edge secrets (once, for all DSPs):
   `supabase secrets set EBAY_CLIENT_ID=… EBAY_CLIENT_SECRET=…`
   (optional `EBAY_MARKETPLACE_ID`, default `EBAY_US`).
3. Deploy the function: `supabase functions deploy parts-search --no-verify-jwt`.
4. In the Parts tab → **Sources & health**, toggle **eBay Motors** on.
Now "Search parts" returns live eBay listings (price, shipping, condition,
seller rating) into the comparison table. Watch eBay's per-app daily call limit;
`supplier_sources.rate_limit_per_min` + persisted `price_observations` support
caching/freshness windows to stay under it. Usage is governed by eBay's API
License Agreement — confirm your platform use case is within its terms.

### Adding more providers
Drop another entry in `PROVIDERS` in `supabase/functions/parts-search/index.ts`
(a pure fetch+normalize unit) with its own edge secret. Candidates: Amazon
PA-API (needs affiliate approval), a distributor JSON/CSV feed (Keystone,
Turn14, Meyer — account holders get a feed URL). The core engine and UI never
hardcode a supplier.

## Operational notes

- **Migration 0485 must be applied** (Supabase SQL Editor) before the tab can
  load data; it is idempotent. CI `migration-check` validates it from scratch.
- **VIN decode needs no deploy.** "Decode VIN" (Parts search bar) calls the free
  public NHTSA vPIC database directly from the browser (keyless, CORS-enabled).
  The `vin-decode` edge function is an optional server-side fallback — deploy it
  (`supabase functions deploy vin-decode --no-verify-jwt`) only if you want the
  decode proxied server-side.
