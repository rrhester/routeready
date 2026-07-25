# H-6 · Uptime monitoring — point a monitor at `/health`

**Finding (audit High H-6):** RouteReady has no external monitoring. If the
database or edge tier goes down, the first person to notice is your customer —
not you. The fix is one external uptime check; the endpoint it needs already
ships.

## The endpoint (already deployed)

`supabase/functions/health/index.ts` is a purpose-built, unauthenticated
liveness/readiness probe (deployed `verify_jwt = false`, so a monitor can hit
it with no credentials). It does the cheapest round-trip that proves Postgres +
PostgREST are alive (a head-only count against `dsps`) and returns **only**
up/down + latency — never any tenant data.

**URL:**
```
https://doiwrhkirgblcvuskhno.functions.supabase.co/health
```
(equivalently `https://doiwrhkirgblcvuskhno.supabase.co/functions/v1/health`)

**Responses:**
| HTTP | Body | Meaning |
|---|---|---|
| `200` | `{"status":"ok","db":"up","ms":<n>,"time":…}` | Postgres + PostgREST answered. Healthy. |
| `503` | `{"status":"degraded","db":"down","error":…,"ms":<n>}` | DB round-trip failed. **Alert.** |

Because it returns a real `503` on failure (not a 200 with an error in the
body), any monitor that alerts on non-2xx status works out of the box — no
keyword/JSON parsing needed.

## Setup (pick one monitor — ~5 minutes)

Any of these work; free tiers are fine to start.

**Better Stack / UptimeRobot / Pingdom / Checkly:**
1. Create an HTTP(S) monitor with the URL above.
2. **Method:** GET (HEAD also works). **Interval:** 60s (or the tightest the
   free tier allows).
3. **Alert condition:** status code is not `200` (a `503` = DB down). Most
   tools default to this.
4. **Alert channel:** your phone/email — and ideally a second channel (SMS or
   a push app) so a single-channel outage doesn't hide the alert.
5. Optional but recommended: add a **latency** alert (e.g. `ms` / response time
   > 2000ms for 3 consecutive checks) to catch a slow-but-up database before it
   becomes a hard outage.

**Zero-dependency fallback (a cron `curl`)** — if you don't want a SaaS monitor,
run this from any always-on box (a cheap VPS, a home server, a GitHub Action on
a schedule) and pipe failures to email/SMS:
```sh
curl -fsS --max-time 10 \
  https://doiwrhkirgblcvuskhno.functions.supabase.co/health \
  > /dev/null || notify "RouteReady /health is DOWN"   # -f makes 503 a failure
```

## Verify it works

- Hit the URL in a browser — you should see `{"status":"ok",…}`.
- Trigger a test alert from the monitor's UI (most have a "test"/"pause &
  resume" button) to confirm the notification actually reaches your phone. An
  alert you never receive is the same as no monitor.

## What this does and doesn't cover

- **Covers:** the whole request path is broken (DB down, PostgREST down, project
  paused, edge tier unreachable). That is the outage class that otherwise
  reaches you via an angry customer.
- **Doesn't cover:** a single tenant's data being wrong, a slow query on one
  page, or a broken edge function other than the app path. Those need app-level
  error reporting (`client_errors`, already wired) — a separate, later step.
