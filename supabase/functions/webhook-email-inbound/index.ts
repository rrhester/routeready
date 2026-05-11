// webhook-email-inbound · Receives parsed email replies from an inbound
// email service and writes them to email_messages as direction='inbound'
// so the applicant card can render the thread.
//
// Auth — either works, checked in this order:
//   1. Svix signature (Resend webhooks, and any Svix-signed sender):
//      svix-id / svix-timestamp / svix-signature headers verified against
//      RESEND_WEBHOOK_SECRET (the `whsec_…` value Resend shows on the
//      webhook).
//   2. Bearer token: `Authorization: Bearer <EMAIL_INBOUND_SECRET>` — for
//      Cloudflare Email Workers, Postmark, a custom relay, etc.
//   At least one of RESEND_WEBHOOK_SECRET / EMAIL_INBOUND_SECRET must be
//   set or every request is refused (500 inbound_secret_missing).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   RESEND_WEBHOOK_SECRET   `whsec_…` signing secret for the Resend webhook
//   EMAIL_INBOUND_SECRET    shared bearer for non-Svix forwarders
//
// Payload (lenient, vendor-agnostic). Resend's `email.received` event
// nests the message under `data`; flat `{ to, from, subject, text, html,
// messageId }` also works:
//   to:        string | string[] | {email|address}[]   recipient(s)
//   from:      string | {email|address}                sender
//   subject?:  string
//   text?:     string                                  plaintext body
//   html?:     string                                  HTML body
//   messageId?: string  (also accepts message_id / email_id / id)
//
// The recipient address's local-part (the slugified DSP name / short
// code) picks the tenant; the sender address picks the applicant inside
// it. If either lookup fails we still 200 so the upstream doesn't retry.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

interface InboundPayload {
  to?: unknown;
  from?: unknown;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  message_id?: string;
  email_id?: string;
  id?: string;
  // Resend's `email.received` event nests the message under `data`.
  data?: InboundPayload;
}

function pickAddress(value: unknown): string | null {
  if (!value) return null;
  const v = Array.isArray(value) ? value[0] : value;
  // Some parsers send addresses as objects ({ email | address | addr }).
  const raw = typeof v === "string"
    ? v
    : (v && typeof v === "object"
        ? ((v as Record<string, unknown>).email
            ?? (v as Record<string, unknown>).address
            ?? (v as Record<string, unknown>).addr)
        : null);
  if (typeof raw !== "string") return null;
  // Strip "Display Name <email@host>" formatting, leaving just the addr.
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  const lp = at > 0 ? email.slice(0, at) : email;
  // Drop any "+tag" suffix so plus-addressed replies still resolve.
  const plus = lp.indexOf("+");
  return plus > 0 ? lp.slice(0, plus) : lp;
}

function slugifyDspName(s: string): string {
  return s.toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64encode(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// Verify a Svix webhook signature (the scheme Resend uses).
//   signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
//   sig = base64(HMAC-SHA256(key = base64decode(secret w/o "whsec_"), signedContent))
// The svix-signature header is a space-separated list of `v1,<sig>`.
async function verifySvix(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: string,
  svixSignatureHeader: string,
): Promise<boolean> {
  // NB: no timestamp-age check on purpose — Resend retries reuse the
  // original svix-timestamp, so a freshness window would make every
  // retry of a momentarily-failed delivery fail forever. The HMAC is the
  // real protection here, and the insert path is idempotent on the
  // message id anyway.
  const keyMaterial = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw", b64decode(keyMaterial),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  } catch {
    return false;
  }
  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = b64encode(mac);

  // Header looks like "v1,abc123 v1,def456" (one entry per active key).
  return svixSignatureHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean)
    .some((sig) => sig === expected);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const svixSecret  = Deno.env.get("RESEND_WEBHOOK_SECRET");
  const bearerSecret = Deno.env.get("EMAIL_INBOUND_SECRET");
  if (!svixSecret && !bearerSecret) return badRequest("inbound_secret_missing", 500);

  // Read the body once as text — Svix verifies the exact bytes.
  const rawBody = await req.text();

  let authed = false;
  const svixId   = req.headers.get("svix-id");
  const svixTs   = req.headers.get("svix-timestamp");
  const svixSig  = req.headers.get("svix-signature");
  if (svixSecret && svixId && svixTs && svixSig) {
    authed = await verifySvix(svixSecret, svixId, svixTs, rawBody, svixSig);
  }
  if (!authed && bearerSecret) {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    authed = token === bearerSecret;
  }
  if (!authed) return badRequest("unauthorized", 401);

  let payload: InboundPayload = {};
  try { payload = JSON.parse(rawBody || "{}") as InboundPayload; } catch { /* keep {} */ }
  const data = payload.data ?? payload; // Resend nests the message under `data`.

  const fromEmail = pickAddress(data.from);
  const toEmail   = pickAddress(data.to);
  if (!fromEmail || !toEmail) {
    return jsonResponse({ ok: true, ignored: "missing_addresses" });
  }
  const messageId = data.messageId ?? data.message_id ?? data.email_id ?? data.id ?? null;

  const supa = serviceClient();

  // 1. Match recipient local-part → DSP (slugified name or short_code —
  // both are how send-email derives the From/Reply-To local part).
  const slug = localPart(toEmail);
  const { data: dsps } = await supa.from("dsps").select("id, name, short_code");
  const dsp = (dsps ?? []).find((d) => {
    const nameSlug = d.name ? slugifyDspName(d.name as string) : "";
    const codeSlug = d.short_code ? (d.short_code as string).toLowerCase() : "";
    return slug === nameSlug || slug === codeSlug;
  });
  if (!dsp) {
    return jsonResponse({ ok: true, ignored: "unknown_recipient_slug", slug });
  }

  // 2. Match sender email → applicant in that DSP. If several applicants
  // share the address (re-applies, a referrer who also applied, test
  // data), attach the reply to the one with the most recent email
  // activity — the live conversation — falling back to the newest.
  let applicantId: string | null = null;
  {
    const { data: cands } = await supa.from("applicants")
      .select("id, created_at").eq("dsp_id", dsp.id).ilike("email", fromEmail);
    if (cands && cands.length === 1) {
      applicantId = cands[0].id as string;
    } else if (cands && cands.length > 1) {
      const ids = cands.map((c) => c.id as string);
      const { data: recent } = await supa.from("email_messages")
        .select("applicant_id, created_at")
        .in("applicant_id", ids)
        .order("created_at", { ascending: false })
        .limit(1);
      applicantId = (recent?.[0]?.applicant_id as string | null | undefined)
        ?? cands.slice().sort((a, b) =>
             String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0].id as string;
    }
  }

  // 3. Idempotency — re-delivery of the same message id is a no-op,
  // except we'll backfill the applicant if we couldn't attribute it
  // before but can now.
  if (messageId) {
    const { data: existing } = await supa.from("email_messages")
      .select("id, applicant_id").eq("provider", "inbound").eq("provider_message_id", messageId).limit(1);
    if (existing && existing.length > 0) {
      if (existing[0].applicant_id == null && applicantId != null) {
        await supa.from("email_messages").update({ applicant_id: applicantId }).eq("id", existing[0].id);
      }
      return jsonResponse({ ok: true, deduped: true, applicant_id: applicantId ?? existing[0].applicant_id ?? null });
    }
  }

  await supa.from("email_messages").insert({
    dsp_id: dsp.id,
    applicant_id: applicantId,
    direction: "inbound",
    status: "received",
    to_email: toEmail,
    from_email: fromEmail,
    subject: data.subject ?? "(no subject)",
    body_text: data.text ?? null,
    body_html: data.html ?? null,
    provider: "inbound",
    provider_message_id: messageId,
  });

  return jsonResponse({ ok: true, applicant_id: applicantId });
});
