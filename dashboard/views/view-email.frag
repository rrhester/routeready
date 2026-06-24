
      <div class="page">
        <!-- style block 40 extracted to inline-styles.css -->
        <div class="em-cmd-shell" id="rr-em-cmd">
          <div class="em-cmd-tabs" role="tablist" aria-label="Command strip mode">
            <button class="em-cmd-tab active" type="button" data-em-cmd-tab="email" role="tab" aria-selected="true">Email</button>
            <button class="em-cmd-tab" type="button" data-em-cmd-tab="print" role="tab" aria-selected="false">Print/Download</button>
          </div>
          <div class="em-header">
            <div class="page-header-l">
              <div class="page-icon" data-c="messages" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>
              </div>
              <div>
                <h1 class="page-title">Email</h1>
                <p class="page-sub" id="rr-fb-team-email" title="Your DSP's team email. Outbound from this address; inbound here lands in Inbox."></p>
              </div>
            </div>
            <!-- Action ribbon · icon-over-label tiles matching the
                 schedule's icon strip. Reply / Reply All / Forward
                 share a vertical stack tile. -->
            <div class="em-actions" role="group" aria-label="Email actions">
              <button type="button" class="em-action" data-em-act="new" aria-label="New email" title="New email">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h11l5 5v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><line x1="11" y1="12" x2="17" y2="12"/><line x1="14" y1="9" x2="14" y2="15"/></svg>
                <span>New Email</span>
              </button>
              <button type="button" class="em-action" data-em-act="delete" aria-label="Delete" title="Delete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                <span>Delete</span>
              </button>
              <button type="button" class="em-action" data-em-act="archive" aria-label="Archive" title="Archive">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                <span>Archive</span>
              </button>
              <div class="em-action-stack" role="group" aria-label="Reply actions">
                <button type="button" class="em-action-stack-btn" data-em-act="reply" aria-label="Reply" title="Reply">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                  <span>Reply</span>
                </button>
                <button type="button" class="em-action-stack-btn" data-em-act="reply-all" aria-label="Reply all" title="Reply all">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg>
                  <span>Reply All</span>
                </button>
                <button type="button" class="em-action-stack-btn" data-em-act="forward" aria-label="Forward" title="Forward">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
                  <span>Forward</span>
                </button>
              </div>
              <!-- Document AI tile removed per operator · the Google
                   Document AI hook is in the codebase but the surface
                   wasn't doing visible work, so the tile was retired
                   from the Fleet Bridge ribbon. -->
            </div>
          </div>
        </div>
        <div class="em-grid">
          <aside class="em-aside" aria-label="Email folders">
            <div class="em-aside-head">
              <span class="em-aside-title">Folders</span>
              <button type="button" class="em-new-folder-btn" id="rr-em-new-folder" aria-label="Create folder" title="Create folder">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>New</span>
              </button>
            </div>
            <!-- Inline new-folder form · revealed by the + New button. -->
            <form class="em-new-folder-form" id="rr-em-new-folder-form" hidden>
              <input id="rr-em-new-folder-input" type="text" maxlength="40" placeholder="Folder name" autocomplete="off" />
              <button type="submit" class="em-new-folder-save">Add</button>
              <button type="button" class="em-new-folder-cancel" data-rr-em-new-folder-cancel>Cancel</button>
            </form>
            <nav class="em-folders" id="rr-em-folders" aria-label="Email folder list"></nav>
          </aside>
          <section class="em-main" aria-label="Email content">
            <div class="em-main-head">
              <span class="em-main-title" id="rr-em-main-title">Inbox</span>
              <span class="em-main-count" id="rr-em-main-count"></span>
            </div>
            <div class="em-split" id="rr-em-split">
              <div class="em-inbox" id="rr-em-inbox" aria-label="Inbox list">
                <div class="em-placeholder">
                  <span class="em-placeholder-label">No messages</span>
                  <div>Once email sync is wired up this folder's threads will land here.</div>
                </div>
              </div>
              <div class="em-resizer" id="rr-em-resizer"
                   role="separator" aria-orientation="vertical" tabindex="0"
                   aria-label="Resize inbox panel"
                   title="Drag to resize"></div>
              <div class="em-preview" id="rr-em-preview" aria-label="Email preview">
                <div class="em-placeholder">
                  <span class="em-placeholder-label">No message selected</span>
                  <div>Pick a thread from the inbox to preview it here.</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    