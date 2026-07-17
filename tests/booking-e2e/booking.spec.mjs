// End-to-end candidate booking flow (#95) against stubbed Supabase routes.
// What must never regress: a candidate with a valid link can always see
// times, answer required intake, and book — and the RPC payload carries
// exactly what they entered.
import { test, expect } from "@playwright/test";
import fs from "node:fs";

const BUNDLE = process.env.RR_SUPABASE_ESM || new URL("./.supabase-esm.js", import.meta.url).pathname;
const PAGE = "http://127.0.0.1:8124/dashboard/booking.html?t=e2e-token";

const INFO = {
  dsp: { name: "Test DSP", short_code: "TD" },
  applicant: { first_name: "Pat", full_name: "Pat Doe" },
  timezone: "America/Chicago",
  slot_minutes: 30,
  schedule_name: "Driver interview",
  branding: {},
  arrival_notes: "Park in the visitor lot.",
  intake_questions: [{ label: "Do you have a valid CDL?", required: true, type: "text" }],
  require_phone_verify: false,
  phone_hint: null,
  captcha_sitekey: null,
  options: [],
  already_booked: false,
  booking: null,
};

function slotsPayload() {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 3);
  base.setUTCHours(15, 0, 0, 0);
  return [0, 1, 2, 3].map((i) => ({
    slot_start: new Date(base.getTime() + i * 30 * 60000).toISOString(),
    slot_end: new Date(base.getTime() + (i + 1) * 30 * 60000).toISOString(),
    capacity: 1, remaining: 1, session_id: null,
  }));
}

// Route order matters: Playwright matches newest-first, so the catch-all
// abort goes FIRST, then the CDN fulfillment, then the Supabase stub.
async function stubSupabase(page, info) {
  const calls = { book: [] };
  await page.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith("http://127.0.0.1:8124/")) return r.continue();
    return r.abort();
  });
  await page.route("**cdn.jsdelivr.net/**supabase-js**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(BUNDLE, "utf8") }));
  await page.route("https://*.supabase.co/**", (r) => {
    const u = new URL(r.request().url());
    const j = (b, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname.endsWith("/rpc/booking_load")) return j(info);
    if (u.pathname.endsWith("/rpc/interview_open_slots")) return j(slotsPayload());
    if (u.pathname.endsWith("/rpc/book_interview_slot")) {
      calls.book.push(JSON.parse(r.request().postData() || "{}"));
      return j({ ok: true, event_id: "00000000-0000-4000-8000-000000000001" });
    }
    if (u.pathname.endsWith("/rpc/booking_confirm")) return j({ ok: true });
    return j([]);
  });
  return calls;
}

test("candidate books a slot end-to-end (intake enforced, payload correct)", async ({ page }) => {
  const calls = await stubSupabase(page, INFO);
  await page.goto(PAGE);

  // Boots with the DSP's identity and the slot grid.
  await expect(page.locator("#host-name")).toHaveText("Test DSP");
  await expect(page.locator("#host-title")).toHaveText("Driver interview");
  const slot = page.locator(".gslot").first();
  await expect(slot).toBeVisible({ timeout: 20000 });
  await slot.click();

  // Confirm sheet: identity line, intake question, arrival notes.
  await expect(page.locator(".confirm")).toBeVisible();
  await expect(page.locator(".who")).toContainText("Pat");
  await expect(page.locator(".arrive")).toContainText("visitor lot");

  // Required intake blocks an empty submit BEFORE any RPC round-trip.
  await page.locator('[data-cx="confirm"]').click();
  await expect(page.locator("#confirm-err")).toContainText(/required/i);
  expect(calls.book.length).toBe(0);

  // Fill it in and book.
  await page.locator("[data-iq]").fill("Yes, class A");
  await page.locator('[data-cx="confirm"]').click();
  await expect(page.locator(".msg strong").first()).toContainText(/Booked/i, { timeout: 15000 });

  // The RPC carried the token and the intake answer verbatim.
  expect(calls.book.length).toBe(1);
  expect(calls.book[0].p_token).toBe("e2e-token");
  expect(calls.book[0].p_answers["Do you have a valid CDL?"]).toBe("Yes, class A");
});

test("already-booked state offers manage actions (confirm / reschedule / cancel / late)", async ({ page }) => {
  const starts = new Date(Date.now() + 2 * 864e5);
  const info = {
    ...INFO,
    already_booked: true,
    booking: {
      starts_at: starts.toISOString(),
      ends_at: new Date(starts.getTime() + 30 * 60000).toISOString(),
      meeting_url: null, location: "1 Depot Way", running_late: null, confirmed: false,
    },
  };
  await stubSupabase(page, info);
  await page.goto(PAGE);

  await expect(page.locator('[data-ab="reschedule"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-ab="cancel"]')).toBeVisible();
  await expect(page.locator('[data-ab="late"]')).toBeVisible();
  // "I'll be there" (0497) — tapping it confirms and acknowledges.
  const confirmBtn = page.locator('[data-ab="confirm"]');
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await expect(page.locator("#ab-note")).toContainText(/confirmed/i);
});
