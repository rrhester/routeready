-- Desktop app "Connect from browser" pairing.
--
-- Flow: the logged-in dashboard (browser) calls the desktop-pair edge
-- function (action=mint) → a short-lived, single-use code is stored here
-- keyed to the user. The dashboard opens routeready://connect?code=… ; the
-- installed desktop app redeems the code (action=redeem) for a Supabase
-- session, so its dashboard window is signed in as the same DSP — no
-- re-login, no emailed magic-link round-trip.
--
-- Only the edge function (service role) ever touches this table. RLS is on
-- with no policies, so anon/authenticated clients can't read or write it.

create table if not exists public.desktop_pairings (
  code        text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- Helps the function ignore/expire stale codes and lets a periodic cleanup
-- (if ever added) prune efficiently.
create index if not exists desktop_pairings_expires_at_idx
  on public.desktop_pairings (expires_at);

alter table public.desktop_pairings enable row level security;

-- No policies on purpose: deny all for anon + authenticated. The service
-- role used by the edge function bypasses RLS.
revoke all on public.desktop_pairings from anon, authenticated;
