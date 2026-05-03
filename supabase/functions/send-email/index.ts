// send-email · Drains queued email_messages and dispatches via Resend.
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   RESEND_FROM_EMAIL          e.g. "RouteReady <hello@gorouteready.com>"
//   RESEND_REPLY_TO            (optional)
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

interface Attachment { name?: string; url: string; content_type?: string; size?: number }
interface QueuedRow {
  id: string; dsp_id: string; applicant_id: string | null;
  to_email: string; subject: string; body_text: string | null; body_html: string | null;
  attachments: Attachment[] | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from   = Deno.env.get("RESEND_FROM_EMAIL");
  const replyTo = Deno.env.get("RESEND_REPLY_TO");
  if (!apiKey || !from) return badRequest("resend_credentials_missing", 500);

  const supa = serviceClient();
  const payload = await req.json().catch(() => ({}));
  const limit = Math.min(payload?.limit ?? 50, 200);

  let q = supa.from("email_messages")
    .select("id, dsp_id, applicant_id, to_email, subject, body_text, body_html, attachments")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (payload?.applicant_id) q = q.eq("applicant_id", payload.applicant_id);

  const { data: rows, error } = await q;
  if (error) return badRequest(error.message, 500);
  if (!rows || rows.length === 0) return jsonResponse({ sent: 0 });

  let sent = 0;
  for (const row of rows as QueuedRow[]) {
    await supa.from("email_messages").update({ status: "sending" }).eq("id", row.id);

    const body: Record<string, unknown> = {
      from, to: [row.to_email], subject: row.subject,
    };
    if (row.body_html) body.html = row.body_html;
    else body.text = row.body_text ?? "";
    if (replyTo) body.reply_to = replyTo;
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
      from_email: from,
      reply_to: replyTo ?? null,
      sent_at: new Date().toISOString(),
    }).eq("id", row.id);
    sent++;
  }

  return jsonResponse({ sent, total: rows.length });
});
