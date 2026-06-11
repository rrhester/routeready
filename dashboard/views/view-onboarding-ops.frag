
      <!-- style block 11 extracted to inline-styles.css -->
      <!-- .tcp-shell · structural lock matching Schedule (PR #1785).
           Flex column, viewport-tall, overflow:hidden. The chrome
           rows below (.tcp + the KPI placeholder) are flex:0 and
           lock their own heights via tokens. Body content (the
           obsub-* sub-pages) scrolls inside its own container and
           can never push the chrome. -->
      <div class="page tcp-shell">
        <!-- Command shell · Onboarding / Print-Download mode tabs
             above the header, matching the Schedule page pattern.
             Carries the .tcp class — chrome dimensions are owned
             by the TopControlPlane tokens in dashboard/tcp.css.
             The .sched-nav-heading card below carries .tcp-strip;
             the KPI band is reserved via the ::after placeholder
             in onboarding-rrx.css (it predates TCP — equivalent
             to .tcp-kpi.is-empty). -->
        <div class="ob-cmd-shell tcp" id="rr-ob-cmd">
        <div class="ob-cmd-tabs" role="tablist" aria-label="Command strip mode">
          <!-- Onboarding is its own sidebar destination now, so this strip
               carries only the Onboarding tab. Schedule / Fleet / Workflows /
               Print are reached from their own sidebar / Schedule strip. -->
          <button class="ob-cmd-tab active" type="button" data-ob-cmd-tab="ops" role="tab" aria-selected="true">Onboarding</button>
        </div>
        <div class="page-header sched-nav-heading tcp-strip">
          <div class="page-header-l">
            <!-- Decorative driver-with-checkmark icon removed per
                 operator request — title alone reads cleaner and
                 matches the Schedule page's text-only header. -->
            <div>
              <h1 class="page-title" id="rr-onboardops-title">On-boarding</h1>
              <p class="page-sub" id="rr-onboardops-sub">Every driver getting ready to drive — readiness at a glance.</p>
            </div>
          </div>
          <!-- Roster actions · only visible when .ob-cmd-shell
               carries .is-roster (set by _obCmdTab when the
               Roster cmd-tab is clicked). Same tile pattern as
               the regular Onboarding ribbon — .sched-ribbon-group
               + .subnav-item — so the hairline divider mechanism
               (border-left on first-of-type group) lines up with
               Schedule's first hairline. Tiles are stubbed inert
               for now; wire onclick to drSub(...) when ready to
               navigate into the Drivers sub-views. -->
          <div class="ob-v2-roster-actions sched-nav-heading-actions sched-ribbon-grouped" aria-label="Roster actions">
            <!-- Group 1 · Roster (lone tile, leads the strip) -->
            <div class="sched-ribbon-group" data-group="roster">
              <div class="subnav" data-rr-tabbar="onboarding-roster">
                <div class="ob-tab-wrap" data-rr-tile="roster-roster">
                  <button class="subnav-item active" type="button" title="Driver roster" onclick="if(typeof _obMountDriverSub==='function') _obMountDriverSub('roster');">
                    <!-- Roster icon · calendar matched to the Attendance
                         icon's height (rect 18 tall + top tabs). Only the
                         LID (top header band, y=4→10) is filled with the
                         Funnel's purple gradient (#A78BFA → #5B21B6); the
                         body + grid stay dark outline, card untouched. -->
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><defs><linearGradient id="rr-roster-icon-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#A78BFA"/><stop offset="100%" stop-color="#5B21B6"/></linearGradient></defs><rect x="3" y="4" width="18" height="6" fill="url(#rr-roster-icon-gradient)" stroke="none"/><rect x="3" y="4" width="18" height="18"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/><line x1="7" y1="18" x2="13" y2="18"/></svg>
                    <span>Roster</span>
                  </button>
                  <button type="button" class="ob-rules-foot" id="rr-roster-rules-toggle"
                          aria-haspopup="dialog" aria-expanded="false"
                          aria-controls="rr-roster-rules-popover"
                          title="Roster display rules · table density">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                  <!-- Roster display rules · table density picker.
                       Mirrors the Schedule grid's density popover
                       (Standard / Compact / Ultra-compact), persisted
                       in localStorage('rr-roster-density') and applied
                       via body classes rr-roster-compact /
                       rr-roster-ultra-compact. The attendance policy
                       builder lives under the SCHEDULE ribbon's Roster
                       icon (#rr-sched-roster-rules-popover), not here. -->
                  <div id="rr-roster-rules-popover" class="ob-att-rules-popover" role="dialog" aria-modal="false" aria-label="Roster display" hidden>
                    <div class="ob-att-rules-head">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="16" x2="13" y2="16"/></svg>
                      <span class="ob-att-rules-head-title">Roster display</span>
                    </div>
                    <div class="ob-att-rules-body">
                      <fieldset class="rr-sched-density-fset" role="radiogroup" aria-label="Table density">
                        <legend style="font:600 13px/18px var(--rr-font-family, 'Segoe UI');color:var(--rr-fg-primary, #242424);margin-bottom:6px">Table density</legend>
                        <p style="font:13px/18px var(--rr-font-family, 'Segoe UI');color:var(--rr-fg-secondary, #605E5C);margin:0 0 12px">Pick how many drivers you want on screen at once.</p>

                        <label class="rr-sched-density-opt">
                          <input type="radio" name="rr-roster-density" value="standard" checked />
                          <span class="rr-sched-density-opt-body">
                            <span class="rr-sched-density-opt-title">Standard</span>
                            <span class="rr-sched-density-opt-sub">Roomy rows with avatars at full size. Easiest to scan.</span>
                          </span>
                        </label>

                        <label class="rr-sched-density-opt">
                          <input type="radio" name="rr-roster-density" value="compact" />
                          <span class="rr-sched-density-opt-body">
                            <span class="rr-sched-density-opt-title">Compact</span>
                            <span class="rr-sched-density-opt-sub">~25% shorter rows. ~50% more drivers visible at once.</span>
                          </span>
                        </label>

                        <label class="rr-sched-density-opt">
                          <input type="radio" name="rr-roster-density" value="ultra" />
                          <span class="rr-sched-density-opt-body">
                            <span class="rr-sched-density-opt-title">Ultra-compact</span>
                            <span class="rr-sched-density-opt-sub">Slimmest rows. Maximum drivers per screen for an overview read.</span>
                          </span>
                        </label>
                      </fieldset>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- Group 2 · Attendance + Coaching (daily driver-quality
                 tiles, share one ribbon group so the hairline divider
                 fires between groups 1↔2 and 2↔3). -->
            <div class="sched-ribbon-group" data-group="daily">
              <div class="subnav" data-rr-tabbar="onboarding-roster">
                <div class="ob-tab-wrap" data-rr-tile="roster-attendance">
                  <button class="subnav-item" type="button" title="Driver attendance" onclick="if(typeof _obMountDriverSub==='function') _obMountDriverSub('attendance');">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 15 11 17 16 12"/></svg>
                    <span>Attendance</span>
                  </button>
                  <!-- Attendance policy builder moved to the Roster icon's
                       Rules chevron (#rr-roster-rules-popover) per operator
                       request, so the Attendance tile no longer carries its
                       own Rules footer. -->
                </div>
                <div class="ob-tab-wrap" data-rr-tile="roster-coaching">
                  <button class="subnav-item" type="button" title="Coaching feed" onclick="if(typeof _obMountDriverSub==='function') _obMountDriverSub('coaching');">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 5h18v12H7l-4 4z"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="13" x2="14" y2="13"/></svg>
                    <span>Coaching</span>
                  </button>
                  <button type="button" class="ob-rules-foot" data-rr-rules-stub title="Coaching rules — coming soon">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <!-- Group 3 · Licences (compliance, trailing solo tile). -->
            <div class="sched-ribbon-group" data-group="compliance">
              <div class="subnav" data-rr-tabbar="onboarding-roster">
                <div class="ob-tab-wrap" data-rr-tile="roster-licences">
                  <button class="subnav-item" type="button" title="Driver licences" onclick="if(typeof _obMountDriverSub==='function') _obMountDriverSub('licences');">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="2" y="5" width="20" height="14"/><circle cx="8" cy="12" r="2.5"/><line x1="13" y1="10" x2="19" y2="10"/><line x1="13" y1="13" x2="19" y2="13"/><line x1="13" y1="16" x2="17" y2="16"/></svg>
                    <span>Licences</span>
                  </button>
                  <button type="button" class="ob-rules-foot" id="rr-lic-rules-toggle"
                          aria-haspopup="dialog" aria-expanded="false"
                          aria-controls="rr-lic-rules-popover"
                          title="License renewals · auto-reminder schedule + message">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                  <!-- License renewals popover · moved here from
                       Settings → License renewals. IDs preserved
                       (rr-lic-toggle-input / -channel-sms / -channel-inapp
                       / -days / -template / -status / data-rr-lic-save) so
                       _rrPrefillLicenseSettings() + the save handler keep
                       working unchanged. Opens leftward (trailing tile) and
                       is narrowed for a tidy form. -->
                  <div id="rr-lic-rules-popover" class="ob-att-rules-popover" role="dialog" aria-modal="false" aria-label="License renewals" style="left:auto;right:0;width:480px" hidden>
                    <div class="ob-att-rules-head">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2.5"/><line x1="13" y1="11" x2="19" y2="11"/><line x1="13" y1="15" x2="17" y2="15"/></svg>
                      <span class="ob-att-rules-head-title">License renewals</span>
                    </div>
                    <div class="ob-att-rules-body">
                      <div style="font-size:var(--fs-sm,13px);color:var(--text-subtle,#605E5C);margin:0 0 4px;line-height:1.5">
                        Auto-remind drivers before their license expires. A daily job checks every driver against your reminder schedule and fires once per threshold per renewal cycle.
                      </div>

                      <div class="rr-lic-row">
                        <div class="rr-lic-text">
                          <div class="rr-lic-label">Auto-reminders enabled</div>
                          <div class="rr-lic-help">When off, no reminders fire regardless of expiry. Renewals still surface on Drivers → Licenses.</div>
                        </div>
                        <label class="toggle"><input type="checkbox" id="rr-lic-toggle-input" data-rr-lic-toggle-input/><span class="toggle-slider"></span></label>
                      </div>

                      <div class="rr-lic-row">
                        <div class="rr-lic-text">
                          <div class="rr-lic-label">Send by SMS</div>
                          <div class="rr-lic-help">Text the driver's phone. Best reach, but counts against your messaging quota.</div>
                        </div>
                        <label class="toggle"><input type="checkbox" id="rr-lic-channel-sms" data-rr-lic-channel="sms"/><span class="toggle-slider"></span></label>
                      </div>

                      <div class="rr-lic-row">
                        <div class="rr-lic-text">
                          <div class="rr-lic-label">Send in the driver app</div>
                          <div class="rr-lic-help">Posts the reminder in the driver's RouteReady app. Free, but only reaches drivers who've signed in.</div>
                        </div>
                        <label class="toggle"><input type="checkbox" id="rr-lic-channel-inapp" data-rr-lic-channel="inapp"/><span class="toggle-slider"></span></label>
                      </div>

                      <div class="rr-lic-field">
                        <div class="rr-lic-label">Reminder days before expiry</div>
                        <div class="rr-lic-help">Comma-separated. A reminder fires the day each threshold is hit. Common: 30, 14, 3.</div>
                        <input class="form-input" id="rr-lic-days" placeholder="30, 14, 3" value="30, 14"/>
                      </div>

                      <div class="rr-lic-field">
                        <div class="rr-lic-label">Message template</div>
                        <div class="rr-lic-help">Tokens: <code>{{name}}</code>, <code>{{days}}</code>, <code>{{date}}</code>. Keep under 160 characters to fit a single SMS.</div>
                        <textarea class="form-input" id="rr-lic-template" rows="3" style="font-family:inherit;resize:vertical">Hi {{name}} — your driver license expires in {{days}} days ({{date}}). Please renew ASAP and send a photo of your new license.</textarea>
                      </div>

                      <div class="rr-lic-foot">
                        <span id="rr-lic-status" class="u-xs-subtle"></span>
                        <button class="btn btn-primary" type="button" data-rr-lic-save>Save settings</button>
                      </div>
                    </div>
                    <!-- style block 12 extracted to inline-styles.css -->
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Print/Download actions · only visible when the
               Print/Download mode tab is active (.ob-cmd-shell
               gains .is-print, sibling CSS reveals these and
               hides the regular tiles). Mirrors Schedule's
               .sched-v2-print-actions pattern — same .sched-print-btn
               class so the tiles render at exactly the same
               size/style as Schedule's print tiles. IDs preserved
               so existing live.js handlers keep working. -->
          <div class="ob-v2-print-actions" aria-label="Print actions">
            <button class="sched-print-btn" type="button" id="rr-ob-print-btn" aria-label="Print the readiness matrix">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              <span>Print page</span>
            </button>
            <button class="sched-print-btn" type="button" id="rr-ob-csv-btn" aria-label="Download the readiness matrix as a CSV">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Download CSV</span>
            </button>
            <!-- PTO report tile relocated to Schedule's print
                 actions per operator request — that report
                 surfaces driver PTO/time-off, which fits the
                 Schedule context better than Onboarding. See
                 #rr-ob-pto-print-btn on the Schedule strip. -->
          </div>

          <!-- Icon command strip · three groups separated by hairline
               dividers (rendered via CSS `+` selector on
               .sched-ribbon-group). Same divider mechanism as the
               Schedule strip. Group order:
                 1) Sourcing      — Funnel, Documents, Interview Day, Calendar
                 2) Readiness     — Onboarding, Work auth
                 3) Quick action  — Add applicant -->
          <div class="sched-nav-heading-actions">
            <div class="sched-ribbon-group" data-group="sourcing" style="order:2">
              <div class="subnav" data-rr-tabbar="onboarding-ops">
                <div class="ob-tab-wrap" draggable="true" data-rr-tile="ob-funnel">
                  <button class="subnav-item ob-funnel-tab" data-obsub="funnel" onclick="obSub('funnel')" title="Hiring funnel">
                    <!-- Microsoft-purple funnel · linear gradient from a
                         lighter top (#A78BFA) to a darker bottom (#5B21B6).
                         Applied as both stroke AND fill so the silhouette
                         reads as a solid purple funnel. -->
                    <svg viewBox="0 0 24 24" fill="url(#rr-ob-funnel-gradient)" stroke="url(#rr-ob-funnel-gradient)" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">
                      <defs>
                        <linearGradient id="rr-ob-funnel-gradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="#A78BFA"/>
                          <stop offset="100%" stop-color="#5B21B6"/>
                        </linearGradient>
                      </defs>
                      <path d="M3 4h18l-7 8.5v6.5l-4 2v-8.5z"/>
                    </svg>
                    <span>Funnel</span>
                  </button>
                  <!-- Funnel "Rules" · kept persistently visible (the primary
                       way to edit screening questions / funnel stages), with
                       the subtle box-arrow launcher like the Calendar +
                       Onboarding-steps rules. -->
                  <button type="button" class="ob-rules-foot ob-rules-foot-shown" id="rr-funnel-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-funnel-rules-popover" title="Screening questions — what applicants answer before booking">
                    Rules
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/><line x1="8" y1="8" x2="13.5" y2="13.5"/><polyline points="13.5 10 13.5 13.5 10 13.5"/></svg>
                  </button>
                  <!-- style block 13 extracted to inline-styles.css -->
                  <div class="ob-rules-popover" id="rr-funnel-rules-popover" role="dialog" aria-modal="false" aria-label="Screening questions" hidden>
                    <div class="ob-rules-head">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4"/><path d="M9 13l2 2 4-4"/></svg>
                      Screening questions
                    </div>
                    <div class="ob-rules-body">
                      <p style="margin:0 0 12px;font-size:var(--fs-sm);color:var(--text-subtle)" id="rr-screening-sub">The questions an applicant answers before booking.</p>
                      <div class="cal-edit-card" style="padding:var(--s-3-5) 18px">
                        <div data-rr-questions></div>
                        <div data-rr-questions-footer style="margin-top:14px">
                          <button class="btn" data-rr-add-question>+ Add question</button>
                        </div>
                      </div>

                      <div style="margin-top:var(--s-5);margin-bottom:var(--s-3)">
                        <h3 style="margin:0;font-size:var(--fs-md);font-weight:600">Video screening</h3>
                        <p style="margin:2px 0 0;font-size:var(--fs-sm);color:var(--text-subtle)">Optional 60-second intro video the applicant records after passing the question screen.</p>
                      </div>
                      <div class="cal-edit-card">
                        <div class="cal-edit-section">
                          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--s-3)">
                            <div>
                              <div class="cal-edit-label" style="margin-bottom:0">Enable video screening</div>
                              <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">When on, the screening page also asks the applicant to record a short intro.</div>
                            </div>
                            <button class="ref-toggle" id="rr-video-enabled-toggle" data-rr-video-toggle></button>
                          </div>
                        </div>
                        <div class="cal-edit-section">
                          <div class="cal-edit-label">Video prompt shown to the applicant</div>
                          <textarea id="rr-video-prompt" class="cal-edit-input" style="min-height:64px;font-family:inherit" placeholder="In 60 seconds, tell us why you'd be a great fit for our team."></textarea>
                        </div>
                        <div class="cal-edit-section">
                          <div class="cal-edit-label">Maximum recording length (seconds)</div>
                          <input id="rr-video-max-seconds" type="number" min="15" max="180" step="15" class="cal-edit-input" style="max-width:120px" value="60" />
                        </div>
                        <div class="cal-edit-foot">
                          <div class="cal-edit-status" id="rr-video-status"></div>
                        </div>
                      </div>

                      <!-- SMS & messaging · relocated from Settings → SMS &
                           messaging (operator preference — screening SMS
                           settings belong with the funnel's screening rules).
                           Same controls, restyled into the popover's card
                           pattern. The switch is the pure-CSS .toggle (no JS
                           wiring needed, matching the original). -->
                      <div style="margin-top:var(--s-5);margin-bottom:var(--s-3)">
                        <h3 style="margin:0;font-size:var(--fs-md);font-weight:600">SMS &amp; messaging</h3>
                        <p style="margin:2px 0 0;font-size:var(--fs-sm);color:var(--text-subtle)">Quiet hours, opt-out handling, default templates.</p>
                      </div>
                      <div class="cal-edit-card">
                        <div class="cal-edit-section">
                          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);flex-wrap:wrap">
                            <div>
                              <div class="cal-edit-label" style="margin-bottom:0">SMS quiet hours</div>
                              <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">No SMS sent to applicants or drivers between these hours.</div>
                            </div>
                            <div style="display:flex;gap:var(--s-2-5);align-items:center">
                              <input class="cal-edit-input" style="max-width:120px" id="rr-sms-quiet-start" value="9:00 PM" />
                              <span class="u-subtle">to</span>
                              <input class="cal-edit-input" style="max-width:120px" id="rr-sms-quiet-end" value="7:00 AM" />
                            </div>
                          </div>
                        </div>
                        <div class="cal-edit-section">
                          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--s-3)">
                            <div>
                              <div class="cal-edit-label" style="margin-bottom:0">Auto-send screening SMS</div>
                              <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">When you add a new applicant, send screening link automatically.</div>
                            </div>
                            <label class="toggle"><input type="checkbox" id="rr-sms-autosend" checked /><span class="toggle-slider"></span></label>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <!-- Documents subnav tab removed — #view-documents
                     now mounts into the Overview tab's right-side
                     placeholder card instead. See _obMountDocuments
                     in live.js. -->

                <div class="ob-tab-wrap" draggable="true" data-rr-tile="ob-interview">
                  <button class="subnav-item" data-obsub="interview" onclick="obSub('interview')" title="Interview">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15.5 13.5"/></svg>
                    <span>Interview</span>
                  </button>
                  <button type="button" class="ob-rules-foot" data-rr-rules-stub title="Interview rules — coming soon">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                </div>
                <div class="ob-tab-wrap" draggable="true" data-rr-tile="ob-overview">
                  <button class="subnav-item active" data-obsub="overview" onclick="obSub('overview')" title="Onboarding">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="3" width="16" height="18"/><rect x="9" y="1.5" width="6" height="4"/><polyline points="8 11 10 13 13 10"/><line x1="15" y1="11" x2="17" y2="11"/><polyline points="8 16 10 18 13 15"/><line x1="15" y1="16" x2="17" y2="16"/></svg>
                    <span>Onboarding</span>
                  </button>
                  <!-- Onboarding-steps Rules · the one rules-foot that stays
                       visible (it's the primary way to edit the onboarding
                       blueprint, so it must be discoverable). Shows the
                       "Rules" label + the subtle box-arrow launcher, matching
                       the Calendar group's Rules. -->
                  <button type="button" class="ob-rules-foot ob-rules-foot-shown" id="rr-ob-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-ob-rules-popover" title="Onboarding steps — edit the onboarding blueprint">
                    Rules
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/><line x1="8" y1="8" x2="13.5" y2="13.5"/><polyline points="13.5 10 13.5 13.5 10 13.5"/></svg>
                  </button>
                  <div class="ob-rules-popover" id="rr-ob-rules-popover" role="dialog" aria-modal="false" aria-label="Onboarding steps" hidden>
                    <div class="ob-rules-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><polyline points="3.5 6 4.5 7 6.5 5"/><polyline points="3.5 12 4.5 13 6.5 11"/><polyline points="3.5 18 4.5 19 6.5 17"/></svg>Onboarding steps</div>
                    <div class="ob-rules-body" id="obsub-builder"><div class="rr-loading">Loading onboarding steps</div></div>
                  </div>
                </div>
              </div>
            </div><!-- /group: sourcing -->

            <!-- Calendar view controls · always on the strip. New event + the
                 four views (Day / Week / Work Week / Month). Clicking a view
                 switches to the calendar and sets it. Interview-availability
                 Rules live on the Week tile. Wired in live.js. order:1 = first. -->
            <div class="sched-ribbon-group" data-group="calendar-controls" id="rr-cal-ribbon" style="order:1;position:relative">
              <div class="subnav" data-rr-tabbar="calendar-controls">
                <!-- New-action subgroup (New event / Add calendar) · same
                     full-height group treatment as the view-selector below, so
                     the "New" group caption centers under the pair and sits on
                     the strip's bottom line, mirroring "Rules". -->
                <div class="rr-cal-newgroup">
                <button class="subnav-item" type="button" onclick="rrIvcalNewEvent()" title="New event">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="12" y1="12.5" x2="12" y2="18.5"/><line x1="9" y1="15.5" x2="15" y2="15.5"/></svg>
                  <span>New event</span>
                </button>
                <button class="subnav-item" type="button" onclick="rrIvcalAddCalendar()" title="Add calendar">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><circle cx="17.5" cy="16.5" r="4.2" fill="var(--oc-surface,#fff)"/><line x1="17.5" y1="14.3" x2="17.5" y2="18.7"/><line x1="15.3" y1="16.5" x2="19.7" y2="16.5"/></svg>
                  <span>Add calendar</span>
                </button>
                <span class="rr-cal-newgroup-cap" aria-hidden="true">New</span>
                </div><!-- /.rr-cal-newgroup -->
                <div class="ob-tab-divider" aria-hidden="true"></div>
                <!-- View-selector subgroup (Day / Week / Work Week / Month) ·
                     mirrors the Schedule page's .sched-v2-viewgroup so the
                     "Rules" caption centers under the view tiles and the
                     dialog-launcher pins to the group's bottom-right next to
                     the hairline — the same location as Schedule's "Go To". -->
                <div class="rr-cal-viewgroup">
                <button class="subnav-item rr-cal-vtab" data-cal-view="day" type="button" onclick="rrIvcalSetView('day')" title="Day view">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="12" y1="13" x2="12" y2="18"/></svg>
                  <span>Day</span>
                </button>
                <div class="ob-tab-wrap" data-rr-tile="ob-cal-week">
                  <button class="subnav-item rr-cal-vtab" data-cal-view="week" type="button" onclick="rrIvcalSetView('week')" title="Week view">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="9" y1="9" x2="9" y2="22"/><line x1="15" y1="9" x2="15" y2="22"/></svg>
                    <span>Week</span>
                  </button>
                  <div class="ob-rules-popover" id="rr-iv-rules-popover" role="dialog" aria-modal="false" aria-label="Interview availability" hidden>
                    <div class="ob-rules-head">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                      Interview availability
                    </div>
                    <div class="ob-rules-body">
                      <p style="margin:0 0 12px;font-size:var(--fs-sm);color:var(--text-subtle)">The days, times, capacity, and one-off group sessions applicants see on your RouteReady booking page.</p>
                      <div class="rr-iv-card" id="rr-iv-card">
                        <div id="rr-iv-body"><div class="rr-loading">Loading…</div></div>
                      </div>
                    </div>
                  </div>
                </div>
                <button class="subnav-item rr-cal-vtab" data-cal-view="workweek" type="button" onclick="rrIvcalSetView('workweek')" title="Work week (Mon–Fri)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><defs><linearGradient id="rr-workweek-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#A78BFA"/><stop offset="100%" stop-color="#5B21B6"/></linearGradient></defs><rect x="3" y="7" width="18" height="5" fill="url(#rr-workweek-gradient)" stroke="none"/><rect x="3" y="7" width="18" height="13"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
                  <span>Work Week</span>
                </button>
                <button class="subnav-item rr-cal-vtab" data-cal-view="month" type="button" onclick="rrIvcalSetView('month')" title="Month view">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="18"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="22"/><line x1="15" y1="9" x2="15" y2="22"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
                  <span>Month</span>
                </button>
                <!-- Rules caption + dialog-launcher · one fixed-height footer
                     row so the browser vertically centers the caption AND the
                     launcher on the same line (caption centered, launcher
                     pinned bottom-right by the hairline) — same arrangement as
                     Schedule's "Go To" + launcher. -->
                <div class="rr-cal-rules-foot" aria-hidden="false">
                  <span class="rr-cal-rules-cap" aria-hidden="true">Rules</span>
                  <button type="button" class="rr-cal-rules-launch" id="rr-iv-rules-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="rr-iv-rules-popover" title="Interview availability — days, times, capacity, and group sessions">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/><line x1="8" y1="8" x2="13.5" y2="13.5"/><polyline points="13.5 10 13.5 13.5 10 13.5"/></svg>
                  </button>
                </div>
                </div><!-- /.rr-cal-viewgroup -->
              </div>
            </div><!-- /group: calendar-controls -->

            <!-- (Onboarding moved into the sourcing group; Work auth into the
                 actions group. The Readiness group was retired in the flat
                 strip reorder.) -->

            <!-- Group 3: actions (flat-strip tail) · order:3 -->
            <div class="sched-ribbon-group" data-group="actions" style="order:3">
              <div class="subnav" data-rr-tabbar="onboarding-actions">
                <!-- Work authorization (moved from the retired Readiness group). -->
                <div class="ob-tab-wrap" draggable="true" data-rr-tile="ob-workauth">
                  <button class="subnav-item" data-obsub="workauth" onclick="obSub('workauth')" title="Work authorization">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 14.5 11 16.5 15.5 11.5"/></svg>
                    <span>Work auth</span>
                  </button>
                  <button type="button" class="ob-rules-foot" data-rr-rules-stub title="Work auth rules — coming soon">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                </div>
                <div class="ob-tab-wrap" draggable="true" data-rr-tile="ob-addapplicant">
                  <button class="subnav-item" onclick="openAddApplicantModal()" title="Add applicant">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="2" y="5" width="14" height="14"/><line x1="5" y1="9" x2="9" y2="9"/><line x1="5" y1="12" x2="13" y2="12"/><line x1="5" y1="15" x2="11" y2="15"/><line x1="20" y1="7" x2="20" y2="15"/><line x1="16" y1="11" x2="24" y2="11"/></svg>
                    <span>Add applicant</span>
                  </button>
                  <button type="button" class="ob-rules-foot" data-rr-rules-stub title="Add applicant rules — coming soon">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                </div>
                <!-- Import · keeps the former PDF-Upload icon + action, relabeled
                     to "Import" per operator request. -->
                <div class="ob-tab-wrap" draggable="true" data-rr-tile="ob-pdf-upload">
                  <button class="subnav-item" onclick="openPdfUploadPicker()" title="Import (upload a PDF)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="5" y="3" width="14" height="18" rx="2"/>
                      <line class="rr-pdf-arrow" x1="12" y1="16" x2="12" y2="9"/>
                      <polyline class="rr-pdf-arrow" points="9 12 12 9 15 12"/>
                    </svg>
                    <span>Import</span>
                  </button>
                  <button type="button" class="ob-rules-foot" data-rr-rules-stub title="Import rules — coming soon">
                    Rules
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>
                  </button>
                </div>
                <!-- Hidden file input that openPdfUploadPicker clicks. -->
                <input type="file" id="rr-ob-pdf-upload-input" accept="application/pdf" style="display:none" multiple/>
                <div class="ob-tab-divider" aria-hidden="true"></div>
              </div>
              <!-- Actions group · no caption/launcher (Add applicant + PDF Upload
                   are actions, not a rules/nav group). -->
            </div><!-- /group: actions -->
          </div>
        </div><!-- /page-header.sched-nav-heading -->
        </div><!-- /ob-cmd-shell -->

        <!-- TCP KPI band · Onboarding has no metrics yet, but the
             card surface IS visible (empty white card) to match
             Schedule's empty-then-populated #rr-sched-kpis behavior.
             Drops `.is-empty` (which would visibility:hidden it)
             so the card renders. Future: when Onboarding starts
             emitting KPI pills, just put them inside this div. -->
        <div id="rr-ob-kpis" class="sched-kpi-pills tcp-kpi" aria-label="Onboarding metrics"></div>

        <!-- Onboarding KPI strip removed · never populated by JS,
             rendered as an empty white card below the icon strip.
             On the Funnel sub-view, the hp-stats-banner now sits
             directly below the icon strip (same position as the
             Schedule KPI strip), styled with matching chrome via
             the rules in #pipe-sub-funnel below. -->

        <!-- Print/Download buttons (Print page / Download CSV /
             PTO report) moved INTO the .page-header.sched-nav-heading
             strip card above as .ob-v2-print-actions tiles — matches
             the Schedule page's Print/Download mode pattern exactly.
             Old body-rendered .ob-print-actions block removed; the
             same IDs (rr-ob-print-btn, rr-ob-csv-btn,
             rr-ob-pto-print-btn) are preserved on the new tiles so
             live.js click handlers keep working unchanged. -->
        <div id="rr-ob-print-area" aria-hidden="true"></div>

        <!-- Driver-roster mount point · when the operator clicks
             the Roster cmd-tab, _obCmdTab('roster') moves the
             live #dr-sub-roster node from #view-drivers into this
             slot, AND injects a CSS alias block so all the
             #view-drivers .x rules also apply to
             #ob-roster-mount .x — preserving the table's styling
             after the move. Hidden + empty until first roster-mode
             entry. -->
        <div id="ob-roster-mount" class="ob-roster-mount" hidden></div>

        <div id="obsub-overview">
          <!-- Two-column shell: the readiness matrix lives in
               .ob-overview-left (loadOnboardingOps writes there);
               .ob-overview-right is a sibling placeholder card the
               operator will populate with moved-in items shortly. -->
          <div class="ob-overview-cols" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">
            <div id="obsub-overview-left" class="ob-overview-left">
              <!-- Skeleton readiness matrix — 4 cohort cards stacked.
                   Replaced by loadOnboardingOps() once data arrives. -->
              <div class="onb-skel-grid" aria-busy="true">
                <div class="onb-skel-card"><span class="rr-skel rr-skel-md" style="width:30%"></span><span class="rr-skel rr-skel-sm" style="width:70%"></span><span class="rr-skel rr-skel-sm" style="width:60%"></span></div>
                <div class="onb-skel-card"><span class="rr-skel rr-skel-md" style="width:36%"></span><span class="rr-skel rr-skel-sm" style="width:84%"></span><span class="rr-skel rr-skel-sm" style="width:68%"></span></div>
                <div class="onb-skel-card"><span class="rr-skel rr-skel-md" style="width:28%"></span><span class="rr-skel rr-skel-sm" style="width:76%"></span><span class="rr-skel rr-skel-sm" style="width:54%"></span></div>
                <div class="onb-skel-card"><span class="rr-skel rr-skel-md" style="width:32%"></span><span class="rr-skel rr-skel-sm" style="width:80%"></span><span class="rr-skel rr-skel-sm" style="width:64%"></span></div>
              </div>
            </div>
            <!-- #view-documents is mounted into this card by
                 _obMountDocuments() on Overview activation. -->
            <div id="ob-docs-mount" class="ob-overview-right ob-placeholder-card" aria-label="Documents">
              <div class="ob-placeholder-inner ob-docs-loading">
                <div class="ob-placeholder-title">Documents</div>
                <div class="ob-placeholder-sub">Loading…</div>
              </div>
            </div>
          </div>

        </div>

        <!-- style block 14 extracted to inline-styles.css -->
        <!-- style block 15 extracted to inline-styles.css -->

        <div id="obsub-workauth" style="display:none">
          <div id="rr-i9-queue">
            <div class="rr-loading">Loading work authorization queue</div>
          </div>
        </div>

        <!-- Onboarding builder (#obsub-builder) now lives in the Rules
             popover under the Onboarding icon, not as a sub-page. -->

        <!-- Hiring pipeline host — the whole #view-pipeline block is
             relocated here by _obMountPipeline() the first time a
             pipeline icon is opened. The Funnel / Interview Day /
             Calendar icons drive pipeSub() inside it. -->
        <div id="obsub-pipeline" style="display:none"></div>

        <!-- Documents now mounts into #ob-docs-mount inside the
             Overview tab's right column (see _obMountDocuments).
             The old #obsub-documents host is removed. -->

      </div>
    