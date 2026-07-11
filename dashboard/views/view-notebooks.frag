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
/* The view is a normal block child of .main (which already begins to the
   right of the app sidebar), sized to the viewport so its three panes fill
   the content column and scroll internally — no window-level absolute
   positioning, so it never slides under the sidebar. */
#view-notebooks{color:var(--text);font-size:var(--fs-base)}
#view-notebooks.active{display:block;height:100vh;overflow:hidden;background:var(--canvas)}
.rrnb-shell{height:100%;display:grid;
  grid-template-columns:248px 300px 1fr;min-height:0;min-width:0}
.rrnb-pane{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;
  border-right:1px solid var(--border);background:var(--surface)}
.rrnb-pane--canvas{border-right:0;background:var(--canvas)}

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
.rrnb-menu-sep{height:1px;background:var(--border);margin:var(--s-1) 0}
.rrnb-menu-add{color:var(--accent);font-weight:600}

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
.rrnb-editor figure.rrnb-fig.sel img{outline:2px solid var(--accent);outline-offset:2px}
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
.rrnb-pop-btn{height:32px;padding:0 var(--s-3);border:0;border-radius:var(--r-md);background:var(--accent);
  color:var(--surface);font-weight:600;cursor:pointer;font-size:var(--fs-sm)}
.rrnb-pop-btn.ghost{background:transparent;color:var(--text-muted);border:1px solid var(--border)}
.rrnb-pop-list{max-height:240px;overflow:auto;margin-top:var(--s-2)}
.rrnb-pop-opt{padding:var(--s-2);border-radius:var(--r-md);cursor:pointer;font-size:var(--fs-base)}
.rrnb-pop-opt:hover,.rrnb-pop-opt.sel{background:var(--accent-soft)}
.rrnb-pop-opt .mut{font-size:var(--fs-xs);color:var(--text-subtle)}

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
.rrnb-tb-ai{color:var(--heritage,#7719aa)}
.rrnb-tb-ai:hover{background:var(--heritage-soft,rgba(119,25,170,.08))}
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
.rrnb-aipanel button.pri{background:var(--accent);color:#fff;border-color:var(--accent)}
.rrnb-aipanel button:hover{filter:brightness(.98)}
.rrnb-spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;
  display:inline-block;animation:rrnbspin .6s linear infinite}
@keyframes rrnbspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rrnb-spin{animation:none}}
@media (max-width:1100px){.rrnb-shell{grid-template-columns:220px 260px 1fr}}
@media (max-width:860px){.rrnb-shell{grid-template-columns:1fr}
  .rrnb-pane:not(.rrnb-pane--canvas){display:none}}
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
      <input id="rrnb-search-input" type="search" placeholder="Search all notebooks…  (Ctrl+F)" autocomplete="off" />
    </div>
    <div class="rrnb-offline" id="rrnb-offline" hidden>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4"/></svg>
      <span>Offline — changes are saved on this device and will sync when you reconnect.</span>
    </div>
    <div class="rrnb-pagelist" id="rrnb-pagelist"></div>
  </div>

  <!-- ── Pane 3: page canvas / editor ─────────────────────────────── -->
  <div class="rrnb-pane rrnb-pane--canvas">
    <div class="rrnb-canvas-wrap" id="rrnb-canvas-wrap">
      <div class="rrnb-blank" id="rrnb-blank">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/></svg>
        <div>Select a page, or press <b>Alt+N</b> to create one.</div>
      </div>
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
      createNotebook: function (name, color) { return rpc("notebook_create", { p_name: name, p_color: color }); },
      createGroup: function (nb, name) { return rpc("notebook_section_group_create", { p_notebook_id: nb, p_name: name }); },
      createSection: function (nb, name, grp, color) { return rpc("notebook_section_create", { p_notebook_id: nb, p_name: name, p_group_id: grp || null, p_color: color }); },
      createPage: function (sec, title, parent, level) { return rpc("notebook_page_create", { p_section_id: sec, p_title: title, p_parent_page_id: parent || null, p_level: level || 0 }); },
      getPage: function (id) { return rpc("notebook_page_get", { p_id: id }); },
      savePage: function (id, p) { return rpc("notebook_page_save", { p_id: id, p_title: p.title, p_content_html: p.content_html, p_content_text: p.content_text, p_tags: p.tags }); },
      rename: function (kind, id, name, color) { return rpc("notebook_item_rename", { p_kind: kind, p_id: id, p_name: name, p_color: color || null }); },
      movePage: function (id, p) { return rpc("notebook_page_move", { p_id: id, p_section_id: p.section_id || null, p_parent_page_id: p.parent_page_id || null, p_level: p.level == null ? null : p.level, p_position: p.position == null ? null : p.position }); },
      pinPage: function (id, on) { return rpc("notebook_page_pin", { p_id: id, p_pinned: !!on }); },
      duplicatePage: function (id) { return rpc("notebook_page_duplicate", { p_id: id }); },
      deleteItem: function (kind, id) { return rpc("notebook_item_delete", { p_kind: kind, p_id: id }); },
      recycleList: function (nb) { return rpc("notebook_recycle_list", { p_notebook_id: nb }); },
      restoreItem: function (kind, id) { return rpc("notebook_item_restore", { p_kind: kind, p_id: id }); },
      setLinks: function (page, links) { return rpc("notebook_links_set", { p_source_page_id: page, p_links: links }); },
      backlinks: function (page) { return rpc("notebook_page_backlinks", { p_page_id: page }); },
      search: function (q, opt) { opt = opt || {}; return rpc("notebook_search", { p_query: q, p_notebook_id: opt.notebookId || null, p_tag: opt.tag || null, p_limit: 50 }); }
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
            content_html: "<h2>Formatting</h2><ul><li><b>Ctrl+B / I / U</b> — bold, italic, underline</li><li><b>Ctrl+1</b> — to-do checkbox</li><li><b>Ctrl+K</b> — insert link</li><li><b>Alt+N</b> — new page</li></ul>",
            content_text: "Keyboard shortcuts formatting bold italic underline to-do link new page" }
        ]
      };
    }
    load();
    function P(v) { return Promise.resolve(v); }
    function nb(id) { return db.notebooks.filter(function (n) { return n.id === id; })[0]; }
    return {
      kind: "local",
      listNotebooks: function () { return P(db.notebooks.map(function (n) {
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
        if (!found) { var id = uid(); found = { id: id, name: title || (t.charAt(0).toUpperCase() + t.slice(1) + " notebook"), color: "#2563eb", kind: "object", subject_type: t, subject_id: String(i), is_pinned: false, position: db.notebooks.length };
          db.notebooks.push(found); db.sections.push({ id: uid(), notebook_id: id, group_id: null, name: "Notes", color: "#2563eb", position: 0 }); persist(); }
        return P(found);
      },
      createNotebook: function (name, color) { var id = uid(); var n = { id: id, name: name || "New Notebook", color: color || "#2563eb", kind: "workspace", is_pinned: false, position: db.notebooks.length, subject_type: null, subject_id: null };
        db.notebooks.push(n); db.sections.push({ id: uid(), notebook_id: id, group_id: null, name: "New Section", color: color || "#2563eb", position: 0 }); persist(); return P(n); },
      createGroup: function (nbId, name) { var g = { id: uid(), notebook_id: nbId, name: name || "New Group", color: "#64748b", position: db.groups.length }; db.groups.push(g); persist(); return P(g); },
      createSection: function (nbId, name, grp, color) { var s = { id: uid(), notebook_id: nbId, group_id: grp || null, name: name || "New Section", color: color || "#2563eb", position: db.sections.length }; db.sections.push(s); persist(); return P(s); },
      createPage: function (sec, title, parent, level) { var s = db.sections.filter(function (x) { return x.id === sec; })[0]; var now = new Date().toISOString();
        var p = { id: uid(), notebook_id: s ? s.notebook_id : null, section_id: sec, parent_page_id: parent || null, level: level || 0, position: db.pages.length, title: title || "Untitled Page", content_html: "", content_text: "", tags: [], is_pinned: false, created_at: now, updated_at: now };
        db.pages.push(p); persist(); return P(p); },
      getPage: function (id) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; return P(p ? JSON.parse(JSON.stringify(p)) : null); },
      savePage: function (id, patch) { var p = db.pages.filter(function (x) { return x.id === id; })[0]; if (p) { if (patch.title != null) p.title = patch.title; if (patch.content_html != null) p.content_html = patch.content_html; if (patch.content_text != null) p.content_text = patch.content_text; if (patch.tags != null) p.tags = patch.tags; p.updated_at = new Date().toISOString(); persist(); } return P(p ? { id: p.id, title: p.title, updated_at: p.updated_at } : null); },
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
          return { id: p.id, notebook_id: p.notebook_id, section_id: p.section_id, title: p.title, tags: p.tags, notebook_name: n ? n.name : "", section_name: s ? s.name : "", snippet: esc(snip) }; })); }
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

  function notify(msg) { try { if (window.toast) return window.toast(msg); if (window.rrToast) return window.rrToast(msg); } catch (e) {} }
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
      renderSections(); renderPageList();
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
      return '<div class="rrnb-menu-item" data-nb="' + n.id + '"><span class="rrnb-swatch" style="background:' + esc(n.color) + '"></span>' +
        '<span class="nm">' + esc(n.name) + '</span><span class="ct">' + (n.page_count || 0) + '</span></div>';
    }).join("");
    html += '<div class="rrnb-menu-sep"></div><div class="rrnb-menu-item rrnb-menu-add" data-new="1">＋ New notebook</div>';
    m.innerHTML = html;
  }

  // ── sections rail ────────────────────────────────────────────────
  function renderSections() {
    var host = $id("rrnb-sections"); if (!host) return;
    if (!S.tree) { host.innerHTML = '<div class="rrnb-empty">No notebook selected.</div>'; return; }
    var groups = S.tree.groups || [], sections = S.tree.sections || [];
    var byGroup = {}; sections.forEach(function (s) { var g = s.group_id || "_"; (byGroup[g] = byGroup[g] || []).push(s); });
    var html = "";
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
        '<span class="tw">▾</span><span>' + esc(g.name) + '</span></div>' +
        (byGroup[g.id] || []).map(secRow).join("") + '</div>';
    });
    html += '<button class="rrnb-newpage" data-add-section="1" style="margin-top:var(--s-2)">＋ New section</button>';
    host.innerHTML = html;
  }

  // ── page list ────────────────────────────────────────────────────
  function renderPageList() {
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
    if (pinned.length) { html += '<div class="rrnb-plgroup-hd">Pinned</div>' + pinned.map(function (p) { return pageRow(p, true); }).join(""); html += '<div class="rrnb-plgroup-hd">Pages</div>'; }
    function walk(p) { html += pageRow(p, false); (kids[p.id] || []).forEach(walk); }
    tops.forEach(walk);
    html += '<div class="rrnb-pageadd"><button class="rrnb-newpage" data-add-page="1">＋ Add page  <span style="margin-left:auto;color:var(--text-disabled)">Alt+N</span></button>' +
      '<button class="rrnb-newpage rrnb-tpl-btn" data-template-menu="1" title="New page from a template">▤</button></div>';
    host.innerHTML = html;
  }
  function pageRow(p, pinnedCtx) {
    var on = p.id === S.pageId ? " active" : "";
    var lvl = pinnedCtx ? "" : (p.level === 1 ? " lvl1" : p.level >= 2 ? " lvl2" : "");
    var pin = p.is_pinned ? " pinned" : "";
    return '<div class="rrnb-page' + on + lvl + pin + '" data-page="' + p.id + '" draggable="true">' +
      '<div class="body"><div class="ttl">' + esc(p.title || "Untitled Page") + '</div>' +
      '<div class="sub">' + esc(relTime(p.updated_at)) + (p.tags && p.tags.length ? '  ·  ' + p.tags.map(esc).join(", ") : "") + '</div></div>' +
      '<span class="pin" title="Pinned">★</span>' +
      '<button class="rrnb-iconbtn kebab" data-menu="page" data-id="' + p.id + '" title="Page options">⋯</button></div>';
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
    S.pageId = null; S.page = null;
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
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="todo" title="To-do checkbox (Ctrl+1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="insertUnorderedList" title="Bulleted list (Ctrl+.)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h11M9 12h11M9 18h11"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="insertOrderedList" title="Numbered list (Ctrl+/)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6h11M9 12h11M9 18h11"/><text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="quote" title="Quote">“</button>' +
      '<button class="rrnb-tb" data-cmd="code" title="Code block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="callout" title="Callout">⚑</button>' +
      '<button class="rrnb-tb" data-cmd="hr" title="Divider">—</button>' +
      '<button class="rrnb-tb" data-cmd="table" title="Insert table"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="image" title="Insert picture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5-5-6 6-3-3-4 4"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="attach" title="Attach a file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.6 1.6 0 0 1-2.3-2.3l8.3-8.3"/></svg></button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb" data-cmd="link" title="Link (Ctrl+K)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></button>' +
      '<button class="rrnb-tb" data-cmd="pagelink" title="Link to a page">[[ ]]</button>' +
      '<button class="rrnb-tb" data-cmd="smartlink" title="Auto-link objects (drivers, Van 27, Route 341)">⚡</button>' +
      '<span class="rrnb-tb-sep"></span>' +
      '<button class="rrnb-tb rrnb-tb-ai" data-cmd="ai" title="AI: summarize, rewrite, extract action items…"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5 10.1 11 5.5 9l4.6-1.4L12 3z"/><path d="M18 15l.8 2 2 .8-2 .8L18 21l-.8-2-2-.8 2-.8.8-2z"/></svg><span style="margin-left:5px;font-weight:600">AI</span></button>' +
      '<button class="rrnb-tb" data-cmd="removeFormat" title="Clear formatting"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 5h13M9 5l-2 14M5 19h6"/><path d="M15 12l6 6M21 12l-6 6"/></svg></button>' +
    '</div>';

  function openPage(id) {
    // flush any pending save of the previous page first
    flushSave();
    S.be.getPage(id).then(function (p) {
      if (!p) { showBlank(); return; }
      S.pageId = id; S.page = p; S.mode = "notebook"; S.savedAt = p.updated_at;
      trackRecent(p);
      renderCanvas(p);
      renderPageList();
    }).catch(fail);
  }

  function renderCanvas(p) {
    var wrap = $id("rrnb-canvas-wrap"); if (!wrap) return;
    var nb = (S.notebooks.filter(function (n) { return n.id === S.nbId; })[0]) || {};
    var sec = ((S.tree && S.tree.sections) || []).filter(function (s) { return s.id === p.section_id; })[0] || {};
    wrap.innerHTML =
      '<div class="rrnb-doc">' +
        '<div class="rrnb-breadcrumb">' + esc(nb.name || "Notebook") + ' <span class="sep">›</span> ' + esc(sec.name || "Section") + ' <span class="sep">›</span> ' + esc(p.title || "Page") + '</div>' +
        '<input class="rrnb-title" id="rrnb-title" placeholder="Untitled Page" value="' + esc(p.title || "") + '" />' +
        '<div class="rrnb-metaline"><span class="rrnb-save" id="rrnb-save"><span class="dot"></span><span id="rrnb-save-txt">Saved</span></span>' +
          '<span id="rrnb-author">' + esc(p.author || "") + '</span></div>' +
        TOOLBAR_HTML +
        '<div class="rrnb-editor" id="rrnb-editor" contenteditable="true" spellcheck="true" data-ph="Type anywhere. Everything autosaves.">' + (p.content_html || "") + '</div>' +
        '<div class="rrnb-tagbar" id="rrnb-tagbar"></div>' +
        '<div class="rrnb-backlinks" id="rrnb-backlinks"></div>' +
      '</div>';
    var ed = $id("rrnb-editor"), title = $id("rrnb-title");
    autoGrow(title);
    title.addEventListener("input", function () { autoGrow(title); scheduleSave(); updateBreadcrumbTitle(); });
    title.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); ed.focus(); } });
    ed.addEventListener("input", function () { scheduleSave(); autoLinkify(); });
    ed.addEventListener("keydown", onEditorKey);
    ed.addEventListener("click", onEditorClick);
    ed.addEventListener("keyup", refreshToolbarState);
    ed.addEventListener("mouseup", refreshToolbarState);
    ed.addEventListener("paste", onEditorPaste);
    ed.addEventListener("dragover", function (e) { e.preventDefault(); ed.classList.add("rrnb-drop"); });
    ed.addEventListener("dragleave", function () { ed.classList.remove("rrnb-drop"); });
    ed.addEventListener("drop", onEditorDrop);
    bindToolbar();
    makeCaptionsEditable();
    renderTags(p.tags || []);
    renderBacklinks(id_of(p));
    refreshSaveLabel();
  }
  function id_of(p) { return p.id || S.pageId; }
  function autoGrow(el) { if (!el) return; el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  function updateBreadcrumbTitle() { var b = $(".rrnb-breadcrumb"); var t = $id("rrnb-title"); if (b && t) { var parts = b.innerHTML.split("›"); parts[parts.length - 1] = " " + esc(t.value || "Page"); b.innerHTML = parts.join("<span class=sep>›</span>"); } }

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
  function insertTodo() {
    var sel = window.getSelection();
    var txt = sel && sel.toString() ? esc(sel.toString()) : "";
    insertHTMLAtCursor('<div class="rrnb-todo" data-checked="0"><span class="rrnb-todo-box" contenteditable="false"></span><span class="rrnb-todo-text">' + (txt || "​") + '</span></div><p><br></p>');
  }
  function insertCodeBlock() { insertHTMLAtCursor('<pre><code>' + (esc(window.getSelection().toString()) || "​") + '</code></pre><p><br></p>'); }
  function insertCallout() { insertHTMLAtCursor('<div class="rrnb-callout"><span class="ico">💡</span><div>' + (esc(window.getSelection().toString()) || "Note…") + '</div></div><p><br></p>'); }

  function onEditorClick(e) {
    var box = e.target.closest(".rrnb-todo-box");
    if (box) { var row = box.closest(".rrnb-todo"); row.setAttribute("data-checked", row.getAttribute("data-checked") === "1" ? "0" : "1"); box.textContent = row.getAttribute("data-checked") === "1" ? "✓" : ""; scheduleSave(); return; }
    var img = e.target.closest("figure.rrnb-fig img");
    var ed = $id("rrnb-editor");
    if (ed) ed.querySelectorAll("figure.rrnb-fig.sel").forEach(function (f) { f.classList.remove("sel"); });
    if (img) { var fig = img.closest("figure.rrnb-fig"); fig.classList.add("sel"); openImageSize(fig, img); return; }
    var fl = e.target.closest("a.rrnb-file"); if (fl) { return; } // let the download link work
    var pl = e.target.closest("a.rrnb-pagelink");
    if (pl && (e.ctrlKey || e.metaKey || e.type === "click")) { var pid = pl.getAttribute("data-page-id"); if (pid) { e.preventDefault(); openPage(pid); } return; }
    var ol = e.target.closest("a.rrnb-objlink");
    if (ol) { e.preventDefault(); var ot = ol.getAttribute("data-obj-type"), oi = ol.getAttribute("data-obj-id"); openObjectRef(ot, oi, ol.getAttribute("data-obj-name") || ol.textContent); }
  }
  function openObjectRef(type, id, name) { if (window.RRNotebooks && window.RRNotebooks.openFor) window.RRNotebooks.openFor(type, id, name || null); }

  // ══════════════════════════════════════════════════════════════════
  //  MEDIA — images (paste / drop / pick, client-side compressed) + files
  // ══════════════════════════════════════════════════════════════════
  var MAX_IMG_DIM = 1600, MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB inline cap
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
      insertHTMLAtCursor('<figure class="rrnb-fig"><img src="' + dataUrl + '" alt="' + esc(file.name || "image") + '" /><figcaption></figcaption></figure><p><br></p>');
      makeCaptionsEditable(); scheduleSave();
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
  function insertFileAttachment(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { notify('"' + (file.name || "file") + '" is over 8 MB — large files land in Phase 3 (Storage offload).'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var ext = ((file.name || "").split(".").pop() || "file").slice(0, 4);
      insertHTMLAtCursor('<a class="rrnb-file" contenteditable="false" href="' + reader.result + '" download="' + esc(file.name || "file") + '">' +
        '<span class="fic">' + esc(ext) + '</span><span class="fnm"><b>' + esc(file.name || "file") + '</b><span>' + fmtBytes(file.size) + '</span></span></a><p><br></p>');
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
    var pop = showPop('<label>Picture size</label><div class="rrnb-sizes">' +
      '<button data-imgw="25">25%</button><button data-imgw="50">50%</button><button data-imgw="75">75%</button><button data-imgw="100">100%</button></div>', r);
    pop.addEventListener("click", function (e) { var b = e.target.closest("[data-imgw]"); if (!b) return;
      img.style.width = b.getAttribute("data-imgw") + "%"; img.style.height = "auto"; hidePop(); scheduleSave(); });
  }

  // ── keyboard shortcuts in the editor ─────────────────────────────
  function onEditorKey(e) {
    var mod = e.ctrlKey || e.metaKey;
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
    var ed = $id("rrnb-editor"), title = $id("rrnb-title");
    if (!ed || !title) return null;
    return { title: title.value.trim() || "Untitled Page", content_html: ed.innerHTML, content_text: ed.innerText || "", tags: (S.page && S.page.tags) || [] };
  }
  function scheduleSave() {
    setSaveState("saving");
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(doSave, 650);
  }
  function flushSave() { if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; doSave(); } }
  function doSave() {
    S.saveTimer = null;
    var pid = S.pageId; if (!pid) return;
    var data = currentEditorData(); if (!data) return;
    S.saving = true;
    S.be.savePage(pid, data).then(function (r) {
      S.saving = false; S.savedAt = (r && r.updated_at) || new Date().toISOString();
      setSaveState("saved");
      // reflect the new title in the list
      if (S.tree) { var pg = S.tree.pages.filter(function (x) { return x.id === pid; })[0]; if (pg) { pg.title = data.title; pg.updated_at = S.savedAt; } }
      renderPageList();
      persistLinks(pid);
    }).catch(function (e) { S.saving = false; setSaveState("err"); console.warn(e); });
  }
  function setSaveState(st) {
    var box = $id("rrnb-save"); if (!box) return;
    box.classList.remove("saving", "err");
    if (st === "saving") { box.classList.add("saving"); $id("rrnb-save-txt").textContent = "Saving…"; }
    else if (st === "err") { box.classList.add("err"); $id("rrnb-save-txt").textContent = "Save failed — retrying"; setTimeout(doSave, 2500); }
    else refreshSaveLabel();
  }
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
    var host = $id("rrnb-backlinks"); if (!host) return;
    S.be.backlinks(pid).then(function (rows) {
      if (!rows || !rows.length) { host.innerHTML = ""; return; }
      host.innerHTML = '<h4>Linked from</h4>' + rows.map(function (r) {
        return '<a class="rrnb-backlink" data-goto-page="' + r.page_id + '" data-goto-nb="' + r.notebook_id + '">← ' + esc(r.title) + '</a>';
      }).join("");
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
      insertHTMLAtCursor('<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(txt) + '</a>&nbsp;');
      hidePop(); scheduleSave();
    });
  }

  function openPagePicker() {
    var range = savedSelection();
    var pages = ((S.tree && S.tree.pages) || []).filter(function (p) { return p.id !== S.pageId; });
    function optList(q) {
      q = (q || "").toLowerCase();
      return pages.filter(function (p) { return !q || (p.title || "").toLowerCase().indexOf(q) >= 0; }).slice(0, 40)
        .map(function (p) { return '<div class="rrnb-pop-opt" data-pick-page="' + p.id + '">' + esc(p.title || "Untitled") + '</div>'; }).join("") ||
        '<div class="rrnb-pop-opt" style="color:var(--text-subtle)">No matching page</div>';
    }
    var pop = showPop('<label>Link to page</label><input id="rrnb-pp-q" placeholder="Search pages…" /><div class="rrnb-pop-list" id="rrnb-pp-list">' + optList("") + '</div>', selRect());
    var q = $id("rrnb-pp-q"); q.focus();
    q.addEventListener("input", function () { $id("rrnb-pp-list").innerHTML = optList(q.value); });
    pop.addEventListener("click", function (e) { var o = e.target.closest("[data-pick-page]"); if (!o) return;
      var pid = o.getAttribute("data-pick-page"); var pg = pages.filter(function (p) { return p.id === pid; })[0];
      $id("rrnb-editor").focus(); restoreSelection(range);
      insertHTMLAtCursor('<a class="rrnb-pagelink" data-page-id="' + pid + '" href="#">' + esc(pg ? pg.title : "page") + '</a>&nbsp;');
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
    var known = byName[word.toLowerCase()];
    if (known) { a.setAttribute("data-obj-type", known.type); a.setAttribute("data-obj-id", known.id); }
    else if (/^route/i.test(word)) { a.setAttribute("data-obj-type", "route"); a.setAttribute("data-obj-id", word.replace(/\D+/g, "")); }
    else { a.setAttribute("data-obj-type", "vehicle"); a.setAttribute("data-obj-id", word.replace(/\D+/g, "")); }
    a.textContent = word; return a;
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
        if (caretAware && caretAbs >= 0) setCaretAt(ed, caretAbs);
        scheduleSave(); persistLinks(S.pageId);
        if (manual) notify(replaced + " link" + (replaced > 1 ? "s" : "") + " added");
      } else if (manual) notify("No drivers, vehicles or routes recognized on this page");
    });
  }
  function smartLink(manual) { linkifyEditor(false, manual); }
  // Auto-link ~1.4s after a pause in typing.
  var autoLinkify = debounce(function () { if (S.pageId) linkifyEditor(true, false); }, 1400);

  // ══════════════════════════════════════════════════════════════════
  //  SEARCH
  // ══════════════════════════════════════════════════════════════════
  var runSearch = debounce(function (q) {
    var host = $id("rrnb-pagelist"); if (!host) return;
    S.be.search(q, {}).then(function (rows) {
      S.mode = "search";
      if (!rows || !rows.length) { host.innerHTML = '<div class="rrnb-empty">No results for “' + esc(q) + '”.</div>'; return; }
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
    showCtx(x, y, [
      { act: "rename", label: "Rename" },
      { act: "pin", label: p.is_pinned ? "Unpin" : "Pin to top" },
      { act: "sub", label: "Make subpage (Tab)" },
      { act: "promote", label: "Promote (Shift+Tab)" },
      { act: "dup", label: "Duplicate" },
      { sep: 1 }, { act: "del", label: "Delete", danger: true }
    ]);
    $id("rrnb-ctx")._target = { kind: "page", id: id };
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
  function handleCtx(act) {
    var t = $id("rrnb-ctx")._target; hideCtx(); if (!t) return;
    if (t.kind === "page") {
      if (act === "rename") return renamePrompt("page", t.id);
      if (act === "pin") { var p = pageById(t.id); return S.be.pinPage(t.id, !(p && p.is_pinned)).then(function () { if (p) p.is_pinned = !p.is_pinned; renderPageList(); }); }
      if (act === "dup") return S.be.duplicatePage(t.id).then(function () { return selectNotebook(S.nbId, null); });
      if (act === "del") return S.be.deleteItem("page", t.id).then(function () { if (S.pageId === t.id) showBlank(); return selectNotebook(S.nbId, null); });
      if (act === "sub") return indentPage(t.id, +1);
      if (act === "promote") return indentPage(t.id, -1);
    }
    if (t.kind === "section") {
      if (act === "rename") return renamePrompt("section", t.id);
      if (act === "recolor") return recolorSection(t.id);
      if (act === "newgroup") return S.be.createGroup(S.nbId, "New Group").then(function () { return selectNotebook(S.nbId, S.pageId); });
      if (act === "del") return S.be.deleteItem("section", t.id).then(function () { S.activeSection = null; return selectNotebook(S.nbId, null); });
    }
  }
  function pageById(id) { return ((S.tree && S.tree.pages) || []).filter(function (x) { return x.id === id; })[0]; }
  function recolorSection(id) {
    var s = ((S.tree && S.tree.sections) || []).filter(function (x) { return x.id === id; })[0]; if (!s) return;
    var cur = PALETTE.indexOf(s.color); var next = PALETTE[(cur + 1) % PALETTE.length];
    S.be.rename("section", id, s.name, next).then(function () { s.color = next; renderSections(); });
  }
  function renamePrompt(kind, id) {
    var cur = kind === "page" ? (pageById(id) || {}).title : (((S.tree && S.tree.sections) || []).filter(function (x) { return x.id === id; })[0] || {}).name;
    var v = window.prompt("Rename", cur || ""); if (v == null) return;
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
    if (cur) cur.addEventListener("click", function () { var m = $id("rrnb-nb-menu"); m.hidden = !m.hidden; });
    var menu = $id("rrnb-nb-menu");
    if (menu) menu.addEventListener("click", function (e) {
      var add = e.target.closest("[data-new]"); if (add) { menu.hidden = true; return createNotebookFlow(); }
      var it = e.target.closest("[data-nb]"); if (it) { menu.hidden = true; S.activeSection = null; selectNotebook(it.getAttribute("data-nb")); }
    });

    // sections rail (delegated)
    var secHost = $id("rrnb-sections");
    if (secHost) secHost.addEventListener("click", function (e) {
      var nn = e.target.closest("[data-new-notebook]"); if (nn) return createNotebookFlow();
      var kb = e.target.closest("[data-menu='section']"); if (kb) { var r = kb.getBoundingClientRect(); return sectionMenu(kb.getAttribute("data-id"), r.left, r.bottom); }
      var tg = e.target.closest("[data-toggle]"); if (tg) { var g = tg.getAttribute("data-toggle"); S.collapsedGroups[g] = !S.collapsedGroups[g]; return renderSections(); }
      var add = e.target.closest("[data-add-section]"); if (add) { return S.be.createSection(S.nbId, "New Section", null, PALETTE[(S.tree.sections.length) % PALETTE.length]).then(function (s) { S.activeSection = s.id; return selectNotebook(S.nbId, null); }); }
      var sec = e.target.closest("[data-sec]"); if (sec) { S.activeSection = sec.getAttribute("data-sec"); S.mode = "notebook"; renderSections(); renderPageList(); var f = firstPageOf(S.activeSection); if (f) openPage(f); else showBlank(); }
    });

    // page list (delegated)
    var plHost = $id("rrnb-pagelist");
    if (plHost) {
      plHost.addEventListener("click", function (e) {
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
    });

    // global shortcuts while the view is active
    document.addEventListener("keydown", function (e) {
      var v = ROOT(); if (!v || !v.classList.contains("active")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.shiftKey) { var s = $id("rrnb-search-input"); if (s) { e.preventDefault(); s.focus(); s.select(); } }
      if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); if (e.shiftKey) newSection(); else newPage(); }
      if (e.altKey && e.key.toLowerCase() === "q") { e.preventDefault(); quickNote(); }
      if (e.key === "Escape") { hidePop(); hideCtx(); hideAiMenu(); }
      // OneNote-style page ops — only when NOT typing in the editor/inputs
      if (!typingContext() && S.pageId && S.mode === "notebook") {
        if (e.key === "F2") { e.preventDefault(); renamePrompt("page", S.pageId); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (window.confirm("Move this page to the Recycle Bin?")) S.be.deleteItem("page", S.pageId).then(function () { showBlank(); return selectNotebook(S.nbId, null); }).catch(fail); return; }
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
  function createNotebookFlow() {
    var name = window.prompt("New notebook name", "New Notebook"); if (name == null) return;
    var color = PALETTE[S.notebooks.length % PALETTE.length];
    S.be.createNotebook(name || "New Notebook", color).then(function (nb) {
      return S.be.listNotebooks().then(function (list) { S.notebooks = list; renderNotebookMenu(); S.activeSection = null; return selectNotebook(nb.id); });
    }).catch(fail);
  }
  function newSection() {
    S.be.createSection(S.nbId, "New Section", null, PALETTE[((S.tree && S.tree.sections.length) || 0) % PALETTE.length]).then(function (s) { S.activeSection = s.id; return selectNotebook(S.nbId, null); }).catch(fail);
  }
  function newPage() {
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
  function openTemplateMenu(anchor) {
    var r = anchor.getBoundingClientRect();
    var pop = showPop('<label>New page from template</label><div class="rrnb-pop-list">' +
      TEMPLATES.map(function (t) { return '<div class="rrnb-pop-opt" data-tpl="' + t.id + '">' + esc(t.name) + '</div>'; }).join("") + '</div>', r);
    pop.addEventListener("click", function (e) { var o = e.target.closest("[data-tpl]"); if (!o) return; hidePop(); createFromTemplate(o.getAttribute("data-tpl")); });
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

  // ── Quick Notes: capture into a "Quick Notes" section of the current notebook ──
  function quickNote() {
    if (!S.nbId && S.notebooks[0]) S.nbId = S.notebooks[0].id;
    if (!S.nbId) return;
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
        aiError(p, (error && error.message) || (data && (data.detail || data.error)) || "The notebook-ai function isn't available yet.");
        return;
      }
      if (data.tags && data.tags.length) return aiShowTags(p, label, data.tags);
      aiShowResult(p, label, String(data.result || ""), ctx.hasSelection);
    }).catch(function (e) { aiError(p, (e && e.message) || "AI request failed."); });
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
