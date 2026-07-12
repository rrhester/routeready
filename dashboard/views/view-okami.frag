
      <div class="page">
        <div class="page-header">
          <div>
            <h1 class="page-title" id="rr-okami-page-title">OKAMI <span class="rr-okami-13week-badge" style="font-size:var(--fs-xs);font-weight:500;color:var(--text-subtle);background:var(--canvas);border:1px solid var(--border);padding:3px 8px;border-radius:var(--r-md);margin-left:8px;letter-spacing:0;text-transform:none;vertical-align:middle" title="Amazon's term for the 13-week DSP route plan horizon">13-week plan</span></h1>
            <p class="page-sub" id="rr-okami-page-sub">Routes vs. staffing vs. risk · drawn from your real history</p>
          </div>
          <div class="page-actions">
            <span id="rr-okami-save-status" style="font-size:var(--fs-sm);color:var(--text-subtle);margin-right:6px"></span>
            <button class="btn rr-okami-back-btn" onclick="goto('schedule')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="15 18 9 12 15 6"/></svg>
              Back to Schedule
            </button>
            <button class="btn btn-primary" id="rr-okami-save-plan" type="button" title="Build shifts from this route plan (route count + cushion %) and add them to the schedule">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              Save
            </button>
          </div>
        </div>

        <!-- Targets rules · embedded mirror of the schedule's
             #rr-sched-quick-settings-popover inputs. Both surfaces share
             the same backing storage (scheduling_settings_for_week) and
             stay in sync via _rrMirrorTargetsRule(). The popover stays
             too — it's the quick-edit-without-leaving-Schedule shortcut.
             Max-days isn't represented here because it lives in the
             Smart Fill rules popover, not the Targets popover. -->
        <div id="rr-okami-targets-rules" style="margin:0 0 var(--s-3) 0;display:flex;align-items:center;gap:var(--s-4);flex-wrap:wrap;font-size:var(--fs-sm);color:var(--text-muted)">
          <span style="font-size:var(--fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-subtle)">Targets rules ·</span>
          <label style="display:inline-flex;align-items:center;gap:6px">
            <span>Block</span>
            <input class="form-input form-input-sm" id="rr-okami-set-block-hours" type="number" min="1" max="14" step="1" autocomplete="off" style="width:64px;text-align:right"/>
            <span style="color:var(--text-subtle);font-size:var(--fs-xs)">h</span>
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px">
            <span>Cushion</span>
            <input class="form-input form-input-sm" id="rr-okami-set-cushion-pct" type="number" min="0" max="50" step="1" autocomplete="off" style="width:64px;text-align:right"/>
            <span style="color:var(--text-subtle);font-size:var(--fs-xs)">%</span>
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px">
            <span>Report time</span>
            <input class="form-input form-input-sm" id="rr-okami-set-report-lead" type="number" min="0" max="120" step="5" autocomplete="off" style="width:72px;text-align:right"/>
            <span style="color:var(--text-subtle);font-size:var(--fs-xs)">min</span>
          </label>
          <span id="rr-okami-targets-rules-status" aria-live="polite" style="font-size:var(--fs-xs);color:var(--text-subtle);font-variant-numeric:tabular-nums"></span>
        </div>

        <!-- Single staffing-plan input — Plan Pad % above the 2× baseline. -->
        <div id="rr-okami-pad-row" style="margin-bottom:var(--s-4);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:var(--s-3-5) var(--s-4);display:flex;align-items:center;gap:var(--s-3-5);flex-wrap:wrap">
          <div style="flex:0 0 auto">
            <div style="font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Staffing Plan Pad</div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Buffer above the 2× per-route baseline. Separate from the schedule cushion.</div>
          </div>
          <div style="flex:1 1 240px;display:flex;align-items:center;gap:var(--s-2-5);min-width:240px">
            <input type="range" id="rr-okami-pad" min="0" max="50" step="5" value="10" style="flex:1"/>
            <span id="rr-okami-pad-val" style="font-size:var(--fs-base);font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);min-width:42px;text-align:right">10%</span>
          </div>
        </div>

        <!-- 13-week table -->
        <div class="plan-table-wrap">
          <table class="okami-table">
            <thead>
              <tr>
                <th>Week</th>
                <th class="center">Routes</th>
                <th class="center">Drivers needed</th>
                <th class="center">Available</th>
                <th class="center">Gap</th>
                <th class="center">Strategy</th>
                <th class="center">Hire by</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="okami-tbody">
              <!-- 13 weeks -->
              <tr id="okami-row-0">
                <td><button class="okami-expand-btn" onclick="okamiToggleDaily(0)" aria-label="Expand daily plan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button><div class="plan-week-label" style="display:inline-block;vertical-align:middle">W19</div><div class="plan-week-dates">May 1–7</div><span class="okami-week-tag cycle">Cycle 14</span><span class="okami-week-tag daily" style="margin-left:4px" title="Daily route targets editable for the next 4 weeks">Daily</span></td>
                <td class="center"><input class="plan-route-input" data-w="0" value="38" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">85</div></td>
                <td class="center"><div class="plan-calc">78</div></td>
                <td class="center"><div class="plan-gap warn">−7</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">Apr 28</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>At risk</span></td>
              </tr>
              <tr class="okami-detail" id="okami-detail-0"><td colspan="8" id="okami-detail-content-0"></td></tr>
              <tr id="okami-row-1">
                <td><button class="okami-expand-btn" onclick="okamiToggleDaily(1)" aria-label="Expand daily plan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button><div class="plan-week-label" style="display:inline-block;vertical-align:middle">W20</div><div class="plan-week-dates">May 8–14</div><span class="okami-week-tag daily" title="Daily route targets editable for the next 4 weeks">Daily</span></td>
                <td class="center"><input class="plan-route-input" data-w="1" value="40" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">90</div></td>
                <td class="center"><div class="plan-calc">81</div></td>
                <td class="center"><div class="plan-gap warn">−9</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">May 5</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>At risk</span></td>
              </tr>
              <tr class="okami-detail" id="okami-detail-1"><td colspan="8" id="okami-detail-content-1"></td></tr>
              <tr id="okami-row-2">
                <td><button class="okami-expand-btn" onclick="okamiToggleDaily(2)" aria-label="Expand daily plan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button><div class="plan-week-label" style="display:inline-block;vertical-align:middle">W21</div><div class="plan-week-dates">May 15–21</div><span class="okami-week-tag daily" title="Daily route targets editable for the next 4 weeks">Daily</span></td>
                <td class="center"><input class="plan-route-input" data-w="2" value="42" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">94</div></td>
                <td class="center"><div class="plan-calc">86</div></td>
                <td class="center"><div class="plan-gap warn">−8</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">May 12</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>At risk</span></td>
              </tr>
              <tr class="okami-detail" id="okami-detail-2"><td colspan="8" id="okami-detail-content-2"></td></tr>
              <tr id="okami-row-3" class="cycle-end">
                <td><button class="okami-expand-btn" onclick="okamiToggleDaily(3)" aria-label="Expand daily plan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button><div class="plan-week-label" style="display:inline-block;vertical-align:middle">W22</div><div class="plan-week-dates">May 22–28</div><span class="okami-week-tag cycle">C14 ends</span><span class="okami-week-tag daily" style="margin-left:4px" title="Daily route targets editable for the next 4 weeks">Daily</span></td>
                <td class="center"><input class="plan-route-input" data-w="3" value="45" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">101</div></td>
                <td class="center"><div class="plan-calc">90</div></td>
                <td class="center"><div class="plan-gap bad">−11</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">May 19</div></td>
                <td><span class="plan-status-pill bad"><span class="dot"></span>Critical</span></td>
              </tr>
              <tr class="okami-detail" id="okami-detail-3"><td colspan="8" id="okami-detail-content-3"></td></tr>
              <tr class="hve">
                <td><div class="plan-week-label">W23</div><div class="plan-week-dates">May 29 – Jun 4</div><span class="okami-week-tag hve">HVE</span></td>
                <td class="center"><input class="plan-route-input" data-w="4" value="72" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">161</div><div class="plan-calc-sub">spike +27 vs avg</div></td>
                <td class="center"><div class="plan-calc">90</div></td>
                <td class="center"><div class="plan-gap bad">−71</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active adw">ADW 5.5</span><span class="strategy-pill active ot">+8h OT</span></div></td>
                <td class="center"><div class="plan-calc">—</div><div class="plan-calc-sub">don't hire</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>HVE absorbed</span></td>
              </tr>
              <tr class="hve">
                <td><div class="plan-week-label">W24</div><div class="plan-week-dates">Jun 5–11</div><span class="okami-week-tag hve">HVE</span></td>
                <td class="center"><input class="plan-route-input" data-w="5" value="72" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">161</div></td>
                <td class="center"><div class="plan-calc">94</div></td>
                <td class="center"><div class="plan-gap bad">−67</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active adw">ADW 5.5</span><span class="strategy-pill active ot">+8h OT</span></div></td>
                <td class="center"><div class="plan-calc">—</div><div class="plan-calc-sub">don't hire</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>HVE absorbed</span></td>
              </tr>
              <tr>
                <td><div class="plan-week-label">W25</div><div class="plan-week-dates">Jun 12–18</div></td>
                <td class="center"><input class="plan-route-input" data-w="6" value="50" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">112</div></td>
                <td class="center"><div class="plan-calc">96</div></td>
                <td class="center"><div class="plan-gap warn">−16</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">Jun 9</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>Tight</span></td>
              </tr>
              <tr>
                <td><div class="plan-week-label">W26</div><div class="plan-week-dates">Jun 19–25</div></td>
                <td class="center"><input class="plan-route-input" data-w="7" value="50" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">112</div></td>
                <td class="center"><div class="plan-calc">100</div></td>
                <td class="center"><div class="plan-gap warn">−12</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">Jun 16</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>Tight</span></td>
              </tr>
              <tr>
                <td><div class="plan-week-label">W27</div><div class="plan-week-dates">Jun 26 – Jul 2</div></td>
                <td class="center"><input class="plan-route-input" data-w="8" value="52" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">117</div></td>
                <td class="center"><div class="plan-calc">104</div></td>
                <td class="center"><div class="plan-gap warn">−13</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">Jun 23</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>Tight</span></td>
              </tr>
              <tr>
                <td><div class="plan-week-label">W28</div><div class="plan-week-dates">Jul 3–9</div></td>
                <td class="center"><input class="plan-route-input" data-w="9" value="50" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">112</div></td>
                <td class="center"><div class="plan-calc">108</div></td>
                <td class="center"><div class="plan-gap warn">−4</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">Jun 30</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>Tight</span></td>
              </tr>
              <tr class="hve">
                <td><div class="plan-week-label">W29</div><div class="plan-week-dates">Jul 10–16</div><span class="okami-week-tag hve">Prime</span></td>
                <td class="center"><input class="plan-route-input" data-w="10" value="80" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">179</div><div class="plan-calc-sub">Prime Day spike</div></td>
                <td class="center"><div class="plan-calc">112</div></td>
                <td class="center"><div class="plan-gap bad">−67</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active adw">ADW 5.5</span><span class="strategy-pill active ot">+10h OT</span></div></td>
                <td class="center"><div class="plan-calc">—</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>HVE absorbed</span></td>
              </tr>
              <tr>
                <td><div class="plan-week-label">W30</div><div class="plan-week-dates">Jul 17–23</div></td>
                <td class="center"><input class="plan-route-input" data-w="11" value="55" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">123</div></td>
                <td class="center"><div class="plan-calc">112</div></td>
                <td class="center"><div class="plan-gap warn">−11</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill active hire">Hire</span></div></td>
                <td class="center"><div class="plan-calc">Jul 14</div></td>
                <td><span class="plan-status-pill warn"><span class="dot"></span>Tight</span></td>
              </tr>
              <tr>
                <td><div class="plan-week-label">W31</div><div class="plan-week-dates">Jul 24–30</div></td>
                <td class="center"><input class="plan-route-input" data-w="12" value="52" oninput="recalcOkami()"/></td>
                <td class="center"><div class="plan-calc">117</div></td>
                <td class="center"><div class="plan-calc">115</div></td>
                <td class="center"><div class="plan-gap ok">−2</div></td>
                <td class="center"><div class="strategy-pills"><span class="strategy-pill">Maintain</span></div></td>
                <td class="center"><div class="plan-calc">—</div></td>
                <td><span class="plan-status-pill ok"><span class="dot"></span>On track</span></td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>
    