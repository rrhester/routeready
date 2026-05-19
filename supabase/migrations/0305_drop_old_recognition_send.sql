-- 0305_drop_old_recognition_send.sql
--
-- Migration 0290 created a 9-arg `recognition_send` overload
-- (without p_metadata). Migration 0295 added a 10-arg overload
-- (with p_metadata) but kept the original alongside it. PostgREST
-- refuses to pick between them when only the common args are
-- supplied — every client call has to pass p_metadata explicitly
-- or it fails with:
--
--   Could not choose the best candidate function between …
--
-- Drop the old 9-arg version. The 10-arg `recognition_send` accepts
-- all the same args (p_metadata defaults to '{}'), so this is a
-- pure cleanup with no behavior change.
--
-- Re-runnable: `drop function if exists`.

drop function if exists public.recognition_send(uuid, text, text, text, text, date, date, int, text);

notify pgrst, 'reload schema';
