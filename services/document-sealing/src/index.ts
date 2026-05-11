// rr-document-sealing · Cloudflare Worker
//
// Invoked by a Postgres trigger on document_envelopes when an envelope
// transitions to 'signed' (via pg_net.http_post — see migration 0155).
// Responsibilities:
//   1. Authenticate the call (bearer SEALING_SECRET).
//   2. Fetch the envelope + template + last 'signed' audit event from
//      Supabase via the service role.
//   3. Download the source PDF from the 'documents' bucket.
//   4. Stamp the driver's signature image (drawn) or typed name onto
//      the PDF — at the field positions captured in fields_snapshot,
//      or a default position at the bottom-right of the last page.
//   5. Append a Certificate of Completion page listing every audit
//      event and the chain hashes — the human-readable proof page.
//   6. Upload the sealed PDF (and the cert as a separate file) back to
//      the 'documents' bucket and stamp the envelope.
//   7. Log a `pdf_sealed` event on the audit chain.
//
// PKCS#7 detached signature + RFC 3161 timestamping land in a follow-up
// PR (slice 4b) — this Worker is the plumbing. Until then the sealed
// PDF is human-defensible (signature visible, Certificate of Completion
// attached, hash chain intact in our DB) but not cryptographically
// tamper-evident to a PDF reader.
//
// Inputs (POST JSON body): { envelope_id: string }
// Auth: Authorization: Bearer <SEALING_SECRET>

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SEALING_SECRET: string;
}

interface AuditEvent {
  id: number;
  kind: string;
  actor_kind: string;
  actor_name: string | null;
  actor_email: string | null;
  ip: string | null;
  user_agent: string | null;
  event_data: Record<string, unknown> | null;
  prev_event_hash: string;
  event_hash: string;
  created_at: string;
}

interface Envelope {
  id: string;
  dsp_id: string;
  template_id: string;
  recipient_name: string;
  recipient_email: string;
  doc_hash_at_send: string;
  doc_hash_at_sign: string | null;
  fields_snapshot: Array<{
    kind?: string;
    page?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }>;
  status: string;
  signed_at: string | null;
  sent_at: string;
  signed_pdf_path: string | null;
  certificate_pdf_path: string | null;
}

interface Template {
  id: string;
  title: string;
  source_path: string;
  source_hash: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    // Shared-secret auth between the Postgres trigger and the Worker.
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.SEALING_SECRET || token !== env.SEALING_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as { envelope_id?: string };
    const envelopeId = body?.envelope_id;
    if (!envelopeId) return json({ error: "missing_envelope_id" }, 400);

    try {
      const result = await sealEnvelope(envelopeId, env);
      return json(result, 200);
    } catch (err) {
      console.error("sealEnvelope failed:", err);
      return json({ error: String((err as Error)?.message || err) }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Sealing pipeline
// ─────────────────────────────────────────────────────────────────────────

async function sealEnvelope(envelopeId: string, env: Env) {
  // 1. Envelope + template.
  const envelope = await sb<Envelope>(env, `document_envelopes?id=eq.${envelopeId}&select=*`);
  if (!envelope[0]) throw new Error("envelope_not_found");
  const env_ = envelope[0];
  if (env_.status !== "signed") return { skipped: "not_signed", status: env_.status };
  if (env_.signed_pdf_path)      return { skipped: "already_sealed", path: env_.signed_pdf_path };

  const tplArr = await sb<Template>(env, `document_templates?id=eq.${env_.template_id}&select=*`);
  if (!tplArr[0]) throw new Error("template_not_found");
  const tpl = tplArr[0];

  // 2. Audit events (full chain for the Certificate of Completion).
  const events = await sb<AuditEvent>(
    env,
    `document_events?envelope_id=eq.${envelopeId}&order=id.asc&select=*`,
  );
  const signedEvent = events.reverse().find((e) => e.kind === "signed");
  events.reverse(); // restore chronological order
  if (!signedEvent) throw new Error("no_signed_event");
  const sigData = (signedEvent.event_data?.signature_data as string) || "";
  const sigMethod = (signedEvent.event_data?.signature_method as string) || "typed";
  const typedName = (signedEvent.event_data?.typed_name as string) || env_.recipient_name;

  // 3. Download source PDF.
  const sourceBytes = await downloadStorage(env, "documents", tpl.source_path);

  // 4. Stamp the signature into the PDF.
  const pdf = await PDFDocument.load(sourceBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  await stampSignature(pdf, env_, sigMethod, sigData, typedName, helvBold);

  // 5. Append the Certificate of Completion page(s) and finalize.
  await appendCertificate(pdf, env_, tpl, events, helv, helvBold);
  const sealedBytes = await pdf.save();

  // 6. Also save the Certificate of Completion as a standalone PDF so
  // the dashboard can link to it independently of the sealed document.
  const certPdf = await PDFDocument.create();
  const certHelv = await certPdf.embedFont(StandardFonts.Helvetica);
  const certHelvBold = await certPdf.embedFont(StandardFonts.HelveticaBold);
  await appendCertificate(certPdf, env_, tpl, events, certHelv, certHelvBold);
  const certBytes = await certPdf.save();

  // 7. Upload to <dsp>/signed/<envelope>.pdf and <dsp>/certificates/<envelope>.pdf.
  const sealedPath = `${env_.dsp_id}/signed/${env_.id}.pdf`;
  const certPath = `${env_.dsp_id}/certificates/${env_.id}.pdf`;
  await uploadStorage(env, "documents", sealedPath, sealedBytes, "application/pdf");
  await uploadStorage(env, "documents", certPath,   certBytes,   "application/pdf");

  // 8. Update the envelope row with the storage paths.
  await sbPatch(env, `document_envelopes?id=eq.${env_.id}`, {
    signed_pdf_path:      sealedPath,
    certificate_pdf_path: certPath,
  });

  // 9. Append the pdf_sealed event to the audit chain (will be the next
  // event after `signed`).
  await sbRpc(env, "append_document_event_signed_pdf", null).catch(() => {
    /* fall through to the private RPC */
  });
  await sbRpc(env, "document_log_sealed", {
    p_envelope_id:        env_.id,
    p_signed_pdf_path:    sealedPath,
    p_certificate_path:   certPath,
    p_sealed_byte_count:  sealedBytes.byteLength,
  }).catch(async () => {
    // No public wrapper exists — call private.append_document_event
    // directly. The migration 0155 creates a public alias so we don't
    // need to grant on private.
    await sbRpc(env, "append_document_event", {
      p_envelope_id:     env_.id,
      p_kind:            "pdf_sealed",
      p_actor_kind:      "system",
      p_actor_user_id:   null,
      p_actor_driver_id: null,
      p_actor_email:     null,
      p_actor_name:      null,
      p_ip:              null,
      p_user_agent:      "rr-document-sealing/0.1",
      p_event_data: {
        signed_pdf_path:      sealedPath,
        certificate_pdf_path: certPath,
        sealed_byte_count:    sealedBytes.byteLength,
        cert_byte_count:      certBytes.byteLength,
        sealing_algorithm:    "stamp+certificate-v1",
      },
    });
  });

  return {
    ok: true,
    envelope_id:           env_.id,
    signed_pdf_path:       sealedPath,
    certificate_pdf_path:  certPath,
    sealed_byte_count:     sealedBytes.byteLength,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Stamping + Certificate of Completion
// ─────────────────────────────────────────────────────────────────────────

async function stampSignature(
  pdf: PDFDocument,
  envelope: Envelope,
  method: string,
  payload: string,
  typedName: string,
  bold: PDFFont,
) {
  const pages = pdf.getPages();
  const fields = Array.isArray(envelope.fields_snapshot) && envelope.fields_snapshot.length > 0
    ? envelope.fields_snapshot
    : null;

  if (fields) {
    for (const f of fields) {
      if ((f.kind || "signature") !== "signature") continue;
      const pageIdx = Math.max(0, Math.min(pages.length - 1, (f.page ?? 1) - 1));
      const page = pages[pageIdx];
      const { width: pw, height: ph } = page.getSize();
      // Field coords are stored as fractions of the page (0..1) with
      // origin at the top-left; pdf-lib's origin is bottom-left, so flip y.
      const x = (f.x ?? 0.6) * pw;
      const w = (f.w ?? 0.3) * pw;
      const h = (f.h ?? 0.08) * ph;
      const y = ph - ((f.y ?? 0.85) * ph) - h;
      await drawSignatureBox(pdf, page, x, y, w, h, method, payload, typedName, bold);
    }
  } else {
    // Default placement: bottom-right of the last page.
    const page = pages[pages.length - 1];
    const { width: pw, height: ph } = page.getSize();
    const w = pw * 0.32;
    const h = ph * 0.07;
    const x = pw - w - pw * 0.06;
    const y = ph * 0.08;
    await drawSignatureBox(pdf, page, x, y, w, h, method, payload, typedName, bold);
  }
}

async function drawSignatureBox(
  pdf: PDFDocument,
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  method: string,
  payload: string,
  typedName: string,
  bold: PDFFont,
) {
  // Thin label above the box so the signer's name + timestamp are clear.
  page.drawText("Signed by " + typedName, {
    x, y: y + h + 4, size: 8, font: bold, color: rgb(0.18, 0.22, 0.30),
  });

  if (method === "drawn" && payload.startsWith("data:image/")) {
    // Decode the data URL and embed the PNG (drawn signatures use PNG).
    const comma = payload.indexOf(",");
    if (comma > 0) {
      const isPng = payload.slice(0, comma).includes("image/png");
      const raw = atob(payload.slice(comma + 1));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      // Fit the signature image inside the box, preserving aspect.
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      page.drawImage(img, { x: x + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh });
    }
  } else {
    // Typed name — render in a script-ish way using bold italic-ish
    // Helvetica (pdf-lib's bundled fonts are limited; the typed name is
    // visually weighted to read as a signature without a custom font).
    const size = Math.min(h * 0.85, 28);
    page.drawText(typedName || payload || "", {
      x: x + 6, y: y + (h - size) / 2 + 2, size, font: bold, color: rgb(0.06, 0.10, 0.18),
    });
  }

  // Thin underline under the signature.
  page.drawLine({
    start: { x, y: y - 2 }, end: { x: x + w, y: y - 2 },
    thickness: 0.6, color: rgb(0.55, 0.60, 0.70),
  });
}

async function appendCertificate(
  pdf: PDFDocument,
  envelope: Envelope,
  template: Template,
  events: AuditEvent[],
  helv: PDFFont,
  bold: PDFFont,
) {
  let page = pdf.addPage([612, 792]); // US Letter
  const { width: pw } = page.getSize();
  let cursorY = 740;
  const margin = 48;
  const innerW = pw - margin * 2;
  const lineHeight = 14;

  const writeLine = (text: string, opts?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> }) => {
    if (cursorY < 60) {
      page = pdf.addPage([612, 792]);
      cursorY = 740;
    }
    page.drawText(text, {
      x: margin, y: cursorY,
      size: opts?.size ?? 10,
      font: opts?.font ?? helv,
      color: opts?.color ?? rgb(0.10, 0.13, 0.20),
      maxWidth: innerW,
    });
    cursorY -= (opts?.size ?? 10) + 4;
  };

  // Header.
  writeLine("Certificate of Completion", { font: bold, size: 22, color: rgb(0.05, 0.08, 0.15) });
  cursorY -= 6;
  writeLine("This certificate documents the electronic-signature event on the attached document.", { color: rgb(0.34, 0.40, 0.50) });
  cursorY -= 10;

  // Document section.
  writeLine("DOCUMENT", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
  writeLine(template.title, { font: bold, size: 12 });
  writeLine("SHA-256 (at send):  " + envelope.doc_hash_at_send, { size: 9, color: rgb(0.34, 0.40, 0.50) });
  if (envelope.doc_hash_at_sign) {
    writeLine("SHA-256 (at sign):  " + envelope.doc_hash_at_sign, { size: 9, color: rgb(0.34, 0.40, 0.50) });
    if (envelope.doc_hash_at_sign === envelope.doc_hash_at_send) {
      writeLine("Hashes match — the document was not altered between send and sign.", { color: rgb(0.04, 0.56, 0.41) });
    } else {
      writeLine("WARNING: hashes do not match — document may have changed between send and sign.", { font: bold, color: rgb(0.88, 0.18, 0.28) });
    }
  }
  cursorY -= 6;

  // Signer.
  writeLine("SIGNER", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
  writeLine(envelope.recipient_name + "  <" + envelope.recipient_email + ">", { font: bold, size: 11 });
  if (envelope.signed_at) writeLine("Signed at:  " + new Date(envelope.signed_at).toISOString());
  cursorY -= 6;

  // Audit chain.
  writeLine("AUDIT TRAIL  (hash-chained, append-only)", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
  for (const e of events) {
    const who = e.actor_kind + (e.actor_name ? " · " + e.actor_name : "");
    const meta = [e.ip ? "ip " + e.ip : null, e.user_agent ? truncate(e.user_agent, 60) : null].filter(Boolean).join("  ·  ");
    writeLine(humanKind(e.kind) + "  ·  " + new Date(e.created_at).toISOString(), { font: bold, size: 10 });
    writeLine("  " + who + (meta ? "  ·  " + meta : ""), { size: 9, color: rgb(0.34, 0.40, 0.50) });
    writeLine("  hash  " + e.event_hash, { size: 8, color: rgb(0.50, 0.55, 0.65) });
    cursorY -= 2;
  }

  // Footer.
  cursorY -= 8;
  writeLine("Issued by RouteReady  ·  rr-document-sealing/0.1", { size: 8, color: rgb(0.50, 0.55, 0.65) });
  writeLine("Verify the integrity of this record at any time via the dashboard's audit trail.", { size: 8, color: rgb(0.50, 0.55, 0.65) });
}

function humanKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─────────────────────────────────────────────────────────────────────────
// Tiny Supabase REST + Storage client
// ─────────────────────────────────────────────────────────────────────────

async function sb<T>(env: Env, path: string): Promise<T[]> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error("supabase_select_failed: " + r.status + " " + (await r.text()));
  return (await r.json()) as T[];
}

async function sbPatch(env: Env, path: string, body: Record<string, unknown>) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("supabase_patch_failed: " + r.status + " " + (await r.text()));
}

async function sbRpc(env: Env, fn: string, params: Record<string, unknown> | null) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params ?? {}),
  });
  if (!r.ok) throw new Error("supabase_rpc_failed: " + r.status + " " + (await r.text()));
}

async function downloadStorage(env: Env, bucket: string, path: string): Promise<ArrayBuffer> {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error("storage_download_failed: " + r.status + " " + (await r.text()));
  return await r.arrayBuffer();
}

async function uploadStorage(env: Env, bucket: string, path: string, bytes: Uint8Array, contentType: string) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!r.ok) throw new Error("storage_upload_failed: " + r.status + " " + (await r.text()));
}

// ─────────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
