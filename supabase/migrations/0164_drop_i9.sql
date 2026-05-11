-- Migration 0164 · drop the Form I-9 scaffolding from 0163
--
-- 0163 added an integrated I-9 workflow (i9_records, i9_events, RPCs).
-- That work has been pulled. If 0163 already ran against a database,
-- this removes everything it created; if it never ran (the file was
-- reverted before the migration deploy), every statement here is a
-- no-op thanks to `if exists`.

drop function if exists public.i9_reopen(uuid, text);
drop function if exists public.i9_complete_section2(uuid, jsonb, text[]);
drop function if exists public.i9_save_section1(uuid, jsonb, boolean);
drop function if exists public.i9_ensure(uuid);
drop function if exists private.i9_log(uuid, text, jsonb);

drop table if exists public.i9_events cascade;
drop table if exists public.i9_records cascade;

notify pgrst, 'reload schema';
