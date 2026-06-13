# RouteReady Solver Service

CP-SAT optimization service for the RouteReady Workforce Optimization Engine.

Lives outside the main dashboard repo's deploy pipeline because OR-Tools
is C++ underneath and needs a server (Edge Functions cap at 256 MB / 60 s,
which doesn't fit a 200-driver CP-SAT solve).

## What this is

A FastAPI app with three endpoints:

- `POST /solve` — runs the CP-SAT model on a `SolveRequest` payload,
  returns the assignments + decisions + metrics. **v1 (current): stub
  that returns the heuristic-equivalent shape so the wire format is
  validated end-to-end.** v2 (next): real CP-SAT model.
- `POST /validate` — runs the hard-rule checks only, no solve. Fast
  pre-check for the dashboard before queueing a real solve.
- `GET /healthz` — liveness probe for the platform.

## Architecture, in one sentence

Dashboard enqueues a row in `optimization_runs` → Edge Function dispatcher
claims the row → calls this service over HTTPS → service runs CP-SAT →
writes result back to `optimization_runs` via the Supabase service role.

## Auth

Single shared secret in `RR_SOLVER_TOKEN`. Sent by the caller as
`Authorization: Bearer <token>`. Rotate by updating the env var on both
sides. Upgrade path: mTLS once we have more than one caller.

## Run locally

```bash
cd solver-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export RR_SOLVER_TOKEN=local-dev-token
uvicorn rr_solver.main:app --reload --port 8080
```

Smoke test:

```bash
curl -s http://localhost:8080/healthz
curl -s -X POST http://localhost:8080/solve \
  -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: application/json" \
  -d '{"schedule_week_start":"2026-06-01","max_days":4,"weekly_hour_cap":40,
       "rules":{}, "drivers":[], "shifts":[], "pto":[]}'
```

## Run the tests

```bash
pip install -r requirements-dev.txt
pytest
```

## Diagnostic Trace Mode

Smart Fill used to be a black box: when a driver got 0 shifts, a shift
stayed open, a cushion seat went unfilled, or OT showed up, there was no
way to see *why*. Trace Mode makes the solver self-explaining.

**Opt in** by setting `"trace": true` on the `/solve` request. The solver
then attaches a `trace` object to the response — a complete, structured
decision report **plus** a pre-rendered human-readable `report` string.
It is **pure observability**: enabling it never changes a single
scheduling decision (the trace is derived *after* the schedule is final).
It's opt-in because the trace can be large (every driver, every shift,
every evaluated pair), so normal runs stay lean.

```bash
curl -s -X POST http://localhost:8080/solve \
  -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: application/json" \
  -d '{"schedule_week_start":"2026-06-01","max_days":4,"weekly_hour_cap":40,
       "trace":true,"run_id":"run-123","dsp_id":"dsp-9",
       "rules":{}, "drivers":[...], "shifts":[...], "pto":[]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['trace']['report'])"
```

The trace answers six questions instantly:

1. **Why did this driver get 0 shifts?** → `driver_trace[].why`,
   `zero_shift_report[]`
2. **Why did this shift remain open?** → `shift_trace[].why`,
   `unfilled_shift_report[]`
3. **Was the driver excluded before the solver?** →
   `driver_trace[].considered_by_solver == false`
4. **Was the driver considered by the solver?** →
   `driver_trace[].considered_by_solver == true`
5. **Was the shift sent to the solver?** → `shift_trace[].sent_to_solver`
   (locked rows are honored verbatim, never sent)
6. **Did scoring or eligibility cause the result?** →
   `driver_trace[].cause` / `shift_trace[].cause`
   (`eligibility` | `scoring` | `capacity` | `solver_status`)

### Structured sections

| Key | Spec section | Contents |
|---|---|---|
| `run_summary` | 1 | run id, timestamp, DSP, date range, **settings used**, counts (drivers received/eligible/excluded, shifts assigned/unfilled, cushion seats filled/open) |
| `driver_trace` | 2 | per driver: pool entry, disposition, availability, certs, status, assigned shifts/hours/OT, and the exact 0-shift reason |
| `shift_trace` | 3 | per shift: date/type/route, regular-vs-cushion, required certs, eligible-driver count, assigned driver, and the exact unfilled reason |
| `eligibility_trace` | 4 | per (driver, shift) pair: PASS/FAIL with the **first-failure** reason code (`AVAILABILITY_FAIL`, `PTO_FAIL`, `LICENSE_FAIL`, `DOT_FAIL`, `XL_FAIL`, `EDV_FAIL`, …) |
| `solver_input` | 5 | the payload as the solver saw it — counts + per-driver/per-shift echo |
| `solver_output` | 6 | assignments returned, unfilled, warnings, solver diagnostics, and per-driver disposition buckets (assigned / considered-but-not-selected / never-considered) |
| `zero_shift_report` | 7 | one definitive sentence per 0-shift driver |
| `unfilled_shift_report` | 8 | one definitive sentence per open shift |
| `report` | — | the whole thing rendered as plain text |

### A note on reason codes

The per-pair **first-failure** codes in `eligibility_trace` come from
`eligibility.py`, which is the single source of truth the model's
`_is_eligible` also uses — so the trace can never drift from the rules the
solver actually applied. Capacity limits (max days, consecutive days,
weekly hours, min rest) are *global* CP-SAT constraints, not per-pair
gates, so they surface at the driver/shift layer (`cause: "capacity"`)
rather than as a per-pair code.

### From the dashboard

The dashboard's edge dispatcher forwards `trace` / `run_id` / `dsp_id` to
the solver. After a Smart Fill run, call `_rrSmartFillDiagnostics()` from
the browser console: it re-solves the cached payload read-only with
`trace: true` and downloads the `.txt` report + `.json` trace.

## Deploy to Fly.io

Recommended target — cheap, Docker-native, regions match Supabase.

```bash
# One-time setup
brew install flyctl   # or curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy   # accepts the included fly.toml

# Set the shared secret (the dashboard's edge function uses the same)
fly secrets set RR_SOLVER_TOKEN="$(openssl rand -hex 32)"

# Ship it
fly deploy
```

### Automated deploys (CI)

`.github/workflows/deploy-solver-service.yml` redeploys this service on
every push to `main` that touches `solver-service/**` (and via the manual
"Run workflow" button). It runs `flyctl deploy --remote-only` and requires
one GitHub **repo secret**:

- **`FLY_API_TOKEN`** — a Fly.io deploy token for this app
  (`fly tokens create deploy -a rr-solve-ready`, or the Fly dashboard →
  app → Tokens). Without it the job fails immediately with
  *"no access token available"* and the live service silently stays on
  its last manually-deployed build — so dashboard-side changes to the
  payload contract can drift ahead of the deployed solver. Confirm a
  green run after any solver change.

Recommended initial sizing:
- 2 vCPU / 2 GB RAM (`shared-cpu-2x` on Fly.io ≈ $10/mo)
- Single region matching your Supabase project's region
- Scale to 4 vCPU / 4 GB once a tenant exceeds ~500 drivers in a single solve

## Why a separate service

1. **OR-Tools CP-SAT is C++ with Python bindings.** Node bindings are
   fragile; the WASM build is missing SearchStrategy. Keeping it Python
   avoids fighting the tooling.
2. **CPU/memory profile is different from a web tier.** Solves can need
   a few hundred MB of working memory and several seconds of CPU.
   Co-tenanting with the dashboard would spike latency for unrelated
   requests.
3. **Independent deploy cadence.** Solver model changes ship without
   redeploying the dashboard, and vice versa.

## Project layout

```
solver-service/
├── rr_solver/
│   ├── __init__.py
│   ├── main.py           # FastAPI app + endpoints + auth
│   ├── models.py         # Pydantic request/response shapes (+ trace)
│   ├── cpsat_model.py    # real CP-SAT model (default engine)
│   ├── solver.py         # heuristic stub engine (RR_SOLVER_ENGINE=stub)
│   ├── eligibility.py    # single-source per-pair hard gate + reason codes
│   ├── trace.py          # Diagnostic Trace Mode (structured + report)
│   ├── ad_hoc.py         # operator ad-hoc constraint compiler
│   └── validators.py     # hard-rule pre-checks
├── tests/
│   ├── test_solve.py
│   ├── test_cpsat.py
│   ├── test_eligibility.py   # locks gate order + reason codes
│   ├── test_trace.py         # Trace Mode behavior + the six questions
│   └── …
├── Dockerfile
├── fly.toml
├── requirements.txt
├── requirements-dev.txt
└── README.md
```
