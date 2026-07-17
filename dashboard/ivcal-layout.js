// Pure overlap-layout engine for the interview calendar's time grids
// (calendar 100-list #90) — extracted from live.js so the algorithm is
// unit-testable in node (scripts/test-ivcal-layout.mjs), continuing the
// extraction program started with ivcal-slots.js and cal-tz.mjs.
//
// layoutDay: greedy interval-graph coloring within each overlap cluster;
// assigns each item _col (column index), _lx (left %), _lw (width %).
// Items carry _sm/_em (start/end minutes); the array is sorted in place.
export function layoutDay(items) {
  if (!items.length) return;
  items.sort((a, b) => a._sm - b._sm || b._em - a._em);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const colEnds = [];
    for (const it of cluster) {
      let col = -1;
      for (let c = 0; c < colEnds.length; c++) { if (colEnds[c] <= it._sm) { colEnds[c] = it._em; col = c; break; } }
      if (col === -1) { col = colEnds.length; colEnds.push(it._em); }
      it._col = col;
    }
    const n = colEnds.length, w = 100 / n;
    for (const it of cluster) { it._lw = w; it._lx = it._col * w; }
    cluster = []; clusterEnd = -1;
  };
  for (const it of items) {
    if (clusterEnd >= 0 && it._sm >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = clusterEnd < 0 ? it._em : Math.max(clusterEnd, it._em);
  }
  flush();
}

// {lx,lw} (left %, width %) → inline CSS. Columns lay out within
// (column width − G) so a clickable grid strip stays on the right,
// keeping double-click-to-create available even when the row is full.
export function layStyle(lay) {
  if (!lay) return "";
  const G = 16;
  const lpx = (lay.lx * G / 100).toFixed(2);
  const wpx = (lay.lw * G / 100 + 2).toFixed(2); // +2 = gap between events
  return `;left:calc(${lay.lx}% - ${lpx}px + 1px);width:calc(${lay.lw}% - ${wpx}px);right:auto`;
}
