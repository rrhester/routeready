
      <div class="page rr-drive-page">
        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="drive"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
            <div>
              <h1 class="page-title">Vault</h1>
              <p class="page-sub">Store and organize driver, fleet, HR, and station documents.</p>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn" id="rr-drive-newfolder" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
              New folder
            </button>
            <button class="btn" id="rr-drive-generate" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
              Generate document
            </button>
            <button class="btn btn-primary" id="rr-drive-upload" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload
            </button>
            <!-- The app launcher (3×3 app drawer) docks here on Drive — see
                 placeLauncher() in index.html — so it stays reachable. -->
            <span class="rr-launcher-dock"></span>
          </div>
        </div>

        <!-- Two-column workspace: content · details/preview. (The section rail
             was removed per operator request — category cards + the Recent /
             Shared chips + breadcrumbs carry navigation.) -->
        <div class="rr-drive-shell">
          <section class="rr-drive-center">
            <!-- Contextual selection bar — replaces the toolbar while one or
                 more documents are checked (multi-select bulk actions). -->
            <div class="rr-drive-bulkbar" id="rr-drive-bulkbar" hidden></div>
            <div class="rr-drive-toolbar">
              <nav class="rr-drive-crumbs" id="rr-drive-crumbs" aria-label="Breadcrumb"></nav>
              <div class="rr-drive-chips" id="rr-drive-chips"></div>
              <div class="rr-drive-tb-spacer"></div>
              <div class="rr-drive-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="search" id="rr-drive-search" placeholder="Search documents…" autocomplete="off" spellcheck="false">
              </div>
              <div class="rr-drive-vtoggle" role="group" aria-label="View">
                <button type="button" class="rr-drive-vbtn is-active" data-rr-drive-view="list" title="List view" aria-label="List view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
                <button type="button" class="rr-drive-vbtn" data-rr-drive-view="grid" title="Grid view" aria-label="Grid view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg></button>
              </div>
            </div>
            <div class="rr-drive-main" id="rr-drive-main">
              <div class="rr-loading">Loading Vault</div>
            </div>
            <!-- Drag-and-drop upload overlay (shown while dragging desktop
                 files over the workspace — pointer-events:none so it never
                 swallows the underlying drag events). -->
            <div class="rr-drive-dropzone" id="rr-drive-dropzone" hidden>
              <div class="rr-drive-dropzone-inner">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <div class="rr-drive-dropzone-title">Drop files to upload</div>
                <div class="rr-drive-dropzone-sub" id="rr-drive-dropzone-sub"></div>
              </div>
            </div>
          </section>

          <aside class="rr-drive-details" id="rr-drive-details" aria-label="Document details"></aside>
        </div>

        <input type="file" id="rr-drive-file" hidden multiple>
      </div>
