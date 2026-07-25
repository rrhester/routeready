
      <div class="page">
        <!-- style block 40 extracted to inline-styles.css -->
        <!-- Two-level page header (redesign 2026-07-21, operator mockup):
             level 1 = workspace nav tabs, level 2 = compact command
             toolbar. Replaces the old TCP strip + icon-over-label action
             ribbon; message-level actions (Reply / Archive / …) now
             render contextually in the reading pane (live.js
             renderPreview). Each nav tab routes to the app's REAL
             surface for that noun — Templates opens the hiring
             message-template drawer (Onboarding), Contacts toggles the
             utility-rail directory, Settings goes to workspace
             settings. -->
        <nav class="em-nav" aria-label="Email workspace">
          <button type="button" class="em-nav-tab active" data-em-nav="email" aria-current="page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>
            <span>Email</span>
          </button>
          <button type="button" class="em-nav-tab" data-em-nav="templates" title="Message templates — the SMS/email templates applicants and drivers receive (opens the editor on the Onboarding page)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span>Templates</span>
          </button>
          <button type="button" class="em-nav-tab" data-em-nav="contacts" title="Contacts — the station contacts directory">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>Contacts</span>
          </button>
          <button type="button" class="em-nav-tab" data-em-nav="settings" title="Workspace settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>Settings</span>
          </button>
        </nav>
        <div class="em-toolbar" role="toolbar" aria-label="Email commands">
          <button type="button" class="em-btn-new" data-em-act="new">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
            <span>New email</span>
          </button>
          <button type="button" class="em-tool-btn" id="rr-em-refresh" aria-label="Refresh mail" title="Refresh mail">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <div class="em-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="rr-em-search" type="search" placeholder="Search mail" aria-label="Search mail" autocomplete="off" />
          </div>
          <select id="rr-em-scope" class="form-input em-scope" aria-label="Mail filter">
            <option value="all">All mail</option>
            <option value="unread">Unread</option>
            <option value="attach">Has attachments</option>
            <option value="failed">Failed</option>
            <option value="unknown">Unknown senders</option>
          </select>
          <div class="em-toolbar-spacer" aria-hidden="true"></div>
          <button type="button" class="em-account" id="rr-em-account" title="Your team's email address — outbound mail sends from it; inbound to it lands in Inbox. Click to copy.">
            <span class="em-account-label" id="rr-fb-team-email"></span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button type="button" class="em-tool-btn" id="rr-em-settings" aria-label="Workspace settings" title="Workspace settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <div class="em-more-wrap">
            <button type="button" class="em-tool-btn" id="rr-em-more" aria-haspopup="menu" aria-expanded="false" aria-label="More actions" title="More actions">
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
            </button>
            <div class="em-more-menu" id="rr-em-more-menu" role="menu" aria-label="More email actions" hidden>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="mark-all-read">Mark all read</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="new-folder">New folder…</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="toggle-folders" id="rr-em-menu-folders">Hide folder pane</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="toggle-density" id="rr-em-menu-density">Compact rows: Off</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="toggle-notify" id="rr-em-menu-notify">Desktop notifications: Off</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="rules">Mail rules…</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="empty-trash">Empty trash…</button>
              <button type="button" class="em-more-item" role="menuitem" data-em-menu="copy-address">Copy team address</button>
            </div>
          </div>
        </div>
        <!-- Unified email workspace · one bordered card, three panes
             divided by hairlines: folders | message list | reading. -->
        <div class="em-grid" id="rr-em-grid">
          <aside class="em-aside" aria-label="Email folders">
            <div class="em-aside-head">
              <span class="em-aside-title">Folders</span>
              <button type="button" class="em-new-folder-btn" id="rr-em-new-folder" aria-label="Create folder" title="Create folder">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
            <!-- Inline new-folder form · revealed by the + button. -->
            <form class="em-new-folder-form" id="rr-em-new-folder-form" hidden>
              <input id="rr-em-new-folder-input" type="text" maxlength="40" placeholder="Folder name" autocomplete="off" />
              <button type="submit" class="em-new-folder-save">Add</button>
              <button type="button" class="em-new-folder-cancel" data-rr-em-new-folder-cancel>Cancel</button>
            </form>
            <nav class="em-folders" id="rr-em-folders" aria-label="Email folder list"></nav>
          </aside>
          <section class="em-main" aria-label="Email content">
            <div class="em-split" id="rr-em-split">
              <div class="em-list-pane">
                <div class="em-main-head">
                  <span class="em-main-title" id="rr-em-main-title">Inbox</span>
                  <span class="em-main-count" id="rr-em-main-count"></span>
                </div>
                <div class="em-inbox" id="rr-em-inbox" aria-label="Message list">
                  <div class="em-placeholder">
                    <span class="em-placeholder-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg></span>
                    <span class="em-placeholder-label">Your inbox is clear</span>
                    <div>No messages to display.</div>
                  </div>
                </div>
              </div>
              <div class="em-resizer" id="rr-em-resizer"
                   role="separator" aria-orientation="vertical" tabindex="0"
                   aria-label="Resize message list"
                   title="Drag to resize"></div>
              <div class="em-preview" id="rr-em-preview" aria-label="Reading pane">
                <div class="em-placeholder">
                  <span class="em-placeholder-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>
                  <span class="em-placeholder-label">No message selected</span>
                  <div>Choose a message from the inbox to preview it here.</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
