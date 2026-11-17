/* Rally Raid roadbook renderer, v0.3: tulip diagrams, FIM-style symbols and the 3-column roadbook strip, as SVG / HTML
 * strings (no dependencies, browser or node). Column 1: total km (big), partial km, box number. Column 2: tulip.
 * Column 3: symbols, notes, CAP, danger. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoadbookRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  /** roadbook text is upper case, except the FIM mixed-case shorthand onL / onR / kpL / kpR / kpS */
  const noteCase = t => String(t == null ? '' : t).toUpperCase().replace(/\b(ON|KP)([LRS])\b/g, (m, a, b) => (a === 'ON' && b === 'S') ? m : a.toLowerCase() + b);
  const rad = d => d * Math.PI / 180;
  // line styles per track class, the usual roadbook code
  const STYLE = {
    tarmac: { w: 7, dbl: true }, dual: { w: 9, dbl: true, mid: true }, gravel: { w: 6 }, track: { w: 3.5 },
    twotrack: { w: 3, dash: '9 3 2 3' }, // FIM: low visible track / traces = dash-dot
    sand: { w: 4, dash: '2 5' }, path: { w: 2, dash: '3 4' }, offpiste: { w: 3, dash: '1 6', cap: 'round' },
    water: { w: 3, color: '#1f6fd1', dash: '6 3' }, fence: { w: 2, fence: true }, railway: { w: 3, rail: true }, road: { w: 3.5 }
  };
  function stroke(x1, y1, x2, y2, cls, color, extraW) {
    const st = STYLE[cls] || STYLE.track, c = color || st.color || '#111', w = st.w + (extraW || 0);
    let s = '';
    if (st.dbl) {
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="butt"/>`;
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="${w - 4}" stroke-linecap="butt"/>`;
      if (st.mid) s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1.2" stroke-linecap="butt"/>`;
      return s;
    }
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="${st.cap || 'butt'}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`;
    if (st.fence || st.rail) { // cross ticks
      const L = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / L, uy = (y2 - y1) / L;
      for (let d = 8; d < L; d += 10) { const px = x1 + ux * d, py = y1 + uy * d; s += `<line x1="${px - uy * 5}" y1="${py + ux * 5}" x2="${px + uy * 5}" y2="${py - ux * 5}" stroke="${c}" stroke-width="1.6"/>`; }
    }
    return s;
  }
  /** tulip: entry from the bottom (dot), exit with an arrow at `exit.angle` (deg, + = right), side roads thinner */
  function tulipSVG(t, size) {
    size = size || 120;
    if (t && Array.isArray(t.pre) && t.pre.length) return tulipPathSVG(t, size);
    const cx = 60, cy = 62;
    const end = (a, L) => [cx + Math.sin(rad(a)) * L, cy - Math.cos(rad(a)) * L];
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">`;
    if (!t) t = { entry: { track: 'track' }, exit: { angle: 0, track: 'track' }, branches: [] };
    for (const b of (t.branches || [])) {
      if (b.cross) { const [x1, y1] = end(b.angle, 52), [x2, y2] = end(b.angle + 180, 52); s += stroke(x1.toFixed(1), y1.toFixed(1), x2.toFixed(1), y2.toFixed(1), b.track || 'road', b.track === 'water' ? null : '#777', -0.5); }
      else { const [x, y] = end(b.angle, 40); s += stroke(cx, cy, x.toFixed(1), y.toFixed(1), b.track, '#888', -1); }
    }
    s += stroke(cx, 112, cx, cy, (t.entry && t.entry.track) || 'track');
    const a = (t.exit && t.exit.angle) || 0, [ex, ey] = end(a, 44);
    s += stroke(cx, cy, ex.toFixed(1), ey.toFixed(1), (t.exit && t.exit.track) || 'track');
    // arrowhead
    const [hx, hy] = end(a, 54), l = [ex + Math.sin(rad(a - 90)) * 8, ey - Math.cos(rad(a - 90)) * 8], r = [ex + Math.sin(rad(a + 90)) * 8, ey - Math.cos(rad(a + 90)) * 8];
    s += `<polygon points="${hx.toFixed(1)},${hy.toFixed(1)} ${l[0].toFixed(1)},${l[1].toFixed(1)} ${r[0].toFixed(1)},${r[1].toFixed(1)}" fill="#111"/>`;
    s += `<circle cx="${cx}" cy="112" r="5" fill="#111"/>`;
    return s + '</svg>';
  }
  /**
   * A junction complex: several junctions / crossings along the way through one box (tulip.pre = the earlier nodes
   * [{at, angle, track, branches}], the top-level exit / branches = the last node, tulip.at its distance). Drawn from
   * the entry dot along the route, each node turning by its angle, the gaps between nodes scaled to their real
   * distance (labelled in metres), side roads and crossing lines at each node, the arrow on the last exit only.
   */
  function tulipPathSVG(t, size) {
    const nodes = t.pre.map(n => ({ at: +n.at || 0, angle: +n.angle || 0, track: n.track, branches: n.branches || [] }))
      .concat([{ at: +t.at || 0, angle: (t.exit && +t.exit.angle) || 0, track: (t.exit && t.exit.track) || 'track', branches: t.branches || [], last: true }]);
    const dir = h => [Math.sin(rad(h)), -Math.cos(rad(h))];
    const lines = [], labels = [], pts = [];
    let p = [0, 0], h = 0, track = (t.entry && t.entry.track) || 'track';
    const add = (a, b, cls, side, cross) => { lines.push({ a, b, cls, side, cross }); pts.push(a, b); };
    const go = (len, cls) => { const d = dir(h), q = [p[0] + d[0] * len, p[1] + d[1] * len]; add(p, q, cls); const r = p; p = q; return r; };
    const start = p.slice();
    go(30, track);
    nodes.forEach((n, k) => {
      for (const b of n.branches) {
        const d = dir(h + (+b.angle || 0));
        if (b.cross) add([p[0] - d[0] * 22, p[1] - d[1] * 22], [p[0] + d[0] * 22, p[1] + d[1] * 22], b.track || 'road', true, true);
        else add(p, [p[0] + d[0] * 22, p[1] + d[1] * 22], b.track, true);
      }
      h += n.angle; track = n.track || track;
      if (n.last) { go(30, track); return; }
      const gap = Math.max(0, nodes[k + 1].at - n.at), len = 20 + 26 * Math.min(1, gap / 250);
      const a = go(len, track), d = dir(h);
      labels.push({ x: (a[0] + p[0]) / 2 - d[1] * 14, y: (a[1] + p[1]) / 2 + d[0] * 14, txt: String(Math.round(gap / 10) * 10) });
    });
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    const x0 = Math.min(...xs) - 8, x1 = Math.max(...xs) + 8, y0 = Math.min(...ys) - 12, y1 = Math.max(...ys) + 8;
    const sc = Math.min(1, 112 / (x1 - x0), 112 / (y1 - y0)), ox = 60 - (x0 + x1) / 2 * sc, oy = 60 - (y0 + y1) / 2 * sc;
    const X = q => (ox + q[0] * sc).toFixed(1), Y = q => (oy + q[1] * sc).toFixed(1);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">`;
    for (const l of lines.filter(l => l.side)) s += stroke(X(l.a), Y(l.a), X(l.b), Y(l.b), l.cls, l.cls === 'water' ? null : l.cross ? '#777' : '#888', l.cross ? -0.5 : -1);
    for (const l of lines.filter(l => !l.side)) s += stroke(X(l.a), Y(l.a), X(l.b), Y(l.b), l.cls);
    const d = dir(h), e = [p[0] + d[0] * 9, p[1] + d[1] * 9], lft = [p[0] - d[1] * 7, p[1] + d[0] * 7], rgt = [p[0] + d[1] * 7, p[1] - d[0] * 7];
    s += `<polygon points="${X(e)},${Y(e)} ${X(lft)},${Y(lft)} ${X(rgt)},${Y(rgt)}" fill="#111"/>`;
    s += `<circle cx="${X(start)}" cy="${Y(start)}" r="5" fill="#111"/>`;
    for (const lb of labels) s += `<text x="${(ox + lb.x * sc).toFixed(1)}" y="${(oy + lb.y * sc + 3).toFixed(1)}" text-anchor="middle" font-family="Arial Narrow,Arial,sans-serif" font-weight="700" font-size="9" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke">${esc(lb.txt)}</text>`;
    return s + '</svg>';
  }
  // ---- symbols (34 x 34). Our own drawings that follow the meaning and general shape of the 2026 FIM / Dakar
  // roadbook legend (docs/fim-symbols/SOURCES.md); hazards on the track are red, as on the FIM legend.
  // a path; `extra` attributes override the defaults (no duplicate attributes: SVG files must be valid XML)
  const P = (d, extra) => {
    const at = { fill: 'none', stroke: '#111', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    String(extra || '').replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { at[k] = v; return ''; });
    return `<path d="${d}" ` + Object.keys(at).map(k => `${k}="${at[k]}"`).join(' ') + '/>';
  };
  const RED = 'stroke="#d00"', BLUE = 'stroke="#1f6fd1"', THIN = 'stroke-width="1.6"';
  const F = (d, fill, extra) => P(d, `fill="${fill || '#111'}" stroke-width="1.4" ${extra || ''}`);
  const C = (cx, cy, r, extra) => P(`M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`, extra);
  const T = (txt, fs, y, fill, x) => `<text x="${x || 17}" y="${y || 22}" text-anchor="middle" font-family="Arial Narrow,Arial,sans-serif" font-weight="700" font-size="${fs || 11}" fill="${fill || '#111'}">${esc(txt)}</text>`;
  const UP = (x, y0, y1, extra) => P(`M${x} ${y0} V${y1}`, extra) + P(`M${x - 5} ${y1 + 6} L${x} ${y1} L${x + 5} ${y1 + 6}`, extra);
  const FENCE = (x0, x1, y) => { let s = P(`M${x0} ${y} H${x1}`, THIN); for (let x = x0 + 2; x <= x1; x += 3) s += P(`M${x} ${y - 4} V${y + 4}`, 'stroke-width="1.2"'); return s; };
  const WAVES = (ys, extra) => ys.map(y => P(`M2 ${y} q4 -5 8 0 t8 0 t8 0 t8 0`, extra || BLUE)).join('');
  const ICON = {
    // on track (red = the hazard, as on the FIM legend)
    crest: P('M2 27 Q17 5 32 27', RED) + P('M2 31 H32', THIN),
    bump: P('M2 22 H8 Q17 2 26 22 H32', RED),
    dip: P('M2 12 H8 Q17 32 26 12 H32', RED),
    compression: P('M2 14 H8 Q17 30 26 14 H32', RED) + P('M28 2 V10') + P('M25 7 L28 10 L31 7'),
    ditch: P('M2 12 H9 L17 28 L25 12 H32', RED),
    jump: P('M3 26 L16 12') + P('M20 10 q5 -4 10 2', 'stroke-dasharray="2 3"') + P('M3 30 H31'),
    step_up: P('M2 26 H15 V14 H32', RED) + P('M4 16 L12 7') + P('M7 6 H12 V11'),
    step_down: P('M2 12 H17 V24 H32', RED) + P('M22 4 L30 12') + P('M30 7 V12 H25'),
    climb: P('M3 28 L31 8') + P('M3 28 H31') + P('M22 8 h9 v9'),
    descent: P('M3 8 L31 28') + P('M3 28 H31') + P('M31 19 v9 h-9'),
    hole: C(17, 17, 13) + P('M8 8 L26 26 M26 8 L8 26'),
    ruts: P('M8 3 q-3 3.5 0 7 t0 7 t0 7 t0 7 M17 3 q-3 3.5 0 7 t0 7 t0 7 t0 7 M26 3 q-3 3.5 0 7 t0 7 t0 7 t0 7', THIN),
    twisty: P('M25 5 Q9 3 10 11 Q11 18 22 19 Q30 21 24 28 Q16 33 8 28', RED + ' stroke-width="3"'),
    undulations: P('M2 26 V18 q3.75 -14 7.5 0 t7.5 0 t7.5 0 t7.5 0 V26', RED + ' stroke-width="2.6"'),
    broken: P('M3 28 L7 8 L12 24 L17 8 L22 24 L27 8 L31 28', RED + ' stroke-width="2.6"'),
    sideslope_l: F('M3 28 H31 V14 Z', '#ddd') + P('M3 28 L31 14') + T('L', 9, 26, '#111', 24),
    sideslope_r: F('M3 14 V28 H31 Z', '#ddd') + P('M31 28 L3 14') + T('R', 9, 26, '#111', 10),
    narrow: P('M8 32 L13 17 V4 M26 32 L21 17 V4'),
    // dunes / sand / terrain
    dunes: F('M1 30 Q7 16 13 24 Q19 10 26 22 Q30 16 33 30 Z', '#bbb', 'stroke="#555"'),
    broken_dune: F('M1 30 Q14 14 33 30 Z', '#bbb', 'stroke="#555"') + P('M10 12 L15 6 L18 12 L24 8'),
    dunes_end: F('M1 30 Q7 16 13 24 Q19 10 26 22 Q30 16 33 30 Z', '#ddd', 'stroke="#777"') + P('M3 4 L31 32', 'stroke="#c00"'),
    bowl: F('M5 14 Q6 5 17 5 Q30 5 30 16 Q30 29 16 29 Q4 29 5 14 Z', '#f2d23c') + P('M10 15 Q17 25 25 15 M12 12 Q17 19 23 12', THIN),
    soft_sand: P('M1 22 q4 -5 8 0 t8 0 t8 0 t8 0') + `<circle cx="8" cy="29" r="1.6" fill="#111"/><circle cx="17" cy="29" r="1.6" fill="#111"/><circle cx="26" cy="29" r="1.6" fill="#111"/><circle cx="12" cy="12" r="1.6" fill="#111"/><circle cx="22" cy="12" r="1.6" fill="#111"/>`,
    wadi: P('M2 10 H9 L13 26 H21 L25 10 H32') + P('M14 22 h6', BLUE),
    ridge: P('M2 28 L17 8 L32 28') + P('M17 8 v-4'),
    valley: P('M2 6 L10 26 H24 L32 6'),
    flat: P('M3 20 H31') + P('M20 13 l7 7 l-7 7'),
    rolling: P('M2 22 q7 -10 15 0 t15 0'),
    rocks: F('M2 30 Q2 22 8 21 Q13 21 14 30 Z', '#999') + F('M12 30 L17 12 Q20 6 24 10 L31 30 Z', '#bbb'),
    cliff: P('M2 8 H18 V30 H32') + P('M18 12 l-5 5 M18 19 l-5 5 M18 26 l-5 4'),
    water: WAVES([12, 20, 28]),
    // route
    junction: P('M17 32 V14') + P('M17 14 L6 4') + P('M17 14 L28 4'),
    keep_left: P('M17 32 V18 L8 6') + P('M17 18 L26 6', 'stroke-dasharray="2 3"') + P('M6 12 L8 6 L14 7'),
    keep_right: P('M17 32 V18 L26 6') + P('M17 18 L8 6', 'stroke-dasharray="2 3"') + P('M20 7 L26 6 L28 12'),
    track_left: P('M17 32 V4') + P('M17 18 L4 12', THIN),
    track_right: P('M17 32 V4') + P('M17 18 L30 12', THIN),
    continue: UP(17, 32, 4),
    bend: P('M10 32 V18 Q10 8 22 8 H30') + P('M25 3 l5 5 l-5 5'),
    hairpin: P('M8 32 V14 Q8 4 17 4 Q26 4 26 14 V26') + P('M21 21 l5 5 l5 -5'),
    over_crest: F('M2 30 Q17 14 32 30 Z', '#ccc', 'stroke="#999"') + P('M14 30 V8 H26') + P('M22 4 L26 8 L22 12'),
    cap: C(17, 17, 14, 'stroke-width="2"') + T('CAP', 9, 21),
    offpiste: P('M17 32 V20', 'stroke-dasharray="1 4"') + P('M17 20 L17 4') + P('M11 10 L17 4 L23 10'),
    join_track: P('M8 32 L17 18', 'stroke-dasharray="1 4"') + P('M17 18 V4', 'stroke-width="4"'),
    cross_track: P('M2 17 H32') + P('M17 32 V2', 'stroke-dasharray="1 4"'),
    towards: F('M2 13 H20 V7 L32 17 L20 27 V21 H2 Z', '#111'),
    reset_trip: P('M5 5 L21 20') + `<circle cx="24" cy="23" r="4.5" fill="#111"/>`,
    surface: P('M17 32 V18', 'stroke-width="4"') + P('M17 16 V3', 'stroke-dasharray="6 3 2 3"') + P('M9 17 H25', THIN) + T('S', 9, 30, '#111', 26),
    // crossings and barriers (the route arrow goes through)
    ford: WAVES([12, 19, 26]) + UP(17, 33, 3, 'stroke-width="2.4"'),
    bridge: P('M9 6 H12 V28 H9 M25 6 H22 V28 H25') + UP(17, 32, 3, BLUE),
    under_bridge: P('M5 13 H29 M5 18 H29') + P('M9 18 V24 M25 18 V24') + UP(17, 32, 3, BLUE),
    gate: FENCE(1, 11, 18) + FENCE(23, 33, 18) + UP(17, 32, 3, BLUE),
    cattle_grid: FENCE(1, 11, 18) + FENCE(23, 33, 18) + P('M11 16 H23 M11 20 H23', THIN) + UP(17, 32, 3, BLUE),
    fence: FENCE(2, 32, 17),
    barbed_wire: P('M2 17 H32', THIN) + P('M4 13 L10 21 M10 13 L4 21 M14 13 L20 21 M20 13 L14 21 M24 13 L30 21 M30 13 L24 21'),
    wall: F('M2 11 H32 V23 H2 Z', '#999') + P('M2 17 H32 M9 11 V17 M19 11 V17 M28 11 V17 M5 17 V23 M14 17 V23 M24 17 V23', 'stroke-width="1.2"'),
    railway: P('M2 13 H32 M2 21 H32') + P('M6 9 V25 M13 9 V25 M20 9 V25 M27 9 V25'),
    // landmarks
    village: C(17, 17, 14) + P('M10 9 L17 26 L24 9', 'stroke-width="3"'),
    buildings: P('M3 30 V17 L10 11 L17 17 V30 Z') + P('M19 30 V20 H31 V30 Z M19 20 L25 15 L31 20'),
    ruins: P('M3 30 H31') + P('M4 30 V14 L8 11 V19 L11 16 V30 M16 30 V21 H23 L26 25 L30 22 V30'),
    mosque: P('M7 30 V20 H27 V30 Z') + P('M9 20 Q17 6 25 20') + P('M17 9 V4'),
    cemetery: P('M9 4 V14 M5 8 H13 M25 4 V14 M21 8 H29 M17 17 V30 M12 22 H22'),
    fort: P('M9 9 H25 V25 H9 Z') + F('M4 4 h7 v7 h-7 Z M23 4 h7 v7 h-7 Z M4 23 h7 v7 h-7 Z M23 23 h7 v7 h-7 Z', '#fff'),
    well: `<ellipse cx="17" cy="15" rx="11" ry="4" fill="none" stroke="#111" stroke-width="2.4"/>` + P('M6 15 V27 Q17 33 28 27 V15') + P('M8 3 H26 M10 3 V12 M24 3 V12', THIN),
    tanks: P('M5 9 H29 V21 H5 Z') + P('M8 21 L5 31 M26 21 L29 31 M11 21 V31 M23 21 V31', THIN) + P('M5 9 Q17 3 29 9'),
    petrol: P('M5 31 V6 H19 V31 Z M3 31 H21') + F('M8 9 H16 V15 H8 Z', '#fff', 'stroke-width="1.6"') + P('M19 12 H24 L28 17 V27 Q28 30 25 28 V22', THIN),
    post: P('M15 31 V5') + P('M10 31 H20'),
    electric_line: P('M6 31 V8 M28 31 V8 M2 10 H10 M24 10 H32') + P('M6 10 Q17 20 28 10', THIN),
    pylon: P('M10 32 L15 5 H19 L24 32 M8 10 H26 M13 18 H21 M12 25 L20 18 M22 25 L14 18 M11 30 H23', THIN + ' stroke-width="1.8"'),
    antenna: P('M17 32 V8 M10 32 L17 8 L24 32 M12 22 H22') + P('M11 5 Q17 1 23 5', THIN),
    sign_post: P('M11 31 V6') + P('M11 6 H30 V15 H11', 'stroke-width="2"') + P('M15 10 H26', THIN),
    cairn: C(10, 26, 5) + C(22, 26, 5) + C(16, 17, 5) + C(16, 8, 4),
    animals: C(17, 17, 14) + T('A', 16, 23),
    road_works: P('M17 4 L32 30 H2 Z', 'stroke="#d00" stroke-width="2.6"') + `<circle cx="15" cy="13.5" r="2" fill="#111"/>` + P('M15 16 L13 23 M15 16 L20 21 M11 27 L13 23 L17 27 M20 21 L24 26', 'stroke-width="1.8"'),
    // vegetation
    tree: F('M3 12 Q17 2 31 12 Q17 16 3 12 Z', '#111') + P('M17 13 V31 M17 21 L11 14 M17 19 L23 14'),
    trees: P('M9 30 V20 M25 30 V22') + C(9, 13, 7) + C(25, 15, 6),
    palm_tree: P('M18 31 Q16 20 17 10') + P('M17 10 Q10 5 4 10 M17 10 Q11 10 7 17 M17 10 Q24 5 30 10 M17 10 Q23 10 27 17 M17 10 Q17 5 13 3'),
    vegetation: P('M4 31 H30') + P('M17 31 V14 M17 31 L10 15 M17 31 L24 15 M17 31 L5 21 M17 31 L29 21', THIN),
    camel_grass: P('M4 30 l3 -10 l3 10 M14 30 l3 -14 l3 14 M24 30 l3 -9 l3 9'),
    // safety
    danger: `<polygon points="17,3 32,30 2,30" fill="none" stroke="#c00" stroke-width="3" stroke-linejoin="round"/>` + `<text x="17" y="27" text-anchor="middle" font-family="Arial" font-weight="900" font-size="15" fill="#c00">!</text>`,
    stop: `<polygon points="11,3 23,3 31,11 31,23 23,31 11,31 3,23 3,11" fill="#c00"/>` + `<text x="17" y="21" text-anchor="middle" font-family="Arial" font-weight="700" font-size="8" fill="#fff">STOP</text>`
  };
  /** FIM / Dakar names (the legend and tooltips) */
  const NAMES = {
    crest: 'Summit / crest', bump: 'Bump', dip: 'Dip / hole', compression: 'Compression', ditch: 'Ditch', jump: 'Jump',
    step_up: 'Step up', step_down: 'Step down', climb: 'Uphill', descent: 'Downhill', hole: 'Hole', ruts: 'Ruts',
    twisty: 'Twisty / sinuous', undulations: 'Bumpy', broken: 'Bumpy / broken', sideslope_l: 'Lateral inclination, falls left',
    sideslope_r: 'Lateral inclination, falls right', narrow: 'Narrow', dunes: 'Dunes', broken_dune: 'Broken dune',
    dunes_end: 'End of dunes', bowl: 'Big bowl "cuvette"', soft_sand: 'Soft sand / sandy plain', wadi: 'Wadi', ridge: 'Ridge',
    valley: 'Valley / wash', flat: 'Flat, fast', rolling: 'Rolling ground', rocks: 'Rocks', cliff: 'Cliff / drop', water: 'River / lake (water)',
    junction: 'Junction', keep_left: 'Keep left (kpL)', keep_right: 'Keep right (kpR)', track_left: 'Track on left (onL)',
    track_right: 'Track on right (onR)', continue: 'Keep straight (kpS)', bend: 'Bend', hairpin: 'Hairpin',
    over_crest: 'Right or left over crest', cap: 'CAP', offpiste: 'Leave track, off track (HP)', join_track: 'Rejoin track (RP)',
    cross_track: 'Cross a track', towards: 'Towards / direction', reset_trip: 'Reset / recal trip', surface: 'Surface change',
    ford: 'Wading / water crossing', bridge: 'Over bridge', under_bridge: 'Under bridge', gate: 'Fence gate',
    cattle_grid: 'Fence with cattle gate', fence: 'Fence', barbed_wire: 'Barbed wire', wall: 'Wall', railway: 'Railroad',
    village: 'Village', buildings: 'Buildings / houses', ruins: 'Ruin / abandoned', mosque: 'Church / mosque', cemetery: 'Cemetery',
    fort: 'Fort / castle', well: 'Well', tanks: 'Tanks', petrol: 'Petrol station', post: 'Post', electric_line: 'Electric line',
    pylon: 'High voltage tower', antenna: 'Antenna', sign_post: 'Sign post', cairn: 'Cairn', animals: 'Animals',
    road_works: 'Road works', tree: 'Tree', trees: 'Trees', palm_tree: 'Palm tree', vegetation: 'Vegetation / bush',
    camel_grass: 'Camel grass', danger: 'Caution', stop: 'Stop',
    DSS: 'Start selective section', ASS: 'Arrival selective section', CP: 'Check point', WPV: 'Visible WP', WPE: 'Eclipsed WP',
    WPM: 'Masked (hidden) WP', WPN: 'Navigation WP', WPS: 'Safety WP', WPC: 'Control WP', WPP: 'Precise WP',
    DZ: 'Start speed limit', FZ: 'Finish speed limit'
  };
  /** other names for the same symbol (FIM wording, older files) */
  const ALIAS = {
    summit: 'crest', dip_hole: 'dip', bumpy: 'undulations', bumpy_broken: 'broken', sinuous: 'twisty', lateral_inclination: 'sideslope_r',
    uphill: 'climb', downhill: 'descent', wading: 'ford', water_cross: 'ford', above_bridge: 'bridge', fence_gate: 'gate',
    cattle_gate: 'cattle_grid', rail_road: 'railway', barbed_fence: 'barbed_wire', houses: 'buildings', house: 'buildings',
    church: 'mosque', ruin: 'ruins', castle: 'fort', fuel: 'petrol', tank: 'tanks', electric_pole: 'post', high_voltage: 'pylon',
    bush: 'vegetation', caution: 'danger', direction: 'towards', recal: 'reset_trip', sandy_plain: 'soft_sand', cuvette: 'bowl',
    dune: 'dunes', river: 'water', lake: 'water', keep_straight: 'continue', straight: 'continue', off_track: 'offpiste', rejoin: 'join_track'
  };
  /** the symbol palette, grouped as on the FIM legend */
  const GROUPS = {
    'on track': ['crest', 'bump', 'dip', 'compression', 'ditch', 'jump', 'step_up', 'step_down', 'climb', 'descent', 'hole', 'ruts', 'twisty', 'undulations', 'broken', 'sideslope_l', 'sideslope_r', 'narrow'],
    'dunes / terrain': ['dunes', 'broken_dune', 'dunes_end', 'bowl', 'soft_sand', 'wadi', 'ridge', 'valley', 'flat', 'rolling', 'rocks', 'cliff', 'water'],
    route: ['junction', 'keep_left', 'keep_right', 'track_left', 'track_right', 'continue', 'bend', 'hairpin', 'over_crest', 'cap', 'offpiste', 'join_track', 'cross_track', 'towards', 'reset_trip', 'surface'],
    crossings: ['ford', 'bridge', 'under_bridge', 'gate', 'cattle_grid', 'fence', 'barbed_wire', 'wall', 'railway'],
    landmarks: ['village', 'buildings', 'ruins', 'mosque', 'cemetery', 'fort', 'well', 'tanks', 'petrol', 'post', 'electric_line', 'pylon', 'antenna', 'sign_post', 'cairn', 'animals', 'road_works'],
    vegetation: ['tree', 'trees', 'palm_tree', 'vegetation', 'camel_grass'],
    safety: ['danger', 'stop', 'speed_30', 'speed_50', 'speed_80'],
    waypoints: ['DSS', 'ASS', 'CP', 'WPV', 'WPE', 'WPM', 'WPN', 'WPS', 'WPC', 'WPP', 'DZ', 'FZ']
  };
  /** FIM / FIA standard roadbook abbreviations (written in the notes) */
  const ABBR = [
    ['P', 'Track / piste'], ['PP', 'Principal track'], ['RO', 'Road'], ['P//', 'Parallel track'], ['HP', 'Off track'],
    ['FPP', 'Follow principal track'], ['FRO', 'Follow road'], ['SA', 'Sandy'], ['GV', 'Gravel'], ['VG', 'Vegetation'],
    ['L/R', 'Left and right'], ['R/L', 'Right and left'], ['onL', 'On left'], ['onR', 'On right'], ['kpL', 'Keep left'],
    ['kpR', 'Keep right'], ['kpS', 'Keep straight'], ['-V', 'Less visible'], ['±V', 'More / less visible'], ['EMP', 'Stony'],
    ['/', 'During'], ['IN', 'In / into'], ['ET', 'And / next'], ['A', 'At'], ['CX', 'Stone'], ['E3', 'Narrow'], ['QT', 'Quit / leave'],
    ['TJS', 'Always'], ['NBX', 'Many'], ['IMP', 'Imperative'], ['EFF', 'Collapsed'], ['ORN', 'Ruts'], ['BAD', 'Bad'], ['RP', 'Rejoin'],
    ['BTW', 'Between'], ['DN', 'Dune'], ['DNX', 'Many dunes'], ['DNT', 'Small dune "dunette"'], ['L1 L2 L3', 'Dunes difficulty level']
  ];
  // waypoint / control badges: the FIM legend's circled letters and colours
  const WP_BADGE = { WPM: ['M', '#9fe3f5'], WPC: ['C', '#ffeb5a'], WPS: ['S', '#f39c80'], WPN: ['N', '#e58ef0'], WPP: ['P', '#fff'], WPV: ['V', '#fff'], WPE: ['E', '#fff'] };
  function badge(code) {
    if (WP_BADGE[code]) return `<circle cx="17" cy="17" r="14.5" fill="${WP_BADGE[code][1]}" stroke="#111" stroke-width="2.4"/>` + T(WP_BADGE[code][0], 18, 23.5);
    if (code === 'DSS') return `<circle cx="17" cy="17" r="15.5" fill="#d00" stroke="#111" stroke-width="1.5"/>` + T('DSS', 11, 21, '#fff');
    if (code === 'ASS') return `<circle cx="17" cy="17" r="15.5" fill="#fff" stroke="#111" stroke-width="1.5"/><path d="M7 6 h5 v5 h-5 Z M17 6 h5 v5 h-5 Z M12 11 h5 v5 h-5 Z M22 11 h5 v5 h-5 Z" fill="#d00"/>` + T('ASS', 10, 27);
    if (code === 'CP') return `<circle cx="17" cy="17" r="14.5" fill="#fff" stroke="#d63cd6" stroke-width="2.6"/>` + T('CP', 13, 22, '#d63cd6');
    if (code === 'DZ') return `<circle cx="17" cy="17" r="14.5" fill="#f2a33a" stroke="#111" stroke-width="2"/>` + T('DZ', 13, 22);
    if (code === 'FZ') return `<circle cx="17" cy="17" r="14.5" fill="#4cbb4c" stroke="#111" stroke-width="2"/>` + T('FZ', 13, 22);
    return null;
  }
  const resolve = code => ICON[code] ? code : (ALIAS[code] || code);
  function symbolSVG(code, size) {
    size = size || 30;
    const c = resolve(code);
    let inner = ICON[c] || badge(c);
    if (!inner) {
      if (/^speed_\d+/.test(c)) inner = `<circle cx="17" cy="17" r="14" fill="#fff" stroke="#c00" stroke-width="4"/>` + T(c.slice(6), 12, 22);
      else inner = T(String(c).slice(0, 4).toUpperCase(), 9);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="${size}" height="${size}"><title>${esc(NAMES[c] || code)}</title>${inner}</svg>`;
  }
  const symbolName = code => { const c = resolve(code); return NAMES[c] || (/^speed_\d+/.test(c) ? 'Speed limit ' + c.slice(6) : String(code).replace(/_/g, ' ')); };
  const pad3 = c => String(Math.round(c) % 360).padStart(3, '0');
  const CSS = `
  .rb{font-family:"Arial Narrow",Arial,sans-serif;width:640px;background:#fff;color:#111}
  .rb h1{font-size:16px;margin:0;padding:8px 10px;background:#111;color:#fff;display:flex;justify-content:space-between}
  .rb table{border-collapse:collapse;width:100%}
  .rb td{border:2px solid #111;vertical-align:top;height:124px}
  .rb .c1{width:150px;position:relative}
  .rb .km{font-size:38px;font-weight:700;text-align:right;padding:18px 8px 0 0;letter-spacing:-1px}
  .rb .part{font-size:20px;text-align:right;padding-right:8px;color:#333}
  .rb .no{position:absolute;left:5px;top:3px;font-size:13px;font-weight:700;background:#111;color:#fff;padding:1px 5px;border-radius:3px}
  .rb .src{position:absolute;left:5px;bottom:3px;font-size:9px;color:#888}
  .rb .c2{width:124px;text-align:center}
  .rb .c3{padding:4px 6px;position:relative}
  .rb .sym{display:flex;gap:3px;flex-wrap:wrap}
  .rb .note{font-size:16px;font-weight:700;line-height:1.15;margin-top:3px}
  .rb .cap{position:absolute;right:6px;bottom:3px;font-size:18px;font-weight:700}
  .rb .dng{position:absolute;right:6px;top:2px;font-size:24px;font-weight:900;color:#d00;letter-spacing:-2px}
  .rb tr.d3 td{background:#ffe9e6} .rb tr.wp .c1{background:#f3f3f3}
  .rb tr.d2 .km span,.rb tr.d3 .km span{border-bottom:3px solid #d00}
  .rb tr.d3 .c3{outline:3px solid #d00;outline-offset:-5px}
  .rb tr.off .c2{background:#fbf8ef}
  .rb .foot{font-size:10px;color:#555;padding:4px 8px}`;
  function boxRow(b) {
    const dng = b.danger ? '!'.repeat(b.danger) : '';
    // FIM: ! / !! / !!! in red; a red line under the km = danger 2; a red frame = the whole box is dangerous (3)
    return `<tr class="${b.danger >= 2 ? 'd' + b.danger : ''} ${b.waypoint ? 'wp' : ''} ${b.offPiste ? 'off' : ''}">
<td class="c1"><span class="no">${b.n}</span><div class="km"><span>${b.km.toFixed(2)}</span></div><div class="part">${b.partial.toFixed(2)}</div><span class="src">${esc(b.source || '')}</span></td>
<td class="c2">${tulipSVG(b.tulip, 120)}</td>
<td class="c3"><div class="sym">${(b.symbols || []).map(s => symbolSVG(s, 30)).join('')}</div><div class="note">${esc(noteCase(b.notes))}</div>${dng ? `<span class="dng">${dng}</span>` : ''}<span class="cap">CAP ${pad3(b.capOut != null ? b.capOut : b.cap)}</span></td></tr>`;
  }
  /** one strip page (real roadbooks read bottom to top; this preview reads top to bottom like a scroll) */
  function stripHTML(rb, from, to, page, pages) {
    const boxes = rb.boxes.filter(b => !b.deleted).slice(from, to);
    return `<div class="rb"><h1><span>${esc(rb.stage.name || rb.stage.id)}</span><span>${page ? 'p ' + page + '/' + pages : ''}</span></h1><table>${boxes.map(boxRow).join('')}</table>
<div class="foot">${esc(rb.generator)} | boxes ${rb.stats.boxes} | ${rb.stats.per10km.offPiste != null ? 'off-piste ' + rb.stats.per10km.offPiste + '/10 km | ' : ''}${rb.stats.per10km.onPiste != null ? 'on-piste ' + rb.stats.per10km.onPiste + '/10 km | ' : ''}AUTO DRAFT, NOT RECCE'D | ${esc(rb.sources.attribution)}</div></div>`;
  }
  /** tulip line styles, as on the FIM legend (tracks) */
  const TRACK_NAMES = { tarmac: 'Tarmac road', dual: 'Dual carriageway', gravel: 'Gravel road / principal track (PP)', track: 'Track / piste (P)',
    twotrack: 'Low visible track / traces', sand: 'Sandy track (SA)', path: 'Small track / path', offpiste: 'Off track (HP)',
    water: 'River / water', fence: 'Fence', railway: 'Railroad' };
  const LEGEND_CSS = `.rbl{font-family:Arial,sans-serif;color:#111;background:#fff;padding:10px;width:1060px}
  .rbl h2{margin:0 0 4px;font-size:20px}.rbl .lg-sub{font-size:11px;color:#555;margin-bottom:8px}
  .rbl .lg-cols{column-count:4;column-gap:14px}.rbl .lg-g{break-inside:avoid;margin-bottom:10px}
  .rbl h3{font-size:12px;text-transform:uppercase;background:#ddd;margin:0 0 3px;padding:3px 6px}
  .rbl .lg-i{display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.1;padding:1px 0;break-inside:avoid}
  .rbl .lg-i svg{flex:none}.rbl .lg-ab b{display:inline-block;width:52px;font-size:14px}
  .rbl .lg-dg{color:#d00;font-weight:900;font-size:16px;width:52px;display:inline-block}`;
  /** the symbol legend (editor panel, legend sheet) */
  function legendHTML() {
    const line = k => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 14" width="70" height="14">${stroke(4, 7, 66, 7, k)}</svg>`;
    let h = `<div class="rbl"><h2>Roadbook symbols</h2><div class="lg-sub">Following the 2026 FIM World Rally-Raid / Dakar roadbook legend (our own drawings). Tulip: you arrive at the dot and leave by the arrow.</div><div class="lg-cols">`;
    h += '<div class="lg-g"><h3>Tracks (tulip lines)</h3>' + Object.keys(TRACK_NAMES).map(k => `<div class="lg-i">${line(k)}<span>${TRACK_NAMES[k]}</span></div>`).join('') + '</div>';
    h += '<div class="lg-g"><h3>Danger</h3><div class="lg-i"><span class="lg-dg">!</span>Danger level 1</div><div class="lg-i"><span class="lg-dg">!!</span>Danger level 2 (red line under the km)</div><div class="lg-i"><span class="lg-dg">!!!</span>Danger level 3 (red frame: the whole box)</div></div>';
    for (const [g, list] of Object.entries(GROUPS)) h += `<div class="lg-g"><h3>${esc(g)}</h3>` + list.map(c => `<div class="lg-i">${symbolSVG(c, 26)}<span>${esc(symbolName(c))}</span></div>`).join('') + '</div>';
    h += '<div class="lg-g"><h3>Abbreviations</h3>' + ABBR.map(([a, m]) => `<div class="lg-i lg-ab"><b>${esc(a)}</b>${esc(m)}</div>`).join('') + '</div>';
    return h + '</div></div>';
  }
  return { noteCase, tulipSVG, symbolSVG, symbolName, legendHTML, LEGEND_CSS, stripHTML, boxRow, CSS, pad3, STYLE, TRACK_NAMES, GROUPS, ABBR, ALIAS, NAMES, ICONS: Object.keys(ICON), resolve };
});
