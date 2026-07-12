# Two-Factor Authentication (MFA) — rollout & test plan

RouteReady ships TOTP two-factor **dark**. Nothing about login changes until you
flip one flag. This doc is the plan to turn it on **safely** — enroll, verify on a
real device, prove you can recover from a lost phone — before anyone is required to
use it.

## How it's built (why it can't lock you out by surprise)

- **Master switch:** `RR_CONFIG.MFA_ENABLED` in `dashboard/config.js` (default `false`).
  When false: no enrollment UI, no login challenge — zero change.
- **Opt-in:** enabling MFA does not force anyone. A user is only ever challenged if
  **they** enrolled an authenticator factor. A user with no factor logs in exactly as
  before (magic link only). So flipping the switch cannot lock out someone who never
  enrolled.
- **Fails open on bugs:** the login gate (`_rrMfaGateOnBoot` in `live.js`) returns and
  lets you in if the MFA API errors. Only a *wrong or missing code* blocks. A bug in the
  check can't lock people out.
- **Standard primitive:** uses Supabase's built-in TOTP MFA (`sb.auth.mfa.*`). Supabase
  returns the enrollment QR itself, so there's no QR library and no secret handling in
  our code.

## Rollout — do this in order

### 1. Turn it on
Set `MFA_ENABLED: true` in `dashboard/config.js`, commit, and let it deploy (Cloudflare
Pages). This reveals **Settings → Workspace → Two-factor** and arms the login gate for
anyone who enrolls. It does **not** yet challenge anyone (no one has a factor).

### 2. Enroll your own account
Settings → **Two-factor → Set up** → scan the QR with Google Authenticator / Authy /
1Password → enter the 6-digit code → **Activate**. Status should read *"Two-factor is
ON for your account."*

### 3. ✅ Prove the login challenge works — THE KEY TEST
1. Sign out.
2. Sign in with your magic link as usual.
3. **Expected:** before the dashboard loads, a full-screen *"Enter your code"* prompt
   appears.
4. Enter the current code from your app → you reach the dashboard.
5. Sign out, sign in again, and try a **wrong** code → it's rejected; the correct code
   lets you in. Confirm **Sign out** on that screen returns you to login.

If anything here misbehaves, set `MFA_ENABLED: false` and redeploy — you're instantly
back to magic-link-only. Enrolled factors stay but are no longer enforced.

### 4. ✅ Prove recovery from a lost phone — DO NOT SKIP
Simulate a user who lost their authenticator. In the Supabase **SQL Editor**:

```sql
-- Remove all authenticator factors for one user (they drop back to magic-link only).
delete from auth.mfa_factors
where user_id = (select id from auth.users where email = 'person@example.com');
```

Then confirm that user can sign in with just the magic link again (no code prompt).
**This SQL is your break-glass.** Keep it somewhere your team can reach it. Without a
tested recovery path, MFA is a lockout waiting to happen.

### 5. (Later) Require it for everyone
This build makes MFA available and enforced **per enrolled user**. Mandating it for all
staff — blocking users who haven't enrolled until they do — is a deliberate follow-up,
not part of this rollout. Get comfortable with steps 1–4 across a few real accounts
first.

## Rollback

`MFA_ENABLED: false` → redeploy. The login gate goes dormant immediately. No data
change; enrolled factors simply stop being challenged (and can be removed via the SQL
above if you want them gone).

## What each piece is

| Piece | Where |
|---|---|
| Master flag | `dashboard/config.js` → `MFA_ENABLED` |
| Login challenge gate | `dashboard/live.js` → `_rrMfaGateOnBoot()` |
| Enroll / activate / disable | `dashboard/live.js` → `rrMfaSetup` / `rrMfaDisable` / `rrMfaRefreshStatus` |
| Settings panel | `dashboard/views/view-settings.frag` → `.rr-mfa-only` block |
| Recovery | this doc, §4 |

## Notes / limits (v1)

- **TOTP only** (authenticator apps). No SMS second factor — SMS MFA is weaker and
  costs Twilio money; skip it.
- **No self-service backup codes yet.** Recovery is the admin SQL in §4. Adding
  user-facing backup codes is a reasonable v2.
- The challenge is required at **login** (session step-up to AAL2), not re-prompted
  mid-session. The idle-timeout (separate feature) still forces a fresh login after
  inactivity, at which point the code is required again.
