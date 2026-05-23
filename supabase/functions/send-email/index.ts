// send-email · Drains queued email_messages and dispatches via Resend.
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   RESEND_FROM_EMAIL          e.g. "RouteReady <hello@gorouteready.com>"
//   RESEND_REPLY_TO            (optional)
import { serviceClient, jsonResponse, badRequest, requireServiceKey } from "../_shared/supabase.ts";

interface Attachment { name?: string; url: string; content_type?: string; size?: number }
interface QueuedRow {
  id: string; dsp_id: string; applicant_id: string | null; folder_id: string | null;
  to_email: string; subject: string; body_text: string | null; body_html: string | null;
  attachments: Attachment[] | null;
}

// Rebuild the Resend "From" header so:
//   • The display name = the per-DSP name from gear icon → Workspace
//     settings (e.g. "Acme Logistics").
//   • The local-part of the address = the stored, globally-unique
//     dsps.slug (migration 0318). Two DSPs whose names slugify the same
//     way now disambiguate via the trailing -2/-3 suffix that
//     private.dsp_unique_slug() assigned at provision time. If the
//     slug column happens to be empty (pre-backfill row), we fall back
//     to the legacy in-memory slugify so outbound mail still ships.
// Recipient sees:  "Acme Logistics <acme-logistics@gorouteready.com>"
function slugifyLocalPart(s: string): string {
  return s.toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
function brandedFrom(
  envFrom: string,
  dspName: string | null | undefined,
  dspShortCode: string | null | undefined,
  dspSlug?: string | null,
): string {
  if (!dspName) return envFrom;
  const m = envFrom.match(/<([^>]+)>/);
  const addr = m ? m[1] : envFrom;
  const atIdx = addr.indexOf("@");
  if (atIdx <= 0) return envFrom; // malformed env var — bail to default

  const slug = (dspSlug && dspSlug.trim())
    || slugifyLocalPart(dspName)
    || (dspShortCode ? dspShortCode.toLowerCase() : "");
  const localPart = slug || addr.slice(0, atIdx);
  const domain = addr.slice(atIdx + 1);

  // Quote the display name if it contains special chars per RFC 5322.
  const safe = /[",<>@]/.test(dspName) ? `"${dspName.replace(/"/g, '\\"')}"` : dspName;
  return `${safe} <${localPart}@${domain}>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  // Function is deployed with --no-verify-jwt (post-key-rotation: the
  // gateway no longer accepts the legacy JWT that the drain cron sends,
  // and the new sb_secret_… keys aren't JWTs at all). Bearer-gate it
  // ourselves against the service role key.
  const gate = requireServiceKey(req); if (gate) return gate;

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from   = Deno.env.get("RESEND_FROM_EMAIL");
  const replyTo = Deno.env.get("RESEND_REPLY_TO");
  // Domain whose MX is pointed at the inbound-email parser (which POSTs
  // to webhook-email-inbound). When set, applicant-attributed mail gets
  // its Reply-To rewritten to <dsp-slug>@<this-domain> so replies route
  // back into the applicant's email thread instead of a dead inbox.
  const inboundDomain = (Deno.env.get("EMAIL_INBOUND_DOMAIN") || "").trim();
  if (!apiKey || !from) return badRequest("resend_credentials_missing", 500);

  const supa = serviceClient();
  const payload = await req.json().catch(() => ({}));
  const limit = Math.min(payload?.limit ?? 50, 200);

  let q = supa.from("email_messages")
    .select("id, dsp_id, applicant_id, folder_id, to_email, subject, body_text, body_html, attachments")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (payload?.applicant_id) q = q.eq("applicant_id", payload.applicant_id);

  const { data: rows, error } = await q;
  if (error) return badRequest(error.message, 500);
  if (!rows || rows.length === 0) return jsonResponse({ sent: 0 });

  // Look up DSP names + short codes + slug + reply-to email for every
  // dsp_id in this batch in one round-trip.
  const dspIds = Array.from(new Set(rows.map((r) => r.dsp_id).filter(Boolean)));
  const dspById = new Map<string, { name: string | null; short_code: string | null; slug: string | null; replyTo: string | null }>();
  if (dspIds.length > 0) {
    const { data: dspRows } = await supa.from("dsps")
      .select("id, name, short_code, slug, metadata").in("id", dspIds);
    for (const d of dspRows ?? []) {
      if (d?.id) {
        const meta = (d.metadata as Record<string, unknown> | null) ?? {};
        const rt = typeof meta.reply_to_email === "string" ? meta.reply_to_email.trim() : "";
        dspById.set(d.id as string, {
          name: (d.name as string) ?? null,
          short_code: (d.short_code as string) ?? null,
          slug: (d.slug as string | null) ?? null,
          replyTo: rt || null,
        });
      }
    }
  }

  let sent = 0;
  for (const row of rows as QueuedRow[]) {
    await supa.from("email_messages").update({ status: "sending" }).eq("id", row.id);

    const dsp = dspById.get(row.dsp_id);
    const fromHeader = brandedFrom(from, dsp?.name ?? null, dsp?.short_code ?? null, dsp?.slug ?? null);
    // Reply-To resolution:
    //   • Fleet Bridge (row.folder_id is set) → leave Reply-To empty;
    //     vendor replies go straight to the From address, which is
    //     <dsp.slug>@gorouteready.com — already the inbound domain.
    //   • Applicant-attributed mail + EMAIL_INBOUND_DOMAIN set →
    //     <dsp-slug>@<inbound-domain>, reusing the From local-part so
    //     webhook-email-inbound can match the reply back to this DSP
    //     (then to the applicant) and append it to the email thread.
    //   • Otherwise → the per-DSP reply-to, else the server-wide
    //     RESEND_REPLY_TO env var.
    let effectiveReplyTo: string | null = null;
    if (row.folder_id) {
      effectiveReplyTo = null;
    } else if (row.applicant_id && inboundDomain) {
      const m = fromHeader.match(/<([^>]+)>/);
      const fromAddr = (m ? m[1] : fromHeader).trim();
      const at = fromAddr.indexOf("@");
      if (at > 0) effectiveReplyTo = `${fromAddr.slice(0, at)}@${inboundDomain}`;
    } else {
      effectiveReplyTo = dsp?.replyTo || replyTo || null;
    }

    const body: Record<string, unknown> = {
      from: fromHeader, to: [row.to_email], subject: row.subject,
    };
    if (row.body_html) body.html = row.body_html;
    else body.text = row.body_text ?? "";
    if (effectiveReplyTo) body.reply_to = effectiveReplyTo;
    // Resend supports `attachments: [{filename, path}]` where `path` is a
    // public URL it fetches at send time.
    const att = Array.isArray(row.attachments) ? row.attachments : [];
    if (att.length > 0) {
      body.attachments = att
        .filter((a) => a?.url)
        .map((a) => ({
          filename: a.name || "attachment",
          path:     a.url,
          content_type: a.content_type,
        }));
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    if (!resp.ok) {
      await supa.from("email_messages").update({
        status: "failed",
        error_code: String(data.statusCode ?? resp.status),
        error_message: data.message ?? "resend_error",
      }).eq("id", row.id);
      continue;
    }

    await supa.from("email_messages").update({
      status: "sent",
      provider: "resend",
      provider_message_id: data.id,
      from_email: fromHeader,
      reply_to: effectiveReplyTo,
      sent_at: new Date().toISOString(),
    }).eq("id", row.id);
    sent++;
  }

  return jsonResponse({ sent, total: rows.length });
});
