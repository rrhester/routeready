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

const CAL_API_BASE = "https://api.cal.com/v2";
const CAL_API_VERSION = "2024-06-14";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// Cal v2 represents schedule days as English weekday names ("Monday",
// "Tuesday", …). The dashboard's editor uses 0–6 (Sun–Sat). Translate
// in both directions so neither side has to know about the other.
const DAY_NUM_TO_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_NAME_TO_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
function dayToCal(d: unknown): string | null {
  if (typeof d === "string") {
    return DAY_NUM_TO_NAME[DAY_NAME_TO_NUM[d.toLowerCase()] ?? -1] ?? null;
  }
  if (typeof d === "number" && d >= 0 && d <= 6) return DAY_NUM_TO_NAME[d];
  return null;
}
function dayFromCal(d: unknown): number | null {
  if (typeof d === "number" && d >= 0 && d <= 6) return d;
  if (typeof d === "string") {
    const n = DAY_NAME_TO_NUM[d.toLowerCase()];
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
// Cal v2 wants HH:MM, the dashboard form may send HH:MM:SS. Normalize.
function timeToCal(t: unknown): string | null {
  if (typeof t !== "string" || !t) return null;
  const m = t.match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : t;
}

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
    //
    // We try a couple of endpoint shapes because Cal's v2 API has shifted
    // a few times. /event-types alone (no username) returns the API key
    // owner's event types — usually what we want — and is the most stable.
    let evtList = await callCal(`/event-types`);
    const flatten = (resp: any) =>
      resp?.data?.eventTypeGroups?.flatMap?.((g: any) => g.eventTypes ?? []) ??
      resp?.data?.eventTypes ??
      resp?.data ?? [];
    let evtArray: any[] = flatten(evtList);

    // Fallback: also try the username-scoped endpoint if the first call
    // came back empty (some Cal accounts behave that way).
    if (!Array.isArray(evtArray) || evtArray.length === 0) {
      try {
        evtList = await callCal(`/event-types?username=${encodeURIComponent(username)}`);
        evtArray = flatten(evtList);
      } catch { /* keep the first attempt's empty list */ }
    }

    const slugLower = interviewSlug.toLowerCase();
    const evt = (Array.isArray(evtArray) ? evtArray : []).find(
      (e: any) => (e.slug || "").toLowerCase() === slugLower,
    );
    if (!evt) {
      const found = (Array.isArray(evtArray) ? evtArray : [])
        .map((e: any) => `"${e.slug}" (${e.title})`)
        .slice(0, 8)
        .join(", ");
      return cors({
        error: `Cal event type "${interviewSlug}" not found. Cal returned ${evtArray.length} event type(s)${found ? ": " + found : ""}.`,
        found_slugs: (Array.isArray(evtArray) ? evtArray : []).map((e: any) => e.slug),
      });
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
          // Translate day names → numbers so the dashboard editor can
          // bucket each block by 0–6 indexed day rows.
          availability: (schedule.availability ?? []).map((b: any) => ({
            ...b,
            days: Array.isArray(b?.days)
              ? b.days.map((d: unknown) => dayFromCal(d)).filter((v: unknown) => v !== null)
              : [],
          })),
        } : null,
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { timeZone, availability, locations } = body;

      // Update the schedule (availability + tz) when supplied.
      if (evt.scheduleId && (timeZone || availability)) {
        const patch: Record<string, unknown> = {};
        if (timeZone) patch.timeZone = timeZone;
        if (Array.isArray(availability)) {
          patch.availability = availability.map((b: any) => ({
            days: Array.isArray(b?.days)
              ? b.days.map(dayToCal).filter((v: unknown) => v !== null)
              : [],
            startTime: timeToCal(b?.startTime),
            endTime:   timeToCal(b?.endTime),
          })).filter((b: any) => b.days.length > 0 && b.startTime && b.endTime);
        }
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
