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
import { timingSafeEqual } from "../_shared/http.ts";
import { parseIcsReply } from "../_shared/ics.ts";
import { decodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";

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
  // Attachments only appear via the Resend API response (the webhook
  // payload itself is metadata-only). Shape varies across forwarders;
  // _extractAttachments normalizes it.
  attachments?: unknown;
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

// EM#82 · spam verdict, best-effort across forwarder payload shapes.
// Only a clear FAIL/REJECT (or an explicit spam flag/score) routes to
// Junk — absent signals stay Inbox, so forwarders that strip auth
// results change nothing.
function spamVerdict(data: InboundPayload): boolean {
  const d = data as unknown as Record<string, unknown>;
  const failish = (v: unknown) => typeof v === "string" && /^(fail|reject)$/i.test(v.trim());
  const res = (o: unknown) => (o && typeof o === "object")
    ? ((o as Record<string, unknown>).result ?? (o as Record<string, unknown>).verdict ?? (o as Record<string, unknown>).status)
    : o;
  if (d.spam === true) return true;
  const score = typeof d.spam_score === "number" ? d.spam_score
    : (typeof d.spam_score === "string" ? parseFloat(d.spam_score) : NaN);
  if (Number.isFinite(score) && score >= 5) return true;
  if (failish(res(d.spf)) || failish(res(d.dkim)) || failish(res(d.dmarc))) return true;
  // Authentication-Results header, when the forwarder passes headers
  // through (array-of-{name,value} or a plain object).
  const headers = d.headers;
  let hval = "";
  if (Array.isArray(headers)) {
    const h = headers.find((x) => x && typeof x === "object"
      && /^authentication-results$/i.test(String((x as Record<string, unknown>).name ?? "")));
    hval = h ? String((h as Record<string, unknown>).value ?? "") : "";
  } else if (headers && typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    hval = String(rec["authentication-results"] ?? rec["Authentication-Results"] ?? "");
  }
  return /(dmarc|spf|dkim)\s*=\s*fail/i.test(hval);
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Resend's `email.received` webhook is metadata-only (no body, no
// attachments). Fetch the parsed message from Resend's API by its
// email id to get the text/html body AND the attachment list.
//
// The /emails/receiving/{id} endpoint returns the full inbound payload
// including any attachments — each attachment carries filename,
// content_type, and either inline base64 `content` or a downloadable
// `url`. We surface both so the caller can pass them straight to the
// document_intake capture path without a second round trip.
async function fetchResendInboundBody(
  emailId: string | null,
): Promise<{
  text: string | null;
  html: string | null;
  attachments: InboundAttachment[];
  smtpMessageId: string | null;
}> {
  const empty = {
    text: null as string | null,
    html: null as string | null,
    attachments: [] as InboundAttachment[],
    smtpMessageId: null as string | null,
  };
  if (!emailId) return empty;
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return empty;
  try {
    // Resend's "Retrieve Received Email" endpoint (not the sent-email
    // /emails/{id}, which 404s for inbound).
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      console.log(`fetchResendInboundBody: ${r.status} for ${emailId}`);
      return empty;
    }
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    // Reuse the shared extractor so the API-shape parser stays in one
    // place — handles `{ attachments: [{filename, content_type,
    // content|url}] }` as well as the slightly older shapes some
    // Resend versions return.
    const attachments = _extractAttachments({ attachments: j.attachments } as InboundPayload, emailId);
    // RFC 5322 Message-ID (EM#76) — Resend surfaces it as message_id
    // (or inside headers); replies thread off it via In-Reply-To.
    const headersObj = (j.headers && typeof j.headers === "object") ? j.headers as Record<string, unknown> : {};
    const rawMid = j.message_id ?? headersObj["message-id"] ?? headersObj["Message-Id"] ?? headersObj["Message-ID"];
    return {
      text: typeof j.text === "string" && j.text ? j.text : null,
      html: typeof j.html === "string" && j.html ? j.html : null,
      attachments,
      smtpMessageId: typeof rawMid === "string" && rawMid.includes("@") ? rawMid.trim() : null,
    };
  } catch (e) {
    console.log(`fetchResendInboundBody: ${(e as Error)?.message ?? e}`);
    return empty;
  }
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
      "raw", b64decode(keyMaterial) as BufferSource,
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
    .some((sig) => timingSafeEqual(sig, expected));
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
    authed = !!token && timingSafeEqual(token, bearerSecret);
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

  // 1. Match recipient local-part → DSP. Primary path: O(1) lookup
  // against the stored dsps.slug (migration 0318). Fallback path
  // remains for the brief window before that backfill (or if the
  // column is missing): slugify name + short_code at request time.
  const slug = localPart(toEmail);
  let dsp: { id: string; name: string | null; short_code: string | null } | undefined;
  {
    const { data } = await supa.from("dsps")
      .select("id, name, short_code")
      .eq("slug", slug)
      .maybeSingle();
    if (data) dsp = data as typeof dsp;
  }
  if (!dsp) {
    const { data: dsps } = await supa.from("dsps").select("id, name, short_code, metadata");
    dsp = (dsps ?? []).find((d) => {
      const nameSlug = d.name ? slugifyDspName(d.name as string) : "";
      const codeSlug = d.short_code ? (d.short_code as string).toLowerCase() : "";
      // Prior station codes survive as aliases (EM#83) — Settings
      // stores each renamed-away code in metadata.email_aliases so
      // vendors holding the old address still reach the DSP.
      const md = (d as Record<string, unknown>).metadata;
      const aliases = (md && typeof md === "object" && Array.isArray((md as Record<string, unknown>).email_aliases))
        ? ((md as Record<string, unknown>).email_aliases as unknown[]).map((a) => String(a).toLowerCase())
        : [];
      return slug === nameSlug || slug === codeSlug || aliases.includes(slug);
    }) as typeof dsp;
  }
  if (!dsp) {
    // Dead-letter (EM#79, 0544) · a typo'd team address used to vanish
    // without trace on either side. Keep an excerpt for the platform
    // admin; best-effort (pre-0544 the table doesn't exist).
    await supa.from("email_dead_letters").insert({
      reason: "unknown_recipient",
      to_email: toEmail,
      from_email: fromEmail,
      subject: String(data.subject ?? "").slice(0, 300),
      body_excerpt: (typeof data.text === "string" ? data.text : "").slice(0, 2000) || null,
      meta: { slug, message_id: messageId },
    }).then(() => {}, () => {});
    return jsonResponse({ ok: true, ignored: "unknown_recipient_slug", slug });
  }

  // Inbound rate limit (EM#81) · a runaway auto-responder loop (or a
  // deliberate flood) fills the inbox, document_intake, and storage.
  // Cap per sender per DSP per hour; overflow goes to the dead-letter
  // table instead of the tenant's mail. Redeliveries of an
  // already-stored message id fall through to the dedup path below.
  {
    const { count: hourCount } = await supa.from("email_messages")
      .select("id", { count: "exact", head: true })
      .eq("dsp_id", dsp.id).eq("direction", "inbound")
      .ilike("from_email", fromEmail)
      .gte("created_at", new Date(Date.now() - 3600_000).toISOString());
    if ((hourCount ?? 0) >= 30) {
      let known = false;
      if (messageId) {
        const { data: existing } = await supa.from("email_messages")
          .select("id").eq("provider", "inbound").eq("provider_message_id", messageId).limit(1);
        known = !!(existing && existing.length);
      }
      if (!known) {
        await supa.from("email_dead_letters").insert({
          reason: "rate_limited",
          dsp_id: dsp.id,
          to_email: toEmail,
          from_email: fromEmail,
          subject: String(data.subject ?? "").slice(0, 300),
          meta: { hour_count: hourCount, message_id: messageId },
        }).then(() => {}, () => {});
        return jsonResponse({ ok: true, ignored: "rate_limited", hour_count: hourCount });
      }
    }
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

  // 3. Body. Resend's email.received webhook is metadata-only, so fetch
  // the parsed message from Resend's API; fall back to anything inline
  // in the payload (other parsers carry text/html), then to an HTML→text
  // pass so the thread always shows the reply text. We always pull
  // from Resend's API when we have an email_id — even when the
  // webhook payload already carries body text — because attachments
  // are NEVER in the webhook payload (metadata-only) and only the
  // API response includes them.
  let bodyText: string | null = typeof data.text === "string" && data.text ? data.text : null;
  let bodyHtml: string | null = typeof data.html === "string" && data.html ? data.html : null;
  let fetchedAttachments: InboundAttachment[] = [];
  // RFC Message-ID for reply threading (EM#76, 0543) — forwarders often
  // put the true <…@…> id in messageId/message_id (Resend's email_id is
  // an API uuid, not an RFC id, so require an "@").
  let smtpMessageId: string | null = null;
  for (const v of [data.messageId, data.message_id]) {
    if (typeof v === "string" && v.includes("@")) { smtpMessageId = v.trim(); break; }
  }
  const resendEmailId = typeof data.email_id === "string" && data.email_id
    ? data.email_id
    : (typeof data.id === "string" ? data.id : null);
  if (resendEmailId) {
    const fetched = await fetchResendInboundBody(resendEmailId);
    if (!bodyText) bodyText = fetched.text;
    if (!bodyHtml) bodyHtml = fetched.html;
    if (!smtpMessageId) smtpMessageId = fetched.smtpMessageId;
    fetchedAttachments = fetched.attachments;
  }
  if (!bodyText && bodyHtml) bodyText = htmlToText(bodyHtml);

  // 4. Fleet Bridge routing · ALL inbound mail also lands in the
  // DSP's Fleet Bridge Inbox folder so the operator sees the full
  // conversation stream there. Applicant-matched mail keeps
  // applicant_id set too, so it ALSO shows up in the applicant
  // thread — the two views render the same row from different
  // filters (folder_id for Fleet Bridge, applicant_id for the
  // applicant pipeline thread modal).
  let folderId: string | null = null;
  {
    const { data: inbox } = await supa.from("fb_folders")
      .select("id").eq("dsp_id", dsp.id).eq("kind", "inbox").maybeSingle();
    folderId = (inbox?.id as string | null) ?? null;
  }

  // 4a-pre. Spam → Junk (EM#82, 0544) · a failed sender-auth verdict
  // outranks the rules: quarantine to the per-DSP Junk system folder,
  // creating it on first use. Pre-0544 the 'junk' kind fails the
  // fb_folders check constraint and the message stays in Inbox.
  const isSpam = spamVerdict(data);
  if (isSpam) {
    const { data: junk } = await supa.from("fb_folders")
      .select("id").eq("dsp_id", dsp.id).eq("kind", "junk").maybeSingle();
    if (junk?.id) {
      folderId = junk.id as string;
    } else {
      const ins = await supa.from("fb_folders")
        .insert({ dsp_id: dsp.id, name: "Junk", kind: "junk", position: 6 })
        .select("id").maybeSingle();
      if (ins.data?.id) folderId = ins.data.id as string;
    }
  }

  // 4a. Auto-filing rules (EM#72, migration 0541) · sender / domain /
  // subject-contains → folder, oldest rule wins. Only fresh inserts are
  // filed — the dedup path never re-files an already-triaged message.
  // Best-effort: pre-0541 the table doesn't exist and the select just
  // errors into the default Inbox routing. Spam already routed to Junk
  // skips the rules.
  if (!isSpam) try {
    const { data: rules } = await supa.from("email_rules")
      .select("match_kind, pattern, folder_id")
      .eq("dsp_id", dsp.id)
      .order("created_at", { ascending: true });
    const subjLc = String(data.subject ?? "").toLowerCase();
    const domain = fromEmail.slice(fromEmail.indexOf("@") + 1);
    for (const r of rules ?? []) {
      const pat = String(r.pattern ?? "").trim().toLowerCase();
      if (!pat || !r.folder_id) continue;
      const hit = r.match_kind === "sender" ? fromEmail === pat
        : r.match_kind === "domain" ? domain === pat.replace(/^@/, "")
        : r.match_kind === "subject" ? subjLc.includes(pat)
        : false;
      if (hit) { folderId = r.folder_id as string; break; }
    }
  } catch { /* pre-0541 — keep the Inbox default */ }

  // Merge inline + fetched attachments BEFORE the dedup branch so both
  // the fresh-insert and the dedup-backfill paths can use them. Dedup
  // matters here because the first delivery of an email — before this
  // function was deployed — created the email_messages row but never
  // captured the attachments; we need to backfill on a later retry.
  const inlineAttachments = _extractAttachments(data);
  const attachments = (() => {
    const seen = new Set<string>();
    const out: InboundAttachment[] = [];
    for (const a of [...inlineAttachments, ...fetchedAttachments]) {
      const key = a.filename + "|" + (a.contentType || "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  })();

  // 4b. Calendar RSVP · if this reply carries a METHOD:REPLY calendar part,
  // flip the matching cal_event's rsvp (accepted / declined / tentative).
  try {
    let calText: string | null = null;
    const calAtt = attachments.find((a) =>
      (a.contentType || "").toLowerCase().includes("text/calendar") || /\.ics$/i.test(a.filename || ""));
    if (calAtt?.contentB64) {
      try { calText = new TextDecoder().decode(decodeBase64(calAtt.contentB64)); } catch { /* skip */ }
    } else if (calAtt?.url) {
      try { const r = await fetch(calAtt.url); if (r.ok) calText = await r.text(); } catch { /* skip */ }
    }
    if (!calText && bodyText && /METHOD:REPLY/i.test(bodyText)) calText = bodyText;

    if (calText) {
      const { uid, partstat } = parseIcsReply(calText);
      const eventId = uid ? uid.split("@")[0].trim() : null;
      const map: Record<string, string> = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "pending" };
      const newRsvp = partstat ? map[partstat] : null;
      if (eventId && newRsvp) {
        await supa.from("cal_events").update({ rsvp: newRsvp }).eq("id", eventId).eq("dsp_id", dsp.id);
      }
    }
  } catch { /* RSVP sync is best-effort; never block the inbound insert */ }

  // 5. Idempotency — a re-delivered message id is a no-op for the email
  // row, but we still backfill applicant_id / folder_id / body / and
  // attachments if any of those are missing on the stored row. The
  // attachment backfill is gated on document_intake being empty for
  // this email_message_id so retries never double-insert.
  if (messageId) {
    const { data: existing } = await supa.from("email_messages")
      .select("id, applicant_id, folder_id, body_text, body_html")
      .eq("provider", "inbound").eq("provider_message_id", messageId).limit(1);
    if (existing && existing.length > 0) {
      const row = existing[0];
      const patch: Record<string, unknown> = {};
      if (row.applicant_id == null && applicantId != null) patch.applicant_id = applicantId;
      if (row.folder_id == null && folderId != null) patch.folder_id = folderId;
      if (row.body_text == null && row.body_html == null && (bodyText || bodyHtml)) {
        patch.body_text = bodyText;
        patch.body_html = bodyHtml;
      }
      if (Object.keys(patch).length > 0) await supa.from("email_messages").update(patch).eq("id", row.id);

      if (attachments.length > 0) {
        const { count } = await supa.from("document_intake")
          .select("id", { count: "exact", head: true })
          .eq("email_message_id", row.id as string);
        if (!count) {
          await _captureAttachments(supa, {
            dspId: dsp.id,
            emailMessageId: row.id as string,
            senderEmail: fromEmail,
            senderName: _extractSenderName(data.from),
            attachments,
          });
        }
        // Paperclip flag (0536) — best-effort; errors pre-migration.
        await supa.from("email_messages")
          .update({ has_attachments: true })
          .eq("id", row.id as string)
          .then(() => {}, () => {});
      }
      // Repair Center matching is idempotent (event-guarded in SQL),
      // so redeliveries are safe to re-run — they backfill attachments
      // captured above onto the case.
      await _repairMatch(supa, row.id as string);
      return jsonResponse({ ok: true, deduped: true, applicant_id: applicantId ?? row.applicant_id ?? null });
    }
  }

  // Body size cap (EM#85) · multi-MB marketing HTML bloats rows and
  // every 200-row list select. Truncate with a visible marker.
  {
    const MAX_HTML = 512 * 1024;
    const MAX_TEXT = 100 * 1024;
    let truncated = false;
    if (bodyHtml && bodyHtml.length > MAX_HTML) { bodyHtml = bodyHtml.slice(0, MAX_HTML); truncated = true; }
    if (bodyText && bodyText.length > MAX_TEXT) { bodyText = bodyText.slice(0, MAX_TEXT); truncated = true; }
    if (truncated) {
      bodyText = (bodyText ?? "") + "\n\n[Message truncated — it exceeded the stored size limit]";
    }
  }

  const baseRow = {
    dsp_id: dsp.id,
    applicant_id: applicantId,
    folder_id: folderId,
    direction: "inbound",
    status: "received",
    to_email: toEmail,
    from_email: fromEmail,
    subject: data.subject ?? "(no subject)",
    body_text: bodyText,
    body_html: bodyHtml,
    provider: "inbound",
    provider_message_id: messageId,
  };
  // from_name + has_attachments are 0536 columns; smtp_message_id is
  // 0543. The function deploys ahead of the manually-applied
  // migrations, so a failed insert here MUST retry with the legacy
  // column set — anything else silently drops inbound mail.
  let ins = await supa.from("email_messages").insert({
    ...baseRow,
    from_name: _extractSenderName(data.from),
    has_attachments: attachments.length > 0,
    smtp_message_id: smtpMessageId,
  }).select("id").single();
  if (ins.error && /from_name|has_attachments|smtp_message_id/.test(ins.error.message ?? "")) {
    ins = await supa.from("email_messages").insert(baseRow).select("id").single();
  }
  const insertedEmail = ins.data;

  // 6. Attachments → document_intake. Every attached file (PDF, image,
  // Excel, …) gets streamed into the `document-intake` Storage bucket
  // and a row in document_intake. Phase 2 will classify + extract;
  // Phase 3 will file. For now we just capture so nothing arriving in
  // mail is ever lost. Best-effort — a failed attachment upload never
  // blocks the email itself from being recorded.
  if (insertedEmail?.id && attachments.length > 0) {
    await _captureAttachments(supa, {
      dspId: dsp.id,
      emailMessageId: insertedEmail.id as string,
      senderEmail: fromEmail,
      senderName: _extractSenderName(data.from),
      attachments,
    });
  }

  // 7. Repair Center · match this email to a repair case (sender ↔
  // vendor, case-number token, or single-open-case — migration 0490).
  // On match the SQL side logs the timeline event and files the
  // attachments onto the case; matched PDF/image attachments then get
  // a fire-and-forget estimate extraction. Best-effort — matching
  // failures never block the inbound pipeline.
  if (insertedEmail?.id) {
    await _repairMatch(supa, insertedEmail.id as string);
  }

  return jsonResponse({
    ok: true,
    applicant_id: applicantId,
    folder_id: folderId,
    attachments_captured: attachments.length,
  });
});

// ── Repair Center matching (Phase 7) ────────────────────────────────
// deno-lint-ignore no-explicit-any
async function _repairMatch(supa: any, emailId: string): Promise<void> {
  try {
    const { data, error } = await supa.rpc("repair_inbound_email_match", {
      p_email_id: emailId,
    });
    if (error) {
      console.warn("repair match failed", { emailId, error: error.message });
      return;
    }
    if (!data?.matched) return;
    const atts: Array<{ id?: string; mime_type?: string }> =
      Array.isArray(data.attachments) ? data.attachments : [];
    for (const a of atts) {
      const mt = (a.mime_type || "").toLowerCase();
      if (!a.id) continue;
      if (mt !== "application/pdf" && !mt.startsWith("image/")) continue;
      _kickoffExtract(a.id).catch((e) =>
        console.warn("extract kickoff failed", { id: a.id, error: (e as Error)?.message }));
    }
  } catch (e) {
    console.warn("repair match exception", { emailId, error: (e as Error)?.message });
  }
}

async function _kickoffExtract(attachmentId: string): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  const key  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  const url = `${base}/functions/v1/repair-quote-extract`;
  // Fire-and-forget, same as _kickoffClassify — the email pipeline
  // never blocks on an Anthropic round-trip.
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
      "apikey": key,
    },
    body: JSON.stringify({ attachment_id: attachmentId }),
  }).catch(() => { /* swallowed */ });
}


// ── Attachment capture ──────────────────────────────────────────────
// Inbound mail attachments arrive in three different shapes depending
// on who's sending the webhook:
//
//   1. { filename, content_type, content (base64) }  ← inline body
//   2. { filename, content_type, url }                ← URL-only payload
//   3. { id, filename, content_type, size, … }        ← metadata-only
//                                                       (this is what
//                                                       Resend's
//                                                       /emails/receiving/{id}
//                                                       API returns —
//                                                       the bytes have
//                                                       to be fetched
//                                                       in a second
//                                                       step via
//                                                       /emails/receiving/{eid}/attachments/{aid}
//                                                       which returns a
//                                                       short-lived
//                                                       download_url).
//
// _extractAttachments normalizes all three into a single InboundAttachment
// shape; _captureAttachments knows how to resolve each variant down to
// raw bytes.

interface InboundAttachment {
  filename: string;
  contentType: string;
  // At least one of these is populated. For metadata-only Resend API
  // responses we keep the email_id + attachment_id and resolve the
  // download_url at capture time, since the URL is short-lived.
  contentB64?: string;
  url?: string;
  resendEmailId?: string;
  resendAttachmentId?: string;
}

function _extractAttachments(
  data: InboundPayload,
  resendEmailId?: string,
): InboundAttachment[] {
  const raw = (data as unknown as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return [];
  const out: InboundAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const filename = (obj.filename ?? obj.name ?? obj.file_name) as string | undefined;
    const contentType = (obj.content_type ?? obj.contentType ?? obj.type ?? obj.mime_type) as string | undefined;
    const contentB64 = (obj.content ?? obj.data ?? obj.content_base64) as string | undefined;
    const url = (obj.url ?? obj.path ?? obj.href) as string | undefined;
    const id = obj.id as string | undefined;
    if (!filename) continue;
    const canResolveViaResend = !!(id && resendEmailId);
    if (!contentB64 && !url && !canResolveViaResend) continue;
    out.push({
      filename: String(filename).slice(0, 200),
      contentType: String(contentType || "application/octet-stream"),
      contentB64: typeof contentB64 === "string" ? contentB64 : undefined,
      url: typeof url === "string" ? url : undefined,
      resendEmailId: canResolveViaResend ? resendEmailId : undefined,
      resendAttachmentId: canResolveViaResend ? String(id) : undefined,
    });
  }
  return out;
}

function _extractSenderName(from: unknown): string | null {
  if (!from) return null;
  const v = Array.isArray(from) ? from[0] : from;
  if (typeof v === "string") {
    // "Display Name <addr@host>" → "Display Name"
    const m = v.match(/^\s*"?([^"<]+?)"?\s*</);
    return m ? m[1].trim() : null;
  }
  if (typeof v === "object" && v != null) {
    const obj = v as Record<string, unknown>;
    const name = obj.name ?? obj.display_name ?? obj.displayName;
    return typeof name === "string" ? name.trim() : null;
  }
  return null;
}

async function _captureAttachments(
  supa: ReturnType<typeof serviceClient>,
  ctx: {
    dspId: string;
    emailMessageId: string;
    senderEmail: string;
    senderName: string | null;
    attachments: InboundAttachment[];
  },
): Promise<void> {
  // Raw email attachments age out after 90 days unless they get filed
  // — Phase 3 will null this column on filed_at to retain forever.
  const retentionUntil = new Date(Date.now() + 90 * 86400 * 1000)
    .toISOString().slice(0, 10);

  const apiKey = Deno.env.get("RESEND_API_KEY") || "";

  // Caps (EM#80) · unbounded capture used to buffer whatever arrived —
  // a 100MB file or a 50-attachment message hits function memory and
  // storage with no ceiling. Mirrors the composer's send-side limits.
  const MAX_ATT_BYTES = 25 * 1024 * 1024;
  const MAX_ATT_COUNT = 15;
  if (ctx.attachments.length > MAX_ATT_COUNT) {
    console.warn("attachment count capped", {
      emailMessageId: ctx.emailMessageId,
      total: ctx.attachments.length,
      kept: MAX_ATT_COUNT,
    });
  }

  for (const att of ctx.attachments.slice(0, MAX_ATT_COUNT)) {
    try {
      let bytes: Uint8Array | null = null;
      let resolvedUrl: string | null = null;

      // Resend API path: fetch the per-attachment endpoint to get a
      // short-lived download_url, then download those bytes. The URL
      // expires fast so we resolve at capture time, not earlier.
      if (!att.contentB64 && !att.url && att.resendEmailId && att.resendAttachmentId && apiKey) {
        const metaRes = await fetch(
          `https://api.resend.com/emails/receiving/${encodeURIComponent(att.resendEmailId)}/attachments/${encodeURIComponent(att.resendAttachmentId)}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (!metaRes.ok) {
          console.warn("resend attachment meta fetch failed", {
            status: metaRes.status,
            attachmentId: att.resendAttachmentId,
          });
          continue;
        }
        const meta = await metaRes.json().catch(() => ({})) as Record<string, unknown>;
        const dl = (meta.download_url ?? meta.downloadUrl ?? meta.url) as string | undefined;
        if (typeof dl === "string" && dl) resolvedUrl = dl;
        else {
          console.warn("resend attachment meta missing download_url", { keys: Object.keys(meta) });
          continue;
        }
      }

      if (att.contentB64) {
        bytes = _base64ToBytes(att.contentB64);
      } else {
        const url = att.url ?? resolvedUrl;
        if (url) {
          const resp = await fetch(url);
          if (resp.ok) {
            // Size gate BEFORE buffering when the server declares it.
            const declared = parseInt(resp.headers.get("content-length") || "", 10);
            if (Number.isFinite(declared) && declared > MAX_ATT_BYTES) {
              console.warn("attachment too large, skipped", { filename: att.filename, declared });
              try { await resp.body?.cancel(); } catch { /* ignore */ }
              continue;
            }
            const buf = new Uint8Array(await resp.arrayBuffer());
            bytes = buf;
          } else {
            console.warn("attachment fetch failed", { url, status: resp.status });
            continue;
          }
        }
      }
      if (!bytes || bytes.length === 0) continue;
      if (bytes.length > MAX_ATT_BYTES) {
        console.warn("attachment too large, skipped", { filename: att.filename, size: bytes.length });
        continue;
      }

      // Storage path: <dsp_id>/<yyyy-mm-dd>/<random>-<sanitized-name>
      const safeName = att.filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
      const date = new Date().toISOString().slice(0, 10);
      const rand = crypto.randomUUID().slice(0, 8);
      const storagePath = `${ctx.dspId}/${date}/${rand}-${safeName}`;

      const { error: upErr } = await supa.storage
        .from("document-intake")
        .upload(storagePath, bytes, {
          contentType: att.contentType,
          upsert: false,
        });
      if (upErr) {
        console.warn("attachment upload failed", { storagePath, error: upErr.message });
        continue;
      }

      const { data: insRow, error: insErr } = await supa.from("document_intake").insert({
        dsp_id: ctx.dspId,
        source: "email",
        email_message_id: ctx.emailMessageId,
        sender_email: ctx.senderEmail,
        sender_name: ctx.senderName,
        storage_path: storagePath,
        file_name: att.filename,
        file_size_bytes: bytes.length,
        mime_type: att.contentType,
        status: "pending",
        retention_until: retentionUntil,
      }).select("id").single();
      if (insErr) {
        console.warn("document_intake insert failed", { storagePath, error: insErr.message });
      } else if (insRow?.id) {
        // Phase 2 · fire-and-forget classification call. Wrapped so a
        // classifier failure never blocks the email pipeline.
        _kickoffClassify(insRow.id as string).catch(e =>
          console.warn("classify kickoff failed", { id: insRow.id, error: (e as Error)?.message }));
      }
    } catch (e) {
      console.warn("attachment capture exception", { filename: att.filename, error: (e as Error)?.message });
    }
  }
}

async function _kickoffClassify(id: string): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  const key  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  const url = `${base}/functions/v1/document-classify`;
  // We deliberately don't await the classifier's full response — the
  // email pipeline shouldn't block on an Anthropic round-trip.
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
      "apikey": key,
    },
    body: JSON.stringify({ id }),
  }).catch(() => { /* swallowed */ });
}

function _base64ToBytes(b64: string): Uint8Array {
  try {
    const clean = b64.replace(/\s+/g, "");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}
