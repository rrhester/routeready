// upload-applicant-video · Receives the applicant's video intro.
//
// Public (anon-callable). Verifies the screening token before accepting
// the upload, so a stranger can't write garbage to the bucket. On success
// stores the file at <dsp_id>/<applicant_id>/<timestamp>.webm and patches
// applicants.video_url to a signed playback URL.
//
// Body (multipart/form-data):
//   token  : screening token from the URL the applicant clicked
//   video  : the recorded blob (webm/mp4)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-client-info, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
};

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME = new Set(["video/webm", "video/mp4", "video/quicktime"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonRespCors({ error: "invalid_form_data" }, 400);
  }

  const token = String(form.get("token") ?? "");
  const file  = form.get("video");
  if (!token) return jsonRespCors({ error: "token_required" }, 400);
  if (!(file instanceof File)) return jsonRespCors({ error: "video_required" }, 400);
  if (file.size > MAX_BYTES) return jsonRespCors({ error: "file_too_large" }, 413);
  // MediaRecorder reports the full codec string (e.g. "video/webm;codecs=vp9"
  // on desktop Chrome), so match on the base MIME type, not an exact string —
  // otherwise every desktop-recorded clip 415s while iOS (bare "video/mp4")
  // slips through.
  const baseMime = (file.type || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(baseMime)) return jsonRespCors({ error: "unsupported_mime: " + file.type }, 415);

  const supa = serviceClient();

  // Verify the token resolves to an applicant whose screening isn't closed.
  const { data: app, error: lookupErr } = await supa
    .from("applicants")
    .select("id, dsp_id, status")
    .eq("metadata->tokens->>screening", token)
    .maybeSingle();

  if (lookupErr || !app) return jsonRespCors({ error: "invalid_or_expired_token" }, 403);
  if (["rejected", "auto_declined", "hired", "no_show"].includes(app.status)) {
    return jsonRespCors({ error: "screening_closed" }, 410);
  }

  const ext = baseMime === "video/mp4" ? "mp4" : (baseMime === "video/quicktime" ? "mov" : "webm");
  const objectPath = `${app.dsp_id}/${app.id}/${Date.now()}.${ext}`;

  const arrayBuf = await file.arrayBuffer();
  const { error: uploadErr } = await supa.storage.from("applicant-videos").upload(
    objectPath,
    new Uint8Array(arrayBuf),
    { contentType: file.type, upsert: false },
  );
  if (uploadErr) return jsonRespCors({ error: "upload_failed: " + uploadErr.message }, 500);

  // Sign a 30-day URL the dashboard can render directly. (We re-sign on
  // demand in the operator UI for longer-lived playback if needed.)
  const { data: signed, error: signErr } = await supa.storage
    .from("applicant-videos")
    .createSignedUrl(objectPath, 60 * 60 * 24 * 30);
  if (signErr || !signed) return jsonRespCors({ error: "sign_failed" }, 500);

  await supa.from("applicants")
    .update({ video_url: signed.signedUrl })
    .eq("id", app.id);

  return jsonRespCors({ ok: true, applicant_id: app.id, video_url: signed.signedUrl });
});

function jsonRespCors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
