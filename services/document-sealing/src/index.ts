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
// Slice 4b — cryptographic integrity (Phase 1):
//   • The Worker computes SHA-256 of the sealed PDF bytes (after the
//     signature stamp + COC are baked in).
//   • It signs that digest with an ECDSA P-256 key held as a Worker
//     secret (RR_SIGNING_PRIVATE_JWK). The matching public key is
//     exposed via GET /public-key so verifiers can validate the seal
//     without our private material.
//   • A JSON sidecar is written to <dsp>/seal/<id>.json containing
//     the digest, signature, key fingerprint, and timestamps — this
//     means the sealed PDF bytes stay byte-identical to what you'd
//     hand to a court while the proof lives next to it.
//   • The Certificate of Completion prints the digest + signature
//     fingerprint, and a `pdf_signed` event lands on the audit chain.
//
// If RR_SIGNING_PRIVATE_JWK isn't set, sealing degrades to the
// previous (uncryptographic) behavior — the sealed PDF + COC still
// upload, just without the sidecar.
//
// Slice 4b Phase 2 — RFC 3161 trusted timestamp:
//   • After signing, the Worker builds an ASN.1 TimeStampReq for the
//     sealed PDF's SHA-256 and POSTs it to a Time Stamping Authority
//     (RR_TSA_URL, default FreeTSA). The TSA returns a TimeStampResp
//     whose embedded TimeStampToken (a PKCS#7 SignedData) attests
//     "this exact hash existed at or before time T" — signed by the
//     TSA, not by us. We store the response bytes verbatim in the
//     sidecar as `tst_b64`, plus the TSA URL and a best-effort parse
//     of the token's genTime for display.
//   • If the TSA is unreachable or returns an error, the seal still
//     ships — `tst_b64` is just omitted (degrades like the rest).
//
// Inputs (POST JSON body): { envelope_id: string }
// Auth: Authorization: Bearer <SEALING_SECRET>

import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";


// Constant-time string compare for the shared-secret bearer — `!==`
// short-circuits on the first differing byte. Workers lack Node's
// crypto.timingSafeEqual, so walk every byte unconditionally.
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  return diff === 0;
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SEALING_SECRET: string;
  // ECDSA P-256 private key in JWK JSON form. Generate locally with:
  //   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
  //   openssl ec -in key.pem -text -noout    # inspect
  //   then convert to JWK and `wrangler secret put RR_SIGNING_PRIVATE_JWK`.
  // If unset, sealing skips the cryptographic step gracefully.
  RR_SIGNING_PRIVATE_JWK?: string;
  // Optional human-readable identifier for the active key, written into
  // every seal — useful when you rotate keys and need to know which
  // public key validates which seal.
  RR_SIGNING_KEY_ID?: string;
  // RFC 3161 Time Stamping Authority endpoint. Defaults to FreeTSA's
  // public service. Set to a commercial TSA if you want an SLA.
  RR_TSA_URL?: string;
  // Where to fetch the official USCIS Form I-9 fillable PDF. Defaults to
  // the USCIS URL; override if it moves or you want to pin an edition.
  // If unreachable / unparseable, the sealer falls back to RouteReady's
  // faithful reproduction.
  RR_I9_FORM_URL?: string;
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
    id?: string;
    kind?: string;
    label?: string;
    page?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }>;
  field_values?: Record<string, unknown> | null;
  status: string;
  signed_at: string | null;
  sent_at: string;
  signed_pdf_path: string | null;
  certificate_pdf_path: string | null;
  seal_path: string | null;
}

interface Template {
  id: string;
  title: string;
  source_path: string;
  source_hash: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Public-key endpoint — anyone can fetch this. Returns the
    // ECDSA P-256 public JWK that validates seals we produce. Used by
    // future external verifiers (slice 5) and is also documented for
    // counterparties who want to verify a sealed PDF independently.
    if (req.method === "GET" && url.pathname === "/public-key") {
      try {
        const pub = await loadPublicKeyJwk(env);
        if (!pub) return json({ error: "signing_key_not_configured" }, 404);
        return json(pub, 200, { "Cache-Control": "public, max-age=300" });
      } catch (err) {
        return json({ error: String((err as Error)?.message || err) }, 500);
      }
    }

    // Diagnostic: probe each configured TSA with a fixed hash and report
    // exactly what came back (status, content-type, response prefix,
    // parsed PKI status, genTime, or the error). No auth — it leaks
    // nothing sensitive, just whether the TSA is reachable from here.
    if (req.method === "GET" && url.pathname === "/timestamp-test") {
      const urls = env.RR_TSA_URL ? env.RR_TSA_URL.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TSA_URLS;
      const fixed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rr-tsa-test")));
      const reqDer = buildTimeStampReq(fixed);
      const out: unknown[] = [];
      for (const u of urls) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12_000);
        try {
          const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/timestamp-query", "Accept": "application/timestamp-reply" }, body: reqDer, signal: ctrl.signal });
          const buf = new Uint8Array(await r.arrayBuffer());
          const hex = Array.from(buf.slice(0, 40)).map((b) => b.toString(16).padStart(2, "0")).join("");
          out.push({ url: u, ok: r.ok, status: r.status, contentType: r.headers.get("content-type"), bodyLen: buf.byteLength, bodyHexPrefix: hex, pkiStatus: r.ok ? readTsaStatus(buf) : null, genTime: r.ok ? extractGenTime(buf) : null });
        } catch (err) {
          out.push({ url: u, error: String((err as Error)?.message || err) });
        } finally { clearTimeout(t); }
      }
      return json({ reqDerLen: reqDer.byteLength, results: out }, 200);
    }

    // Diagnostic: fetch the official USCIS Form I-9 and report every
    // AcroForm field — name, type, options (for dropdowns), the page it
    // lives on, and its rectangle. Used to build/verify the field map in
    // tryFillOfficialI9. No auth — it leaks nothing (just the blank form's
    // structure).
    if (req.method === "GET" && url.pathname === "/i9-form-fields") {
      const formUrl = env.RR_I9_FORM_URL || "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf";
      try {
        const r = await fetch(formUrl, { headers: { "User-Agent": "rr-document-sealing", "Accept": "application/pdf" } });
        if (!r.ok) return json({ error: `fetch failed: HTTP ${r.status}`, url: formUrl }, 502);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
        let form;
        try { form = doc.getForm(); } catch (e) { return json({ error: "no AcroForm", detail: String((e as Error)?.message || e), bytes: bytes.byteLength }, 200); }
        const fields = form.getFields().map((f) => {
          let rect: number[] | null = null;
          try {
            const w = (f as unknown as { acroField: { getWidgets(): Array<{ getRectangle(): { x: number; y: number; width: number; height: number } }> } }).acroField.getWidgets()[0];
            if (w) { const r = w.getRectangle(); rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }
          } catch { /* widgetless or unsupported */ }
          let options: string[] | undefined;
          try { if (f instanceof PDFDropdown) options = (f as PDFDropdown).getOptions(); } catch { /* ignore */ }
          return { name: f.getName(), type: f.constructor.name, options, rect };
        });
        return json({ url: formUrl, bytes: bytes.byteLength, fieldCount: fields.length, fields }, 200);
      } catch (err) {
        return json({ error: String((err as Error)?.message || err), url: formUrl }, 500);
      }
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    // Shared-secret auth between the Postgres trigger and the Worker.
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.SEALING_SECRET || !timingSafeEqualStr(token, env.SEALING_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as { envelope_id?: string; i9_record_id?: string; force?: boolean };

    // Form I-9 sealing path: render the completed form to a PDF, append
    // a Certificate of Completion, seal + timestamp it, and call
    // i9_log_sealed back. Same security envelope as the e-sign documents.
    if (body?.i9_record_id) {
      try {
        const result = await sealI9(body.i9_record_id, env, body?.force === true);
        return json(result, 200);
      } catch (err) {
        console.error("sealI9 failed:", err);
        return json({ error: String((err as Error)?.message || err) }, 500);
      }
    }

    const envelopeId = body?.envelope_id;
    if (!envelopeId) return json({ error: "missing_envelope_id" }, 400);

    try {
      const result = await sealEnvelope(envelopeId, env, body?.force === true);
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

async function sealEnvelope(envelopeId: string, env: Env, force = false) {
  // 1. Envelope + template.
  const envelope = await sb<Envelope>(env, `document_envelopes?id=eq.${envelopeId}&select=*`);
  if (!envelope[0]) throw new Error("envelope_not_found");
  const env_ = envelope[0];
  if (env_.status !== "signed") return { skipped: "not_signed", status: env_.status };
  // Already sealed → skip, unless this is an explicit re-seal (force).
  // We don't null the paths here on force; the new artifacts overwrite
  // the old ones on success (x-upsert), so a failed re-seal leaves the
  // existing seal intact.
  if (env_.signed_pdf_path && !force) return { skipped: "already_sealed", path: env_.signed_pdf_path };

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

  // 3b. Load the signing key metadata up front. The key id +
  // fingerprint don't depend on the PDF bytes, so we can print them
  // inside the embedded Certificate of Completion. The actual digest
  // + signature can only be computed *after* the final PDF exists —
  // and would be circular if printed inside it — so those go in the
  // sidecar JSON (and the standalone COC, which is a separate file).
  const keyMeta = await loadSealKeyMeta(env);
  const sealPath = `${env_.dsp_id}/seal/${env_.id}.json`;
  const sealStub: SealStub | null = keyMeta
    ? { key_id: keyMeta.key_id, key_fingerprint: keyMeta.key_fingerprint, seal_path: sealPath }
    : null;

  // 4. Stamp the signature into the PDF + append the Certificate of
  // Completion (with the seal stub if we have a key).
  const pdf = await PDFDocument.load(sourceBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvMono = await pdf.embedFont(StandardFonts.Courier);
  await stampSignature(pdf, env_, sigMethod, sigData, typedName, helvBold);
  await appendCertificate(pdf, env_, tpl, events, helv, helvBold, helvMono, sealStub, null);
  const sealedBytes = await pdf.save();

  // 5. Cryptographic seal: ECDSA P-256 signature over the sealed PDF's
  // SHA-256 (Phase 1) + an RFC 3161 trusted timestamp on the same
  // digest (Phase 2). Both null if not configured / unreachable.
  let sealInfo = keyMeta ? await signBytes(keyMeta, env_.id, sealedBytes) : null;
  let tsaError: string | null = null;
  if (sealInfo) {
    const ts = await maybeTimestamp(env, sealedBytes);
    if (ts.info) sealInfo = { ...sealInfo, ...ts.info };
    if (ts.error) tsaError = ts.error;
  }
  const sidecarBytes = sealInfo
    ? new TextEncoder().encode(JSON.stringify(sealInfo, null, 2))
    : null;

  // 6. Save the Certificate of Completion as a standalone PDF — this
  // one isn't part of the sealed bytes, so it can print the full
  // digest + signature fingerprint.
  const certPdf = await PDFDocument.create();
  const certHelv = await certPdf.embedFont(StandardFonts.Helvetica);
  const certHelvBold = await certPdf.embedFont(StandardFonts.HelveticaBold);
  const certMono = await certPdf.embedFont(StandardFonts.Courier);
  await appendCertificate(certPdf, env_, tpl, events, certHelv, certHelvBold, certMono, sealStub, sealInfo);
  const certBytes = await certPdf.save();

  // 7. Upload to <dsp>/signed/<envelope>.pdf, <dsp>/certificates/<envelope>.pdf,
  // and (if sealed) <dsp>/seal/<envelope>.json.
  const sealedPath = `${env_.dsp_id}/signed/${env_.id}.pdf`;
  const certPath = `${env_.dsp_id}/certificates/${env_.id}.pdf`;
  // sealPath was computed in step 3b.
  await uploadStorage(env, "documents", sealedPath, sealedBytes, "application/pdf");
  await uploadStorage(env, "documents", certPath,   certBytes,   "application/pdf");
  if (sidecarBytes) {
    await uploadStorage(env, "documents", sealPath, sidecarBytes, "application/json");
  }

  // 8. Update the envelope row with the storage paths.
  await sbPatch(env, `document_envelopes?id=eq.${env_.id}`, {
    signed_pdf_path:      sealedPath,
    certificate_pdf_path: certPath,
    seal_path:            sidecarBytes ? sealPath : null,
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

  // 10. If we cryptographically sealed, append a `pdf_signed` event
  // documenting the seal. Best-effort — the sealed PDF + sidecar
  // already make the proof verifiable independently of the chain.
  // (Goes through document_log_signed, the public service-role wrapper;
  // append_document_event itself is private-only.)
  if (sealInfo) {
    await sbRpc(env, "document_log_signed", {
      p_envelope_id: env_.id,
      p_event_data: {
        seal_path:        sealPath,
        pdf_sha256:       sealInfo.pdf_sha256,
        signature_alg:    sealInfo.signature_alg,
        signature_b64:    sealInfo.signature_b64,
        key_id:           sealInfo.key_id,
        key_fingerprint:  sealInfo.key_fingerprint,
        signed_at:        sealInfo.signed_at,
        tsa_url:          sealInfo.tsa_url ?? null,
        tsa_gen_time:     sealInfo.tsa_gen_time ?? null,
        has_tst:          !!sealInfo.tst_b64,
        tsa_error:        sealInfo.tst_b64 ? null : (tsaError ?? null),
      },
    }).catch((err) => {
      console.error("pdf_signed audit log failed", err);
    });
  }

  return {
    ok: true,
    envelope_id:           env_.id,
    signed_pdf_path:       sealedPath,
    certificate_pdf_path:  certPath,
    seal_path:             sidecarBytes ? sealPath : null,
    sealed_byte_count:     sealedBytes.byteLength,
    sealed:                !!sealInfo,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Form I-9 sealing — render the completed form to a real PDF, append a
// Certificate of Completion, then run it through the same seal pipeline
// (ECDSA P-256 over SHA-256 + RFC 3161 timestamp + JSON sidecar).
// ─────────────────────────────────────────────────────────────────────────

interface I9Record {
  id: string;
  dsp_id: string;
  driver_id: string;
  status: string;
  first_day_of_employment: string | null;
  section1: Record<string, unknown> | null;
  section1_signature: Record<string, unknown> | null;
  section1_completed_at: string | null;
  section1_completed_via: string | null;
  section1_consent_text: string | null;
  section2: Record<string, unknown> | null;
  section2_signature: Record<string, unknown> | null;
  section2_document_paths: string[] | null;
  section2_completed_at: string | null;
  section2_completed_by_name: string | null;
  section2_completed_by_title: string | null;
  section2_consent_text: string | null;
  needs_correction_note: string | null;
  pdf_path: string | null;
}
interface I9Event {
  id: number;
  kind: string;
  actor_kind: string;
  actor_name: string | null;
  ip: string | null;
  event_data: Record<string, unknown> | null;
  created_at: string;
}
interface DriverRow { id: string; full_name: string; preferred_name: string | null; first_name: string | null; last_name: string | null; }
interface DspRow { id: string; name: string; business_address?: string | null; address?: string | null; }

async function sealI9(i9RecordId: string, env: Env, force = false) {
  const recArr = await sb<I9Record>(env, `i9_records?id=eq.${i9RecordId}&select=*`);
  if (!recArr[0]) throw new Error("i9_not_found");
  const rec = recArr[0];
  if (rec.status !== "verified") return { skipped: "not_verified", status: rec.status };
  if (rec.pdf_path && !force) return { skipped: "already_sealed", path: rec.pdf_path };

  const drvArr = await sb<DriverRow>(env, `drivers?id=eq.${rec.driver_id}&select=id,full_name,preferred_name,first_name,last_name`);
  const dspArr = await sb<DspRow>(env, `dsps?id=eq.${rec.dsp_id}&select=id,name,business_address,address`);
  const drv = drvArr[0] || { id: rec.driver_id, full_name: "Employee", preferred_name: null, first_name: null, last_name: null };
  const dsp = dspArr[0] || { id: rec.dsp_id, name: "Employer" };
  const events = await sb<I9Event>(env, `i9_events?i9_record_id=eq.${i9RecordId}&order=id.asc&select=id,kind,actor_kind,actor_name,ip,event_data,created_at`);

  const keyMeta = await loadSealKeyMeta(env);
  const sealPath = `${rec.dsp_id}/i9-seal/${rec.id}.json`;
  const sealStub: SealStub | null = keyMeta
    ? { key_id: keyMeta.key_id, key_fingerprint: keyMeta.key_fingerprint, seal_path: sealPath }
    : null;

  // Build the form PDF (official USCIS form if reachable, else our
  // reproduction) + embedded Certificate of Completion.
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const formInfo = await buildI9Pdf(pdf, rec, drv, dsp, helv, bold, env);
  await appendI9Certificate(pdf, rec, dsp, events, helv, bold, mono, sealStub, null, formInfo.source);
  const sealedBytes = await pdf.save();

  let sealInfo = keyMeta ? await signBytes(keyMeta, rec.id, sealedBytes) : null;
  let tsaError: string | null = null;
  if (sealInfo) {
    const ts = await maybeTimestamp(env, sealedBytes);
    if (ts.info) sealInfo = { ...sealInfo, ...ts.info };
    if (ts.error) tsaError = ts.error;
  }
  const sidecarBytes = sealInfo ? new TextEncoder().encode(JSON.stringify(sealInfo, null, 2)) : null;

  // Standalone Certificate of Completion (separate file → can print the
  // full digest + signature without circularity).
  const certPdf = await PDFDocument.create();
  const certHelv = await certPdf.embedFont(StandardFonts.Helvetica);
  const certBold = await certPdf.embedFont(StandardFonts.HelveticaBold);
  const certMono = await certPdf.embedFont(StandardFonts.Courier);
  await appendI9Certificate(certPdf, rec, dsp, events, certHelv, certBold, certMono, sealStub, sealInfo, formInfo.source);
  const certBytes = await certPdf.save();

  const pdfPath  = `${rec.dsp_id}/i9/${rec.id}.pdf`;
  const certPath = `${rec.dsp_id}/i9-certificates/${rec.id}.pdf`;
  await uploadStorage(env, "documents", pdfPath,  sealedBytes, "application/pdf");
  await uploadStorage(env, "documents", certPath, certBytes,   "application/pdf");
  if (sidecarBytes) await uploadStorage(env, "documents", sealPath, sidecarBytes, "application/json");

  await sbRpc(env, "i9_log_sealed", {
    p_i9_record_id:    rec.id,
    p_pdf_path:        pdfPath,
    p_certificate_path: certPath,
    p_seal_path:       sidecarBytes ? sealPath : null,
    p_byte_count:      sealedBytes.byteLength,
    p_pdf_sha256:      sealInfo?.pdf_sha256 ?? null,
    p_signature_b64:   sealInfo?.signature_b64 ?? null,
    p_key_fingerprint: sealInfo?.key_fingerprint ?? null,
    p_tsa_url:         sealInfo?.tsa_url ?? null,
    p_tsa_gen_time:    sealInfo?.tsa_gen_time ?? null,
  }).catch((err) => { throw new Error("i9_log_sealed failed: " + String((err as Error)?.message || err)); });

  return {
    ok: true,
    i9_record_id:        rec.id,
    pdf_path:            pdfPath,
    certificate_pdf_path: certPath,
    seal_path:           sidecarBytes ? sealPath : null,
    byte_count:          sealedBytes.byteLength,
    sealed:              !!sealInfo,
    form_source:         formInfo.source,
    form_detail:         formInfo.detail ?? null,
    tsa_error:           sealInfo && !sealInfo.tst_b64 ? tsaError : null,
  };
}

const I9_CIT_LABELS: Record<string, string> = {
  citizen: "A citizen of the United States",
  national: "A noncitizen national of the United States",
  lpr: "A lawful permanent resident",
  authorized: "A noncitizen authorized to work in the United States",
};

// Build the I-9 form pages into `pdf`. Preferred path: fetch the official
// USCIS fillable Form I-9, fill its AcroForm fields from the captured
// data, flatten it, and append an "Electronic Signature Record" page
// (the official form's signature lines can't carry our images). If the
// official PDF is unreachable / unparseable / has no fields, fall back
// to RouteReady's faithful reproduction. Returns which path was used.
async function buildI9Pdf(
  pdf: PDFDocument, rec: I9Record, drv: DriverRow, dsp: DspRow, helv: PDFFont, bold: PDFFont, env: Env,
): Promise<{ source: "official_form" | "reproduction"; detail?: string }> {
  const url = env.RR_I9_FORM_URL || "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    let bytes: Uint8Array;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "rr-document-sealing", "Accept": "application/pdf" }, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      bytes = new Uint8Array(await r.arrayBuffer());
    } finally { clearTimeout(t); }
    if (bytes.byteLength < 10_000) throw new Error("response too small to be the form");
    const official = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
    let form;
    try { form = official.getForm(); } catch { form = null; }
    const fields = form ? form.getFields() : [];
    if (!form || fields.length === 0) throw new Error("no AcroForm fields");
    const sigRects = tryFillOfficialI9(fields, rec, dsp);
    try { form.flatten(); } catch (e) { console.warn("i9 form flatten failed (filled fields kept):", e); }
    const pages = await pdf.copyPages(official, official.getPageIndices());
    for (const p of pages) pdf.addPage(p);
    // Stamp the captured signatures onto the form's signature lines
    // (Section 1 + Section 2 are both on page 1 of the official form).
    if (pages[0]) {
      await stampSigOnPage(pdf, pages[0], sigRects.employeeSigRect, rec.section1_signature);
      await stampSigOnPage(pdf, pages[0], sigRects.employerSigRect, rec.section2_signature);
    }
    await appendI9SignaturePage(pdf, rec, drv, dsp, helv, bold);
    return { source: "official_form" };
  } catch (e) {
    console.warn("official Form I-9 unavailable — using reproduction:", (e as Error)?.message || e);
    await buildI9Reproduction(pdf, rec, drv, dsp, helv, bold);
    return { source: "reproduction", detail: String((e as Error)?.message || e) };
  }
}

// Fill the official USCIS Form I-9 AcroForm — exact field names for the
// current edition (01/20/25), with looser aliases as fallbacks for other
// editions. Field names are normalised (lowercase; _ - . [] () → spaces;
// collapsed) before an *equality* lookup, so `Last_Name_Family_Name[0]`
// and `Last Name (Family Name)` both resolve. Returns the page-1
// rectangles of the two signature lines so the caller can stamp the
// captured signature images onto them after flattening.
function tryFillOfficialI9(
  fields: ReturnType<NonNullable<ReturnType<PDFDocument["getForm"]>>["getFields"]>,
  rec: I9Record, dsp: DspRow,
): { employeeSigRect: number[] | null; employerSigRect: number[] | null } {
  const s1 = (rec.section1 || {}) as Record<string, string>;
  const s2 = (rec.section2 || {}) as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[_\-./\\]+/g, " ").replace(/[[\]()]+/g, " ").replace(/\s+/g, " ").trim();
  const byNorm = new Map<string, (typeof fields)[number]>();
  for (const f of fields) { const k = norm(f.getName()); if (!byNorm.has(k)) byNorm.set(k, f); }
  const used = new Set<unknown>();
  const find = (names: string[]) => { for (const nm of names) { const f = byNorm.get(norm(nm)); if (f && !used.has(f)) return f; } return null; };
  const setT = (value: string | null | undefined, ...names: string[]) => {
    if (value == null || value === "") return;
    const f = find(names);
    if (!f) return;
    used.add(f);
    try {
      if (f instanceof PDFDropdown) { const v = String(value).trim().toUpperCase(); try { f.select(v); } catch { /* not a valid option — leave blank */ } }
      else if (f instanceof PDFTextField) f.setText(String(value));
    } catch { /* ignore */ }
  };
  const check = (...names: string[]) => { const f = find(names); if (f instanceof PDFCheckBox) { used.add(f); try { f.check(); } catch { /* ignore */ } } };
  const rectOf = (...names: string[]): number[] | null => {
    for (const nm of names) {
      const f = byNorm.get(norm(nm)); if (!f) continue;
      try {
        const w = (f as unknown as { acroField: { getWidgets(): Array<{ getRectangle(): { x: number; y: number; width: number; height: number } }> } }).acroField.getWidgets()[0];
        if (w) { const r = w.getRectangle(); return [r.x, r.y, r.width, r.height]; }
      } catch { /* ignore */ }
    }
    return null;
  };
  const mmddyyyy = (iso?: string | null) => { if (!iso) return ""; const d = new Date(/T/.test(iso) ? iso : iso + "T12:00:00Z"); if (isNaN(d.getTime())) return ""; const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`; };

  // ── Section 1 — Employee Information and Attestation ──
  setT(s1.last_name, "Last Name (Family Name)", "Last Name Family Name", "last name");
  setT(s1.first_name, "First Name Given Name", "First Name (Given Name)", "first name");
  setT(s1.middle_initial, "Employee Middle Initial (if any)", "Middle Initial (if any)", "middle initial");
  setT(s1.other_last_names, "Employee Other Last Names Used (if any)", "Other Last Names Used (if any)", "other last names used");
  setT(s1.addr_street, "Address Street Number and Name", "Address (Street Number and Name)", "address street number and name");
  setT(s1.addr_apt, "Apt Number (if any)", "Apt. Number (if any)", "apt number");
  setT(s1.addr_city, "City or Town", "city or town");
  setT(s1.addr_state, "State", "state");
  setT(s1.addr_zip, "ZIP Code", "Zip Code", "zip code");
  setT(mmddyyyy(s1.dob), "Date of Birth mmddyyyy", "Date of Birth (mm/dd/yyyy)", "date of birth mmddyyyy", "date of birth");
  setT(s1.ssn, "US Social Security Number", "U.S. Social Security Number", "us social security number");
  setT(s1.email, "Employees E-mail Address", "Employee's Email Address", "employees e mail address", "employee s email address");
  setT(s1.phone, "Telephone Number", "Employee's Telephone Number", "telephone number");
  // Citizenship attestation — CB_1..CB_4 on 01/20/25.
  const cs = s1.citizen_status;
  if (cs === "citizen")    check("CB_1", "1 A citizen of the United States", "citizen of the united states");
  if (cs === "national")   check("CB_2", "2 A noncitizen national of the United States", "noncitizen national");
  if (cs === "lpr")        check("CB_3", "3 A lawful permanent resident", "lawful permanent resident");
  if (cs === "authorized") check("CB_4", "4 A noncitizen authorized to work", "noncitizen authorized to work", "authorized to work");
  if (cs === "lpr") setT(s1.lpr_uscis_number, "3 A lawful permanent resident Enter USCIS or ANumber", "uscis a number", "uscis or a number");
  if (cs === "authorized") {
    setT(mmddyyyy(s1.auth_expires) || (s1.auth_expires || "N/A"), "Exp Date mmddyyyy", "exp date mmddyyyy", "expiration date mm dd yyyy");
    if (s1.auth_doc_kind === "uscis")    setT(s1.auth_doc_number, "USCIS ANumber", "uscis a number", "uscis a-number");
    if (s1.auth_doc_kind === "i94")      setT(s1.auth_doc_number, "Form I94 Admission Number", "form i 94 admission number", "i94 admission number");
    if (s1.auth_doc_kind === "passport") setT([s1.auth_doc_number, s1.auth_passport_country].filter(Boolean).join(" — "), "Foreign Passport Number and Country of IssuanceRow1", "foreign passport number and country of issuance");
  }
  setT(mmddyyyy(rec.section1_completed_at), "Today's Date mmddyyy", "Today's Date (mm/dd/yyyy)", "todays date mmddyyy", "today s date mmddyyy");

  // ── Section 2 — Employer Review and Verification ──
  setT(mmddyyyy(rec.first_day_of_employment), "FirstDayEmployed mmddyyyy", "first day employed mmddyyyy", "first day of employment");
  const docs = Array.isArray(s2.documents) ? (s2.documents as Array<Record<string, string>>) : [];
  if ((s2.list_used as string) === "A") {
    const d = docs[0] || {};
    setT(d.title, "Document Title 1", "list a document title 1");
    setT(d.issuing_authority, "Issuing Authority 1", "list a issuing authority 1");
    setT(d.number, "Document Number 0 (if any)", "list a document number 1");
    setT(mmddyyyy(d.expires_on), "Expiration Date if any", "list a expiration date 1");
  } else {
    const b = docs.find((x) => x.list === "B") || docs[0] || {};
    const c = docs.find((x) => x.list === "C") || docs[1] || {};
    setT(b.title, "List B Document 1 Title", "list b document title 1");
    setT(b.issuing_authority, "List B Issuing Authority 1");
    setT(b.number, "List B Document Number 1");
    setT(mmddyyyy(b.expires_on), "List B Expiration Date 1");
    setT(c.title, "List C Document Title 1");
    setT(c.issuing_authority, "List C Issuing Authority 1");
    setT(c.number, "List C Document Number 1");
    setT(mmddyyyy(c.expires_on), "List C Expiration Date 1");
  }
  if (s2.exam_method === "remote_alternative") check("CB_Alt", "check here if you used an alternative procedure");
  if (s2.additional_info) setT(String(s2.additional_info), "Additional Information", "additional information");
  const repName = (rec.section2_completed_by_name || "").trim();
  const repLast = repName ? repName.split(/\s+/).slice(-1)[0] : "";
  const repFirst = repName ? (repName.split(/\s+/).slice(0, -1).join(" ") || "") : "";
  const repTitle = (rec.section2_completed_by_title || "").trim();
  setT([repLast || repName, repFirst, repTitle].filter(Boolean).join(", "),
    "Last Name First Name and Title of Employer or Authorized Representative",
    "last name first name and title of employer or authorized representative",
    "last name first name and title employer");
  // Editions that split the fields:
  setT(repLast, "Last Name of Employer or Authorized Representative", "last name of employer");
  setT(repFirst, "First Name of Employer or Authorized Representative", "first name of employer");
  setT(repTitle, "Title of Employer or Authorized Representative", "title of employer");
  setT(dsp.name, "Employers Business or Org Name", "Employer's Business or Organization Name", "employers business or org name");
  setT((dsp.business_address || dsp.address || "").replace(/\s*\n+\s*/g, ", ").trim(),
    "Employers Business or Org Address", "Employer's Business or Organization Address", "employers business or org address");
  setT(mmddyyyy(rec.section2_completed_at), "S2 Todays Date mmddyyyy", "s2 todays date mmddyyyy", "todays date section 2");

  return {
    employeeSigRect: rectOf("Signature of Employee", "signature of employee"),
    employerSigRect: rectOf("Signature of Employer or AR", "signature of employer or ar", "signature of employer or authorized representative"),
  };
}

// Stamp a captured signature (drawn image or typed text) onto a page at
// the given rect [x, y, w, h] (PDF coords, bottom-left origin).
async function stampSigOnPage(pdf: PDFDocument, page: PDFPage, rect: number[] | null, sig: Record<string, unknown> | null) {
  if (!rect || !sig || typeof sig !== "object") return;
  const method = sig.method as string | undefined;
  const data = sig.data as string | undefined;
  const pad = 2, [x, y, w, h] = rect;
  // The official form's "Signature" field is just a thin line — render the
  // captured signature at a legible height (≈22pt), sitting on the line and
  // overflowing upward into the cell's whitespace.
  const targetH = Math.max(h, 22);
  if (method === "drawn" && typeof data === "string" && data.startsWith("data:image")) {
    try {
      const img = data.includes("image/png") ? await pdf.embedPng(data) : await pdf.embedJpg(data);
      const sc = Math.min((w - pad * 2) / img.width, (targetH - pad) / img.height);
      page.drawImage(img, { x: x + pad, y: y + 1, width: img.width * sc, height: img.height * sc });
      return;
    } catch { /* fall through to text */ }
  }
  const txt = (typeof data === "string" && data) || (typeof sig.signer_name === "string" ? sig.signer_name as string : "");
  if (txt) { try { page.drawText(String(txt).slice(0, 60), { x: x + pad, y: y + 2, size: Math.min(16, targetH - 4), color: rgb(0.07, 0.09, 0.13) }); } catch { /* ignore */ } }
}

async function appendI9SignaturePage(pdf: PDFDocument, rec: I9Record, drv: DriverRow, dsp: DspRow, helv: PDFFont, bold: PDFFont) {
  const s1 = (rec.section1 || {}) as Record<string, string>;
  const ink = rgb(0.07, 0.09, 0.13), grey = rgb(0.40, 0.45, 0.52), lite = rgb(0.62, 0.66, 0.72);
  const page = pdf.addPage([612, 792]); const M = 48; let y = 740;
  const text = (s: string, x: number, o?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> }) => page.drawText(s ?? "", { x, y, size: o?.size ?? 9, font: o?.font ?? helv, color: o?.color ?? ink, maxWidth: 612 - M * 2 });
  const line = (s: string, o?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> }) => { text(s, M, o); y -= (o?.size ?? 9) + 6; };
  const fmtD = (x?: string | null) => x ? new Date(/T/.test(x) ? x : x + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "—";
  const sigBox = async (sig: Record<string, unknown> | null, fallbackName: string, dateIso: string | null, label: string, sub: string) => {
    const boxW = (612 - M * 2) * 0.62, boxH = 44;
    page.drawRectangle({ x: M, y: y - boxH, width: boxW, height: boxH, borderColor: lite, borderWidth: 0.7 });
    const method = sig && typeof sig === "object" ? (sig.method as string) : null;
    const data = sig && typeof sig === "object" ? (sig.data as string) : null;
    if (method === "drawn" && typeof data === "string" && data.startsWith("data:image")) {
      try { const png = data.includes("image/png") ? await pdf.embedPng(data) : await pdf.embedJpg(data); const sc = Math.min((boxW - 10) / png.width, (boxH - 10) / png.height); page.drawImage(png, { x: M + 5, y: y - boxH + 5, width: png.width * sc, height: png.height * sc }); }
      catch { page.drawText(fallbackName, { x: M + 8, y: y - boxH / 2, size: 15, font: helv, color: ink }); }
    } else { page.drawText((data && method === "typed" ? data : fallbackName) || "—", { x: M + 8, y: y - boxH / 2 + 2, size: 17, font: helv, color: ink }); }
    page.drawText(label, { x: M, y: y - boxH - 11, size: 7, font: helv, color: grey });
    const dx = M + boxW + 18;
    page.drawText("DATE", { x: dx, y, size: 7, font: helv, color: grey });
    page.drawText(dateIso ? new Date(dateIso).toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—", { x: dx, y: y - 14, size: 11, font: helv, color: ink });
    page.drawLine({ start: { x: dx, y: y - 17 }, end: { x: 612 - M, y: y - 17 }, thickness: 0.6, color: lite });
    y -= boxH + 22;
    if (sub) { text(sub, M, { size: 7.5, color: grey }); y -= 14; }
  };
  text("Form I-9 — Electronic Signature Record", M, { font: bold, size: 15 }); y -= 20;
  line(`Attached to the official Form I-9 above for ${[s1.first_name, s1.middle_initial, s1.last_name].filter(Boolean).join(" ") || (drv.preferred_name || drv.full_name)} · ${dsp.name}.`, { size: 9, color: grey });
  line("The official USCIS form's signature lines cannot carry an electronic signature image; the captured signatures and their provenance are recorded here, and the whole document is cryptographically sealed and timestamped on the Certificate of Completion that follows.", { size: 8, color: lite });
  y -= 8;
  line("SECTION 1 — EMPLOYEE", { font: bold, size: 9, color: grey });
  await sigBox(rec.section1_signature, [s1.first_name, s1.last_name].filter(Boolean).join(" ") || (drv.preferred_name || drv.full_name) || "Employee", rec.section1_completed_at, "Signature of employee",
    `Completed ${rec.section1_completed_at ? new Date(rec.section1_completed_at).toLocaleString() : "—"}${rec.section1_completed_via ? " · " + (rec.section1_completed_via === "driver_app" ? "signed electronically by the employee in the RouteReady app" : "recorded by the employer on the employee's behalf") : ""}.`);
  y -= 6;
  line("SECTION 2 — EMPLOYER OR AUTHORIZED REPRESENTATIVE", { font: bold, size: 9, color: grey });
  await sigBox(rec.section2_signature, rec.section2_completed_by_name || "Employer representative", rec.section2_completed_at, "Signature of employer or authorized representative",
    `${rec.section2_completed_by_name || "—"}${rec.section2_completed_by_title ? ", " + rec.section2_completed_by_title : ""} · ${dsp.name} · verified ${rec.section2_completed_at ? new Date(rec.section2_completed_at).toLocaleString() : "—"} · examined ${(((rec.section2 || {}) as Record<string, unknown>).exam_method) === "remote_alternative" ? "remotely under the DHS-authorized alternative procedure" : "physically, in person"}.`);
  y -= 8;
  line(`Retain Form I-9 until at least ${fmtD((function () { const base = rec.first_day_of_employment || null; if (!base) return null; const d = new Date(base + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + 3); return d.toISOString().slice(0, 10); })())} — 3 years after the date employment began, or 1 year after employment ends, whichever is later. Not legal advice.`, { size: 8, color: lite });
}

// A faithful reproduction of Form I-9 (USCIS edition 08/01/23) drawn
// from the captured data — used when the official PDF can't be fetched.
async function buildI9Reproduction(
  pdf: PDFDocument, rec: I9Record, drv: DriverRow, dsp: DspRow, helv: PDFFont, bold: PDFFont,
) {
  const s1 = (rec.section1 || {}) as Record<string, string>;
  const s2 = (rec.section2 || {}) as Record<string, unknown>;
  const ink = rgb(0.07, 0.09, 0.13);
  const grey = rgb(0.40, 0.45, 0.52);
  const lite = rgb(0.62, 0.66, 0.72);
  const PW = 612, PH = 792, M = 48;
  let page = pdf.addPage([PW, PH]);
  let y = PH - 50;
  const ensure = (need: number) => { if (y < need) { page = pdf.addPage([PW, PH]); y = PH - 50; } };
  const text = (s: string, x: number, opts?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; maxWidth?: number }) => {
    page.drawText(s ?? "", { x, y, size: opts?.size ?? 9, font: opts?.font ?? helv, color: opts?.color ?? ink, maxWidth: opts?.maxWidth });
  };
  const line = (s: string, opts?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> }) => {
    const sz = opts?.size ?? 9; ensure(54);
    text(s, M, { ...opts, size: sz, maxWidth: PW - M * 2 });
    y -= sz + 5;
  };
  const rule = () => { ensure(54); page.drawLine({ start: { x: M, y: y + 4 }, end: { x: PW - M, y: y + 4 }, thickness: 0.6, color: lite }); y -= 8; };
  const sectionBar = (s: string) => { ensure(70); y -= 8; page.drawRectangle({ x: M, y: y - 4, width: PW - M * 2, height: 18, color: rgb(0.12, 0.16, 0.22) }); page.drawText(s, { x: M + 8, y: y, size: 10, font: bold, color: rgb(1, 1, 1) }); y -= 26; };
  // Two-column field rows.
  const field = (label: string, value: string, x: number, w: number) => {
    page.drawText(label.toUpperCase(), { x, y: y, size: 6.5, font: helv, color: grey });
    page.drawText(value || " ", { x, y: y - 11, size: 10, font: helv, color: ink, maxWidth: w });
    page.drawLine({ start: { x, y: y - 14 }, end: { x: x + w, y: y - 14 }, thickness: 0.5, color: lite });
  };
  const row2 = (l1: string, v1: string, l2: string, v2: string) => {
    ensure(60); const colW = (PW - M * 2 - 16) / 2;
    field(l1, v1, M, colW); field(l2, v2, M + colW + 16, colW); y -= 24;
  };
  const row3 = (l1: string, v1: string, l2: string, v2: string, l3: string, v3: string) => {
    ensure(60); const colW = (PW - M * 2 - 32) / 3;
    field(l1, v1, M, colW); field(l2, v2, M + colW + 16, colW); field(l3, v3, M + (colW + 16) * 2, colW); y -= 24;
  };
  const para = (s: string, opts?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> }) => {
    const sz = opts?.size ?? 8; for (const ln of wrapText(s, Math.floor((PW - M * 2) / (sz * 0.52)))) { ensure(54); text(ln, M, { ...opts, size: sz, maxWidth: PW - M * 2 }); y -= sz + 3; }
  };
  const checkRow = (checked: boolean, num: number, label: string, extra?: string) => {
    ensure(56);
    page.drawRectangle({ x: M, y: y - 2, width: 10, height: 10, borderColor: ink, borderWidth: 1, color: checked ? rgb(0.12, 0.16, 0.22) : rgb(1, 1, 1) });
    if (checked) page.drawText("X", { x: M + 1.5, y: y - 1.5, size: 9, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`${num}. ${label}`, { x: M + 16, y: y, size: 9, font: helv, color: ink });
    if (extra) { y -= 12; page.drawText("   " + extra, { x: M + 16, y: y, size: 8, font: helv, color: grey }); }
    y -= 16;
  };
  const sigBlock = async (sig: Record<string, unknown> | null, fallbackName: string, dateIso: string | null, label: string) => {
    ensure(80);
    const boxW = (PW - M * 2) * 0.62, boxX = M, boxH = 40;
    page.drawRectangle({ x: boxX, y: y - boxH, width: boxW, height: boxH, borderColor: lite, borderWidth: 0.6 });
    const method = sig && typeof sig === "object" ? (sig.method as string) : null;
    const data = sig && typeof sig === "object" ? (sig.data as string) : null;
    if (method === "drawn" && data && data.startsWith("data:image")) {
      try {
        const png = data.includes("image/png") ? await pdf.embedPng(data) : await pdf.embedJpg(data);
        const scale = Math.min((boxW - 8) / png.width, (boxH - 8) / png.height);
        page.drawImage(png, { x: boxX + 4, y: y - boxH + 4, width: png.width * scale, height: png.height * scale });
      } catch { page.drawText(fallbackName, { x: boxX + 6, y: y - boxH / 2, size: 14, font: helv, color: ink }); }
    } else {
      page.drawText((data && method === "typed" ? data : fallbackName) || "—", { x: boxX + 6, y: y - boxH / 2 + 2, size: 16, font: helv, color: ink });
    }
    page.drawText(label, { x: boxX, y: y - boxH - 10, size: 6.5, font: helv, color: grey });
    const dx = boxX + boxW + 16;
    page.drawText("DATE", { x: dx, y: y, size: 6.5, font: helv, color: grey });
    page.drawText(dateIso ? new Date(dateIso).toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—", { x: dx, y: y - 13, size: 10, font: helv, color: ink });
    page.drawLine({ start: { x: dx, y: y - 16 }, end: { x: PW - M, y: y - 16 }, thickness: 0.5, color: lite });
    y -= boxH + 20;
  };
  const fmtD = (x?: string | null) => x ? new Date(/T/.test(x) ? x : x + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }) : "";

  // ── Header ──
  text("Form I-9, Employment Eligibility Verification", M, { font: bold, size: 15 }); y -= 18;
  text("Department of Homeland Security · U.S. Citizenship and Immigration Services", M, { size: 8.5, color: grey }); y -= 14;
  para(`Reproduced from RouteReady's records for ${dsp.name} on ${new Date().toLocaleString()}. The official USCIS form is edition 08/01/23; this captures the same information and attestations. Not legal advice.`, { size: 7.5, color: lite });
  rule();

  // ── Section 1 ──
  sectionBar("Section 1.  Employee Information and Attestation");
  row3("Last name (family name)", s1.last_name || "", "First name (given name)", s1.first_name || "", "Middle initial", s1.middle_initial || "");
  row2("Other last names used (if any)", s1.other_last_names || "", "U.S. Social Security Number", s1.ssn || "");
  row3("Address (street number and name)", s1.addr_street || "", "Apt. number", s1.addr_apt || "", "City or town", s1.addr_city || "");
  row3("State", s1.addr_state || "", "ZIP code", s1.addr_zip || "", "Date of birth (mm/dd/yyyy)", fmtD(s1.dob));
  row2("Employee's email address", s1.email || "", "Employee's telephone number", s1.phone || "");
  y -= 4;
  line("I attest, under penalty of perjury, that I am (check one):", { font: bold, size: 8.5, color: grey });
  const cs = s1.citizen_status || "";
  checkRow(cs === "citizen", 1, I9_CIT_LABELS.citizen);
  checkRow(cs === "national", 2, I9_CIT_LABELS.national);
  checkRow(cs === "lpr", 3, I9_CIT_LABELS.lpr, cs === "lpr" ? `USCIS/A-Number: ${s1.lpr_uscis_number || "—"}` : undefined);
  let authExtra: string | undefined;
  if (cs === "authorized") {
    const kindLbl: Record<string, string> = { uscis: "USCIS/A-Number", i94: "Form I-94 Admission #", passport: "Foreign passport #" };
    authExtra = `Expires: ${s1.auth_expires || "N/A"}   ·   ${kindLbl[s1.auth_doc_kind] || "Document #"}: ${s1.auth_doc_number || "—"}${s1.auth_doc_kind === "passport" && s1.auth_passport_country ? `  (country: ${s1.auth_passport_country})` : ""}`;
  }
  checkRow(cs === "authorized", 4, I9_CIT_LABELS.authorized, authExtra);
  y -= 4;
  para("I am aware that federal law provides for imprisonment and/or fines for false statements, or the use of false documents, in connection with the completion of this form. I attest, under penalty of perjury, that the information provided above and the citizenship or immigration status I selected are true and correct.", { size: 8, color: ink });
  y -= 4;
  await sigBlock(rec.section1_signature, [drv.preferred_name, drv.full_name, [s1.first_name, s1.last_name].filter(Boolean).join(" ")].find(Boolean) || "Employee", rec.section1_completed_at, "Signature of employee");
  line(`Completed ${rec.section1_completed_at ? new Date(rec.section1_completed_at).toLocaleString() : "—"}${rec.section1_completed_via ? "  ·  " + (rec.section1_completed_via === "driver_app" ? "signed electronically by the employee in the RouteReady app" : "recorded by the employer on the employee's behalf") : ""}${s1.preparer_used ? "  ·  a preparer/translator assisted (Supplement A — collected separately)" : ""}.`, { size: 7.5, color: grey });

  // ── Section 2 ──
  sectionBar("Section 2.  Employer Review and Verification");
  const exam = (s2.exam_method as string) === "remote_alternative" ? "DHS-authorized alternative procedure (remote)" : "Physical, in-person examination";
  const listUsed = (s2.list_used as string) === "A" ? "List A" : "List B + List C";
  row3("Employee's first day of employment (mm/dd/yyyy)", fmtD(rec.first_day_of_employment), "Examination method", exam, "Documents presented", listUsed);
  const docs = Array.isArray(s2.documents) ? (s2.documents as Array<Record<string, string>>) : [];
  const docBlock = (title: string, d?: Record<string, string>) => {
    line(title, { font: bold, size: 8, color: grey });
    if (!d) { line("—", { size: 9, color: lite }); return; }
    row2("Document title", d.title || "", "Issuing authority", d.issuing_authority || "");
    row2("Document number", d.number || "", "Expiration date (if any)", d.expires_on ? fmtD(d.expires_on) : "N/A");
  };
  if ((s2.list_used as string) === "A") {
    docBlock("List A — identity & employment authorization", docs[0]);
  } else {
    docBlock("List B — identity", docs.find((x) => x.list === "B") || docs[0]);
    docBlock("List C — employment authorization", docs.find((x) => x.list === "C") || docs[1]);
  }
  if (s2.additional_info) { line("Additional information", { font: bold, size: 8, color: grey }); para(String(s2.additional_info), { size: 8.5, color: ink }); }
  y -= 4;
  para(`I attest, under penalty of perjury, that (1) I have examined the documentation presented by the above-named employee, (2) the documentation appears to be genuine and to relate to the employee named, and (3) to the best of my knowledge, the employee is authorized to work in the United States.${(s2.exam_method as string) === "remote_alternative" ? " I further attest that I examined the documentation remotely in accordance with the DHS-authorized alternative procedure, and that the employer is enrolled in and in good standing with E-Verify." : ""}`, { size: 8, color: ink });
  y -= 4;
  await sigBlock(rec.section2_signature, rec.section2_completed_by_name || "Employer representative", rec.section2_completed_at, "Signature of employer or authorized representative");
  row3("Name of employer representative", rec.section2_completed_by_name || "", "Title", rec.section2_completed_by_title || "", "Business or organization name", dsp.name);
  if (Array.isArray(rec.section2_document_paths) && rec.section2_document_paths.length) line(`${rec.section2_document_paths.length} document image(s) retained on the employee's record in RouteReady.`, { size: 7.5, color: grey });

  rule();
  para("This reproduction is generated from RouteReady's records and is accompanied by a cryptographic seal, an RFC 3161 trusted timestamp, and a Certificate of Completion on the following page(s). It does not replace your obligation to follow current USCIS guidance or to use the official form where required. Retain Form I-9 for 3 years after the date employment began, or 1 year after employment ends — whichever is later.", { size: 7.5, color: lite });
}

async function appendI9Certificate(
  pdf: PDFDocument, rec: I9Record, dsp: DspRow, events: I9Event[], helv: PDFFont, bold: PDFFont, mono: PDFFont,
  sealStub: SealStub | null, sealFull: SealInfo | null, formSource: "official_form" | "reproduction" = "reproduction",
) {
  const certId = formatCertId(rec.id);
  const issuedAt = new Date().toISOString();
  const s1 = (rec.section1 || {}) as Record<string, string>;
  const employeeName = [s1.first_name, s1.middle_initial, s1.last_name].filter(Boolean).join(" ") || "—";
  const citizenship = I9_CIT_LABELS[s1.citizen_status] || s1.citizen_status || "—";

  const ctx = beginCertificate(pdf, helv, bold, mono, {
    title: "CERTIFICATE OF COMPLETION",
    subtitle: "Employment Eligibility Verification (Form I-9) · Audit Record",
    certId,
    envelopeId: rec.id,
    issuedAt,
  });

  // ── 01 · FORM SOURCE ────────────────────────────────────────────────
  certSection(ctx, "01", "Form source");
  certBody(ctx, formSource === "official_form"
    ? "The attached pages are the unmodified USCIS Form I-9 (edition 08/01/23) filled from the captured data, followed by an Electronic Signature Record."
    : "The attached pages are a faithful reproduction of USCIS Form I-9 (edition 08/01/23) — the official PDF was not reachable at sealing time. The captured data is otherwise unchanged.");
  certBody(ctx, "The official Form I-9 (USCIS edition 08/01/23) and its instructions govern. This certificate is an electronic audit record, not legal advice.", { tone: "muted" });

  // ── 02 · PARTIES ────────────────────────────────────────────────────
  certSection(ctx, "02", "Parties");
  certKv(ctx, [
    { label: "Employer", value: dsp.name,      width: ctx.innerW / 2 - 6 },
    { label: "Employee", value: employeeName,  width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
  ]);
  certKv(ctx, [
    { label: "Citizenship status", value: citizenship,            width: ctx.innerW / 2 - 6 },
    { label: "Form record status",  value: rec.status,            width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
  ]);

  // ── 03 · COMPLETION ─────────────────────────────────────────────────
  certSection(ctx, "03", "Completion");
  if (rec.first_day_of_employment) {
    certKv(ctx, [{ label: "First day of employment", value: rec.first_day_of_employment, width: ctx.innerW }]);
  }
  if (rec.section1_completed_at) {
    certKv(ctx, [
      { label: "Section 1 completed (UTC)", value: new Date(rec.section1_completed_at).toISOString(), width: ctx.innerW / 2 - 6 },
      { label: "Section 1 method",          value: rec.section1_completed_via === "driver_app" ? "Signed by the employee in the app" : "Recorded by the employer", width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
    ]);
  }
  if (rec.section2_completed_at) {
    certKv(ctx, [
      { label: "Section 2 completed (UTC)", value: new Date(rec.section2_completed_at).toISOString(), width: ctx.innerW / 2 - 6 },
      { label: "Section 2 completed by",    value: rec.section2_completed_by_name || "—", width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
    ]);
  }

  // ── 04 · CHAIN OF CUSTODY ───────────────────────────────────────────
  certSection(ctx, "04", "Chain of custody");
  certBody(ctx, "Append-only record of every action taken against this Form I-9 record. Each entry includes the actor, timestamp, and metadata captured at the moment of the action.");
  certEventsI9(ctx, events);

  // ── 05 · CRYPTOGRAPHIC SEAL ─────────────────────────────────────────
  if (sealStub) {
    certSection(ctx, "05", "Cryptographic seal");
    certKv(ctx, [
      { label: "Algorithm",          value: sealFull?.signature_alg || "ECDSA-P256-SHA256", width: ctx.innerW / 2 - 6 },
      { label: "Sealed at (UTC)",    value: sealFull?.signed_at || "Embedded — see sidecar", width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
    ]);
    certKvMono(ctx, [
      { label: "Key id",          value: sealStub.key_id },
      { label: "Key fingerprint", value: sealStub.key_fingerprint },
      ...(sealFull ? [{ label: "PDF SHA-256", value: sealFull.pdf_sha256 }] : []),
    ]);
    if (sealFull) {
      certMonoBlock(ctx, "Signature (base64, raw r∥s)", sealFull.signature_b64);
      if (sealFull.tst_b64) {
        certSubheader(ctx, "RFC 3161 trusted timestamp");
        certKv(ctx, [
          { label: "Authority",          value: sealFull.tsa_url || "(unspecified)", width: ctx.innerW / 2 - 6 },
          { label: "Attested time (UTC)", value: sealFull.tsa_gen_time || "—",       width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
        ]);
        certBody(ctx, "Time attestation by the TSA, independent of RouteReady. TimeStampToken stored at " + sealStub.seal_path + " (key tst_b64); verify with: openssl ts -reply -in tst.tsr -text");
      }
    } else {
      certBody(ctx, "The PDF SHA-256, signature, public key, and (when present) RFC 3161 timestamp are stored in the JSON sidecar at " + sealStub.seal_path + ".");
    }
  }

  // ── 06 · VERIFICATION & INTEGRITY ───────────────────────────────────
  certSection(ctx, "06", "Verification & integrity");
  certKvMono(ctx, [
    { label: "Certificate ID", value: certId },
    { label: "Record ID",      value: rec.id },
    { label: "Audit entries",  value: String(events.length) },
  ]);
  certBody(ctx, "This record is tamper-evident. The chain of custody above is append-only; the cryptographic seal binds this PDF's SHA-256 to a digital signature; the trusted timestamp (when present) independently attests when the signature was made. Tampering with any byte invalidates the seal.");
  certBody(ctx, "Public verification key: GET https://rr-document-sealing.gorouteready.com/public-key", { mono: true });

  certFooter(ctx, certId, "rr-document-sealing · v0.13 · Form I-9");
}

// ─────────────────────────────────────────────────────────────────────────
// Cryptographic seal (Phase 1) — ECDSA P-256 over the sealed PDF bytes.
// ─────────────────────────────────────────────────────────────────────────

// What we can print inside the *embedded* COC (no PDF digest — that
// would be circular). What we put in the sidecar JSON + standalone COC
// + audit event (the full thing) is SealInfo.
interface SealStub {
  key_id:          string;
  key_fingerprint: string;
  seal_path:       string;
}
interface SealInfo {
  version:         "rr-seal-v1";
  envelope_id:     string;
  pdf_sha256:      string;
  signature_alg:   "ECDSA-P256-SHA256";
  signature_b64:   string;
  key_id:          string;
  key_fingerprint: string;
  public_jwk:      JsonWebKey;
  signed_at:       string;
  // RFC 3161 trusted timestamp on `pdf_sha256` — present only when a
  // TSA was reachable. `tst_b64` is the raw TimeStampResp; verify with
  // `openssl ts -reply -in tst.tsr -text` or any RFC 3161 verifier.
  tsa_url?:        string;
  tsa_gen_time?:   string;   // best-effort parse of the token's genTime
  tst_b64?:        string;
}

interface TimestampInfo {
  tsa_url:       string;
  tsa_gen_time?: string;
  tst_b64:       string;
}

interface SealKeyMeta {
  privKey:         CryptoKey;
  pubJwk:          JsonWebKey;
  key_id:          string;
  key_fingerprint: string;
}

// Imports RR_SIGNING_PRIVATE_JWK and derives the public material +
// fingerprint. Returns null (and logs) when no key is configured or
// the JWK is malformed — callers degrade to unsealed sealing.
async function loadSealKeyMeta(env: Env): Promise<SealKeyMeta | null> {
  if (!env.RR_SIGNING_PRIVATE_JWK) return null;
  let priv: JsonWebKey;
  try {
    priv = JSON.parse(env.RR_SIGNING_PRIVATE_JWK);
  } catch {
    console.error("RR_SIGNING_PRIVATE_JWK is not valid JSON; skipping seal");
    return null;
  }
  try {
    const privKey = await crypto.subtle.importKey(
      "jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    const pubJwk: JsonWebKey = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y };
    const pubKey = await crypto.subtle.importKey(
      "jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"],
    );
    // Fingerprint = first 32 hex chars of SHA-256 over the canonical SPKI bytes.
    const spki = (await crypto.subtle.exportKey("spki", pubKey)) as ArrayBuffer;
    const fpFull = await crypto.subtle.digest("SHA-256", spki);
    const fingerprint = bytesToHex(new Uint8Array(fpFull)).slice(0, 32);
    return {
      privKey,
      pubJwk,
      key_id:          env.RR_SIGNING_KEY_ID || "rr-seal-2026",
      key_fingerprint: fingerprint,
    };
  } catch (err) {
    console.error("failed to import signing key; skipping seal", err);
    return null;
  }
}

// Signs SHA-256(bytes) with the configured ECDSA P-256 key.
async function signBytes(
  meta: SealKeyMeta,
  envelopeId: string,
  bytes: Uint8Array,
): Promise<SealInfo | null> {
  try {
    const pdfDigest = await crypto.subtle.digest("SHA-256", bytes);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, meta.privKey, pdfDigest,
    );
    return {
      version:         "rr-seal-v1",
      envelope_id:     envelopeId,
      pdf_sha256:      bytesToHex(new Uint8Array(pdfDigest)),
      signature_alg:   "ECDSA-P256-SHA256",
      signature_b64:   bytesToBase64(new Uint8Array(sig)),
      key_id:          meta.key_id,
      key_fingerprint: meta.key_fingerprint,
      public_jwk:      meta.pubJwk,
      signed_at:       new Date().toISOString(),
    };
  } catch (err) {
    console.error("seal signing failed; uploading unsealed", err);
    return null;
  }
}

async function loadPublicKeyJwk(env: Env): Promise<JsonWebKey | null> {
  if (!env.RR_SIGNING_PRIVATE_JWK) return null;
  const priv: JsonWebKey = JSON.parse(env.RR_SIGNING_PRIVATE_JWK);
  return { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, key_ops: ["verify"] };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// ─────────────────────────────────────────────────────────────────────────
// RFC 3161 — trusted timestamp on the sealed PDF's SHA-256.
// ─────────────────────────────────────────────────────────────────────────

// Default chain of RFC 3161 TSAs, tried in order. FreeTSA is the
// "ideal" (its TST chains to its own CA you can publish), but it's a
// free volunteer service that's frequently slow/down — so we fall back
// to DigiCert's and Sectigo's public timestamp endpoints, which are
// widely used and accept arbitrary SHA-256 hashes. Override with
// RR_TSA_URL (comma-separated) to use a paid/SLA'd TSA instead.
const DEFAULT_TSA_URLS = [
  "https://freetsa.org/tsr",
  "http://timestamp.digicert.com",
  "http://timestamp.sectigo.com",
];

// Try one TSA endpoint once. Returns the parsed token or a short error
// string describing why it didn't (so callers can surface it).
async function tryOneTsa(tsaUrl: string, reqDer: Uint8Array): Promise<{ info?: TimestampInfo; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const resp = await fetch(tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        "Accept":       "application/timestamp-reply",
      },
      body: reqDer,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = (await resp.text().catch(() => "")).slice(0, 120);
      const e = `${tsaUrl}: HTTP ${resp.status}${txt ? " " + txt : ""}`;
      console.error("TSA non-200", e);
      return { error: e };
    }
    const respDer = new Uint8Array(await resp.arrayBuffer());
    // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
    // status 0 = granted, 1 = grantedWithMods.
    const status = readTsaStatus(respDer);
    if (status !== 0 && status !== 1) {
      const e = `${tsaUrl}: rejected (PKI status ${status})`;
      console.error("TSA rejected", e);
      return { error: e };
    }
    return {
      info: {
        tsa_url:      tsaUrl,
        tsa_gen_time: extractGenTime(respDer) ?? undefined,
        tst_b64:      bytesToBase64(respDer),
      },
    };
  } catch (err) {
    const e = `${tsaUrl}: ${String((err as Error)?.message || err)}`;
    console.error("TSA request failed", e);
    return { error: e };
  } finally {
    clearTimeout(t);
  }
}

// Returns { info } on success or { error } describing why every TSA
// failed. The seal ships either way; { error } is recorded on the
// pdf_signed event so it's visible in the audit view.
async function maybeTimestamp(env: Env, sealedBytes: Uint8Array): Promise<{ info?: TimestampInfo; error?: string }> {
  const urls = env.RR_TSA_URL
    ? env.RR_TSA_URL.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TSA_URLS;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", sealedBytes));
    const reqDer = buildTimeStampReq(digest);
    const errs: string[] = [];
    // Try each endpoint once (6s timeout each). No per-endpoint retry —
    // the seal is on the critical path and the diagnostic shows these
    // TSAs respond in well under a second when they're up; a retry+sleep
    // wasn't worth adding seconds to the seal's wall-clock.
    for (const url of urls) {
      const r = await tryOneTsa(url, reqDer);
      if (r.info) return { info: r.info };
      if (r.error) errs.push(r.error);
    }
    const error = "all TSA endpoints failed — " + errs.join(" | ");
    console.error(error);
    return { error };
  } catch (err) {
    const error = "timestamp step failed: " + String((err as Error)?.message || err);
    console.error(error);
    return { error };
  }
}

// Minimal DER builders for the one structure we need:
//   TimeStampReq ::= SEQUENCE {
//     version        INTEGER { v1(1) },
//     messageImprint SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING },
//     certReq        BOOLEAN }     -- we ask for the TSA cert to be returned
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
function derTLV(tag: number, value: number[]): number[] {
  return [tag, ...derLen(value.length), ...value];
}
function buildTimeStampReq(sha256Digest: Uint8Array): Uint8Array {
  // AlgorithmIdentifier for SHA-256: SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }
  const sha256Oid = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
  const algId = derTLV(0x30, [...sha256Oid, 0x05, 0x00]);
  const hashedMessage = derTLV(0x04, Array.from(sha256Digest));
  const messageImprint = derTLV(0x30, [...algId, ...hashedMessage]);
  const version = derTLV(0x02, [0x01]);          // INTEGER 1
  const certReq = derTLV(0x01, [0xff]);          // BOOLEAN TRUE
  const req = derTLV(0x30, [...version, ...messageImprint, ...certReq]);
  return new Uint8Array(req);
}

// Read the integer in TimeStampResp.status.PKIStatusInfo.status (the
// first INTEGER inside the first inner SEQUENCE). Returns -1 on parse
// surprise so callers treat it as a rejection.
function readTsaStatus(der: Uint8Array): number {
  try {
    let p = 0;
    if (der[p++] !== 0x30) return -1;             // outer SEQUENCE
    p += skipLen(der, p);                         // skip outer length
    if (der[p++] !== 0x30) return -1;             // PKIStatusInfo SEQUENCE
    const statusInfoLen = readLen(der, p); p += skipLen(der, p);
    void statusInfoLen;
    if (der[p++] !== 0x02) return -1;             // INTEGER (status)
    const n = readLen(der, p); p += skipLen(der, p);
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 8) | der[p + i];
    return v;
  } catch { return -1; }
}

// Best-effort: walk the DER linearly and return the first GeneralizedTime
// (tag 0x18) as an ISO string. In a TimeStampToken the TSTInfo (which
// contains genTime) precedes the signer certificates in the SignedData
// structure, so the first GeneralizedTime we hit is the timestamp's
// genTime. Returns null on any surprise.
function extractGenTime(der: Uint8Array): string | null {
  try {
    for (let i = 0; i + 2 < der.length; i++) {
      if (der[i] !== 0x18) continue;              // GeneralizedTime
      const len = der[i + 1];
      if (len < 13 || len > 32 || i + 2 + len > der.length) continue;
      const s = new TextDecoder().decode(der.subarray(i + 2, i + 2 + len));
      // GeneralizedTime: YYYYMMDDHHMMSS[.fff]Z
      const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
      if (!m) continue;
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? m[7] : ""}Z`;
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      return d.toISOString();
    }
    return null;
  } catch { return null; }
}

function readLen(der: Uint8Array, p: number): number {
  const first = der[p];
  if (first < 0x80) return first;
  const n = first & 0x7f;
  let v = 0;
  for (let i = 1; i <= n; i++) v = (v << 8) | der[p + i];
  return v;
}
function skipLen(der: Uint8Array, p: number): number {
  const first = der[p];
  return first < 0x80 ? 1 : 1 + (first & 0x7f);
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

  // Auto-filled field values, all derived from the signing event — the
  // signer never edits these (DocuSign-style "Date Signed" / "Full
  // Name" fields). Date falls back to today if signed_at is missing.
  const signedDate = envelope.signed_at ? new Date(envelope.signed_at) : new Date();
  const dateStr = `${String(signedDate.getUTCMonth() + 1).padStart(2, "0")}/${String(signedDate.getUTCDate()).padStart(2, "0")}/${signedDate.getUTCFullYear()}`;
  const fullName = (typedName || envelope.recipient_name || "").trim();
  const initialsStr = fullName.split(/\s+/).map((p) => p[0]).filter(Boolean).join("").toUpperCase().slice(0, 5) || "—";
  const fieldValues = (envelope.field_values && typeof envelope.field_values === "object") ? envelope.field_values : {};

  if (fields) {
    for (const f of fields) {
      const kind = f.kind || "signature";
      if (!["signature", "date", "name", "initials", "text", "checkbox"].includes(kind)) continue;
      const pageIdx = Math.max(0, Math.min(pages.length - 1, (f.page ?? 1) - 1));
      const page = pages[pageIdx];
      const { width: pw, height: ph } = page.getSize();
      // Field coords are stored as fractions of the page (0..1) with
      // origin at the top-left; pdf-lib's origin is bottom-left, so flip y.
      const x = (f.x ?? 0.6) * pw;
      const w = (f.w ?? 0.3) * pw;
      const h = (f.h ?? 0.08) * ph;
      const y = ph - ((f.y ?? 0.85) * ph) - h;
      if (kind === "date")          drawAutoTextBox(page, x, y, w, h, dateStr, "Date", bold);
      else if (kind === "name")     drawAutoTextBox(page, x, y, w, h, fullName, "Name", bold);
      else if (kind === "initials") drawAutoTextBox(page, x, y, w, h, initialsStr, "Initials", bold);
      else if (kind === "text")     drawAutoTextBox(page, x, y, w, h, String((f.id && (fieldValues as Record<string, unknown>)[f.id]) ?? ""), f.label || "", bold);
      else if (kind === "checkbox") drawCheckboxBox(page, x, y, w, h, !!(f.id && (fieldValues as Record<string, unknown>)[f.id]), f.label || "", bold);
      else                          await drawSignatureBox(pdf, page, x, y, w, h, method, payload, typedName, bold);
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

// An auto-filled text field (Date / Name / Initials) — the value comes
// from the signing event, never from something the signer typed. Drawn
// in its box (left-aligned, shrunk to fit width) with a small caption
// above and an underline, mirroring the signature box.
function drawAutoTextBox(
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  value: string,
  caption: string,
  bold: PDFFont,
) {
  page.drawText(caption, {
    x, y: y + h + 4, size: 8, font: bold, color: rgb(0.18, 0.22, 0.30),
  });
  const txt = value || "—";
  let size = Math.min(h * 0.62, 16);
  // Shrink to fit the box width.
  while (size > 6 && bold.widthOfTextAtSize(txt, size) > w - 8) size -= 0.5;
  page.drawText(txt, {
    x: x + 4,
    y: y + (h - size) / 2 + 2,
    size, font: bold, color: rgb(0.06, 0.10, 0.18),
  });
  page.drawLine({
    start: { x, y: y - 2 }, end: { x: x + w, y: y - 2 },
    thickness: 0.6, color: rgb(0.55, 0.60, 0.70),
  });
}

// A recipient-completed checkbox: a small square at the left of the
// box, marked "X" when the signer checked it, with the field's label
// to its right. Nothing is drawn for an unchecked box's mark, so a
// "no" reads as a clear empty square.
function drawCheckboxBox(
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  checked: boolean,
  label: string,
  bold: PDFFont,
) {
  const box = Math.min(h * 0.7, 14, w * 0.5);
  const bx = x;
  const by = y + (h - box) / 2;
  page.drawRectangle({
    x: bx, y: by, width: box, height: box,
    borderColor: rgb(0.30, 0.34, 0.42), borderWidth: 1,
    color: rgb(1, 1, 1),
  });
  if (checked) {
    const s = box * 1.05;
    page.drawText("X", {
      x: bx + (box - bold.widthOfTextAtSize("X", s)) / 2,
      y: by + (box - s) / 2 + s * 0.18,
      size: s, font: bold, color: rgb(0.06, 0.10, 0.18),
    });
  }
  const lbl = (label || "").trim();
  if (lbl) {
    let size = Math.min(box * 0.92, 11);
    const maxW = w - box - 6;
    let txt = lbl;
    while (size > 6 && bold.widthOfTextAtSize(txt, size) > maxW) {
      if (bold.widthOfTextAtSize(txt + "…", size) > maxW && txt.length > 1) txt = txt.slice(0, -1);
      else size -= 0.5;
    }
    if (txt !== lbl) txt = txt.replace(/…?$/, "…");
    page.drawText(txt, {
      x: bx + box + 5, y: y + (h - size) / 2 + 1,
      size, font: bold, color: rgb(0.18, 0.22, 0.30),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Certificate layout primitives
//
// Shared by appendCertificate (envelope sealing) and appendI9Certificate
// (Form I-9 sealing). Renders an institutional, monochrome, audit-grade
// page — corner registration marks, sectioned blocks, label/value
// pairs, chain-of-custody table, cryptographic-seal block, verification
// footer. No agency seals, no flags, no fake government insignia: the
// intent is "high-trust digital compliance record" (DocuSign / Adobe
// Sign / chain-of-custody report) rather than government replica.
// ─────────────────────────────────────────────────────────────────────────

interface CertCtx {
  pdf:    PDFDocument;
  page:   PDFPage;
  helv:   PDFFont;
  bold:   PDFFont;
  mono:   PDFFont;
  M:      number;   // outer margin
  PW:     number;   // page width
  PH:     number;   // page height
  innerW: number;
  innerL: number;   // left edge of content
  innerR: number;   // right edge of content
  y:      number;   // current cursor (descends)
  topY:   number;   // y where header sits
  bottomY:number;   // safe bottom before footer
  pageNo: number;
  // header context, repeated on continuation pages
  hdr: {
    title:      string;
    subtitle:   string;
    certId:     string;
    envelopeId: string;
    issuedAt:   string;
  };
  // color tokens
  c: {
    ink:        ReturnType<typeof rgb>;
    inkSoft:    ReturnType<typeof rgb>;
    muted:      ReturnType<typeof rgb>;
    subtle:     ReturnType<typeof rgb>;
    hairline:   ReturnType<typeof rgb>;
    ruleStrong: ReturnType<typeof rgb>;
    ok:         ReturnType<typeof rgb>;
    warn:       ReturnType<typeof rgb>;
    pending:    ReturnType<typeof rgb>;
    wm:         ReturnType<typeof rgb>;
    paper:      ReturnType<typeof rgb>;
  };
}

function beginCertificate(
  pdf: PDFDocument, helv: PDFFont, bold: PDFFont, mono: PDFFont,
  hdr: { title: string; subtitle: string; certId: string; envelopeId: string; issuedAt: string },
): CertCtx {
  const PW = 612, PH = 792, M = 56;
  const ctx: CertCtx = {
    pdf, helv, bold, mono,
    M, PW, PH,
    innerL: M,
    innerR: PW - M,
    innerW: PW - M * 2,
    y: 0,
    topY: PH - M,
    bottomY: M + 38, // reserve for footer band
    pageNo: 0,
    page: pdf.addPage([PW, PH]), // placeholder; overwritten by certNewPage
    hdr,
    c: {
      ink:        rgb(0.07, 0.09, 0.13),
      inkSoft:    rgb(0.18, 0.22, 0.28),
      muted:      rgb(0.42, 0.48, 0.56),
      subtle:     rgb(0.60, 0.65, 0.72),
      hairline:   rgb(0.82, 0.85, 0.89),
      ruleStrong: rgb(0.50, 0.55, 0.62),
      ok:         rgb(0.07, 0.45, 0.32),
      warn:       rgb(0.72, 0.10, 0.18),
      pending:    rgb(0.65, 0.48, 0.10),
      wm:         rgb(0.94, 0.95, 0.97),
      paper:      rgb(1.00, 1.00, 1.00),
    },
  };
  // Drop the placeholder and mint page 1 with the full header.
  pdf.removePage(pdf.getPageCount() - 1);
  certNewPage(ctx);
  return ctx;
}

function certNewPage(ctx: CertCtx) {
  ctx.pageNo += 1;
  const page = ctx.pdf.addPage([ctx.PW, ctx.PH]);
  ctx.page = page;

  // Watermark — ultra-light vertical hairlines spanning the safe page
  // area. Reads as "security paper" without the carnival of guilloche
  // curls or rotated wordmarks. Spacing is non-uniform on purpose so
  // it doesn't read as a moiré grid.
  for (const x of [80, 116, 152, 188, 224, 260, 296, 332, 368, 404, 440, 476, 512]) {
    page.drawLine({
      start: { x, y: ctx.M + 20 },
      end:   { x, y: ctx.PH - ctx.M - 20 },
      thickness: 0.3,
      color: ctx.c.wm,
    });
  }

  // Corner registration marks — small L-shapes at each content corner.
  const tick = 9;
  const lw = 0.6;
  const corners: Array<[number, number, 1 | -1, 1 | -1]> = [
    [ctx.innerL, ctx.PH - ctx.M, 1,  1],   // top-left
    [ctx.innerR, ctx.PH - ctx.M, -1, 1],   // top-right
    [ctx.innerL, ctx.M, 1,  -1],           // bottom-left
    [ctx.innerR, ctx.M, -1, -1],           // bottom-right
  ];
  for (const [cx, cy, sx, sy] of corners) {
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + sx * tick, y: cy }, thickness: lw, color: ctx.c.ruleStrong });
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy - sy * tick }, thickness: lw, color: ctx.c.ruleStrong });
  }

  // Header band on every page (so continuation pages still identify
  // the record). Title left-aligned, metadata right-aligned.
  let y = ctx.PH - ctx.M - 4;
  // Title
  ctx.page.drawText(ctx.hdr.title, {
    x: ctx.innerL, y: y - 12, size: 13, font: ctx.bold, color: ctx.c.ink,
    // Letter-spacing isn't directly supported; the all-caps title is
    // enough to read as institutional.
  });
  // Subtitle (smaller, muted)
  ctx.page.drawText(ctx.hdr.subtitle, {
    x: ctx.innerL, y: y - 28, size: 8.5, font: ctx.helv, color: ctx.c.muted,
  });
  if (ctx.pageNo > 1) {
    ctx.page.drawText("— continuation —", {
      x: ctx.innerL, y: y - 40, size: 7.5, font: ctx.helv, color: ctx.c.subtle,
    });
  }
  // Top-right metadata block: Certificate ID, Envelope/Record ID,
  // Issued. Three label/value pairs, right-aligned.
  const metaPairs = [
    { label: "CERTIFICATE ID", value: ctx.hdr.certId,     mono: true },
    { label: "ENVELOPE ID",    value: ctx.hdr.envelopeId, mono: true },
    { label: "ISSUED (UTC)",   value: ctx.hdr.issuedAt,   mono: true },
  ];
  let metaY = y;
  for (const m of metaPairs) {
    const labelW = ctx.helv.widthOfTextAtSize(m.label, 6.5);
    const valFont = m.mono ? ctx.mono : ctx.helv;
    const valW    = valFont.widthOfTextAtSize(m.value, 8);
    ctx.page.drawText(m.label, {
      x: ctx.innerR - labelW, y: metaY, size: 6.5, font: ctx.helv, color: ctx.c.subtle,
    });
    ctx.page.drawText(m.value, {
      x: ctx.innerR - valW, y: metaY - 11, size: 8, font: valFont, color: ctx.c.inkSoft,
    });
    metaY -= 24;
  }
  // Double rule under the header.
  const ruleY = ctx.PH - ctx.M - 50;
  ctx.page.drawLine({
    start: { x: ctx.innerL, y: ruleY },
    end:   { x: ctx.innerR, y: ruleY },
    thickness: 1.0, color: ctx.c.ink,
  });
  ctx.page.drawLine({
    start: { x: ctx.innerL, y: ruleY - 3 },
    end:   { x: ctx.innerR, y: ruleY - 3 },
    thickness: 0.4, color: ctx.c.ruleStrong,
  });
  // Cursor starts below the header band.
  ctx.y = ruleY - 18;
}

function certEnsureSpace(ctx: CertCtx, need: number) {
  if (ctx.y - need < ctx.bottomY) certNewPage(ctx);
}

function certSection(ctx: CertCtx, num: string, label: string) {
  certEnsureSpace(ctx, 36);
  // Number + label, with a hairline that runs full-width under the row.
  ctx.page.drawText(num, {
    x: ctx.innerL, y: ctx.y - 9, size: 9, font: ctx.bold, color: ctx.c.muted,
  });
  ctx.page.drawText(label.toUpperCase(), {
    x: ctx.innerL + 28, y: ctx.y - 9, size: 9.5, font: ctx.bold, color: ctx.c.ink,
  });
  ctx.y -= 14;
  ctx.page.drawLine({
    start: { x: ctx.innerL, y: ctx.y },
    end:   { x: ctx.innerR, y: ctx.y },
    thickness: 0.6, color: ctx.c.ruleStrong,
  });
  ctx.y -= 14;
}

function certSubheader(ctx: CertCtx, label: string) {
  certEnsureSpace(ctx, 20);
  ctx.page.drawText(label.toUpperCase(), {
    x: ctx.innerL, y: ctx.y, size: 7.5, font: ctx.bold, color: ctx.c.muted,
  });
  ctx.y -= 12;
  ctx.page.drawLine({
    start: { x: ctx.innerL, y: ctx.y + 4 },
    end:   { x: ctx.innerR, y: ctx.y + 4 },
    thickness: 0.3, color: ctx.c.hairline,
  });
  ctx.y -= 6;
}

interface KvCell { label: string; value: string; width: number; dx?: number; }

function certKv(ctx: CertCtx, cells: KvCell[]) {
  certEnsureSpace(ctx, 30);
  for (const c of cells) {
    const x = ctx.innerL + (c.dx ?? 0);
    ctx.page.drawText(c.label.toUpperCase(), {
      x, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle,
    });
    ctx.page.drawText(c.value, {
      x, y: ctx.y - 12, size: 10, font: ctx.helv, color: ctx.c.ink, maxWidth: c.width,
    });
  }
  ctx.y -= 28;
}

function certKvMono(ctx: CertCtx, cells: Array<{ label: string; value: string }>) {
  for (const c of cells) {
    certEnsureSpace(ctx, 18);
    ctx.page.drawText(c.label.toUpperCase(), {
      x: ctx.innerL, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle,
    });
    ctx.page.drawText(c.value, {
      x: ctx.innerL + 130, y: ctx.y, size: 8.5, font: ctx.mono, color: ctx.c.inkSoft, maxWidth: ctx.innerW - 130,
    });
    ctx.y -= 14;
  }
  ctx.y -= 4;
}

function certStatus(ctx: CertCtx, s: { label: string; state: "ok" | "warn" | "pending" }) {
  certEnsureSpace(ctx, 22);
  const color = s.state === "ok" ? ctx.c.ok : s.state === "warn" ? ctx.c.warn : ctx.c.pending;
  const glyph = s.state === "ok" ? "■" : s.state === "warn" ? "▲" : "○"; // ■ ▲ ○
  ctx.page.drawText(glyph, { x: ctx.innerL, y: ctx.y, size: 9, font: ctx.bold, color });
  ctx.page.drawText(s.label, { x: ctx.innerL + 14, y: ctx.y, size: 9, font: ctx.bold, color });
  ctx.y -= 18;
}

function certBody(ctx: CertCtx, text: string, opts?: { tone?: "muted" | "default"; mono?: boolean }) {
  const font = opts?.mono ? ctx.mono : ctx.helv;
  const color = opts?.tone === "muted" ? ctx.c.subtle : ctx.c.inkSoft;
  const size = opts?.mono ? 8 : 9;
  // Word-wrap manually so the prose flows on multiple lines without
  // pdf-lib silently clipping at maxWidth.
  const lines = wrapToWidth(text, font, size, ctx.innerW);
  for (const line of lines) {
    certEnsureSpace(ctx, size + 4);
    ctx.page.drawText(line, { x: ctx.innerL, y: ctx.y, size, font, color });
    ctx.y -= size + 3;
  }
  ctx.y -= 4;
}

function certMonoBlock(ctx: CertCtx, label: string, value: string) {
  certEnsureSpace(ctx, 30);
  ctx.page.drawText(label.toUpperCase(), {
    x: ctx.innerL, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle,
  });
  ctx.y -= 10;
  for (const chunk of wrapText(value, 88)) {
    certEnsureSpace(ctx, 10);
    ctx.page.drawText(chunk, { x: ctx.innerL, y: ctx.y, size: 7.5, font: ctx.mono, color: ctx.c.inkSoft });
    ctx.y -= 10;
  }
  ctx.y -= 4;
}

function certEvents(ctx: CertCtx, events: AuditEvent[]) {
  // Column layout: # · time · kind · actor / meta · hash (mono).
  const num = events.length;
  certEnsureSpace(ctx, 16);
  // Column header
  ctx.page.drawText("#",       { x: ctx.innerL,        y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.page.drawText("TIME (UTC)", { x: ctx.innerL + 22, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.page.drawText("EVENT",   { x: ctx.innerL + 142, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.page.drawText("ACTOR / META", { x: ctx.innerL + 240, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.y -= 8;
  ctx.page.drawLine({ start: { x: ctx.innerL, y: ctx.y }, end: { x: ctx.innerR, y: ctx.y }, thickness: 0.3, color: ctx.c.hairline });
  ctx.y -= 10;

  events.forEach((e, i) => {
    certEnsureSpace(ctx, 28);
    const ord = String(i + 1).padStart(2, "0") + " / " + String(num).padStart(2, "0");
    const t   = new Date(e.created_at).toISOString();
    const kind = humanKind(e.kind);
    const actor = e.actor_kind + (e.actor_name ? " · " + e.actor_name : "");
    const meta = [e.ip ? "ip " + e.ip : null, e.user_agent ? truncate(e.user_agent, 56) : null].filter(Boolean).join("  ·  ");

    ctx.page.drawText(ord,   { x: ctx.innerL,        y: ctx.y, size: 7.5, font: ctx.mono, color: ctx.c.subtle });
    ctx.page.drawText(t,     { x: ctx.innerL + 22,  y: ctx.y, size: 7.5, font: ctx.mono, color: ctx.c.inkSoft });
    ctx.page.drawText(kind,  { x: ctx.innerL + 142, y: ctx.y, size: 9,   font: ctx.bold, color: ctx.c.ink });
    ctx.page.drawText(actor, { x: ctx.innerL + 240, y: ctx.y, size: 8.5, font: ctx.helv, color: ctx.c.inkSoft, maxWidth: ctx.innerW - 240 });
    ctx.y -= 11;
    if (meta) {
      ctx.page.drawText(meta, { x: ctx.innerL + 240, y: ctx.y, size: 7.5, font: ctx.helv, color: ctx.c.muted, maxWidth: ctx.innerW - 240 });
      ctx.y -= 10;
    }
    // Event hash line
    ctx.page.drawText("HASH", { x: ctx.innerL + 142, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
    ctx.page.drawText(e.event_hash, { x: ctx.innerL + 168, y: ctx.y, size: 7.5, font: ctx.mono, color: ctx.c.muted, maxWidth: ctx.innerW - 168 });
    ctx.y -= 12;
    // Hairline between entries except after the last.
    if (i < events.length - 1) {
      ctx.page.drawLine({ start: { x: ctx.innerL, y: ctx.y + 2 }, end: { x: ctx.innerR, y: ctx.y + 2 }, thickness: 0.25, color: ctx.c.hairline });
      ctx.y -= 4;
    }
  });
  ctx.y -= 6;
}

function certEventsI9(ctx: CertCtx, events: I9Event[]) {
  const num = events.length;
  certEnsureSpace(ctx, 16);
  ctx.page.drawText("#",         { x: ctx.innerL,        y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.page.drawText("TIME (UTC)", { x: ctx.innerL + 22,  y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.page.drawText("EVENT",     { x: ctx.innerL + 142, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.page.drawText("ACTOR / META", { x: ctx.innerL + 240, y: ctx.y, size: 6.5, font: ctx.helv, color: ctx.c.subtle });
  ctx.y -= 8;
  ctx.page.drawLine({ start: { x: ctx.innerL, y: ctx.y }, end: { x: ctx.innerR, y: ctx.y }, thickness: 0.3, color: ctx.c.hairline });
  ctx.y -= 10;

  events.forEach((e, i) => {
    certEnsureSpace(ctx, 24);
    const ord = String(i + 1).padStart(2, "0") + " / " + String(num).padStart(2, "0");
    const t   = new Date(e.created_at).toISOString();
    const kind = humanKind(e.kind);
    const actor = e.actor_kind + (e.actor_name ? " · " + e.actor_name : "");
    const meta = e.ip ? "ip " + e.ip : "";
    const reason = e.kind === "reopened" && e.event_data && (e.event_data as Record<string, unknown>).reason
      ? String((e.event_data as Record<string, unknown>).reason)
      : null;

    ctx.page.drawText(ord,   { x: ctx.innerL,        y: ctx.y, size: 7.5, font: ctx.mono, color: ctx.c.subtle });
    ctx.page.drawText(t,     { x: ctx.innerL + 22,  y: ctx.y, size: 7.5, font: ctx.mono, color: ctx.c.inkSoft });
    ctx.page.drawText(kind,  { x: ctx.innerL + 142, y: ctx.y, size: 9,   font: ctx.bold, color: ctx.c.ink });
    ctx.page.drawText(actor, { x: ctx.innerL + 240, y: ctx.y, size: 8.5, font: ctx.helv, color: ctx.c.inkSoft, maxWidth: ctx.innerW - 240 });
    ctx.y -= 11;
    if (meta) {
      ctx.page.drawText(meta, { x: ctx.innerL + 240, y: ctx.y, size: 7.5, font: ctx.helv, color: ctx.c.muted, maxWidth: ctx.innerW - 240 });
      ctx.y -= 10;
    }
    if (reason) {
      ctx.page.drawText("reason · " + reason, { x: ctx.innerL + 240, y: ctx.y, size: 7.5, font: ctx.helv, color: ctx.c.muted, maxWidth: ctx.innerW - 240 });
      ctx.y -= 10;
    }
    if (i < events.length - 1) {
      ctx.page.drawLine({ start: { x: ctx.innerL, y: ctx.y + 2 }, end: { x: ctx.innerR, y: ctx.y + 2 }, thickness: 0.25, color: ctx.c.hairline });
      ctx.y -= 4;
    }
  });
  ctx.y -= 6;
}

function certFooter(ctx: CertCtx, certId: string, signature: string) {
  // Footer band is on each page. Top hairline, then three columns:
  // left = certificate id, center = page x of y, right = signature.
  // Because pdf-lib has no Page.afterDraw hook we paint the footer on
  // every page that's been created so far before save() is called by
  // the caller — easiest path: paint right now on every page already
  // in the doc.
  const total = ctx.pageNo;
  const pages = ctx.pdf.getPages();
  for (let i = 0; i < total; i++) {
    const p = pages[pages.length - total + i];
    const fy = ctx.M + 22;
    p.drawLine({ start: { x: ctx.innerL, y: fy + 18 }, end: { x: ctx.innerR, y: fy + 18 }, thickness: 0.4, color: ctx.c.ruleStrong });
    p.drawText("CERTIFICATE ID", { x: ctx.innerL, y: fy + 8, size: 5.5, font: ctx.helv, color: ctx.c.subtle });
    p.drawText(certId,            { x: ctx.innerL, y: fy - 2, size: 7.5, font: ctx.mono, color: ctx.c.inkSoft });
    const pageStr = "PAGE " + (i + 1) + " OF " + total;
    const pageW = ctx.helv.widthOfTextAtSize(pageStr, 7);
    p.drawText(pageStr, { x: ctx.PW / 2 - pageW / 2, y: fy + 2, size: 7, font: ctx.helv, color: ctx.c.muted });
    const sigW = ctx.helv.widthOfTextAtSize(signature, 7);
    p.drawText("ISSUED BY", { x: ctx.innerR - sigW, y: fy + 8, size: 5.5, font: ctx.helv, color: ctx.c.subtle });
    p.drawText(signature,    { x: ctx.innerR - sigW, y: fy - 2, size: 7,   font: ctx.helv, color: ctx.c.inkSoft });
    // Tamper-evident microcopy along the very bottom.
    p.drawText("Tamper-evident · Append-only audit chain · ECDSA-P256 sealed · RFC 3161 timestamp (when present)",
      { x: ctx.innerL, y: ctx.M, size: 5.5, font: ctx.helv, color: ctx.c.subtle });
  }
  // Mute the unused `degrees` import warning in case we ever switch to
  // a rotated wordmark watermark later.
  void degrees;
}

function formatCertId(uuid: string): string {
  const hex = uuid.replace(/-/g, "").slice(0, 16).toUpperCase();
  return "RR-" + hex.slice(0, 4) + "-" + hex.slice(4, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16);
}

function wrapToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const trial = line ? line + " " + w : w;
    const width = font.widthOfTextAtSize(trial, size);
    if (width > maxWidth && line) {
      out.push(line);
      line = w;
    } else {
      line = trial;
    }
  }
  if (line) out.push(line);
  return out;
}


async function appendCertificate(
  pdf: PDFDocument,
  envelope: Envelope,
  template: Template,
  events: AuditEvent[],
  helv: PDFFont,
  bold: PDFFont,
  mono: PDFFont,
  // stub is safe to print inside the embedded COC (no circular digest);
  // full carries pdf_sha256 + signature and is only passed when we're
  // building the standalone COC (a separate file).
  sealStub: SealStub | null,
  sealFull: SealInfo | null,
) {
  // Stable certificate id derived from the envelope id so a re-seal of
  // the same envelope produces the same printed id. Format: 4-4-4-4
  // upper-hex prefix of the envelope id, matching the visual cadence of
  // institutional audit references.
  const certId = formatCertId(envelope.id);
  const issuedAt = new Date().toISOString();
  const docHashSign = envelope.doc_hash_at_sign || null;
  const hashesMatch = docHashSign != null && docHashSign === envelope.doc_hash_at_send;
  const integrity = docHashSign == null
    ? { label: "Pending second-hash verification", state: "pending" as const }
    : hashesMatch
      ? { label: "Integrity verified · hashes match", state: "ok" as const }
      : { label: "Integrity warning · hashes diverge", state: "warn" as const };

  const ctx = beginCertificate(pdf, helv, bold, mono, {
    title: "CERTIFICATE OF COMPLETION",
    subtitle: "Electronic Signature · Audit Record",
    certId,
    envelopeId: envelope.id,
    issuedAt,
  });

  // ── 01 · DOCUMENT ───────────────────────────────────────────────────
  certSection(ctx, "01", "Document");
  certKv(ctx, [
    { label: "Title", value: template.title, width: ctx.innerW },
  ]);
  certKvMono(ctx, [
    { label: "SHA-256 at send", value: envelope.doc_hash_at_send },
    ...(docHashSign ? [{ label: "SHA-256 at sign", value: docHashSign }] : []),
  ]);
  certStatus(ctx, integrity);

  // ── 02 · SIGNER IDENTITY ────────────────────────────────────────────
  certSection(ctx, "02", "Signer identity");
  const signedEvent = events.slice().reverse().find((e) => e.kind === "signed");
  const sigMethod = (signedEvent?.event_data?.signature_method as string) || "typed";
  certKv(ctx, [
    { label: "Name",  value: envelope.recipient_name,  width: ctx.innerW / 2 - 6 },
    { label: "Email", value: envelope.recipient_email, width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
  ]);
  certKv(ctx, [
    { label: "Signed at (UTC)", value: envelope.signed_at ? new Date(envelope.signed_at).toISOString() : "—", width: ctx.innerW / 2 - 6 },
    { label: "Method",          value: sigMethod,                                                              width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
  ]);
  if (signedEvent) {
    certKv(ctx, [
      { label: "IP address", value: signedEvent.ip || "—", width: ctx.innerW / 2 - 6 },
      { label: "User agent", value: truncate(signedEvent.user_agent || "—", 70), width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
    ]);
  }

  // ── 03 · CHAIN OF CUSTODY ───────────────────────────────────────────
  certSection(ctx, "03", "Chain of custody");
  certBody(ctx, "Append-only, hash-chained record. Each entry references the previous entry's hash; any modification to an earlier entry would break the chain at that point and at every entry that follows.");
  certEvents(ctx, events);

  // ── 04 · CRYPTOGRAPHIC SEAL ─────────────────────────────────────────
  if (sealStub) {
    certSection(ctx, "04", "Cryptographic seal");
    certKv(ctx, [
      { label: "Algorithm", value: sealFull?.signature_alg || "ECDSA-P256-SHA256", width: ctx.innerW / 2 - 6 },
      { label: "Sealed at (UTC)", value: sealFull?.signed_at || "Embedded — see sidecar", width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
    ]);
    certKvMono(ctx, [
      { label: "Key id",           value: sealStub.key_id },
      { label: "Key fingerprint",  value: sealStub.key_fingerprint },
      ...(sealFull ? [{ label: "PDF SHA-256", value: sealFull.pdf_sha256 }] : []),
    ]);
    if (sealFull) {
      certMonoBlock(ctx, "Signature (base64, raw r∥s)", sealFull.signature_b64);
      if (sealFull.tst_b64) {
        certSubheader(ctx, "RFC 3161 trusted timestamp");
        certKv(ctx, [
          { label: "Authority",          value: sealFull.tsa_url || "(unspecified)", width: ctx.innerW / 2 - 6 },
          { label: "Attested time (UTC)", value: sealFull.tsa_gen_time || "—",       width: ctx.innerW / 2 - 6, dx: ctx.innerW / 2 + 6 },
        ]);
        certBody(ctx, "Time attestation by the TSA, independent of RouteReady. TimeStampToken stored at " + sealStub.seal_path + " (key tst_b64); verify with: openssl ts -reply -in tst.tsr -text");
      }
    } else {
      certBody(ctx, "The PDF SHA-256, signature, public key, and (when present) RFC 3161 timestamp are stored in the JSON sidecar at " + sealStub.seal_path + ".");
    }
  }

  // ── 05 · VERIFICATION & INTEGRITY ───────────────────────────────────
  certSection(ctx, "05", "Verification & integrity");
  certKvMono(ctx, [
    { label: "Certificate ID", value: certId },
    { label: "Envelope ID",    value: envelope.id },
    { label: "Audit entries",  value: String(events.length) },
  ]);
  certBody(ctx, "This record is tamper-evident. The chain of custody above is append-only and hash-linked; the cryptographic seal binds the sealed PDF's SHA-256 to a digital signature; the trusted timestamp (when present) independently attests when the signature was made. Tampering with any byte invalidates the seal and breaks chain verification.");
  certBody(ctx, "Verify online: https://gorouteready.com/verify/" + envelope.id);
  certBody(ctx, "Public verification key: GET https://rr-document-sealing.gorouteready.com/public-key", { mono: true });

  certFooter(ctx, certId, "rr-document-sealing · v0.13");
}

function wrapText(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
