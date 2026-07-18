-- Migration 0516 · Notebook backlinks: a linking-context snippet ──────────────
--
-- #40 ("backlinks list shows a snippet of the sentence that links here").
-- notebook_page_backlinks (0451/0454) returned only the source page's title.
-- This adds a `snippet` built from the source page's plaintext mirror
-- (content_text): we locate the target page's title within it — a page link
-- renders the target's title as its text, so the title reliably lands inside
-- the linking sentence — and return a ~160-char window around it, falling back
-- to the start of the page when the title isn't found.
--
-- Idempotent (create or replace throughout). The frag degrades gracefully:
-- a missing snippet field just renders the old "Linked from" line.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function private.notebook_link_snippet(p_text text, p_needle text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_clean text; v_pos int := 0; v_start int; v_snip text;
begin
  v_clean := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  if v_clean = '' then return null; end if;
  if coalesce(p_needle, '') <> '' then v_pos := position(lower(p_needle) in lower(v_clean)); end if;
  if v_pos > 0 then
    v_start := greatest(1, v_pos - 60);
    v_snip := substring(v_clean from v_start for 160);
    if v_start > 1 then v_snip := '…' || v_snip; end if;
    if v_start + 160 <= length(v_clean) then v_snip := v_snip || '…'; end if;
  else
    v_snip := substring(v_clean from 1 for 140);
    if length(v_clean) > 140 then v_snip := v_snip || '…'; end if;
  end if;
  return v_snip;
end; $$;

create or replace function public.notebook_page_backlinks(p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb; v_title text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select title into v_title from public.notebook_pages where id = p_page_id and dsp_id = v_dsp;
  select coalesce(jsonb_agg(jsonb_build_object('page_id', src.id, 'title', src.title,
           'section_id', src.section_id, 'notebook_id', src.notebook_id,
           'snippet', private.notebook_link_snippet(src.content_text, v_title))
           order by src.updated_at desc), '[]'::jsonb)
    into v_out
    from public.notebook_links l
    join public.notebook_pages src on src.id = l.source_page_id and src.deleted_at is null
   where l.target_page_id = p_page_id and l.dsp_id = v_dsp
     and private.notebook_visible(src.notebook_id);
  return v_out;
end; $$;
grant execute on function public.notebook_page_backlinks(uuid) to authenticated;

notify pgrst, 'reload schema';
