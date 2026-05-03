// cal-availability · Read + write the operator's Cal.com availability and
// location for the "interview" event type, so the dashboard can offer a
// RouteReady-branded availability editor instead of embedding the Cal UI.
//
// GET  → returns current event-type / schedule / location
// POST → updates schedule (timeZone + availability) + event-type (locations)
//
// Env required (Supabase secrets):
//   CAL_API_KEY          Cal.com personal API key (cal_live_… / cal_test_…)
//   CAL_USERNAME         Cal username, e.g. "Routeready"  (defaults to that)
//   CAL_INTERVIEW_SLUG   slug of the event type to manage (defaults to "interview")
import { jsonResponse, badRequest } from "../_shared/supabase.ts";

const CAL_API_BASE = "https://api.cal.com/v2";
const CAL_API_VERSION = "2024-06-14";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

async function callCal(path: string, init: RequestInit = {}) {
  const apiKey = Deno.env.get("CAL_API_KEY");
  if (!apiKey) throw new Error("CAL_API_KEY not configured on the project");

  const res = await fetch(`${CAL_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "Authorization":   `Bearer ${apiKey}`,
      "cal-api-version": CAL_API_VERSION,
      "Content-Type":    "application/json",
    },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || text || `HTTP ${res.status}`;
    throw new Error(`Cal API ${res.status}: ${msg}`);
  }
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const username = Deno.env.get("CAL_USERNAME") || "Routeready";
  const interviewSlug = Deno.env.get("CAL_INTERVIEW_SLUG") || "interview";

  try {
    // ── Resolve the event type by slug ────────────────────────────────────
    const evtList = await callCal(`/event-types?username=${encodeURIComponent(username)}`);
    // v2 response shape varies between releases; handle both
    const evtArray =
      evtList?.data?.eventTypeGroups?.[0]?.eventTypes ??
      evtList?.data?.eventTypes ??
      evtList?.data ?? [];
    const evt = (Array.isArray(evtArray) ? evtArray : []).find(
      (e: any) => e.slug === interviewSlug,
    );
    if (!evt) {
      // 200 with {error} so supabase-js surfaces the body in data.
      return cors({ error: `Cal event type "${interviewSlug}" not found under username "${username}"` });
    }

    if (req.method === "GET") {
      let schedule = null as any;
      if (evt.scheduleId) {
        const s = await callCal(`/schedules/${evt.scheduleId}`);
        schedule = s?.data ?? s ?? null;
      } else {
        // Some accounts default to the first schedule when scheduleId is null.
        const s = await callCal(`/schedules`);
        const list = s?.data ?? [];
        schedule = list[0] ?? null;
      }

      return cors({
        username,
        eventType: {
          id:        evt.id,
          slug:      evt.slug,
          title:     evt.title,
          length:    evt.length ?? evt.lengthInMinutes ?? null,
          locations: evt.locations ?? [],
          link:      `https://cal.com/${username}/${evt.slug}`,
        },
        schedule: schedule ? {
          id:           schedule.id,
          name:         schedule.name,
          timeZone:     schedule.timeZone,
          availability: schedule.availability ?? [],
        } : null,
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { timeZone, availability, locations } = body;

      // Update the schedule (availability + tz) when supplied.
      if (evt.scheduleId && (timeZone || availability)) {
        const patch: Record<string, unknown> = {};
        if (timeZone)            patch.timeZone     = timeZone;
        if (Array.isArray(availability)) patch.availability = availability;
        if (Object.keys(patch).length > 0) {
          await callCal(`/schedules/${evt.scheduleId}`, {
            method: "PATCH",
            body:   JSON.stringify(patch),
          });
        }
      }

      // Update the event-type locations when supplied.
      if (Array.isArray(locations)) {
        await callCal(`/event-types/${evt.id}`, {
          method: "PATCH",
          body:   JSON.stringify({ locations }),
        });
      }

      return cors({ ok: true });
    }

    return cors({ error: "method_not_allowed" });
  } catch (e: any) {
    // Always 200 so the frontend can read the error body.
    return cors({ error: String(e?.message ?? e) });
  }
});

function cors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
