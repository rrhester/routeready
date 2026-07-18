// Login-flow e2e against a stubbed Supabase (project-review PR#82).
// The load-bearing guarantees:
//   1. ?next= is sanitized to a same-origin relative path — a cross-origin
//      next must NOT survive to location.replace (the open-redirect fix).
//   2. The mode machine switches password ↔ magic-link ↔ reset.
import { test, expect } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:8126";
const LOGIN = ORIGIN + "/dashboard/login.html";

// A far-future fake session so onAuthStateChange / getSession are happy.
const SESSION = {
  access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlMmUifQ.x",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "r",
  user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "you@example.com" },
};

// Stub Supabase auth/REST. Everything off our origin is aborted except the
// Supabase host, whose auth token endpoint returns a session so a password
// sign-in "succeeds" and login.html runs its location.replace(next).
async function stubAuth(page) {
  await page.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith(ORIGIN + "/")) return r.continue();
    if (/\.supabase\.co\//.test(u)) {
      const j = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      const path = new URL(u).pathname;
      if (path.includes("/auth/v1/token")) return j(SESSION);
      if (path.includes("/auth/v1/user")) return j(SESSION.user);
      if (path.includes("/auth/v1")) return j({});
      return j([]);
    }
    return r.abort();
  });
}

test("cross-origin ?next= is sanitized — no open redirect", async ({ page }) => {
  await stubAuth(page);
  // A malicious next. After a successful sign-in the page must land on the
  // same-origin fallback (index.html), NEVER navigate to evil.example.
  await page.goto(LOGIN + "?next=" + encodeURIComponent("https://evil.example/steal"));
  await page.fill("#pw-email", "you@example.com");
  await page.fill("#pw-password", "hunter2hunter2");
  await page.click("#form-password button.primary");
  // A cross-origin next is dropped to the same-origin fallback (index.html).
  // Wait for the DESTINATION specifically — the login page is also under
  // /dashboard/, so a looser match would resolve before the redirect.
  await page.waitForURL(/\/dashboard\/index\.html/, { timeout: 15000 });
  const url = page.url();
  expect(url).not.toContain("evil.example");
  expect(new URL(url).origin).toBe(ORIGIN);
});

test("a same-origin relative ?next= is honored", async ({ page }) => {
  await stubAuth(page);
  await page.goto(LOGIN + "?next=" + encodeURIComponent("/dashboard/index.html?tab=schedule"));
  await page.fill("#pw-email", "you@example.com");
  await page.fill("#pw-password", "hunter2hunter2");
  await page.click("#form-password button.primary");
  await page.waitForURL(/\/dashboard\/index\.html/, { timeout: 15000 });
  expect(page.url()).toContain("/dashboard/index.html");
});

test("mode machine switches password ↔ magic ↔ reset", async ({ page }) => {
  await stubAuth(page);
  await page.goto(LOGIN);
  // Default: password form visible, magic hidden.
  await expect(page.locator("#form-password")).toBeVisible();
  await expect(page.locator("#form-magic")).toBeHidden();
  // → magic link
  await page.click('[data-go="magic"]');
  await expect(page.locator("#form-magic")).toBeVisible();
  await expect(page.locator("#form-password")).toBeHidden();
  // → back to password
  await page.click('[data-go="password"]');
  await expect(page.locator("#form-password")).toBeVisible();
  // → reset request
  await page.click('[data-go="reset-req"]');
  await expect(page.locator("#form-reset-req")).toBeVisible();
});
