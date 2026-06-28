<!-- ════════════════════════════════════════════════════════════════════
     MARKETPLACE — RouteReady's integrations + extensions hub.
     Shell only: the category chips, app cards and the connect drawer body
     are painted by loadMarketplaceView() in live.js from the RR_MKT_APPS
     catalog. Built on the shared design system (.page / .card / .btn /
     .rr-drawer) so it reads as a first-class app, App-Store style.
     ════════════════════════════════════════════════════════════════════ -->
<div class="page rr-mkt" id="rr-mkt-page">
  <div class="page-header rr-mkt-header">
    <div class="page-header-l">
      <div class="rr-mkt-titlewrap">
        <span class="rr-mkt-hero-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18l-1.6-5.6A1 1 0 0 0 18.5 3H5.5a1 1 0 0 0-.95.7z"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21V13h6v8"/></svg>
        </span>
        <div>
          <h1 class="page-title">Marketplace</h1>
          <p class="page-sub">Connect the software your business already uses.</p>
        </div>
      </div>
    </div>
    <div class="page-actions">
      <div class="dr-search rr-mkt-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" id="rr-mkt-search" placeholder="Search applications…" autocomplete="off" spellcheck="false" aria-label="Search applications">
      </div>
    </div>
  </div>

  <!-- Category filter · chips painted by JS (Featured + categories + RouteReady). -->
  <div class="rr-mkt-cats" id="rr-mkt-cats" role="tablist" aria-label="Marketplace categories"></div>

  <!-- App grid / category sections · painted by renderMarketplace(). -->
  <div class="rr-mkt-body" id="rr-mkt-grid"></div>

  <!-- ── Connect drawer (right-side) · reuses the shared .rr-drawer chrome.
       Title / logo / description / permissions / footer are filled per-app
       by openMarketplaceConnect(). Mock OAuth only — no real auth. ────── -->
  <div class="rr-drawer-backdrop" id="rr-mkt-backdrop" data-rr-mkt-close></div>
  <aside class="rr-drawer rr-mkt-drawer" id="rr-mkt-drawer" aria-hidden="true" role="dialog" aria-labelledby="rr-mkt-drawer-title">
    <div class="rr-drawer-head">
      <div class="rr-mkt-dh">
        <span class="rr-mkt-logo rr-mkt-dh-logo" id="rr-mkt-drawer-logo" aria-hidden="true"></span>
        <div style="min-width:0">
          <p class="modal-title" id="rr-mkt-drawer-title">Connect</p>
          <p class="modal-sub" id="rr-mkt-drawer-sub">—</p>
        </div>
      </div>
      <button class="rr-drawer-close" type="button" data-rr-mkt-close aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="rr-drawer-body" id="rr-mkt-drawer-body"></div>
    <div class="rr-mkt-drawer-foot" id="rr-mkt-drawer-foot"></div>
  </aside>
</div>
