// Minimal iCalendar (RFC 5545) helpers for interview invites.
//   • buildIcsRequest — a METHOD:REQUEST VEVENT so Gmail/Outlook render the
//     native event card (Yes/Maybe/No) and add it to the recipient's calendar.
//   • parseIcsReply    — pulls UID + PARTSTAT out of a METHOD:REPLY the
//     recipient's mail client sends back when they respond.

function icsDate(iso: string): string {
  // → 20260610T153000Z (UTC, no punctuation)
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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
    `DTSTART:${icsDate(o.start)}`,
    `DTEND:${icsDate(end)}`,
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
