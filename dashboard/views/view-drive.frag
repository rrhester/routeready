
      <div class="page rr-drive-page">
        <div class="page-header">
          <div class="page-header-l">
            <div class="page-icon" data-c="drive"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
            <div>
              <h1 class="page-title">Drive</h1>
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
          </div>
        </div>

        <!-- Three-column workspace: section rail · content · details/preview.
             All three panes are painted by loadDriveView() in live.js. -->
        <div class="rr-drive-shell">
          <aside class="rr-drive-rail" id="rr-drive-rail" aria-label="Drive sections"></aside>

          <section class="rr-drive-center">
            <div class="rr-drive-toolbar">
              <nav class="rr-drive-crumbs" id="rr-drive-crumbs" aria-label="Breadcrumb"></nav>
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
              <div class="rr-loading">Loading Drive</div>
            </div>
          </section>

          <aside class="rr-drive-details" id="rr-drive-details" aria-label="Document details"></aside>
        </div>

        <input type="file" id="rr-drive-file" hidden>
      </div>
