// fleet-pm-core.mjs — preventive-maintenance due math (pure, tested).
//
// Mirrors the SQL in fleet_pm_board() (migration 0539) — keep the two in
// sync. A rule has an interval in miles and/or months plus warn windows;
// a vehicle×rule pair's status derives from its latest completion:
//
//   no_baseline — never completed, or the completion can't anchor any
//                 configured axis (e.g. a miles-only rule logged with no
//                 odometer reading)
//   overdue     — past the due date OR past the due mileage
//   due_soon    — inside the warn window on either axis
//   ok          — otherwise
//
// Dates are ISO "YYYY-MM-DD" strings, compared lexically (safe for ISO).
// Month addition clamps to the end of shorter months (Jan 31 + 1 mo =
// Feb 28), matching Postgres date + make_interval(months).

export const PM_STATUS_RANK = { overdue: 1, due_soon: 2, no_baseline: 3, ok: 4 };

export function addMonthsIso(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const total = y * 12 + mo + Math.trunc(months);
  const ny = Math.floor(total / 12), nmo = total % 12;
  const lastDay = new Date(Date.UTC(ny, nmo + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ny}-${pad(nmo + 1)}-${pad(nd)}`;
}

export function diffDaysIso(fromIso, toIso) {
  const p = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  };
  const a = p(fromIso), b = p(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function pmDueState({
  lastDoneOn = null,     // ISO date or null
  lastDoneMiles = null,  // odometer at completion, or null
  intervalMonths = null,
  intervalMiles = null,
  warnDays = 14,
  warnMiles = 500,
  today,                 // ISO date (required)
  currentMiles = null,   // vehicle's current odometer, or null
} = {}) {
  const dueOn = (lastDoneOn && intervalMonths) ? addMonthsIso(lastDoneOn, intervalMonths) : null;
  const dueMiles = (lastDoneMiles != null && intervalMiles) ? lastDoneMiles + intervalMiles : null;
  const daysRemaining = dueOn ? diffDaysIso(today, dueOn) : null;
  const milesRemaining = (dueMiles != null && currentMiles != null) ? dueMiles - currentMiles : null;

  let status;
  if (!lastDoneOn) {
    status = "no_baseline";
  } else if (dueOn == null && dueMiles == null) {
    status = "no_baseline";
  } else if (
    (dueOn != null && today > dueOn) ||
    (milesRemaining != null && milesRemaining < 0)
  ) {
    status = "overdue";
  } else if (
    (daysRemaining != null && daysRemaining <= warnDays) ||
    (milesRemaining != null && milesRemaining <= warnMiles)
  ) {
    status = "due_soon";
  } else {
    status = "ok";
  }

  return { status, dueOn, dueMiles, daysRemaining, milesRemaining };
}

export function worstPmStatus(statuses) {
  let worst = null;
  for (const s of statuses || []) {
    if (!(s in PM_STATUS_RANK)) continue;
    if (worst == null || PM_STATUS_RANK[s] < PM_STATUS_RANK[worst]) worst = s;
  }
  return worst;
}
