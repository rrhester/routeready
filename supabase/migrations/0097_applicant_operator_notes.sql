-- Per-applicant operator notes. Free-text scratchpad on each
-- applicant card so the DSP can jot follow-ups, call summaries,
-- gut-check observations, etc. Visible only to the operator's
-- own DSP via the existing applicants_tenant_rw RLS policy.

alter table public.applicants
  add column if not exists operator_notes text;

comment on column public.applicants.operator_notes is
  'Free-text scratchpad written by the DSP operator about this applicant. Not visible to applicants.';
