-- 0327_optimization_explanations.sql
--
-- Workforce Optimization Engine — Step 9: AI explainer cache.
--
-- Persists natural-language explanations the explain-optimization-run
-- edge function generates from optimization_runs + optimization_decisions
-- (the audit data captured in 0324 + step 2). Same (run_id, question)
-- never gets re-queried — saves Anthropic spend and gives the dashboard
-- instant replay of prior explanations.
--
-- Idempotent.

create table if not exists public.optimization_explanations (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.optimization_runs(id) on delete cascade,
  question        text not null,
  question_kind   text not null default 'free_text'
                    check (question_kind in
                      ('summary','shift_change','uncovered','driver_idle',
                       'overtime','risk','forecast','free_text')),
  answer          text not null,
  cited_decisions uuid[] not null default '{}',
  model           text,
  prompt_tokens   integer,
  output_tokens   integer,
  hash            text not null,                     -- (run_id, question_kind, question)
  generated_at    timestamptz not null default now(),
  unique (run_id, hash)
);
create index if not exists idx_optimization_explanations_run
  on public.optimization_explanations (run_id, generated_at desc);

alter table public.optimization_explanations enable row level security;

-- DSP-scoped reads via the run's dsp_id.
drop policy if exists optimization_explanations_dsp_read on public.optimization_explanations;
create policy optimization_explanations_dsp_read on public.optimization_explanations
  for select using (
    exists (
      select 1 from public.optimization_runs r
       where r.id = optimization_explanations.run_id
         and r.dsp_id = private.current_dsp_id()
    )
  );

-- The edge function uses the service role for writes; no INSERT/UPDATE
-- policy is required for the authenticated role.


-- ── RPC · cached_explanation_for_run ──────────────────────────────
-- Cheap read used by the dashboard before it calls the edge function.
-- If a matching cached explanation exists, return it; otherwise return
-- null and the dashboard calls the edge function.
create or replace function public.cached_optimization_explanation(
  p_run_id        uuid,
  p_question_kind text,
  p_question_hash text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(e)
    from public.optimization_explanations e
    join public.optimization_runs r on r.id = e.run_id
   where e.run_id = p_run_id
     and r.dsp_id = private.current_dsp_id()
     and e.hash = p_question_hash
   order by e.generated_at desc
   limit 1;
$$;
grant execute on function public.cached_optimization_explanation(uuid, text, text) to authenticated;


notify pgrst, 'reload schema';
