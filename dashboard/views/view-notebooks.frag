<!-- ═══════════════════════════════════════════════════════════════════════
     NOTEBOOKS — the RouteReady notebook system (OneNote-class).

     A three-pane, keyboard-first hierarchical note store:
        Notebook ▸ Section Group ▸ Section ▸ Page ▸ Subpage
     with a professional rich-text editor, instant full-text search, tags,
     internal links + backlinks, a Recycle Bin, and per-object notebooks
     (open a Driver / Vehicle / Route and see its notebook).

     Data layer is offline-first: it drives Supabase RPCs (migration 0451)
     when the operator is signed in, and transparently falls back to a
     localStorage-backed store otherwise — so the view is always alive,
     even in the offline/visual-regression render where live.js never boots.

     All markup + styles + engine live in this fragment (self-contained,
     like the workbook). live.js calls window.RRNotebooks.loadView() on nav.
     ═══════════════════════════════════════════════════════════════════ -->
<style>
/* Scoped to #view-notebooks; colors/sizes reference design tokens so the
   design-ratchet never trips (this file is not even in its scan set, but we
   hold the same bar). Dynamic per-item colors are inline (data-driven). */
/* The view is a normal block child of .main, which lays out as a flex column
   with a 44px sticky .topbar (Window-Controls-Overlay title bar in the desktop
   app) as its first child. The notebook must fill the space BELOW that bar —
   using the full 100vh made it 44px too tall, which pushed its top row (the
   notebook picker + search) up under the title bar in the desktop app.
   Primary: flex-fill the remaining height when the app has stamped the active
   view on <body> (auto-adapts to the bar's height). Fallback: calc for any
   render that hasn't stamped it. Either way the three panes scroll internally. */
#view-notebooks{color:var(--text);font-size:var(--fs-base)}
/* The view sits at the top of the window with the app's 44px title bar
   (Window-Controls-Overlay) drawn over it, so its top row (notebook picker +
   search) was hidden underneath. Fill the window (100vh) but reserve 44px of
   top padding INSIDE the box so all content starts below the title bar. The
   shell is 100% of the content box, i.e. 100vh − 44px, and its panes scroll
   internally — no page overflow. */
#view-notebooks.active{display:block;height:100vh;box-sizing:border-box;padding-top:44px;
  overflow:hidden;background:var(--canvas)}
.rrnb-shell{height:100%;display:grid;
  grid-template-columns:248px 300px 1fr;min-height:0;min-width:0}
.rrnb-shell.ctx-on{grid-template-columns:248px 300px 1fr minmax(280px,320px)}
.rrnb-pane{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;
  border-right:1px solid var(--border);background:var(--surface)}
.rrnb-pane--canvas{border-right:0;background:var(--canvas)}

/* ── Pane 4: context rail (linked records · outline · backlinks · props) ── */
.rrnb-pane--ctx{border-right:0;border-left:1px solid var(--border);background:var(--surface);display:none}
.rrnb-shell.ctx-on .rrnb-pane--ctx{display:flex}
.rrnb-ctxhead{display:flex;align-items:center;gap:var(--s-2);height:46px;flex:0 0 auto;
  padding:0 var(--s-3);border-bottom:1px solid var(--border)}
.rrnb-ctxtitle{flex:1;font-size:var(--fs-sm);font-weight:600;letter-spacing:.02em;
  text-transform:uppercase;color:var(--text-subtle)}
.rrnb-ctxbody{flex:1;overflow:auto;min-height:0}
.rrnb-ctxsec{padding:var(--s-3);border-bottom:1px solid var(--border)}
.rrnb-ctxsec:empty{display:none}
.rrnb-ctxsec h4{margin:0 0 var(--s-2);font-size:var(--fs-xs);font-weight:700;letter-spacing:.05em;
  text-transform:uppercase;color:var(--text-subtle);display:flex;align-items:center;gap:6px}
.rrnb-ctxsec h4 .cnt{margin-left:auto;background:var(--surface-secondary,var(--surface-hover));
  border:1px solid var(--border);border-radius:var(--r-pill);padding:0 6px;font-size:10px;font-weight:700;color:var(--text-muted)}
.rrnb-crec{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-1);border-radius:var(--r-md);cursor:pointer}
.rrnb-crec:hover{background:var(--surface-hover)}
.rrnb-crec .av{width:26px;height:26px;border-radius:6px;flex:0 0 auto;display:flex;align-items:center;
  justify-content:center;color:#fff;font-size:11px;font-weight:700}
.rrnb-crec .av svg{width:15px;height:15px}
.rrnb-crec .cc{min-width:0;flex:1}
.rrnb-crec .rn{font-size:var(--fs-sm);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrnb-crec .rt{font-size:var(--fs-xs);color:var(--text-subtle);text-transform:capitalize}
.rrnb-crec .go{color:var(--text-subtle);flex:0 0 auto;opacity:0;display:flex}
.rrnb-crec .go svg{width:14px;height:14px}
.rrnb-crec:hover .go{opacity:1}
.rrnb-ctxlink{display:flex;align-items:center;gap:6px;font-size:var(--fs-sm);color:var(--accent);
  cursor:pointer;padding:var(--s-2) var(--s-1) var(--s-1)}
.rrnb-ctxlink svg{width:14px;height:14px}
.rrnb-ol{list-style:none;margin:0;padding:0}
.rrnb-ol li{font-size:var(--fs-sm);color:var(--text-muted);padding:3px 0 3px 10px;
  border-left:2px solid transparent;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrnb-ol li:hover{color:var(--text);border-left-color:var(--border-strong,var(--border))}
.rrnb-ol li.l3{padding-left:22px;font-size:var(--fs-xs);color:var(--text-subtle)}
.rrnb-prop{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:var(--fs-sm)}
.rrnb-prop .pl{color:var(--text-subtle)}
.rrnb-prop .pv{color:var(--text);font-weight:500;text-align:right;white-space:nowrap}
.rrnb-ctxempty{padding:var(--s-4);color:var(--text-subtle);font-size:var(--fs-sm);line-height:1.5}
.rrnb-metabtn.on{color:var(--accent);background:var(--accent-soft)}
/* comments */
.rrnb-cmt{display:flex;gap:var(--s-2);margin-bottom:var(--s-3)}
.rrnb-cmt.reply{margin-left:var(--s-5)}
.rrnb-cmt.resolved{opacity:.55}
.rrnb-cmt .av{width:24px;height:24px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;
  justify-content:center;color:#fff;font-size:10px;font-weight:700;background:var(--accent)}
.rrnb-cmt .cbd{flex:1;min-width:0}
.rrnb-cmt .chd{display:flex;align-items:center;gap:6px;font-size:var(--fs-sm);font-weight:600}
.rrnb-cmt .chd .tm{font-weight:400;color:var(--text-disabled);font-size:var(--fs-xs)}
.rrnb-cmt .chd .act{margin-left:auto;display:flex;gap:2px;opacity:0}
.rrnb-cmt:hover .chd .act{opacity:1}
.rrnb-cmt .cta{width:22px;height:22px;border-radius:var(--r-sm);display:grid;place-items:center;color:var(--text-subtle);cursor:pointer;border:0;background:transparent}
.rrnb-cmt .cta:hover{background:var(--surface-hover);color:var(--text)}
.rrnb-cmt .cta svg{width:14px;height:14px}
.rrnb-cmt .cta.on{color:var(--green)}
.rrnb-cmt .ctx-body-txt{font-size:var(--fs-sm);color:var(--text-muted);line-height:1.45;margin-top:2px;white-space:pre-wrap;word-wrap:break-word}
.rrnb-cmt .ctx-body-txt .mn{color:var(--accent);font-weight:600}
.rrnb-cmt .rply{font-size:var(--fs-xs);color:var(--accent);cursor:pointer;margin-top:3px;display:inline-block}
.rrnb-cmt .rslv-badge{font-size:var(--fs-xs);color:var(--green);font-weight:600}
.rrnb-cmt-replychip{display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);color:var(--text-subtle);
  background:var(--surface-secondary,var(--surface-hover));border-radius:var(--r-md);padding:4px 8px;margin-bottom:6px}
.rrnb-cmt-replychip button{margin-left:auto;border:0;background:transparent;color:var(--text-subtle);cursor:pointer;font-size:13px}
.rrnb-cmt-composer{position:relative;margin-top:var(--s-2)}
.rrnb-cmt-input{width:100%;min-height:34px;max-height:120px;resize:none;border:1px solid var(--border-strong);
  border-radius:var(--r-md);padding:8px 10px;font:inherit;font-size:var(--fs-sm);color:var(--text);
  background:var(--surface);box-shadow:var(--inset-input,inset 0 1px 2px rgba(15,23,42,.05))}
.rrnb-cmt-input:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring-focus,0 0 0 3px rgba(37,99,235,.18))}
.rrnb-cmt-input::placeholder{color:var(--text-subtle)}
.rrnb-cmt-row{display:flex;align-items:center;gap:8px;margin-top:6px}
.rrnb-cmt-row .hint{font-size:var(--fs-xs);color:var(--text-disabled)}
.rrnb-cmt-send{margin-left:auto;height:28px;padding:0 12px;border-radius:var(--r-md);border:1px solid var(--accent);
  background:var(--accent);color:#fff;font-size:var(--fs-xs);font-weight:600;cursor:pointer}
.rrnb-cmt-send:disabled{opacity:.5;cursor:default}
.rrnb-mnmenu{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:20;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-pop);padding:4px;max-height:180px;overflow:auto}
.rrnb-mnmenu .mnrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--r-sm);cursor:pointer;font-size:var(--fs-sm)}
.rrnb-mnmenu .mnrow:hover,.rrnb-mnmenu .mnrow.on{background:var(--accent-soft)}
.rrnb-mnmenu .mnav{width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:9px;font-weight:700}
@media (max-width:1280px){
  .rrnb-shell.ctx-on{grid-template-columns:248px 300px 1fr}
  .rrnb-pane--ctx{position:absolute;top:0;bottom:0;right:0;z-index:60;width:min(340px,88vw);
    transform:translateX(105%);transition:transform .18s ease;box-shadow:var(--shadow-pop);display:flex}
  .rrnb-shell.ctx-on .rrnb-pane--ctx{transform:translateX(0)}
  @media (prefers-reduced-motion:reduce){.rrnb-pane--ctx{transition:none}}
}

/* ── column headers ──────────────────────────────────────────────── */
.rrnb-colhd{display:flex;align-items:center;gap:var(--s-2);height:46px;flex:0 0 auto;
  padding:0 var(--s-3);border-bottom:1px solid var(--border);background:var(--surface)}
.rrnb-colhd h3{margin:0;font-size:var(--fs-sm);font-weight:600;letter-spacing:.02em;
  text-transform:uppercase;color:var(--text-subtle);flex:1;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.rrnb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:0;border-radius:var(--r-md);background:transparent;color:var(--text-subtle);cursor:pointer;
  flex:0 0 auto}
.rrnb-iconbtn:hover{background:var(--surface-hover);color:var(--text)}
.rrnb-iconbtn svg{width:16px;height:16px}

/* ── notebook picker ─────────────────────────────────────────────── */
.rrnb-nbpicker{position:relative;flex:0 0 auto;padding:var(--s-2);border-bottom:1px solid var(--border)}
.rrnb-nbcurrent{display:flex;align-items:center;gap:var(--s-2);width:100%;padding:var(--s-2) var(--s-2-5);
  border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);cursor:pointer;
  text-align:left;font-size:var(--fs-base);color:var(--text)}
.rrnb-nbcurrent:hover{background:var(--surface-hover)}
.rrnb-nbcurrent .rrnb-swatch{flex:0 0 auto}
.rrnb-nbcurrent .nm{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrnb-nbcurrent .nm.is-editing{overflow:visible;text-overflow:clip;cursor:text;padding:0 3px;margin:0 -3px;
  border-radius:4px;outline:2px solid var(--accent);outline-offset:1px;background:var(--surface)}
.rrnb-nbcurrent .chev{flex:0 0 auto;color:var(--text-subtle)}
.rrnb-swatch{width:12px;height:12px;border-radius:3px;background:var(--accent)}
.rrnb-menu{position:absolute;z-index:40;left:var(--s-2);right:var(--s-2);top:calc(100% - var(--s-1));
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  box-shadow:var(--shadow-pop);padding:var(--s-1);max-height:60vh;overflow:auto}
.rrnb-menu[hidden]{display:none}
.rrnb-menu-item{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2) var(--s-2-5);
  border-radius:var(--r-md);cursor:pointer;font-size:var(--fs-base);color:var(--text)}
.rrnb-menu-item:hover,.rrnb-menu-item.sel{background:var(--accent-soft)}
.rrnb-menu-item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrnb-menu-item .ct{color:var(--text-subtle);font-size:var(--fs-xs)}
.rrnb-menu-item .kebab{opacity:0;flex:0 0 auto}
.rrnb-menu-item:hover .kebab{opacity:1}
.rrnb-menu-sep{height:1px;background:var(--border);margin:var(--s-1) 0}
.rrnb-menu-add{color:var(--accent);font-weight:600}
/* inline title editing — double-click a section / page / group title */
.rrnb-inline-edit{outline:2px solid var(--accent);outline-offset:1px;border-radius:4px;background:var(--surface);
  cursor:text;white-space:normal;overflow:visible;text-overflow:clip;padding:0 3px;margin:0 -3px;box-shadow:var(--shadow-pop)}

/* ── section list ────────────────────────────────────────────────── */
.rrnb-sections{flex:1;min-height:0;overflow:auto;padding:var(--s-2)}
.rrnb-group{margin-bottom:var(--s-1)}
.rrnb-group-hd{display:flex;align-items:center;gap:var(--s-1);padding:var(--s-1) var(--s-2);
  font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  color:var(--text-subtle);cursor:pointer}
.rrnb-group-hd .tw{transition:transform .12s}
.rrnb-group.collapsed .tw{transform:rotate(-90deg)}
.rrnb-group.collapsed .rrnb-section{display:none}
.rrnb-section{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2) var(--s-2-5);
  border-radius:var(--r-md);cursor:pointer;position:relative;color:var(--text)}
.rrnb-section:hover{background:var(--surface-hover)}
.rrnb-section.active{background:var(--accent-soft);font-weight:600}
.rrnb-section .bar{position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--accent)}
.rrnb-section .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  padding-left:var(--s-1)}
.rrnb-section .kebab{opacity:0;flex:0 0 auto}
.rrnb-section:hover .kebab,.rrnb-section.active .kebab{opacity:1}
.rrnb-railfoot{flex:0 0 auto;border-top:1px solid var(--border);padding:var(--s-2)}
.rrnb-railfoot .rrnb-linkbtn{display:flex;align-items:center;gap:var(--s-2);width:100%;
  padding:var(--s-2) var(--s-2-5);border:0;background:transparent;border-radius:var(--r-md);
  color:var(--text-subtle);cursor:pointer;font-size:var(--fs-base)}
.rrnb-railfoot .rrnb-linkbtn:hover{background:var(--surface-hover);color:var(--text)}
.rrnb-railfoot .rrnb-linkbtn svg{width:16px;height:16px;flex:0 0 auto}
#view-notebooks .rrnb-shell svg{max-width:100%}

/* ── page list ───────────────────────────────────────────────────── */
.rrnb-search{flex:0 0 auto;padding:var(--s-2);border-bottom:1px solid var(--border)}
.rrnb-search input{width:100%;height:34px;padding:0 var(--s-2-5);border:1px solid var(--border);
  border-radius:var(--r-lg);background:var(--surface);color:var(--text);font-size:var(--fs-base);outline:none}
.rrnb-search input:focus{border-color:var(--accent);box-shadow:var(--accent-glow)}
.rrnb-pagelist{flex:1;min-height:0;overflow:auto;padding:var(--s-1) var(--s-2) var(--s-4)}
.rrnb-plgroup-hd{padding:var(--s-2) var(--s-2) var(--s-1);font-size:var(--fs-xs);font-weight:700;
  text-transform:uppercase;letter-spacing:.04em;color:var(--text-subtle)}
.rrnb-page{display:flex;align-items:flex-start;gap:var(--s-2);padding:var(--s-2) var(--s-2-5);
  border-radius:var(--r-md);cursor:pointer;position:relative}
.rrnb-page:hover{background:var(--surface-hover)}
.rrnb-page.active{background:var(--accent-soft)}
.rrnb-page.active::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;
  border-radius:2px;background:var(--accent)}
.rrnb-page.lvl1{margin-left:var(--s-4)}
.rrnb-page.lvl2{margin-left:var(--s-8)}
.rrnb-page .body{flex:1;min-width:0}
.rrnb-page .ttl{font-size:var(--fs-base);color:var(--text);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.rrnb-page.active .ttl{font-weight:600}
.rrnb-page .sub{font-size:var(--fs-xs);color:var(--text-subtle);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;margin-top:1px}
.rrnb-page .sub mark{background:var(--accent-soft-strong,rgba(37,99,235,.16));color:var(--accent-text);
  border-radius:2px;padding:0 1px}
.rrnb-page .pin{flex:0 0 auto;color:var(--amber);opacity:0}
.rrnb-page.pinned .pin{opacity:1}
.rrnb-page .kebab{opacity:0;flex:0 0 auto}
.rrnb-page:hover .kebab{opacity:1}
.rrnb-newpage{display:flex;align-items:center;gap:var(--s-2);width:100%;margin-top:var(--s-1);
  padding:var(--s-2) var(--s-2-5);border:1px dashed var(--border-strong);border-radius:var(--r-md);
  background:transparent;color:var(--text-subtle);cursor:pointer;font-size:var(--fs-base)}
.rrnb-newpage:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.rrnb-empty{padding:var(--s-8) var(--s-4);text-align:center;color:var(--text-subtle);font-size:var(--fs-sm)}

/* ── canvas / editor ─────────────────────────────────────────────── */
.rrnb-canvas-wrap{flex:1;min-height:0;overflow:auto;display:flex;justify-content:center}
.rrnb-doc{width:100%;max-width:820px;padding:var(--s-6) var(--s-8) 40vh}
.rrnb-breadcrumb{display:flex;align-items:center;gap:var(--s-1);font-size:var(--fs-sm);
  color:var(--text-subtle);margin-bottom:var(--s-3);flex-wrap:wrap}
.rrnb-breadcrumb .sep{opacity:.5}
.rrnb-title{width:100%;border:0;outline:0;background:transparent;color:var(--text);
  font-size:var(--fs-xxl);font-weight:700;line-height:1.2;padding:0 0 var(--s-2);
  font-family:inherit;resize:none;overflow:hidden}
.rrnb-title::placeholder{color:var(--text-disabled)}
.rrnb-metaline{display:flex;align-items:center;gap:var(--s-3);font-size:var(--fs-xs);
  color:var(--text-subtle);border-bottom:1px solid var(--border);padding-bottom:var(--s-3);
  margin-bottom:var(--s-3)}
.rrnb-save{display:inline-flex;align-items:center;gap:6px}
.rrnb-save .dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
.rrnb-save.saving .dot{background:var(--amber)}
.rrnb-save.err .dot{background:var(--red)}

/* toolbar */
.rrnb-toolbar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:2px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:4px;margin-bottom:var(--s-3);box-shadow:var(--shadow-xs)}
.rrnb-tb{display:inline-flex;align-items:center;justify-content:center;height:30px;min-width:30px;
  padding:0 6px;border:0;border-radius:var(--r-md);background:transparent;color:var(--text-muted);
  cursor:pointer;font-size:var(--fs-sm);font-weight:600}
.rrnb-tb:hover{background:var(--surface-hover);color:var(--text)}
.rrnb-tb.on{background:var(--accent-soft);color:var(--accent-text)}
.rrnb-tb svg{width:16px;height:16px}
.rrnb-tb-sep{width:1px;align-self:stretch;background:var(--border);margin:4px 3px}
.rrnb-tb-sel{height:30px;border:0;border-radius:var(--r-md);background:transparent;color:var(--text-muted);
  font-size:var(--fs-sm);font-weight:600;cursor:pointer;padding:0 var(--s-1)}
.rrnb-tb-sel:hover{background:var(--surface-hover)}

/* editor body */
.rrnb-editor{outline:0;min-height:52vh;font-size:var(--fs-lg);line-height:1.6;color:var(--text)}
.rrnb-editor:empty::before{content:attr(data-ph);color:var(--text-disabled)}
.rrnb-editor h1{font-size:var(--fs-xl);font-weight:700;margin:var(--s-4) 0 var(--s-2)}
.rrnb-editor h2{font-size:var(--fs-lg);font-weight:700;margin:var(--s-3) 0 var(--s-2)}
.rrnb-editor h3{font-size:var(--fs-base);font-weight:700;text-transform:uppercase;letter-spacing:.03em;
  color:var(--text-muted);margin:var(--s-3) 0 var(--s-1)}
.rrnb-editor p{margin:0 0 var(--s-2)}
.rrnb-editor ul,.rrnb-editor ol{margin:0 0 var(--s-2);padding-left:var(--s-6)}
.rrnb-editor li{margin:2px 0}
.rrnb-editor a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-border)}
.rrnb-editor a:hover{border-bottom-color:var(--accent)}
.rrnb-editor a.rrnb-pagelink,.rrnb-editor a.rrnb-objlink{background:var(--accent-soft);
  border-radius:var(--r-sm);padding:0 4px;border-bottom:0;font-weight:500}
/* web links (auto-detected URLs + Ctrl/⌘-K links): read as clickable */
.rrnb-editor a.rrnb-weblink{cursor:pointer;border-bottom:1px solid var(--accent-border)}
.rrnb-editor a.rrnb-weblink:hover{border-bottom-color:var(--accent);text-decoration:underline;text-underline-offset:2px}
/* ── TipTap (opt-in) editor surface ─────────────────────────────────── */
.rrnb-editor.rrnb-tt{padding:0}
.rrnb-tt .ProseMirror{outline:none;min-height:44vh;font-size:var(--fs-lg);line-height:1.6;color:var(--text)}
.rrnb-tt .ProseMirror:focus{outline:none}
.rrnb-tt-loading{color:var(--text-subtle);font-size:var(--fs-sm);padding:var(--s-2) 0}
.rrnb-tt .ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);
  color:var(--text-disabled);float:left;height:0;pointer-events:none}
.rrnb-tt ul[data-type="taskList"]{list-style:none;padding-left:0;margin:var(--s-2) 0}
.rrnb-tt ul[data-type="taskList"] li{display:flex;align-items:flex-start;gap:var(--s-2);margin:3px 0}
.rrnb-tt ul[data-type="taskList"] li>label{margin-top:2px}
.rrnb-tt ul[data-type="taskList"] li>div{flex:1;min-width:0}
.rrnb-tt ul[data-type="taskList"] input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent)}
.rrnb-tt table{border-collapse:collapse;width:100%;margin:var(--s-2) 0;table-layout:fixed}
.rrnb-tt td,.rrnb-tt th{border:1px solid var(--border);padding:6px 8px;min-width:40px;vertical-align:top}
.rrnb-tt th{background:var(--canvas);font-weight:600;text-align:left}
.rrnb-tt .selectedCell{background:var(--accent-soft)}
.rrnb-tt img{max-width:100%;border-radius:var(--r-md)}
.rrnb-beta{background:var(--accent-soft)!important;color:var(--accent-text)!important;
  border:1px solid var(--accent-border)!important}
/* an auto-detected reference not yet tied to a real record: muted, dashed —
   reads as "suggested link", click to resolve. Never navigates to a fake id. */
.rrnb-editor a.rrnb-objlink.rrnb-objlink-unresolved{background:transparent;color:var(--text-muted);
  border-bottom:1px dashed var(--border-strong,var(--text-disabled));border-radius:0;padding:0}
.rrnb-editor a.rrnb-objlink.rrnb-objlink-unresolved:hover{color:var(--accent);border-bottom-color:var(--accent)}
/* object-link resolver popover */
.rrnb-pop.rrnb-objresolve{width:280px;padding:var(--s-2)}
.rrnb-objresolve .rrnb-oh{font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);padding:var(--s-1) var(--s-1) var(--s-2)}
.rrnb-objresolve .rrnb-orow{display:flex;align-items:center;gap:var(--s-2);width:100%;text-align:left;
  padding:var(--s-2);border:0;background:transparent;border-radius:var(--r-md);cursor:pointer;margin:0}
.rrnb-objresolve .rrnb-orow:hover{background:var(--accent-soft)}
.rrnb-objresolve .rrnb-oic{width:26px;height:26px;border-radius:6px;flex:0 0 auto;display:flex;align-items:center;
  justify-content:center;color:#fff;font-size:11px;font-weight:700}
.rrnb-objresolve .rrnb-oic.mut{background:var(--surface-secondary,var(--surface-hover));color:var(--text-subtle)}
.rrnb-objresolve .rrnb-otx{display:flex;flex-direction:column;min-width:0;font-size:var(--fs-sm);color:var(--text)}
.rrnb-objresolve .rrnb-otx .mut{font-size:var(--fs-xs);color:var(--text-subtle);text-transform:capitalize}
.rrnb-objresolve .rrnb-oempty{font-size:var(--fs-sm);color:var(--text-subtle);padding:var(--s-2)}
.rrnb-objresolve .rrnb-osep{height:1px;background:var(--border);margin:var(--s-1) 0}
.rrnb-editor blockquote{margin:var(--s-2) 0;padding:var(--s-1) var(--s-4);border-left:3px solid var(--accent);
  color:var(--text-muted);background:var(--accent-soft);border-radius:0 var(--r-md) var(--r-md) 0}
.rrnb-editor pre{background:var(--surface-secondary);border:1px solid var(--border);border-radius:var(--r-md);
  padding:var(--s-3);overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:var(--fs-md);line-height:1.5;margin:var(--s-2) 0}
.rrnb-editor code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;
  background:var(--surface-secondary);border-radius:var(--r-sm);padding:1px 4px}
.rrnb-editor pre code{background:transparent;padding:0}
.rrnb-editor hr{border:0;border-top:1px solid var(--border-strong);margin:var(--s-4) 0}
.rrnb-editor table{border-collapse:collapse;margin:var(--s-2) 0;min-width:40%}
.rrnb-editor td,.rrnb-editor th{border:1px solid var(--border-strong);padding:var(--s-1) var(--s-2);
  min-width:60px;vertical-align:top}
.rrnb-editor th{background:var(--surface-secondary);font-weight:600;text-align:left}
.rrnb-editor mark{background:var(--amber-soft,rgba(217,119,6,.18));border-radius:2px;padding:0 1px}
.rrnb-editor img{max-width:100%;border-radius:var(--r-md);margin:var(--s-1) 0}
/* figures (pasted / dropped images) */
.rrnb-editor figure.rrnb-fig{margin:var(--s-3) 0;max-width:100%}
.rrnb-editor figure.rrnb-fig img{display:block;margin:0;cursor:default}
.rrnb-editor figure.rrnb-fig.sel img,.rrnb-editor img.sel{outline:2px solid var(--accent);outline-offset:2px}
.rrnb-editor figure.rrnb-fig figcaption{font-size:var(--fs-sm);color:var(--text-subtle);margin-top:6px;
  padding:2px 2px;outline:0;border-radius:var(--r-sm)}
.rrnb-editor figure.rrnb-fig figcaption:empty::before{content:"Add a caption…";color:var(--text-disabled)}
.rrnb-editor figure.rrnb-fig figcaption:focus{background:var(--surface-secondary)}
/* file attachment chip */
.rrnb-editor .rrnb-file{display:flex;align-items:center;gap:var(--s-2);margin:var(--s-2) 0;padding:var(--s-2) var(--s-3);
  border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);max-width:420px;text-decoration:none;color:var(--text)}
.rrnb-editor .rrnb-file:hover{border-color:var(--accent);background:var(--accent-soft)}
.rrnb-editor .rrnb-file .fic{width:34px;height:34px;border-radius:var(--r-sm);background:var(--surface-secondary);
  display:grid;place-items:center;flex:0 0 auto;font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase}
.rrnb-editor .rrnb-file .fnm{flex:1;min-width:0}
.rrnb-editor .rrnb-file .fnm b{display:block;color:var(--text);font-size:var(--fs-base);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrnb-editor .rrnb-file .fnm span{font-size:var(--fs-xs);color:var(--text-subtle)}
.rrnb-editor.rrnb-drop{outline:2px dashed var(--accent);outline-offset:-6px;background:var(--accent-soft)}
/* image size popover buttons */
.rrnb-pop .rrnb-sizes{display:flex;gap:4px;margin-top:var(--s-1)}
.rrnb-pop .rrnb-sizes button{flex:1;height:30px;border:1px solid var(--border);border-radius:var(--r-md);
  background:var(--surface);color:var(--text-muted);cursor:pointer;font-size:var(--fs-sm);font-weight:600}
.rrnb-pop .rrnb-sizes button:hover{border-color:var(--accent);color:var(--accent)}
/* drag-to-resize overlay for pictures — grips on corners/edges of the selected image.
   Lives on <body> (never inside the contenteditable) so it can't leak into saved HTML. */
#rrnb-imgrz{position:fixed;z-index:75;pointer-events:none}
#rrnb-imgrz b{position:absolute;display:block;pointer-events:auto;touch-action:none}
#rrnb-imgrz b::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:11px;height:11px;background:var(--surface);border:2px solid var(--accent);border-radius:50%;
  box-shadow:0 1px 3px rgba(0,0,0,.25)}
#rrnb-imgrz [data-rz=nw]{left:-7px;top:-7px;width:14px;height:14px;cursor:nwse-resize}
#rrnb-imgrz [data-rz=ne]{right:-7px;top:-7px;width:14px;height:14px;cursor:nesw-resize}
#rrnb-imgrz [data-rz=sw]{left:-7px;bottom:-7px;width:14px;height:14px;cursor:nesw-resize}
#rrnb-imgrz [data-rz=se]{right:-7px;bottom:-7px;width:14px;height:14px;cursor:nwse-resize}
/* edge strips: the whole border is grabbable, only the midpoint shows a grip */
#rrnb-imgrz [data-rz=n]{left:10px;right:10px;top:-5px;height:10px;cursor:ns-resize}
#rrnb-imgrz [data-rz=s]{left:10px;right:10px;bottom:-5px;height:10px;cursor:ns-resize}
#rrnb-imgrz [data-rz=e]{top:10px;bottom:10px;right:-5px;width:10px;cursor:ew-resize}
#rrnb-imgrz [data-rz=w]{top:10px;bottom:10px;left:-5px;width:10px;cursor:ew-resize}
#rrnb-imgrz [data-rz=n]::after,#rrnb-imgrz [data-rz=s]::after,
#rrnb-imgrz [data-rz=e]::after,#rrnb-imgrz [data-rz=w]::after{width:9px;height:9px}
html.rrnb-rz-drag,html.rrnb-rz-drag *{user-select:none!important}
/* page-add row + template button */
.rrnb-pageadd{display:flex;gap:6px;margin-top:var(--s-1)}
.rrnb-pageadd .rrnb-newpage{margin-top:0}
.rrnb-tpl-btn{flex:0 0 auto;width:40px;justify-content:center;font-size:var(--fs-lg)}
/* to-do widget */
.rrnb-todo{display:flex;align-items:flex-start;gap:var(--s-2);margin:2px 0}
.rrnb-todo-box{flex:0 0 auto;width:18px;height:18px;margin-top:3px;border:1.6px solid var(--border-strong);
  border-radius:var(--r-sm);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  background:var(--surface);color:transparent;user-select:none}
.rrnb-todo[data-checked="1"] .rrnb-todo-box{background:var(--accent);border-color:var(--accent);color:var(--surface)}
.rrnb-todo[data-checked="1"] .rrnb-todo-text{color:var(--text-disabled);text-decoration:line-through}
.rrnb-todo-text{flex:1;min-width:0}

/* callout */
.rrnb-editor .rrnb-callout{display:flex;gap:var(--s-2);margin:var(--s-2) 0;padding:var(--s-2) var(--s-3);
  border-radius:var(--r-md);background:var(--accent-soft);border:1px solid var(--accent-border)}
.rrnb-editor .rrnb-callout .ico{flex:0 0 auto}

/* tags + backlinks footer */
.rrnb-tagbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:var(--s-4);
  padding-top:var(--s-3);border-top:1px solid var(--border)}
.rrnb-tag{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 var(--s-2);border-radius:var(--r-pill);
  background:var(--surface-secondary);color:var(--text-muted);font-size:var(--fs-xs);font-weight:600}
.rrnb-tag button{border:0;background:transparent;color:var(--text-subtle);cursor:pointer;padding:0;
  line-height:1;font-size:var(--fs-sm)}
.rrnb-tag.done{background:var(--green-soft,rgba(22,163,74,.12));color:var(--green)}
.rrnb-tag.important{background:var(--amber-soft,rgba(217,119,6,.14));color:var(--amber)}
.rrnb-addtag{height:24px;border:1px dashed var(--border-strong);border-radius:var(--r-pill);
  background:transparent;color:var(--text-subtle);font-size:var(--fs-xs);padding:0 var(--s-2);cursor:pointer}
.rrnb-addtag:hover{color:var(--accent);border-color:var(--accent)}
.rrnb-backlinks{margin-top:var(--s-4)}
.rrnb-backlinks h4{margin:0 0 var(--s-2);font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;
  letter-spacing:.04em;color:var(--text-subtle)}
.rrnb-backlink{display:block;padding:var(--s-1) var(--s-2);border-radius:var(--r-md);color:var(--accent);
  cursor:pointer;font-size:var(--fs-sm);text-decoration:none}
.rrnb-backlink:hover{background:var(--accent-soft)}

/* placeholder / empty canvas */
.rrnb-blank{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;
  color:var(--text-subtle);gap:var(--s-2);text-align:center;padding:var(--s-8)}
.rrnb-blank svg{width:40px;height:40px;opacity:.4}

/* popover (link / table / mention pickers) */
.rrnb-pop{position:fixed;z-index:80;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-lg);box-shadow:var(--shadow-pop);padding:var(--s-2);min-width:260px}
.rrnb-pop[hidden]{display:none}
.rrnb-pop label{display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);
  margin:var(--s-1) 0 3px}
.rrnb-pop input,.rrnb-pop select{width:100%;height:32px;padding:0 var(--s-2);border:1px solid var(--border);
  border-radius:var(--r-md);background:var(--surface);color:var(--text);font-size:var(--fs-base);outline:none}
.rrnb-pop input:focus{border-color:var(--accent)}
.rrnb-pop-row{display:flex;gap:var(--s-2);align-items:flex-end;margin-top:var(--s-2)}
.rrnb-pop-btn{height:32px;padding:0 var(--s-3);border:0;border-radius:var(--r-md);background:var(--rr-amber-primary);
  color:var(--rr-white);font-weight:600;cursor:pointer;font-size:var(--fs-sm)}
.rrnb-pop-btn.ghost{background:transparent;color:var(--text-muted);border:1px solid var(--border)}
.rrnb-pop-list{max-height:240px;overflow:auto;margin-top:var(--s-2)}
.rrnb-pop-opt{padding:var(--s-2);border-radius:var(--r-md);cursor:pointer;font-size:var(--fs-base)}
.rrnb-pop-opt:hover,.rrnb-pop-opt.sel{background:var(--accent-soft)}
.rrnb-pop-opt .mut{font-size:var(--fs-xs);color:var(--text-subtle)}
/* slash "/" command menu (classic editor) — floating block inserter */
.rrnb-slash{position:fixed;z-index:90;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-lg);box-shadow:var(--shadow-pop);padding:5px;min-width:236px;max-height:326px;
  overflow:auto;font-size:var(--fs-base)}
.rrnb-slash[hidden]{display:none}
.rrnb-slash-opt{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:var(--r-md);
  cursor:pointer;color:var(--text);white-space:nowrap}
.rrnb-slash-opt.sel,.rrnb-slash-opt:hover{background:var(--accent-soft)}
.rrnb-slash-opt.mut{color:var(--text-subtle);cursor:default}
.rrnb-slash-opt.mut:hover{background:transparent}
.rrnb-slash-opt .ic{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
  border-radius:var(--r-sm);background:var(--canvas,rgba(15,23,42,.05));font-size:11px;font-weight:700;
  color:var(--text-muted);flex:0 0 auto}
/* drag-to-reorder: left-margin grip + live drop line (classic editor) */
.rrnb-draghandle{position:fixed;z-index:70;width:18px;height:22px;display:flex;align-items:center;
  justify-content:center;color:var(--text-disabled);cursor:grab;border-radius:var(--r-sm);background:transparent}
.rrnb-draghandle:hover{background:var(--accent-soft);color:var(--text-muted)}
.rrnb-draghandle.grabbing{cursor:grabbing}
.rrnb-draghandle[hidden]{display:none}
.rrnb-dropline{position:fixed;z-index:71;height:2px;background:var(--accent);border-radius:2px;pointer-events:none}
.rrnb-dropline[hidden]{display:none}
/* block action menu (opened by clicking the grip) */
.rrnb-blockmenu{min-width:196px}
.rrnb-bm-head{padding:5px 9px 3px;font-size:var(--fs-xs);font-weight:700;letter-spacing:.05em;
  text-transform:uppercase;color:var(--text-subtle)}
.rrnb-bm-sep{height:1px;background:var(--border);margin:5px 6px}
.rrnb-slash-opt.danger{color:var(--red,#dc2626)}
.rrnb-slash-opt.danger:hover{background:var(--red-soft,rgba(220,38,38,.08))}
.rrnb-slash-opt.danger .ic{color:inherit;background:transparent}
/* code-block copy chip (hover overlay) */
.rrnb-codecopy{position:fixed;z-index:72;height:24px;padding:0 10px;border:1px solid var(--border);
  border-radius:var(--r-md);background:var(--surface);color:var(--text-muted);font-size:var(--fs-xs);
  font-weight:600;cursor:pointer;box-shadow:var(--shadow-sm,0 1px 2px rgba(15,23,42,.06))}
.rrnb-codecopy:hover{color:var(--text);border-color:var(--border-strong,var(--text-disabled))}
.rrnb-codecopy.done{color:var(--green);border-color:var(--green)}
.rrnb-codecopy[hidden]{display:none}

/* context menu */
.rrnb-ctx{position:fixed;z-index:90;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-lg);box-shadow:var(--shadow-pop);padding:var(--s-1);min-width:180px}
.rrnb-ctx[hidden]{display:none}
.rrnb-ctx-item{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2) var(--s-2-5);
  border-radius:var(--r-md);cursor:pointer;font-size:var(--fs-base);color:var(--text)}
.rrnb-ctx-item:hover{background:var(--surface-hover)}
.rrnb-ctx-item.danger{color:var(--red)}
.rrnb-ctx-item.danger:hover{background:var(--red-soft,rgba(220,38,38,.08))}

/* offline banner */
.rrnb-offline{flex:0 0 auto;display:flex;align-items:center;gap:var(--s-2);padding:6px var(--s-3);
  background:var(--amber-soft,rgba(217,119,6,.12));color:var(--amber);font-size:var(--fs-xs);font-weight:600}
.rrnb-offline[hidden]{display:none}

/* drag-to-reorder pages */
.rrnb-page.rrnb-dragging{opacity:.45}
.rrnb-page.rrnb-dragover{box-shadow:inset 0 2px 0 var(--accent)}
/* AI toolbar button + menu */
.rrnb-tb-ai{color:var(--accent)}
.rrnb-tb-ai:hover{background:var(--accent-soft)}
.rrnb-aimenu{position:fixed;z-index:85;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-lg);box-shadow:var(--shadow-pop);padding:var(--s-1);min-width:230px}
.rrnb-aimenu[hidden]{display:none}
.rrnb-aimenu .hd{font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  color:var(--text-subtle);padding:var(--s-2) var(--s-2-5) 4px}
.rrnb-aimenu .it{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2) var(--s-2-5);
  border-radius:var(--r-md);cursor:pointer;font-size:var(--fs-base);color:var(--text)}
.rrnb-aimenu .it:hover{background:var(--accent-soft)}
.rrnb-aimenu .it .k{margin-left:auto;font-size:var(--fs-xs);color:var(--text-disabled)}
/* AI result panel */
.rrnb-aipanel{margin:var(--s-3) 0;border:1px solid var(--accent-border,rgba(37,99,235,.22));
  border-radius:var(--r-lg);background:var(--accent-soft);overflow:hidden}
.rrnb-aipanel .ph{display:flex;align-items:center;gap:8px;padding:var(--s-2) var(--s-3);
  border-bottom:1px solid var(--accent-border,rgba(37,99,235,.22));font-size:var(--fs-sm);font-weight:600;color:var(--accent-text)}
.rrnb-aipanel .ph .sp{margin-left:auto;display:flex;gap:6px}
.rrnb-aipanel .bd{padding:var(--s-3);font-size:var(--fs-base);color:var(--text);max-height:340px;overflow:auto;white-space:pre-wrap}
.rrnb-aipanel .bd.busy{color:var(--text-subtle)}
.rrnb-aipanel button{height:28px;padding:0 var(--s-2-5);border-radius:var(--r-md);border:1px solid var(--border);
  background:var(--surface);color:var(--text-muted);font-size:var(--fs-sm);font-weight:600;cursor:pointer}
.rrnb-aipanel button.pri{background:var(--rr-amber-primary);color:var(--rr-white);border-color:var(--rr-amber-primary)}
.rrnb-aipanel button:hover{filter:brightness(.98)}
.rrnb-spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;
  display:inline-block;animation:rrnbspin .6s linear infinite}
@keyframes rrnbspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rrnb-spin{animation:none}}

/* conflict banner (stale save / concurrent edit) */
.rrnb-conflict{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap;margin:0 0 var(--s-3);
  padding:var(--s-2) var(--s-3);border:1px solid var(--amber);border-radius:var(--r-md);
  background:var(--amber-soft,rgba(217,119,6,.12));color:var(--amber);font-size:var(--fs-sm);font-weight:600}
.rrnb-conflict button{height:26px;padding:0 var(--s-2-5);border-radius:var(--r-md);border:1px solid var(--amber);
  background:var(--surface);color:var(--amber);font-size:var(--fs-xs);font-weight:700;cursor:pointer}
.rrnb-conflict button.pri{background:var(--amber);color:var(--text-inverse)}

/* presence ("Alice is viewing") + metaline action buttons */
.rrnb-presence{display:inline-flex;align-items:center;gap:5px;color:var(--green)}
.rrnb-presence .pdot{width:7px;height:7px;border-radius:50%;background:var(--green)}
.rrnb-presence[hidden]{display:none}
.rrnb-metabtn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 var(--s-2);
  margin-left:auto;border:1px solid var(--border);border-radius:var(--r-pill);background:transparent;
  color:var(--text-subtle);font-size:var(--fs-xs);font-weight:600;cursor:pointer}
.rrnb-metabtn:hover{color:var(--accent);border-color:var(--accent)}
.rrnb-metabtn svg{width:12px;height:12px}

/* floating table controls */
.rrnb-tablectl{display:flex;gap:4px;flex-wrap:wrap}
.rrnb-tablectl button{height:28px;padding:0 var(--s-2);border:1px solid var(--border);border-radius:var(--r-md);
  background:var(--surface);color:var(--text-muted);font-size:var(--fs-xs);font-weight:600;cursor:pointer}
.rrnb-tablectl button:hover{border-color:var(--accent);color:var(--accent)}
.rrnb-tablectl button.danger:hover{border-color:var(--red);color:var(--red)}

/* ink annotation overlay (draw on a picture) */
.rrnb-ink{position:fixed;inset:0;z-index:120;background:rgba(15,23,42,.66);display:flex;
  flex-direction:column;align-items:center;justify-content:center;gap:var(--s-3);padding:var(--s-4)}
.rrnb-ink[hidden]{display:none}
.rrnb-ink-bar{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--r-lg);padding:var(--s-2) var(--s-3);box-shadow:var(--shadow-pop)}
.rrnb-ink-bar .sw{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}
.rrnb-ink-bar .sw.on{border-color:var(--text);box-shadow:0 0 0 2px var(--surface) inset}
.rrnb-ink-bar .wd{height:28px;padding:0 var(--s-2);border:1px solid var(--border);border-radius:var(--r-md);
  background:var(--surface);color:var(--text-muted);font-size:var(--fs-xs);font-weight:700;cursor:pointer}
.rrnb-ink-bar .wd.on{border-color:var(--accent);color:var(--accent)}
.rrnb-ink-bar .gap{width:1px;align-self:stretch;background:var(--border);margin:2px 4px}
.rrnb-ink-bar button.act{height:28px;padding:0 var(--s-2-5);border:1px solid var(--border);border-radius:var(--r-md);
  background:var(--surface);color:var(--text-muted);font-size:var(--fs-sm);font-weight:600;cursor:pointer}
.rrnb-ink-bar button.act.pri{background:var(--rr-amber-primary);color:var(--rr-white);border-color:var(--rr-amber-primary)}
.rrnb-ink canvas{max-width:92vw;max-height:72vh;background:#fff;border-radius:var(--r-md);
  box-shadow:var(--shadow-pop);cursor:crosshair;touch-action:none}

/* dictation */
.rrnb-tb.rec{background:var(--red-soft,rgba(220,38,38,.12));color:var(--red)}
.rrnb-tb.rec .rrnb-recdot{width:8px;height:8px;border-radius:50%;background:var(--red);
  display:inline-block;margin-right:4px;animation:rrnbspin 1s steps(2) infinite}

/* "mentioned elsewhere" rail panel (object notebooks) */
.rrnb-mentions{flex:0 0 auto;border-top:1px solid var(--border);padding:var(--s-2);max-height:30vh;overflow:auto}
.rrnb-mentions[hidden]{display:none}
.rrnb-mentions h4{margin:0 0 var(--s-1);padding:0 var(--s-2);font-size:var(--fs-xs);font-weight:700;
  text-transform:uppercase;letter-spacing:.04em;color:var(--text-subtle)}
.rrnb-mention{display:block;padding:var(--s-1) var(--s-2);border-radius:var(--r-md);color:var(--accent);
  cursor:pointer;font-size:var(--fs-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrnb-mention:hover{background:var(--accent-soft)}
.rrnb-mention .mut{color:var(--text-subtle);font-size:var(--fs-xs)}

/* mobile top bar (hidden on desktop) */
.rrnb-mobilebar{display:none}

@media (max-width:1100px){.rrnb-shell{grid-template-columns:220px 260px 1fr}}
@media (max-width:860px){
  .rrnb-shell{grid-template-columns:1fr;position:relative}
  /* rail + pages become off-canvas drawers instead of vanishing */
  .rrnb-pane--rail,.rrnb-pane--pages{position:absolute;top:0;bottom:0;left:0;z-index:60;width:min(320px,86vw);
    transform:translateX(-105%);transition:transform .18s ease;box-shadow:var(--shadow-pop);border-right:1px solid var(--border)}
  .rrnb-shell.show-rail .rrnb-pane--rail{transform:translateX(0)}
  .rrnb-shell.show-pages .rrnb-pane--pages{transform:translateX(0)}
  @media (prefers-reduced-motion:reduce){.rrnb-pane--rail,.rrnb-pane--pages{transition:none}}
  .rrnb-mobilebar{display:flex;align-items:center;gap:var(--s-1);flex:0 0 auto;height:44px;
    padding:0 var(--s-2);border-bottom:1px solid var(--border);background:var(--surface)}
  .rrnb-mobilebar button{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 var(--s-2-5);
    border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);color:var(--text-muted);
    font-size:var(--fs-sm);font-weight:600;cursor:pointer}
  .rrnb-mobilebar .ttl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    font-size:var(--fs-sm);font-weight:600;color:var(--text-subtle);text-align:right}
  .rrnb-doc{padding:var(--s-4) var(--s-4) 30vh}
}

/* ═══════════════════════════════════════════════════════════════════════
   CALM RESTYLE — the OneNote-clean direction (approved 2026-07-13).
   Appended last so it wins the cascade; scoped to #view-notebooks. Purely
   visual — no markup logic or behaviour changes. Content on white, an airy
   title + soft date line, whisper-quiet lists, de-boxed callouts & tables,
   a lighter toolbar. Everything stays functional; nothing is hidden.
   ═══════════════════════════════════════════════════════════════════════ */
#view-notebooks .rrnb-pane{border-right-color:#ECEEF1}
#view-notebooks .rrnb-pane--ctx{border-left-color:#ECEEF1}
#view-notebooks .rrnb-pane--canvas{background:#FFFFFF}

/* section list — quiet: subtle gray selection (not a blue wash), a slim
   rounded color tab, more air */
#view-notebooks .rrnb-sections{padding:var(--s-2) var(--s-2) var(--s-4)}
#view-notebooks .rrnb-section{padding:7px 10px 7px 14px;border-radius:var(--r-md)}
#view-notebooks .rrnb-section:hover{background:rgba(15,23,42,.04)}
#view-notebooks .rrnb-section.active{background:rgba(15,23,42,.05);font-weight:600}
#view-notebooks .rrnb-section .bar{left:4px;top:7px;bottom:7px;width:4px;border-radius:2px}
#view-notebooks .rrnb-section .nm{font-weight:460;font-size:13px;color:#1B2430}
#view-notebooks .rrnb-section.active .nm{font-weight:600}

/* page list — subtle gray selection, keep the slim accent bar as the marker */
#view-notebooks .rrnb-page{padding:9px 12px}
#view-notebooks .rrnb-page:hover{background:rgba(15,23,42,.04)}
#view-notebooks .rrnb-page.active{background:rgba(15,23,42,.05)}
#view-notebooks .rrnb-page .ttl{font-weight:480;color:#1B2430}
#view-notebooks .rrnb-page .sub{color:#AEB6C2;margin-top:3px}

/* add controls read as quiet text links, not heavy dashed buttons */
#view-notebooks .rrnb-newpage{border:0;background:transparent;color:var(--accent);
  justify-content:flex-start;padding:8px 10px;font-weight:500}
#view-notebooks .rrnb-newpage:hover{background:rgba(15,23,42,.04);color:var(--accent)}

/* editor — content on white, more air, a lighter title + soft date line.
   The canvas becomes a column so the toolbar can stretch full-width on top
   while the page column stays centered below it. */
#view-notebooks .rrnb-canvas-wrap{flex-direction:column;justify-content:flex-start;align-items:stretch}
#view-notebooks .rrnb-doc{align-self:center;width:100%;max-width:720px;padding:var(--s-6) var(--s-6) 40vh}
#view-notebooks .rrnb-breadcrumb{color:#8A93A2}
#view-notebooks .rrnb-title{font-size:30px;font-weight:600;letter-spacing:-.02em;color:#2A3340;line-height:1.15}
#view-notebooks .rrnb-pdate{font-size:12.5px;color:#AEB6C2;margin:2px 0 4px}
#view-notebooks .rrnb-metaline{gap:var(--s-2-5);color:#8A93A2;margin-top:2px}
#view-notebooks .rrnb-metaline #rrnb-author{display:none}   /* author shown in the date line instead */
#view-notebooks .rrnb-editor{line-height:1.72;min-height:46vh}
#view-notebooks .rrnb-editor h2{margin-top:var(--s-5)}
#view-notebooks .rrnb-editor h3{margin-top:var(--s-5)}

/* toolbar — a full-width ribbon across the whole editor pane (Office/OneNote
   style), sitting above the centered page column and sticking to the top as
   you scroll. A single clean row of icons; scrolls sideways only if the
   window is truly narrow. */
#view-notebooks .rrnb-toolbar{background:#FFFFFF;border:0;border-bottom:1px solid #ECEEF1;
  border-radius:0;box-shadow:none;padding:19px 16px;margin:0;
  position:sticky;top:0;z-index:12;
  flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:#D1D5DB transparent}
#view-notebooks .rrnb-toolbar > *{flex:0 0 auto}
/* Chrome drops a flex scroll container's padding-right, so the last control
   (AI) clips against the edge. A real flex spacer restores the trailing gap. */
#view-notebooks .rrnb-toolbar::after{content:"";flex:0 0 16px;align-self:stretch}
#view-notebooks .rrnb-toolbar::-webkit-scrollbar{height:6px}
#view-notebooks .rrnb-toolbar::-webkit-scrollbar-thumb{background:#D9DDE3;border-radius:3px}
#view-notebooks .rrnb-toolbar::-webkit-scrollbar-track{background:transparent}
#view-notebooks .rrnb-tb{color:#5A6472;min-width:28px;height:34px;padding:0 4px}
#view-notebooks .rrnb-tb:hover{background:rgba(15,23,42,.04);color:#1B2430}
#view-notebooks .rrnb-tb svg{width:17px;height:17px}
#view-notebooks .rrnb-tb-sel{height:34px;font-size:12.5px;padding:0 8px}
#view-notebooks .rrnb-tb-sep{margin:6px 4px}

/* section list — a small color SQUARE before the name (not a left bar), like OneNote */
#view-notebooks .rrnb-section{padding:7px 10px}
#view-notebooks .rrnb-section .bar{position:static;left:auto;top:auto;bottom:auto;width:11px;height:11px;
  border-radius:3px;flex:0 0 auto}
#view-notebooks .rrnb-section.active{box-shadow:none}

/* "Add section" / "Add page" pinned to the top of each pane, quiet text links */
#view-notebooks .rrnb-addtop{margin:0 0 var(--s-1);font-weight:500}
#view-notebooks .rrnb-pageadd-top{padding:var(--s-1) var(--s-2) var(--s-2);margin:0}
#view-notebooks .rrnb-pageadd-top .rrnb-tpl-btn{flex:0 0 auto;width:auto}

/* callouts — de-boxed: a soft left rule, content breathing, no card */
#view-notebooks .rrnb-editor .rrnb-callout{background:transparent;border:0;border-left:2px solid var(--amber-bright,#d97706);
  border-radius:0;padding:2px 0 2px 16px;margin:6px 0 18px}

/* tables — airy: hairline underlines only, quiet uppercase headers, no fills */
#view-notebooks .rrnb-editor table{min-width:60%;width:100%;margin:8px 0 20px}
#view-notebooks .rrnb-editor td,#view-notebooks .rrnb-editor th{border:0;border-bottom:1px solid #ECEEF1;
  padding:9px 14px 9px 0}
#view-notebooks .rrnb-editor th{background:transparent;font-size:var(--fs-xs);text-transform:uppercase;
  letter-spacing:.03em;color:#8A93A2;border-bottom-color:#E2E5EA}

/* TipTap surface inherits the same calm */
#view-notebooks .rrnb-tt table td,#view-notebooks .rrnb-tt table th{border:0;border-bottom:1px solid #ECEEF1}
#view-notebooks .rrnb-tt table th{background:transparent}
</style>

<div class="rrnb-shell" id="rrnb-shell">
  <!-- ── Pane 1: notebooks + sections ─────────────────────────────── -->
  <div class="rrnb-pane rrnb-pane--rail">
    <div class="rrnb-nbpicker">
      <button class="rrnb-nbcurrent" id="rrnb-nb-current" type="button">
        <span class="rrnb-swatch" id="rrnb-nb-swatch"></span>
        <span class="nm" id="rrnb-nb-name">Notebooks</span>
        <span class="chev" aria-hidden="true">▾</span>
      </button>
      <div class="rrnb-menu" id="rrnb-nb-menu" hidden></div>
    </div>
    <div class="rrnb-sections" id="rrnb-sections"></div>
    <div class="rrnb-mentions" id="rrnb-mentions" hidden></div>
    <div class="rrnb-railfoot">
      <button class="rrnb-linkbtn" id="rrnb-quicknote-btn" type="button" title="Capture a quick note (Alt+Q)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg>
        <span>Quick Note</span>
      </button>
      <button class="rrnb-linkbtn" id="rrnb-recent-btn" type="button" title="Recently opened pages">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>
        <span>Recent</span>
      </button>
      <button class="rrnb-linkbtn" id="rrnb-recycle-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
        <span>Recycle Bin</span>
      </button>
    </div>
  </div>

  <!-- ── Pane 2: page list + search ───────────────────────────────── -->
  <div class="rrnb-pane rrnb-pane--pages">
    <div class="rrnb-search">
      <input id="rrnb-search-input" type="search" placeholder="Search all notebooks…  #tag to filter  (Ctrl+F)" autocomplete="off" />
    </div>
    <div class="rrnb-offline" id="rrnb-offline" hidden>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4"/></svg>
      <span>Offline — notes are saved in this browser only and aren't shared with your team.</span>
    </div>
    <div class="rrnb-pagelist" id="rrnb-pagelist"></div>
  </div>

  <!-- ── Pane 3: page canvas / editor ─────────────────────────────── -->
  <div class="rrnb-pane rrnb-pane--canvas">
    <div class="rrnb-mobilebar" id="rrnb-mobilebar">
      <button type="button" id="rrnb-mb-rail" title="Notebook &amp; sections">☰ Sections</button>
      <button type="button" id="rrnb-mb-pages" title="Pages in this section">▤ Pages</button>
      <span class="ttl" id="rrnb-mb-title"></span>
    </div>
    <div class="rrnb-canvas-wrap" id="rrnb-canvas-wrap">
      <div class="rrnb-blank" id="rrnb-blank">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/></svg>
        <div>Select a page, or press <b>Alt+N</b> to create one.</div>
      </div>
    </div>
  </div>

  <!-- ── Pane 4: context rail (linked records · outline · backlinks · props) ── -->
  <div class="rrnb-pane rrnb-pane--ctx" id="rrnb-ctxpane">
    <div class="rrnb-ctxhead">
      <span class="rrnb-ctxtitle">Context</span>
      <button class="rrnb-iconbtn" type="button" data-ctx-toggle title="Hide context panel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
    <div class="rrnb-ctxbody" id="rrnb-ctxbody">
      <div class="rrnb-ctxsec" id="rrnb-ctx-records"></div>
      <div class="rrnb-ctxsec" id="rrnb-ctx-outline"></div>
      <div class="rrnb-ctxsec" id="rrnb-ctx-comments"></div>
      <div class="rrnb-ctxsec" id="rrnb-ctx-backlinks"></div>
      <div class="rrnb-ctxsec" id="rrnb-ctx-props"></div>
      <div class="rrnb-ctxempty" id="rrnb-ctx-empty">Open a page to see its linked RouteReady records, outline, backlinks and properties.</div>
    </div>
  </div>
</div>

<!-- picker / context-menu hosts (portaled to body-level fixed positioning) -->
<div class="rrnb-ctx" id="rrnb-ctx" hidden></div>
<div class="rrnb-pop" id="rrnb-pop" hidden></div>

<script>
(function () {
  "use strict";
  if (window.RRNotebooks && window.RRNotebooks.__inited) return;

  // ── tiny helpers ────────────────────────────────────────────────
  var ROOT = function () { return document.getElementById("view-notebooks"); };
  var $ = function (sel) { var r = ROOT(); return r ? r.querySelector(sel) : null; };
  var $id = function (id) { return document.getElementById(id); };
  function uid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return "id-" + Math.random().toString(36).slice(2) + "-" + (new Date().getTime()).toString(36);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this;
    clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function relTime(iso) {
    if (!iso) return "";
    var d = (new Date().getTime() - new Date(iso).getTime()) / 1000;
    if (d < 45) return "just now";
    if (d < 90) return "a minute ago";
    if (d < 3600) return Math.round(d / 60) + " min ago";
    if (d < 86400) return Math.round(d / 3600) + " h ago";
    return Math.round(d / 86400) + " d ago";
  }
  var PALETTE = ["#2563eb", "#7c3aed", "#dc2626", "#d97706", "#16a34a", "#0891b2", "#db2777", "#475569"];

  // ══════════════════════════════════════════════════════════════════
  //  DATA LAYER — two interchangeable backends behind one interface.
  //  Supa: migration-0451 RPCs.  Local: offline-first localStorage store.
  // ══════════════════════════════════════════════════════════════════
  function sbClient() {
    var sb = (window.RR && window.RR.sb) || window.sb || null;
    var dsp = window.RR && window.RR.dsp && window.RR.dsp.id;
    return (sb && dsp) ? sb : null;
  }

  // ---- Supabase backend -------------------------------------------------
  function SupaBackend(sb) {
    function rpc(fn, args) {
      return sb.rpc(fn, args || {}).then(function (r) {
        if (r.error) throw r.error; return r.data;
      });
    }
    return {
      kind: "supabase",
      listNotebooks: function () { return rpc("notebooks_list"); },
      tree: function (id) { return rpc("notebook_tree", { p_notebook_id: id }); },
      ensureFor: function (t, i, title) { return rpc("notebook_ensure_for", { p_subject_type: t, p_subject_id: String(i), p_title: title || null }); },
      createNotebook: function (name, color, kind) { return rpc("notebook_create", { p_name: name, p_color: color, p_kind: kind || "workspace" }); },
      shareCandidates: function () { return rpc("notebook_share_candidates"); },
      shareList: function (nb) { return rpc("notebook_share_list", { p_notebook_id: nb }); },
      shareSet: function (nb, members) { return rpc("notebook_share_set", { p_notebook_id: nb, p_members: members }); },
      createGroup: function (nb, name) { return rpc("notebook_section_group_create", { p_notebook_id: nb, p_name: name }); },
      createSection: function (nb, name, grp, color) { return rpc("notebook_section_create", { p_notebook_id: nb, p_name: name, p_group_id: grp || null, p_color: color }); },
      createPage: function (sec, title, parent, level) { return rpc("notebook_page_create", { p_section_id: sec, p_title: title, p_parent_page_id: parent || null, p_level: level || 0 }); },
      getPage: function (id) { return rpc("notebook_page_get", { p_id: id }); },
      savePage: function (id, p, base) { return rpc("notebook_page_save", { p_id: id, p_title: p.title, p_content_html: p.content_html, p_content_text: p.content_text, p_tags: p.tags, p_base_updated_at: base || null }); },
      revisionsList: function (page) { return rpc("notebook_page_revisions_list", { p_page_id: page }); },
      revisionGet: function (id) { return rpc("notebook_page_revision_get", { p_id: id }); },
      revisionRestore: function (id) { return rpc("notebook_page_revision_restore", { p_id: id }); },
      pagesForObject: function (t, i) { return rpc("notebook_pages_for_object", { p_target_type: t, p_target_id: String(i) }); },
      rename: function (kind, id, name, color) { return rpc("notebook_item_rename", { p_kind: kind, p_id: id, p_name: name, p_color: color || null }); },
      movePage: function (id, p) { return rpc("notebook_page_move", { p_id: id, p_section_id: p.section_id || null, p_parent_page_id: p.parent_page_id || null, p_level: p.level == null ? null : p.level, p_position: p.position == null ? null : p.position }); },
      pinPage: function (id, on) { return rpc("notebook_page_pin", { p_id: id, p_pinned: !!on }); },
      duplicatePage: function (id) { return rpc("notebook_page_duplicate", { p_id: id }); },
      deleteItem: function (kind, id) { return rpc("notebook_item_delete", { p_kind: kind, p_id: id }); },
      recycleList: function (nb) { return rpc("notebook_recycle_list", { p_notebook_id: nb }); },
      restoreItem: function (kind, id) { return rpc("notebook_item_restore", { p_kind: kind, p_id: id }); },
      setLinks: function (page, links) { return rpc("notebook_links_set", { p_source_page_id: page, p_links: links }); },
      backlinks: function (page) { return rpc("notebook_page_backlinks", { p_page_id: page }); },
      search: function (q, opt) { opt = opt || {}; return rpc("notebook_search", { p_query: q, p_notebook_id: opt.notebookId || null, p_tag: opt.tag || null, p_limit: 50 }); },
      commentsList: function (page) { return rpc("notebook_comments_list", { p_page_id: page }); },
      commentAdd: function (page, body, parent, anchor, mentions) { return rpc("notebook_comment_add", { p_page_id: page, p_body: body, p_parent_id: parent || null, p_anchor: anchor || null, p_mentions: (mentions && mentions.length) ? mentions : null }); },
      commentResolve: function (id, on) { return rpc("notebook_comment_resolve", { p_id: id, p_resolved: !!on }); },
      commentDelete: function (id) { return rpc("notebook_comment_delete", { p_id: id }); },
      commentCounts: function (ids) { return rpc("notebook_comment_counts", { p_page_ids: ids || [] }); }
    };
  }

  // ---- Local (offline-first) backend -----------------------------------
  function LocalBackend() {
    var KEY = "rrnb:v1:" + (((window.RR && window.RR.dsp && window.RR.dsp.id) || "local"));
    var db;
    function load() {
      try { db = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { db = null; }
      if (!db) { db = seed(); persist(); }
      return db;
    }
    function persist() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
    // version history (local flavor): one snapshot per minute of editing, newest 20 per page
    function snapshot(p, patch) {
      if (patch.content_html == null || patch.content_html === p.content_html) return;
      db.revisions = db.revisions || [];
      var last = db.revisions.filter(function (r) { return r.page_id === p.id; })
        .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })[0];
      if (last && (new Date().getTime() - new Date(last.created_at).getTime()) < 60000) return;
      db.revisions.push({ id: uid(), page_id: p.id, title: p.title, content_html: p.content_html, content_text: p.content_text, tags: (p.tags || []).slice(), created_at: new Date().toISOString() });
      var mine = db.revisions.filter(function (r) { return r.page_id === p.id; })
        .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
      if (mine.length > 20) { var drop = {}; mine.slice(20).forEach(function (r) { drop[r.id] = 1; });
        db.revisions = db.revisions.filter(function (r) { return !drop[r.id]; }); }
    }
    function seed() {
      var now = new Date().toISOString();
      var nb = uid(), sec = uid(), sec2 = uid(), p1 = uid(), p2 = uid();
      return {
        notebooks: [{ id: nb, name: "Operations", color: "#2563eb", kind: "workspace", is_pinned: true, position: 0, subject_type: null, subject_id: null }],
        groups: [], sections: [
          { id: sec, notebook_id: nb, group_id: null, name: "Daily Ops", color: "#2563eb", position: 0 },
          { id: sec2, notebook_id: nb, group_id: null, name: "Playbooks", color: "#16a34a", position: 1 }
        ],
        pages: [
          { id: p1, notebook_id: nb, section_id: sec, parent_page_id: null, level: 0, position: 0, title: "Welcome to Notebooks", tags: ["important"], is_pinned: true, created_at: now, updated_at: now,
            content_html: "<p>This is your RouteReady notebook — a full <b>OneNote-class</b> workspace for the whole operation.</p><h2>What you can do</h2><div class='rrnb-todo' data-checked='1'><span class='rrnb-todo-box' contenteditable='false'>✓</span><span class='rrnb-todo-text'>Write rich notes that autosave every keystroke</span></div><div class='rrnb-todo' data-checked='0'><span class='rrnb-todo-box' contenteditable='false'></span><span class='rrnb-todo-text'>Organize by Notebook ▸ Section ▸ Page ▸ Subpage</span></div><div class='rrnb-todo' data-checked='0'><span class='rrnb-todo-box' contenteditable='false'></span><span class='rrnb-todo-text'>Search everything instantly (Ctrl+F)</span></div><p>Every driver, vehicle, route and station has its own notebook too.</p>",
            content_text: "This is your RouteReady notebook. What you can do. Write rich notes. Organize. Search everything." },
          { id: p2, notebook_id: nb, section_id: sec, parent_page_id: p1, level: 1, position: 1, title: "Keyboard shortcuts", tags: [], is_pinned: false, created_at: now, updated_at: now,
            content_html: "<h2>Formatting</h2><ul><li><b>Ctrl+B / I / U</b> — bold, italic, underline</li><li><b>Ctrl+1</b> — to-do checkbox (Enter continues the list)</li><li><b>Ctrl+K</b> — insert link · <b>[[</b> — link or create a page</li><li><b>Alt+N</b> — new page · <b>Alt+Q</b> — quick note</li><li><b>Tab</b> in a table — next cell (adds a row at the end); right-click for table controls</li><li><b>#tag</b> in search — filter by tag</li></ul>",
            content_text: "Keyboard shortcuts formatting bold italic underline to-do link new page quick note table tag search" }
        ]
      };
    }
    load();
    function P(v) { return Promise.resolve(v); }
    function nb(id) { return db.notebooks.filter(function (n) { return n.id === id; })[0]; }
    return {
      kind: "local",
      listNotebooks: function () { return P(db.notebooks.filter(function (n) { return !n.deleted_at; }).map(function (n) {
        return { id: n.id, name: n.name, color: n.color, kind: n.kind, subject_type: n.subject_type, subject_id: n.subject_id, is_pinned: n.is_pinned, position: n.position,
          page_count: db.pages.filter(function (p) { return p.notebook_id === n.id && !p.deleted_at; }).length }; })); },
      tree: function (id) { return P({
        notebook: nb(id),
        groups: db.groups.filter(function (g) { return g.notebook_id === id && !g.deleted_at; }),
        sections: db.sections.filter(function (s) { return s.notebook_id === id && !s.deleted_at; }),
        pages: db.pages.filter(function (p) { return p.notebook_id === id && !p.deleted_at; })
          .map(function (p) { return { id: p.id, section_id: p.section_id, parent_page_id: p.parent_page_id, title: p.title, level: p.level, position: p.position, tags: p.tags, is_pinned: p.is_pinned, updated_at: p.updated_at }; })
      }); },
      ensureFor: function (t, i, title) {
        var found = db.notebooks.filter(function (n) { return n.subject_type === t && n.subject_id === String(i); })[0];
        // a deleted object notebook is revived, not duplicated — matches notebook_ensure_for
        if (found && found.deleted_at) { delete found.deleted_at; persist(); }
        if (!found) { var id = uid(); found = { id: id, name: title || (t.charAt(0).toUpperCase() + t.slice(1) + " notebook"), color: "#2563eb", kind: "object", subject_type: t, subject_id: String(i), is_pinned: false, position: db.notebooks.length };
          db.notebooks.push(found); db.sections.push({ id: uid(), notebook_id: id, group_id: null, name: "Notes", color: "#2563eb", position: 0 }); persist(); }
        return P(found);
      },
      shareCandidates: function () { return P([]); },
      shareList: function () { return P([]); },
      shareSet: function () { return P([]); },
      createNotebook: function (name, color, kind) { var id = uid(); var n = { id: id, name: name || "New Notebook", color: color || "#2563eb", kind: kind === "personal" ? "personal" : "workspace", is_pinned: false, position: db.notebooks.length, subject_type: null, subject_id: null };
        db.notebooks.push(n); db.sections.push({ id: uid(), notebook_id: id, group_id: null, name: "New Section", color: color || "#2563eb", position: 0 }); persist(); return P(n); },
      createGroup: function (nbId, name) { var g = { id: uid(), notebook_id: nbId, name: name || "New Group", color: "#64748b", position: db.groups.length }; db.groups.push(g); persist(); return P(g); },
      createSection: function (nbId, name, grp, color) { var s = { id: uid(), notebook_id: nbId, group_id: grp || null, name: name || "New Section", color: color || "#2563eb", position: db.sections.length }; db.sections.push(s); persist(); return P(s); },
      createPage: function (sec, title, parent, level) { var s = db.sections.filter(function (x) { return x.id === sec; })[0]; var now = new Date().toISOString();
        var p = { id: uid(), notebook_id: s ? s.notebook_id : null, section_id: sec, parent_page_id: parent || null, level: level || 0, position: db.pages.length, title: title || "Untitled Page", content_html: "", content_text: "", tags: [], is_pinned: false, created_at: now, updated_at: now };
        db.pages.push(p); persist(); return P(p); },
      getPage: function (id) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; return P(p ? JSON.parse(JSON.stringify(p)) : null); },
      savePage: function (id, patch) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; if (p) { snapshot(p, patch); if (patch.title != null) p.title = patch.title; if (patch.content_html != null) p.content_html = patch.content_html; if (patch.content_text != null) p.content_text = patch.content_text; if (patch.tags != null) p.tags = patch.tags; p.updated_at = new Date().toISOString(); persist(); } return P(p ? { id: p.id, title: p.title, updated_at: p.updated_at } : null); },
      revisionsList: function (page) { return P((db.revisions || []).filter(function (r) { return r.page_id === page; })
        .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
        .map(function (r) { return { id: r.id, title: r.title, created_at: r.created_at, author: "You", chars: (r.content_text || "").length }; })); },
      revisionGet: function (id) { var r = (db.revisions || []).filter(function (x) { return x.id === id; })[0]; return P(r ? JSON.parse(JSON.stringify(r)) : null); },
      revisionRestore: function (id) { var r = (db.revisions || []).filter(function (x) { return x.id === id; })[0]; if (!r) return P(null);
        var p = db.pages.filter(function (x) { return x.id === r.page_id; })[0]; if (!p) return P(null);
        db.revisions.push({ id: uid(), page_id: p.id, title: p.title, content_html: p.content_html, content_text: p.content_text, tags: (p.tags || []).slice(), created_at: new Date().toISOString() });
        p.title = r.title; p.content_html = r.content_html; p.content_text = r.content_text; p.tags = (r.tags || []).slice(); p.updated_at = new Date().toISOString(); persist();
        return P({ id: p.id, title: p.title, content_html: p.content_html, tags: p.tags, updated_at: p.updated_at }); },
      pagesForObject: function () { return P([]); },
      rename: function (kind, id, name, color) { var col = kind === "notebook" ? db.notebooks : kind === "group" ? db.groups : kind === "section" ? db.sections : db.pages; var r = col.filter(function (x) { return x.id === id; })[0]; if (r) { if (kind === "page") r.title = name; else r.name = name; if (color) r.color = color; } persist(); return P(); },
      movePage: function (id, patch) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; if (p) { if (patch.section_id) { p.section_id = patch.section_id; var s = db.sections.filter(function (x) { return x.id === patch.section_id; })[0]; if (s) p.notebook_id = s.notebook_id; } if (patch.parent_page_id !== undefined && patch.parent_page_id !== id) p.parent_page_id = patch.parent_page_id; if (patch.level != null) p.level = patch.level; if (patch.position != null) p.position = patch.position; } persist(); return P(); },
      pinPage: function (id, on) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; if (p) p.is_pinned = !!on; persist(); return P(); },
      duplicatePage: function (id) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; if (!p) return P(null); var now = new Date().toISOString();
        var c = { id: uid(), notebook_id: p.notebook_id, section_id: p.section_id, parent_page_id: p.parent_page_id, level: p.level, position: db.pages.length, title: p.title + " (copy)", content_html: p.content_html, content_text: p.content_text, tags: (p.tags || []).slice(), is_pinned: false, created_at: now, updated_at: now }; db.pages.push(c); persist(); return P(c); },
      deleteItem: function (kind, id) { var now = new Date().toISOString();
        if (kind === "page") db.pages.forEach(function (p) { if (p.id === id || p.parent_page_id === id) p.deleted_at = now; });
        else if (kind === "section") { db.sections.forEach(function (s) { if (s.id === id) s.deleted_at = now; }); db.pages.forEach(function (p) { if (p.section_id === id) p.deleted_at = now; }); }
        else if (kind === "group") db.groups.forEach(function (g) { if (g.id === id) g.deleted_at = now; });
        else if (kind === "notebook") db.notebooks.forEach(function (n) { if (n.id === id) n.deleted_at = now; });
        persist(); return P(); },
      recycleList: function (nbId) { return P(db.pages.filter(function (p) { return p.notebook_id === nbId && p.deleted_at; }).map(function (p) { return { id: p.id, title: p.title, section_id: p.section_id, deleted_at: p.deleted_at }; })); },
      restoreItem: function (kind, id) { var col = kind === "page" ? db.pages : kind === "section" ? db.sections : db.notebooks; col.forEach(function (x) { if (x.id === id) delete x.deleted_at; }); persist(); return P(); },
      setLinks: function () { return P(); },
      backlinks: function () { return P([]); },
      search: function (q, opt) { opt = opt || {}; q = (q || "").toLowerCase().trim();
        var res = db.pages.filter(function (p) { return !p.deleted_at && (!opt.notebookId || p.notebook_id === opt.notebookId) && (!opt.tag || (p.tags || []).indexOf(opt.tag) >= 0)
          && (!q || (p.title + " " + p.content_text).toLowerCase().indexOf(q) >= 0); });
        return P(res.slice(0, 50).map(function (p) { var n = nb(p.notebook_id); var s = db.sections.filter(function (x) { return x.id === p.section_id; })[0];
          var idx = p.content_text.toLowerCase().indexOf(q); var snip = q && idx >= 0 ? p.content_text.slice(Math.max(0, idx - 20), idx + 40) : p.content_text.slice(0, 60);
          return { id: p.id, notebook_id: p.notebook_id, section_id: p.section_id, title: p.title, tags: p.tags, notebook_name: n ? n.name : "", section_name: s ? s.name : "", snippet: esc(snip) }; })); },
      commentsList: function (page) { return P((db.comments || []).filter(function (c) { return c.page_id === page; }).sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; })); },
      commentAdd: function (page, body, parent, anchor) {
        var c = { id: uid(), page_id: page, parent_id: parent || null, anchor: anchor || null, body: String(body).trim(),
          author: "You", author_id: "local", is_mine: true, resolved: false, mentions: [], created_at: new Date().toISOString() };
        (db.comments = db.comments || []).push(c); persist(); return P(c); },
      commentResolve: function (id, on) { var c = (db.comments || []).filter(function (x) { return x.id === id; })[0]; if (c) { c.resolved = !!on; persist(); } return P(); },
      commentDelete: function (id) { db.comments = (db.comments || []).filter(function (x) { return x.id !== id && x.parent_id !== id; }); persist(); return P(); },
      commentCounts: function (ids) { var m = {}; (db.comments || []).forEach(function (c) { if (!c.resolved && (ids || []).indexOf(c.page_id) >= 0) m[c.page_id] = (m[c.page_id] || 0) + 1; }); return P(m); }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  STATE + CONTROLLER
  // ══════════════════════════════════════════════════════════════════
  var S = { be: null, notebooks: [], nbId: null, tree: null, pageId: null, page: null,
    saveTimer: null, saving: false, savedAt: null, mode: "notebook", collapsedGroups: {} };

  function chooseBackend() {
    var sb = sbClient();
    S.be = sb ? SupaBackend(sb) : LocalBackend();
    var off = $id("rrnb-offline"); if (off) off.hidden = !!sb;
  }

  function notify(msg) {
    try { if (window.toast) { window.toast(msg); return; } if (window.rrToast) { window.rrToast(msg); return; } } catch (e) {}
    // Self-rendered fallback so notebook feedback always shows, even if the
    // host app's toast isn't exposed on window.
    try {
      var t = document.getElementById("rrnb-toast");
      if (!t) { t = document.createElement("div"); t.id = "rrnb-toast";
        t.style.cssText = "position:fixed;z-index:2147483000;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;font-family:inherit;box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;transition:opacity .15s;pointer-events:none;max-width:80vw";
        document.body.appendChild(t); }
      t.textContent = msg; t.style.opacity = "1"; clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = "0"; }, 2400);
    } catch (e) {}
  }
  function fail(e) { console.warn("[notebooks]", e); notify((e && e.message) || "Something went wrong"); }

  // ── first load ──────────────────────────────────────────────────
  function provKey() { return "rrnb-provisioned:" + (((window.RR && window.RR.dsp && window.RR.dsp.id) || "local")); }
  function defaultNbName() {
    var d = window.RR && window.RR.dsp && window.RR.dsp.name;
    return d ? (d + " Notebook") : "Workspace";
  }
  function loadView(opts) {
    var root = ROOT(); if (!root) return;
    if (!S.be) chooseBackend();
    bindOnce();
    initRealtime();
    setTimeout(outboxFlush, 400); // replay edits queued while offline / in a closed tab
    // RouteReady Meet hand-off — if notes are waiting in the inbox, import them
    // into the "Meeting Notes" notebook and open the page. Guarded so a second
    // loadView() during the async import doesn't double-create. When signed in
    // we must wait for the workspace (window.RR.dsp) to load first, otherwise
    // sbClient() is null, the import lands in a throwaway LOCAL store, and the
    // note never shows in the Supabase notebook. Retry briefly until ready.
    if (!S.meetImporting && readMeetInbox().length) {
      if (meetSignedIn() && !(window.RR && window.RR.dsp && window.RR.dsp.id)) {
        if (!S._meetWaiting && (S._meetWait = (S._meetWait || 0) + 1) < 60) {
          S._meetWaiting = true;
          setTimeout(function () { S._meetWaiting = false; loadView(opts); }, 150);
        }
        return; // come back once the workspace is ready
      }
      S.meetImporting = true;
      S.be = null; chooseBackend(); // re-derive the backend now that dsp is ready
      return importMeetInbox().then(function (dest) {
        S.meetImporting = false;
        return S.be.listNotebooks().then(function (list) {
          S.notebooks = list || []; renderNotebookMenu(); S.activeSection = null;
          if (dest && dest.nbId) return selectNotebook(dest.nbId, dest.pageId);
        });
      }).catch(function (e) { S.meetImporting = false; return onLoadError(e); });
    }
    // Object-notebook navigation (RRNotebooks.openFor) — consumed here,
    // synchronously, so it wins over any concurrent default load.
    var po = S.pendingObject; S.pendingObject = null;
    if (po) {
      return S.be.ensureFor(po.t, po.i, po.title).then(function (nb) {
        return S.be.listNotebooks().then(function (list) {
          S.notebooks = list || []; renderNotebookMenu(); S.activeSection = null;
          return selectNotebook(nb.id);
        });
      }).catch(onLoadError);
    }
    S.be.listNotebooks().then(function (list) {
      S.notebooks = list || [];
      renderNotebookMenu();
      var want = (opts && opts.notebookId) || S.nbId || (S.notebooks[0] && S.notebooks[0].id);
      if (want) return selectNotebook(want, opts && opts.pageId);
      // No notebooks yet. On a signed-in workspace, provision a starter
      // notebook once (so the user lands somewhere usable, like OneNote's
      // "My Notebook"); if they've since emptied it, show a create CTA.
      var firstRun = false;
      try { firstRun = !localStorage.getItem(provKey()); } catch (e) {}
      if (S.be.kind === "supabase" && firstRun) {
        try { localStorage.setItem(provKey(), "1"); } catch (e) {}
        return S.be.createNotebook(defaultNbName(), "#2563eb").then(function (nb) {
          return S.be.listNotebooks().then(function (l) {
            S.notebooks = l || []; renderNotebookMenu(); S.activeSection = null;
            return selectNotebook((nb && nb.id) || (S.notebooks[0] && S.notebooks[0].id));
          });
        }).catch(onLoadError);
      }
      renderSections(); renderPageList(); renderFirstRun();
    }).catch(onLoadError);
  }

  // Distinguish "database not set up yet" (migration missing) from real errors
  // so the operator sees a clear next step instead of a silent blank view.
  function onLoadError(e) {
    console.warn("[notebooks]", e);
    var msg = (e && (e.message || e.hint || e.details)) || "";
    var m = String(msg).toLowerCase();
    var host = $id("rrnb-canvas-wrap");
    var needsSetup = /does not exist|not find|schema cache|function .*notebook|relation .*notebook|pgrst|404/.test(m);
    var forbidden = /forbidden|permission|not allowed|42501/.test(m);
    if (host) {
      if (needsSetup) {
        host.innerHTML = '<div class="rrnb-blank"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3l9 4-9 4-9-4 9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/></svg>' +
          '<div style="max-width:420px"><b style="color:var(--text);display:block;margin-bottom:6px">Almost there — Notebooks needs its database tables</b>' +
          'An admin needs to run migration <code style="font-family:ui-monospace,monospace">0451_notebooks.sql</code> in the Supabase SQL Editor. It\'s a one-time, idempotent step.</div>' +
          '<button class="rrnb-pop-btn" id="rrnb-retry" style="margin-top:6px">Retry</button></div>';
      } else if (forbidden) {
        host.innerHTML = '<div class="rrnb-blank"><div style="max-width:420px"><b style="color:var(--text)">Notebooks is staff-only</b><br>Your role doesn\'t have notebook access yet. Ask an owner or manager to grant it.</div></div>';
      } else {
        host.innerHTML = '<div class="rrnb-blank"><div style="max-width:420px"><b style="color:var(--text)">Couldn\'t load notebooks</b><br>' + esc(msg || "Something went wrong.") + '</div><button class="rrnb-pop-btn" id="rrnb-retry" style="margin-top:6px">Retry</button></div>';
      }
      var rb = $id("rrnb-retry"); if (rb) rb.addEventListener("click", function () { S.be = null; loadView(); });
    }
    var sec = $id("rrnb-sections"); if (sec) sec.innerHTML = '<div class="rrnb-empty">Not set up yet.</div>';
  }

  // Signed-in workspace with zero notebooks (after the user emptied it):
  // an unmistakable way to start a new one.
  function renderFirstRun() {
    var host = $id("rrnb-canvas-wrap"); if (!host) return;
    host.innerHTML = '<div class="rrnb-blank"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/></svg>' +
      '<div><b style="color:var(--text);display:block;margin-bottom:4px">No notebooks yet</b>Create your first notebook to start capturing notes.</div>' +
      '<button class="rrnb-pop-btn" id="rrnb-firstnb" style="margin-top:6px">＋ New notebook</button></div>';
    var b = $id("rrnb-firstnb"); if (b) b.addEventListener("click", createNotebookFlow);
    var sec = $id("rrnb-sections"); if (sec) sec.innerHTML = '<button class="rrnb-newpage" data-new-notebook="1" style="margin:var(--s-2)">＋ New notebook</button>';
  }

  function selectNotebook(id, pageId) {
    S.nbId = id;
    var meta = S.notebooks.filter(function (n) { return n.id === id; })[0];
    var nm = $id("rrnb-nb-name"), sw = $id("rrnb-nb-swatch");
    if (nm) nm.textContent = meta ? meta.name : "Notebook";
    if (sw && meta) sw.style.background = meta.color || "var(--accent)";
    return S.be.tree(id).then(function (t) {
      S.tree = t; S.mode = "notebook";
      S.myRole = (t.notebook && t.notebook.my_role) || "editor";
      S.readOnly = S.myRole === "viewer";
      renderSections(); renderPageList();
      renderMentions(meta || (t && t.notebook));
      var first = pageId || (S.activeSection && firstPageOf(S.activeSection)) || null;
      if (!S.activeSection) { var secs = (t.sections || []); S.activeSection = secs[0] && secs[0].id; }
      renderPageList();
      var target = pageId || firstPageOf(S.activeSection);
      if (target) openPage(target); else showBlank();
    }).catch(fail);
  }

  function firstPageOf(secId) { if (!S.tree) return null; var p = S.tree.pages.filter(function (x) { return x.section_id === secId; }).sort(bySort)[0]; return p && p.id; }
  function bySort(a, b) { return (a.is_pinned ? -1 : 0) - (b.is_pinned ? -1 : 0) || (a.position - b.position); }

  // ── notebook picker menu ─────────────────────────────────────────
  function renderNotebookMenu() {
    var m = $id("rrnb-nb-menu"); if (!m) return;
    var html = S.notebooks.map(function (n) {
      var badge = "";
      if (n.kind === "personal") {
        badge = (n.member_count > 0)
          ? '<span class="ct" title="Private — shared with ' + n.member_count + '">🔒👥' + n.member_count + '</span>'
          : '<span class="ct" title="Private — only you">🔒</span>';
        if (n.my_role === "viewer") badge += '<span class="ct" title="View only">view</span>';
      }
      return '<div class="rrnb-menu-item" data-nb="' + n.id + '"><span class="rrnb-swatch" style="background:' + esc(n.color) + '"></span>' +
        '<span class="nm">' + esc(n.name) + '</span>' + badge + '<span class="ct">' + (n.page_count || 0) + '</span>' +
        '<button class="rrnb-iconbtn kebab" data-menu="notebook" data-id="' + n.id + '" title="Notebook options">⋯</button></div>';
    }).join("");
    html += '<div class="rrnb-menu-sep"></div><div class="rrnb-menu-item rrnb-menu-add" data-new="1">＋ New notebook</div>' +
      '<div class="rrnb-menu-item rrnb-menu-add" data-new-private="1" title="Only you can see it, until you share it">🔒 New private notebook</div>';
    m.innerHTML = html;
  }

  // ── rename a notebook inline, right in the picker header ─────────────
  // No modal prompt: the current-notebook name becomes editable in place
  // (double-click it, or ⋯ → Rename notebook). Enter / blur commits,
  // Escape cancels.
  function startNotebookRename(id) {
    // Renaming happens in the header, which only shows the active notebook,
    // so switch to it first when the ⋯ came from another row.
    if (id && id !== S.nbId) { S.activeSection = null; return selectNotebook(id).then(beginHeaderEdit); }
    beginHeaderEdit();
  }
  function beginHeaderEdit() {
    var nm = $id("rrnb-nb-name"); if (!nm || !S.nbId || S._nbEditing) return;
    S._nbEditing = true; S._nbEditOrig = nm.textContent || "";
    nm.classList.add("is-editing");
    nm.setAttribute("contenteditable", "true"); nm.setAttribute("spellcheck", "false");
    nm.focus();
    try { var r = document.createRange(); r.selectNodeContents(nm); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
  }
  function endHeaderEdit(commit) {
    var nm = $id("rrnb-nb-name"); if (!nm || !S._nbEditing) return;
    S._nbEditing = false;
    nm.removeAttribute("contenteditable"); nm.classList.remove("is-editing");
    var next = (nm.textContent || "").replace(/\s+/g, " ").trim();
    var orig = (S._nbEditOrig || "").trim();
    var id = S.nbId;
    if (!commit || !next || next === orig) { nm.textContent = orig; return; }
    nm.textContent = next;
    S.be.rename("notebook", id, next).then(function () {
      var n = (S.notebooks || []).filter(function (x) { return x.id === id; })[0]; if (n) n.name = next;
      renderNotebookMenu();
      if (S.nbId === id) { var cn = $(".rrnb-cr-nb"); if (cn) cn.textContent = next; }
    }).catch(function (e) { nm.textContent = orig; fail(e); });
  }

  // ── delete a notebook (soft-delete → recycle) ───────────────────────
  function deleteNotebook(id) {
    var n = (S.notebooks || []).filter(function (x) { return x.id === id; })[0];
    var nm = n ? n.name : "this notebook";
    var pc = n ? (n.page_count || 0) : 0;
    var msg = 'Delete "' + nm + '"?' + (pc ? ' Its ' + pc + ' page' + (pc === 1 ? '' : 's') + ' will move to the Recycle Bin.' : '');
    if (!window.confirm(msg)) return;
    S.be.deleteItem("notebook", id).then(function () {
      return S.be.listNotebooks().then(function (list) {
        S.notebooks = list || []; renderNotebookMenu();
        if (S.nbId !== id) return;
        S.nbId = null; S.tree = null; S.pageId = null; S.activeSection = null; S.mode = "notebook";
        if (S.notebooks[0]) return selectNotebook(S.notebooks[0].id);
        var hn = $id("rrnb-nb-name"); if (hn) hn.textContent = "Notebooks";
        var sw = $id("rrnb-nb-swatch"); if (sw) sw.style.background = "var(--accent)";
        renderSections(); renderPageList(); renderFirstRun();
      });
    }).catch(fail);
  }

  // ── generic inline title editing (sections, pages, groups) ──────────
  // Double-click any title to rename it in place — no modal. Enter / blur
  // commits, Escape cancels. renderSections()/renderPageList() no-op while
  // an edit is live (S._inlineEditing) so an async re-render can't wipe the
  // field mid-edit; we re-render once the edit settles.
  function startInlineEdit(el, commit, refresh) {
    if (!el || S._inlineEditing) return;
    S._inlineEditing = true;
    var orig = el.textContent, done = false;
    el.setAttribute("contenteditable", "true"); el.setAttribute("spellcheck", "false");
    el.classList.add("rrnb-inline-edit");
    el.focus();
    try { var r = document.createRange(); r.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
    function finish(save) {
      if (done) return; done = true; S._inlineEditing = false;
      el.removeEventListener("keydown", onKey); el.removeEventListener("blur", onBlur);
      el.removeAttribute("contenteditable"); el.classList.remove("rrnb-inline-edit");
      var next = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!save || !next || next === (orig || "").trim()) { el.textContent = orig; if (refresh) refresh(); return; }
      el.textContent = next;
      try { commit(next); } catch (e2) {}
      if (refresh) refresh();
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    }
    function onBlur() { finish(true); }
    el.addEventListener("keydown", onKey); el.addEventListener("blur", onBlur);
  }
  function editSectionTitle(id) {
    var host = $id("rrnb-sections");
    var el = host && host.querySelector('.rrnb-section[data-sec="' + id + '"] .nm');
    if (!el) return renamePrompt("section", id);
    startInlineEdit(el, function (next) {
      var s = ((S.tree && S.tree.sections) || []).filter(function (x) { return x.id === id; })[0];
      var prev = s ? s.name : ""; if (s) s.name = next;
      if (S.pageId) { var op = pageById(S.pageId); if (op && op.section_id === id) { var cs = $(".rrnb-cr-sec"); if (cs) cs.textContent = next; } }
      S.be.rename("section", id, next).catch(function (err) { if (s) s.name = prev; renderSections(); fail(err); });
    }, renderSections);
  }
  function editPageTitle(id) {
    var host = $id("rrnb-pagelist");
    var el = host && host.querySelector('.rrnb-page[data-page="' + id + '"] .ttl');
    if (!el) return renamePrompt("page", id);
    startInlineEdit(el, function (next) {
      var p = pageById(id); var prev = p ? p.title : ""; if (p) p.title = next;
      if (S.pageId === id) { if (S.page) S.page.title = next; var t = $id("rrnb-title"); if (t) t.value = next; updateBreadcrumbTitle(); }
      S.be.rename("page", id, next).catch(function (err) {
        if (p) p.title = prev; if (S.pageId === id) { var t2 = $id("rrnb-title"); if (t2) t2.value = prev; updateBreadcrumbTitle(); }
        renderPageList(); fail(err);
      });
    }, renderPageList);
  }
  function editGroupTitle(id) {
    var host = $id("rrnb-sections");
    var el = host && host.querySelector('.rrnb-group-hd[data-toggle="' + id + '"] .gnm');
    if (!el) return;
    startInlineEdit(el, function (next) {
      var g = ((S.tree && S.tree.groups) || []).filter(function (x) { return x.id === id; })[0];
      var prev = g ? g.name : ""; if (g) g.name = next;
      S.be.rename("group", id, next).catch(function (err) { if (g) g.name = prev; renderSections(); fail(err); });
    }, renderSections);
  }

  // ── sections rail ────────────────────────────────────────────────
  function renderSections() {
    if (S._inlineEditing) return; // don't wipe an in-progress inline rename
    var host = $id("rrnb-sections"); if (!host) return;
    if (!S.tree) { host.innerHTML = '<div class="rrnb-empty">No notebook selected.</div>'; return; }
    var groups = S.tree.groups || [], sections = S.tree.sections || [];
    var liveGroups = {}; groups.forEach(function (g) { liveGroups[g.id] = 1; });
    // a section whose group was deleted renders as ungrouped, not invisible
    var byGroup = {}; sections.forEach(function (s) { var g = (s.group_id && liveGroups[s.group_id]) ? s.group_id : "_"; (byGroup[g] = byGroup[g] || []).push(s); });
    var html = "";
    if (!S.readOnly) html += '<button class="rrnb-newpage rrnb-addtop" data-add-section="1">＋ Add section</button>';
    function secRow(s) {
      var on = s.id === S.activeSection ? " active" : "";
      return '<div class="rrnb-section' + on + '" data-sec="' + s.id + '"><span class="bar" style="background:' + esc(s.color) + '"></span>' +
        '<span class="nm">' + esc(s.name) + '</span>' +
        '<button class="rrnb-iconbtn kebab" data-menu="section" data-id="' + s.id + '" title="Section options">⋯</button></div>';
    }
    (byGroup._ || []).forEach(function (s) { html += secRow(s); });
    groups.forEach(function (g) {
      var col = S.collapsedGroups[g.id] ? " collapsed" : "";
      html += '<div class="rrnb-group' + col + '" data-grp="' + g.id + '"><div class="rrnb-group-hd" data-toggle="' + g.id + '">' +
        '<span class="tw">▾</span><span class="gnm">' + esc(g.name) + '</span></div>' +
        (byGroup[g.id] || []).map(secRow).join("") + '</div>';
    });
    host.innerHTML = html;
  }

  // ── page list ────────────────────────────────────────────────────
  function renderPageList() {
    if (S._inlineEditing) return; // don't wipe an in-progress inline rename
    var host = $id("rrnb-pagelist"); if (!host) return;
    if (S.mode === "search") return; // search owns the list
    if (S.mode === "recycle") return renderRecycle(host);
    if (S.mode === "recent") return renderRecent();
    if (!S.tree || !S.activeSection) { host.innerHTML = '<div class="rrnb-empty">Pick a section to see its pages.</div>'; return; }
    var pages = S.tree.pages.filter(function (p) { return p.section_id === S.activeSection; });
    // build tree order: top pages by position, children after their parent
    var tops = pages.filter(function (p) { return !p.parent_page_id; }).sort(function (a, b) { return a.position - b.position; });
    var kids = {}; pages.forEach(function (p) { if (p.parent_page_id) (kids[p.parent_page_id] = kids[p.parent_page_id] || []).push(p); });
    Object.keys(kids).forEach(function (k) { kids[k].sort(function (a, b) { return a.position - b.position; }); });
    var pinned = pages.filter(function (p) { return p.is_pinned; }).sort(function (a, b) { return a.position - b.position; });
    var html = "";
    if (!S.readOnly) html += '<div class="rrnb-pageadd rrnb-pageadd-top"><button class="rrnb-newpage rrnb-addtop" data-add-page="1">＋ Add page  <span style="margin-left:auto;color:var(--text-disabled)">Alt+N</span></button>' +
      '<button class="rrnb-newpage rrnb-tpl-btn" data-template-menu="1" title="New page from a template">▤</button></div>';
    if (pinned.length) { html += '<div class="rrnb-plgroup-hd">Pinned</div>' + pinned.map(function (p) { return pageRow(p, true); }).join(""); html += '<div class="rrnb-plgroup-hd">Pages</div>'; }
    function walk(p) { html += pageRow(p, false); (kids[p.id] || []).forEach(walk); }
    tops.forEach(walk);
    host.innerHTML = html;
  }
  function pageRow(p, pinnedCtx) {
    var on = p.id === S.pageId ? " active" : "";
    var lvl = pinnedCtx ? "" : (p.level === 1 ? " lvl1" : p.level >= 2 ? " lvl2" : "");
    var pin = p.is_pinned ? " pinned" : "";
    return '<div class="rrnb-page' + on + lvl + pin + '" data-page="' + p.id + '" draggable="true">' +
      '<div class="body"><div class="ttl">' + esc(p.title || "Untitled Page") + '</div>' +
      '<div class="sub">' + pageRowSub(p) + '</div></div>' +
      '<span class="pin" title="Pinned">★</span>' +
      '<button class="rrnb-iconbtn kebab" data-menu="page" data-id="' + p.id + '" title="Page options">⋯</button></div>';
  }
  function pageRowSub(p) {
    return esc(relTime(p.updated_at)) + (p.tags && p.tags.length ? '  ·  ' + p.tags.map(esc).join(", ") : "");
  }
  // Patch just one page's row in place (title + meta) instead of rebuilding the
  // whole list. Returns false when the row isn't in the current view so the
  // caller can fall back to a full render. This is what keeps autosave from
  // re-rendering the entire page list on every keystroke-batch.
  function patchPageRow(pid) {
    if (S.mode !== "notebook") return true;            // list isn't showing pages — nothing to patch
    var host = $id("rrnb-pagelist"); if (!host) return true;
    var row = host.querySelector('.rrnb-page[data-page="' + pid + '"]'); if (!row) return false;
    var p = pageById(pid); if (!p) return false;
    var ttl = row.querySelector(".ttl"); if (ttl && ttl.textContent !== (p.title || "Untitled Page")) ttl.textContent = p.title || "Untitled Page";
    var sub = row.querySelector(".sub"); if (sub) sub.innerHTML = pageRowSub(p);
    return true;
  }

  function renderRecycle(host) {
    S.be.recycleList(S.nbId).then(function (rows) {
      var html = '<div class="rrnb-plgroup-hd">Recycle Bin</div>';
      if (!rows || !rows.length) html += '<div class="rrnb-empty">Nothing deleted. Deleted pages are kept here so you can restore them.</div>';
      html += (rows || []).map(function (r) {
        return '<div class="rrnb-page" data-restore="' + r.id + '"><div class="body"><div class="ttl">' + esc(r.title) + '</div>' +
          '<div class="sub">deleted ' + esc(relTime(r.deleted_at)) + '</div></div>' +
          '<button class="rrnb-iconbtn kebab" data-restore-btn="' + r.id + '" title="Restore" style="opacity:1">↺</button></div>';
      }).join("");
      html += '<button class="rrnb-newpage" data-exit-recycle="1">‹ Back to pages</button>';
      host.innerHTML = html;
    }).catch(fail);
  }

  // ══════════════════════════════════════════════════════════════════
  //  EDITOR / CANVAS
  // ══════════════════════════════════════════════════════════════════
  function showBlank() {
    var wrap = $id("rrnb-canvas-wrap"); if (!wrap) return;
    wrap.innerHTML = '<div class="rrnb-blank"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/></svg><div>Select a page, or press <b>Alt+N</b> to create one.</div></div>';
    if (S._tt) { S._tt.destroy(); S._tt = null; }
    S.editorKind = "classic";
    S.pageId = null; S.page = null;
    resetContextRail();
    leavePresence();
  }

  var TOOLBAR_HTML =
    '<div class="rrnb-toolbar" id="rrnb-toolbar">' +
      '<button class="rrnb-tb" data-cmd="undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="redo" title="Redo (Ctrl+Y)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<select class="rrnb-tb-sel" id="rrnb-style-sel" title="Paragraph style">' +
        '<option value="P">Normal</option><option value="H1">Heading 1</option><option value="H2">Heading 2</option><option value="H3">Heading 3</option></select>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
      '<button class="rrnb-tb" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
      '<button class="rrnb-tb" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
      '<button class="rrnb-tb" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>' +
      '<button class="rrnb-tb" data-cmd="highlight" title="Highlight (Ctrl+Shift+H)"><span style="background:var(--amber-soft,rgba(217,119,6,.3));padding:0 3px;border-radius:2px">H</span></button>' +
      '<button class="rrnb-tb" data-cmd="insertUnorderedList" title="Bulleted list (Ctrl+.)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h11M9 12h11M9 18h11"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="insertOrderedList" title="Numbered list (Ctrl+/)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6h11M9 12h11M9 18h11"/><text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg></button>' +
      '<button class="rrnb-tb" data-cmd="quote" title="Quote">“</button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="todo" title="To-do checkbox (Ctrl+1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="table" title="Insert table"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="image" title="Insert picture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5-5-6 6-3-3-4 4"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="attach" title="Attach a file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.6 1.6 0 0 1-2.3-2.3l8.3-8.3"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="link" title="Link (Ctrl+K)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="callout" title="Callout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 15V4h13l-2 3 2 3H4"/><path d="M4 21v-6"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="code" title="Code block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="hr" title="Divider">—</button>' +
      '<button class="rrnb-tb" data-cmd="pagelink" title="Link to a page">[[ ]]</button>' +
      '<button class="rrnb-tb" data-cmd="smartlink" title="Auto-link objects (drivers, Van 27, Route 341)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="dictate" title="Dictate — voice to text" hidden><span class="rrnb-recdot" hidden></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5M8.5 21.5h7"/></svg></button>' +
      '<button class="rrnb-tb rrnb-tb-ai" data-cmd="ai" title="AI: summarize, rewrite, extract action items…"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5 10.1 11 5.5 9l4.6-1.4L12 3z"/><path d="M18 15l.8 2 2 .8-2 .8L18 21l-.8-2-2-.8 2-.8.8-2z"/></svg><span style="margin-left:5px;font-weight:600">AI</span></button>' +
      '<button class="rrnb-tb" data-cmd="removeFormat" title="Clear formatting"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 5h13M9 5l-2 14M5 19h6"/><path d="M15 12l6 6M21 12l-6 6"/></svg></button>' +
    '</div>';

  function openPage(id) {
    // flush any pending save of the previous page first
    flushSave();
    if (_dict) toggleDictation();
    S.be.getPage(id).then(function (p) {
      if (!p) { showBlank(); return; }
      S.pageId = id; S.page = p; S.mode = "notebook"; S.savedAt = p.updated_at;
      S.baseUpdatedAt = p.updated_at;
      trackRecent(p);
      if (S._inlineEditing) { renderPageList(); return; } // a live inline rename owns the DOM — don't rebuild over it
      renderCanvas(p);
      renderPageList();
      joinPresence(id);
      var sh = $id("rrnb-shell"); if (sh) sh.classList.remove("show-rail", "show-pages");
      var mt = $id("rrnb-mb-title"); if (mt) mt.textContent = p.title || "";
    }).catch(fail);
  }

  // Per-DSP opt-in for the TipTap/ProseMirror editor. Off by default; a DSP
  // turns it on via dsp.metadata.notebook_editor='tiptap' (or metadata.flags.
  // notebook_tiptap), and an individual can force classic/tiptap in this
  // browser via localStorage 'rrnb-editor' for testing.
  function tiptapEnabled() {
    try { var o = localStorage.getItem("rrnb-editor"); if (o === "tiptap") return true; if (o === "classic") return false; } catch (e) {}
    var md = window.RR && window.RR.dsp && window.RR.dsp.metadata;
    return !!(md && (md.notebook_editor === "tiptap" || (md.flags && md.flags.notebook_tiptap)));
  }
  // Dispatcher: the TipTap path is entirely separate so the proven classic
  // editor below stays untouched. Always tear down any live TipTap instance
  // first so switching pages / editors never leaks a ProseMirror view.
  function renderCanvas(p) {
    if (S._tt) { S._tt.destroy(); S._tt = null; }
    if (tiptapEnabled() && window.RRTipTap) { S.editorKind = "tiptap"; return renderCanvasTipTap(p); }
    S.editorKind = "classic";
    return renderCanvasClassic(p);
  }
  function renderCanvasClassic(p) {
    var wrap = $id("rrnb-canvas-wrap"); if (!wrap) return;
    hideImgResize();
    // our own grips replace Firefox's native contenteditable image resizers
    try { document.execCommand("enableObjectResizing", false, "false"); } catch (e) {}
    var nb = (S.notebooks.filter(function (n) { return n.id === S.nbId; })[0]) || {};
    var sec = ((S.tree && S.tree.sections) || []).filter(function (s) { return s.id === p.section_id; })[0] || {};
    wrap.innerHTML =
      TOOLBAR_HTML +
      '<div class="rrnb-doc">' +
        '<div class="rrnb-breadcrumb"><span class="rrnb-cr-nb">' + esc(nb.name || "Notebook") + '</span> <span class="sep">›</span> <span class="rrnb-cr-sec">' + esc(sec.name || "Section") + '</span> <span class="sep">›</span> <span class="rrnb-cr-pg">' + esc(p.title || "Page") + '</span></div>' +
        '<input class="rrnb-title" id="rrnb-title" placeholder="Untitled Page" value="' + esc(p.title || "") + '" />' +
        '<div class="rrnb-pdate" id="rrnb-pdate">' + esc(pageDateLine(p)) + '</div>' +
        '<div class="rrnb-metaline"><span class="rrnb-save" id="rrnb-save"><span class="dot"></span><span id="rrnb-save-txt">Saved</span></span>' +
          '<span id="rrnb-author">' + esc(p.author || "") + '</span>' +
          '<span class="rrnb-presence" id="rrnb-presence" hidden><span class="pdot"></span><span id="rrnb-presence-txt"></span></span>' +
          '<button class="rrnb-metabtn" id="rrnb-history-btn" type="button" title="Page version history">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>History</button>' +
          '<button class="rrnb-metabtn" id="rrnb-ctx-toggle" type="button" title="Toggle the context panel (linked records, outline, backlinks)">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>Context</button></div>' +
        '<div class="rrnb-editor" id="rrnb-editor" contenteditable="true" spellcheck="true" data-ph="Type anywhere. Everything autosaves.">' + (p.content_html || "") + '</div>' +
        '<div class="rrnb-tagbar" id="rrnb-tagbar"></div>' +
      '</div>';
    var ed = $id("rrnb-editor"), title = $id("rrnb-title");
    autoGrow(title);
    title.addEventListener("input", function () { autoGrow(title); scheduleSave(); updateBreadcrumbTitle(); });
    title.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); ed.focus(); } });
    // Keep the host app's single-key global shortcuts (e.g. "c" opens a coaching
    // log) from firing while you type here — let real chords (Ctrl/Meta/Alt) and
    // Escape through so our own + the app's modified shortcuts still work.
    var stopTypingLeak = function (e) { if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key !== "Escape") e.stopPropagation(); };
    ed.addEventListener("keydown", stopTypingLeak);
    ed.addEventListener("keyup", stopTypingLeak);
    ed.addEventListener("keypress", stopTypingLeak);
    title.addEventListener("keydown", stopTypingLeak);
    title.addEventListener("keyup", stopTypingLeak);
    title.addEventListener("keypress", stopTypingLeak);
    ed.addEventListener("input", function () { slashScan(); scheduleSave(); autoLinkify(); positionImgResize(); scheduleCtxRefresh(); });
    ed.addEventListener("keydown", onEditorKey);
    ed.addEventListener("click", onEditorClick);
    ed.addEventListener("contextmenu", onEditorCtx);
    var hb = $id("rrnb-history-btn"); if (hb) hb.addEventListener("click", openHistory);
    var ctb = $id("rrnb-ctx-toggle"); if (ctb) ctb.addEventListener("click", function () { ctxToggle(); });
    var dictBtn = $id("rrnb-toolbar") && $id("rrnb-toolbar").querySelector('[data-cmd="dictate"]');
    if (dictBtn && (window.SpeechRecognition || window.webkitSpeechRecognition)) dictBtn.hidden = false;
    ed.addEventListener("keyup", refreshToolbarState);
    ed.addEventListener("mouseup", refreshToolbarState);
    ed.addEventListener("paste", onEditorPaste);
    ed.addEventListener("dragover", function (e) { if (DH.dragging) { dhDragOver(e); return; } e.preventDefault(); ed.classList.add("rrnb-drop"); });
    ed.addEventListener("dragleave", function () { ed.classList.remove("rrnb-drop"); });
    ed.addEventListener("drop", function (e) { if (DH.dragging) { dhDrop(e); return; } onEditorDrop(e); });
    ed.addEventListener("mousemove", dhMouseMove);
    ed.addEventListener("mousemove", cpMouseMove);
    ed.addEventListener("mouseleave", function () { hideHandle(); cpHide(); });
    bindToolbar();
    makeCaptionsEditable();
    if (S.readOnly || p.my_role === "viewer") applyReadOnly();
    hydrateMedia(ed);
    renderTags(p.tags || []);
    renderContextRail(p);
    refreshSaveLabel();
  }
  function id_of(p) { return p.id || S.pageId; }
  // Soft "Monday, February 2, 2026 · 8:31 AM · Author" line under the title —
  // the calm OneNote-style dateline. Best-effort locale formatting.
  function pageDateLine(p) {
    var d = (p && (p.updated_at || p.created_at)) || null; if (!d) return "";
    try {
      var dt = new Date(d);
      var s = dt.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }) +
              " · " + dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      if (p.author) s += " · " + p.author;
      return s;
    } catch (e) { return ""; }
  }

  // ══════════════════════════════════════════════════════════════════
  //  TIPTAP EDITOR (opt-in, flag-gated) — a separate, self-contained
  //  render path. Shares the title, metaline, tag bar, context rail and
  //  the exact save/conflict/offline contract with the classic editor
  //  (via currentEditorData's tiptap branch). Advanced classic-only
  //  features (image annotation/OCR/resize, [[ page picker, ⚡ object
  //  linking, attachments, dictation, AI) are not yet wired here — the
  //  curated toolbar only exposes what actually works, so there are no
  //  dead buttons. Falls back to the classic editor if TipTap can't load.
  // ══════════════════════════════════════════════════════════════════
  var TT_TOOLBAR_HTML =
    '<div class="rrnb-toolbar" id="rrnb-toolbar">' +
      '<button class="rrnb-tb" data-ttcmd="undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>' +
      '<button class="rrnb-tb" data-ttcmd="redo" title="Redo (Ctrl+Y)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<select class="rrnb-tb-sel" id="rrnb-style-sel" title="Paragraph style">' +
        '<option value="P">Normal</option><option value="H1">Heading 1</option><option value="H2">Heading 2</option><option value="H3">Heading 3</option></select>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-ttcmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
      '<button class="rrnb-tb" data-ttcmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
      '<button class="rrnb-tb" data-ttcmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
      '<button class="rrnb-tb" data-ttcmd="strikeThrough" title="Strikethrough"><s>S</s></button>' +
      '<button class="rrnb-tb" data-ttcmd="highlight" title="Highlight"><span style="background:var(--amber-soft,rgba(217,119,6,.3));padding:0 3px;border-radius:2px">H</span></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-ttcmd="todo" title="To-do checklist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg></button>' +
      '<button class="rrnb-tb" data-ttcmd="insertUnorderedList" title="Bulleted list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h11M9 12h11M9 18h11"/></svg></button>' +
      '<button class="rrnb-tb" data-ttcmd="insertOrderedList" title="Numbered list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6h11M9 12h11M9 18h11"/><text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-ttcmd="quote" title="Quote">“</button>' +
      '<button class="rrnb-tb" data-ttcmd="code" title="Code block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg></button>' +
      '<button class="rrnb-tb" data-ttcmd="hr" title="Divider">—</button>' +
      '<button class="rrnb-tb" data-ttcmd="table" title="Insert table"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></svg></button>' +
      '<button class="rrnb-tb" data-ttcmd="image" title="Insert picture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5-5-6 6-3-3-4 4"/></svg></button>' +
      '<button class="rrnb-tb" data-ttcmd="link" title="Link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-ttcmd="removeFormat" title="Clear formatting"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 5h13M9 5l-2 14M5 19h6"/><path d="M15 12l6 6M21 12l-6 6"/></svg></button>' +
    '</div>';

  function renderCanvasTipTap(p) {
    var wrap = $id("rrnb-canvas-wrap"); if (!wrap) return;
    var nb = (S.notebooks.filter(function (n) { return n.id === S.nbId; })[0]) || {};
    var sec = ((S.tree && S.tree.sections) || []).filter(function (s) { return s.id === p.section_id; })[0] || {};
    var ro = S.readOnly || p.my_role === "viewer";
    wrap.innerHTML =
      (ro ? '' : TT_TOOLBAR_HTML) +
      '<div class="rrnb-doc">' +
        '<div class="rrnb-breadcrumb"><span class="rrnb-cr-nb">' + esc(nb.name || "Notebook") + '</span> <span class="sep">›</span> <span class="rrnb-cr-sec">' + esc(sec.name || "Section") + '</span> <span class="sep">›</span> <span class="rrnb-cr-pg">' + esc(p.title || "Page") + '</span></div>' +
        '<input class="rrnb-title" id="rrnb-title" placeholder="Untitled Page" value="' + esc(p.title || "") + '" />' +
        '<div class="rrnb-pdate" id="rrnb-pdate">' + esc(pageDateLine(p)) + '</div>' +
        '<div class="rrnb-metaline"><span class="rrnb-save" id="rrnb-save"><span class="dot"></span><span id="rrnb-save-txt">Saved</span></span>' +
          '<span id="rrnb-author">' + esc(p.author || "") + '</span>' +
          '<span class="rrnb-tag rrnb-beta" title="You’re on the new rich editor (beta). Switch back anytime in settings.">Beta editor</span>' +
          '<span class="rrnb-presence" id="rrnb-presence" hidden><span class="pdot"></span><span id="rrnb-presence-txt"></span></span>' +
          '<button class="rrnb-metabtn" id="rrnb-history-btn" type="button" title="Page version history">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>History</button>' +
          '<button class="rrnb-metabtn" id="rrnb-ctx-toggle" type="button" title="Toggle the context panel">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>Context</button></div>' +
        '<div class="rrnb-editor rrnb-tt" id="rrnb-editor"><div class="rrnb-tt-loading">Loading the rich editor…</div></div>' +
        '<div class="rrnb-tagbar" id="rrnb-tagbar"></div>' +
      '</div>';
    var title = $id("rrnb-title");
    autoGrow(title);
    title.addEventListener("input", function () { autoGrow(title); scheduleSave(); updateBreadcrumbTitle(); });
    var stopLeak = function (e) { if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key !== "Escape") e.stopPropagation(); };
    title.addEventListener("keydown", function (e) { stopLeak(e); if (e.key === "Enter") { e.preventDefault(); if (S._tt) S._tt.focus(); } });
    title.addEventListener("keyup", stopLeak); title.addEventListener("keypress", stopLeak);
    var hb = $id("rrnb-history-btn"); if (hb) hb.addEventListener("click", openHistory);
    var ctb = $id("rrnb-ctx-toggle"); if (ctb) ctb.addEventListener("click", function () { ctxToggle(); });
    if (ro) applyReadOnly();
    var mountEl = $id("rrnb-editor");
    window.RRTipTap.mount(mountEl, {
      content: p.content_html || "", readOnly: ro,
      placeholder: "Type here. Everything autosaves.",
      onUpdate: function () { scheduleSave(); scheduleCtxRefresh(); }
    }).then(function (api) {
      if (S.pageId !== id_of(p)) { api.destroy(); return; }   // page switched mid-load
      S._tt = api; S.editorKind = "tiptap";
      var mnt = $id("rrnb-editor"); if (mnt) { var ld = mnt.querySelector(".rrnb-tt-loading"); if (ld) ld.remove(); }
      var pm = mnt && mnt.querySelector(".ProseMirror");
      if (pm) { pm.addEventListener("keydown", stopLeak); pm.addEventListener("keyup", ttToolbarState); pm.addEventListener("mouseup", ttToolbarState); }
      bindTTToolbar();
    }).catch(function (e) {
      // CDN unreachable → don't strand the user; fall back to the proven editor.
      console.warn("TipTap load failed, using classic editor:", e);
      S.editorKind = "classic"; renderCanvasClassic(p);
    });
    renderTags(p.tags || []);
    renderContextRail(p);
    refreshSaveLabel();
  }
  function bindTTToolbar() {
    var tb = $id("rrnb-toolbar"); if (!tb) return;
    tb.addEventListener("mousedown", function (e) { if (e.target.closest("[data-ttcmd]")) e.preventDefault(); });
    tb.addEventListener("click", function (e) {
      var b = e.target.closest("[data-ttcmd]"); if (!b || !S._tt) return;
      var cmd = b.getAttribute("data-ttcmd");
      if (cmd === "link") { var u = window.prompt("Link URL"); if (u == null) return; S._tt.cmd("link", u.trim() || null); }
      else if (cmd === "image") { ttPickImage(); }
      else { S._tt.cmd(cmd); }
      ttToolbarState();
    });
    var sel = $id("rrnb-style-sel");
    if (sel) sel.addEventListener("change", function () { if (S._tt) { S._tt.cmd("block", sel.value); ttToolbarState(); } });
    ttToolbarState();
  }
  function ttToolbarState() {
    var tb = $id("rrnb-toolbar"); if (!tb || !S._tt) return;
    [["bold", "bold"], ["italic", "italic"], ["underline", "underline"], ["strikeThrough", "strike"],
     ["highlight", "highlight"], ["todo", "taskList"], ["insertUnorderedList", "bulletList"],
     ["insertOrderedList", "orderedList"], ["quote", "blockquote"], ["code", "codeBlock"]].forEach(function (m) {
      var btn = tb.querySelector('[data-ttcmd="' + m[0] + '"]'); if (btn) btn.classList.toggle("on", S._tt.isActive(m[1]));
    });
    var sel = $id("rrnb-style-sel"); if (sel) sel.value = S._tt.activeBlock();
  }
  function ttPickImage() {
    var inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f || !S._tt) return;
      compressImage(f, function (dataUrl) { S._tt.cmd("image", dataUrl); scheduleSave(); });
    };
    inp.click();
  }
  // viewer role: the page renders normally but nothing is editable
  function applyReadOnly() {
    S.readOnly = true;
    var ed = $id("rrnb-editor"), title = $id("rrnb-title"), tb = $id("rrnb-toolbar");
    if (ed) {
      ed.setAttribute("contenteditable", "false");
      ed.querySelectorAll("figcaption[contenteditable]").forEach(function (c) { c.setAttribute("contenteditable", "false"); });
    }
    if (title) title.readOnly = true;
    if (tb) tb.hidden = true;
    var at = $id("rrnb-addtag"); if (at) at.hidden = true;
    var sv = $id("rrnb-save"); if (sv) sv.hidden = true;
    var ml = $(".rrnb-metaline");
    if (ml && !$id("rrnb-viewonly")) {
      var s = document.createElement("span"); s.id = "rrnb-viewonly"; s.className = "rrnb-tag";
      s.title = "You have view-only access to this notebook";
      s.textContent = "View only";
      ml.insertBefore(s, ml.firstChild);
    }
  }
  function autoGrow(el) { if (!el) return; el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  function updateBreadcrumbTitle() { var el = $(".rrnb-cr-pg"); var t = $id("rrnb-title"); if (el && t) el.textContent = t.value || "Page"; }

  // ── toolbar behaviour ────────────────────────────────────────────
  function bindToolbar() {
    var tb = $id("rrnb-toolbar"); if (!tb) return;
    tb.addEventListener("mousedown", function (e) { if (e.target.closest("[data-cmd]")) e.preventDefault(); }); // keep selection
    tb.addEventListener("click", function (e) { var b = e.target.closest("[data-cmd]"); if (!b) return; doCommand(b.getAttribute("data-cmd")); });
    var sel = $id("rrnb-style-sel");
    if (sel) sel.addEventListener("change", function () { applyBlock(sel.value); $id("rrnb-editor").focus(); });
  }
  function exec(cmd, val) { try { document.execCommand(cmd, false, val); } catch (e) {} }
  function applyBlock(tag) {
    var t = tag === "P" ? "P" : tag;
    exec("formatBlock", (document.queryCommandSupported && /^H\d$/.test(t)) ? t : "<" + t.toLowerCase() + ">");
    scheduleSave();
  }
  function doCommand(cmd) {
    var ed = $id("rrnb-editor"); if (ed) ed.focus();
    switch (cmd) {
      case "bold": case "italic": case "underline": case "strikeThrough":
      case "insertUnorderedList": case "insertOrderedList": case "undo": case "redo":
      case "removeFormat": exec(cmd); break;
      case "highlight": exec("hiliteColor", "#fde68a"); break;
      case "quote": exec("formatBlock", "<blockquote>"); break;
      case "hr": exec("insertHorizontalRule"); break;
      case "code": insertCodeBlock(); break;
      case "callout": insertCallout(); break;
      case "todo": insertTodo(); break;
      case "table": openTablePicker(); break;
      case "image": pickFile("image/*", true); break;
      case "attach": pickFile("*/*", false); break;
      case "link": openLinkPicker(); break;
      case "pagelink": openPagePicker(); break;
      case "smartlink": smartLink(true); break;
      case "dictate": toggleDictation(); break;
      case "ai": openAiMenu(); break;
    }
    scheduleSave(); refreshToolbarState();
  }
  function refreshToolbarState() {
    var tb = $id("rrnb-toolbar"); if (!tb) return;
    [["bold","bold"],["italic","italic"],["underline","underline"],["strikeThrough","strikeThrough"]].forEach(function (m) {
      var btn = tb.querySelector('[data-cmd="' + m[0] + '"]'); if (!btn) return;
      var on = false; try { on = document.queryCommandState(m[1]); } catch (e) {}
      btn.classList.toggle("on", !!on);
    });
    var sel = $id("rrnb-style-sel");
    if (sel) { var blk = "P"; try { var b = (document.queryCommandValue("formatBlock") || "").toUpperCase(); if (/^H[1-3]$/.test(b)) blk = b; } catch (e) {} sel.value = blk; }
  }
  function insertHTMLAtCursor(html) {
    var ed = $id("rrnb-editor"); ed.focus();
    try { document.execCommand("insertHTML", false, html); }
    catch (e) { ed.insertAdjacentHTML("beforeend", html); }
  }
  // ── to-do rows: OneNote-style behavior ───────────────────────────
  // Ctrl+1 / toolbar inserts a row with the caret IN it (or toggles the
  // current row back to a paragraph); Enter continues the checklist; Enter
  // on an empty row (or Backspace at the start of one) dissolves it.
  function closestTodo(node) {
    while (node && node.nodeType === 3) node = node.parentNode;
    return node && node.closest ? node.closest(".rrnb-todo") : null;
  }
  function caretToEl(el, atStart) {
    if (!el) return;
    var r = document.createRange(); r.selectNodeContents(el); r.collapse(!!atStart);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function caretAtStartOf(el, sel) {
    if (!el || !sel || !sel.rangeCount || !sel.isCollapsed) return false;
    var r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return false;
    var pre = document.createRange(); pre.selectNodeContents(el);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return false; }
    return pre.toString().replace(/​/g, "").length === 0;
  }
  function makeTodo(text) {
    var row = document.createElement("div"); row.className = "rrnb-todo"; row.setAttribute("data-checked", "0");
    var box = document.createElement("span"); box.className = "rrnb-todo-box"; box.setAttribute("contenteditable", "false");
    var txt = document.createElement("span"); txt.className = "rrnb-todo-text";
    if (text) txt.textContent = text; else txt.appendChild(document.createElement("br"));
    row.appendChild(box); row.appendChild(txt);
    return row;
  }
  function todoToParagraph(todo, caretAtEnd) {
    var p = document.createElement("p");
    var t = todo.querySelector(".rrnb-todo-text");
    while (t && t.firstChild) p.appendChild(t.firstChild);
    if (!p.firstChild) p.appendChild(document.createElement("br"));
    todo.parentNode.replaceChild(p, todo);
    caretToEl(p, !caretAtEnd);
  }
  function blockOf(node, ed) {
    while (node && node !== ed) {
      if (node.nodeType === 1 && /^(P|DIV|H1|H2|H3|LI|BLOCKQUOTE|PRE|FIGURE|TABLE)$/.test(node.tagName)) return node;
      node = node.parentNode;
    }
    return null;
  }
  function insertTodo() {
    var ed = $id("rrnb-editor"); if (!ed) return; ed.focus();
    var sel = window.getSelection();
    var cur = sel && sel.anchorNode ? closestTodo(sel.anchorNode) : null;
    if (cur && ed.contains(cur)) { todoToParagraph(cur, true); scheduleSave(); return; }
    var text = sel && sel.rangeCount && !sel.isCollapsed ? sel.toString() : "";
    if (text && sel.rangeCount) sel.getRangeAt(0).deleteContents();
    var row = makeTodo(text);
    var blk = sel && sel.anchorNode ? blockOf(sel.anchorNode, ed) : null;
    if (blk && blk.parentNode) {
      var empty = /^(P|DIV)$/.test(blk.tagName) && !blk.textContent.replace(/​/g, "").trim() && !blk.querySelector("img,figure,table");
      if (empty) blk.parentNode.replaceChild(row, blk);
      else blk.parentNode.insertBefore(row, blk.nextSibling);
    } else if (sel && sel.rangeCount) sel.getRangeAt(0).insertNode(row);
    else ed.appendChild(row);
    caretToEl(row.querySelector(".rrnb-todo-text"), !text);
    scheduleSave();
  }
  // Enter / Backspace inside a to-do row. Returns true when handled.
  function todoKeydown(e) {
    var ed = $id("rrnb-editor"); if (!ed) return false;
    var sel = window.getSelection();
    var todo = sel && sel.anchorNode ? closestTodo(sel.anchorNode) : null;
    if (!todo || !ed.contains(todo)) return false;
    var txtEl = todo.querySelector(".rrnb-todo-text");
    var content = (txtEl && txtEl.textContent || "").replace(/​/g, "");
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!content.trim()) { todoToParagraph(todo, false); scheduleSave(); return true; }
      var after = "";
      try {
        var r = sel.getRangeAt(0).cloneRange();
        r.setEnd(txtEl, txtEl.childNodes.length);
        after = r.toString();
        r.deleteContents();
      } catch (err) {}
      var row = makeTodo(after);
      todo.parentNode.insertBefore(row, todo.nextSibling);
      caretToEl(row.querySelector(".rrnb-todo-text"), true);
      scheduleSave();
      return true;
    }
    if (e.key === "Backspace" && caretAtStartOf(txtEl, sel)) {
      e.preventDefault();
      todoToParagraph(todo, false);
      scheduleSave();
      return true;
    }
    return false;
  }
  function insertCodeBlock() { insertHTMLAtCursor('<pre><code>' + (esc(window.getSelection().toString()) || "​") + '</code></pre><p><br></p>'); }
  function insertCallout() { insertHTMLAtCursor('<div class="rrnb-callout"><span class="ico">💡</span><div>' + (esc(window.getSelection().toString()) || "Note…") + '</div></div><p><br></p>'); }

  function onEditorClick(e) {
    var box = e.target.closest(".rrnb-todo-box");
    if (box) { var row = box.closest(".rrnb-todo"); row.setAttribute("data-checked", row.getAttribute("data-checked") === "1" ? "0" : "1"); box.textContent = row.getAttribute("data-checked") === "1" ? "✓" : ""; scheduleSave(); return; }
    var img = e.target.closest("img");
    var ed = $id("rrnb-editor");
    if (ed) ed.querySelectorAll("figure.rrnb-fig.sel, img.sel").forEach(function (f) { f.classList.remove("sel"); });
    hideImgResize();
    if (img) { var fig = img.closest("figure.rrnb-fig") || img; fig.classList.add("sel"); showImgResize(fig, img); openImageSize(fig, img); return; }
    var fl = e.target.closest("a.rrnb-file");
    if (fl) {
      var mp = fl.getAttribute("data-media-path");
      if (mp) { // stored file: the saved href expires — sign a fresh URL now
        e.preventDefault();
        mediaSign([mp], function (map) {
          if (!map[mp]) { notify("Couldn't fetch that file — are you online?"); return; }
          var a = document.createElement("a");
          a.href = map[mp]; a.download = fl.getAttribute("download") || "file";
          document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 200);
        });
      }
      return; // inline (base64) chips download natively
    }
    // Plain web link (http/mailto/tel) — contenteditable swallows navigation,
    // so open it ourselves. Excludes the app's page/record/file chips.
    var wl = e.target.closest("a[href]");
    if (wl && e.type === "click" && !wl.matches(".rrnb-pagelink,.rrnb-objlink,.rrnb-file")) {
      var wh = wl.getAttribute("href") || "";
      if (/^(https?:|mailto:|tel:)/i.test(wh)) { e.preventDefault(); window.open(wh, "_blank", "noopener"); return; }
    }
    var pl = e.target.closest("a.rrnb-pagelink");
    if (pl && (e.ctrlKey || e.metaKey || e.type === "click")) { var pid = pl.getAttribute("data-page-id"); if (pid) { e.preventDefault(); openPage(pid); } return; }
    var ol = e.target.closest("a.rrnb-objlink");
    if (ol) {
      e.preventDefault(); e.stopPropagation();
      var oi = ol.getAttribute("data-obj-id");
      if (ol.getAttribute("data-obj-unresolved") || !oi) { openObjResolver(ol); return; }  // never navigate to a fabricated id
      openObjectRef(ol.getAttribute("data-obj-type"), oi, ol.getAttribute("data-obj-name") || ol.textContent || "record");
    }
  }
  // Deep-link a linked record to its ACTUAL record view (driver / vehicle /
  // applicant drawer) rather than the per-entity notebook. Entity types with no
  // dedicated drawer (route / station / shift / incident) fall back to opening
  // their object notebook, which is still the right home for their notes.
  function openObjectRef(type, id, name) {
    try {
      if (type === "driver" && typeof window.openDriverDrawer === "function") { window.openDriverDrawer(id); return; }
      if (type === "vehicle" && typeof window.openFleetDrawer === "function") { window.openFleetDrawer(id); return; }
      if (type === "applicant" && typeof window.openApplicant === "function") { window.openApplicant(id); return; }
      if (window.RRNotebooks && window.RRNotebooks.openFor) window.RRNotebooks.openFor(type, id, name || null);
    } catch (e) { notify("Couldn’t open that record: " + ((e && e.message) || e)); }
  }

  // ══════════════════════════════════════════════════════════════════
  //  MEDIA — images (paste / drop / pick, client-side compressed) + files
  // ══════════════════════════════════════════════════════════════════
  var MAX_IMG_DIM = 1600, MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB inline (base64) fallback cap
  var MEDIA_BUCKET = "notebook-media", MAX_STORE_BYTES = 25 * 1024 * 1024; // storage path cap (migration 0453)

  // ── storage offload: media lives in the notebook-media bucket ─────
  // Pages store only data-media-path; render hydrates short-lived signed
  // URLs. When storage isn't reachable (signed-out/offline), media falls
  // back to inline base64 exactly as before.
  function storageClient() {
    var sb = (window.RR && window.RR.sb) || window.sb;
    var dsp = window.RR && window.RR.dsp && window.RR.dsp.id;
    return (S.be && S.be.kind === "supabase" && sb && sb.storage && dsp) ? { sb: sb, dsp: dsp } : null;
  }
  function safeName(n) { return (String(n || "file").replace(/[^\w.\-]+/g, "_").slice(-80)) || "file"; }
  function mediaUpload(blob, name, cb) {
    var st = storageClient(); if (!st || !blob) return cb(null);
    var path = st.dsp + "/" + (S.pageId || "page") + "/" + uid() + "-" + safeName(name);
    st.sb.storage.from(MEDIA_BUCKET)
      .upload(path, blob, { contentType: blob.type || "application/octet-stream", upsert: false })
      .then(function (r) { cb(r && !r.error ? path : null); }, function () { cb(null); });
  }
  function mediaSign(paths, cb) {
    var st = storageClient(); if (!st || !paths || !paths.length) return cb({});
    st.sb.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600).then(function (r) {
      var map = {};
      (((r && r.data) || [])).forEach(function (row) {
        var u = row && (row.signedUrl || row.signedURL);
        if (row && row.path && u) map[row.path] = u;
      });
      cb(map);
    }, function () { cb({}); });
  }
  // refresh signed URLs on stored media (srcs in saved HTML expire after 1h)
  function hydrateMedia(root) {
    if (!root || !storageClient()) return;
    var els = Array.prototype.slice.call(root.querySelectorAll("[data-media-path]"));
    if (!els.length) return;
    var paths = els.map(function (el) { return el.getAttribute("data-media-path"); });
    mediaSign(paths, function (map) {
      els.forEach(function (el) {
        var u = map[el.getAttribute("data-media-path")]; if (!u) return;
        if (el.tagName === "IMG") { if (el.src !== u) el.src = u; }
        else el.setAttribute("href", u);
      });
    });
  }
  function dataUrlToBlob(dataUrl) {
    try {
      var m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl); if (!m) return null;
      var bin = atob(m[2]), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: m[1] });
    } catch (e) { return null; }
  }
  // after an image lands as base64, quietly move it to storage and slim the page
  function offloadFigure(fig, dataUrl, name) {
    var blob = dataUrlToBlob(dataUrl); if (!blob) return;
    mediaUpload(blob, name || "image", function (path) {
      if (!path || !fig || !fig.isConnected) return;
      var img = fig.querySelector("img"); if (!img) return;
      mediaSign([path], function (map) {
        if (!fig.isConnected) return;
        img.setAttribute("data-media-path", path);
        if (map[path]) img.src = map[path];
        scheduleSave();
      });
    });
  }

  function pickFile(accept, isImage) {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept; inp.style.display = "none";
    if (accept === "image/*") inp.multiple = true;
    document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      var files = Array.prototype.slice.call(inp.files || []);
      files.forEach(function (f) { isImage || /^image\//.test(f.type) ? insertImageFile(f) : insertFileAttachment(f); });
      inp.remove();
    });
    inp.click();
  }
  function insertImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return insertFileAttachment(file);
    var reader = new FileReader();
    reader.onload = function () { compressImage(reader.result, file.type, function (dataUrl) {
      var fid = "rrnb-fig-" + uid();
      insertHTMLAtCursor('<figure class="rrnb-fig" id="' + fid + '"><img src="' + dataUrl + '" alt="' + esc(file.name || "image") + '" /><figcaption></figcaption></figure><p><br></p>');
      makeCaptionsEditable(); scheduleSave();
      var fig = $id(fid);
      if (fig) { fig.removeAttribute("id"); ocrFigure(fig, dataUrl); offloadFigure(fig, dataUrl, file.name); }
    }); };
    reader.readAsDataURL(file);
  }
  function compressImage(dataUrl, type, cb) {
    try {
      var im = new Image();
      im.onload = function () {
        var w = im.naturalWidth, h = im.naturalHeight, scale = Math.min(1, MAX_IMG_DIM / Math.max(w, h));
        if (scale >= 1 && (dataUrl.length < 400000)) return cb(dataUrl); // small enough already
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(im, 0, 0, cw, ch);
        var out = /png/.test(type) ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.82);
        cb(out || dataUrl);
      };
      im.onerror = function () { cb(dataUrl); };
      im.src = dataUrl;
    } catch (e) { cb(dataUrl); }
  }
  function fileChipHTML(file, href, mediaPath) {
    var ext = ((file.name || "").split(".").pop() || "file").slice(0, 4);
    return '<a class="rrnb-file" contenteditable="false" href="' + esc(href || "#") + '"' +
      (mediaPath ? ' data-media-path="' + esc(mediaPath) + '"' : '') +
      ' download="' + esc(file.name || "file") + '">' +
      '<span class="fic">' + esc(ext) + '</span><span class="fnm"><b>' + esc(file.name || "file") + '</b><span>' +
      fmtBytes(file.size) + '</span></span></a><p><br></p>';
  }
  function insertFileAttachment(file) {
    if (!file) return;
    if (storageClient()) {
      if (file.size > MAX_STORE_BYTES) { notify('"' + (file.name || "file") + '" is over 25 MB.'); return; }
      var range = savedSelection();
      notify("Uploading " + (file.name || "file") + "…");
      mediaUpload(file, file.name, function (path) {
        if (!path) { notify("Upload failed — attaching inline instead"); return insertInlineFile(file); }
        mediaSign([path], function (map) {
          var ed = $id("rrnb-editor"); if (!ed) return;
          ed.focus();
          // the canvas may have re-rendered during the upload (realtime,
          // outbox sync) — a range into the old DOM would insert nowhere
          if (range && ed.contains(range.startContainer)) restoreSelection(range);
          else caretToEl(ed, false);
          insertHTMLAtCursor(fileChipHTML(file, map[path] || "#", path));
          scheduleSave();
        });
      });
      return;
    }
    insertInlineFile(file);
  }
  function insertInlineFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { notify('"' + (file.name || "file") + '" is over 8 MB — larger files need a signed-in session.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      insertHTMLAtCursor(fileChipHTML(file, reader.result, null));
      scheduleSave();
    };
    reader.readAsDataURL(file);
  }
  function fmtBytes(n) { if (!n && n !== 0) return ""; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(0) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
  function makeCaptionsEditable() {
    var ed = $id("rrnb-editor"); if (!ed) return;
    ed.querySelectorAll("figure.rrnb-fig figcaption").forEach(function (c) { c.setAttribute("contenteditable", "true"); });
  }
  function onEditorPaste(e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image") === 0) {
        var f = items[i].getAsFile(); if (f) { e.preventDefault(); insertImageFile(f); return; }
      }
    }
    // Let the browser drop the text in first, then linkify any pasted URL so a
    // pasted "https://…" becomes clickable right away (not after a typing pause).
    var txt = e.clipboardData && e.clipboardData.getData && e.clipboardData.getData("text/plain");
    WEB_URL_RE.lastIndex = 0;
    if (txt && WEB_URL_RE.test(txt)) setTimeout(function () { linkifyUrls(false); }, 0);
  }
  function onEditorDrop(e) {
    var ed = $id("rrnb-editor"); if (ed) ed.classList.remove("rrnb-drop");
    var files = (e.dataTransfer && e.dataTransfer.files) || [];
    if (files.length) {
      e.preventDefault();
      Array.prototype.slice.call(files).forEach(function (f) { /^image\//.test(f.type) ? insertImageFile(f) : insertFileAttachment(f); });
    }
  }
  function openImageSize(fig, img) {
    var r = img.getBoundingClientRect();
    var pop = showPop('<label>Picture</label><div class="rrnb-sizes">' +
      '<button data-imgw="25">25%</button><button data-imgw="50">50%</button><button data-imgw="75">75%</button><button data-imgw="100">100%</button></div>' +
      '<div class="rrnb-sizes"><button data-imgann="1" style="flex:1">✏ Annotate</button>' +
      '<button data-imgocr="1" style="flex:1">Copy text from picture</button></div>', r);
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("[data-imgw]");
      if (b) { img.style.width = b.getAttribute("data-imgw") + "%"; img.style.height = "auto"; hidePop(); positionImgResize(); scheduleSave(); return; }
      if (e.target.closest("[data-imgann]")) { hidePop(); hideImgResize(); openAnnotate(fig, img); return; }
      if (e.target.closest("[data-imgocr]")) {
        hidePop();
        var put = function (t) {
          if (!t) { notify(aiFn() ? "No text found in this picture" : "Picture text needs a signed-in session"); return; }
          try { navigator.clipboard.writeText(t); notify("Picture text copied"); } catch (e2) { notify(t.slice(0, 200)); }
        };
        var have = fig.getAttribute("data-ocr");
        if (have) put(have); else { notify("Reading picture…"); ocrFigure(fig, img.src, put); }
      }
    });
  }

  // ── drag-to-resize: grab any corner or border of the selected picture ──
  var RZ = { img: null, fig: null, box: null };
  function rzBox() {
    if (RZ.box) return RZ.box;
    var d = document.createElement("div");
    d.id = "rrnb-imgrz"; d.hidden = true;
    d.innerHTML = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(function (k) { return '<b data-rz="' + k + '"></b>'; }).join("");
    d.addEventListener("pointerdown", rzStart);
    document.body.appendChild(d);
    window.addEventListener("scroll", positionImgResize, true);
    window.addEventListener("resize", positionImgResize);
    RZ.box = d;
    return d;
  }
  function showImgResize(fig, img) { RZ.fig = fig; RZ.img = img; rzBox().hidden = false; positionImgResize(); }
  function hideImgResize() { RZ.fig = RZ.img = null; if (RZ.box) RZ.box.hidden = true; }
  function positionImgResize() {
    if (!RZ.box || RZ.box.hidden) return;
    if (!RZ.img || !document.body.contains(RZ.img)) { hideImgResize(); return; }
    var r = RZ.img.getBoundingClientRect();
    if (!r.width && !r.height) { hideImgResize(); return; }
    RZ.box.style.left = r.left + "px"; RZ.box.style.top = r.top + "px";
    RZ.box.style.width = r.width + "px"; RZ.box.style.height = r.height + "px";
  }
  function rzStart(e) {
    var h = e.target.closest("[data-rz]"); if (!h || !RZ.img) return;
    e.preventDefault(); e.stopPropagation(); hidePop();
    var dir = h.getAttribute("data-rz"), img = RZ.img;
    var r0 = img.getBoundingClientRect();
    // width is stored in % of the containing block so pages stay responsive
    var host = (RZ.fig && RZ.fig !== img) ? RZ.fig : (img.parentElement || img);
    var maxW = host.clientWidth || (($id("rrnb-editor") || {}).clientWidth || 0) || r0.width;
    var aspect = r0.height ? r0.width / r0.height : 1;
    var sx = e.clientX, sy = e.clientY, moved = false;
    document.documentElement.classList.add("rrnb-rz-drag");
    document.documentElement.style.cursor = getComputedStyle(h).cursor;
    try { h.setPointerCapture(e.pointerId); } catch (err) {}
    function widthAt(ev) {
      var hx = /e/.test(dir) ? ev.clientX - sx : (/w/.test(dir) ? sx - ev.clientX : 0);
      var hy = /s/.test(dir) ? ev.clientY - sy : (/n/.test(dir) ? sy - ev.clientY : 0);
      if (hx && hy) return Math.abs(hy * aspect) > Math.abs(hx) ? (r0.height + hy) * aspect : r0.width + hx; // corner: dominant axis wins
      if (hy) return (r0.height + hy) * aspect; // top/bottom edge: height drives width (aspect kept)
      return r0.width + hx;
    }
    function onMove(ev) {
      moved = true;
      var pct = Math.max(4, Math.min(100, Math.max(40, widthAt(ev)) / maxW * 100));
      img.style.width = pct.toFixed(1) + "%";
      img.style.height = "auto";
      positionImgResize();
    }
    function onUp() {
      h.removeEventListener("pointermove", onMove);
      h.removeEventListener("pointerup", onUp);
      h.removeEventListener("pointercancel", onUp);
      document.documentElement.classList.remove("rrnb-rz-drag");
      document.documentElement.style.cursor = "";
      positionImgResize();
      if (moved) scheduleSave();
    }
    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerup", onUp);
    h.addEventListener("pointercancel", onUp);
  }

  // ── ink: draw on a picture (OneNote-style annotation) ─────────────
  // Loads the image fresh (crossOrigin for stored media), lets the operator
  // draw pen strokes on a canvas, then bakes the strokes into the picture
  // and re-stores it (storage upload when signed in, base64 otherwise).
  var INK_COLORS = ["#dc2626", "#d97706", "#2563eb", "#16a34a", "#111827", "#ffffff"];
  function openAnnotate(fig, img) {
    var src = img.currentSrc || img.src; if (!src) return;
    var base = new Image();
    if (!/^data:/.test(src)) base.crossOrigin = "anonymous";
    base.onload = function () { buildInkOverlay(fig, img, base); };
    base.onerror = function () { notify("Couldn't open this picture for annotation"); };
    base.src = src;
  }
  function buildInkOverlay(fig, img, base) {
    var old = $id("rrnb-ink"); if (old) old.remove();
    var W = base.naturalWidth || base.width, H = base.naturalHeight || base.height;
    if (!W || !H) { notify("Couldn't read this picture"); return; }
    var scale = Math.min(1, MAX_IMG_DIM / Math.max(W, H)); W = Math.round(W * scale); H = Math.round(H * scale);
    var wrap = document.createElement("div"); wrap.className = "rrnb-ink"; wrap.id = "rrnb-ink";
    wrap.innerHTML = '<div class="rrnb-ink-bar">' +
      INK_COLORS.map(function (c, i) { return '<button class="sw' + (i === 0 ? " on" : "") + '" data-ink-c="' + c + '" style="background:' + c + (c === "#ffffff" ? ";border:2px solid var(--border-strong)" : "") + '" title="' + c + '"></button>'; }).join("") +
      '<span class="gap"></span>' +
      '<button class="wd on" data-ink-w="4">Thin</button><button class="wd" data-ink-w="8">Med</button><button class="wd" data-ink-w="14">Thick</button>' +
      '<span class="gap"></span>' +
      '<button class="act" data-ink-undo>Undo</button>' +
      '<button class="act" data-ink-cancel>Cancel</button>' +
      '<button class="act pri" data-ink-save>Save</button></div>';
    var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    wrap.appendChild(cv);
    document.body.appendChild(wrap);
    var ctx = cv.getContext("2d");
    var strokes = [], cur = null, color = INK_COLORS[0], width = 4;
    function redraw() {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(base, 0, 0, W, H);
      ctx.lineJoin = ctx.lineCap = "round";
      strokes.concat(cur ? [cur] : []).forEach(function (s) {
        if (s.points.length < 2) return;
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
        ctx.beginPath(); ctx.moveTo(s.points[0][0], s.points[0][1]);
        for (var i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i][0], s.points[i][1]);
        ctx.stroke();
      });
    }
    function pt(e) {
      var r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
    }
    cv.addEventListener("pointerdown", function (e) {
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      cur = { color: color, width: width, points: [pt(e)] };
    });
    cv.addEventListener("pointermove", function (e) { if (cur) { cur.points.push(pt(e)); redraw(); } });
    function endStroke() { if (cur) { if (cur.points.length > 1) strokes.push(cur); cur = null; redraw(); } }
    cv.addEventListener("pointerup", endStroke);
    cv.addEventListener("pointercancel", endStroke);
    wrap.addEventListener("click", function (e) {
      var c = e.target.closest("[data-ink-c]");
      if (c) { color = c.getAttribute("data-ink-c"); wrap.querySelectorAll(".sw").forEach(function (b) { b.classList.toggle("on", b === c); }); return; }
      var w = e.target.closest("[data-ink-w]");
      if (w) { width = +w.getAttribute("data-ink-w"); wrap.querySelectorAll(".wd").forEach(function (b) { b.classList.toggle("on", b === w); }); return; }
      if (e.target.closest("[data-ink-undo]")) { strokes.pop(); redraw(); return; }
      if (e.target.closest("[data-ink-cancel]")) { wrap.remove(); return; }
      if (e.target.closest("[data-ink-save]")) {
        if (!strokes.length) { wrap.remove(); return; }
        var out;
        try { out = cv.toDataURL("image/jpeg", 0.88); }
        catch (err) { wrap.remove(); notify("This picture can't be edited here (cross-origin)"); return; }
        wrap.remove();
        img.src = out;
        img.removeAttribute("data-media-path"); // annotated = new artifact; re-offload below
        scheduleSave();
        if (fig && fig.tagName === "FIGURE") offloadFigure(fig, out, "annotated.jpg");
        notify("Annotation saved");
      }
    });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { var el = $id("rrnb-ink"); if (el) el.remove(); document.removeEventListener("keydown", esc); }
    });
    redraw();
  }

  // ── keyboard shortcuts in the editor ─────────────────────────────
  function onEditorKey(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (slashKey(e)) return;                       // slash menu owns arrows/enter/esc while open
    if (!mod && !e.altKey && todoKeydown(e)) return;
    if (!mod && !e.altKey && tableTabKey(e)) return;
    if (mod && !e.shiftKey && !e.altKey) {
      var k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "u") { return; } // native, but we refresh after
      if (k === "1") { e.preventDefault(); insertTodo(); scheduleSave(); return; }
      if (k === "k") { e.preventDefault(); openLinkPicker(); return; }
      if (e.key === ".") { e.preventDefault(); exec("insertUnorderedList"); scheduleSave(); return; }
      if (e.key === "/") { e.preventDefault(); exec("insertOrderedList"); scheduleSave(); return; }
    }
    if (mod && e.altKey) {
      if (e.key === "1") { e.preventDefault(); applyBlock("H1"); return; }
      if (e.key === "2") { e.preventDefault(); applyBlock("H2"); return; }
      if (e.key === "3") { e.preventDefault(); applyBlock("H3"); return; }
      if (e.key === "0") { e.preventDefault(); applyBlock("P"); return; }
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); exec("hiliteColor", "#fde68a"); scheduleSave(); return; }
    // "[[" opens the page picker
    if (e.key === "[") {
      var ed = $id("rrnb-editor"); var sel = window.getSelection();
      if (sel && sel.anchorNode && sel.anchorNode.textContent && sel.anchorNode.textContent.slice(0, sel.anchorOffset).slice(-1) === "[") {
        e.preventDefault();
        // remove the stray first "["
        exec("delete");
        openPagePicker();
      }
    }
    setTimeout(refreshToolbarState, 0);
  }

  // ══════════════════════════════════════════════════════════════════
  //  AUTOSAVE
  // ══════════════════════════════════════════════════════════════════
  function currentEditorData() {
    if (S.editorKind === "tiptap" && S._tt) {
      var ttitle = $id("rrnb-title"); if (!ttitle) return null;
      return { title: ttitle.value.trim() || "Untitled Page", content_html: S._tt.getHTML(),
        content_text: S._tt.getText(), tags: (S.page && S.page.tags) || [] };
    }
    var ed = $id("rrnb-editor"), title = $id("rrnb-title");
    if (!ed || !title) return null;
    // OCR'd picture text rides along in the plaintext mirror so full-text
    // search finds what's inside screenshots (it never shows on the canvas).
    var text = ed.innerText || "";
    ed.querySelectorAll("figure.rrnb-fig[data-ocr]").forEach(function (f) {
      var t = f.getAttribute("data-ocr"); if (t) text += "\n[image] " + t;
    });
    // strip the transient image-selection highlight so it never persists
    var clean = ed.cloneNode(true);
    clean.querySelectorAll("figure.rrnb-fig.sel, img.sel").forEach(function (n) { n.classList.remove("sel"); });
    return { title: title.value.trim() || "Untitled Page", content_html: clean.innerHTML, content_text: text, tags: (S.page && S.page.tags) || [] };
  }
  function scheduleSave() {
    if (S.readOnly) return; // viewer role: nothing to save
    setSaveState("saving");
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(doSave, 650);
  }
  function flushSave() { if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; doSave(); } }
  function doSave(force) {
    S.saveTimer = null;
    var pid = S.pageId; if (!pid) return;
    var data = currentEditorData(); if (!data) return;
    S.saving = true;
    S.be.savePage(pid, data, force ? null : (S.baseUpdatedAt || null)).then(function (r) {
      S.saving = false; S.savedAt = (r && r.updated_at) || new Date().toISOString();
      S.baseUpdatedAt = (r && r.updated_at) || S.baseUpdatedAt;
      hideConflict();
      outboxRemove(pid);
      setSaveState("saved");
      // reflect the new title in the list — patch just this row, not the whole
      // list, so a content save never rebuilds the page-list DOM (title/tags/
      // position of other rows are unchanged by a save). Fall back to a full
      // render only if the row isn't currently mounted.
      if (S.tree) { var pg = S.tree.pages.filter(function (x) { return x.id === pid; })[0]; if (pg) { pg.title = data.title; pg.updated_at = S.savedAt; if (data.tags) pg.tags = data.tags; } }
      if (!patchPageRow(pid)) renderPageList();
      persistLinks(pid);
    }).catch(function (e) {
      S.saving = false;
      if (/stale_write/.test(String((e && e.message) || ""))) { setSaveState("conflict"); showConflict(); return; }
      // network-ish failure: park the edit in the outbox so closing the tab
      // can't lose it — it replays on reconnect / next boot. Only claim
      // "saved on this device" if the outbox write actually persisted.
      if (S.be.kind === "supabase" && outboxPut(pid, data, force ? null : (S.baseUpdatedAt || null))) setSaveState("queued");
      else setSaveState("err");
      console.warn(e);
    });
  }
  function setSaveState(st) {
    var box = $id("rrnb-save"); if (!box) return;
    box.classList.remove("saving", "err");
    if (st === "saving") { box.classList.add("saving"); $id("rrnb-save-txt").textContent = "Saving…"; }
    else if (st === "err") { box.classList.add("err"); $id("rrnb-save-txt").textContent = "Save failed — retrying"; setTimeout(doSave, 2500); }
    else if (st === "queued") { box.classList.add("saving"); $id("rrnb-save-txt").textContent = "Offline — saved on this device, will sync"; setTimeout(doSave, 4000); }
    else if (st === "conflict") { box.classList.add("err"); $id("rrnb-save-txt").textContent = "Conflict — not saved"; }
    else refreshSaveLabel();
  }

  // ── offline outbox: edits survive a dead connection AND a closed tab ──
  // Queued saves replay on reconnect or next boot. If the page changed on
  // the server while we were offline, the queued edit becomes a
  // "(conflicted copy)" page — both versions survive, OneNote-style.
  function outboxKey() { return "rrnb-outbox:" + (((window.RR && window.RR.dsp && window.RR.dsp.id) || "local")); }
  function outboxRead() { try { return JSON.parse(localStorage.getItem(outboxKey()) || "{}"); } catch (e) { return {}; } }
  function outboxWrite(ob) { try { localStorage.setItem(outboxKey(), JSON.stringify(ob)); return true; } catch (e) { return false; } }
  // returns false when persistence failed (quota, private browsing) — callers
  // must NOT claim "saved on this device" in that case (Codex review)
  function outboxPut(pid, data, base) {
    var ob = outboxRead(); ob[pid] = { data: data, base: base || null, at: new Date().toISOString() };
    return outboxWrite(ob) && !!outboxRead()[pid];
  }
  function outboxRemove(pid) { var ob = outboxRead(); if (ob[pid]) { delete ob[pid]; outboxWrite(ob); } }
  var _outboxBusy = false;
  function outboxFlush() {
    if (_outboxBusy || !S.be || S.be.kind !== "supabase") return;
    var ob = outboxRead(); var ids = Object.keys(ob); if (!ids.length) return;
    _outboxBusy = true;
    var ok = 0;
    (function next(i) {
      if (i >= ids.length) {
        _outboxBusy = false;
        if (ok) {
          notify(ok + " offline change" + (ok > 1 ? "s" : "") + " synced");
          // refresh the tree quietly; reload the canvas only if the open page
          // was one of the synced ones and the operator isn't mid-edit
          if (S.nbId) S.be.tree(S.nbId).then(function (t) { S.tree = t; renderSections(); renderPageList(); }).catch(function () {});
          if (ids.indexOf(S.pageId) >= 0 && !S.saveTimer && !S.saving) openPage(S.pageId);
        }
        return;
      }
      var pid = ids[i], entry = ob[pid];
      if (pid === S.pageId && S.saveTimer) { next(i + 1); return; } // live editor owns this page right now
      S.be.savePage(pid, entry.data, entry.base).then(function () {
        ok++; outboxRemove(pid); next(i + 1);
      }, function (e) {
        var msg = String((e && e.message) || "");
        if (/stale_write/.test(msg)) { outboxRemove(pid); conflictedCopy(pid, entry).then(function () { ok++; next(i + 1); }, function () { next(i + 1); }); }
        else if (/page_not_found/.test(msg)) { outboxRemove(pid); next(i + 1); }
        else next(i + 1); // still unreachable — keep queued for the next flush
      });
    })(0);
  }
  function conflictedCopy(pid, entry) {
    return S.be.getPage(pid).then(function (orig) {
      var sec = (orig && orig.section_id) || S.activeSection;
      if (!sec) throw new Error("no_section");
      var title = ((entry.data && entry.data.title) || "Untitled") + " (conflicted copy)";
      return S.be.createPage(sec, title, null, 0).then(function (p) {
        return S.be.savePage(p.id, { title: title, content_html: entry.data.content_html, content_text: entry.data.content_text, tags: entry.data.tags }).then(function () {
          notify("The page changed while you were offline — your edits were kept as “" + title + "”");
        });
      });
    });
  }
  window.addEventListener("online", function () { setTimeout(outboxFlush, 800); });
  // Someone else saved this page after the version we loaded: never clobber
  // silently — the operator picks which version wins.
  function showConflict() {
    if ($id("rrnb-conflict")) return;
    var tb = $id("rrnb-toolbar"); if (!tb || !tb.parentNode) return;
    var d = document.createElement("div"); d.className = "rrnb-conflict"; d.id = "rrnb-conflict";
    d.innerHTML = '<span>Someone else saved this page while you were editing.</span>' +
      '<button data-cf="reload" type="button">Load their version</button>' +
      '<button class="pri" data-cf="overwrite" type="button">Keep mine</button>';
    tb.parentNode.insertBefore(d, tb);
    d.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cf]"); if (!b) return;
      var act = b.getAttribute("data-cf"); hideConflict();
      if (act === "reload") openPage(S.pageId); else doSave(true);
    });
  }
  function hideConflict() { var d = $id("rrnb-conflict"); if (d) d.remove(); }
  function refreshSaveLabel() { var t = $id("rrnb-save-txt"); if (t) t.textContent = S.savedAt ? ("Saved " + relTime(S.savedAt)) : "Saved"; }

  function persistLinks(pid) {
    var ed = $id("rrnb-editor"); if (!ed) return;
    var links = [];
    ed.querySelectorAll("a.rrnb-pagelink[data-page-id]").forEach(function (a) { links.push({ target_page_id: a.getAttribute("data-page-id"), label: a.textContent }); });
    ed.querySelectorAll("a.rrnb-objlink[data-obj-type]").forEach(function (a) { links.push({ target_type: a.getAttribute("data-obj-type"), target_id: a.getAttribute("data-obj-id"), label: a.textContent }); });
    try { S.be.setLinks(pid, links); } catch (e) {}
  }

  // ── tags ─────────────────────────────────────────────────────────
  var TAG_PRESETS = ["important", "to-do", "question", "follow-up", "decision", "idea"];
  function renderTags(tags) {
    var host = $id("rrnb-tagbar"); if (!host) return;
    var html = (tags || []).map(function (t) {
      var cls = t === "important" ? " important" : (t === "to-do" || t === "follow-up") ? " done" : "";
      return '<span class="rrnb-tag' + cls + '" data-tag="' + esc(t) + '">' + esc(t) + ' <button data-remove-tag="' + esc(t) + '" title="Remove">×</button></span>';
    }).join("");
    html += '<button class="rrnb-addtag" id="rrnb-addtag">＋ Tag</button>';
    host.innerHTML = html;
  }
  function addTag(t) {
    if (!S.page) return; t = (t || "").trim().toLowerCase(); if (!t) return;
    S.page.tags = S.page.tags || []; if (S.page.tags.indexOf(t) < 0) S.page.tags.push(t);
    renderTags(S.page.tags); scheduleSave();
  }
  function removeTag(t) { if (!S.page || !S.page.tags) return; S.page.tags = S.page.tags.filter(function (x) { return x !== t; }); renderTags(S.page.tags); scheduleSave(); }

  // ── backlinks ────────────────────────────────────────────────────
  function renderBacklinks(pid) {
    var host = $id("rrnb-ctx-backlinks"); if (!host) return;
    S.be.backlinks(pid).then(function (rows) {
      if (!rows || !rows.length) { host.innerHTML = ""; return; }
      host.innerHTML = '<h4>Backlinks<span class="cnt">' + rows.length + '</span></h4>' + rows.map(function (r) {
        return '<div class="rrnb-crec" data-goto-page="' + esc(r.page_id) + '" data-goto-nb="' + esc(r.notebook_id) + '">' +
          '<span class="av" style="background:var(--text-subtle)"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></span>' +
          '<div class="cc"><div class="rn">' + esc(r.title) + '</div><div class="rt">Linked from</div></div></div>';
      }).join("");
    }).catch(function () {});
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONTEXT RAIL (Pane 4) — surfaces the depth the backend already has:
  //  linked RouteReady records, page outline, backlinks, and properties.
  //  Records/outline are read from the live editor DOM; backlinks come
  //  from notebook_page_backlinks; properties from the loaded page.
  // ══════════════════════════════════════════════════════════════════
  function ctxPref() { try { return localStorage.getItem("rrnb-ctx-open") !== "0"; } catch (e) { return true; } }
  function ctxToggle(force) {
    var sh = $id("rrnb-shell"); if (!sh) return;
    var on = (force == null) ? !sh.classList.contains("ctx-on") : !!force;
    sh.classList.toggle("ctx-on", on);
    try { localStorage.setItem("rrnb-ctx-open", on ? "1" : "0"); } catch (e) {}
    var b = $id("rrnb-ctx-toggle"); if (b) b.classList.toggle("on", on);
  }
  var _ctxBound = false;
  function ensureCtxInit() {
    if (_ctxBound) return; _ctxBound = true;
    if (!S._cmtMentions) S._cmtMentions = {};
    var sh = $id("rrnb-shell"); if (sh) sh.classList.toggle("ctx-on", ctxPref());
    var pane = $id("rrnb-ctxpane"); if (pane) pane.addEventListener("click", onCtxClick);
    var ch = $id("rrnb-ctx-comments");
    if (ch) {
      ch.addEventListener("click", onCommentsClick);
      ch.addEventListener("input", function (e) { if (e.target.classList && e.target.classList.contains("rrnb-cmt-input")) onComposerInput(e.target); });
      ch.addEventListener("keydown", function (e) { if (e.target.classList && e.target.classList.contains("rrnb-cmt-input")) onComposerKey(e); });
    }
  }
  var CTX_COLORS = { driver: "#2563eb", vehicle: "#7c3aed", route: "#475569", station: "#0891b2",
    incident: "#dc2626", shift: "#16a34a", applicant: "#d97706" };
  function recInitials(name) {
    var w = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!w.length) return "•";
    return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
  }
  function resetContextRail() {
    ensureCtxInit();
    ["rrnb-ctx-records", "rrnb-ctx-outline", "rrnb-ctx-comments", "rrnb-ctx-backlinks", "rrnb-ctx-props"].forEach(function (id) {
      var el = $id(id); if (el) el.innerHTML = "";
    });
    var em = $id("rrnb-ctx-empty"); if (em) em.hidden = false;
  }
  function fillCtxRecords() {
    var host = $id("rrnb-ctx-records"); if (!host) return;
    var ed = $id("rrnb-editor");
    var recs = [], seen = {};
    var nb = (S.tree && S.tree.notebook) || {};
    if (nb.subject_type && nb.subject_id) {
      seen[nb.subject_type + ":" + nb.subject_id] = 1;
      recs.push({ type: nb.subject_type, id: nb.subject_id, name: nb.name || nb.subject_type, subject: true });
    }
    if (ed) ed.querySelectorAll("a.rrnb-objlink[data-obj-type]").forEach(function (a) {
      var t = a.getAttribute("data-obj-type"), i = a.getAttribute("data-obj-id");
      if (!t || !i) return;
      var k = t + ":" + i; if (seen[k]) return; seen[k] = 1;
      recs.push({ type: t, id: i, name: a.getAttribute("data-obj-name") || a.textContent || "record" });
    });
    if (!recs.length) {
      host.innerHTML = '<h4>Linked records</h4>' +
        '<div class="rrnb-ctxlink" data-ctx-add>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Link a driver, van or route…</div>';
      return;
    }
    host.innerHTML = '<h4>Linked records<span class="cnt">' + recs.length + '</span></h4>' + recs.map(function (r) {
      var col = CTX_COLORS[r.type] || "var(--accent)";
      return '<div class="rrnb-crec" data-ctx-rec data-rt="' + esc(r.type) + '" data-ri="' + esc(r.id) + '" data-rn="' + esc(r.name) + '">' +
        '<span class="av" style="background:' + col + '">' + esc(recInitials(r.name)) + '</span>' +
        '<div class="cc"><div class="rn">' + esc(r.name) + '</div><div class="rt">' + esc(r.type) + (r.subject ? ' · this notebook' : '') + '</div></div>' +
        '<span class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M9 7h8v8"/></svg></span></div>';
    }).join("") +
      '<div class="rrnb-ctxlink" data-ctx-add><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Link a record…</div>';
  }
  function fillCtxOutline() {
    var host = $id("rrnb-ctx-outline"); if (!host) return;
    var ed = $id("rrnb-editor"); var heads = [];
    if (ed) ed.querySelectorAll("h1,h2,h3").forEach(function (h, ix) {
      var t = (h.textContent || "").trim(); if (!t) return;
      if (!h.id) h.id = "rrnb-h-" + ix;
      heads.push({ id: h.id, lvl: h.tagName.toLowerCase(), t: t });
    });
    if (!heads.length) { host.innerHTML = ""; return; }
    host.innerHTML = '<h4>On this page</h4><ul class="rrnb-ol">' + heads.map(function (h) {
      return '<li class="' + (h.lvl === "h3" ? "l3" : "") + '" data-ctx-head="' + esc(h.id) + '">' + esc(h.t) + '</li>';
    }).join("") + '</ul>';
  }
  function fillCtxProps(p) {
    var host = $id("rrnb-ctx-props"); if (!host) return;
    var sec = ((S.tree && S.tree.sections) || []).filter(function (s) { return s.id === p.section_id; })[0] || {};
    var rows = [];
    if (p.author) rows.push(["Author", esc(p.author)]);
    if (p.updated_at) rows.push(["Edited", esc(relTime(p.updated_at))]);
    if (p.created_at) rows.push(["Created", esc(new Date(p.created_at).toLocaleDateString())]);
    if (sec.name) rows.push(["Section", esc(sec.name)]);
    if (p.level) rows.push(["Depth", p.level === 1 ? "Subpage" : "Sub-subpage"]);
    if (!rows.length) { host.innerHTML = ""; return; }
    host.innerHTML = '<h4>Properties</h4>' + rows.map(function (r) {
      return '<div class="rrnb-prop"><span class="pl">' + r[0] + '</span><span class="pv">' + r[1] + '</span></div>';
    }).join("");
  }
  function renderContextRail(p, localOnly) {
    ensureCtxInit();
    if (!p) { resetContextRail(); return; }
    var em = $id("rrnb-ctx-empty"); if (em) em.hidden = true;
    fillCtxRecords();
    fillCtxOutline();
    if (!localOnly) { S._replyTo = null; S._cmtMentions = {}; renderBacklinks(id_of(p)); fillCtxProps(p); fillCtxComments(id_of(p)); }
  }
  var scheduleCtxRefresh = debounce(function () { if (S.page) renderContextRail(S.page, true); }, 500);
  function onCtxClick(e) {
    var t = e.target;
    if (t.closest("[data-ctx-toggle]")) { ctxToggle(false); return; }
    var rec = t.closest("[data-ctx-rec]");
    if (rec) { openObjectRef(rec.getAttribute("data-rt"), rec.getAttribute("data-ri"), rec.getAttribute("data-rn")); return; }
    var gp = t.closest("[data-goto-page]");
    if (gp) {
      var nb = gp.getAttribute("data-goto-nb"), pg = gp.getAttribute("data-goto-page");
      if (nb && nb !== S.nbId) { S.activeSection = null; selectNotebook(nb, pg); } else { openPage(pg); }
      return;
    }
    var h = t.closest("[data-ctx-head]");
    if (h) { var el = document.getElementById(h.getAttribute("data-ctx-head")); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (t.closest("[data-ctx-add]")) { try { smartLink(true); } catch (_) {} return; }
  }

  // ── comments (migration 0479) ────────────────────────────────────────────
  function ensureCommentStaff() {
    if (S._cmtStaff) return;
    S._cmtStaff = []; // sentinel so we only fetch once
    if (!S.be || !S.be.shareCandidates) return;
    S.be.shareCandidates().then(function (rows) {
      S._cmtStaff = (rows || []).map(function (r) { return { user_id: r.user_id, name: r.name || r.email || "teammate" }; });
    }).catch(function () { S._cmtStaff = []; });
  }
  function fillCtxComments(pid) {
    var host = $id("rrnb-ctx-comments"); if (!host || !pid) return;
    ensureCommentStaff();
    S.be.commentsList(pid).then(function (rows) {
      if (S.pageId !== pid) return;             // page switched while loading
      renderComments(host, rows || []);
    }).catch(function () { host.innerHTML = ""; });
  }
  function cmtBodyHtml(c) {
    var body = esc(c.body || "");
    (c.mentions || []).forEach(function (nm) { body = body.split("@" + esc(nm)).join('<span class="mn">@' + esc(nm) + "</span>"); });
    return body.replace(/\n/g, "<br>");
  }
  function cmtHtml(c, isReply) {
    var canDel = c.is_mine || S.myRole === "owner";
    var acts = S.readOnly ? "" : ('<span class="act">' +
      '<button class="cta' + (c.resolved ? " on" : "") + '" data-cmt-resolve="' + esc(c.id) + '" title="' + (c.resolved ? "Reopen" : "Resolve") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button>' +
      (canDel ? '<button class="cta" data-cmt-del="' + esc(c.id) + '" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>' : "") +
      "</span>");
    return '<div class="rrnb-cmt' + (isReply ? " reply" : "") + (c.resolved ? " resolved" : "") + '" data-cmt="' + esc(c.id) + '">' +
      '<span class="av">' + esc(recInitials(c.author)) + "</span>" +
      '<div class="cbd"><div class="chd"><span>' + esc(c.author || "Teammate") + '</span><span class="tm">' + esc(relTime(c.created_at)) + "</span>" + acts + "</div>" +
      '<div class="ctx-body-txt">' + cmtBodyHtml(c) + "</div>" +
      ((!isReply && !S.readOnly) ? '<span class="rply" data-cmt-reply="' + esc(c.id) + '">Reply</span>' : "") +
      (c.resolved ? ' <span class="rslv-badge">· resolved</span>' : "") +
      "</div></div>";
  }
  function renderComments(host, rows) {
    var top = rows.filter(function (c) { return !c.parent_id; });
    var repl = {}; rows.forEach(function (c) { if (c.parent_id) (repl[c.parent_id] = repl[c.parent_id] || []).push(c); });
    var html = '<h4>Comments' + (rows.length ? '<span class="cnt">' + rows.length + "</span>" : "") + "</h4>";
    if (!rows.length) html += '<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-bottom:8px">No comments yet — start the thread.</div>';
    top.forEach(function (c) { html += cmtHtml(c, false); (repl[c.id] || []).forEach(function (r) { html += cmtHtml(r, true); }); });
    var chip = "";
    if (S._replyTo) {
      var pc = rows.filter(function (x) { return x.id === S._replyTo; })[0];
      chip = '<div class="rrnb-cmt-replychip">Replying to ' + esc(pc ? pc.author : "comment") + '<button data-cmt-cancelreply title="Cancel reply">✕</button></div>';
    }
    html += '<div class="rrnb-cmt-composer">' + chip + '<div class="rrnb-mnmenu" hidden></div>' +
      '<textarea class="rrnb-cmt-input" rows="1" placeholder="' + (S.readOnly ? "View only" : "Comment or @mention…") + '"' + (S.readOnly ? " disabled" : "") + "></textarea>" +
      '<div class="rrnb-cmt-row"><span class="hint">@ mention · ⌘↵ send</span><button class="rrnb-cmt-send" disabled>' + (S._replyTo ? "Reply" : "Comment") + "</button></div></div>";
    host.innerHTML = html;
  }
  function onComposerInput(ta) {
    ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    var wrap = ta.closest(".rrnb-cmt-composer"); if (!wrap) return;
    var send = wrap.querySelector(".rrnb-cmt-send"); if (send) send.disabled = !ta.value.trim();
    var menu = wrap.querySelector(".rrnb-mnmenu"); if (!menu) return;
    var upto = ta.value.slice(0, ta.selectionStart);
    var m = /@([\w.'-]*)$/.exec(upto);
    if (m && S._cmtStaff && S._cmtStaff.length) {
      var tok = m[1].toLowerCase();
      var hits = S._cmtStaff.filter(function (s) { return s.name.toLowerCase().indexOf(tok) >= 0; }).slice(0, 6);
      if (hits.length) {
        menu.innerHTML = hits.map(function (s, i) {
          return '<div class="mnrow' + (i === 0 ? " on" : "") + '" data-mn-id="' + esc(s.user_id) + '" data-mn-name="' + esc(s.name) + '"><span class="mnav">' + esc(recInitials(s.name)) + "</span>" + esc(s.name) + "</div>";
        }).join(""); menu.hidden = false; return;
      }
    }
    menu.hidden = true;
  }
  function insertMention(ta, id, name) {
    var start = ta.selectionStart, before = ta.value.slice(0, start), after = ta.value.slice(start);
    before = before.replace(/@([\w.'-]*)$/, "@" + name + " ");
    ta.value = before + after; var pos = before.length; try { ta.setSelectionRange(pos, pos); } catch (e) {}
    if (!S._cmtMentions) S._cmtMentions = {}; S._cmtMentions[name] = id;
    var wrap = ta.closest(".rrnb-cmt-composer");
    var menu = wrap && wrap.querySelector(".rrnb-mnmenu"); if (menu) menu.hidden = true;
    var send = wrap && wrap.querySelector(".rrnb-cmt-send"); if (send) send.disabled = !ta.value.trim();
    ta.focus();
  }
  function onComposerKey(e) {
    var ta = e.target;
    var wrap = ta.closest(".rrnb-cmt-composer"); if (!wrap) return;
    var menu = wrap.querySelector(".rrnb-mnmenu");
    if (menu && !menu.hidden) {
      var rows = [].slice.call(menu.querySelectorAll(".mnrow")); if (!rows.length) { }
      var cur = menu.querySelector(".mnrow.on"), i = rows.indexOf(cur);
      if (e.key === "ArrowDown") { e.preventDefault(); if (cur) cur.classList.remove("on"); (rows[(i + 1) % rows.length] || rows[0]).classList.add("on"); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); if (cur) cur.classList.remove("on"); (rows[(i - 1 + rows.length) % rows.length] || rows[0]).classList.add("on"); return; }
      if (e.key === "Enter") { e.preventDefault(); var pick = cur || rows[0]; if (pick) insertMention(ta, pick.getAttribute("data-mn-id"), pick.getAttribute("data-mn-name")); return; }
      if (e.key === "Escape") { e.preventDefault(); menu.hidden = true; return; }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComment(ta); }
  }
  function submitComment(ta) {
    var body = (ta.value || "").trim(); if (!body) return;
    var pid = S.pageId; if (!pid) return;
    var ments = Object.keys(S._cmtMentions || {}).filter(function (n) { return body.indexOf("@" + n) >= 0; }).map(function (n) { return S._cmtMentions[n]; });
    var parent = S._replyTo || null;
    ta.disabled = true;
    S.be.commentAdd(pid, body, parent, null, ments).then(function () {
      S._cmtMentions = {}; S._replyTo = null; fillCtxComments(pid);
    }).catch(function (e) { ta.disabled = false; fail(e); });
  }
  function onCommentsClick(e) {
    var host = e.currentTarget;
    var mn = e.target.closest("[data-mn-id]");
    if (mn) { var ta = host.querySelector(".rrnb-cmt-input"); if (ta) insertMention(ta, mn.getAttribute("data-mn-id"), mn.getAttribute("data-mn-name")); return; }
    if (e.target.closest(".rrnb-cmt-send")) { var ta2 = host.querySelector(".rrnb-cmt-input"); if (ta2) submitComment(ta2); return; }
    var rs = e.target.closest("[data-cmt-resolve]");
    if (rs) { var on = rs.classList.contains("on"); S.be.commentResolve(rs.getAttribute("data-cmt-resolve"), !on).then(function () { fillCtxComments(S.pageId); }).catch(fail); return; }
    var dl = e.target.closest("[data-cmt-del]");
    if (dl) { S.be.commentDelete(dl.getAttribute("data-cmt-del")).then(function () { fillCtxComments(S.pageId); }).catch(fail); return; }
    var rp = e.target.closest("[data-cmt-reply]");
    if (rp) { S._replyTo = rp.getAttribute("data-cmt-reply"); fillCtxComments(S.pageId); setTimeout(function () { var t = host.querySelector(".rrnb-cmt-input"); if (t) t.focus(); }, 60); return; }
    if (e.target.closest("[data-cmt-cancelreply]")) { S._replyTo = null; fillCtxComments(S.pageId); return; }
  }

  // ══════════════════════════════════════════════════════════════════
  //  VERSION HISTORY (migration 0452)
  // ══════════════════════════════════════════════════════════════════
  function openHistory() {
    var btn = $id("rrnb-history-btn"); if (!btn || !S.pageId || !S.be.revisionsList) return;
    flushSave();
    var r = btn.getBoundingClientRect();
    S.be.revisionsList(S.pageId).then(function (rows) {
      if (!rows || !rows.length) {
        showPop('<label>Version history</label><div class="rrnb-pop-opt" style="color:var(--text-subtle)">No earlier versions yet — they\'re captured automatically as the page is edited.</div>', r);
        return;
      }
      var pop = showPop('<label>Version history</label><div class="rrnb-pop-list">' + rows.map(function (v) {
        return '<div class="rrnb-pop-opt" data-rev="' + v.id + '">' + esc(relTime(v.created_at)) + ' · ' + esc(v.author || "") +
          '<div class="mut">' + esc(v.title || "") + '</div></div>';
      }).join("") + '</div>', r);
      pop.addEventListener("click", function (e) {
        var o = e.target.closest("[data-rev]"); if (!o) return;
        hidePop(); previewRevision(o.getAttribute("data-rev"));
      });
    }).catch(fail);
  }
  function previewRevision(revId) {
    S.be.revisionGet(revId).then(function (rev) {
      if (!rev) return;
      var p = aiPanel();
      p.innerHTML = '<div class="ph">Version from ' + esc(relTime(rev.created_at)) +
        '<span class="sp">' + (S.readOnly ? '' : '<button class="pri" data-rv-restore="1">Restore this version</button>') + '<button data-ai-x="1">Close</button></span></div>' +
        '<div class="bd">' + (rev.content_html || "<p>(empty page)</p>") + '</div>';
      hydrateMedia(p.querySelector(".bd"));
      p.querySelector("[data-ai-x]").onclick = function () { p.remove(); };
      var rvBtn = p.querySelector("[data-rv-restore]");
      if (rvBtn) rvBtn.onclick = function () {
        p.remove();
        S.be.revisionRestore(revId).then(function () { notify("Version restored"); openPage(S.pageId); }).catch(fail);
      };
    }).catch(fail);
  }

  // ══════════════════════════════════════════════════════════════════
  //  REALTIME — live page updates + who's-here presence
  // ══════════════════════════════════════════════════════════════════
  function rtClient() { return (S.be && S.be.kind === "supabase" && window.RR && window.RR.sb) ? window.RR.sb : null; }
  function myUserId() { return (window.RR && window.RR.user && window.RR.user.id) || null; }
  function myName() { var u = window.RR && window.RR.user; return (u && (u.full_name || u.email)) || "A teammate"; }
  var renderPageListSoon = debounce(function () { if (S.mode === "notebook") renderPageList(); }, 150);
  function initRealtime() {
    var sb = rtClient(); if (!sb || S.rtChannel || !sb.channel) return;
    var dsp = window.RR.dsp && window.RR.dsp.id; if (!dsp) return;
    try {
      S.rtChannel = sb.channel("rrnb-pages-" + dsp)
        .on("postgres_changes", { event: "*", schema: "public", table: "notebook_pages", filter: "dsp_id=eq." + dsp }, onPageChange)
        .subscribe();
    } catch (e) { S.rtChannel = null; }
  }
  function onPageChange(payload) {
    try {
      var row = (payload["new"] && payload["new"].id) ? payload["new"] : payload.old;
      if (!row || !S.tree) return;
      var evt = payload.eventType;
      var fresh = payload["new"];
      var mine = fresh && fresh.updated_by && fresh.updated_by === myUserId();
      var pg = S.tree.pages.filter(function (x) { return x.id === row.id; })[0];
      if (evt === "UPDATE" && pg && fresh) {
        if (fresh.deleted_at) S.tree.pages = S.tree.pages.filter(function (x) { return x.id !== row.id; });
        else { pg.title = fresh.title; pg.updated_at = fresh.updated_at; pg.is_pinned = !!fresh.is_pinned; pg.tags = fresh.tags || pg.tags; }
        renderPageListSoon();
      } else if (evt === "INSERT" && fresh && fresh.notebook_id === S.nbId && !pg && !fresh.deleted_at) {
        S.tree.pages.push({ id: fresh.id, section_id: fresh.section_id, parent_page_id: fresh.parent_page_id, title: fresh.title, level: fresh.level || 0, position: fresh.position || 0, tags: fresh.tags || [], is_pinned: !!fresh.is_pinned, updated_at: fresh.updated_at });
        renderPageListSoon();
      } else if (evt === "DELETE" && pg) {
        S.tree.pages = S.tree.pages.filter(function (x) { return x.id !== row.id; });
        renderPageListSoon();
      }
      // the page on my canvas changed under me
      if (!mine && evt === "UPDATE" && fresh && S.pageId === row.id && !fresh.deleted_at
          && fresh.updated_at !== S.baseUpdatedAt) {
        if (S.saveTimer || S.saving) showConflict();
        else openPage(S.pageId);
      }
    } catch (e) {}
  }
  function joinPresence(pageId) {
    leavePresence();
    var sb = rtClient(); if (!sb || !sb.channel || !pageId) return;
    try {
      var ch = sb.channel("rrnb-presence-" + pageId, { config: { presence: { key: String(myUserId() || uid()) } } });
      ch.on("presence", { event: "sync" }, function () {
        try {
          var state = ch.presenceState(), names = [];
          Object.keys(state).forEach(function (k) {
            if (k === String(myUserId())) return;
            (state[k] || []).forEach(function (m) { if (m.name && names.indexOf(m.name) < 0) names.push(m.name); });
          });
          var box = $id("rrnb-presence"), txt = $id("rrnb-presence-txt");
          if (!box || !txt) return;
          if (names.length) { txt.textContent = names.slice(0, 3).join(", ") + (names.length > 3 ? " +" + (names.length - 3) : "") + " viewing"; box.hidden = false; }
          else box.hidden = true;
        } catch (e) {}
      });
      ch.subscribe(function (status) { if (status === "SUBSCRIBED") { try { ch.track({ name: myName() }); } catch (e) {} } });
      S.presenceChannel = ch;
    } catch (e) { S.presenceChannel = null; }
  }
  function leavePresence() {
    var sb = rtClient();
    if (S.presenceChannel && sb) { try { sb.removeChannel(S.presenceChannel); } catch (e) {} }
    S.presenceChannel = null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  DICTATION (voice → text, Web Speech API where available)
  // ══════════════════════════════════════════════════════════════════
  var _dict = null;
  function toggleDictation() {
    var btn = document.querySelector('#rrnb-toolbar [data-cmd="dictate"]');
    if (_dict) { var d = _dict; _dict = null; try { d.stop(); } catch (e) {} if (btn) btn.classList.remove("rec"); return; }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { notify("Dictation isn't supported in this browser"); return; }
    var rec = new SR();
    rec.continuous = true; rec.interimResults = false;
    try { rec.lang = navigator.language || "en-US"; } catch (e) {}
    rec.onresult = function (ev) {
      var txt = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) txt += ev.results[i][0].transcript;
      if (txt.trim()) { var ed = $id("rrnb-editor"); if (ed) { ed.focus(); insertHTMLAtCursor(esc(txt.trim()) + " "); scheduleSave(); } }
    };
    rec.onend = function () { if (_dict === rec) { _dict = null; if (btn) btn.classList.remove("rec"); } };
    rec.onerror = function (ev) { if (ev && ev.error === "not-allowed") notify("Microphone permission was denied"); };
    try { rec.start(); _dict = rec; if (btn) btn.classList.add("rec"); notify("Listening — click the mic again to stop"); }
    catch (e) { _dict = null; notify("Couldn't start dictation"); }
  }

  // ══════════════════════════════════════════════════════════════════
  //  OCR — picture text becomes searchable (and copyable), like OneNote
  // ══════════════════════════════════════════════════════════════════
  function aiFn() { var sb = (window.RR && window.RR.sb) || window.sb; return (sb && sb.functions) ? sb : null; }
  function ocrFigure(fig, dataUrl, cb) {
    var sb = aiFn(); if (!sb || !fig || !dataUrl) { if (cb) cb(null); return; }
    sb.functions.invoke("notebook-ai", { body: { action: "ocr", image: dataUrl } }).then(function (res) {
      var data = res && res.data;
      var text = (data && !data.error) ? String(data.result || "").trim() : "";
      if (text && fig.isConnected) { fig.setAttribute("data-ocr", text); scheduleSave(); }
      if (cb) cb(text || null);
    }).catch(function () { if (cb) cb(null); });
  }

  // ══════════════════════════════════════════════════════════════════
  //  EXPORT — print/PDF + Markdown download
  // ══════════════════════════════════════════════════════════════════
  function pageSnapshotFor(id) {
    if (id === S.pageId && $id("rrnb-editor")) {
      return Promise.resolve({ title: ($id("rrnb-title") || {}).value || (S.page && S.page.title) || "Page",
        content_html: $id("rrnb-editor").innerHTML || "" });
    }
    return S.be.getPage(id);
  }
  function printPage(id) {
    var w = window.open("", "_blank", "width=900,height=700");
    if (!w) { notify("Pop-up blocked — allow pop-ups to print"); return; }
    pageSnapshotFor(id).then(function (p) {
      if (!p) { try { w.close(); } catch (e) {} return; }
      // stored media: saved srcs may be expired signed URLs — re-sign for print
      var host = document.createElement("div"); host.innerHTML = p.content_html || "";
      var els = Array.prototype.slice.call(host.querySelectorAll("[data-media-path]"));
      var writeDoc = function () { p.content_html = host.innerHTML; writePrintDoc(w, p); };
      if (els.length && storageClient()) {
        mediaSign(els.map(function (el) { return el.getAttribute("data-media-path"); }), function (map) {
          els.forEach(function (el) {
            var u = map[el.getAttribute("data-media-path")]; if (!u) return;
            if (el.tagName === "IMG") el.src = u; else el.setAttribute("href", u);
          });
          writeDoc();
        });
      } else writeDoc();
    }).catch(fail);
  }
  function writePrintDoc(w, p) {
      w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(p.title || "Page") + '</title><style>' +
        'body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 24px}' +
        'h1{font-size:26px;margin:0 0 16px}h2{font-size:20px}h3{font-size:15px;text-transform:uppercase;letter-spacing:.03em}' +
        'table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #bbb;padding:4px 8px;min-width:60px;vertical-align:top}th{background:#f3f4f6;text-align:left}' +
        'blockquote{border-left:3px solid #888;margin:8px 0;padding:4px 16px;color:#444}' +
        'pre{background:#f6f6f6;border:1px solid #ddd;padding:12px;border-radius:6px;overflow:auto}' +
        'img{max-width:100%}figure{margin:12px 0}figcaption{font-size:12px;color:#666}' +
        '.rrnb-todo{display:flex;gap:8px;margin:2px 0}.rrnb-todo-box{display:inline-block;flex:0 0 auto;width:14px;height:14px;border:1.5px solid #555;border-radius:3px;margin-top:4px;font-size:11px;line-height:14px;text-align:center}' +
        '.rrnb-todo[data-checked="1"] .rrnb-todo-text{text-decoration:line-through;color:#888}' +
        '.rrnb-callout{display:flex;gap:8px;background:#eef4ff;border:1px solid #c8d8f8;border-radius:6px;padding:8px 12px;margin:8px 0}' +
        'a{color:#2563eb}.rrnb-file{display:block;border:1px solid #ddd;border-radius:6px;padding:8px 12px;max-width:420px;text-decoration:none;color:#111;margin:8px 0}' +
        '</style></head><body><h1>' + esc(p.title || "Page") + '</h1>' + (p.content_html || "") + '</body></html>');
      w.document.close();
      w.focus();
      setTimeout(function () { try { w.print(); } catch (e) {} }, 300);
  }
  function exportMarkdown(id) {
    pageSnapshotFor(id).then(function (p) {
      if (!p) return;
      var md = "# " + (p.title || "Page") + "\n\n" + htmlToMd(p.content_html || "");
      var blob = new Blob([md], { type: "text/markdown" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ((p.title || "page").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "page") + ".md";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    }).catch(fail);
  }
  function htmlToMd(html) {
    var root = document.createElement("div"); root.innerHTML = html || "";
    function inline(node) {
      var out = "";
      Array.prototype.forEach.call(node.childNodes, function (c) {
        if (c.nodeType === 3) { out += c.nodeValue.replace(/​/g, ""); return; }
        if (c.nodeType !== 1) return;
        var tag = c.tagName, inner = inline(c);
        if (c.classList && c.classList.contains("rrnb-file")) out += "[attachment: " + (((c.querySelector("b") || {}).textContent) || "file") + "]";
        else if (tag === "B" || tag === "STRONG") out += "**" + inner + "**";
        else if (tag === "I" || tag === "EM") out += "*" + inner + "*";
        else if (tag === "S" || tag === "STRIKE" || tag === "DEL") out += "~~" + inner + "~~";
        else if (tag === "U") out += inner;
        else if (tag === "CODE") out += "`" + inner + "`";
        else if (tag === "MARK") out += "==" + inner + "==";
        else if (tag === "A") out += (c.classList.contains("rrnb-pagelink") || c.classList.contains("rrnb-objlink")) ? "[[" + inner + "]]" : "[" + inner + "](" + (c.getAttribute("href") || "") + ")";
        else if (tag === "BR") out += "\n";
        else if (tag === "IMG") out += "![" + (c.getAttribute("alt") || "image") + "]";
        else out += inner;
      });
      return out;
    }
    function walk(node) {
      var out = "";
      Array.prototype.forEach.call(node.childNodes, function (c) {
        if (c.nodeType === 3) { var t = c.nodeValue.replace(/​/g, ""); if (t.trim()) out += t.trim() + "\n\n"; return; }
        if (c.nodeType !== 1) return;
        var tag = c.tagName;
        if (c.classList && c.classList.contains("rrnb-todo")) {
          var tx = c.querySelector(".rrnb-todo-text");
          out += "- [" + (c.getAttribute("data-checked") === "1" ? "x" : " ") + "] " + (tx ? inline(tx).trim() : "") + "\n";
        }
        else if (c.classList && c.classList.contains("rrnb-callout")) out += "> " + inline(c).trim() + "\n\n";
        else if (tag === "H1") out += "# " + inline(c).trim() + "\n\n";
        else if (tag === "H2") out += "## " + inline(c).trim() + "\n\n";
        else if (tag === "H3") out += "### " + inline(c).trim() + "\n\n";
        else if (tag === "P") { var t2 = inline(c).trim(); if (t2) out += t2 + "\n\n"; }
        else if (tag === "HR") out += "---\n\n";
        else if (tag === "BLOCKQUOTE") out += inline(c).trim().split("\n").map(function (l) { return "> " + l; }).join("\n") + "\n\n";
        else if (tag === "PRE") out += "```\n" + (c.innerText || "").replace(/\n?$/, "\n") + "```\n\n";
        else if (tag === "UL" || tag === "OL") {
          var n = 0;
          Array.prototype.forEach.call(c.children, function (li) {
            if (li.tagName !== "LI") return; n++;
            out += (tag === "OL" ? n + ". " : "- ") + inline(li).trim() + "\n";
          });
          out += "\n";
        }
        else if (tag === "FIGURE") {
          var cap = c.querySelector("figcaption");
          out += "![" + ((cap && cap.textContent.trim()) || "image") + "]";
          var ocr = c.getAttribute("data-ocr");
          if (ocr) out += "\n> " + ocr.split("\n").join("\n> ");
          out += "\n\n";
        }
        else if (tag === "TABLE") {
          var rows = Array.prototype.slice.call(c.querySelectorAll("tr"));
          rows.forEach(function (tr, ri) {
            var cells = Array.prototype.slice.call(tr.children).map(function (td) { return inline(td).replace(/\|/g, "\\|").replace(/\n/g, " ").trim(); });
            out += "| " + cells.join(" | ") + " |\n";
            if (ri === 0) out += "|" + cells.map(function () { return " --- "; }).join("|") + "|\n";
          });
          out += "\n";
        }
        else if (tag === "DIV") out += walk(c);
        else { var t3 = inline(c).trim(); if (t3) out += t3 + "\n\n"; }
      });
      return out;
    }
    return walk(root).replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  // ══════════════════════════════════════════════════════════════════
  //  MENTIONS — pages elsewhere that reference this object notebook's subject
  // ══════════════════════════════════════════════════════════════════
  function renderMentions(meta) {
    var host = $id("rrnb-mentions"); if (!host) return;
    host.hidden = true; host.innerHTML = "";
    if (!meta || meta.kind !== "object" || !meta.subject_type || !S.be.pagesForObject) return;
    S.be.pagesForObject(meta.subject_type, meta.subject_id).then(function (rows) {
      rows = (rows || []).filter(function (r) { return r.notebook_id !== S.nbId; });
      if (!rows.length || !$id("rrnb-mentions")) return;
      host.innerHTML = '<h4>Mentioned in</h4>' + rows.slice(0, 12).map(function (r) {
        return '<a class="rrnb-mention" data-mn-page="' + r.page_id + '" data-mn-nb="' + r.notebook_id + '">' + esc(r.title || "Untitled") + '</a>';
      }).join("");
      host.hidden = false;
    }).catch(function () {});
  }

  // ══════════════════════════════════════════════════════════════════
  //  POPOVERS: link, page-link, table
  // ══════════════════════════════════════════════════════════════════
  function savedSelection() { var s = window.getSelection(); return s.rangeCount ? s.getRangeAt(0).cloneRange() : null; }
  function restoreSelection(r) { if (!r) return; var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  function showPop(html, anchorRect) {
    var pop = $id("rrnb-pop"); pop.innerHTML = html; pop.hidden = false;
    var r = anchorRect || { left: window.innerWidth / 2 - 130, bottom: 120 };
    pop.style.left = Math.max(12, Math.min(window.innerWidth - pop.offsetWidth - 12, r.left)) + "px";
    pop.style.top = (r.bottom + 6) + "px";
    return pop;
  }
  function hidePop() { var pop = $id("rrnb-pop"); if (pop) { pop.hidden = true; pop.innerHTML = ""; } }
  function selRect() { var s = window.getSelection(); if (s.rangeCount) { var rr = s.getRangeAt(0).getBoundingClientRect(); if (rr && rr.width + rr.height) return rr; } var e = $id("rrnb-editor"); return e ? e.getBoundingClientRect() : null; }

  function openLinkPicker() {
    var range = savedSelection();
    var selText = window.getSelection().toString();
    var pop = showPop(
      '<label>Link text</label><input id="rrnb-lk-text" value="' + esc(selText) + '" placeholder="Text to show" />' +
      '<label>URL</label><input id="rrnb-lk-url" placeholder="https://…" />' +
      '<div class="rrnb-pop-row"><button class="rrnb-pop-btn ghost" data-pop-cancel="1">Cancel</button><button class="rrnb-pop-btn" id="rrnb-lk-ok">Add link</button></div>', selRect());
    var url = $id("rrnb-lk-url"); if (url) url.focus();
    $id("rrnb-lk-ok").addEventListener("click", function () {
      var u = $id("rrnb-lk-url").value.trim(); var txt = $id("rrnb-lk-text").value.trim() || u;
      if (!u) return; if (!/^[a-z]+:/i.test(u)) u = "https://" + u;
      $id("rrnb-editor").focus(); restoreSelection(range);
      insertHTMLAtCursor('<a class="rrnb-weblink" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(txt) + '</a>&nbsp;');
      hidePop(); scheduleSave();
    });
  }

  function openPagePicker() {
    var range = savedSelection();
    var pages = ((S.tree && S.tree.pages) || []).filter(function (p) { return p.id !== S.pageId; });
    function optList(q) {
      q = (q || "").toLowerCase();
      var hits = pages.filter(function (p) { return !q || (p.title || "").toLowerCase().indexOf(q) >= 0; }).slice(0, 40)
        .map(function (p) { return '<div class="rrnb-pop-opt" data-pick-page="' + p.id + '">' + esc(p.title || "Untitled") + '</div>'; }).join("");
      // wiki behavior: linking a page that doesn't exist yet offers to create it
      if (q && !pages.some(function (p) { return (p.title || "").toLowerCase() === q; })) {
        hits += '<div class="rrnb-pop-opt" data-create-page="1" style="color:var(--accent);font-weight:600">＋ Create page “' + esc(q) + '”</div>';
      }
      return hits || '<div class="rrnb-pop-opt" style="color:var(--text-subtle)">Type a title to link or create a page</div>';
    }
    var pop = showPop('<label>Link to page</label><input id="rrnb-pp-q" placeholder="Search or create…" /><div class="rrnb-pop-list" id="rrnb-pp-list">' + optList("") + '</div>', selRect());
    var q = $id("rrnb-pp-q"); q.focus();
    q.addEventListener("input", function () { $id("rrnb-pp-list").innerHTML = optList(q.value); });
    pop.addEventListener("click", function (e) {
      if (e.target.closest("[data-create-page]")) {
        var titleQ = (($id("rrnb-pp-q") || {}).value || "").trim(); if (!titleQ) return;
        var secId = S.activeSection || (S.tree && S.tree.sections[0] && S.tree.sections[0].id);
        if (!secId) return;
        S.be.createPage(secId, titleQ, null, 0).then(function (np) {
          if (S.tree) S.tree.pages.push({ id: np.id, section_id: np.section_id, parent_page_id: null, title: np.title, level: 0, position: np.position, tags: [], is_pinned: false, updated_at: np.updated_at });
          $id("rrnb-editor").focus(); restoreSelection(range);
          insertHTMLAtCursor('<a class="rrnb-pagelink" contenteditable="false" data-page-id="' + np.id + '" href="#">' + esc(np.title) + '</a>&nbsp;');
          hidePop(); scheduleSave(); renderPageList();
          notify('Created “' + np.title + '”');
        }).catch(fail);
        return;
      }
      var o = e.target.closest("[data-pick-page]"); if (!o) return;
      var pid = o.getAttribute("data-pick-page"); var pg = pages.filter(function (p) { return p.id === pid; })[0];
      $id("rrnb-editor").focus(); restoreSelection(range);
      insertHTMLAtCursor('<a class="rrnb-pagelink" contenteditable="false" data-page-id="' + pid + '" href="#">' + esc(pg ? pg.title : "page") + '</a>&nbsp;');
      hidePop(); scheduleSave();
    });
  }

  // ── table editing: Tab cell-nav (last cell appends a row) + controls ──
  function cellOf(node) {
    while (node && node.nodeType === 3) node = node.parentNode;
    return node && node.closest ? node.closest("td,th") : null;
  }
  function tableTabKey(e) {
    if (e.key !== "Tab") return false;
    var ed = $id("rrnb-editor"); if (!ed) return false;
    var sel = window.getSelection();
    var cell = sel && sel.anchorNode ? cellOf(sel.anchorNode) : null;
    if (!cell || !ed.contains(cell)) return false;
    e.preventDefault();
    var table = cell.closest("table");
    var cells = Array.prototype.slice.call(table.querySelectorAll("td,th"));
    var i = cells.indexOf(cell);
    if (e.shiftKey) { if (i > 0) caretToEl(cells[i - 1], false); return true; }
    if (i < cells.length - 1) { caretToEl(cells[i + 1], false); return true; }
    var lastRow = cell.closest("tr");
    var tr = document.createElement("tr");
    for (var c = 0; c < lastRow.cells.length; c++) { var td = document.createElement("td"); td.appendChild(document.createElement("br")); tr.appendChild(td); }
    (table.tBodies[0] || table).appendChild(tr);
    caretToEl(tr.cells[0], true);
    scheduleSave();
    return true;
  }
  function onEditorCtx(e) {
    var ed = $id("rrnb-editor");
    var cell = e.target.closest && e.target.closest("td,th");
    if (cell && ed && ed.contains(cell)) { e.preventDefault(); showTableControls(cell); return; }
    // block objects: right-click any of them to delete it
    var node = e.target.closest && e.target.closest("figure.rrnb-fig,.rrnb-file,.rrnb-callout,.rrnb-todo,hr");
    if (node && ed && ed.contains(node)) {
      e.preventDefault();
      var label = node.classList.contains("rrnb-fig") ? "picture"
        : node.classList.contains("rrnb-file") ? "attachment"
        : node.classList.contains("rrnb-callout") ? "callout"
        : node.classList.contains("rrnb-todo") ? "to-do" : "divider";
      showCtx(e.clientX, e.clientY, [{ act: "del", label: "Delete " + label, danger: true }]);
      $id("rrnb-ctx")._target = { kind: "ednode", el: node };
    }
  }
  function showTableControls(cell) {
    var table = cell.closest("table"); if (!table) return;
    var pop = showPop('<label>Table</label><div class="rrnb-tablectl">' +
      '<button data-tbl="row+">＋ Row</button><button data-tbl="col+">＋ Column</button>' +
      '<button data-tbl="row-" class="danger">− Row</button><button data-tbl="col-" class="danger">− Column</button>' +
      '<button data-tbl="del" class="danger">Delete table</button></div>', cell.getBoundingClientRect());
    pop.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-tbl]"); if (!b) return;
      var act = b.getAttribute("data-tbl");
      var tr = cell.closest("tr"); var ci = cell.cellIndex;
      var rows = Array.prototype.slice.call(table.querySelectorAll("tr"));
      if (act === "del" || (act === "row-" && rows.length <= 1) || (act === "col-" && tr.cells.length <= 1)) {
        table.remove();
      } else if (act === "row+") {
        var nr = document.createElement("tr");
        for (var c = 0; c < tr.cells.length; c++) { var td = document.createElement("td"); td.appendChild(document.createElement("br")); nr.appendChild(td); }
        tr.parentNode.insertBefore(nr, tr.nextSibling);
      } else if (act === "row-") {
        tr.remove();
      } else if (act === "col+") {
        rows.forEach(function (r) {
          var el = document.createElement(r.parentNode && r.parentNode.tagName === "THEAD" ? "th" : "td");
          el.appendChild(document.createElement("br"));
          var ref = r.cells[ci] || null;
          r.insertBefore(el, ref ? ref.nextSibling : null);
        });
      } else if (act === "col-") {
        rows.forEach(function (r) { if (r.cells[ci]) r.cells[ci].remove(); });
      }
      hidePop(); scheduleSave();
    });
  }

  function openTablePicker() {
    var range = savedSelection();
    showPop('<label>Insert table</label><div class="rrnb-pop-row"><div><label>Rows</label><input id="rrnb-tb-r" type="number" min="1" max="20" value="3" /></div><div><label>Columns</label><input id="rrnb-tb-c" type="number" min="1" max="12" value="3" /></div><button class="rrnb-pop-btn" id="rrnb-tb-ok">Insert</button></div>', selRect());
    $id("rrnb-tb-ok").addEventListener("click", function () {
      var rows = Math.max(1, Math.min(20, +$id("rrnb-tb-r").value || 3));
      var cols = Math.max(1, Math.min(12, +$id("rrnb-tb-c").value || 3));
      var html = "<table><thead><tr>";
      for (var c = 0; c < cols; c++) html += "<th>Column " + (c + 1) + "</th>";
      html += "</tr></thead><tbody>";
      for (var r = 0; r < rows; r++) { html += "<tr>"; for (var c2 = 0; c2 < cols; c2++) html += "<td><br></td>"; html += "</tr>"; }
      html += "</tbody></table><p><br></p>";
      $id("rrnb-editor").focus(); restoreSelection(range); insertHTMLAtCursor(html); hidePop(); scheduleSave();
    });
  }

  // ── smart-linking: detect Van 27 / Route 341 / driver names ──────
  // Entity index: real drivers (_rosterRows) + vehicles (_fleetRows) if those
  // views have loaded; otherwise a lightweight one-time fetch. Names longer
  // than 3 chars only, sorted longest-first so "John Smith" wins over "John".
  var _entIndex = null, _entLoading = false;
  function buildEntIndex(rows) {
    var list = [];
    ((window._rosterRows) || []).forEach(function (d) { var nm = (d.full_name || "").trim(); if (nm.length > 3) list.push({ type: "driver", id: d.id, name: nm }); });
    ((window._fleetRows) || []).forEach(function (v) { var nm = (v.name || v.plate || "").trim(); if (nm.length > 2) list.push({ type: "vehicle", id: v.id, name: nm }); });
    (rows || []).forEach(function (r) { if (r && r.name) list.push(r); });
    // longest names first for greedy matching
    list.sort(function (a, b) { return b.name.length - a.name.length; });
    return list;
  }
  function ensureEntIndex(cb) {
    // prefer already-loaded globals
    if ((window._rosterRows && window._rosterRows.length) || (window._fleetRows && window._fleetRows.length)) { _entIndex = buildEntIndex(); return cb(_entIndex); }
    if (_entIndex) return cb(_entIndex);
    if (_entLoading) return cb([]);
    var sb = (window.RR && window.RR.sb) || window.sb, dsp = window.RR && window.RR.dsp && window.RR.dsp.id;
    if (!sb || !dsp) { _entIndex = buildEntIndex(); return cb(_entIndex); }
    _entLoading = true;
    Promise.all([
      sb.from("drivers").select("id, full_name").eq("dsp_id", dsp).neq("status", "terminated").limit(500).then(function (r) { return r.data || []; }, function () { return []; }),
      sb.from("vehicles").select("id, name").eq("dsp_id", dsp).is("archived_at", null).limit(500).then(function (r) { return r.data || []; }, function () { return []; })
    ]).then(function (res) {
      var extra = [];
      (res[0] || []).forEach(function (d) { var nm = (d.full_name || "").trim(); if (nm.length > 3) extra.push({ type: "driver", id: d.id, name: nm }); });
      (res[1] || []).forEach(function (v) { var nm = (v.name || "").trim(); if (nm.length > 2) extra.push({ type: "vehicle", id: v.id, name: nm }); });
      _entIndex = buildEntIndex(extra); _entLoading = false; cb(_entIndex);
    }, function () { _entLoading = false; _entIndex = buildEntIndex(); cb(_entIndex); });
  }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Absolute caret offset within the editor (counts all text, incl. inside
  // existing links) — mirrors Range.toString() so it round-trips with setCaretAt.
  function caretOffsetIn(el) {
    var sel = window.getSelection(); if (!sel || !sel.rangeCount) return -1;
    var r = sel.getRangeAt(0); if (!el.contains(r.startContainer)) return -1;
    var pre = document.createRange(); pre.selectNodeContents(el);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return -1; }
    return pre.toString().length;
  }
  function setCaretAt(el, offset) {
    if (offset < 0) return; var acc = 0, target = null, toff = 0;
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length && !target; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) { var len = c.nodeValue.length; if (acc + len >= offset) { target = c; toff = offset - acc; } else acc += len; }
        else if (c.nodeType === 1) walk(c);
      }
    })(el);
    if (target) { var r = document.createRange(); r.setStart(target, Math.max(0, Math.min(toff, target.nodeValue.length))); r.collapse(true); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  // Snapshot linkable text nodes with their absolute start offsets. Text inside
  // A/PRE/CODE still advances the offset (so caret math stays aligned) but isn't
  // itself linkable (never link inside a link or a code block).
  function snapshotTextNodes(root) {
    var nodes = [], acc = { v: 0 };
    (function walk(node, linkable) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) { if (linkable) nodes.push({ node: c, start: acc.v, text: c.nodeValue }); acc.v += c.nodeValue.length; }
        else if (c.nodeType === 1) walk(c, linkable && !/^(A|PRE|CODE)$/.test(c.tagName));
      }
    })(root, true);
    return nodes;
  }
  function makeObjLink(word, byName) {
    var a = document.createElement("a"); a.className = "rrnb-objlink"; a.href = "#";
    a.setAttribute("contenteditable", "false");   // atomic clickable chip, not editable text
    a.setAttribute("data-obj-name", word);
    var known = byName[word.toLowerCase()];
    if (known) { a.setAttribute("data-obj-type", known.type); a.setAttribute("data-obj-id", known.id); }
    else {
      // A pattern match ("Van 27", "Route 341") that isn't a real roster/fleet
      // record. NEVER fabricate a digit-only id that points at nothing — mark it
      // unresolved so a click opens the resolver to pick the real record.
      a.className += " rrnb-objlink-unresolved";
      a.setAttribute("data-obj-unresolved", "1");
      a.title = "Not linked yet — click to connect this to a record";
    }
    a.textContent = word; return a;
  }
  // Resolve an unresolved object chip to a real record. Offers roster/fleet
  // candidates matching the chip text (a plain digit token also matches a
  // vehicle by number), plus "Keep as text" to unlink. On pick, the chip gets
  // the real type + id and autosaves; the context rail refreshes.
  function openObjResolver(el) {
    if (!el) return;
    var word = el.getAttribute("data-obj-name") || el.textContent || "";
    var digits = word.replace(/\D+/g, "");
    ensureEntIndex(function (index) {
      index = index || [];
      var wl = word.toLowerCase();
      var hits = index.filter(function (e2) {
        var n = e2.name.toLowerCase();
        return n.indexOf(wl) >= 0 || wl.indexOf(n) >= 0 || (digits && (e2.type === "vehicle") && e2.name.replace(/\D+/g, "") === digits);
      }).slice(0, 8);
      var html = '<div class="rrnb-oh">Link “' + esc(word) + '” to a record</div>';
      if (hits.length) {
        html += hits.map(function (h) {
          return '<button type="button" class="rrnb-orow" data-resolve-type="' + esc(h.type) + '" data-resolve-id="' + esc(h.id) + '" data-resolve-name="' + esc(h.name) + '">' +
            '<span class="rrnb-oic" style="background:' + (CTX_COLORS[h.type] || "var(--accent)") + '">' + esc(recInitials(h.name)) + '</span>' +
            '<span class="rrnb-otx"><b>' + esc(h.name) + '</b><span class="mut">' + esc(h.type) + '</span></span></button>';
        }).join("");
      } else {
        html += '<div class="rrnb-oempty">No matching driver or vehicle found.</div>';
      }
      html += '<div class="rrnb-osep"></div><button type="button" class="rrnb-orow" data-resolve-unlink="1"><span class="rrnb-oic mut">×</span><span class="rrnb-otx">Keep as plain text</span></button>';
      var pop = showPop(html, el.getBoundingClientRect());
      pop.classList.add("rrnb-objresolve");
      S._resolveEl = el;
      bindResolveOnce(pop);
    });
  }
  function bindResolveOnce(pop) {
    if (pop._resolveBound) return; pop._resolveBound = true;
    pop.addEventListener("click", function (e) {
      var el = S._resolveEl; if (!el) return;
      if (e.target.closest("[data-resolve-unlink]")) {
        var tn = document.createTextNode(el.textContent || ""); if (el.parentNode) el.parentNode.replaceChild(tn, el);
        pop.classList.remove("rrnb-objresolve"); hidePop(); scheduleSave(); return;
      }
      var row = e.target.closest("[data-resolve-type]");
      if (row) {
        el.setAttribute("data-obj-type", row.getAttribute("data-resolve-type"));
        el.setAttribute("data-obj-id", row.getAttribute("data-resolve-id"));
        el.setAttribute("data-obj-name", row.getAttribute("data-resolve-name"));
        el.removeAttribute("data-obj-unresolved");
        el.classList.remove("rrnb-objlink-unresolved");
        el.title = "";
        pop.classList.remove("rrnb-objresolve"); hidePop(); scheduleSave();
        if (S.page) renderContextRail(S.page, true);
      }
    });
  }
  // The linkifier. caretAware=true (auto-as-you-type): only link matches that
  // END at or before the caret, then restore the caret — so what you just
  // finished typing links, but the word under construction and anything after
  // the caret are left alone. caretAware=false (⚡ button): link the whole page.
  function linkifyEditor(caretAware, manual) {
    var ed = $id("rrnb-editor"); if (!ed) return;
    ensureEntIndex(function (index) {
      var names = (index || []).slice(0, 400).map(function (e) { return reEsc(e.name); });
      var byName = {}; (index || []).forEach(function (e) { byName[e.name.toLowerCase()] = e; });
      var reParts = [];
      if (names.length) reParts.push("(?:" + names.join("|") + ")");
      reParts.push("(?:Van|Vehicle)\\s*#?\\s*\\d{1,4}");
      reParts.push("Route\\s*#?\\s*[A-Z]{0,2}\\d{1,4}");
      var re = new RegExp("\\b(" + reParts.join("|") + ")\\b", "g");
      var caretAbs = caretAware ? caretOffsetIn(ed) : -1;
      var nodes = snapshotTextNodes(ed);
      var replaced = 0;
      nodes.forEach(function (rec) {
        var text = rec.text; if (!text || text.length < 2) return;
        var out = document.createDocumentFragment(); var last = 0, m, hit = false; re.lastIndex = 0;
        while ((m = re.exec(text))) {
          var absEnd = rec.start + m.index + m[0].length;
          if (caretAware && caretAbs >= 0 && absEnd >= caretAbs) break;  // stop before the caret — the word there may still be growing
          out.appendChild(document.createTextNode(text.slice(last, m.index)));
          out.appendChild(makeObjLink(m[0], byName)); last = m.index + m[0].length; replaced++; hit = true;
        }
        if (hit) { out.appendChild(document.createTextNode(text.slice(last))); rec.node.parentNode.replaceChild(out, rec.node); }
      });
      if (replaced) {
        // Rewriting text nodes can drop the caret/focus out of the editor —
        // which then lets the app's single-key hotkeys (guarded on
        // activeElement.isContentEditable) fire on your next keystroke. Put
        // focus + caret back so typing continues seamlessly.
        if (caretAware && caretAbs >= 0) { try { ed.focus({ preventScroll: true }); } catch (e2) { ed.focus(); } setCaretAt(ed, caretAbs); }
        scheduleSave(); persistLinks(S.pageId);
        if (manual) notify(replaced + " link" + (replaced > 1 ? "s" : "") + " added");
      } else if (manual) notify("No drivers, vehicles or routes recognized on this page");
    });
  }
  function smartLink(manual) { linkifyEditor(false, manual); }

  // ── web URLs → clickable links ────────────────────────────────────────
  // Turn bare "https://…" / "www.…" text into real anchors (OneNote-style),
  // skipping text already inside a link / code block (snapshotTextNodes does
  // the skipping). caretAware leaves the URL you're mid-typing alone until the
  // caret moves past it; paste calls it with caretAware=false so a pasted URL
  // links immediately.
  var WEB_URL_RE = /(?:https?:\/\/|www\.)[^\s<>]+[^\s<>.,;:!?'"”’)\]}]/gi;
  function makeWebLink(url) {
    var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
    var a = document.createElement("a");
    a.className = "rrnb-weblink"; a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.title = href + " — click to open";
    a.textContent = url; return a;
  }
  function linkifyUrls(caretAware) {
    var ed = $id("rrnb-editor"); if (!ed) return 0;
    var caretAbs = caretOffsetIn(ed);
    var nodes = snapshotTextNodes(ed);
    var replaced = 0;
    nodes.forEach(function (rec) {
      var text = rec.text; if (!text || text.length < 5 || text.indexOf(".") < 0) return;
      var out = document.createDocumentFragment(); var last = 0, m, hit = false; WEB_URL_RE.lastIndex = 0;
      while ((m = WEB_URL_RE.exec(text))) {
        var absEnd = rec.start + m.index + m[0].length;
        if (caretAware && caretAbs >= 0 && absEnd >= caretAbs) break;  // don't touch the URL still under the caret
        out.appendChild(document.createTextNode(text.slice(last, m.index)));
        out.appendChild(makeWebLink(m[0])); last = m.index + m[0].length; replaced++; hit = true;
      }
      if (hit) { out.appendChild(document.createTextNode(text.slice(last))); rec.node.parentNode.replaceChild(out, rec.node); }
    });
    if (replaced) {
      // wrapping preserves total text length, so the absolute caret offset still maps back
      if (caretAbs >= 0) { try { ed.focus({ preventScroll: true }); } catch (e2) { ed.focus(); } setCaretAt(ed, caretAbs); }
      scheduleSave();
    }
    return replaced;
  }

  // Auto-link ~1.4s after a pause in typing (URLs first, then entity chips).
  var autoLinkify = debounce(function () { if (S.pageId) { linkifyUrls(true); linkifyEditor(true, false); } }, 1400);

  // ══════════════════════════════════════════════════════════════════
  //  SLASH MENU (classic editor) — type "/" at the start of a block (or
  //  after a space) to insert a block: heading, list, checklist, table,
  //  callout, picture, link, record link… It dispatches to the SAME
  //  commands the toolbar uses (doCommand / applyBlock), so there's no
  //  parallel code path to keep in sync. Never steals caret focus.
  // ══════════════════════════════════════════════════════════════════
  var SLASH_CMDS = [
    { cmd: "H1", block: true, label: "Heading 1", kw: "heading title h1", ic: "H1" },
    { cmd: "H2", block: true, label: "Heading 2", kw: "heading subheading h2", ic: "H2" },
    { cmd: "H3", block: true, label: "Heading 3", kw: "heading h3", ic: "H3" },
    { cmd: "todo", label: "To-do checklist", kw: "todo task checkbox check", ic: "☑" },
    { cmd: "insertUnorderedList", label: "Bulleted list", kw: "bullet unordered list", ic: "•" },
    { cmd: "insertOrderedList", label: "Numbered list", kw: "number ordered list", ic: "1." },
    { cmd: "quote", label: "Quote", kw: "quote blockquote", ic: "❝" },
    { cmd: "callout", label: "Callout", kw: "callout note tip info highlight", ic: "💡" },
    { cmd: "code", label: "Code block", kw: "code pre monospace", ic: "{ }" },
    { cmd: "table", label: "Table", kw: "table grid rows columns", ic: "▦" },
    { cmd: "hr", label: "Divider", kw: "divider hr line rule separator", ic: "—" },
    { cmd: "image", label: "Picture", kw: "image picture photo upload", ic: "▧" },
    { cmd: "attach", label: "File attachment", kw: "file attach upload document", ic: "📎" },
    { cmd: "link", label: "Web link", kw: "link url web hyperlink", ic: "🔗" },
    { cmd: "pagelink", label: "Link to page", kw: "page wiki internal link", ic: "❏" },
    { cmd: "smartlink", label: "Link records (drivers, vehicles, routes)", kw: "record driver vehicle route smart link connect", ic: "⚡" }
  ];
  var SL = { open: false, node: null, at: 0, items: [], sel: 0, el: null };
  function slashEl() {
    if (SL.el) return SL.el;
    var d = document.createElement("div"); d.className = "rrnb-slash"; d.id = "rrnb-slash"; d.hidden = true;
    d.addEventListener("mousedown", function (e) { e.preventDefault(); });               // keep the caret in the editor
    d.addEventListener("click", function (e) { var r = e.target.closest("[data-si]"); if (r) slashPick(SL.items[+r.getAttribute("data-si")]); });
    document.body.appendChild(d);
    document.addEventListener("mousedown", function (e) { if (SL.open && SL.el && !SL.el.contains(e.target)) slashClose(); });
    SL.el = d; return d;
  }
  function slashRender() {
    var d = slashEl();
    d.innerHTML = SL.items.length
      ? SL.items.map(function (it, i) { return '<div class="rrnb-slash-opt' + (i === SL.sel ? " sel" : "") + '" data-si="' + i + '"><span class="ic">' + esc(it.ic) + '</span>' + esc(it.label) + '</div>'; }).join("")
      : '<div class="rrnb-slash-opt mut">No matching block</div>';
  }
  function slashClose() { SL.open = false; SL.node = null; if (SL.el) SL.el.hidden = true; }
  function caretRect() {
    var s = window.getSelection(); if (!s || !s.rangeCount) return null;
    var r = s.getRangeAt(0).cloneRange(); r.collapse(true);
    var rects = r.getClientRects(); var rr = (rects && rects[0]) || r.getBoundingClientRect();
    return (rr && (rr.width || rr.height || rr.top || rr.left)) ? rr : null;
  }
  function slashScan() {
    if (S.readOnly || S.editorKind === "tiptap") return slashClose();
    var ed = $id("rrnb-editor"); if (!ed) return slashClose();
    var s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return slashClose();
    var node = s.anchorNode;
    if (!node || node.nodeType !== 3 || !ed.contains(node)) return slashClose();
    if (node.parentNode && node.parentNode.closest && node.parentNode.closest("a,pre,code")) return slashClose();
    var m = /(^|\s)\/([\w-]*)$/.exec(node.nodeValue.slice(0, s.anchorOffset));
    if (!m) return slashClose();
    var q = m[2].toLowerCase();
    SL.node = node; SL.at = s.anchorOffset - m[2].length - 1;       // index of the "/"
    SL.items = SLASH_CMDS.filter(function (it) { return !q || it.label.toLowerCase().indexOf(q) >= 0 || it.kw.indexOf(q) >= 0; });
    SL.sel = 0; SL.open = true; slashRender();
    var d = slashEl(); d.hidden = false;
    var rect = caretRect() || selRect();
    if (rect) {
      d.style.left = Math.max(12, Math.min(window.innerWidth - d.offsetWidth - 12, rect.left)) + "px";
      var top = rect.bottom + 6;
      if (top + d.offsetHeight > window.innerHeight - 12) top = Math.max(12, rect.top - d.offsetHeight - 6);
      d.style.top = top + "px";
    }
  }
  function slashKey(e) {
    if (!SL.open) return false;
    var n = Math.max(1, SL.items.length);
    if (e.key === "ArrowDown") { e.preventDefault(); SL.sel = (SL.sel + 1) % n; slashRender(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); SL.sel = (SL.sel - 1 + n) % n; slashRender(); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); slashPick(SL.items[SL.sel]); return true; }
    if (e.key === "Escape") { e.preventDefault(); slashClose(); return true; }
    return false;
  }
  function slashPick(it) {
    if (!it) { slashClose(); return; }
    var ed = $id("rrnb-editor"); if (ed) ed.focus();
    var s = window.getSelection();
    // strip the "/query" trigger text, keeping the text node in place so the caret survives
    if (SL.node && s && s.anchorNode === SL.node) {
      var v = SL.node.nodeValue; SL.node.nodeValue = v.slice(0, SL.at) + v.slice(s.anchorOffset);
      try { var r = document.createRange(); r.setStart(SL.node, SL.at); r.collapse(true); s.removeAllRanges(); s.addRange(r); } catch (e2) {}
    }
    slashClose();
    if (it.block) applyBlock(it.cmd); else doCommand(it.cmd);
  }

  // ══════════════════════════════════════════════════════════════════
  //  DRAG-TO-REORDER BLOCKS (classic editor) — a hover grip in the left
  //  margin lets you pick up a top-level block (paragraph, heading, list,
  //  table, callout, to-do, picture…) and drop it elsewhere, with a live
  //  drop line. The grip is a separate draggable element (not the editable
  //  content), so dragging never selects or splits text. Classic only.
  // ══════════════════════════════════════════════════════════════════
  var DH = { el: null, line: null, block: null, dragging: false, target: null };
  function dhEl() {
    if (DH.el) return DH.el;
    var h = document.createElement("div");
    h.className = "rrnb-draghandle"; h.id = "rrnb-draghandle"; h.hidden = true; h.setAttribute("draggable", "true");
    h.title = "Drag to move this block";
    h.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor">' +
      '<circle cx="2.5" cy="3" r="1.15"/><circle cx="7.5" cy="3" r="1.15"/><circle cx="2.5" cy="8" r="1.15"/>' +
      '<circle cx="7.5" cy="8" r="1.15"/><circle cx="2.5" cy="13" r="1.15"/><circle cx="7.5" cy="13" r="1.15"/></g></svg>';
    document.body.appendChild(h);
    h.addEventListener("dragstart", dhDragStart);
    h.addEventListener("dragend", dhDragEnd);
    h.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openBlockMenu(); });   // click (not drag) → actions
    DH.el = h; return h;
  }
  function dhLine() {
    if (DH.line) return DH.line;
    var l = document.createElement("div"); l.className = "rrnb-dropline"; l.hidden = true;
    document.body.appendChild(l); DH.line = l; return l;
  }
  function hideHandle() { if (DH.el && !DH.dragging) DH.el.hidden = true; }
  function topBlockOf(node, ed) {
    while (node && node.parentNode !== ed) node = node.parentNode;
    return (node && node.nodeType === 1 && node !== DH.el && node !== DH.line) ? node : null;
  }
  function dhMouseMove(e) {
    if (DH.dragging || S.readOnly || S.editorKind === "tiptap") return;
    var ed = $id("rrnb-editor"); if (!ed) return;
    if (DH.el && (e.target === DH.el || DH.el.contains(e.target))) return;   // hovering the grip itself
    var blk = topBlockOf(e.target, ed);
    if (!blk || blk.tagName === "HR") { hideHandle(); return; }
    DH.block = blk;
    var h = dhEl(), r = blk.getBoundingClientRect();
    h.style.top = (r.top + 2) + "px";
    h.style.left = Math.max(6, r.left - 22) + "px";
    h.hidden = false;
  }
  function dhBlocks(ed) {
    return [].slice.call(ed.children).filter(function (c) { return c.nodeType === 1 && c !== DH.el && c !== DH.line; });
  }
  function dhTargetAt(ed, y) {
    var kids = dhBlocks(ed);
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return { block: kids[i], before: true };
    }
    return kids.length ? { block: kids[kids.length - 1], before: false } : null;
  }
  function dhDragStart(e) {
    if (!DH.block) { e.preventDefault(); return; }
    DH.dragging = true; DH.el.classList.add("grabbing");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/rrnb-block", "1"); } catch (x) {}
    try { e.dataTransfer.setDragImage(DH.block, 12, 12); } catch (x) {}
  }
  function dhDragOver(e) {
    e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (x) {}
    var ed = $id("rrnb-editor"); if (!ed) return;
    var t = dhTargetAt(ed, e.clientY); DH.target = t;
    var l = dhLine();
    if (!t) { l.hidden = true; return; }
    var r = t.block.getBoundingClientRect();
    l.style.left = r.left + "px"; l.style.width = r.width + "px";
    l.style.top = ((t.before ? r.top : r.bottom) - 1) + "px";
    l.hidden = false;
  }
  function dhDrop(e) {
    e.preventDefault();
    var ed = $id("rrnb-editor");
    var t = DH.target || (ed && dhTargetAt(ed, e.clientY));
    if (ed && t && DH.block && t.block !== DH.block) {
      if (t.before) ed.insertBefore(DH.block, t.block);
      else ed.insertBefore(DH.block, t.block.nextSibling);
      scheduleSave(); persistLinks(S.pageId);
    }
    dhDragEnd();
  }
  function dhDragEnd() {
    DH.dragging = false; DH.target = null;
    if (DH.el) { DH.el.classList.remove("grabbing"); DH.el.hidden = true; }
    if (DH.line) DH.line.hidden = true;
    var ed = $id("rrnb-editor"); if (ed) ed.classList.remove("rrnb-drop");
  }

  // ── block action menu — click the grip to turn a block into another
  //    type, duplicate it, or delete it. Operates on the grip's block, not
  //    the caret. Reuses formatBlock/execCommand, so conversions match the
  //    toolbar. ─────────────────────────────────────────────────────────
  var BLOCK_ACTIONS = [
    { head: true, label: "Turn into" },
    { act: "turn", arg: "P", label: "Text", ic: "¶" },
    { act: "turn", arg: "H1", label: "Heading 1", ic: "H1" },
    { act: "turn", arg: "H2", label: "Heading 2", ic: "H2" },
    { act: "turn", arg: "H3", label: "Heading 3", ic: "H3" },
    { act: "turn", arg: "ul", label: "Bulleted list", ic: "•" },
    { act: "turn", arg: "ol", label: "Numbered list", ic: "1." },
    { act: "turn", arg: "quote", label: "Quote", ic: "❝" },
    { sep: true },
    { act: "dup", label: "Duplicate", ic: "⧉" },
    { act: "del", label: "Delete", ic: "✕", danger: true }
  ];
  var BM = { el: null, block: null };
  function blockMenuEl() {
    if (BM.el) return BM.el;
    var m = document.createElement("div"); m.className = "rrnb-slash rrnb-blockmenu"; m.id = "rrnb-blockmenu"; m.hidden = true;
    m.addEventListener("mousedown", function (e) { e.preventDefault(); });
    m.addEventListener("click", function (e) { var r = e.target.closest("[data-bi]"); if (r) blockAction(BLOCK_ACTIONS[+r.getAttribute("data-bi")]); });
    document.body.appendChild(m);
    document.addEventListener("mousedown", function (e) { if (!BM.el || BM.el.hidden) return; if (BM.el.contains(e.target) || (DH.el && DH.el.contains(e.target))) return; closeBlockMenu(); });
    BM.el = m; return m;
  }
  function openBlockMenu() {
    if (!DH.block || S.readOnly || S.editorKind === "tiptap") return;
    BM.block = DH.block;
    var m = blockMenuEl();
    m.innerHTML = BLOCK_ACTIONS.map(function (a, i) {
      if (a.head) return '<div class="rrnb-bm-head">' + esc(a.label) + '</div>';
      if (a.sep) return '<div class="rrnb-bm-sep"></div>';
      return '<div class="rrnb-slash-opt' + (a.danger ? " danger" : "") + '" data-bi="' + i + '"><span class="ic">' + esc(a.ic) + '</span>' + esc(a.label) + '</div>';
    }).join("");
    m.hidden = false;
    var r = DH.el.getBoundingClientRect();
    m.style.left = Math.max(12, Math.min(window.innerWidth - m.offsetWidth - 12, r.right + 4)) + "px";
    var top = r.top; if (top + m.offsetHeight > window.innerHeight - 12) top = Math.max(12, window.innerHeight - m.offsetHeight - 12);
    m.style.top = top + "px";
  }
  function closeBlockMenu() { if (BM.el) BM.el.hidden = true; BM.block = null; }
  function blockAction(a) {
    var blk = BM.block; var ed = $id("rrnb-editor");
    if (!a || !blk || !ed) { closeBlockMenu(); return; }
    if (a.act === "turn") {
      var nb2 = convertBlock(blk, a.arg);
      if (nb2) { ed.focus(); try { var rg = document.createRange(); rg.selectNodeContents(nb2.tagName === "UL" || nb2.tagName === "OL" ? (nb2.querySelector("li") || nb2) : nb2); rg.collapse(false); var s = window.getSelection(); s.removeAllRanges(); s.addRange(rg); } catch (e3) {} }
      scheduleSave(); persistLinks(S.pageId);
    } else if (a.act === "dup") {
      ed.insertBefore(blk.cloneNode(true), blk.nextSibling); scheduleSave(); persistLinks(S.pageId);
    } else if (a.act === "del") {
      blk.remove(); if (!ed.firstChild) ed.innerHTML = "<p><br></p>"; scheduleSave(); persistLinks(S.pageId);
    }
    closeBlockMenu(); hideHandle();
  }
  // Deterministic block conversion (no execCommand — it nests <ul> inside <p>).
  // Moves the block's actual child nodes, so inline record links survive.
  function bmMove(from, to) { while (from.firstChild) to.appendChild(from.firstChild); if (!to.firstChild) to.appendChild(document.createElement("br")); }
  function convertBlock(blk, arg) {
    if (!blk || !blk.parentNode) return null;
    var isList = blk.tagName === "UL" || blk.tagName === "OL";
    if (arg === "ul" || arg === "ol") {
      if (isList) { if (blk.tagName.toLowerCase() === arg) return blk; var nl = document.createElement(arg); while (blk.firstChild) nl.appendChild(blk.firstChild); blk.parentNode.replaceChild(nl, blk); return nl; }
      var list = document.createElement(arg), li = document.createElement("li");
      bmMove(blk, li); list.appendChild(li); blk.parentNode.replaceChild(list, blk); return list;
    }
    var tag = arg === "P" ? "p" : arg === "quote" ? "blockquote" : arg.toLowerCase();   // h1/h2/h3
    var el = document.createElement(tag);
    if (isList) { el.innerHTML = [].slice.call(blk.querySelectorAll("li")).map(function (li) { return li.innerHTML; }).join("<br>") || "<br>"; }
    else bmMove(blk, el);
    blk.parentNode.replaceChild(el, blk); return el;
  }

  // ── code-block copy button — a floating "Copy" chip on hover over a
  //    <pre>. An overlay (not injected into content), so it never persists
  //    into the saved HTML. Classic editor only. ──────────────────────────
  var CP = { el: null, pre: null };
  function cpEl() {
    if (CP.el) return CP.el;
    var b = document.createElement("button"); b.type = "button"; b.className = "rrnb-codecopy"; b.id = "rrnb-codecopy"; b.hidden = true; b.textContent = "Copy";
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); cpDo(); });
    document.body.appendChild(b); CP.el = b; return b;
  }
  function cpHide() { if (CP.el && !CP.el.classList.contains("done")) { CP.el.hidden = true; CP.pre = null; } }
  function cpDo() {
    if (!CP.pre) return;
    var text = CP.pre.innerText || CP.pre.textContent || "";
    var done = function () { var b = cpEl(); b.textContent = "Copied"; b.classList.add("done"); setTimeout(function () { if (CP.el) { CP.el.textContent = "Copy"; CP.el.classList.remove("done"); CP.el.hidden = true; } }, 1100); };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done); else done(); }
    catch (e) { done(); }
  }
  function cpMouseMove(e) {
    if (S.readOnly || S.editorKind === "tiptap") return;
    var ed = $id("rrnb-editor"); if (!ed) return;
    if (CP.el && (e.target === CP.el || CP.el.contains(e.target))) return;
    var pre = e.target.closest ? e.target.closest("pre") : null;
    if (!pre || !ed.contains(pre)) { cpHide(); return; }
    CP.pre = pre;
    var el = cpEl(); el.hidden = false;
    var r = pre.getBoundingClientRect();
    el.style.top = (r.top + 6) + "px";
    el.style.left = (r.right - el.offsetWidth - 8) + "px";
  }

  // ══════════════════════════════════════════════════════════════════
  //  SEARCH
  // ══════════════════════════════════════════════════════════════════
  var runSearch = debounce(function (q) {
    var host = $id("rrnb-pagelist"); if (!host) return;
    // "#tag" tokens filter by tag; the rest is the text query
    var tag = null;
    q = String(q || "").replace(/(^|\s)#([\w-]+)/g, function (_, sp, t) { if (!tag) tag = t.toLowerCase(); return sp; }).trim();
    var label = q || (tag ? "#" + tag : "");
    S.be.search(q, { tag: tag }).then(function (rows) {
      S.mode = "search";
      if (!rows || !rows.length) { host.innerHTML = '<div class="rrnb-empty">No results for “' + esc(label) + '”.</div>'; return; }
      host.innerHTML = '<div class="rrnb-plgroup-hd">' + rows.length + ' result' + (rows.length > 1 ? "s" : "") + '</div>' + rows.map(function (r) {
        return '<div class="rrnb-page" data-search-page="' + r.id + '" data-search-nb="' + r.notebook_id + '"><div class="body">' +
          '<div class="ttl">' + esc(r.title || "Untitled") + '</div>' +
          '<div class="sub">' + esc(r.notebook_name || "") + (r.section_name ? ' › ' + esc(r.section_name) : "") + '</div>' +
          (r.snippet ? '<div class="sub">' + r.snippet + '</div>' : "") + '</div></div>';
      }).join("");
    }).catch(fail);
  }, 180);

  // ══════════════════════════════════════════════════════════════════
  //  CONTEXT MENUS
  // ══════════════════════════════════════════════════════════════════
  function showCtx(x, y, items) {
    var ctx = $id("rrnb-ctx");
    ctx.innerHTML = items.map(function (it) { return it.sep ? '<div class="rrnb-menu-sep"></div>' :
      '<div class="rrnb-ctx-item' + (it.danger ? " danger" : "") + '" data-act="' + it.act + '">' + esc(it.label) + '</div>'; }).join("");
    ctx.hidden = false;
    ctx.style.left = Math.min(x, window.innerWidth - 200) + "px";
    ctx.style.top = Math.min(y, window.innerHeight - ctx.offsetHeight - 8) + "px";
    ctx._items = items;
  }
  function hideCtx() { var c = $id("rrnb-ctx"); if (c) { c.hidden = true; c._items = null; } }

  function pageMenu(id, x, y) {
    var p = ((S.tree && S.tree.pages) || []).filter(function (x) { return x.id === id; })[0] || {};
    var items = S.readOnly ? [
      { act: "print", label: "Print / PDF" },
      { act: "md", label: "Download as Markdown" }
    ] : [
      { act: "rename", label: "Rename" },
      { act: "pin", label: p.is_pinned ? "Unpin" : "Pin to top" },
      { act: "sub", label: "Make subpage (Tab)" },
      { act: "promote", label: "Promote (Shift+Tab)" },
      { act: "dup", label: "Duplicate" },
      { sep: 1 },
      { act: "print", label: "Print / PDF" },
      { act: "md", label: "Download as Markdown" },
      { act: "tpl", label: "Save as template" },
      { sep: 1 }, { act: "del", label: "Delete", danger: true }
    ];
    showCtx(x, y, items);
    $id("rrnb-ctx")._target = { kind: "page", id: id };
  }
  function notebookMenu(id, x, y) {
    var n = (S.notebooks || []).filter(function (x2) { return x2.id === id; })[0] || {};
    var items = [{ act: "rename", label: "Rename notebook" }];
    if (n.kind === "personal" && (n.my_role === "owner" || n.my_role == null)) {
      items.push({ act: "share", label: "Share…" + (n.member_count ? " (" + n.member_count + ")" : "") });
    }
    items.push({ sep: 1 }, { act: "del", label: "Delete notebook", danger: true });
    showCtx(x, y, items);
    $id("rrnb-ctx")._target = { kind: "notebook", id: id };
  }
  function sectionMenu(id, x, y) {
    showCtx(x, y, [
      { act: "rename", label: "Rename section" },
      { act: "recolor", label: "Change color" },
      { act: "newgroup", label: "New section group" },
      { sep: 1 }, { act: "del", label: "Delete section", danger: true }
    ]);
    $id("rrnb-ctx")._target = { kind: "section", id: id };
  }
  function groupMenu(id, x, y) {
    showCtx(x, y, [
      { act: "rename", label: "Rename group" },
      { sep: 1 }, { act: "del", label: "Delete group", danger: true }
    ]);
    $id("rrnb-ctx")._target = { kind: "group", id: id };
  }
  function handleCtx(act) {
    var t = $id("rrnb-ctx")._target; hideCtx(); if (!t) return;
    if (t.kind === "page") {
      if (act === "rename") return editPageTitle(t.id);
      if (act === "pin") { var p = pageById(t.id); return S.be.pinPage(t.id, !(p && p.is_pinned)).then(function () { if (p) p.is_pinned = !p.is_pinned; renderPageList(); }); }
      if (act === "print") return printPage(t.id);
      if (act === "md") return exportMarkdown(t.id);
      if (act === "tpl") return saveAsTemplate(t.id);
      if (act === "dup") return S.be.duplicatePage(t.id).then(function () { return selectNotebook(S.nbId, null); });
      if (act === "del") return S.be.deleteItem("page", t.id).then(function () { if (S.pageId === t.id) showBlank(); return selectNotebook(S.nbId, null); });
      if (act === "sub") return indentPage(t.id, +1);
      if (act === "promote") return indentPage(t.id, -1);
    }
    if (t.kind === "notebook") {
      if (act === "rename") return startNotebookRename(t.id);
      if (act === "share") return openSharePopover(t.id);
      if (act === "del") return deleteNotebook(t.id);
    }
    if (t.kind === "section") {
      if (act === "rename") return editSectionTitle(t.id);
      if (act === "recolor") return recolorSection(t.id);
      if (act === "newgroup") return S.be.createGroup(S.nbId, "New Group").then(function () { return selectNotebook(S.nbId, S.pageId); });
      if (act === "del") return S.be.deleteItem("section", t.id).then(function () { S.activeSection = null; return selectNotebook(S.nbId, null); });
    }
    if (t.kind === "group") {
      if (act === "rename") return editGroupTitle(t.id);
      if (act === "del") return S.be.deleteItem("group", t.id).then(function () { notify("Group deleted — its sections were kept"); return selectNotebook(S.nbId, S.pageId); });
    }
    if (t.kind === "ednode") {
      if (act === "del" && t.el) { t.el.remove(); scheduleSave(); }
      return;
    }
  }
  function pageById(id) { return ((S.tree && S.tree.pages) || []).filter(function (x) { return x.id === id; })[0]; }
  function recolorSection(id) {
    var s = ((S.tree && S.tree.sections) || []).filter(function (x) { return x.id === id; })[0]; if (!s) return;
    var cur = PALETTE.indexOf(s.color); var next = PALETTE[(cur + 1) % PALETTE.length];
    S.be.rename("section", id, s.name, next).then(function () { s.color = next; renderSections(); });
  }
  function renamePrompt(kind, id) {
    var cur = kind === "page" ? (pageById(id) || {}).title
      : (((S.tree && S.tree.sections) || []).filter(function (x) { return x.id === id; })[0] || {}).name;
    var v = window.prompt("Rename", cur || ""); if (v == null) return;
    v = v.trim(); if (!v) return;
    S.be.rename(kind, id, v).then(function () {
      if (kind === "page") { var p = pageById(id); if (p) p.title = v; if (S.pageId === id) { var t = $id("rrnb-title"); if (t) t.value = v; updateBreadcrumbTitle(); } renderPageList(); }
      else { var s = ((S.tree && S.tree.sections) || []).filter(function (x) { return x.id === id; })[0]; if (s) s.name = v; renderSections(); }
    }).catch(fail);
  }
  function indentPage(id, dir) {
    var p = pageById(id); if (!p) return;
    var lvl = Math.max(0, Math.min(2, (p.level || 0) + dir));
    var parent = p.parent_page_id;
    if (dir > 0) {
      // parent = previous top-level/lower-level sibling in the section
      var sibs = S.tree.pages.filter(function (x) { return x.section_id === p.section_id; }).sort(function (a, b) { return a.position - b.position; });
      var idx = sibs.map(function (x) { return x.id; }).indexOf(id);
      for (var i = idx - 1; i >= 0; i--) { if ((sibs[i].level || 0) < lvl) { parent = sibs[i].id; break; } }
    } else { parent = null; }
    S.be.movePage(id, { level: lvl, parent_page_id: parent }).then(function () { p.level = lvl; p.parent_page_id = parent; renderPageList(); });
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT WIRING (delegated, bound once)
  // ══════════════════════════════════════════════════════════════════
  var _bound = false;
  function bindOnce() {
    if (_bound) return; _bound = true;
    var root = ROOT(); if (!root) return;

    // notebook picker
    var cur = $id("rrnb-nb-current");
    if (cur) cur.addEventListener("click", function () { if (S._nbEditing) return; var m = $id("rrnb-nb-menu"); m.hidden = !m.hidden; });
    // inline rename: double-click the header name to edit it in place
    var nmEl = $id("rrnb-nb-name");
    if (nmEl) {
      nmEl.addEventListener("dblclick", function (e) { e.preventDefault(); e.stopPropagation(); var m = $id("rrnb-nb-menu"); if (m) m.hidden = true; if (S.nbId) beginHeaderEdit(); });
      nmEl.addEventListener("click", function (e) { if (S._nbEditing) e.stopPropagation(); });
      nmEl.addEventListener("keydown", function (e) {
        if (!S._nbEditing) return;
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); nmEl.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endHeaderEdit(false); }
        else e.stopPropagation(); // keep typing from reaching global shortcuts
      });
      nmEl.addEventListener("blur", function () { if (S._nbEditing) endHeaderEdit(true); });
    }
    // right-click the header (current notebook) for its options menu
    if (cur) cur.addEventListener("contextmenu", function (e) {
      if (S._nbEditing || !S.nbId) return;
      e.preventDefault(); var m0 = $id("rrnb-nb-menu"); if (m0) m0.hidden = true;
      notebookMenu(S.nbId, e.clientX, e.clientY);
    });
    var menu = $id("rrnb-nb-menu");
    if (menu) menu.addEventListener("contextmenu", function (e) {
      var it = e.target.closest("[data-nb]"); if (!it) return;
      e.preventDefault(); menu.hidden = true;
      notebookMenu(it.getAttribute("data-nb"), e.clientX, e.clientY);
    });
    if (menu) menu.addEventListener("click", function (e) {
      var kb = e.target.closest("[data-menu='notebook']"); if (kb) { var r = kb.getBoundingClientRect(); menu.hidden = true; return notebookMenu(kb.getAttribute("data-id"), r.left, r.bottom); }
      var addp = e.target.closest("[data-new-private]"); if (addp) { menu.hidden = true; return createNotebookFlow("personal"); }
      var add = e.target.closest("[data-new]"); if (add) { menu.hidden = true; return createNotebookFlow(); }
      var it = e.target.closest("[data-nb]"); if (it) { menu.hidden = true; S.activeSection = null; selectNotebook(it.getAttribute("data-nb")); }
    });

    // sections rail (delegated)
    var secHost = $id("rrnb-sections");
    if (secHost) secHost.addEventListener("dblclick", function (e) {
      var gh = e.target.closest(".rrnb-group-hd"); if (gh && e.target.closest(".gnm")) { e.preventDefault(); return editGroupTitle(gh.getAttribute("data-toggle")); }
      var srow = e.target.closest("[data-sec]"); if (srow && e.target.closest(".nm")) { e.preventDefault(); return editSectionTitle(srow.getAttribute("data-sec")); }
    });
    if (secHost) secHost.addEventListener("contextmenu", function (e) {
      var srow = e.target.closest("[data-sec]"); if (srow) { e.preventDefault(); return sectionMenu(srow.getAttribute("data-sec"), e.clientX, e.clientY); }
      var gh = e.target.closest(".rrnb-group-hd"); if (gh) { e.preventDefault(); return groupMenu(gh.getAttribute("data-toggle"), e.clientX, e.clientY); }
    });
    if (secHost) secHost.addEventListener("click", function (e) {
      if (S._inlineEditing) return;
      var nn = e.target.closest("[data-new-notebook]"); if (nn) return createNotebookFlow();
      var kb = e.target.closest("[data-menu='section']"); if (kb) { var r = kb.getBoundingClientRect(); return sectionMenu(kb.getAttribute("data-id"), r.left, r.bottom); }
      var tg = e.target.closest("[data-toggle]"); if (tg) { var g = tg.getAttribute("data-toggle"); S.collapsedGroups[g] = !S.collapsedGroups[g]; return renderSections(); }
      var add = e.target.closest("[data-add-section]"); if (add) { return S.be.createSection(S.nbId, "New Section", null, PALETTE[(S.tree.sections.length) % PALETTE.length]).then(function (s) { S.activeSection = s.id; return selectNotebook(S.nbId, null); }); }
      var sec = e.target.closest("[data-sec]"); if (sec) {
        var sid = sec.getAttribute("data-sec");
        // on mobile, picking a section (even the active one) flows into the
        // pages drawer — and stays there so the operator can pick a page
        // (openPage would close it)
        var sh = $id("rrnb-shell"), mobileFlow = false;
        if (sh && sh.classList.contains("show-rail")) { sh.classList.remove("show-rail"); sh.classList.add("show-pages"); mobileFlow = true; }
        // re-clicking the active section is a no-op on desktop — and crucially
        // must NOT re-render, or a synchronous rail rebuild between the two
        // clicks of a double-click breaks native dblclick-to-rename
        if (sid === S.activeSection) return;
        S.activeSection = sid; S.mode = "notebook"; renderSections(); renderPageList();
        var f = firstPageOf(sid);
        if (f && !mobileFlow) openPage(f); else if (!f) showBlank();
      }
    });

    // page list (delegated)
    var plHost = $id("rrnb-pagelist");
    if (plHost) {
      plHost.addEventListener("dblclick", function (e) {
        var prow = e.target.closest("[data-page]"); if (prow && e.target.closest(".ttl")) { e.preventDefault(); return editPageTitle(prow.getAttribute("data-page")); }
      });
      plHost.addEventListener("click", function (e) {
        if (S._inlineEditing) return;
        var kb = e.target.closest("[data-menu='page']"); if (kb) { var r = kb.getBoundingClientRect(); return pageMenu(kb.getAttribute("data-id"), r.left, r.bottom); }
        var add = e.target.closest("[data-add-page]"); if (add) return newPage();
        var tpl = e.target.closest("[data-template-menu]"); if (tpl) return openTemplateMenu(tpl);
        var exit = e.target.closest("[data-exit-recycle]"); if (exit) { S.mode = "notebook"; return renderPageList(); }
        var exr = e.target.closest("[data-exit-recent]"); if (exr) { S.mode = "notebook"; return renderPageList(); }
        var rp = e.target.closest("[data-recent-page]"); if (rp) { var rnb = rp.getAttribute("data-recent-nb"), rpg = rp.getAttribute("data-recent-page"); if (rnb && rnb !== S.nbId) { S.activeSection = null; return selectNotebook(rnb, rpg); } S.mode = "notebook"; return openPage(rpg); }
        var rb = e.target.closest("[data-restore-btn]"); if (rb) { return S.be.restoreItem("page", rb.getAttribute("data-restore-btn")).then(function () { return selectNotebook(S.nbId, null); }); }
        var sr = e.target.closest("[data-search-page]"); if (sr) { var nb = sr.getAttribute("data-search-nb"), pg = sr.getAttribute("data-search-page"); var si = $id("rrnb-search-input"); if (si) si.value = ""; if (nb !== S.nbId) { S.activeSection = null; return selectNotebook(nb, pg); } S.mode = "notebook"; return openPage(pg); }
        var pg2 = e.target.closest("[data-page]"); if (pg2) { S.mode = "notebook"; openPage(pg2.getAttribute("data-page")); }
      });
      plHost.addEventListener("contextmenu", function (e) { var pg = e.target.closest("[data-page]"); if (pg && pg.getAttribute("data-page")) { e.preventDefault(); pageMenu(pg.getAttribute("data-page"), e.clientX, e.clientY); } });
      // Tab / Shift+Tab to indent the active page from the list
      plHost.addEventListener("keydown", function (e) { if (e.key === "Tab" && S.pageId) { e.preventDefault(); indentPage(S.pageId, e.shiftKey ? -1 : 1); } });
      // drag-to-reorder pages
      plHost.addEventListener("dragstart", function (e) { var row = e.target.closest("[data-page]"); if (row) { S._dragPage = row.getAttribute("data-page"); row.classList.add("rrnb-dragging"); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", S._dragPage); } catch (x) {} } });
      plHost.addEventListener("dragend", function () { S._dragPage = null; plHost.querySelectorAll(".rrnb-dragging,.rrnb-dragover").forEach(function (x) { x.classList.remove("rrnb-dragging", "rrnb-dragover"); }); });
      plHost.addEventListener("dragover", function (e) { if (!S._dragPage) return; var row = e.target.closest("[data-page]"); if (!row) return; e.preventDefault(); plHost.querySelectorAll(".rrnb-dragover").forEach(function (x) { x.classList.remove("rrnb-dragover"); }); if (row.getAttribute("data-page") !== S._dragPage) row.classList.add("rrnb-dragover"); });
      plHost.addEventListener("drop", function (e) { if (!S._dragPage) return; var row = e.target.closest("[data-page]"); if (!row) return; e.preventDefault(); var tgt = row.getAttribute("data-page"); var drag = S._dragPage; S._dragPage = null; reorderPage(drag, tgt); });
    }

    // recycle bin button
    var rec = $id("rrnb-recycle-btn");
    if (rec) rec.addEventListener("click", function () { S.mode = "recycle"; renderPageList(); });

    // mobile drawers (≤860px): rail / pages slide over the canvas
    var shell = $id("rrnb-shell");
    var mbR = $id("rrnb-mb-rail"), mbP = $id("rrnb-mb-pages");
    if (mbR && shell) mbR.addEventListener("click", function () { shell.classList.remove("show-pages"); shell.classList.toggle("show-rail"); });
    if (mbP && shell) mbP.addEventListener("click", function () { shell.classList.remove("show-rail"); shell.classList.toggle("show-pages"); });

    // "mentioned in" rail links (object notebooks)
    var mn = $id("rrnb-mentions");
    if (mn) mn.addEventListener("click", function (e) {
      var a = e.target.closest("[data-mn-page]"); if (!a) return;
      var nb = a.getAttribute("data-mn-nb"), pg = a.getAttribute("data-mn-page");
      if (nb && nb !== S.nbId) { S.activeSection = null; selectNotebook(nb, pg); } else openPage(pg);
    });

    // quick note + recent
    var qn = $id("rrnb-quicknote-btn");
    if (qn) qn.addEventListener("click", function () { quickNote(); });
    var rcb = $id("rrnb-recent-btn");
    if (rcb) rcb.addEventListener("click", function () { S.mode = "recent"; renderRecent(); });

    // search
    var si = $id("rrnb-search-input");
    if (si) si.addEventListener("input", function () { var q = si.value.trim(); if (!q) { S.mode = "notebook"; renderPageList(); } else runSearch(q); });

    // canvas delegated (tags, backlinks, add-tag)
    var cw = $id("rrnb-canvas-wrap");
    if (cw) cw.addEventListener("click", function (e) {
      var rm = e.target.closest("[data-remove-tag]"); if (rm) return removeTag(rm.getAttribute("data-remove-tag"));
      var at = e.target.closest("#rrnb-addtag"); if (at) return openTagPicker(at);
      var bl = e.target.closest("[data-goto-page]"); if (bl) { var nb = bl.getAttribute("data-goto-nb"), pg = bl.getAttribute("data-goto-page"); if (nb !== S.nbId) { S.activeSection = null; return selectNotebook(nb, pg); } return openPage(pg); }
    });

    // context menu dispatch + dismissers
    var ctx = $id("rrnb-ctx");
    if (ctx) ctx.addEventListener("click", function (e) { var it = e.target.closest("[data-act]"); if (it) handleCtx(it.getAttribute("data-act")); });
    document.addEventListener("mousedown", function (e) {
      if (!e.target.closest("#rrnb-ctx")) hideCtx();
      if (!e.target.closest("#rrnb-pop") && !e.target.closest("[data-cmd]")) hidePop();
      if (!e.target.closest("#rrnb-nb-menu") && !e.target.closest("#rrnb-nb-current")) { var m = $id("rrnb-nb-menu"); if (m) m.hidden = true; }
      if (!e.target.closest("#rrnb-aimenu") && !e.target.closest(".rrnb-tb-ai")) hideAiMenu();
      if (!e.target.closest("#rrnb-imgrz") && !e.target.closest("#rrnb-pop") && !e.target.closest("img")) {
        hideImgResize();
        var ed0 = $id("rrnb-editor");
        if (ed0) ed0.querySelectorAll("figure.rrnb-fig.sel, img.sel").forEach(function (f) { f.classList.remove("sel"); });
      }
    });

    // global shortcuts while the view is active
    document.addEventListener("keydown", function (e) {
      var v = ROOT(); if (!v || !v.classList.contains("active")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.shiftKey) { var s = $id("rrnb-search-input"); if (s) { e.preventDefault(); s.focus(); s.select(); } }
      if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); if (e.shiftKey) newSection(); else newPage(); }
      if (e.altKey && e.key.toLowerCase() === "q") { e.preventDefault(); quickNote(); }
      if (e.key === "Escape") { hidePop(); hideCtx(); hideAiMenu(); hideImgResize(); }
      // OneNote-style page ops — only when NOT typing in the editor/inputs
      if (!typingContext() && S.pageId && S.mode === "notebook") {
        if (e.key === "F2") { e.preventDefault(); if (!S.readOnly) editPageTitle(S.pageId); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (!S.readOnly && window.confirm("Move this page to the Recycle Bin?")) S.be.deleteItem("page", S.pageId).then(function () { showBlank(); return selectNotebook(S.nbId, null); }).catch(fail); return; }
        if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); navPage(1); return; }
        if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); navPage(-1); return; }
      }
    });

    // flush save when leaving the tab / page
    window.addEventListener("beforeunload", flushSave);
    document.addEventListener("visibilitychange", function () { if (document.hidden) flushSave(); });
  }

  function openTagPicker(anchor) {
    var r = anchor.getBoundingClientRect();
    var used = (S.page && S.page.tags) || [];
    var opts = TAG_PRESETS.filter(function (t) { return used.indexOf(t) < 0; });
    var pop = showPop('<label>Add tag</label><input id="rrnb-tag-in" placeholder="Type or pick…" /><div class="rrnb-pop-list">' +
      opts.map(function (t) { return '<div class="rrnb-pop-opt" data-tag-pick="' + esc(t) + '">' + esc(t) + '</div>'; }).join("") + '</div>', r);
    var inp = $id("rrnb-tag-in"); inp.focus();
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { addTag(inp.value); hidePop(); } });
    pop.addEventListener("click", function (e) { var o = e.target.closest("[data-tag-pick]"); if (o) { addTag(o.getAttribute("data-tag-pick")); hidePop(); } });
  }

  // ── create flows ─────────────────────────────────────────────────
  function createNotebookFlow(kind) {
    var priv = kind === "personal";
    var name = window.prompt(priv ? "New private notebook name (only you can see it)" : "New notebook name",
      priv ? "My Notebook" : "New Notebook");
    if (name == null) return;
    var color = PALETTE[S.notebooks.length % PALETTE.length];
    S.be.createNotebook(name || (priv ? "My Notebook" : "New Notebook"), color, priv ? "personal" : "workspace").then(function (nb) {
      return S.be.listNotebooks().then(function (list) { S.notebooks = list; renderNotebookMenu(); S.activeSection = null; return selectNotebook(nb.id); });
    }).catch(fail);
  }

  // ── share a private notebook with teammates ─────────────────────────
  function openSharePopover(nbId) {
    var host = $id("rrnb-nb-current");
    var r = host ? host.getBoundingClientRect() : { left: 80, bottom: 80 };
    Promise.all([S.be.shareCandidates(), S.be.shareList(nbId)]).then(function (res) {
      var candidates = res[0] || [], members = res[1] || [];
      if (!candidates.length) { notify("No other staff to share with yet"); return; }
      var byId = {}; members.forEach(function (m) { byId[m.user_id] = m.role; });
      var pop = showPop('<label>Share this private notebook</label><div class="rrnb-pop-list">' +
        candidates.map(function (c) {
          var cur = byId[c.user_id] || "";
          return '<div class="rrnb-pop-opt" style="display:flex;align-items:center;gap:8px" data-share-row="' + esc(c.user_id) + '">' +
            '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.name) + '</span>' +
            '<select data-share-role="' + esc(c.user_id) + '" class="rrnb-tb-sel" style="border:1px solid var(--border);height:26px">' +
              '<option value=""' + (cur === "" ? " selected" : "") + '>No access</option>' +
              '<option value="viewer"' + (cur === "viewer" ? " selected" : "") + '>Can view</option>' +
              '<option value="editor"' + (cur === "editor" ? " selected" : "") + '>Can edit</option>' +
            '</select></div>';
        }).join("") + '</div>' +
        '<div class="rrnb-pop-row"><button class="rrnb-pop-btn ghost" data-pop-cancel="1">Cancel</button>' +
        '<button class="rrnb-pop-btn" id="rrnb-share-save">Save sharing</button></div>', r);
      pop.addEventListener("mousedown", function (e) { e.stopPropagation(); }); // keep selects usable
      var cancel = pop.querySelector("[data-pop-cancel]");
      if (cancel) cancel.addEventListener("click", hidePop);
      var save = $id("rrnb-share-save");
      if (save) save.addEventListener("click", function () {
        var out = [];
        pop.querySelectorAll("[data-share-role]").forEach(function (sel) {
          if (sel.value) out.push({ user_id: sel.getAttribute("data-share-role"), role: sel.value });
        });
        S.be.shareSet(nbId, out).then(function (list2) {
          hidePop();
          var n = (S.notebooks || []).filter(function (x) { return x.id === nbId; })[0];
          if (n) n.member_count = (list2 || []).length;
          renderNotebookMenu();
          notify((list2 || []).length ? "Shared with " + (list2 || []).length + " teammate" + ((list2 || []).length > 1 ? "s" : "") : "No longer shared");
        }).catch(fail);
      });
    }).catch(fail);
  }
  function newSection() {
    if (S.readOnly) { notify("You have view-only access to this notebook"); return; }
    S.be.createSection(S.nbId, "New Section", null, PALETTE[((S.tree && S.tree.sections.length) || 0) % PALETTE.length]).then(function (s) { S.activeSection = s.id; return selectNotebook(S.nbId, null); }).catch(fail);
  }
  function newPage() {
    if (S.readOnly) { notify("You have view-only access to this notebook"); return; }
    if (!S.activeSection) { if (S.tree && S.tree.sections[0]) S.activeSection = S.tree.sections[0].id; else return; }
    S.be.createPage(S.activeSection, "Untitled Page", null, 0).then(function (p) {
      if (S.tree) S.tree.pages.push({ id: p.id, section_id: p.section_id, parent_page_id: null, title: p.title, level: 0, position: p.position, tags: [], is_pinned: false, updated_at: p.updated_at });
      renderPageList(); openPage(p.id);
      setTimeout(function () { var t = $id("rrnb-title"); if (t) { t.focus(); t.select(); } }, 30);
    }).catch(fail);
  }

  // ── templates ────────────────────────────────────────────────────
  var TEMPLATES = [
    { id: "blank", name: "Blank page", title: "Untitled Page", html: "" },
    { id: "meeting", name: "Meeting notes", title: "Meeting — " + todayStr(), html:
      "<h2>Meeting notes</h2><p><b>Date:</b> " + todayStr() + " &nbsp; <b>Attendees:</b> </p>" +
      "<h3>Agenda</h3><ul><li></li></ul><h3>Discussion</h3><p></p>" +
      "<h3>Action items</h3><div class='rrnb-todo' data-checked='0'><span class='rrnb-todo-box' contenteditable='false'></span><span class='rrnb-todo-text'></span></div>" +
      "<h3>Decisions</h3><ul><li></li></ul>" },
    { id: "incident", name: "Incident report", title: "Incident — " + todayStr(), html:
      "<h2>Incident report</h2><p><b>When:</b> " + todayStr() + " &nbsp; <b>Where:</b> &nbsp; <b>Reported by:</b> </p>" +
      "<h3>What happened</h3><p></p><h3>People / vehicles involved</h3><ul><li></li></ul>" +
      "<h3>Immediate actions</h3><div class='rrnb-todo' data-checked='0'><span class='rrnb-todo-box' contenteditable='false'></span><span class='rrnb-todo-text'></span></div>" +
      "<h3>Follow-up</h3><p></p>" },
    { id: "standup", name: "Daily standup", title: "Standup — " + todayStr(), html:
      "<h2>Daily standup — " + todayStr() + "</h2><h3>On road today</h3><p></p><h3>Callouts / gaps</h3><ul><li></li></ul><h3>Blockers</h3><ul><li></li></ul>" },
    { id: "sop", name: "SOP / procedure", title: "SOP — ", html:
      "<h2>Standard operating procedure</h2><p><b>Purpose:</b> </p><p><b>Scope:</b> </p><h3>Steps</h3><ol><li></li><li></li></ol><h3>Notes</h3><p></p>" },
    { id: "coaching", name: "Driver coaching", title: "Coaching — " + todayStr(), html:
      "<h2>Driver coaching</h2><p><b>Driver:</b> &nbsp; <b>Date:</b> " + todayStr() + "</p><h3>Topic</h3><p></p><h3>Discussion</h3><p></p>" +
      "<h3>Agreed actions</h3><div class='rrnb-todo' data-checked='0'><span class='rrnb-todo-box' contenteditable='false'></span><span class='rrnb-todo-text'></span></div>" }
  ];
  function todayStr() { try { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); } catch (e) { return ""; } }
  // custom templates: any page can be saved as one (localStorage, per DSP)
  function tplKey() { return "rrnb-tpl:" + (((window.RR && window.RR.dsp && window.RR.dsp.id) || "local")); }
  function customTemplates() { try { return JSON.parse(localStorage.getItem(tplKey()) || "[]"); } catch (e) { return []; } }
  function saveAsTemplate(id) {
    pageSnapshotFor(id).then(function (p) {
      if (!p) return;
      var name = window.prompt("Template name", p.title || "My template"); if (name == null) return;
      var list = customTemplates();
      list.push({ id: uid(), name: name || "My template", title: p.title || "", html: p.content_html || "" });
      try { localStorage.setItem(tplKey(), JSON.stringify(list.slice(-30))); } catch (e) {}
      notify('Saved — find it under "New page from template"');
    }).catch(fail);
  }
  function openTemplateMenu(anchor) {
    var r = anchor.getBoundingClientRect();
    var customs = customTemplates();
    var pop = showPop('<label>New page from template</label><div class="rrnb-pop-list">' +
      TEMPLATES.map(function (t) { return '<div class="rrnb-pop-opt" data-tpl="' + t.id + '">' + esc(t.name) + '</div>'; }).join("") +
      (customs.length ? '<div class="rrnb-menu-sep"></div>' + customs.map(function (t) {
        return '<div class="rrnb-pop-opt" data-ctpl="' + esc(t.id) + '" style="display:flex;align-items:center;gap:6px"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.name) + '</span>' +
          '<button data-deltpl="' + esc(t.id) + '" title="Remove template" style="border:0;background:transparent;color:var(--text-subtle);cursor:pointer;font-size:var(--fs-sm)">×</button></div>';
      }).join("") : "") + '</div>', r);
    pop.addEventListener("click", function (e) {
      var del = e.target.closest("[data-deltpl]");
      if (del) {
        e.stopPropagation();
        var left = customTemplates().filter(function (t) { return t.id !== del.getAttribute("data-deltpl"); });
        try { localStorage.setItem(tplKey(), JSON.stringify(left)); } catch (err) {}
        hidePop(); notify("Template removed"); return;
      }
      var c = e.target.closest("[data-ctpl]");
      if (c) {
        var t = customTemplates().filter(function (x) { return x.id === c.getAttribute("data-ctpl"); })[0];
        hidePop(); if (t) createFromCustomTemplate(t); return;
      }
      var o = e.target.closest("[data-tpl]"); if (!o) return; hidePop(); createFromTemplate(o.getAttribute("data-tpl"));
    });
  }
  function createFromCustomTemplate(t) {
    if (!S.activeSection) { if (S.tree && S.tree.sections[0]) S.activeSection = S.tree.sections[0].id; else return; }
    S.be.createPage(S.activeSection, t.title || t.name, null, 0).then(function (p) {
      return S.be.savePage(p.id, { title: t.title || t.name, content_html: t.html, content_text: stripHtml(t.html), tags: [] }).then(function () {
        return selectNotebook(S.nbId, p.id);
      });
    }).catch(fail);
  }
  function createFromTemplate(tplId) {
    var tpl = TEMPLATES.filter(function (t) { return t.id === tplId; })[0] || TEMPLATES[0];
    if (!S.activeSection) { if (S.tree && S.tree.sections[0]) S.activeSection = S.tree.sections[0].id; else return; }
    S.be.createPage(S.activeSection, tpl.title || "Untitled Page", null, 0).then(function (p) {
      return S.be.savePage(p.id, { title: tpl.title, content_html: tpl.html, content_text: stripHtml(tpl.html), tags: [] }).then(function () {
        return selectNotebook(S.nbId, p.id);
      });
    }).catch(fail);
  }
  function stripHtml(html) { var d = document.createElement("div"); d.innerHTML = html || ""; return d.innerText || ""; }

  // ── RouteReady Meet hand-off ─────────────────────────────────────────────
  // meet.js drops meeting notes into an "inbox" in localStorage, then opens
  // the dashboard at #notebooks. We import them into a "Meeting Notes"
  // notebook — one page per meeting, updated in place — and open the page, so
  // the host lands on their filed notes. Backend-agnostic (Supabase / local).
  var MEET_INBOX_KEY = "rr-notebook-inbox";
  var MEET_PAGEMAP_KEY = "rr-notebook-meet-pages";
  var MEET_NB_NAME = "Meeting Notes";
  // A Supabase session is persisted under a "sb-<ref>-auth-token" key. If one
  // exists we're signed in and must import into the Supabase notebook (wait for
  // window.RR.dsp); with no session, the local store is the right target.
  function meetSignedIn() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) return true;
      }
    } catch (e) {}
    return false;
  }
  function readMeetInbox() { try { return JSON.parse(localStorage.getItem(MEET_INBOX_KEY) || "[]"); } catch (e) { return []; } }
  function clearMeetInbox() { try { localStorage.removeItem(MEET_INBOX_KEY); } catch (e) {} }
  function meetPageMap() { try { return JSON.parse(localStorage.getItem(MEET_PAGEMAP_KEY) || "{}"); } catch (e) { return {}; } }
  function saveMeetPageMap(m) { try { localStorage.setItem(MEET_PAGEMAP_KEY, JSON.stringify(m)); } catch (e) {} }
  function meetTextToHtml(t) {
    return String(t || "").split(/\r?\n/).map(function (ln) {
      return ln.trim() ? "<p>" + esc(ln) + "</p>" : "<p><br></p>";
    }).join("") || "<p><br></p>";
  }
  function importMeetInbox() {
    var items = readMeetInbox();
    if (!items.length) return Promise.resolve(null);
    return S.be.listNotebooks().then(function (list) {
      var found = (list || []).filter(function (n) { return n.name === MEET_NB_NAME && !n.subject_type; })[0];
      var getNb = found
        ? Promise.resolve({ row: found, fresh: false })
        : S.be.createNotebook(MEET_NB_NAME, "#2563eb").then(function (n) { return { row: n, fresh: true }; });
      return getNb.then(function (res) {
        var nbId = res.row.id;
        return S.be.tree(nbId).then(function (tree) {
          var sec0 = ((tree && tree.sections) || [])[0];
          var getSec;
          if (sec0 && res.fresh) getSec = S.be.rename("section", sec0.id, "Meetings").then(function () { return sec0; }, function () { return sec0; });
          else if (sec0) getSec = Promise.resolve(sec0);
          else getSec = S.be.createSection(nbId, "Meetings", null, "#2563eb");
          return getSec.then(function (secrow) {
            var secId = secrow.id;
            var map = meetPageMap();
            var lastPageId = null;
            var chain = Promise.resolve();
            items.forEach(function (it) {
              chain = chain.then(function () {
                var patch = { title: it.title, content_html: meetTextToHtml(it.text), content_text: String(it.text || ""), tags: [] };
                var create = function () {
                  return S.be.createPage(secId, it.title, null, 0).then(function (p) {
                    map[it.code] = p.id; lastPageId = p.id;
                    return S.be.savePage(p.id, patch, null);
                  });
                };
                if (map[it.code]) {
                  return S.be.savePage(map[it.code], patch, null).then(function () { lastPageId = map[it.code]; }, create);
                }
                return create();
              });
            });
            return chain.then(function () { saveMeetPageMap(map); clearMeetInbox(); return { nbId: nbId, pageId: lastPageId }; });
          });
        });
      });
    });
  }

  // ── Quick Notes: capture into a "Quick Notes" section of the current notebook ──
  function quickNote() {
    if (!S.nbId && S.notebooks[0]) S.nbId = S.notebooks[0].id;
    if (!S.nbId) return;
    if (S.readOnly) { notify("You have view-only access to this notebook — pick another for quick notes"); return; }
    var doCreate = function (sectionId) {
      var stamp = todayStr() + " " + new Date().toTimeString().slice(0, 5);
      S.be.createPage(sectionId, "Quick note · " + stamp, null, 0).then(function (p) {
        S.activeSection = sectionId; S.mode = "notebook";
        return selectNotebook(S.nbId, p.id).then(function () {
          setTimeout(function () { var ed = $id("rrnb-editor"); if (ed) ed.focus(); }, 60);
        });
      }).catch(fail);
    };
    var existing = ((S.tree && S.tree.sections) || []).filter(function (s) { return s.name === "Quick Notes"; })[0];
    if (existing) return doCreate(existing.id);
    S.be.createSection(S.nbId, "Quick Notes", null, "#d97706").then(function (s) {
      return S.be.tree(S.nbId).then(function (t) { S.tree = t; renderSections(); doCreate(s.id); });
    }).catch(fail);
  }

  // ── Recent pages (cross-notebook, localStorage) ──────────────────
  function recentKey() { return "rrnb-recent:" + (((window.RR && window.RR.dsp && window.RR.dsp.id) || "local")); }
  function trackRecent(p) {
    try {
      var list = JSON.parse(localStorage.getItem(recentKey()) || "[]");
      list = list.filter(function (x) { return x.id !== p.id; });
      list.unshift({ id: p.id, title: p.title, notebook_id: p.notebook_id || S.nbId, section_id: p.section_id, at: new Date().toISOString() });
      localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, 25)));
    } catch (e) {}
  }
  function renderRecent() {
    var host = $id("rrnb-pagelist"); if (!host) return;
    var list = [];
    try { list = JSON.parse(localStorage.getItem(recentKey()) || "[]"); } catch (e) {}
    var html = '<div class="rrnb-plgroup-hd">Recent</div>';
    if (!list.length) html += '<div class="rrnb-empty">Pages you open show up here.</div>';
    html += list.map(function (r) {
      var nb = S.notebooks.filter(function (n) { return n.id === r.notebook_id; })[0];
      return '<div class="rrnb-page" data-recent-page="' + r.id + '" data-recent-nb="' + r.notebook_id + '"><div class="body">' +
        '<div class="ttl">' + esc(r.title || "Untitled") + '</div><div class="sub">' + esc(nb ? nb.name : "") + '  ·  ' + esc(relTime(r.at)) + '</div></div></div>';
    }).join("");
    html += '<button class="rrnb-newpage" data-exit-recent="1">‹ Back to pages</button>';
    host.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════════
  //  AI — summarize / rewrite / extract, via the notebook-ai edge function
  // ══════════════════════════════════════════════════════════════════
  var AI_ACTIONS = [
    { k: "summarize", label: "Summarize" },
    { k: "action_items", label: "Extract action items" },
    { k: "rewrite", label: "Rewrite (clean up)" },
    { k: "professional", label: "Make it professional" },
    { k: "grammar", label: "Fix spelling & grammar" },
    { k: "expand", label: "Expand into detail" },
    { k: "minutes", label: "Meeting minutes" },
    { k: "checklist", label: "Turn into a checklist" },
    { k: "tags", label: "Suggest tags" }
  ];
  function openAiMenu() {
    var btn = $(".rrnb-tb-ai"); if (!btn) return;
    var r = btn.getBoundingClientRect();
    var m = $id("rrnb-aimenu") || (function () { var d = document.createElement("div"); d.className = "rrnb-aimenu"; d.id = "rrnb-aimenu"; document.body.appendChild(d); return d; })();
    m.innerHTML = '<div class="hd">AI · works on selection or whole page</div>' +
      AI_ACTIONS.map(function (a) { return '<div class="it" data-ai="' + a.k + '">' + esc(a.label) + '</div>'; }).join("");
    m.hidden = false;
    m.style.left = Math.max(12, Math.min(window.innerWidth - m.offsetWidth - 12, r.left)) + "px";
    m.style.top = (r.bottom + 6) + "px";
    m.onclick = function (e) { var it = e.target.closest("[data-ai]"); if (!it) return; var k = it.getAttribute("data-ai"); m.hidden = true; runAI(k, (AI_ACTIONS.filter(function (a) { return a.k === k; })[0] || {}).label || "AI"); };
  }
  function hideAiMenu() { var m = $id("rrnb-aimenu"); if (m) m.hidden = true; }
  function aiContext() {
    var sel = window.getSelection(); var selText = sel && sel.toString().trim();
    var ed = $id("rrnb-editor");
    return { text: selText || (ed ? (ed.innerText || "") : ""), hasSelection: !!(selText && selText.length > 1) };
  }
  function aiPanel() {
    var p = $id("rrnb-aipanel");
    if (!p) { p = document.createElement("div"); p.className = "rrnb-aipanel"; p.id = "rrnb-aipanel";
      var ed = $id("rrnb-editor"); if (ed && ed.parentNode) ed.parentNode.insertBefore(p, ed); }
    return p;
  }
  function runAI(action, label) {
    var ctx = aiContext();
    if (!ctx.text || ctx.text.trim().length < 2) { notify("Write or select some text first."); return; }
    var p = aiPanel();
    p.innerHTML = '<div class="ph"><span class="rrnb-spin"></span> ' + esc(label) + '…<span class="sp"><button data-ai-x="1">Cancel</button></span></div><div class="bd busy">Thinking…</div>';
    p.querySelector("[data-ai-x]").onclick = function () { p.remove(); };
    var sb = (window.RR && window.RR.sb) || window.sb;
    if (!sb || !sb.functions) { aiError(p, "AI needs a signed-in RouteReady session."); return; }
    var title = ($id("rrnb-title") || {}).value || (S.page && S.page.title) || "";
    sb.functions.invoke("notebook-ai", { body: { action: action, text: ctx.text.slice(0, 12000), title: title } }).then(function (res) {
      var data = res && res.data, error = res && res.error;
      if (error || !data || data.error || (!data.result && !data.tags)) {
        aiExplainError(error, data, function (msg) { aiError(p, msg); });
        return;
      }
      if (data.tags && data.tags.length) return aiShowTags(p, label, data.tags);
      aiShowResult(p, label, String(data.result || ""), ctx.hasSelection);
    }).catch(function (e) { aiError(p, (e && e.message) || "AI request failed."); });
  }
  // supabase-js buries the function's real error payload: on a non-2xx the
  // error is a FunctionsHttpError whose .message is always the generic
  // "Edge Function returned a non-2xx status code" — the actual JSON body
  // lives in error.context (a Response). Read it and translate the known
  // notebook-ai error codes into something the operator can act on.
  function aiExplainError(error, data, cb) {
    function explain(p) {
      if (!p) return null;
      var code = String(p.error || "");
      if (code.indexOf("ANTHROPIC_API_KEY") >= 0) return "AI isn't set up on the server yet — the ANTHROPIC_API_KEY secret is missing on the Supabase project. An admin can add it under Project Settings → Edge Functions → Secrets.";
      if (code === "missing_auth" || code === "invalid_auth") return "Your session has expired — sign out and back in to use AI.";
      if (code === "no_membership") return "AI is available to active team members only. Ask an admin to check your account.";
      if (code === "ai_failed") {
        var d = String(p.detail || "");
        if (/credit balance|billing/i.test(d)) return "The AI account is out of credits — an admin can top up at console.anthropic.com → Plans & Billing. AI works again immediately after.";
        if (/rate.?limit|overloaded|529/i.test(d)) return "The AI service is busy right now — try again in a minute.";
        return "The AI service returned an error: " + (d || "unknown error") + ".";
      }
      if (code === "image_too_large") return "That picture is too large for AI to read.";
      return p.detail || p.error || null;
    }
    var direct = explain(data);
    if (direct) return cb(direct);
    if (error && error.context && typeof error.context.json === "function") {
      error.context.json().then(function (p) { cb(explain(p) || (error && error.message) || "AI request failed."); })
        .catch(function () { cb((error && error.message) || "AI request failed."); });
      return;
    }
    cb((error && error.message) || (data && (data.detail || data.error)) || "The notebook-ai function isn't available yet.");
  }
  function aiError(p, msg) {
    p.innerHTML = '<div class="ph">AI<span class="sp"><button data-ai-x="1">Dismiss</button></span></div><div class="bd" style="color:var(--red)">' + esc(msg) + '</div>';
    p.querySelector("[data-ai-x]").onclick = function () { p.remove(); };
  }
  function aiShowResult(p, label, text, hasSel) {
    var html = aiMdToHtml(text);
    p.innerHTML = '<div class="ph">' + esc(label) +
      '<span class="sp">' + (hasSel ? '<button data-ai-replace="1">Replace selection</button>' : '') +
      '<button class="pri" data-ai-insert="1">Insert below</button><button data-ai-copy="1">Copy</button><button data-ai-x="1">Dismiss</button></span></div>' +
      '<div class="bd" id="rrnb-ai-bd">' + html + '</div>';
    p.querySelector("[data-ai-x]").onclick = function () { p.remove(); };
    p.querySelector("[data-ai-copy]").onclick = function () { try { navigator.clipboard.writeText(text); notify("Copied"); } catch (e) {} };
    p.querySelector("[data-ai-insert]").onclick = function () {
      var ed = $id("rrnb-editor"); if (ed) { ed.focus(); ed.insertAdjacentHTML("beforeend", html); scheduleSave(); makeCaptionsEditable(); } p.remove();
    };
    var rep = p.querySelector("[data-ai-replace]");
    if (rep) rep.onclick = function () { var ed = $id("rrnb-editor"); if (ed) { ed.focus(); try { document.execCommand("insertHTML", false, html); } catch (e) {} scheduleSave(); } p.remove(); };
  }
  function aiShowTags(p, label, tags) {
    p.innerHTML = '<div class="ph">' + esc(label) + '<span class="sp"><button data-ai-x="1">Dismiss</button></span></div>' +
      '<div class="bd">' + tags.map(function (t) { return '<button class="rrnb-addtag" data-ai-tag="' + esc(t) + '" style="margin:3px">＋ ' + esc(t) + '</button>'; }).join("") + '</div>';
    p.querySelector("[data-ai-x]").onclick = function () { p.remove(); };
    p.querySelectorAll("[data-ai-tag]").forEach(function (b) { b.onclick = function () { addTag(b.getAttribute("data-ai-tag")); b.disabled = true; b.textContent = "✓ " + b.getAttribute("data-ai-tag"); }; });
  }
  function aiInline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*]+?)\*/g, "$1<i>$2</i>"); }
  function aiMdToHtml(t) {
    var lines = String(t).split(/\r?\n/), html = "", inUl = false, inOl = false, m;
    function closeLists() { if (inUl) { html += "</ul>"; inUl = false; } if (inOl) { html += "</ol>"; inOl = false; } }
    lines.forEach(function (ln) {
      if ((m = ln.match(/^\s*[-*]\s*\[([ xX]?)\]\s+(.*)/))) { closeLists(); var ck = m[1].trim() ? "1" : "0"; html += '<div class="rrnb-todo" data-checked="' + ck + '"><span class="rrnb-todo-box" contenteditable="false">' + (ck === "1" ? "✓" : "") + '</span><span class="rrnb-todo-text">' + aiInline(m[2]) + '</span></div>'; }
      else if ((m = ln.match(/^\s*[-*•]\s+(.*)/))) { if (inOl) { html += "</ol>"; inOl = false; } if (!inUl) { html += "<ul>"; inUl = true; } html += "<li>" + aiInline(m[1]) + "</li>"; }
      else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) { if (inUl) { html += "</ul>"; inUl = false; } if (!inOl) { html += "<ol>"; inOl = true; } html += "<li>" + aiInline(m[1]) + "</li>"; }
      else if ((m = ln.match(/^\s*#{1,6}\s+(.*)/))) { closeLists(); html += "<h3>" + aiInline(m[1]) + "</h3>"; }
      else if (ln.trim() === "") { closeLists(); }
      else { closeLists(); html += "<p>" + aiInline(ln) + "</p>"; }
    });
    closeLists();
    return html || "<p></p>";
  }

  // ══════════════════════════════════════════════════════════════════
  //  PAGE REORDER (drag) + keyboard navigation
  // ══════════════════════════════════════════════════════════════════
  function orderedPages(secId) {
    if (!S.tree) return [];
    var pages = S.tree.pages.filter(function (p) { return p.section_id === secId; });
    var tops = pages.filter(function (p) { return !p.parent_page_id; }).sort(function (a, b) { return a.position - b.position; });
    var kids = {}; pages.forEach(function (p) { if (p.parent_page_id) (kids[p.parent_page_id] = kids[p.parent_page_id] || []).push(p); });
    Object.keys(kids).forEach(function (k) { kids[k].sort(function (a, b) { return a.position - b.position; }); });
    var out = []; (function walk(list) { list.forEach(function (p) { out.push(p); if (kids[p.id]) walk(kids[p.id]); }); })(tops);
    return out;
  }
  function navPage(dir) {
    if (!S.tree || !S.activeSection) return;
    var ord = orderedPages(S.activeSection); var i = ord.map(function (p) { return p.id; }).indexOf(S.pageId);
    var j = i < 0 ? 0 : i + dir; if (j < 0 || j >= ord.length) return; openPage(ord[j].id);
  }
  function reorderPage(dragId, targetId) {
    if (dragId === targetId || !S.tree) return;
    var pages = S.tree.pages;
    var d = pages.filter(function (x) { return x.id === dragId; })[0];
    var t = pages.filter(function (x) { return x.id === targetId; })[0];
    if (!d || !t) return;
    d.section_id = t.section_id; d.parent_page_id = t.parent_page_id || null; d.level = t.level;
    var sibs = pages.filter(function (x) { return x.section_id === t.section_id && (x.parent_page_id || null) === (t.parent_page_id || null) && x.id !== dragId; }).sort(function (a, b) { return a.position - b.position; });
    var ti = sibs.map(function (x) { return x.id; }).indexOf(targetId);
    var prev = sibs[ti - 1];
    var newPos = prev ? (prev.position + t.position) / 2 : t.position - 1;
    d.position = newPos;
    renderPageList();
    S.be.movePage(dragId, { section_id: d.section_id, parent_page_id: d.parent_page_id, level: d.level, position: newPos }).catch(fail);
  }
  function typingContext() {
    var a = document.activeElement;
    return a && (a.id === "rrnb-editor" || a.id === "rrnb-title" || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════
  window.RRNotebooks = {
    __inited: true,
    loadView: function (opts) { chooseBackend(); loadView(opts); },
    reload: function () { S.be = null; loadView(); },
    // Open the notebook bound to any RouteReady object (driver, vehicle, …).
    // We stash the target; loadView() consumes it synchronously at its top,
    // so whether it's driven by goto()'s notebooks hook or by our fallback
    // tick, exactly one load selects the object notebook (no race).
    openFor: function (subjectType, subjectId, title) {
      S.pendingObject = { t: subjectType, i: String(subjectId), title: title || null };
      chooseBackend();
      try { if (typeof window.goto === "function") window.goto("notebooks"); } catch (e) {}
      // If goto didn't drive a load (no live.js hook, e.g. already active or
      // a bare router), do it ourselves. pendingObject is already null if a
      // load consumed it synchronously.
      setTimeout(function () { if (S.pendingObject) loadView(); }, 0);
    }
  };
  // also expose the legacy hook name live.js may call
  window.loadNotebooksView = function () { window.RRNotebooks.loadView(); };
})();
</script>
