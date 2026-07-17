// link-preview · fetch a URL's title/description for chat link-unfurl cards
// (Messages 100-list #24).
//
// Why a server function (not a direct browser fetch): CORS blocks reading
// arbitrary pages from the dashboard. This proxies ONE bounded HTML read
// and returns only whitelisted metadata fields.
//
// SSRF posture — the URL here IS user-controlled (it came out of a chat
// message), so we constrain the fetch instead of the URL:
//   • http/https only, no credentials in the URL
//   • hostname must not be a private/loopback/link-local IP literal or
//     localhost-ish name (the edge runtime is also network-isolated from
//     any RouteReady-internal services — there is nothing private to reach)
//   • redirects followed manually, max 3, each hop re-validated
//   • 5s timeout, response read capped at 256 KB, text/html only
//   • response is parsed with regexes for <title>/og: tags — never
//     executed, never reflected as HTML (client escapes everything)
//
// Auth: caller's RouteReady user JWT validated in-function via auth.getUser.
// Gateway verify_jwt off (config.toml) so we own the 401s + CORS preflight.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

function validateUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (PRIVATE_HOST.test(u.hostname)) return null;
  return u;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } })
    .replace(/\s+/g, " ").trim();
}

function extractMeta(html: string): { title: string; description: string } {
  const pick = (re: RegExp) => { const m = html.match(re); return m ? decodeEntities(m[1]) : ""; };
  const og = (prop: string) =>
    pick(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, "i")) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, "i"));
  const named = (name: string) =>
    pick(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i")) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']+)["']+[^>]*name=["']${name}["']`, "i"));
  const title = og("title") || pick(/<title[^>]*>([^<]{1,300})</i);
  const description = og("description") || named("description");
  return { title: title.slice(0, 160), description: description.slice(0, 280) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const supaUrl = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supaUrl || !anon) return json({ error: "server_misconfigured" }, 500);
  const userClient = createClient(supaUrl, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: { url?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  let target = validateUrl(String(body?.url || ""));
  if (!target) return json({ error: "bad_url" }, 400);

  try {
    let resp: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        resp = await fetch(target.href, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "user-agent": "RouteReadyLinkPreview/1.0 (+https://routeready.app)", accept: "text/html" },
        });
      } finally { clearTimeout(timer); }
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) break;
        const next = validateUrl(new URL(loc, target).href);
        if (!next) return json({ error: "bad_redirect" }, 400);
        target = next;
        continue;
      }
      break;
    }
    if (!resp || !resp.ok) return json({ title: "", description: "", host: target.hostname });
    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("text/html")) return json({ title: "", description: "", host: target.hostname });

    // Cap the read at 256 KB — metadata lives in <head>.
    const reader = resp.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      let bytes = 0;
      while (bytes < 262144) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += dec.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
      try { await reader.cancel(); } catch { /* already done */ }
    }
    const meta = extractMeta(html);
    return json({ ...meta, host: target.hostname });
  } catch {
    return json({ title: "", description: "", host: target?.hostname || "" });
  }
});
