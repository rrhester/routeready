// webhook-apply · Public applicant intake.
//
// Two callers:
//   1. The /apply page on gorouteready.com submits the form here.
//   2. Indeed / ZipRecruiter / referral form posts (with shared-secret).
//
// The function calls intake_applicant() and, if dsp.metadata.sms.auto_send_screening
// is true and the applicant has a phone, also queues a screening invite.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APPLY_SHARED_SECRET (optional)
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-apply-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const expected = Deno.env.get("APPLY_SHARED_SECRET");
  if (expected && req.headers.get("x-apply-secret") !== expected) {
    return badRequest("forbidden", 403);
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return badRequest("invalid_json");

  const supa = serviceClient();
  const { data: applicant, error } = await supa.rpc("intake_applicant", { p_payload: payload });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400, headers: { "content-type": "application/json", ...CORS },
    });
  }

  // Auto-send screening if the DSP opted in.
  const { data: dsp } = await supa.from("dsps").select("metadata").eq("id", applicant.dsp_id).single();
  const autoSend = dsp?.metadata?.sms?.auto_send_screening !== false;

  if (autoSend && applicant.phone && applicant.status === "applied") {
    // Use the screening RPC via service client (it'll skip the is_staff
    // gate because security definer + service role bypasses RLS).
    // We can't call it directly though — it checks current_dsp_id which
    // returns null for the service role. So we replicate its essentials
    // here: stamp a token, queue the SMS row.
    const token = crypto.randomUUID().replace(/-/g, "");
    const md = applicant.metadata ?? {};
    md.tokens = { ...(md.tokens ?? {}), screening: token };
    await supa.from("applicants").update({ metadata: md, status: "contacted" }).eq("id", applicant.id);

    const baseUrl = (dsp?.metadata?.public_base_url) ?? "https://gorouteready.com";
    const link = `${baseUrl}/s/${token}`;

    const { data: tpl } = await supa.from("message_templates")
      .select("body").eq("dsp_id", applicant.dsp_id)
      .eq("channel", "sms").eq("key", "applicant.invite_screening")
      .eq("active", true).single();

    if (tpl) {
      const body = tpl.body
        .replace(/\{\{first_name\}\}/g, applicant.first_name ?? applicant.full_name)
        .replace(/\{\{link\}\}/g, link);
      await supa.from("sms_messages").insert({
        dsp_id: applicant.dsp_id, applicant_id: applicant.id,
        direction: "outbound", status: "queued",
        to_phone: applicant.phone, body,
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, applicant_id: applicant.id }), {
    headers: { "content-type": "application/json", ...CORS },
  });
});
