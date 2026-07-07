
      <div class="page">
        <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--s-3)">
          <div>
            <h1 class="page-title">Settings</h1>
            <p class="page-sub">Workspace, integrations, hiring, and team configuration</p>
          </div>
          <button class="btn btn-ghost" type="button" onclick="openAuditLog()" title="Who changed what - drivers, schedule, roles, documents">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 3"/></svg>
            Activity log
          </button>
        </div>

        <div class="settings-layout">
          <nav class="settings-nav">
            <button class="settings-nav-item active" data-set="workspace" onclick="setSettingsSection(this)">Workspace</button>
            <button class="settings-nav-item" data-set="team" onclick="setSettingsSection(this)">Team</button>
            <button class="settings-nav-item" data-set="hiring-messages" onclick="setSettingsSection(this)">Hiring messages</button>
            <button class="settings-nav-item" data-set="referrals" onclick="setSettingsSection(this)">Hiring referrals</button>
            <!-- SMS & messaging moved to Onboarding → Funnel ▸ Rules -->
            <!-- License renewals moved to Onboarding → Roster → Licences ▸ Rules -->
            <button class="settings-nav-item" data-set="scheduling" onclick="setSettingsSection(this)">Scheduling</button>
            <button class="settings-nav-item" data-set="recognition" onclick="setSettingsSection(this); if (typeof loadRecognitionSettings === 'function') loadRecognitionSettings();">Recognition</button>
            <button class="settings-nav-item" data-set="billing" onclick="setSettingsSection(this)">Billing</button>
          </nav>

          <div>
            <div class="settings-section" data-set="workspace">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Workspace</h2>
                <p class="settings-section-sub">Basic information about your DSP.</p>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">DSP name</div>
                  <div class="form-help">Shown in SMS and emails sent to applicants and drivers.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center">
                  <input class="form-input" id="rr-set-dsp-name" value="" style="flex:1"/>
                  <button class="btn btn-sm btn-primary" id="rr-set-dsp-name-save" type="button">Save</button>
                </div>
              </div>
              <!-- Team email · the DSP's unique Email address.
                   Derived from the Station code: <short_code>@mail
                   .gorouteready.com. Share with vendors; inbound mail
                   lands in Email → Inbox. -->
              <div class="form-row">
                <div>
                  <div class="form-label">Team email</div>
                  <div class="form-help">Your DSP's unique address. Share with vendors — inbound mail lands in Email → Inbox. Outbound mail you send from Email goes out from this address.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center">
                  <input class="form-input" id="rr-set-fb-email" value="" readonly style="flex:1;background:var(--canvas);font-family:ui-monospace,SFMono-Regular,Menlo,monospace"/>
                </div>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">Reply email</div>
                  <div class="form-help">When applicants hit Reply on a hiring email, the reply lands in this inbox. Leave blank to use your DSP's default support address.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center">
                  <input class="form-input" id="rr-set-dsp-reply-email" type="email" placeholder="hiring@your-dsp.com" value="" style="flex:1"/>
                  <button class="btn btn-sm btn-primary" id="rr-set-dsp-reply-email-save" type="button">Save</button>
                </div>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">Business address</div>
                  <div class="form-help">Your DSP's business/organization address. Appears on Form I-9 Section 2 ("Employer's Business or Organization Address") and other employer documents.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center">
                  <input class="form-input" id="rr-set-dsp-address" placeholder="123 Main St, Springfield, MO 65810" value="" style="flex:1"/>
                  <button class="btn btn-sm btn-primary" id="rr-set-dsp-address-save" type="button">Save</button>
                </div>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">Station code</div>
                  <div class="form-help">Your primary Amazon delivery station.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center">
                  <input class="form-input" id="rr-set-dsp-code" value="" style="flex:1"/>
                  <button class="btn btn-sm btn-primary" id="rr-set-dsp-code-save" type="button">Save</button>
                </div>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">Time zone</div>
                  <div class="form-help">Used for SMS quiet hours and report timestamps.</div>
                </div>
                <div>
                  <select class="form-input">
                    <option>America/Chicago (Central)</option>
                    <option>America/New_York (Eastern)</option>
                    <option>America/Denver (Mountain)</option>
                    <option>America/Los_Angeles (Pacific)</option>
                  </select>
                </div>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">Station location (weather tracking)</div>
                  <div class="form-help">Latitude and longitude — paste from Google Maps. Stored on the DSP record so the system can log local weather every day for performance insights.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center;flex-wrap:wrap">
                  <input class="form-input" id="rr-set-weather-lat" placeholder="38.886" style="max-width:120px" inputmode="decimal"/>
                  <input class="form-input" id="rr-set-weather-lon" placeholder="-76.910" style="max-width:120px" inputmode="decimal"/>
                  <button class="btn btn-sm btn-primary" id="rr-set-weather-save" type="button">Save</button>
                  <span id="rr-set-weather-status" class="u-xs-subtle"></span>
                </div>
              </div>
              <div class="form-row">
                <div>
                  <div class="form-label">Backfill weather history</div>
                  <div class="form-help">Pull the last year of local daily weather (temp, precip, wind, conditions) for your station so the call-out forecast can start predicting today instead of waiting weeks to learn. Safe to re-run — it skips days already logged.</div>
                </div>
                <div style="display:flex;gap:var(--s-2);align-items:center;flex-wrap:wrap">
                  <button class="btn btn-sm" id="rr-set-weather-backfill" type="button">Backfill 1 year</button>
                  <span id="rr-set-weather-backfill-status" class="u-xs-subtle"></span>
                </div>
              </div>
            </div>

            <!-- SMS & MESSAGING SECTION · moved · now opens from the
                 Onboarding → Funnel tile's Rules footer. See the
                 "SMS & messaging" block in #rr-funnel-rules-popover
                 (#view-onboarding-ops). -->

            <!-- LICENSE RENEWALS SECTION · moved · now opens from the
                 Onboarding → Roster → Licences tile's Rules footer.
                 See #rr-lic-rules-popover in #view-onboarding-ops. The
                 settings markup (and its rr-lic-* IDs) lives there now;
                 _rrPrefillLicenseSettings() + the save handler are
                 unchanged. -->


            <!-- SCHEDULING SECTION -->
            <div class="settings-section hidden" data-set="scheduling">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Scheduling</h2>
                <p class="settings-section-sub">DSP-wide rules the schedule engine, Cover, and driver self-service all read. Per-week overrides still live behind the gear icon on the Schedule view.</p>
              </div>

              <div class="rules-grid">

                <!-- Attendance policy moved · now opens from the
                     Onboarding → Roster → Attendance tile's Rules
                     footer. See #rr-att-rules-popover in
                     #view-onboarding-ops. -->

                <details class="rules-section" data-rr-rules-section="availability-rules" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    Availability rules
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Lead time on driver availability changes, the auto-response messages drivers receive on approve / deny, and blackout windows where driver-initiated availability changes are blocked.
                  </div>
                  <div class="card u-mb-4">
                    <h3 style="margin:0 0 4px;font-size:var(--fs-base);font-weight:700">Settings</h3>
                    <p style="font-size:var(--fs-sm);color:var(--text-subtle);margin:0 0 14px">Lead time and the auto-response messages drivers receive on approve / deny.</p>
                    <div data-rr-avail-settings></div>
                  </div>
                  <div class="card">
                    <h3 style="margin:0 0 4px;font-size:var(--fs-base);font-weight:700">Blackout dates</h3>
                    <p style="font-size:var(--fs-sm);color:var(--text-subtle);margin:0 0 14px">Windows where drivers cannot submit availability changes — e.g. peak season, holidays.</p>
                    <div data-rr-avail-blackouts></div>
                  </div>
                </details>

                <details class="rules-section" data-rr-rules-section="fleet-assign" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/></svg>
                    Fleet assignments
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    How the system fills gaps between scheduled drivers and vans. Standing chains (primary + backup) are still set on the Workspaces → Van assignments board.
                  </div>
                  <div class="rule-row" style="padding:var(--s-3-5) 0">
                    <div>
                      <div class="rule-label">Auto-assign vans to scheduled drivers</div>
                      <div class="rule-help">When on, the Today's Plan home page fills every "No van" gap automatically as soon as it opens, pulling from your active + spare pool. Per-day overrides only — the standing chain isn't changed. Manual changes from the Today's roster always override this.</div>
                    </div>
                    <label class="rr-switch">
                      <input type="checkbox" id="rr-set-auto-van-assign" data-rr-fleet-setting="auto_van_assign">
                      <span class="rr-switch-track" aria-hidden="true"></span>
                      <span class="rr-switch-label" data-rr-auto-van-label>Off</span>
                    </label>
                  </div>
                  <!-- style block 18 extracted to inline-styles.css -->
                </details>

                <details class="rules-section" data-rr-rules-section="floor" style="grid-column:1/-1" open>
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/><polyline points="9 12 11 14 15 10"/></svg>
                    Always enforced · system floor
                    <span class="rules-sub-badge ok">Locked</span>
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    These guardrails apply to every DSP and aren't configurable. They protect against data corruption, payroll mistakes, and compliance violations. Open this section any time you want to see exactly what the schedule engine is doing behind the scenes.
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-2) 16px">
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">No double-booking</div>
                        <div class="rule-help">A driver can't hold two shifts on the same date in <code>scheduled</code>, <code>completed</code>, or <code>late</code> status.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">No past-date assignments</div>
                        <div class="rule-help">Cover and driver pickup only operate on shifts dated after today.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Expired driver's license blocks scheduling</div>
                        <div class="rule-help">Drivers whose DL expires on or before the shift date are skipped by Cover and pickup.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Service-type certifications</div>
                        <div class="rule-help">DOT-required service types need <code>dot_certified</code> drivers; XL-required service types need <code>xl_certified</code> drivers.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Approved time-off blocks scheduling</div>
                        <div class="rule-help">Cover, pickup, and swaps all skip drivers with an <code>approved</code> PTO request that overlaps the shift date.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Inactive drivers excluded</div>
                        <div class="rule-help">Only drivers with <code>status = active</code> appear in Cover or pickup eligibility.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Every shift edit audited</div>
                        <div class="rule-help">Driver, date, time, route, and status changes write an immutable row to <code>shift_changes</code> (visible in the Activity feed).</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Cross-DSP isolation</div>
                        <div class="rule-help">Row-level security scopes every schedule table to your DSP — no other tenant can read or write your data.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">Dispatcher-only writes</div>
                        <div class="rule-help">Creating, editing, and deleting shifts requires the dispatcher role. Drivers can only act on their own shifts via Cover/pickup/swap flows.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                    <div class="rule-row" style="padding:var(--s-2) 0;border:0">
                      <div>
                        <div class="rule-label">One pending offer per shift</div>
                        <div class="rule-help">Cover offers and swap requests can't pile up on the same shift — a unique constraint enforces single-pending.</div>
                      </div>
                      <span class="rules-sub-badge ok">Always on</span>
                    </div>
                  </div>
                </details>

                <details class="rules-section" data-rr-rules-section="woc-limits" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    Working hour limits
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Cover and Smart Fill exclude any driver who'd violate one of these. Defaults match the previous hardcoded values (55 / 6 / 10) so existing weeks behave the same until you tweak them.
                  </div>
                  <div data-rr-woc-form>
                    <div class="rule-row">
                      <div>
                        <div class="rule-label">Max hours per driver per week</div>
                        <div class="rule-help">Hard cap. Cover and Smart Fill exclude any driver who'd exceed this.</div>
                      </div>
                      <input class="rule-input" id="rr-woc-max-hours-per-week" type="number" min="1" max="168" value="55" />
                    </div>
                    <div class="rule-row">
                      <div>
                        <div class="rule-label">Max consecutive working days</div>
                        <div class="rule-help">Sliding window — counts in both directions from the candidate date.</div>
                      </div>
                      <input class="rule-input" id="rr-woc-max-consecutive-days" type="number" min="1" max="14" value="6" />
                    </div>
                    <div class="rule-row">
                      <div>
                        <div class="rule-label">Minimum rest between shifts (hours)</div>
                        <div class="rule-help">Compared against the start / end time on the adjacent shift.</div>
                      </div>
                      <input class="rule-input" id="rr-woc-min-rest-hours" type="number" min="0" max="24" value="10" />
                    </div>
                    <div style="display:flex;align-items:center;gap:var(--s-2-5);margin-top:var(--s-2)">
                      <button class="btn btn-primary btn-sm" id="rr-woc-save" type="button">Save</button>
                      <span id="rr-woc-status" class="u-xs-subtle"></span>
                    </div>
                  </div>
                </details>

                <details class="rules-section" data-rr-rules-section="pay-ot" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    Pay &amp; overtime
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Defaults Cover and the schedule forecast use when calculating projected OT premium. Per-driver overrides on the driver's Pay tab take precedence.
                  </div>
                  <div data-rr-pay-form>
                    <div class="rule-row">
                      <div>
                        <div class="rule-label">Overtime threshold (hours per week)</div>
                        <div class="rule-help">Weekly hours past this point count as overtime. Cover ranks candidates by how much OT they'd add.</div>
                      </div>
                      <input class="rule-input" id="rr-pay-ot-threshold" type="number" min="0" max="168" step="1" value="40" />
                    </div>
                    <div class="rule-row">
                      <div>
                        <div class="rule-label">Default overtime multiplier</div>
                        <div class="rule-help">Applied to drivers without a per-driver override. 1.5&times; is the federal default.</div>
                      </div>
                      <input class="rule-input" id="rr-pay-ot-mult" type="number" min="1" max="5" step="0.05" value="1.5" />
                    </div>
                    <div class="rule-row">
                      <div>
                        <div class="rule-label">Default hourly rate ($)</div>
                        <div class="rule-help">Fallback when a driver has no rate set on their Pay tab. Leave blank for no DSP-wide default.</div>
                      </div>
                      <input class="rule-input" id="rr-pay-default-rate" type="number" min="0" max="500" step="0.01" placeholder="—" />
                    </div>
                    <div style="display:flex;align-items:center;gap:var(--s-2-5);margin-top:var(--s-2)">
                      <button class="btn btn-primary btn-sm" id="rr-pay-save" type="button">Save</button>
                      <span id="rr-pay-status" class="u-xs-subtle"></span>
                    </div>
                  </div>
                </details>

                <details class="rules-section" data-rr-rules-section="driver-pickup" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Driver self-service
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Lets drivers act on shifts directly from the driver app. Both flows run through the same hard-compliance gates as a Cover offer — license valid, certs present, no double-book, no PTO overlap, hours / rest / consecutive-day limits.
                  </div>
                  <div class="rule-row">
                    <div>
                      <div class="rule-label">Allow drivers to pick up open shifts</div>
                      <div class="rule-help">When on, eligible drivers see open future shifts in their app and can claim them.</div>
                    </div>
                    <label class="toggle"><input type="checkbox" id="rr-pickup-toggle" /><span class="toggle-slider"></span></label>
                  </div>
                  <div class="rule-row">
                    <div>
                      <div class="rule-label">Allow drivers to swap shifts with each other</div>
                      <div class="rule-help">Peer-to-peer: a driver offers one of their shifts in exchange for another driver's. Both sides confirm; the swap executes only if both drivers pass compliance.</div>
                    </div>
                    <label class="toggle"><input type="checkbox" id="rr-swap-toggle" /><span class="toggle-slider"></span></label>
                  </div>
                </details>

                <details class="rules-section" data-rr-rules-section="attendance-windows" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    Attendance windows · check-in, tardy, no-show
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Drivers can check in this many minutes before their shift starts. After the shift starts, the grace window decides when they're marked tardy; past the no-show window without a check-in or a reported missed-day, they're marked NCNS.
                  </div>
                  <div id="rr-att-windows" style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:var(--s-2-5);align-items:end">
                    <div>
                      <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">Check-in opens (min before)</label>
                      <input type="number" id="rr-att-lead" min="0" max="120" value="15" class="form-input form-input-block"/>
                    </div>
                    <div>
                      <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">Tardy after (min past start)</label>
                      <input type="number" id="rr-att-grace" min="0" max="120" value="10" class="form-input form-input-block"/>
                    </div>
                    <div>
                      <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">NCNS after (min past start)</label>
                      <input type="number" id="rr-att-ncns" min="0" max="720" value="60" class="form-input form-input-block"/>
                    </div>
                    <button class="btn btn-sm btn-primary" id="rr-att-windows-save">Save</button>
                  </div>
                </details>

                <details class="rules-section" data-rr-rules-section="geofence" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/></svg>
                    Station geofences · driver check-in
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Set the lat/lng pin and radius for each station. Drivers can only check in for their shift when their phone reports a location inside the radius. Tap "Use current location" while standing at the station to capture the pin from your device.
                  </div>
                  <div id="rr-station-geofences"><div class="rr-loading">Loading station geofences</div></div>
                </details>

                <details class="rules-section" data-rr-rules-section="license-compliance" style="grid-column:1/-1">
                  <summary class="rules-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M7 10h6M7 14h4"/><circle cx="17" cy="14" r="2"/></svg>
                    License compliance · block scheduling past expiry
                  </summary>
                  <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin:6px 0 12px;line-height:1.5">
                    Hard rule: drivers with an expired driver's license can't be assigned to upcoming shifts.  Recommended for DOT compliance.  When OFF, expired licenses still surface as warnings on the schedule but assignments aren't blocked.
                  </div>
                  <div class="rule-row">
                    <div>
                      <div class="rule-label">Block scheduling past license expiry</div>
                      <div class="rule-help">Reminder cadence and message templates live in <strong>Settings → License renewals</strong>.</div>
                    </div>
                    <label class="toggle"><input type="checkbox" id="rr-lic-block-input" data-rr-lic-block-input/><span class="toggle-slider"></span></label>
                  </div>
                </details>

              </div>
            </div>


            <!-- TEAM SECTION -->
            <div class="settings-section hidden" data-set="team">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Team</h2>
                <p class="settings-section-sub">Manage who has access to RouteReady and what they can do.</p>
              </div>
              <div id="rr-team-list">
                <div class="rr-loading">Loading team</div>
              </div>
              <div class="u-mt-3">
                <button class="btn btn-primary" id="rr-team-invite-open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Invite team member</button>
              </div>
            </div>

            <!-- Invite team member modal -->
            <div class="modal-backdrop" id="modal-team-invite" style="display:none" onclick="if(event.target===this)document.getElementById('modal-team-invite').style.display='none'">
              <div class="modal-card" style="max-width:460px;width:92vw">
                <div class="modal-head">
                  <div>
                    <p class="modal-title">Invite team member</p>
                    <p class="modal-sub">They'll receive a magic-link email with no password required.</p>
                  </div>
                  <button class="modal-close" onclick="document.getElementById('modal-team-invite').style.display='none'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
                <form class="modal-body" id="rr-team-invite-form" style="display:flex;flex-direction:column;gap:var(--s-3)">
                  <label style="display:block">
                    <span style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Email</span>
                    <input type="email" required autocomplete="email" class="form-input form-input-block" id="rr-team-invite-email" placeholder="name@example.com"/>
                  </label>
                  <label style="display:block">
                    <span style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Full name <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-subtle)">(optional)</span></span>
                    <input type="text" class="form-input form-input-block" id="rr-team-invite-name" placeholder="First Last"/>
                  </label>
                  <label style="display:block">
                    <span style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Role</span>
                    <select class="form-input form-input-block" id="rr-team-invite-role">
                      <option value="dispatcher" selected>Dispatcher · day-to-day operator</option>
                      <option value="ops">Ops · multi-station / can invite</option>
                      <option value="owner">Owner · full access</option>
                    </select>
                  </label>
                  <div id="rr-team-invite-status" style="font-size:var(--fs-sm);color:var(--text-subtle);min-height:18px"></div>
                  <div style="display:flex;justify-content:flex-end;gap:var(--s-2);margin-top:6px">
                    <button type="button" class="btn" onclick="document.getElementById('modal-team-invite').style.display='none'">Cancel</button>
                    <button type="submit" class="btn btn-primary" id="rr-team-invite-submit">Send invite</button>
                  </div>
                </form>
              </div>
            </div>
            <!-- HIRING MESSAGES SECTION -->
            <div class="settings-section hidden" data-set="hiring-messages">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Hiring messages</h2>
                <p class="settings-section-sub">Customize the SMS and email applicants and drivers receive at every step. Tokens like <code>{{first_name}}</code> and <code>{{link}}</code> are filled in automatically. Paste links right into the body.</p>
              </div>
              <!-- style block 19 extracted to inline-styles.css -->
              <div class="msg-card" id="rr-messages-list">
                <div class="rr-loading">Loading templates</div>
              </div>
            </div>

            <!-- REFERRAL PROGRAM SECTION -->
            <div class="settings-section hidden" data-set="referrals">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Hiring referrals</h2>
                <p class="settings-section-sub">Live KPIs, leaderboard, auto-invite, and the milestone payout structure for every successful referral. Edits affect future hires only.</p>
              </div>

              <!-- KPI strip -->
              <div class="pipeline-kpis">
                <div class="pipeline-kpi">
                  <div class="pipeline-kpi-label">Active referrals</div>
                  <div class="pipeline-kpi-value"><span id="ref-active">0</span><span class="frac"> in flight</span></div>
                  <div class="pipeline-kpi-trend" id="ref-active-sub">applicants in screening + booking</div>
                </div>
                <div class="pipeline-kpi">
                  <div class="pipeline-kpi-label">Referral hires</div>
                  <div class="pipeline-kpi-value"><span id="ref-hired">0</span><span class="frac"> all-time</span></div>
                  <div class="pipeline-kpi-trend" id="ref-hired-sub">since the program launched</div>
                </div>
                <div class="pipeline-kpi">
                  <div class="pipeline-kpi-label">Payout per hire</div>
                  <div class="pipeline-kpi-value">$<span id="ref-payout">0</span></div>
                  <div class="pipeline-kpi-trend">Edit in the milestones table below</div>
                </div>
                <div class="pipeline-kpi">
                  <div class="pipeline-kpi-label">Auto-invite</div>
                  <div class="pipeline-kpi-value" id="ref-auto-status">Off</div>
                  <div class="pipeline-kpi-trend" id="ref-auto-sub">New hires don't get a referral SMS automatically.</div>
                </div>
              </div>

              <!-- style block 20 extracted to inline-styles.css -->

              <div class="ref-grid">
                <!-- Leaderboard -->
                <div class="ref-card">
                  <div class="ref-card-head">
                    <div>
                      <div class="ref-card-title">Top referring drivers</div>
                      <div class="ref-card-sub">All-time hires attributed to each driver.</div>
                    </div>
                    <button class="ref-action-btn ghost" data-rr-send-campaign>Send to all drivers</button>
                  </div>
                  <div id="ref-leaderboard">
                    <div class="rr-loading">Loading referral leaderboard</div>
                  </div>
                </div>

                <!-- Auto-invite + cadence -->
                <div class="ref-card">
                  <div class="ref-card-head">
                    <div>
                      <div class="ref-card-title">Auto-invite</div>
                      <div class="ref-card-sub">Saved instantly. Affects future hires only.</div>
                    </div>
                  </div>
                  <div class="ref-set-row">
                    <div>
                      <div class="ref-set-label">Auto-invite new hires</div>
                      <div class="ref-set-help">Send each new driver their referral link some weeks after their hire date.</div>
                    </div>
                    <button class="ref-toggle" id="ref-toggle-enabled" data-rr-ref-enabled></button>
                  </div>
                  <div class="ref-set-row">
                    <div>
                      <div class="ref-set-label">Send referral link how many weeks after hire?</div>
                      <div class="ref-set-help">Drivers who've been with you a while are more likely to refer good fits.</div>
                    </div>
                    <input type="number" min="0" max="52" class="ref-set-input" id="ref-weeks" value="4" />
                  </div>
                </div>
              </div>

              <!-- Public link preview / copy -->
              <div class="ref-card u-mt-4">
                <div class="ref-card-head">
                  <div>
                    <div class="ref-card-title">Your master referral link</div>
                    <div class="ref-card-sub">Use as a fallback when a driver hasn't received their personal link yet. Driver-attributed links are unique per driver.</div>
                  </div>
                  <button class="ref-action-btn" data-rr-copy-master-ref>Copy link</button>
                </div>
                <div id="ref-master-link" style="font-family:'SF Mono',Menlo,monospace;font-size:var(--fs-sm);color:var(--text-muted);background:var(--canvas);border:1px dashed var(--border);border-radius:var(--r-md);padding:var(--s-2-5) var(--s-3)">…</div>
              </div>

              <!-- Milestone payouts (existing settings) -->
              <h4 style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin:var(--s-5) 0 8px 0">Milestone payouts</h4>
              <p style="font-size:var(--fs-sm);color:var(--text-muted);margin:0 0 var(--s-3) 0;line-height:1.5">Set the dollar amounts paid to a referrer at each milestone. When you hire a referrer-attributed applicant, all four payouts are scheduled automatically.</p>

              <div class="form-row">
                <div><div class="form-label">Enable referral program</div><div class="form-help">When off, hiring an attributed applicant doesn't schedule payouts.</div></div>
                <div><label class="toggle"><input type="checkbox" id="ref-enabled" checked /><span class="toggle-slider"></span></label></div>
              </div>

              <h4 style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin:var(--s-4) 0 8px 0">Payout milestones</h4>

              <!-- style block 21 extracted to inline-styles.css -->

              <div>
                <div class="ref-milestone-row">
                  <div class="ref-milestone-num">1</div>
                  <div>
                    <div style="font-weight:500">On hire</div>
                    <div class="u-xs-subtle">Paid the same day the applicant is marked Hired in Interview Day.</div>
                  </div>
                  <div class="ref-amt-input"><span>$</span><input type="number" min="0" step="25" id="ref-amt-hire" value="500" /></div>
                  <div style="font-size:var(--fs-xs);color:var(--text-subtle);text-align:right">at hire date</div>
                </div>
                <div class="ref-milestone-row">
                  <div class="ref-milestone-num">2</div>
                  <div>
                    <div style="font-weight:500">30-day tenure</div>
                    <div class="u-xs-subtle">Driver still active 30 days after hire date.</div>
                  </div>
                  <div class="ref-amt-input"><span>$</span><input type="number" min="0" step="25" id="ref-amt-30" value="250" /></div>
                  <div style="font-size:var(--fs-xs);color:var(--text-subtle);text-align:right">+30 days</div>
                </div>
                <div class="ref-milestone-row">
                  <div class="ref-milestone-num">3</div>
                  <div>
                    <div style="font-weight:500">60-day tenure</div>
                    <div class="u-xs-subtle">Driver still active 60 days after hire.</div>
                  </div>
                  <div class="ref-amt-input"><span>$</span><input type="number" min="0" step="25" id="ref-amt-60" value="250" /></div>
                  <div style="font-size:var(--fs-xs);color:var(--text-subtle);text-align:right">+60 days</div>
                </div>
                <div class="ref-milestone-row">
                  <div class="ref-milestone-num">4</div>
                  <div>
                    <div style="font-weight:500">90-day tenure</div>
                    <div class="u-xs-subtle">Driver still active 90 days after hire — end of probation period.</div>
                  </div>
                  <div class="ref-amt-input"><span>$</span><input type="number" min="0" step="25" id="ref-amt-90" value="500" /></div>
                  <div style="font-size:var(--fs-xs);color:var(--text-subtle);text-align:right">+90 days</div>
                </div>
              </div>

              <div style="margin-top:var(--s-4);background:var(--canvas);border-radius:8px;padding:var(--s-3) var(--s-3-5);font-size:var(--fs-sm);color:var(--text-muted);line-height:1.5;display:flex;align-items:flex-start;gap:var(--s-2-5)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;color:var(--accent);flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <div>
                  <strong style="color:var(--text)">Total per successful referral: <span id="ref-total">$1,500</span></strong>
                  <div style="margin-top:4px">Paid via your existing payroll integration (Gusto / ADP / Paychex / manual). Tenure milestones fire automatically on the matching date if the driver is still active.</div>
                </div>
              </div>

              <h4 style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin:var(--s-5) 0 8px 0">Eligibility rules</h4>

              <div class="form-row">
                <div><div class="form-label">Referrer must be active</div><div class="form-help">A referrer who left or was terminated before the milestone date forfeits that payout.</div></div>
                <div><label class="toggle"><input type="checkbox" id="ref-rule-active" checked /><span class="toggle-slider"></span></label></div>
              </div>
              <div class="form-row">
                <div><div class="form-label">Referrer must be in good standing</div><div class="form-help">No active suspension or final warning at milestone date.</div></div>
                <div><label class="toggle"><input type="checkbox" id="ref-rule-standing" checked /><span class="toggle-slider"></span></label></div>
              </div>
              <div class="form-row" style="border-bottom:0">
                <div><div class="form-label">Driver hire counts only once</div><div class="form-help">If a hired driver leaves and is later re-hired, no second payout cycle.</div></div>
                <div><label class="toggle"><input type="checkbox" id="ref-rule-once" checked /><span class="toggle-slider"></span></label></div>
              </div>

              <div style="margin-top:var(--s-4);display:flex;gap:var(--s-2);justify-content:flex-end">
                <button class="btn" onclick="refResetAmounts()">Reset to defaults</button>
                <button class="btn btn-primary" onclick="refSaveProgram()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Save program
                </button>
              </div>

              <script>
                (function(){
                  function fmt(n){ return '$' + n.toLocaleString('en-US'); }
                  function refTotal(){
                    var h = parseInt(document.getElementById('ref-amt-hire').value, 10) || 0;
                    var t30 = parseInt(document.getElementById('ref-amt-30').value, 10) || 0;
                    var t60 = parseInt(document.getElementById('ref-amt-60').value, 10) || 0;
                    var t90 = parseInt(document.getElementById('ref-amt-90').value, 10) || 0;
                    var el = document.getElementById('ref-total');
                    if (el) el.textContent = fmt(h + t30 + t60 + t90);
                  }
                  ['ref-amt-hire','ref-amt-30','ref-amt-60','ref-amt-90'].forEach(function(id){
                    var el = document.getElementById(id);
                    if (el) el.addEventListener('input', refTotal);
                  });
                  window.refResetAmounts = function(){
                    document.getElementById('ref-amt-hire').value = 500;
                    document.getElementById('ref-amt-30').value = 250;
                    document.getElementById('ref-amt-60').value = 250;
                    document.getElementById('ref-amt-90').value = 500;
                    refTotal();
                    if (window.toast) toast('Reset to defaults');
                  };
                  window.refSaveProgram = function(){
                    refTotal();
                    if (window.toast) toast('Referral program saved · effective for future hires');
                  };
                  document.addEventListener('DOMContentLoaded', refTotal);
                  if (document.readyState !== 'loading') refTotal();
                })();
              </script>
            </div>

            <!-- LICENSE RENEWALS SECTION -->

            <!-- RECOGNITION SECTION -->
            <div class="settings-section hidden" data-set="recognition">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Recognition</h2>
                <p class="settings-section-sub">Per-celebration auto-fire toggles.  A scheduled job runs every morning and sends the celebrations you've enabled to qualifying active drivers — birthdays + work anniversaries on the right day, holidays on the right date.  Nothing fires until you flip a toggle here.</p>
              </div>

              <div id="rr-recog-settings-status" class="u-xs-subtle" style="margin-bottom:var(--s-3)">Loading…</div>

              <div id="rr-recog-settings-groups"></div>

              <div class="form-row" style="margin-top:var(--s-5);border-top:1px solid var(--border-subtle);padding-top:var(--s-4)">
                <div>
                  <div class="form-label">Run today's auto-fire now</div>
                  <div class="form-help">Manually invoke the auto-fire engine for today.  Safe to re-run — celebrations already created today are skipped.  Useful for testing or for catching up after a missed cron run.</div>
                </div>
                <div style="display:flex;align-items:center;gap:var(--s-2-5)">
                  <span id="rr-recog-autofire-status" class="u-xs-subtle"></span>
                  <button class="btn btn-primary" type="button" id="rr-recog-autofire-now">Run now</button>
                </div>
              </div>
            </div>

            <!-- BILLING SECTION -->
            <div class="settings-section hidden" data-set="billing">
              <div class="settings-section-head">
                <h2 class="settings-section-title">Billing</h2>
                <p class="settings-section-sub">Subscription, invoices, and payment method.</p>
              </div>

              <div class="billing-card">
                <div>
                  <div class="billing-plan">Premium plan</div>
                  <div class="billing-name">RouteReady Pro</div>
                  <div class="billing-price">$249/mo · billed monthly · next charge May 30</div>
                </div>
                <button class="btn" style="background:#fff;color:var(--text);border-color:transparent">Manage subscription</button>
              </div>

              <h4 style="font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin:var(--s-4) 0 8px 0">Recent invoices</h4>
              <div>
                <div class="invoice-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="font-weight:500">Apr 2026</span><span class="u-muted">$249.00</span><span class="role-pill role-pill-paid">Paid</span><button class="btn btn-sm">Download</button></div>
                <div class="invoice-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="font-weight:500">Mar 2026</span><span class="u-muted">$249.00</span><span class="role-pill role-pill-paid">Paid</span><button class="btn btn-sm">Download</button></div>
                <div class="invoice-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="font-weight:500">Feb 2026</span><span class="u-muted">$249.00</span><span class="role-pill role-pill-paid">Paid</span><button class="btn btn-sm">Download</button></div>
              </div>

              <h4 style="font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin:var(--s-5) 0 8px 0">Payment method</h4>
              <div style="background:var(--canvas);border-radius:var(--r-md);padding:var(--s-3-5) var(--s-4);display:flex;justify-content:space-between;align-items:center">
                <div style="display:flex;align-items:center;gap:var(--s-2-5);font-size:var(--fs-md)"><span style="background:#1A1F2E;color:#fff;padding:var(--s-1) 8px;border-radius:var(--r-sm);font-size:var(--fs-xs);font-weight:700">VISA</span>•••• 4242</div>
                <button class="btn btn-sm">Update</button>
              </div>
            </div>

          </div>
        </div>
      </div>
    