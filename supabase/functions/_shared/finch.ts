// Finch (https://tryfinch.com) — unified employment API. RouteReady connects a
// DSP's payroll/HRIS provider (ADP Workforce Now / ADP Run, etc.) THROUGH Finch,
// so RouteReady never touches ADP's mTLS / partner credentialing — Finch owns
// that. Our side is a normal OAuth-style code→token exchange that runs fine in a
// Supabase edge function. Token encryption + signed OAuth state are reused from
// the Google integration so no new crypto secrets are required.
export { encryptSecret, decryptSecret, signState, verifyState } from "./google_crypto.ts";

const FINCH_API = "https://api.tryfinch.com";
const FINCH_CONNECT = "https://connect.tryfinch.com";

// Products RouteReady requests from Finch — the HRIS roster a DSP needs to keep
// drivers in sync. (PTO/time-off is a separate, provider-dependent product and
// can be added later once the core sync is proven.)
const PRODUCTS = "company directory individual employment";

export function apiVersion(): string {
  return Deno.env.get("FINCH_API_VERSION") || "2020-09-17";
}

function clientId(): string {
  const v = Deno.env.get("FINCH_CLIENT_ID");
  if (!v) throw new Error("finch_not_configured");
  return v;
}
function clientSecret(): string {
  const v = Deno.env.get("FINCH_CLIENT_SECRET");
  if (!v) throw new Error("finch_not_configured");
  return v;
}
function redirectUri(): string {
  const v = Deno.env.get("FINCH_REDIRECT_URI");
  if (!v) throw new Error("finch_not_configured");
  return v;
}

// True once the Finch app credentials are present in the edge env. The UI uses
// this to show an honest "not set up yet" state instead of a hard error.
export function isConfigured(): boolean {
  return !!(Deno.env.get("FINCH_CLIENT_ID") && Deno.env.get("FINCH_CLIENT_SECRET") && Deno.env.get("FINCH_REDIRECT_URI"));
}

// Finch Connect authorize URL (redirect flow). After the DSP authorizes their
// ADP account, Finch redirects to FINCH_REDIRECT_URI with ?code & ?state.
export function connectUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    products: PRODUCTS,
    redirect_uri: redirectUri(),
    state,
  });
  // Optional sandbox: set FINCH_SANDBOX=finch (Finch-simulated) or =provider.
  const sandbox = Deno.env.get("FINCH_SANDBOX");
  if (sandbox) params.set("sandbox", sandbox);
  return `${FINCH_CONNECT}/authorize?${params.toString()}`;
}

function authHeaders(token: string): HeadersInit {
  return {
    "authorization": `Bearer ${token}`,
    "Finch-API-Version": apiVersion(),
    "content-type": "application/json",
  };
}

// Exchange the Connect authorization code for a (long-lived) access token.
export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(`${FINCH_API}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error("token_exchange_failed: " + (body.message || body.error || res.status));
  }
  return body.access_token as string;
}

// /introspect → identify the connected account (provider, company, account ids).
export async function introspect(token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${FINCH_API}/introspect`, { headers: authHeaders(token) });
  if (!res.ok) return {};
  return await res.json().catch(() => ({}));
}

export interface FinchIndividual {
  id: string;
  first_name?: string;
  last_name?: string;
  department?: { name?: string } | null;
  manager?: { id?: string } | null;
  is_active?: boolean;
}

// /employer/directory → the lightweight roster (ids + names + active flag).
export async function getDirectory(token: string): Promise<FinchIndividual[]> {
  const out: FinchIndividual[] = [];
  // Directory is paged (250/page). Walk until a short page.
  for (let offset = 0; offset < 50_000; offset += 250) {
    const res = await fetch(`${FINCH_API}/employer/directory?limit=250&offset=${offset}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) throw new Error("directory_failed: " + res.status);
    const body = await res.json().catch(() => ({}));
    const page: FinchIndividual[] = body.individuals || [];
    out.push(...page);
    if (page.length < 250) break;
  }
  return out;
}

// /employer/employment (batch) → title, department, manager, status, start date.
export async function getEmployment(token: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  // Finch caps batch size; chunk to be safe.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await fetch(`${FINCH_API}/employer/employment`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ requests: chunk.map((individual_id) => ({ individual_id })) }),
    });
    if (!res.ok) continue; // employment is best-effort enrichment; skip a bad chunk
    const body = await res.json().catch(() => ({}));
    for (const r of (body.responses || [])) {
      if (r.individual_id && r.body) map.set(r.individual_id, r.body);
    }
  }
  return map;
}

// Best-effort revoke at Finch when a DSP disconnects.
export async function disconnect(token: string): Promise<void> {
  try {
    await fetch(`${FINCH_API}/disconnect`, { method: "POST", headers: authHeaders(token) });
  } catch (_) { /* best-effort */ }
}
