// webhook-email-inbound · Receives parsed email replies from an inbound
// email service (Resend Inbound, Postmark, Cloudflare Email Worker —
// any service that POSTs JSON works) and writes them to email_messages
// as direction='inbound' so the applicant card can render the thread.
//
// Auth: bearer token via the Authorization header. The same token must
//       be set in the upstream service's webhook config + as the
//       EMAIL_INBOUND_SECRET env var on the Supabase project.
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   EMAIL_INBOUND_SECRET   shared bearer for upstream to authenticate
//
// Expected JSON shape (best-effort, vendor-agnostic):
//   {
//     to:        string | string[],     // recipient(s) — we read the slug
//     from:      string,                // sender's email
//     subject?:  string,
//     text?:     string,                // plaintext body
//     html?:     string,                // HTML body
//     messageId?: string                // upstream message id (idempotency)
//   }
//
// The local-part of the recipient address (slugified DSP name) selects
// the tenant; the sender address selects the applicant inside that DSP.
// If either lookup fails, we 200 the request anyway so the upstream
// doesn't retry — the row is just dropped on the floor.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

interface InboundPayload {
  to?: string | string[];
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  // Resend Inbound nests the parsed message under `data`. Be lenient.
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  // Bearer-token auth so only configured upstream services can post here.
  const expected = Deno.env.get("EMAIL_INBOUND_SECRET");
  if (!expected) return badRequest("inbound_secret_missing", 500);
  const auth = req.headers.get("authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (got !== expected) return badRequest("unauthorized", 401);

  const payload = (await req.json().catch(() => ({}))) as InboundPayload;
  const data = payload.data ?? payload; // Resend nests under `data`.

  const fromEmail = pickAddress(data.from);
  const toEmail   = pickAddress(data.to);
  if (!fromEmail || !toEmail) {
    return jsonResponse({ ok: true, ignored: "missing_addresses" });
  }

  const supa = serviceClient();

  // 1. Match recipient slug → DSP. Both slugified-name and short_code
  // are accepted because the From local-part is derived from one of
  // them in send-email.
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

  // 2. Match sender email → applicant in that DSP.
  const { data: app } = await supa.from("applicants")
    .select("id").eq("dsp_id", dsp.id).ilike("email", fromEmail).limit(1);
  const applicantId = app?.[0]?.id ?? null;

  // 3. Idempotency — if upstream sends the same messageId twice, no-op.
  if (data.messageId) {
    const { data: existing } = await supa.from("email_messages")
      .select("id").eq("provider", "inbound").eq("provider_message_id", data.messageId).limit(1);
    if (existing && existing.length > 0) {
      return jsonResponse({ ok: true, deduped: true });
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
    provider_message_id: data.messageId ?? null,
  });

  return jsonResponse({ ok: true, applicant_id: applicantId });
});
