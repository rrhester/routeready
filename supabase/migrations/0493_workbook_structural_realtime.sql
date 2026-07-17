-- 0493_workbook_structural_realtime.sql
--
-- 100-list #72: structural edits (sheet add/rename/delete, column/row
-- resize, freeze, conditional formatting, charts, pivots, protected
-- ranges, and text/checklist block edits) all persist to
-- workbook_sheets / workbook_blocks, but those two tables were never in
-- the realtime publication — so other open clients only saw cell-value
-- changes stream in. Add them so the client's new sheet/block
-- subscriptions receive live structural updates.

do $$
declare t text;
        tables text[] := array[
          'workbook_sheets',
          'workbook_blocks'
        ];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
