
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
          <label style="display:inline-flex;align-items:center;gap:6px" title="Cushion adds extra SHIFTS when the week's schedule is built — not extra hires (that's the Plan Pad below)">
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

        <!-- Single staffing-plan input — Plan Pad % above the per-route
             baseline. (The formula's other knob, Drivers per route, is
             edited in the Drivers-needed ⓘ header popover — it must ride
             WITH the table, which relocates into Schedule → Targets.) -->
        <div id="rr-okami-pad-row" style="margin-bottom:var(--s-4);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:var(--s-3-5) var(--s-4);display:flex;align-items:center;gap:var(--s-3-5);flex-wrap:wrap">
          <div style="flex:0 0 auto">
            <div style="font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Staffing Plan Pad</div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Extra <b>hires</b> buffer above the per-route baseline. Not the schedule cushion — that adds extra <b>shifts</b> at build time.</div>
          </div>
          <div style="flex:1 1 240px;display:flex;align-items:center;gap:var(--s-2-5);min-width:240px">
            <input type="range" id="rr-okami-pad" min="0" max="50" step="5" value="10" style="flex:1"/>
            <span id="rr-okami-pad-val" style="font-size:var(--fs-base);font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);min-width:42px;text-align:right">10%</span>
          </div>
        </div>

        <!-- 13-week table · rows are BUILT AT RUNTIME by _rrOkamiEnsureRows
             (live.js) from okami_grid data. The tbody used to ship 13
             hand-written sample rows; on any RPC failure those fake
             numbers stayed on screen looking real. Now the static
             markup is only a loading skeleton — live.js replaces it
             with generated rows (weeks 0–3 keep the daily drill-down
             contract: #okami-row-N + .okami-expand-btn +
             #okami-detail-N/#okami-detail-content-N). -->
        <div class="plan-table-wrap">
          <table class="okami-table">
            <caption class="rr-visually-hidden">13-week route plan: weekly route targets, drivers needed, driver availability and staffing gap per week</caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col" class="center">Routes</th>
                <th scope="col" class="center">Drivers needed</th>
                <th scope="col" class="center">Available</th>
                <th scope="col" class="center">Gap</th>
                <th scope="col" class="center">Strategy</th>
                <th scope="col" class="center">Hire by</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody id="okami-tbody">
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
              <tr class="rr-okami-skel-row"><td colspan="8"><div class="rr-okami-skel"></div></td></tr>
            </tbody>
            <tfoot id="okami-tfoot"></tfoot>
          </table>
        </div>

      </div>
    