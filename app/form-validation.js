// RouteReady Driver PWA · shared form-answer validation
//
// Single source of truth for driver-form field validation on the CLIENT.
// It is deliberately a standalone, dependency-free ES module (no window /
// document / network) so it can be unit-tested in Node and diffed against
// the SERVER rules in supabase/migrations/0439_driver_forms_server_validation.sql.
//
// The two implementations (this file + the SQL in driver_submit_form) MUST
// stay in lockstep: a submission that passes here must pass the server, and
// vice-versa. tests/driver-forms/validation-cases.json is the shared fixture
// set both are checked against (scripts/test-driver-forms.mjs for JS,
// supabase/tests/driver_forms_test.sql for SQL); if the two ever drift, one
// of those suites fails.

// Conditional-logic eligibility: only these earlier field types can be a
// trigger (discrete answers). Mirrors the builder's _COND_TRIGGER_TYPES and
// the SQL private.form_field_visible eligibility check.
export const COND_TRIGGER_TYPES = new Set(["yes_no", "single_choice", "dropdown", "rating"]);

// Field types that are layout-only — never collected, never validated.
export const LAYOUT_FIELD_TYPES = new Set(["section_header", "divider", "instructions"]);

// Validate one answer against its field's rules. Returns an error string
// (already user-facing) or null when the answer is acceptable. Mirrors the
// server-side checks in migration 0439 so the app and DB agree.
export function validateFormAnswer(f, v) {
  const label = f.label || "This field";
  const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
  if (empty) return f.required ? `"${label}" is required` : null;
  const val = (f.validation && typeof f.validation === "object") ? f.validation : {};
  switch (f.type) {
    case "email":
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) return `"${label}" needs a valid email address`;
      break;
    case "phone":
      if (String(v).replace(/\D/g, "").length < 7) return `"${label}" needs a valid phone number`;
      break;
    case "number": {
      const n = Number(v);
      if (!isFinite(n)) return `"${label}" must be a number`;
      if (val.min != null && n < val.min) return `"${label}" must be at least ${val.min}`;
      if (val.max != null && n > val.max) return `"${label}" must be at most ${val.max}`;
      break;
    }
    case "rating": {
      const n = Number(v);
      if (!(n >= 1 && n <= 5)) return `"${label}" has an invalid rating`;
      break;
    }
    case "short_text":
    case "long_text": {
      const len = String(v).length;
      if (val.minLen != null && len < val.minLen) return `"${label}" must be at least ${val.minLen} characters`;
      if (val.maxLen != null && len > val.maxLen) return `"${label}" must be ${val.maxLen} characters or fewer`;
      break;
    }
    case "single_choice":
    case "dropdown": {
      const opts = Array.isArray(f.options) ? f.options : [];
      if (opts.length && !opts.includes(String(v))) return `"${label}" has an invalid selection`;
      break;
    }
    case "multi_choice": {
      const opts = Array.isArray(f.options) ? f.options : [];
      if (opts.length && Array.isArray(v) && v.some(x => !opts.includes(x))) return `"${label}" has an invalid selection`;
      break;
    }
  }
  return null;
}
