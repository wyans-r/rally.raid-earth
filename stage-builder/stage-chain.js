/* rally.raid Earth Stage-Gen chaining (B10), v1.0.0: special stages longer than one Stage-Gen run (100-500 km).
 *
 * Stage-Gen v1 makes one stage of up to ~204 km (its region is an ellipse of at most 170 km x 1.2). A longer special is
 * built as a CHAIN of segments generated end to end: segment k's finish (ASS) is segment k+1's start (DSS), so the line
 * is continuous. The segments are then merged into ONE normal stage file (docs/STAGE_FORMAT.md): one DSS, one ASS,
 * continuous km from the DSS, every segment junction a visible waypoint (WPV) the GPS opens at once, one roadbook.
 *
 *   layout()          : where the junctions go. Anchors = DSS, the landmark pins ("vias"), ASS. If the anchor path is
 *                       shorter than lengthKm / ratio it is bulged sideways (or, for a loop, laid out as a polygon round
 *                       the start) until every segment has about the same length / straight-line ratio (default 1.3);
 *                       long edges are cut so no segment is longer than segMaxKm.
 *   generateChained() : runs Stage-Gen (stagegen-core.js) once per segment, in order, each with its own small region
 *                       (so Overpass is asked per segment, through the same mirrors helper), then merge().
 *   merge()           : segment stage files -> one stage file.
 *
 * UMD: window.StageChain = factory(window.StageGen, window.RoadbookGen) in the browser; require(...)(SG, RB) in node.
 * Overpass load: segments are generated one after another, never in parallel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.StageChain = factory(root.StageGen, root.RoadbookGen);
})(typeof self !== 'undefined' ? self : this, function (SG, RB) {
  'use strict';
  const VERSION = '1.0.0';
  if (!SG) throw new Error('StageChain needs StageGen (stagegen-core.js)');
  const DEFAULTS = {
    segMaxKm: 150,        // longest segment (Stage-Gen's own cap is ~204 km; shorter = smaller Overpass regions)
    singleMaxKm: 185,     // up to this a stage is ONE Stage-Gen run (no chain)
    ratio: 1.3,           // segment length / straight line between its ends (room for Stage-Gen's arc / zig-zag shapes)
    minRatio: 1.12,       // below this a segment is too straight to generate: warning (move the DSS / ASS)
    loopShare: 0.3,       // DSS-ASS under this x length (and no pins) = a loop
    junctionType: 'WPV'   // what a segment junction becomes in the merged stage (visible: the GPS shows it at once)
  };
  const R = 6371008.8, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const r6 = x => Math.round(x * 1e6) / 1e6;
  function dist(a, b) { const p1 = rad(a[0]), p2 = rad(b[0]), dp = p2 - p1, dl = rad(b[1] - a[1]); const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  function bearing(a, b) { const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]); return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360; }
  function dest(a, brg, m) { const d = m / R, t = rad(brg), p1 = rad(a[0]), l1 = rad(a[1]); const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t)); const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2)); return [r6(deg(p2)), r6(((deg(l2) + 540) % 360) - 180)]; }
  function lerp(a, b, f) { return [r6(a[0] + (b[0] - a[0]) * f), r6(a[1] + (b[1] - a[1]) * f)]; }
  const pathLen = P => { let m = 0; for (let i = 1; i < P.length; i++) m += dist(P[i - 1], P[i]); return m; };

  /**
   * Junction layout. inp: {dss, ass, lengthKm, vias?: [[lat,lon]], side?: 'left'|'right' (bulge side, travel direction),
   * loopBearing?: degrees (where a loop goes from the start)}. Returns {loop, junctions: [[lat,lon]], segKm: [], ratio,
   * warnings: []} with junctions[0] = DSS and the last = ASS.
   */
  function layout(inp, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {}), L = +inp.lengthKm, T = L * 1000 / o.ratio, warnings = [];
    const dss = inp.dss.map(Number), ass = inp.ass.map(Number), vias = (inp.vias || []).map(v => v.map(Number));
    const sideSign = inp.side === 'right' ? 1 : -1;      // perpendicular offset: right of travel = bearing + 90
    const loop = !vias.length && dist(dss, ass) < o.loopShare * L * 1000;
    if (L <= o.singleMaxKm && !vias.length) return { loop, junctions: [dss, ass], segKm: [L], ratio: L * 1000 / Math.max(1, dist(dss, ass)), warnings, single: true };
    let P;
    if (loop) {
      // polygon round the start: N corners (N >= 3), circle through the DSS, centre towards loopBearing
      const N = Math.max(3, Math.ceil(L / o.segMaxKm));
      const Rm = T / (2 * N * Math.sin(Math.PI / N));
      const b0 = inp.loopBearing != null ? +inp.loopBearing : bearing(dss, ass) + 90 * sideSign;
      const C = dest(dss, b0, Rm), back = (b0 + 180) % 360;
      P = [dss];
      for (let k = 1; k < N; k++) P.push(dest(C, back + sideSign * -1 * 360 * k / N, Rm));
      P.push(ass);
    } else {
      P = [dss].concat(vias, [ass]);
      // bulge: while too short, put an offset corner in the middle of the longest edge
      for (let g = 0; g < 12 && pathLen(P) < T * 0.97; g++) {
        let k = 0, e = 0; for (let i = 1; i < P.length; i++) { const d = dist(P[i - 1], P[i]); if (d > e) { e = d; k = i; } }
        const need = T - pathLen(P), h = Math.min(Math.sqrt(Math.max(0, ((e + need) / 2) ** 2 - (e / 2) ** 2)), Math.max(e, 20000));
        const m = lerp(P[k - 1], P[k], 0.5), brg = bearing(P[k - 1], P[k]);
        P.splice(k, 0, dest(m, brg + 90 * sideSign, h));
      }
    }
    const PL = pathLen(P), ratio = L * 1000 / PL;
    if (ratio < o.minRatio) warnings.push('The straight line through the pins (' + Math.round(PL / 1000) + ' km) leaves too little room for ' + L + ' km of stage (ratio ' + ratio.toFixed(2) + '; move the DSS / ASS closer or drop a pin).');
    // cut long edges so every segment is <= segMaxKm
    const J = [P[0]], kmOf = [];
    for (let i = 1; i < P.length; i++) {
      const e = dist(P[i - 1], P[i]), segL = L * e / PL, n = Math.max(1, Math.ceil(segL / o.segMaxKm));
      for (let m = 1; m <= n; m++) { J.push(m === n ? P[i] : lerp(P[i - 1], P[i], m / n)); kmOf.push(segL / n); }
    }
    // a segment under 8 km is merged into its neighbour (except the end ones)
    for (let i = 1; i < kmOf.length - 1; i++) if (kmOf[i] < 8) { kmOf[i - 1] += kmOf[i]; kmOf.splice(i, 1); J.splice(i, 1); i--; }
    return { loop, junctions: J, segKm: kmOf.map(x => Math.round(x * 10) / 10), ratio: +ratio.toFixed(3), warnings };
  }

  /** segment stage files (in order, each one's DSS = the previous one's ASS) -> one stage file */
  function merge(stages, meta, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!SG.stageToPoints) throw new Error('stagegen-core.js too old (no stageToPoints)');
    let pts = [];
    stages.forEach((st, k) => {
      const p = SG.stageToPoints(st).map(q => Object.assign({}, q, { id: q.type === 'DSS' && k === 0 ? 'dss' : q.type === 'ASS' && k === stages.length - 1 ? 'ass' : 's' + (k + 1) + '-' + q.id }));
      if (k > 0) {
        const prev = pts[pts.length - 1], first = p.shift();       // the segment's DSS = the previous ASS
        if (dist([prev.lat, prev.lon], [first.lat, first.lon]) > 5) throw new Error('segment ' + (k + 1) + ' does not start where segment ' + k + ' ends (' + Math.round(dist([prev.lat, prev.lon], [first.lat, first.lon])) + ' m)');
        if (p[0] && p[0].leg) p[0].leg.points[0] = [prev.lat, prev.lon];
      }
      if (k < stages.length - 1) { const last = p[p.length - 1]; last.type = o.junctionType; last.name = 'Junction ' + (k + 1); }
      pts = pts.concat(p);
    });
    // validation circles must not overlap: a soft waypoint next to a junction becomes a roadbook NOTE
    const VAL = { DSS: 200, WPV: 200, WPE: 90, WPM: 90, WPN: 200, WPS: 30, WPC: 300, WPP: 20, DZ: 90, FZ: 90, ASS: 90 };
    const g = () => pts.map((p, i) => i).filter(i => pts[i].type !== 'NOTE');
    for (let guard = 0, changed = true; changed && guard < 200; guard++) {
      changed = false; const idx = g();
      for (let n = 1; n < idx.length && !changed; n++) {
        const q = pts[idx[n - 1]], p = pts[idx[n]];
        if (dist([q.lat, q.lon], [p.lat, p.lon]) >= (VAL[q.type] || 0) + (VAL[p.type] || 0)) continue;
        const soft = x => /^(WPM|WPS)$/.test(x.type) || (x.type === 'WPV' && !/^Junction/.test(x.name || ''));
        if (soft(p)) { p.type = 'NOTE'; changed = true; } else if (soft(q)) { q.type = 'NOTE'; changed = true; }
      }
    }
    const st = SG.stageFile(pts, meta);
    return st;
  }

  /**
   * Generate a long stage. inp: {dss, ass, lengthKm, preset, offShare, region, vias, side, loopBearing}.
   * hooks (all optional): loadSegment(k) -> stage | null (resume), saveSegment(k, stage, info), log(text),
   * segmentOpts: Stage-Gen overrides. Returns {stage, segments: [{k, inputs, km, warnings, ms}], layout, warnings}.
   */
  async function generateChained(inp, seed, io, opts, hooks) {
    hooks = hooks || {}; opts = opts || {};
    const log = hooks.log || (() => {}), lay = layout(inp, opts.chain);
    const segs = [], stages = [], warnings = lay.warnings.slice();
    let start = inp.dss.map(Number);
    for (let k = 0; k < lay.segKm.length; k++) {
      const segInp = { dss: start, ass: lay.junctions[k + 1], lengthKm: Math.max(5, lay.segKm[k]), preset: inp.preset, offShare: inp.offShare, region: (inp.region || 'Stage') + (lay.segKm.length > 1 ? ' part ' + (k + 1) : '') };
      let st = hooks.loadSegment ? await hooks.loadSegment(k, segInp) : null, info = { k, inputs: segInp, resumed: !!st, warnings: [] };
      if (!st) {
        const t0 = Date.now();
        log('segment ' + (k + 1) + '/' + lay.segKm.length + ': ' + segInp.lengthKm + ' km from ' + segInp.dss.join(',') + ' to ' + segInp.ass.join(','));
        // length fix: a part off its target by more than fixTol is made again with the target scaled (map data is cached)
        // the closest of the tries is kept; the target is corrected with damping (the length does not scale linearly)
        let want = segInp.lengthKm, res = null, best = null;
        const tries = opts.lengthFixTries != null ? opts.lengthFixTries : 3;
        for (let t = 0; t <= tries; t++) {
          const tryInp = Object.assign({}, segInp, { lengthKm: Math.round(want * 10) / 10 });
          const r = await SG.generate(tryInp, seed + ':seg' + (k + 1), io, Object.assign({ options: 1 }, opts.segmentOpts || {}));
          const s1 = await SG.buildStage(r, r.options[0].index, io, { created: opts.created });
          const dev = (s1.lengthKm - segInp.lengthKm) / segInp.lengthKm;
          if (!best || Math.abs(dev) < Math.abs(best.dev)) best = { st: s1, res: r, dev };
          if (Math.abs(dev) <= (opts.fixTol || 0.05)) break;
          if (t < tries) log('segment ' + (k + 1) + ': ' + s1.lengthKm.toFixed(1) + ' km for ' + segInp.lengthKm + ' km (' + (dev * 100).toFixed(0) + '%), trying again');
          const minKm = dist(segInp.dss, segInp.ass) / 1000 * 1.12;   // Stage-Gen needs room above the straight line
          const next = Math.max(minKm, Math.min(want * Math.pow(segInp.lengthKm / Math.max(1, s1.lengthKm), t === 0 ? 1 : 0.6), 200));
          if (Math.abs(next - want) < 0.3) break;
          want = next;
        }
        st = best.st; res = best.res;
        info.warnings = (res.warnings || []).map(w => w.text); info.ms = Date.now() - t0; info.region = res.region;
        if (hooks.saveSegment) await hooks.saveSegment(k, st, info);
      }
      info.km = st.lengthKm; segs.push(info); stages.push(st);
      const end = st.waypoints[st.waypoints.length - 1]; start = [end.lat, end.lon];
      warnings.push(...info.warnings.map(w => 'part ' + (k + 1) + ': ' + w));
    }
    const meta = Object.assign({ id: 'chain', name: inp.region || 'Stage', region: inp.region || '', created: opts.created || new Date().toISOString() }, opts.meta || {});
    const stage = stages.length === 1 ? Object.assign(stages[0], { id: meta.id, name: meta.name, region: meta.region, description: meta.description || stages[0].description }) : merge(stages, meta, opts.chain);
    stage.builder = stage.builder || {};
    stage.builder.stagegen = stages.length === 1 ? stages[0].builder.stagegen : { version: SG.VERSION, chain: { version: VERSION, layout: { loop: lay.loop, ratio: lay.ratio, junctions: lay.junctions }, seed: String(seed),
      segments: segs.map((s, i) => ({ k: i + 1, inputs: s.inputs, km: s.km, option: stages[i].builder.stagegen && stages[i].builder.stagegen.option, dataHash: stages[i].builder.stagegen && stages[i].builder.stagegen.dataHash, stats: stages[i].builder.stagegen && stages[i].builder.stagegen.stats })) } };
    return { stage, segments: segs, layout: lay, warnings };
  }

  return { VERSION, DEFAULTS, layout, merge, generateChained, dist, bearing, dest };
});
