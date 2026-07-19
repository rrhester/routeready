
      <div class="page" style="padding-bottom:0">
        <!-- Icon header retired per operator request · Messages
             goes straight into the chat shell with no strip card
             above it. The chat shell flexes to fill the page so
             the composer stays anchored at the bottom. -->
        <!-- style block 31 extracted to inline-styles.css -->

        <div class="msg-shell" data-rr-no-drawer>
          <!-- LEFT: messaging navigation + conversation list -->
          <aside class="msg-list">
            <div class="msg-list-head">
              <span class="msg-list-title">Messages</span>
              <div class="msg-head-actions">
                <button class="msg-headbtn" data-rr-saved-messages title="Saved messages" aria-label="Saved messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
                <button class="msg-headbtn" data-rr-scheduled-messages title="Scheduled messages" aria-label="Scheduled messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/><path d="M17 3l4 2-2 4" transform="translate(-1 -1)"/></svg></button>
                <button class="msg-headbtn" data-rr-call-history title="Recent calls" aria-label="Recent calls"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg></button>
                <!-- Call-a-teammate button retired here (redundant · calling
                     lives in the conversation header + Start meeting below);
                     removing it also relieves the header-actions crowding at
                     narrow list widths. _rrToggleTeammateMenu still reachable. -->
                <!-- Recognition · auto-fire toggles for birthday /
                     anniversary / holiday celebration messages. Relocated
                     from Settings → Recognition (it's message automation);
                     opens the recognition slide-over. -->
                <button class="msg-headbtn" id="rr-recog-open" title="Recognition · celebration auto-fire" aria-label="Recognition settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.6 5.8 21 7 14 2 9.3 9 8.5"/></svg></button>
                <button class="msg-newbtn" title="New message" aria-label="New message" onclick="renderNewDmList('');openModal('modal-new-dm')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
              </div>
            </div>
            <div class="msg-list-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="rr-msg-search" type="search" placeholder="Search messages…" aria-label="Search messages" autocomplete="off" />
            </div>
            <!-- Restrained enterprise quick actions — compose a direct
                 message, or spin up a RouteReady meeting. -->
            <div class="msg-quick-actions">
              <button type="button" class="msg-quick-btn" onclick="renderNewDmList('');openModal('modal-new-dm')">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                New message
              </button>
              <button type="button" class="msg-quick-btn" onclick="rrOpenMeetWindow('meet.html')">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                Start meeting
              </button>
            </div>
            <!-- Inbox filter · Drivers (driver-ops chats) / HR (people
                 chats) / Rooms (broadcast channels).  Compact segmented
                 filter — switching a segment only re-filters the list (see
                 msgListTab in live.js); the viewer + composer are untouched. -->
            <div class="msg-list-tabs" role="tablist" aria-label="Filter conversations">
              <button class="msg-list-tab active" data-tab="drivers" role="tab" aria-selected="true" onclick="msgListTab(this)">Drivers</button>
              <button class="msg-list-tab" data-tab="hr" role="tab" aria-selected="false" onclick="msgListTab(this)">HR</button>
              <button class="msg-list-tab" data-tab="broadcasts" role="tab" aria-selected="false" onclick="msgListTab(this)">Rooms</button>
            </div>
            <div class="msg-list-items" id="rr-msg-driver-list">
              <!-- Conversation list skeleton — matches the .msg-item
                   grid (32px avatar | name/preview | time) so the list
                   doesn't reflow when the real rows arrive. -->
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:62%"></span><span class="rr-skel rr-skel-sm" style="width:88%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:48%"></span><span class="rr-skel rr-skel-sm" style="width:75%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:70%"></span><span class="rr-skel rr-skel-sm" style="width:92%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:55%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:65%"></span><span class="rr-skel rr-skel-sm" style="width:84%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:60%"></span><span class="rr-skel rr-skel-sm" style="width:90%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:50%"></span><span class="rr-skel rr-skel-sm" style="width:78%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
              <div class="msg-skel-item"><span class="rr-skel rr-skel-circle" style="width:32px;height:32px;flex:0 0 auto"></span><div class="msg-skel-text"><span class="rr-skel rr-skel-md" style="width:67%"></span><span class="rr-skel rr-skel-sm" style="width:86%"></span></div><span class="rr-skel rr-skel-sm" style="width:34px;flex:0 0 auto"></span></div>
            </div>
          </aside>

          <!-- RIGHT: active conversation -->
          <section class="msg-conv" id="rr-msg-conv">
            <!-- Empty pane — rendered while no conversation is selected.
                 Canonical rr-empty primitive so this reads the same as
                 every other "nothing selected yet" surface. -->
            <div class="rr-empty msg-conv-empty">
              <div class="rr-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <div class="rr-empty-title">Pick a conversation</div>
              <div class="rr-empty-sub">Select a driver, channel, or broadcast from the list to open the thread.</div>
            </div>
          </section>

          <!-- RIGHT RAIL: collapsible driver details panel.  Populated by
               _renderDriverDetails when a driver thread opens; the column
               collapses to zero width (desktop) or slides away (medium /
               small) when closed. -->
          <aside class="msg-details" id="rr-msg-details" aria-hidden="true" aria-label="Driver details"></aside>
        </div>
      </div>

      <!-- ── Recognition drawer ─────────────────────────────────────
           Celebration auto-fire toggles, slid over the Messages view.
           Body is empty here; the .settings-section[data-set=
           "recognition"] node is hoisted in on first open by
           _rrRecognitionDrawer (live.js), preserving loadRecognitionSettings
           + the "Run now" handler. position:fixed + hidden by default. -->
      <div class="rr-slideover-backdrop" id="rr-recog-backdrop" hidden></div>
      <aside class="rr-slideover" id="rr-recog-drawer" role="dialog" aria-modal="true" aria-labelledby="rr-recog-title" hidden>
        <div class="rr-slideover-head">
          <div>
            <h2 class="rr-slideover-title" id="rr-recog-title">Recognition</h2>
            <p class="rr-slideover-sub">Per-celebration auto-fire toggles. A morning job sends the celebrations you enable to qualifying active drivers — nothing fires until you flip a toggle.</p>
          </div>
          <button type="button" class="rr-slideover-close" id="rr-recog-close" aria-label="Close recognition settings">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="rr-slideover-body" id="rr-recog-body"></div>
      </aside>
    