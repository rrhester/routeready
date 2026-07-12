// Public Supabase config for the operator dashboard.
//
// The anon key is safe to ship to the browser — it has no power beyond
// the RLS policies + RPC grants we configured in migrations 0001-0005.
// Replace ANON_KEY below with the value from
//   Supabase Dashboard → Project Settings → API → anon public.
//
// To rotate: regenerate in Supabase, then update this file.

window.RR_CONFIG = Object.freeze({
  SUPABASE_URL:     "https://doiwrhkirgblcvuskhno.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_HvRuTWdEOrYlJPPIp4CLog_UNC3vNdI",
  ALLOWED_SIGNUP_DOMAINS: ["gorouteready.com"],
  PUBLIC_BASE_URL:  "https://gorouteready.com",
  // Minutes of no interaction before the operator dashboard forces a clean
  // re-login (HR/PII on shared machines). Set to 0 to disable.
  IDLE_TIMEOUT_MINUTES: 30,
  // Two-factor authentication (TOTP). Ships DARK (false): no enrollment UI,
  // no login challenge — zero change until you flip it. When true: the
  // Settings → Two-factor panel appears and any user WITH a verified
  // authenticator factor is challenged for a code at login. A user with NO
  // factor is never blocked, so enabling this cannot lock out anyone who
  // hasn't enrolled. See docs/MFA.md for the rollout + recovery steps.
  MFA_ENABLED: true,
});
