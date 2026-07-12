
      <div class="page">

        <!-- Page header -->
        <div class="page-header">
          <div>
            <h1 class="page-title">Build Your Own Tool</h1>
            <p class="page-sub">Describe an operational problem · drop the data · save the tool · run it anytime</p>
          </div>
          <div class="page-actions">
            <button class="btn" onclick="document.getElementById('saved-tools-anchor').scrollIntoView({behavior:'smooth'})">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg>
              My Saved Tools <span style="background:var(--canvas);color:var(--text-muted);font-size:var(--fs-xs);font-weight:600;padding:1px 7px;border-radius:var(--r-lg);margin-left:var(--s-1)">5</span>
            </button>
          </div>
        </div>

        <!-- Compact hero · the long pitch is for first-time visits, not return ones -->
        <div class="build-hero" style="padding:var(--s-4) var(--s-5)">
          <div style="position:relative;z-index:1">
            <h2 class="build-hero-headline" style="font-size:var(--fs-lg);margin:0 0 var(--s-1) 0">Describe the problem · Drop in the data · Save the tool · Run it anytime</h2>
            <p class="build-hero-sub" style="font-size:var(--fs-sm);margin:0">Turn operational intent and messy data into reusable tools.</p>
          </div>
          <button class="build-hero-cta" onclick="document.getElementById('build-prompt').focus()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            Build something new
          </button>
        </div>

        <!-- Workspace: Left = workflow input, Right = preview -->
        <div class="bb-workspace">

          <!-- LEFT COLUMN -->
          <div>

            <!-- Step 1: Describe -->
            <div class="bb-card">
              <div class="bb-step"><span class="bb-step-num">1</span>Describe the operational problem</div>
              <textarea id="build-prompt" class="bb-prompt" placeholder="Example: I want to analyze time theft by comparing paid hours, route activity, and delivery scan timestamps.">I want to analyze time theft by comparing paid hours, route activity, and delivery scan timestamps.</textarea>
              <div class="bb-suggest-row">
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Analyze time theft</button>
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Track call-outs</button>
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>Identify van damage patterns</button>
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Build a driver coaching tracker</button>
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>Monitor training completion</button>
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Flag repeat safety issues</button>
                <button class="bb-suggest" onclick="setBuildPrompt(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="3" y1="12" x2="21" y2="12"/></svg>Compare route assignments to actual hours</button>
              </div>
            </div>

            <!-- Step 2: Required data -->
            <div class="bb-card">
              <div class="bb-step done"><span class="bb-step-num">2</span>Data RouteReady needs</div>
              <p class="bb-section-sub u-mb-3">Based on your prompt, here's what RouteReady needs to build the <strong style="color:var(--text)">Time Theft Analyzer</strong>.</p>

              <div class="bb-data-row">
                <div class="bb-data-icon uploaded"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div><div class="bb-data-name">Driver time clock data</div><div class="bb-data-meta">Clock-in / clock-out per driver per shift</div></div>
                <span class="bb-data-status uploaded">Uploaded</span>
              </div>

              <div class="bb-data-row">
                <div class="bb-data-icon uploaded"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div><div class="bb-data-name">Route assignment data</div><div class="bb-data-meta">Which driver was assigned which route on which day</div></div>
                <span class="bb-data-status uploaded">Uploaded</span>
              </div>

              <div class="bb-data-row">
                <div class="bb-data-icon needed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/></svg></div>
                <div><div class="bb-data-name">Delivery scan timestamps</div><div class="bb-data-meta">Per-package scan times to compute active delivery time</div></div>
                <span class="bb-data-status needed">Needed</span>
              </div>

              <div class="bb-data-row">
                <div class="bb-data-icon optional"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
                <div><div class="bb-data-name">Break logs</div><div class="bb-data-meta">Lunch + breaks · improves accuracy of idle gap calc</div></div>
                <span class="bb-data-status optional">Optional</span>
              </div>

              <div class="bb-data-row">
                <div class="bb-data-icon optional"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
                <div><div class="bb-data-name">Rescue records</div><div class="bb-data-meta">When a driver was rescued by another · explains gaps</div></div>
                <span class="bb-data-status optional">Optional</span>
              </div>

              <div class="bb-data-row">
                <div class="bb-data-icon optional"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
                <div><div class="bb-data-name">GPS breadcrumbs</div><div class="bb-data-meta">Vehicle location every 30s · highest fidelity</div></div>
                <span class="bb-data-status optional">Optional</span>
              </div>

              <div class="bb-data-row">
                <div class="bb-data-icon missing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg></div>
                <div><div class="bb-data-name">Payroll export</div><div class="bb-data-meta">Hours paid · for $ overpayment math</div></div>
                <span class="bb-data-status missing">Missing</span>
              </div>
            </div>

            <!-- Step 3: Upload -->
            <div class="bb-card">
              <div class="bb-step"><span class="bb-step-num">3</span>Upload or connect data</div>
              <div class="bb-upload" onclick="toast('File picker would open · upload your messy export')">
                <div class="bb-upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
                <div class="bb-upload-title">Drop in messy exports.</div>
                <div class="bb-upload-sub">RouteReady pulls the fields it needs and ignores the rest.</div>
                <div class="bb-upload-formats">
                  <span class="bb-upload-format">CSV</span>
                  <span class="bb-upload-format">Excel</span>
                  <span class="bb-upload-format">PDF</span>
                  <span class="bb-upload-format">Image</span>
                  <span class="bb-upload-format">Email forward</span>
                  <span class="bb-upload-format">Raw export</span>
                </div>
              </div>
              <div class="bb-upload-actions">
                <span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline;margin-right:4px;color:var(--green)"><polyline points="20 6 9 17 4 12"/></svg>Ignore extra data automatically</span>
                <a onclick="toast('Column mapping editor — would open')">Map columns →</a>
              </div>
            </div>

            <!-- Step 4: Generate -->
            <div class="bb-card" style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <div class="bb-step"><span class="bb-step-num">4</span>Generate the tool</div>
                <p class="bb-section-sub" style="margin:0">RouteReady will design the metrics, rules, dashboards, and actions automatically.</p>
              </div>
              <button class="btn btn-primary" onclick="toast('Tool already generated · see preview on the right →')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8 22 9 17 14 18 21 12 18 6 21 7 14 2 9 9 8 12 2"/></svg>
                Generate Tool
              </button>
            </div>

          </div>

          <!-- RIGHT COLUMN: Tool preview -->
          <div>

            <!-- Generated tool -->
            <div class="bb-tool-preview">
              <div class="bb-tool-head">
                <div class="bb-tool-tag">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8 22 9 17 14 18 21 12 18 6 21 7 14 2 9 9 8 12 2"/></svg>
                  Generated tool · type: analyzer
                </div>
                <h2 class="bb-tool-title">Time Theft Analyzer</h2>
                <p class="bb-tool-desc">Identifies discrepancies between paid time and actual delivery activity. Flags drivers whose idle gap exceeds 90 min.</p>
              </div>
              <div class="bb-tool-body">

                <div class="bb-tool-cards">
                  <div class="bb-tool-card">
                    <div class="bb-tool-card-label">Flagged drivers</div>
                    <div class="bb-tool-card-value bad">7</div>
                    <div class="bb-tool-card-sub">idle gap &gt; 90 min</div>
                  </div>
                  <div class="bb-tool-card">
                    <div class="bb-tool-card-label">Estimated excess hours</div>
                    <div class="bb-tool-card-value warn">31.5</div>
                    <div class="bb-tool-card-sub">≈ $640 overpayment</div>
                  </div>
                  <div class="bb-tool-card">
                    <div class="bb-tool-card-label">Highest risk driver</div>
                    <div class="bb-tool-card-value">Marcus J.</div>
                    <div class="bb-tool-card-sub">3.2 hr idle gap on CX-14</div>
                  </div>
                  <div class="bb-tool-card">
                    <div class="bb-tool-card-label">Missing data rows</div>
                    <div class="bb-tool-card-value">14</div>
                    <div class="bb-tool-card-sub">drivers without scan data</div>
                  </div>
                </div>

                <div style="font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin:0 0 8px 0">High-risk drivers</div>
                <table class="bb-tool-table">
                  <thead>
                    <tr><th>Driver</th><th>Paid hrs</th><th>Active</th><th>Idle gap</th><th>Route</th><th>Risk</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    <tr><td><strong>Marcus J.</strong></td><td>10.4</td><td>7.2</td><td>3.2 hrs</td><td>CX-14</td><td><span class="bb-risk-pill high">High</span></td><td><a style="color:var(--accent-text);font-weight:600;cursor:pointer" onclick="toast('Review opened for Marcus J.')">Review</a></td></tr>
                    <tr><td><strong>Elena R.</strong></td><td>9.8</td><td>8.1</td><td>1.7 hrs</td><td>CX-22</td><td><span class="bb-risk-pill med">Medium</span></td><td><a style="color:var(--accent-text);font-weight:600;cursor:pointer" onclick="toast('Monitoring enabled for Elena R.')">Monitor</a></td></tr>
                    <tr><td><strong>Travis B.</strong></td><td>11.1</td><td>7.9</td><td>3.2 hrs</td><td>CX-09</td><td><span class="bb-risk-pill high">High</span></td><td><a style="color:var(--accent-text);font-weight:600;cursor:pointer" onclick="toast('Review opened for Travis B.')">Review</a></td></tr>
                    <tr><td><strong>Devon P.</strong></td><td>9.4</td><td>7.6</td><td>1.8 hrs</td><td>CX-04</td><td><span class="bb-risk-pill med">Medium</span></td><td><a style="color:var(--accent-text);font-weight:600;cursor:pointer" onclick="toast('Monitoring enabled')">Monitor</a></td></tr>
                  </tbody>
                </table>

                <div class="bb-logic">
                  <strong>Logic summary.</strong> RouteReady computes <strong>shift duration</strong> from clock-in/clock-out, <strong>active delivery time</strong> from first to last scan, and <strong>idle gap</strong> as their difference. Drivers with idle gap &gt; 90 min are flagged High; 30–90 min Medium; &lt; 30 min Low. Estimated excess hours = sum of idle gaps over the 90-min threshold.
                </div>

                <div class="bb-actions">
                  <button class="bb-action-chip" onclick="openDriverDetail('Marcus Davidson','KMO1','18 mo','62','88%')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>Review driver</button>
                  <button class="bb-action-chip" onclick="toast('Manager notified via Messages')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Notify manager</button>
                  <button class="bb-action-chip" onclick="toast('Auto-dispute filed with payroll')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Auto-dispute payroll</button>
                  <button class="bb-action-chip" onclick="openCoachDrawer('Marcus Davidson','quality','Idle-gap pattern · 3.2h on CX-14 (Time Theft Analyzer flagged)')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/></svg>Coach driver</button>
                </div>

                <div style="display:flex;gap:var(--s-2);margin-top:var(--s-4);padding-top:var(--s-4);border-top:1px solid var(--border)">
                  <button class="btn" style="flex:1" onclick="toast('Tool definition copied to editor')">Edit logic</button>
                  <button class="btn btn-primary" style="flex:2" onclick="toast('Time Theft Analyzer saved · added to My Saved Tools')">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                    Save Tool
                  </button>
                </div>
              </div>
            </div>

            <!-- Tool blueprint -->
            <div class="bb-blueprint" id="bb-blueprint">
              <button class="bb-blueprint-toggle" onclick="document.getElementById('bb-blueprint').classList.toggle('open')">
                <span><strong>Tool blueprint</strong> · how RouteReady translates your request into structured logic</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="bb-blueprint-body">
<span class="punct">{</span>
  <span class="key">"toolName"</span><span class="punct">:</span> <span class="str">"Time Theft Analyzer"</span><span class="punct">,</span>
  <span class="key">"toolType"</span><span class="punct">:</span> <span class="str">"analyzer"</span><span class="punct">,</span>
  <span class="key">"description"</span><span class="punct">:</span> <span class="str">"Identifies discrepancies between paid time and actual delivery activity."</span><span class="punct">,</span>
  <span class="key">"dataRequirements"</span><span class="punct">: [</span>
    <span class="str">"Driver time clock data"</span><span class="punct">,</span>
    <span class="str">"Route assignment data"</span><span class="punct">,</span>
    <span class="str">"Delivery scan timestamps"</span>
  <span class="punct">],</span>
  <span class="key">"metrics"</span><span class="punct">: [</span>
    <span class="punct">{</span><span class="key">"name"</span><span class="punct">:</span> <span class="str">"Total Shift Duration"</span><span class="punct">,</span> <span class="key">"logic"</span><span class="punct">:</span> <span class="str">"clock_out_time - clock_in_time"</span><span class="punct">},</span>
    <span class="punct">{</span><span class="key">"name"</span><span class="punct">:</span> <span class="str">"Active Delivery Time"</span><span class="punct">,</span> <span class="key">"logic"</span><span class="punct">:</span> <span class="str">"last_scan - first_scan"</span><span class="punct">},</span>
    <span class="punct">{</span><span class="key">"name"</span><span class="punct">:</span> <span class="str">"Idle Gap"</span><span class="punct">,</span> <span class="key">"logic"</span><span class="punct">:</span> <span class="str">"shift_duration - active_delivery_time"</span><span class="punct">}</span>
  <span class="punct">],</span>
  <span class="key">"rules"</span><span class="punct">: [</span>
    <span class="punct">{</span><span class="key">"condition"</span><span class="punct">:</span> <span class="str">"idle_gap &gt; 90 minutes"</span><span class="punct">,</span> <span class="key">"action"</span><span class="punct">:</span> <span class="str">"flag_driver_for_review"</span><span class="punct">}</span>
  <span class="punct">],</span>
  <span class="key">"views"</span><span class="punct">: [</span>
    <span class="punct">{</span><span class="key">"name"</span><span class="punct">:</span> <span class="str">"High Risk Drivers"</span><span class="punct">,</span> <span class="key">"filter"</span><span class="punct">:</span> <span class="str">"idle_gap &gt; 90 minutes"</span><span class="punct">}</span>
  <span class="punct">],</span>
  <span class="key">"dashboardCards"</span><span class="punct">: [</span>
    <span class="punct">{</span><span class="key">"title"</span><span class="punct">:</span> <span class="str">"Flagged Drivers"</span><span class="punct">,</span> <span class="key">"metric"</span><span class="punct">:</span> <span class="str">"count_of_flagged_drivers"</span><span class="punct">},</span>
    <span class="punct">{</span><span class="key">"title"</span><span class="punct">:</span> <span class="str">"Estimated Excess Hours"</span><span class="punct">,</span> <span class="key">"metric"</span><span class="punct">:</span> <span class="str">"sum_of_idle_gaps_over_threshold"</span><span class="punct">}</span>
  <span class="punct">],</span>
  <span class="key">"actions"</span><span class="punct">: [</span>
    <span class="punct">{</span><span class="key">"label"</span><span class="punct">:</span> <span class="str">"Review Driver"</span><span class="punct">,</span> <span class="key">"type"</span><span class="punct">:</span> <span class="str">"review"</span><span class="punct">},</span>
    <span class="punct">{</span><span class="key">"label"</span><span class="punct">:</span> <span class="str">"Notify Manager"</span><span class="punct">,</span> <span class="key">"type"</span><span class="punct">:</span> <span class="str">"notify"</span><span class="punct">}</span>
  <span class="punct">]</span>
<span class="punct">}</span>
              </div>
            </div>

          </div>
        </div>

        <!-- SAVED TOOLS LIBRARY -->
        <div id="saved-tools-anchor" style="margin-top:var(--s-8);padding-top:var(--s-5);border-top:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:var(--s-4);gap:var(--s-3)">
            <div>
              <h2 class="bb-section-title">My Saved Tools</h2>
              <p class="bb-section-sub" style="margin:0">Re-run with fresh data anytime. Edit logic. Share with your team.</p>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm">All tools</button>
              <button class="btn btn-sm">Mine</button>
              <button class="btn btn-sm">Shared</button>
            </div>
          </div>

          <div class="bb-saved-grid">

            <div class="bb-saved-card">
              <div class="bb-saved-head">
                <div class="bb-saved-icon analyzer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
                <div class="u-right">
                  <div class="bb-saved-type">Analyzer</div>
                </div>
              </div>
              <div>
                <div class="bb-saved-name">Time Theft Analyzer</div>
                <p class="bb-saved-meta">Idle-gap detection across paid hours, route activity, and scan timestamps.</p>
              </div>
              <div class="bb-saved-data">
                <span class="bb-saved-data-pill">Time clock</span>
                <span class="bb-saved-data-pill">Routes</span>
                <span class="bb-saved-data-pill">Scans</span>
              </div>
              <div class="bb-saved-foot">
                <span class="bb-saved-last">Last run · today, 6:42 AM</span>
                <div class="bb-saved-actions">
                  <button class="bb-saved-action-btn" title="Edit logic" onclick="toast('Editor opens with tool definition')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="bb-saved-action-btn" title="Archive" onclick="toast('Tool archived')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>
                </div>
              </div>
              <button class="bb-saved-card-cta" onclick="toast('Re-running with latest data…')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Run again
              </button>
            </div>

            <div class="bb-saved-card">
              <div class="bb-saved-head">
                <div class="bb-saved-icon tracker"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/></svg></div>
                <div class="u-right"><div class="bb-saved-type">Tracker</div></div>
              </div>
              <div>
                <div class="bb-saved-name">Driver Call-Out Tracker</div>
                <p class="bb-saved-meta">Detects callout patterns by day-of-week and tenure cohort.</p>
              </div>
              <div class="bb-saved-data">
                <span class="bb-saved-data-pill">Attendance</span>
                <span class="bb-saved-data-pill">Schedule</span>
              </div>
              <div class="bb-saved-foot">
                <span class="bb-saved-last">Last run · yesterday</span>
                <div class="bb-saved-actions">
                  <button class="bb-saved-action-btn" title="Edit logic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="bb-saved-action-btn" title="Archive"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg></button>
                </div>
              </div>
              <button class="bb-saved-card-cta" onclick="toast('Re-running with latest attendance log…')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Run again
              </button>
            </div>

            <div class="bb-saved-card">
              <div class="bb-saved-head">
                <div class="bb-saved-icon finder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></div>
                <div class="u-right"><div class="bb-saved-type">Pattern Finder</div></div>
              </div>
              <div>
                <div class="bb-saved-name">Van Damage Pattern Finder</div>
                <p class="bb-saved-meta">Clusters damage events by vehicle, driver, and route to find systemic issues.</p>
              </div>
              <div class="bb-saved-data">
                <span class="bb-saved-data-pill">Incidents</span>
                <span class="bb-saved-data-pill">Vehicles</span>
                <span class="bb-saved-data-pill">Routes</span>
              </div>
              <div class="bb-saved-foot">
                <span class="bb-saved-last">Last run · 4 days ago</span>
                <div class="bb-saved-actions">
                  <button class="bb-saved-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="bb-saved-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg></button>
                </div>
              </div>
              <button class="bb-saved-card-cta" onclick="toast('Re-running pattern detection…')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Run again
              </button>
            </div>

            <div class="bb-saved-card">
              <div class="bb-saved-head">
                <div class="bb-saved-icon monitor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="u-right"><div class="bb-saved-type">Monitor</div></div>
              </div>
              <div>
                <div class="bb-saved-name">Training Completion Monitor</div>
                <p class="bb-saved-meta">Tracks safety + DCR training across roster · alerts on lapses.</p>
              </div>
              <div class="bb-saved-data">
                <span class="bb-saved-data-pill">Training</span>
                <span class="bb-saved-data-pill">Drivers</span>
              </div>
              <div class="bb-saved-foot">
                <span class="bb-saved-last">Last run · today, 6:00 AM</span>
                <div class="bb-saved-actions">
                  <button class="bb-saved-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="bb-saved-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg></button>
                </div>
              </div>
              <button class="bb-saved-card-cta" onclick="toast('Re-running with latest training log…')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Run again
              </button>
            </div>

            <div class="bb-saved-card">
              <div class="bb-saved-head">
                <div class="bb-saved-icon review"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
                <div class="u-right"><div class="bb-saved-type">Review</div></div>
              </div>
              <div>
                <div class="bb-saved-name">Bottom 5 Driver Coaching Review</div>
                <p class="bb-saved-meta">Auto-prepares coaching prep packet for the 5 lowest-scoring drivers each cycle.</p>
              </div>
              <div class="bb-saved-data">
                <span class="bb-saved-data-pill">Scorecards</span>
                <span class="bb-saved-data-pill">Coaching log</span>
                <span class="bb-saved-data-pill">Safety</span>
              </div>
              <div class="bb-saved-foot">
                <span class="bb-saved-last">Last run · weekly · auto</span>
                <div class="bb-saved-actions">
                  <button class="bb-saved-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="bb-saved-action-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg></button>
                </div>
              </div>
              <button class="bb-saved-card-cta" onclick="toast('Coaching prep packet generating…')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Run again
              </button>
            </div>

          </div>

          <div style="margin-top:var(--s-5);padding:var(--s-5);background:var(--canvas);border-radius:var(--r-lg);text-align:center">
            <div style="font-size:var(--fs-base);font-weight:600;color:var(--text);margin-bottom:4px">Build something else</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--s-3)">Every tool you build saves time forever. Re-run them anytime with fresh data.</div>
            <button class="btn btn-primary" onclick="document.getElementById('build-prompt').focus();window.scrollTo({top:0,behavior:'smooth'})">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Build a new tool
            </button>
          </div>
        </div>

      </div>
    