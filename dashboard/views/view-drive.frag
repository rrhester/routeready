
      <div class="page rr-drive-page rr-drive-v2">
        <!-- Enterprise 3-column DMS: left nav · content · preview panel.
             Interaction is unchanged — every row/nav item still carries the
             data-rr-drive-* contract the live.js delegate listens for. -->
        <div class="rr-drive-shell">

          <!-- ── Left navigation (220px) ──────────────────────────────── -->
          <aside class="rr-drive-nav" aria-label="Vault navigation">
            <div class="rr-drive-nav-top">
              <button class="btn btn-primary rr-drive-newbtn" id="rr-drive-new" type="button" aria-haspopup="menu" aria-expanded="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New
                <svg class="rr-drive-new-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <!-- The 3×3 app drawer docks here (placeLauncher() in index.html). -->
              <span class="rr-launcher-dock"></span>
            </div>
            <nav class="rr-drive-navlist" id="rr-drive-navlist" aria-label="Sections"></nav>
            <div class="rr-drive-nav-foot" id="rr-drive-navfoot"></div>
          </aside>

          <!-- ── Center content ───────────────────────────────────────── -->
          <section class="rr-drive-center">
            <div class="rr-drive-gbanner" id="rr-drive-gbanner" hidden></div>
            <!-- Contextual selection bar — replaces the toolbar while ≥1 doc is checked. -->
            <div class="rr-drive-bulkbar" id="rr-drive-bulkbar" hidden></div>
            <div class="rr-drive-toolbar">
              <div class="rr-drive-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="search" id="rr-drive-search" placeholder="Search your vault…" autocomplete="off" spellcheck="false">
              </div>
              <div class="rr-drive-tb-actions">
                <button type="button" class="rr-drive-tbtn" id="rr-drive-sortbtn" aria-haspopup="menu" title="Sort">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="13" y2="6"/><line x1="3" y1="12" x2="11" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/><polyline points="17 8 17 18"/><polyline points="14 15 17 18 20 15"/></svg>
                  <span>Sort</span>
                </button>
                <button type="button" class="rr-drive-tbtn" id="rr-drive-filterbtn" aria-haspopup="menu" title="Filter">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                  <span>Filter</span>
                </button>
                <div class="rr-drive-vtoggle" role="group" aria-label="View">
                  <button type="button" class="rr-drive-vbtn is-active" data-rr-drive-view="list" title="List view" aria-label="List view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
                  <button type="button" class="rr-drive-vbtn" data-rr-drive-view="grid" title="Grid view" aria-label="Grid view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg></button>
                </div>
              </div>
            </div>
            <nav class="rr-drive-crumbs" id="rr-drive-crumbs" aria-label="Breadcrumb"></nav>
            <div class="rr-drive-main" id="rr-drive-main">
              <div class="rr-loading">Loading Vault</div>
            </div>
            <!-- Drag-and-drop upload overlay. -->
            <div class="rr-drive-dropzone" id="rr-drive-dropzone" hidden>
              <div class="rr-drive-dropzone-inner">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <div class="rr-drive-dropzone-title">Drop files to upload</div>
                <div class="rr-drive-dropzone-sub" id="rr-drive-dropzone-sub"></div>
              </div>
            </div>
          </section>

          <!-- ── Right preview / details panel (always present) ────────── -->
          <aside class="rr-drive-details" id="rr-drive-details" aria-label="Document details"></aside>
        </div>

        <input type="file" id="rr-drive-file" hidden multiple>
      </div>
