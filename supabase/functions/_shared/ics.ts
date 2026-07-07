// Minimal iCalendar (RFC 5545) helpers for interview invites.
//   • buildIcsRequest — a METHOD:REQUEST VEVENT so Gmail/Outlook render the
//     native event card (Yes/Maybe/No) and add it to the recipient's calendar.
//   • parseIcsReply    — pulls UID + PARTSTAT out of a METHOD:REPLY the
//     recipient's mail client sends back when they respond.

function icsDate(iso: string): string {
  // → 20260610T153000Z (UTC, no punctuation)
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function icsDateOnly(iso: string, tz?: string): string {
  // → 20260610 · the calendar DATE in the event's own timezone. All-day
  // events are stored as local 00:00–23:59 converted to UTC, so slicing the
  // UTC date would land a day off for positive-offset zones — resolve the
  // wall-clock date via Intl instead.
  const d = new Date(iso);
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(d).replace(/-/g, "");
    } catch { /* unknown tz — fall through to UTC */ }
  }
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function icsDateOnlyNext(iso: string, tz?: string): string {
  // The day AFTER the given instant's local date — RFC 5545 all-day DTEND
  // is exclusive, so a one-day event ending 23:59 on the 10th → DTEND on
  // the 11th.
  const s = icsDateOnly(iso, tz);
  const next = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) + 86_400_000);
  return next.toISOString().slice(0, 10).replace(/-/g, "");
}
function esc(s: string): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export interface IcsOpts {
  uid: string;            // stable id (we use the cal_event id)
  start: string;         // ISO
  end?: string | null;   // ISO
  title: string;
  description?: string;
  location?: string;
  organizerName: string;
  organizerEmail: string;
  attendeeEmail: string;
  sequence?: number;
  method?: "REQUEST" | "CANCEL";
  allDay?: boolean;      // emit VALUE=DATE start/end (whole-day event)
  tzid?: string;         // IANA zone used to resolve all-day wall-clock dates
}

export function buildIcsRequest(o: IcsOpts): string {
  const end = o.end || new Date(new Date(o.start).getTime() + 30 * 60_000).toISOString();
  const method = o.method || "REQUEST";
  const status = method === "CANCEL" ? "CANCELLED" : "CONFIRMED";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RouteReady//Interview//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${o.uid}`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    o.allDay ? `DTSTART;VALUE=DATE:${icsDateOnly(o.start, o.tzid)}` : `DTSTART:${icsDate(o.start)}`,
    o.allDay ? `DTEND;VALUE=DATE:${icsDateOnlyNext(end, o.tzid)}` : `DTEND:${icsDate(end)}`,
    `SEQUENCE:${o.sequence ?? 0}`,
    `SUMMARY:${esc(o.title)}`,
    o.description ? `DESCRIPTION:${esc(o.description)}` : null,
    o.location ? `LOCATION:${esc(o.location)}` : null,
    o.location ? `URL:${esc(o.location)}` : null,
    `ORGANIZER;CN=${esc(o.organizerName)}:mailto:${o.organizerEmail}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${esc(o.attendeeEmail)}:mailto:${o.attendeeEmail}`,
    `STATUS:${status}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean) as string[];
  return lines.join("\r\n");
}

// Multi-event VCALENDAR for the subscribe feeds (calendar-feed function).
// No METHOD (this is a published calendar, not an invite); X-WR-CALNAME
// names the subscription in the client; PUBLISHED-TTL hints refresh cadence.
export interface FeedEvent {
  uid: string; start: string; end?: string | null; title: string;
  description?: string; location?: string; allDay?: boolean; tzid?: string;
}
export function buildIcsFeed(name: string, events: FeedEvent[]): string {
  const stamp = icsDate(new Date().toISOString());
  const lines: (string | null)[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RouteReady//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${esc(name)}`,
    "X-PUBLISHED-TTL:PT15M",
  ];
  for (const o of events) {
    const end = o.end || new Date(new Date(o.start).getTime() + 30 * 60_000).toISOString();
    lines.push(
      "BEGIN:VEVENT",
      `UID:${o.uid}`,
      `DTSTAMP:${stamp}`,
      o.allDay ? `DTSTART;VALUE=DATE:${icsDateOnly(o.start, o.tzid)}` : `DTSTART:${icsDate(o.start)}`,
      o.allDay ? `DTEND;VALUE=DATE:${icsDateOnlyNext(end, o.tzid)}` : `DTEND:${icsDate(end)}`,
      `SUMMARY:${esc(o.title)}`,
      o.description ? `DESCRIPTION:${esc(o.description)}` : null,
      o.location ? `LOCATION:${esc(o.location)}` : null,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return (lines.filter(Boolean) as string[]).join("\r\n");
}

// Pull the response out of a calendar REPLY. Returns the UID and the
// PARTSTAT (ACCEPTED / DECLINED / TENTATIVE) if this is a METHOD:REPLY.
export function parseIcsReply(text: string): { uid: string | null; partstat: string | null } {
  if (!text || !/METHOD:REPLY/i.test(text)) return { uid: null, partstat: null };
  const unfolded = text.replace(/\r?\n[ \t]/g, ""); // RFC5545 line unfolding
  const uidM = unfolded.match(/^UID:(.+)$/mi);
  const psM = unfolded.match(/PARTSTAT=([A-Za-z-]+)/);
  return {
    uid: uidM ? uidM[1].trim() : null,
    partstat: psM ? psM[1].toUpperCase() : null,
  };
}
