// google-calendar-pull · The inbound half of two-way Google Calendar sync.
//
// Runs on a 5-minute cron (private.fire_gcal_pull → pg_net, 0432) and, per
// connected DSP account, walks Google's incremental change feed (syncToken):
//
//   • RouteReady-pushed events edited IN GOOGLE (matched by google_event_id)
//     get their time/location pulled back; a Google-side delete cancels the
//     local copy for free-form events. Interviews/orientations are never
//     cancelled from Google — their cancellation flows (candidate notice,
//     rebooking) live in RouteReady, so a Google delete is left to the
//     outbound sync's 404 self-heal instead.
//   • Google-NATIVE timed, busy events are imported as provider='google'
//     cal_events rows, which makes them real busy-blocks for the interview
//     booking engine (no more double-booking candidates over the operator's
//     Google meetings). All-day and transparency='transparent' (Free) items
//     are NOT imported — an imported birthday would block a whole day of
//     interview slots — they stay visible via the read-only overlay, which
//     already skips anything whose id exists in cal_events.
//
// Loop safety: applying an inbound change updates cal_events → the 0432
// trigger echoes one outbound push with identical values → Google bumps the
// event, the next pull sees it, values compare equal, nothing is written.
// The echo terminates after one cycle. Imported inserts never fire the
// outbound trigger at all (INSERTs with google_event_id set are skipped).
//
// A stale syncToken (410) or a full sync older than FULL_RESYNC_DAYS drops
// the token and re-lists a fresh [-7d, +180d] window; that pass also cancels
// imported rows whose Google copy vanished while the token was stale.
//
// Deployed --no-verify-jwt; gated by the x-rr-sync-token shared secret.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { getAccessToken, gcalSyncList, type GCalAccount } from "../_shared/google_calendar.ts";

const FULL_WINDOW_PAST_DAYS = 7;
const FULL_WINDOW_FUTURE_DAYS = 180;
const FULL_RESYNC_DAYS = 14;

// deno-lint-ignore no-explicit-any
export function itemTimes(it: any): { start: string | null; end: string | null; allDay: boolean } {
  const allDay = !!(it.start && it.start.date && !it.start.dateTime);
  const start = it.start?.dateTime || (it.start?.date ? it.start.date + "T00:00:00Z" : null);
  const end = it.end?.dateTime || (it.end?.date ? it.end.date + "T00:00:00Z" : null);
  return { start, end, allDay };
}

// Import policy for Google-native items (no matching cal_events row).
// deno-lint-ignore no-explicit-any
export function shouldImport(it: any): boolean {
  if (!it || it.status === "cancelled") return false;
  const { start, allDay } = itemTimes(it);
  if (!start || allDay) return false;                 // all-day → overlay only
  if (it.transparency === "transparent") return false; // marked Free → not busy
  if (it.eventType && it.eventType !== "default") return false; // OOO/focus/birthday/workingLocation
  // deno-lint-ignore no-explicit-any
  const self = (it.attendees || []).find((a: any) => a?.self);
  if (self && self.responseStatus === "declined") return false;
  return true;
}

const sameInstant = (a: string | null, b: string | null) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
};

Deno.serve(async (req) => {
  if (req.headers.get("x-rr-sync-token") !== Deno.env.get("GOOGLE_SYNC_TRIGGER_TOKEN")) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const supa = serviceClient();
  const { data: accounts } = await supa.from("google_calendar_accounts").select("*");
  if (!accounts || accounts.length === 0) return jsonResponse({ ok: true, accounts: 0 });

  const summary: Record<string, unknown>[] = [];
  for (const acct of accounts as (GCalAccount & {
    sync_token: string | null; full_synced_at: string | null;
  })[]) {
    const dsp = acct.dsp_id;
    const cal = acct.calendar_id || "primary";
    let updated = 0, imported = 0, cancelled = 0;
    try {
      const token = await getAccessToken(supa, acct);

      const fullStale = !acct.full_synced_at ||
        Date.now() - new Date(acct.full_synced_at).getTime() > FULL_RESYNC_DAYS * 864e5;
      let syncToken: string | null = fullStale ? null : (acct.sync_token || null);
      let fullSync = !syncToken;

      const runList = async () => {
        // deno-lint-ignore no-explicit-any
        const items: any[] = [];
        let pageToken: string | null = null;
        let nextSyncToken: string | null = null;
        const timeMin = new Date(Date.now() - FULL_WINDOW_PAST_DAYS * 864e5).toISOString();
        const timeMax = new Date(Date.now() + FULL_WINDOW_FUTURE_DAYS * 864e5).toISOString();
        do {
          const page = await gcalSyncList(token, cal, {
            syncToken, pageToken,
            timeMin: fullSync ? timeMin : undefined,
            timeMax: fullSync ? timeMax : undefined,
          });
          items.push(...page.items);
          pageToken = page.nextPageToken;
          if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
        } while (pageToken);
        return { items, nextSyncToken };
      };

      let listed;
      try {
        listed = await runList();
      } catch (e) {
        if (String(e).includes("SYNC_TOKEN_GONE")) {
          syncToken = null; fullSync = true;
          listed = await runList();
        } else throw e;
      }

      const seenIds = new Set<string>();
      for (const it of listed.items) {
        const gid = String(it.id || "");
        if (!gid) continue;
        seenIds.add(gid);

        const { data: rows } = await supa.from("cal_events")
          .select("id, kind, status, provider, starts_at, ends_at, title, location, metadata")
          .eq("dsp_id", dsp).eq("google_event_id", gid).limit(1);
        const row = rows && rows[0];

        if (it.status === "cancelled") {
          // Deleted in Google. Cancel free-form copies; leave interviews to
          // RouteReady's own cancellation flows (see header).
          if (row && row.kind === "event" && (row.status === "scheduled" || row.status === "rescheduled")) {
            await supa.from("cal_events").update({
              status: "cancelled", cancelled_at: new Date().toISOString(),
              cancellation_reason: "Deleted in Google Calendar",
            }).eq("id", row.id);
            cancelled++;
          }
          continue;
        }

        const { start, end } = itemTimes(it);
        if (row) {
          if (row.status !== "scheduled" && row.status !== "rescheduled") continue; // don't resurrect
          if (!start) continue;
          const patch: Record<string, unknown> = {};
          if (!sameInstant(start, row.starts_at)) patch.starts_at = new Date(start).toISOString();
          if (!sameInstant(end, row.ends_at)) patch.ends_at = end ? new Date(end).toISOString() : null;
          if (typeof it.location === "string" && it.location.trim() !== (row.location || "")) {
            patch.location = it.location.trim() || null;
          }
          // Titles: free-form events accept Google-side renames; interview
          // titles are generated from the applicant and stay authoritative.
          if (row.kind === "event" && typeof it.summary === "string" && it.summary.trim() &&
              it.summary.trim() !== (row.title || "")) {
            patch.title = it.summary.trim();
          }
          if (Object.keys(patch).length > 0) {
            if (patch.starts_at || patch.ends_at) patch.status = "rescheduled";
            await supa.from("cal_events").update(patch).eq("id", row.id);
            updated++;
          }
        } else if (shouldImport(it)) {
          await supa.from("cal_events").insert({
            dsp_id: dsp, applicant_id: null, kind: "event", status: "scheduled",
            provider: "google",
            starts_at: new Date(start!).toISOString(),
            ends_at: end ? new Date(end).toISOString() : null,
            timezone: it.start?.timeZone || null,
            title: (it.summary || "(busy)").slice(0, 300),
            location: typeof it.location === "string" ? (it.location.trim() || null) : null,
            google_event_id: gid, google_calendar_id: cal,
            google_sync_status: "synced", google_synced_at: new Date().toISOString(),
            metadata: { google_html_link: it.htmlLink || null, google_native: true },
          });
          imported++;
        }
      }

      // Full-sync reconciliation: imported rows whose Google copy vanished
      // while we had no valid token get cancelled here (a live token handles
      // deletions via status:'cancelled' items instead).
      if (fullSync) {
        const { data: ghosts } = await supa.from("cal_events")
          .select("id, google_event_id")
          .eq("dsp_id", dsp).eq("provider", "google")
          .in("status", ["scheduled", "rescheduled"])
          .gte("starts_at", new Date(Date.now() - FULL_WINDOW_PAST_DAYS * 864e5).toISOString())
          .lte("starts_at", new Date(Date.now() + FULL_WINDOW_FUTURE_DAYS * 864e5).toISOString());
        for (const g of ghosts || []) {
          if (g.google_event_id && !seenIds.has(g.google_event_id)) {
            await supa.from("cal_events").update({
              status: "cancelled", cancelled_at: new Date().toISOString(),
              cancellation_reason: "Deleted in Google Calendar",
            }).eq("id", g.id);
            cancelled++;
          }
        }
      }

      const patch: Record<string, unknown> = {
        last_pulled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      if (listed.nextSyncToken) patch.sync_token = listed.nextSyncToken;
      if (fullSync) patch.full_synced_at = new Date().toISOString();
      await supa.from("google_calendar_accounts").update(patch).eq("dsp_id", dsp);

      summary.push({ dsp, ok: true, fullSync, updated, imported, cancelled });
    } catch (e) {
      summary.push({ dsp, error: String(e).slice(0, 300) });
    }
  }
  return jsonResponse({ ok: true, accounts: accounts.length, summary });
});
