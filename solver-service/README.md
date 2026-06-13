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
│   ├── models.py         # Pydantic request/response shapes
│   ├── solver.py         # CP-SAT model (stub now, real in v2)
│   └── validators.py     # hard-rule pre-checks
├── tests/
│   └── test_solve.py
├── Dockerfile
├── fly.toml
├── requirements.txt
├── requirements-dev.txt
└── README.md
```
