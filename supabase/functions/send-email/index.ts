// send-email · Drains queued email_messages and dispatches via Resend.
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   RESEND_FROM_EMAIL          e.g. "RouteReady <hello@gorouteready.com>"
//   RESEND_REPLY_TO            (optional)
import { serviceClient, jsonResponse, badRequest, signMessageAttachment, requireServiceKey } from "../_shared/supabase.ts";
import { fetchWithTimeout, safeJson } from "../_shared/http.ts";
import { buildIcsRequest } from "../_shared/ics.ts";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";

interface Attachment { name?: string; url?: string; path?: string; content_type?: string; size?: number }
interface QueuedRow {
  id: string; dsp_id: string; applicant_id: string | null; folder_id: string | null;
  to_email: string; cc_emails: string[] | null;
  subject: string; body_text: string | null; body_html: string | null;
  attachments: Attachment[] | null; cal_event_id: string | null;
  calendar_method?: string | null;   // 'request' | 'cancel' (0429)
}
interface InviteEvent {
  id: string; kind: string | null; starts_at: string; ends_at: string | null;
  title: string | null; timezone: string | null; location: string | null;
  meeting_url: string | null; metadata: Record<string, unknown> | null;
  ics_sequence?: number | null;
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
  options?: { preferShortCode?: boolean; preferDomain?: string | null },
): string {
  if (!dspName) return envFrom;
  const m = envFrom.match(/<([^>]+)>/);
  const addr = m ? m[1] : envFrom;
  const atIdx = addr.indexOf("@");
  if (atIdx <= 0) return envFrom; // malformed env var — bail to default

  // Local-part selection:
  //   • Fleet Bridge mail (preferShortCode=true) uses the operator's
  //     short_code so vendors see e.g. ozrk@mail.gorouteready.com —
  //     the "team email" surfaced in DSP settings.
  //   • Applicant mail keeps the original slug-from-name behavior so
  //     historical reply-to addresses + threading stay valid.
  let localPart: string;
  if (options?.preferShortCode && dspShortCode && dspShortCode.trim()) {
    localPart = dspShortCode.trim().toLowerCase();
  } else {
    const slug = (dspSlug && dspSlug.trim())
      || slugifyLocalPart(dspName)
      || (dspShortCode ? dspShortCode.toLowerCase() : "");
    localPart = slug || addr.slice(0, atIdx);
  }
  const domain = (options?.preferDomain && options.preferDomain.trim())
    || addr.slice(atIdx + 1);

  // Quote the display name if it contains special chars per RFC 5322.
  const safe = /[",<>@]/.test(dspName) ? `"${dspName.replace(/"/g, '\\"')}"` : dspName;
  return `${safe} <${localPart}@${domain}>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  // Server-to-server only. Both callers — the 0007 AFTER-INSERT trigger and
  // the cron drainer — present the service-role key as a bearer (app.service_role_key
  // GUC). Require it so an anonymous internet caller can't force-drain the
  // queue or probe the endpoint. Deployed with --no-verify-jwt (the sb_secret_…
  // key is not a JWT and would 401 at the gateway); the bearer check happens
  // in-function via requireServiceKey.
  const authFail = requireServiceKey(req);
  if (authFail) return authFail;

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

  // select("*") on purpose: calendar_method (0429) may not exist yet when
  // this function deploys ahead of the manually-applied migration, and an
  // explicit column list would fail the whole drain.
  let q = supa.from("email_messages")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (payload?.applicant_id) q = q.eq("applicant_id", payload.applicant_id);

  const { data: rows, error } = await q;
  if (error) return badRequest(error.message, 500);
  if (!rows || rows.length === 0) return jsonResponse({ sent: 0 });

  // Pre-load the cal_events referenced by this batch so we can attach a real
  // calendar invite (.ics) to interview invitations. select("*") for the same
  // migration-lag tolerance as above (ics_sequence is 0429).
  const evIds = Array.from(new Set((rows as QueuedRow[]).map((r) => r.cal_event_id).filter(Boolean) as string[]));
  const evById = new Map<string, InviteEvent>();
  if (evIds.length > 0) {
    const { data: evRows } = await supa.from("cal_events")
      .select("*").in("id", evIds);
    for (const e of evRows ?? []) if (e?.id) evById.set(e.id as string, e as never);
  }

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

  let sent = 0, skipped = 0;
  for (const row of rows as QueuedRow[]) {
    // Atomically claim the row: flip queued→sending only if it is STILL
    // queued. The pg_net insert trigger and the 1-minute cron drainer both
    // select status='queued' and can race for the same row; without this
    // guard both would send it (duplicate email). The conditional update
    // returns the row only to the worker that won the claim; a loser gets
    // zero rows and skips.
    const { data: claimed } = await supa.from("email_messages")
      .update({ status: "sending" })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id");
    if (!claimed || claimed.length === 0) { skipped++; continue; }

    const dsp = dspById.get(row.dsp_id);
    // Fleet Bridge mail (row.folder_id set) is the operator-to-vendor
    // channel; the From local-part is the DSP's short_code and the
    // domain is the inbound subdomain (mail.gorouteready.com) so
    // vendors see the same team-email address that's surfaced in DSP
    // settings, and replies route through webhook-email-inbound back
    // to the same DSP. Applicant mail keeps the legacy slug-based
    // From so historical reply threading still works.
    const fromHeader = brandedFrom(
      from,
      dsp?.name ?? null,
      dsp?.short_code ?? null,
      dsp?.slug ?? null,
      row.folder_id
        ? { preferShortCode: true, preferDomain: inboundDomain || null }
        : undefined,
    );
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
    // A calendar invite must route the recipient's RSVP reply back to our
    // inbound webhook (so cal_events.rsvp updates), so force the reply-to /
    // organizer to the inbound address when this row carries a cal_event_id.
    const isInvite = !!(row.cal_event_id && evById.has(row.cal_event_id));
    const fromAddrM = fromHeader.match(/<([^>]+)>/);
    const fromAddr = (fromAddrM ? fromAddrM[1] : fromHeader).trim();
    const inboundAddr = (() => {
      if (!inboundDomain) return null;
      const at = fromAddr.indexOf("@");
      return at > 0 ? `${fromAddr.slice(0, at)}@${inboundDomain}` : null;
    })();

    let effectiveReplyTo: string | null = null;
    if (row.folder_id) {
      effectiveReplyTo = null;
    } else if (isInvite && inboundAddr) {
      effectiveReplyTo = inboundAddr;
    } else if (row.applicant_id && inboundDomain) {
      effectiveReplyTo = inboundAddr;
    } else {
      effectiveReplyTo = dsp?.replyTo || replyTo || null;
    }

    const body: Record<string, unknown> = {
      from: fromHeader, to: [row.to_email], subject: row.subject,
    };
    if (Array.isArray(row.cc_emails) && row.cc_emails.length > 0) {
      body.cc = row.cc_emails;
    }
    if (row.body_html) body.html = row.body_html;
    else body.text = row.body_text ?? "";
    if (effectiveReplyTo) body.reply_to = effectiveReplyTo;
    // Resend fetches each attachment `path` (a URL) at send time. Attachments
    // from the private message-attachments bucket (0447) must be signed fresh
    // here; attachments from other buckets (e.g. fleet-bridge-attachments)
    // already carry a valid signed url. Best-effort — a failure just drops
    // that one attachment; the email still sends.
    const att = Array.isArray(row.attachments) ? row.attachments : [];
    const outAtts: Record<string, unknown>[] = [];
    for (const a of att) {
      if (!a) continue;
      const isMsgAtt = !!a.path || /\/object\/(?:public|sign)\/message-attachments\//.test(String(a.url || ""));
      const url = isMsgAtt ? await signMessageAttachment(supa, a) : (a.url || null);
      if (url) outAtts.push({ filename: a.name || "attachment", path: url, content_type: a.content_type });
    }

    // Calendar invite (.ics) — rows stamped calendar_method 'request' or
    // 'cancel' (0429) get a standards RFC 5545 METHOD:REQUEST / CANCEL part
    // so Gmail/Outlook render the native event card and add it to the
    // recipient's calendar. The HTML Accept/Decline + add-to-calendar
    // buttons stay in the body as the fallback. ORGANIZER is the inbound
    // reply address, so a native RSVP (METHOD:REPLY) routes back through
    // webhook-email-inbound → cal_events.rsvp. Reminder emails also carry
    // cal_event_id but no calendar_method — they never re-attach.
    const ev = row.cal_event_id ? evById.get(row.cal_event_id) : undefined;
    const method = row.calendar_method === "cancel" ? "CANCEL"
      : row.calendar_method === "request" ? "REQUEST" : null;
    if (ev && method) {
      const fallbackTitle = ev.kind === "orientation" ? "Orientation"
        : ev.kind === "interview" ? "Interview" : "Event";
      const title = (ev.title || "").trim()
        || (dsp?.name ? `${fallbackTitle} — ${dsp.name}` : fallbackTitle);
      const md = (ev.metadata ?? {}) as Record<string, unknown>;
      // Invitee-facing description: the composer note (free-form events
      // only — interview rows may hold internal recruiter notes) + join link.
      const note = ev.kind === "event" && typeof md.note === "string" ? md.note.trim() : "";
      const desc = [note, ev.meeting_url ? `Join the video meeting: ${ev.meeting_url}` : ""]
        .filter(Boolean).join("\n");
      const ics = buildIcsRequest({
        uid: `${row.cal_event_id}@gorouteready.com`,
        start: ev.starts_at,
        end: ev.ends_at,
        title,
        description: desc || undefined,
        location: ev.location || ev.meeting_url || undefined,
        organizerName: dsp?.name || "RouteReady",
        organizerEmail: effectiveReplyTo || fromAddr,
        attendeeEmail: row.to_email,
        // CANCEL must carry a sequence >= the last REQUEST. The cancel email
        // can be queued before cancel_cal_event_silent runs, so +1 here
        // rather than trusting the row to have been bumped already.
        sequence: (ev.ics_sequence ?? 0) + (method === "CANCEL" ? 1 : 0),
        method,
        allDay: md.all_day === true,
        tzid: ev.timezone || undefined,
      });
      outAtts.push({
        filename: method === "CANCEL" ? "cancel.ics" : "invite.ics",
        content: encodeBase64(new TextEncoder().encode(ics)),
        content_type: `text/calendar; method=${method}; charset=UTF-8`,
      });
    }

    if (outAtts.length > 0) body.attachments = outAtts;

    // Timeout + tolerant parse: a hung Resend call used to stall the drain,
    // and resp.json() throwing on a non-JSON body stranded the claimed row
    // in 'sending' forever.
    let resp: Response;
    try {
      resp = await fetchWithTimeout("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }, 25_000);
    } catch (e) {
      await supa.from("email_messages").update({ status: "queued" }).eq("id", row.id);
      console.error("resend fetch failed:", (e as Error)?.message);
      skipped++;
      continue;
    }
    const data = (await safeJson(resp) ?? {}) as { statusCode?: unknown; message?: string; id?: string };

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

  return jsonResponse({ sent, skipped, total: rows.length });
});

// redeploy: retry after a transient JWT-gated deploy failure (no logic change)
