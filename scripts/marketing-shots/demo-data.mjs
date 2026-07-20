// Fictional demo dataset for marketing screenshots. All names invented.
export const DSP_ID = "11111111-1111-1111-1111-111111111111";
export const UID    = "22222222-2222-2222-2222-222222222222";
export const ST1    = "33333333-3333-3333-3333-333333333331";
export const SVC_SP = "44444444-4444-4444-4444-444444444441";
export const SVC_XL = "44444444-4444-4444-4444-444444444442";

export const DSP = {
  id: DSP_ID, name: "Blue Ridge Logistics", short_code: "BRL",
  timezone: "America/New_York",
  metadata: { scheduling: { cushion_pct: 10 } },
};

export const STATIONS = [{ id: ST1, dsp_id: DSP_ID, code: "DNW2", name: "Norwood", active: true }];

// 12 fictional drivers.
let _phoneSeq = 100;
const N = (id, full, first, last, opts = {}) => ({
  id, full_name: full, first_name: first, last_name: last, preferred_name: null,
  status: "active", station_id: ST1, hire_date: opts.hire || "2025-03-10",
  birthday: opts.bday || null, tier: opts.tier || null, metadata: {},
  dl_expires_on: opts.dl || "2027-05-01", dot_certified: true,
  xl_certified: !!opts.xl, edv_certified: false, is_trainer: !!opts.trainer,
  role: null, station: { code: "DNW2" },
  phone: "(571) 555-0" + (_phoneSeq++),   // 555-01xx fictional range
  score: 84 + ((_phoneSeq * 7) % 14),
  email: (first + "." + last).toLowerCase() + "@example.com",
});

export const DRIVERS = [
  N("d-01", "Marcus Bell",      "Marcus", "Bell",      { xl: true, trainer: true, hire: "2024-02-12" }),
  N("d-02", "Tanya Rivera",     "Tanya",  "Rivera",    { hire: "2024-06-03" }),
  N("d-03", "Jordan Reyes",     "Jordan", "Reyes",     { xl: true, hire: "2024-09-22" }),
  N("d-04", "Alicia Whitfield", "Alicia", "Whitfield", { hire: "2025-01-15" }),
  N("d-05", "Sam Okafor",       "Sam",    "Okafor",    { xl: true, hire: "2025-02-20" }),
  N("d-06", "Dana Kowalski",    "Dana",   "Kowalski",  { hire: "2025-04-01" }),
  N("d-07", "Chris Yang",       "Chris",  "Yang",      { hire: "2025-05-11" }),
  N("d-08", "Maria Santos",     "Maria",  "Santos",    { xl: true, trainer: true, hire: "2023-11-06" }),
  N("d-09", "Devon Carter",     "Devon",  "Carter",    { hire: "2025-06-16" }),
  N("d-10", "Priya Nair",       "Priya",  "Nair",      { hire: "2025-08-04" }),
  N("d-11", "Luke Bennett",     "Luke",   "Bennett",   { hire: "2025-09-29" }),
  N("d-12", "Grace Kim",        "Grace",  "Kim",       { hire: "2025-10-13", dl: "2026-07-26" }),
  N("d-13", "Aaron Diaz",       "Aaron",  "Diaz",      { hire: "2025-11-17" }),
  N("d-14", "Nicole Freeman",   "Nicole", "Freeman",   { xl: true, hire: "2026-01-05" }),
  N("d-15", "Omar Haddad",      "Omar",   "Haddad",    { hire: "2026-02-09" }),
  N("d-16", "Jess Thompson",    "Jess",   "Thompson",  { hire: "2026-03-23" }),
];

export const VANS = Array.from({ length: 13 }, (_, i) => {
  const n = i + 1;
  const makes = [
    ["Ford", "Transit 250", 2023], ["Ford", "Transit 350", 2022], ["RAM", "ProMaster 2500", 2023],
    ["Ford", "Transit 250", 2024], ["RAM", "ProMaster 3500", 2022], ["Ford", "Transit 350", 2023],
    ["Ford", "Transit 250", 2022], ["RAM", "ProMaster 2500", 2024], ["Ford", "Transit 350", 2024],
    ["Ford", "Transit 250", 2023], ["RAM", "ProMaster 2500", 2023], ["Ford", "Transit 350", 2023],
    ["Ford", "Transit 250", 2024],
  ];
  const [make, model, year] = makes[i];
  return {
    id: "v-" + String(n).padStart(2, "0"),
    name: String(100 + n), nickname: null, kind: "van", status: "active",
    ownership: "leased", van_type: "cdv", operational_status: n === 13 ? "maintenance" : "operational",
    year, make, model, trim_level: null, color: "White",
    plate: "TR" + (4200 + n * 7), plate_state: "VA",
    vin: "1FTBW2CM" + String(70000 + n * 137).padStart(8, "0"),
    mileage: 18000 + n * 3120, mileage_updated_at: null,
    doc_insurance:    { status: "active", expires_on: "2027-01-31" },
    doc_registration: n === 6 ? { status: "expiring_soon", days_until: 21, expires_on: "2026-08-10" } : { status: "active", expires_on: "2027-02-28" },
    last_route_completed_at: null, photo_path: null,
    station_id: ST1, station_code: "DNW2",
    last_service_at: "2026-06-0" + ((n % 9) + 1), next_service_due_at: null,
    dot_inspection_at: "2026-03-15", registration_expires_on: "2027-02-28",
    insurance_expires_on: "2027-01-31", updated_at: null,
    is_branded: true, archived_at: null,
    primary_driver_id: DRIVERS[i] ? DRIVERS[i].id : null,
    primary_driver_name: DRIVERS[i] ? DRIVERS[i].full_name : null,
    backup_count: n % 3 === 0 ? 1 : 0,
    open_issue_count: n === 11 ? 1 : 0,
  };
});

// ── Week generation ──────────────────────────────────────────────────
const iso = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
export const todayIso = iso(new Date());
const sunday = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d; })();
export const WEEK_START = iso(sunday);
export const weekDates = Array.from({ length: 7 }, (_, i) => { const d = new Date(sunday); d.setDate(d.getDate() + i); return iso(d); });

// Grace Kim (d-12) is on PTO Thu+Fri.
export const TIME_OFF = [{
  id: "to-1", driver_id: "d-12", start_date: weekDates[4], end_date: weekDates[5],
  status: "approved", is_pto: true,
}];

// Build shifts: Sun = 7 seats, Mon-Sat = 10 seats; one XL seat on weekdays.
// Rotation keeps every driver at 5-6 days.
export function buildWeek(startIsoStr, weeks = 1) {
  const start = new Date(startIsoStr + "T12:00:00");
  const shifts = [];
  const coverage = [];
  let sid = 0;
  let cursor = 0; // fair round-robin over the driver list
  for (let w = 0; w < weeks; w++) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(d.getDate() + w * 7 + i);
      const dateIso = iso(d);
      const dow = d.getDay();
      const seats = dow === 0 ? 7 : dow === 6 ? 9 : 10;
      const targets = dow === 0 ? 6 : dow === 6 ? 8 : 9;
      const xlSeats = (dow >= 1 && dow <= 5) ? 1 : 0;
      // fair rotation: keep pulling from a cycling pointer, skip PTO
      const onPto = (dr) => TIME_OFF.some((t) => t.driver_id === dr.id && dateIso >= t.start_date && dateIso <= t.end_date);
      const crew = [];
      let guard = 0;
      while (crew.length < seats && guard++ < DRIVERS.length * 2) {
        const dr = DRIVERS[cursor % DRIVERS.length];
        cursor++;
        if (onPto(dr) || crew.includes(dr)) continue;
        crew.push(dr);
      }
      // XL seats need xl_certified drivers — move one to front
      if (xlSeats) {
        const idx = crew.findIndex((c) => c.xl_certified);
        if (idx > 0) { const [x] = crew.splice(idx, 1); crew.unshift(x); }
      }
      const past = dateIso < todayIso;
      crew.forEach((dr, k) => {
        const isXl = k < xlSeats;
        const wave = k < Math.ceil(seats * 0.6) ? 1 : 2;
        const startT = wave === 1 ? "10:20:00" : "10:50:00";
        const startsAt = `${dateIso}T${startT}-04:00`;
        const endH = wave === 1 ? "19:20:00" : "19:50:00";
        shifts.push({
          id: "sh-" + (++sid), date: dateIso, station_id: ST1,
          driver_id: dr.id, driver_name: dr.full_name,
          route_code: null, status: past ? "completed" : "scheduled",
          starts_at: startsAt, ends_at: `${dateIso}T${endH}-04:00`,
          block_hours: 9, is_cushion: k >= targets, wave_index: wave,
          service_type_id: isXl ? SVC_XL : SVC_SP,
          service_type_code: isXl ? "XL" : "SP",
          service_type_label: isXl ? "Extra Large" : "Standard Parcel",
          service_type_color: isXl ? "#f97316" : "#3b82f6",
          shift_kind: "regular", trainer_driver_id: null, trainer_name: null,
          route_classification: null, notes: null,
          van_id: null, // filled below by seat index
        });
        shifts[shifts.length - 1].van_id = "v-" + String((k % 13) + 1).padStart(2, "0");
      });
      const wave1 = crew.filter((_, k) => k < Math.ceil(seats * 0.6)).length;
      coverage.push({
        date: dateIso, station_id: ST1, station_code: "DNW2",
        target_routes: targets,
        targets_by_wave: [
          { wave_index: 1, service_type_id: SVC_SP, service_type_code: "SP", target_routes: Math.max(0, Math.min(targets - xlSeats, wave1 - xlSeats)) },
          ...(xlSeats ? [{ wave_index: 1, service_type_id: SVC_XL, service_type_code: "XL", target_routes: xlSeats }] : []),
          { wave_index: 2, service_type_id: SVC_SP, service_type_code: "SP", target_routes: Math.max(0, targets - wave1) },
        ].filter((t) => t.target_routes > 0),
        filled_by_wave: [
          { wave_index: 1, service_type_id: SVC_SP, service_type_code: "SP", filled: wave1 - xlSeats },
          ...(xlSeats ? [{ wave_index: 1, service_type_id: SVC_XL, service_type_code: "XL", filled: xlSeats }] : []),
          { wave_index: 2, service_type_id: SVC_SP, service_type_code: "SP", filled: seats - wave1 },
        ].filter((t) => t.filled > 0),
        cushion_pct: 10, needed: targets, filled: seats,
        open_count: Math.max(0, targets - seats),
      });
    }
  }
  return { coverage, shifts, start: startIsoStr, weeks };
}

// Van day assignments mirror the per-shift seat-index van mapping —
// unique van per driver within a day, vans shared across days.
export function buildVanDays(grid) {
  return grid.shifts
    .filter((s) => s.driver_id && s.van_id)
    .map((s) => ({ vehicle_id: s.van_id, driver_id: s.driver_id, date: s.date }));
}
