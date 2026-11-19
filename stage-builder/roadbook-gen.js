/* Rally Raid roadbook generator, v0.1 (phase 1).
 *
 * Takes a stage file (docs/STAGE_FORMAT.md) and drafts a roadbook (docs/ROADBOOK_FORMAT.md):
 *   1. resamples the planned route every ~20 m,
 *   2. reads ground heights along it (and 60 m either side) from the same terrain tiles BeamNG.Earth uses
 *      (Mapterhorn, Terrarium-encoded; AWS Terrain Tiles as the backup),
 *   3. finds terrain features in the height profile (climbs, descents, crests, dips / wadis, dunes, side slopes,
 *      ridges, terrain changes),
 *   4. reads OpenStreetMap along the route through Overpass (junctions with their real side roads, fords, bridges,
 *      gates, cattle grids, fences, rivers / wadis, railways, surface changes, villages),
 *   5. merges everything into roadbook boxes with distances, CAPs, tulip data, symbols and danger levels.
 *
 * Runs in the browser (plain <script>, exposes window.RoadbookGen) and in node (require). Everything that touches the
 * network goes through two injectable functions (opts.fetchBytes, opts.decodeImage), so node can add a disk cache
 * and an image decoder, and tests can run with no network at all (opts.heightFn, opts.osm).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoadbookGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.6.0';
  const GENERATOR = 'rallyraid-roadbook-gen ' + VERSION;

  // ------------------------------------------------------------------ geometry (points are [lat, lon])
  const RE = 6371008.8;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function dist(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * RE * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function dest(p, brg, d) {
    const dr = d / RE, b = rad(brg), la = rad(p[0]), lo = rad(p[1]);
    const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
    return [deg(la2), ((deg(lo2) + 540) % 360) - 180];
  }
  /** signed angle from heading a to heading b, -180..180, + = to the right */
  const rel = (a, b) => ((b - a + 540) % 360) - 180;
  const n360 = x => ((Math.round(x) % 360) + 360) % 360;
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // local flat projection (metres) around a reference latitude, good to a few cm over a stage
  function projector(lat0) {
    const kx = RE * Math.cos(rad(lat0)) * Math.PI / 180, ky = RE * Math.PI / 180;
    return { xy: p => [p[1] * kx, p[0] * ky], ll: q => [q[1] / ky, q[0] / kx] };
  }
  function segIntersect(p1, p2, p3, p4) { // 2-D segments in metres; returns [t on p1p2, u on p3p4] or null
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1], d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
    const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
    return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? [t, u] : null;
  }
  function distToSeg(p, a, b) { // metres, flat coords
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return [Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t];
  }
  function simplify(pts, tol) { // Douglas-Peucker on [lat,lon] with flat metres
    if (pts.length < 3) return pts.slice();
    const P = projector(pts[0][0]), q = pts.map(P.xy), keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [i, j] = st.pop(); let md = 0, mi = -1;
      for (let k = i + 1; k < j; k++) { const d = distToSeg(q[k], q[i], q[j])[0]; if (d > md) { md = d; mi = k; } }
      if (md > tol) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
    }
    return pts.filter((_, k) => keep[k]);
  }

  // ------------------------------------------------------------------ route resampling
  /**
   * The stage's route as samples every `step` metres: {lat, lon, d (m along the geometry), km (roadbook km: each leg
   * scaled so it ends at the stage's own km), leg, mode}. The roadbook km is what the trip meter reads, so all
   * distances in the roadbook use it.
   */
  function resampleRoute(stage, step) {
    const legs = (stage.route && stage.route.legs) || [];
    if (!legs.length) { // no route: straight lines between waypoints
      const w = stage.waypoints;
      for (let i = 0; i + 1 < w.length; i++) legs.push({ from: w[i].id, to: w[i + 1].id, mode: 'direct', points: [[w[i].lat, w[i].lon], [w[i + 1].lat, w[i + 1].lon]] });
    }
    const out = []; let d0 = 0, km0 = 0;
    legs.forEach((leg, li) => {
      const pts = leg.points, offSet = leg.offSegs && leg.offSegs.length ? new Set(leg.offSegs) : null;
      let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
      const legKm = (typeof leg.km === 'number' && leg.km > 0) ? leg.km : L / 1000;
      const scale = L > 0 ? legKm / (L / 1000) : 1;
      const n = Math.max(1, Math.round(L / step));
      let seg = 1, segStart = 0, segLen = pts.length > 1 ? dist(pts[0], pts[1]) : 0;
      for (let k = (li === 0 ? 0 : 1); k <= n; k++) {
        const s = L * k / n;
        while (seg < pts.length - 1 && s > segStart + segLen) { segStart += segLen; seg++; segLen = dist(pts[seg - 1], pts[seg]); }
        const t = segLen > 0 ? Math.min(1, (s - segStart) / segLen) : 0;
        const p = pts.length > 1 ? lerp(pts[seg - 1], pts[seg], t) : pts[0];
        out.push({ lat: p[0], lon: p[1], d: d0 + s, km: km0 + (s / 1000) * scale, leg: li, mode: offSet && offSet.has(seg) ? 'direct' : (leg.mode || 'road'), vtx: seg });
      }
      d0 += L; km0 += legKm;
    });
    // heading of travel at each sample (over +-40 m), used for CAPs, cross-sections and turns
    const span = Math.max(1, Math.round(40 / step));
    for (let i = 0; i < out.length; i++) {
      const a = out[Math.max(0, i - span)], b = out[Math.min(out.length - 1, i + span)];
      out[i].hdg = (a === b) ? 0 : bearing([a.lat, a.lon], [b.lat, b.lon]);
    }
    return out;
  }
  function sampleAtKm(S, km) { // nearest sample index at/after km (binary search)
    let lo = 0, hi = S.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].km < km) lo = m + 1; else hi = m; }
    return lo;
  }
  function capAround(S, i, back, step) { // heading into (back=true) or out of sample i over ~60 m
    const k = Math.max(1, Math.round(60 / step));
    const j = back ? Math.max(0, i - k) : Math.min(S.length - 1, i + k);
    if (j === i) return capAround(S, i, !back, step);
    const a = back ? S[j] : S[i], b = back ? S[i] : S[j];
    return bearing([a.lat, a.lon], [b.lat, b.lon]);
  }

  // ------------------------------------------------------------------ elevation (Terrarium tiles, Web Mercator)
  const DEM_SOURCES = [
    { name: 'mapterhorn', label: 'Mapterhorn terrain tiles (Copernicus GLO-30 + national lidar), the same tiles BeamNG.Earth uses',
      url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp', size: 512, zoom: 12, attribution: 'Mapterhorn (mapterhorn.com/attribution): Copernicus DEM GLO-30 (c) ESA/DLR/Airbus and others' },
    { name: 'aws-terrarium', label: 'AWS Terrain Tiles (SRTM and others)',
      url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', size: 256, zoom: 13, attribution: 'AWS Terrain Tiles / Mapzen: SRTM, GMTED, ETOPO1 and others' }
  ];
  async function browserDecode(buf) { // ArrayBuffer -> {width, height, data: RGBA}
    const bmp = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, bmp.height);
  }
  async function defaultFetchBytes(url) {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return await r.arrayBuffer();
  }
  /** Height sampler: await dem.load(points) once, then dem.h(lat, lon) synchronously (bilinear, metres). */
  function createDem(opts) {
    opts = opts || {};
    const fetchBytes = opts.fetchBytes || defaultFetchBytes, decode = opts.decodeImage || browserDecode;
    const sources = opts.sources || DEM_SOURCES;
    const tiles = new Map(); // key -> Float32Array heights (or null = missing)
    const used = {}; let failures = 0;
    const key = (s, z, x, y) => s.name + '/' + z + '/' + x + '/' + y;
    function px(s, lat, lon) {
      const n = Math.pow(2, s.zoom) * s.size, sl = Math.sin(rad(Math.max(-85, Math.min(85, lat))));
      return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * n];
    }
    async function getTile(s, x, y) {
      const k = key(s, s.zoom, x, y);
      if (tiles.has(k)) return tiles.get(k);
      let h = null;
      try {
        const buf = await fetchBytes(s.url.replace('{z}', s.zoom).replace('{x}', x).replace('{y}', y));
        if (buf) {
          const img = await decode(buf);
          h = new Float32Array(img.width * img.height);
          const d = img.data;
          for (let i = 0, j = 0; i < h.length; i++, j += 4) h[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
          h.w = img.width;
        }
      } catch (e) { failures++; h = null; }
      tiles.set(k, h);
      return h;
    }
    const tileFor = new Map(); // "x/y" on the primary grid -> source index that answered
    async function load(points, onProgress) {
      const s0 = sources[0], need = new Set();
      for (const p of points) {
        const [X, Y] = px(s0, p[0], p[1]);
        for (const dx of [-1, 1]) for (const dy of [-1, 1]) need.add(Math.floor((X + dx) / s0.size) + '/' + Math.floor((Y + dy) / s0.size));
      }
      const list = [...need]; let done = 0;
      const worker = async () => {
        while (list.length) {
          const t = list.pop(); const [x, y] = t.split('/').map(Number);
          let si = 0;
          for (; si < sources.length; si++) {
            const s = sources[si];
            if (si === 0) { if (await getTile(s, x, y)) break; continue; }
            // backup grid: all its tiles under this primary tile
            const f = Math.pow(2, s.zoom - s0.zoom) * s0.size / s.size; let ok = true;
            for (let a = 0; a < f; a++) for (let b = 0; b < f; b++) if (!(await getTile(s, x * f + a, y * f + b))) ok = false;
            if (ok) break;
          }
          tileFor.set(t, si < sources.length ? si : -1);
          if (si < sources.length) used[sources[si].name] = (used[sources[si].name] || 0) + 1;
          done++; if (onProgress) onProgress(done, need.size);
        }
      };
      await Promise.all(Array.from({ length: opts.concurrency || 6 }, worker));
    }
    function pixel(s, X, Y) {
      const x = Math.floor(X / s.size), y = Math.floor(Y / s.size);
      const t = tiles.get(key(s, s.zoom, x, y));
      if (!t) return NaN;
      const ix = Math.min(t.w - 1, Math.max(0, X - x * s.size)), iy = Math.min(t.w - 1, Math.max(0, Y - y * s.size));
      return t[iy * t.w + ix];
    }
    function h(lat, lon) {
      const s0 = sources[0], [X0, Y0] = px(s0, lat, lon);
      const si = tileFor.get(Math.floor(X0 / s0.size) + '/' + Math.floor(Y0 / s0.size));
      if (si === undefined || si < 0) return NaN;
      const s = sources[si], [X, Y] = px(s, lat, lon);
      const fx = X - 0.5, fy = Y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const a = pixel(s, x0, y0), b = pixel(s, x0 + 1, y0), c = pixel(s, x0, y0 + 1), d = pixel(s, x0 + 1, y0 + 1);
      const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      return Number.isFinite(v) ? v : [a, b, c, d].find(Number.isFinite);
    }
    return { load, h, used, sources, get failures() { return failures; }, get tileCount() { return tiles.size; } };
  }

  // ------------------------------------------------------------------ land cover (ESA WorldCover 10 m, 2021)
  /* ESA WorldCover v200 through Microsoft Planetary Computer's tiler (public, no key, CORS *): z14 Web Mercator PNG
   * tiles of the raw class value (10 trees, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare / sparse,
   * 70 snow, 80 water, 90 wetland, 95 mangroves, 100 moss). One item per 3 x 3 degree cell. Missing tiles or a
   * failed fetch just mean "unknown": the roadbook is made without land cover. */
  const LANDCOVER = { name: 'esa-worldcover-2021', zoom: 14, size: 256,
    url: 'https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?collection=esa-worldcover&item={item}&assets=map',
    attribution: 'ESA WorldCover 2021 v200 (c) ESA, CC BY 4.0, via Microsoft Planetary Computer' };
  const LC_GROUP = { 10: 'trees', 95: 'trees', 20: 'bush', 30: 'grass', 40: 'crop', 50: 'built', 60: 'bare', 70: 'snow', 80: 'water', 90: 'wet', 100: 'moss' };
  function worldCoverItem(lat, lon) {
    const a = Math.floor(lat / 3) * 3, b = Math.floor(lon / 3) * 3;
    return 'ESA_WorldCover_10m_2021_v200_' + (a < 0 ? 'S' : 'N') + String(Math.abs(a)).padStart(2, '0') + (b < 0 ? 'W' : 'E') + String(Math.abs(b)).padStart(3, '0');
  }
  function createLandCover(opts) {
    opts = opts || {};
    const fetchBytes = opts.fetchBytes || defaultFetchBytes, decode = opts.decodeImage || browserDecode, s = opts.source || LANDCOVER;
    const tiles = new Map(); let failures = 0, loaded = 0;
    const n = Math.pow(2, s.zoom) * s.size;
    const px = (lat, lon) => { const sl = Math.sin(rad(Math.max(-85, Math.min(85, lat)))); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * n]; };
    const keyOf = (lat, lon) => { const [X, Y] = px(lat, lon); const item = worldCoverItem(lat, lon); return [item + '/' + Math.floor(X / s.size) + '/' + Math.floor(Y / s.size), X, Y, item]; };
    async function getTile(k) {
      if (tiles.has(k)) return tiles.get(k);
      const [item, x, y] = k.split('/');
      let t = null;
      try {
        const buf = await fetchBytes(s.url.replace('{z}', s.zoom).replace('{x}', x).replace('{y}', y).replace('{item}', item));
        if (buf) { const img = await decode(buf); t = new Uint8Array(img.width * img.height); for (let i = 0, j = 0; i < t.length; i++, j += 4) t[i] = img.data[j + 3] ? img.data[j] : 0; t.w = img.width; loaded++; }
      } catch (e) { failures++; }
      tiles.set(k, t); return t;
    }
    async function load(points, onProgress) {
      const need = [...new Set(points.map(p => keyOf(p[0], p[1])[0]))].filter(k => !tiles.has(k));
      let done = 0; const list = need.slice();
      const worker = async () => { while (list.length) { await getTile(list.pop()); done++; if (onProgress) onProgress(done, need.length); if (opts.maxFailures && failures >= opts.maxFailures) list.length = 0; } };
      await Promise.all(Array.from({ length: opts.concurrency || 6 }, worker));
    }
    function at(lat, lon) {
      const [k, X, Y] = keyOf(lat, lon), t = tiles.get(k);
      if (!t) return 0;
      const ix = Math.min(t.w - 1, Math.floor(X) % s.size), iy = Math.min(t.w - 1, Math.floor(Y) % s.size);
      return t[iy * t.w + ix] || 0;
    }
    return { load, at, source: s, get failures() { return failures; }, get loaded() { return loaded; } };
  }
  /** land-cover group per route sample: majority of the class codes within +-100 m (0 / null = unknown) */
  function coverAlong(S, atFn, o) {
    const N = S.length, raw = S.map(s => atFn(s.lat, s.lon)), half = Math.max(1, Math.round(100 / o.step)), out = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const cnt = {}; let best = null, bn = 0, known = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(N - 1, i + half); j++) { const g = LC_GROUP[raw[j]]; if (!g) continue; known++; cnt[g] = (cnt[g] || 0) + 1; if (cnt[g] > bn) { bn = cnt[g]; best = g; } }
      out[i] = known >= half ? best : null;
    }
    return out;
  }
  /** changes of land cover that last (both sides >= 300 m): "enter bush", "camel grass", "end of vegetation" */
  function coverFeatures(S, cov, o) {
    const N = S.length, F = [], minRun = Math.round(300 / o.step);
    let runs = []; for (let i = 0; i < N;) { let j = i; while (j + 1 < N && cov[j + 1] === cov[i]) j++; runs.push({ a: i, b: j, g: cov[i] }); i = j + 1; }
    // absorb short runs into the longer neighbour, shortest first
    for (let guard = 0; guard < 10000; guard++) {
      let k = -1; for (let r = 0; r < runs.length; r++) if (runs.length > 1 && runs[r].b - runs[r].a + 1 < minRun && (k < 0 || runs[r].b - runs[r].a < runs[k].b - runs[k].a)) k = r;
      if (k < 0) break;
      const L = runs[k - 1], R = runs[k + 1], into = !L ? R : !R ? L : (L.b - L.a >= R.b - R.a ? L : R);
      into.a = Math.min(into.a, runs[k].a); into.b = Math.max(into.b, runs[k].b); runs.splice(k, 1);
      for (let r = 1; r < runs.length; r++) if (runs[r].g === runs[r - 1].g) { runs[r - 1].b = runs[r].b; runs.splice(r, 1); r--; }
    }
    for (let r = 1; r < runs.length; r++) {
      const from = runs[r - 1].g, to = runs[r].g, i = runs[r].a;
      if (!from || !to || /snow|moss/.test(from + to)) continue;
      const off = S[i].mode === 'direct';
      if (!off && !/^(trees|crop|wet)$/.test(to)) continue;                  // on a track: only what changes the view (the road itself reads as built-up)
      F.push({ i, kind: 'cover', from, to, len: Math.round((runs[r].b - runs[r].a) * o.step), danger: 0 });
    }
    return F;
  }

  // ------------------------------------------------------------------ landmarks: classify, cluster, place
  const PALM = /palm|phoenix|cocos|washingtonia|hyphaene|borassus|elaeis|dactylifera|arecaceae/i;
  /** what a roadbook calls an OSM object: {k, sym, word, r (m it is seen / worth naming from), prom} or null */
  function landmarkKind(t) {
    if (!t) return null;
    if (t.power === 'line') return { k: 'powerline', sym: 'electric_line', word: 'POWER LINE', r: 200, prom: 2.5, line: true };
    if (t.power === 'tower') return { k: 'pylon', sym: 'pylon', word: 'PYLON', r: 300, prom: 2 };
    if (t.power === 'generator') return /wind/.test(t['generator:source'] || '') ? { k: 'turbine', sym: 'pylon', word: 'WIND TURBINE', r: 600, prom: 4 } : null;
    const h = t.historic, mm = t.man_made, am = t.amenity;
    if (t.ruins === 'yes' || h === 'ruins' || h === 'archaeological_site' || t.building === 'ruins') return { k: 'ruin', sym: 'ruins', word: 'RUIN', r: 250, prom: 3.5 };
    if (/^(fort|castle|citadel)$/.test(h || '')) return { k: 'fort', sym: 'fort', word: 'FORT', r: 400, prom: 4.5 };
    if (am === 'place_of_worship' || /^(mosque|church|chapel|temple)$/.test(t.building || '')) { const w = /muslim/.test(t.religion || '') || t.building === 'mosque' ? 'MOSQUE' : /christian/.test(t.religion || '') || /church|chapel/.test(t.building || '') ? 'CHURCH' : 'TEMPLE'; return { k: 'worship', sym: 'mosque', word: w, r: 350, prom: 4 }; }
    if (am === 'grave_yard' || t.landuse === 'cemetery') return { k: 'cemetery', sym: 'cemetery', word: 'CEMETERY', r: 250, prom: 3, area: true };
    if (am === 'fuel') return { k: 'fuel', sym: 'petrol', word: 'FUEL', r: 250, prom: 4 };
    if (/^(mast|tower|communications_tower|antenna)$/.test(mm || '')) return { k: 'mast', sym: 'antenna', word: mm === 'tower' ? 'TOWER' : 'MAST', r: 450, prom: 3.5 };
    if (mm === 'chimney') return { k: 'mast', sym: 'antenna', word: 'CHIMNEY', r: 450, prom: 3 };
    if (/^(water_tower|storage_tank|silo|reservoir_covered)$/.test(mm || '')) return { k: 'tank', sym: 'tanks', word: mm === 'water_tower' ? 'WATER TOWER' : mm === 'silo' ? 'SILO' : 'TANK', r: 300, prom: 3.5 };
    // 0.4.0: windpumps, wells, springs, cairns, survey points, monuments, milestones, border stones and sign posts are
    // not built by BeamNG.Earth (no object for them in the game), so a box must not name them
    if (/^(windmill|windpump|water_well|cairn|survey_point)$/.test(mm || '') || am === 'water_point' || t.natural === 'spring' || t.information === 'guidepost' ||
        /^(monument|memorial|boundary_stone|milestone|wayside_cross|wayside_shrine)$/.test(h || '')) return null;
    if (t.highway === 'construction') return { k: 'works', sym: 'road_works', word: 'ROAD WORKS', r: 150, prom: 3, line: true };
    const nat = t.natural;
    const latinName = () => { const n = t['name:en'] || t.int_name || t['name:latin'] || t.name; return n && /^[\x20-\u024f]+$/.test(n) ? ' ' + String(n).toUpperCase().slice(0, 24) : ''; };
    if (/^(peak|volcano|hill)$/.test(nat || '') && (t.name || t.ele)) return { k: 'peak', sym: null, word: (nat === 'volcano' ? 'VOLCANO' : nat === 'hill' ? 'HILL' : 'PEAK') + latinName(), r: 2500, prom: 3, far: true };
    if (nat === 'saddle' && t.name) return { k: 'saddle', sym: null, word: 'PASS' + latinName(), r: 1500, prom: 2.5, far: true };
    if (nat === 'coastline') return { k: 'sea', sym: 'water', word: 'SEA', r: 2000, prom: 3, line: true };
    if (nat === 'beach') return { k: 'beach', sym: 'soft_sand', word: 'BEACH', r: 300, prom: 1.5, area: true };
    if (nat === 'sand' || nat === 'dune') return { k: 'sand', sym: 'soft_sand', word: 'SA', inWord: 'SA (SANDY)', r: 60, prom: 2.2, area: true, ground: true };
    if (/^(scree|shingle|bare_rock)$/.test(nat || '')) return { k: 'stony', sym: 'rocks', word: nat === 'bare_rock' ? 'ROCK SLAB' : 'EMP', inWord: nat === 'bare_rock' ? 'ON BARE ROCK' : 'EMP (STONY)', r: 60, prom: 2.2, area: true, ground: true };
    if (t.landuse === 'salt_pond' || (nat === 'water' && /salt/.test(t.water || '')) || (nat === 'wetland' && /salt|saltmarsh|tidalflat/.test(t.wetland || ''))) return { k: 'salt', sym: 'water', word: 'SALT PAN', r: 400, prom: 3, area: true };
    if (nat === 'wetland') return { k: 'marsh', sym: 'water', word: 'MARSH', r: 250, prom: 2.5, area: true };
    if (nat === 'water') { const w = /^(river|canal|stream)$/.test(t.water || '') ? 'RIVER' : t.intermittent === 'yes' ? 'PAN' : t.water === 'reservoir' || t.landuse === 'reservoir' ? 'RESERVOIR' : /^(lake|lagoon|oxbow)$/.test(t.water || '') || t.name ? 'LAKE' : 'WATER'; return { k: 'water', sym: 'water', word: w + (w === 'LAKE' || w === 'RESERVOIR' ? latinName() : ''), r: w === 'LAKE' || w === 'RESERVOIR' ? 600 : 300, prom: w === 'WATER' ? 2.8 : 3.4, area: true }; }
    if (t.natural === 'tree') { const palm = PALM.test([t.species, t.genus, t.taxon, t['species:en'], t.name, t.leaf_type === 'palm' ? 'palm' : ''].join(' ')); return { k: palm ? 'palm' : 'tree', sym: palm ? 'palm_tree' : 'tree', word: palm ? 'PALM' : 'TREE', r: 120, prom: 2.2 }; }
    if (t.natural === 'tree_row') return { k: 'treerow', sym: 'trees', word: 'TREE LINE', r: 150, prom: 2, line: true };
    if (t.natural === 'rock' || t.natural === 'stone') return null;   // 0.4.0: a mapped boulder is not placed in the game (its rocks are random, from land cover + slope)
    if (t.landuse === 'orchard') return { k: 'orchard', sym: 'trees', word: 'ORCHARD', r: 80, prom: 2, area: true };
    if (t.landuse === 'farmland') return { k: 'fields', sym: 'vegetation', word: 'FIELDS', r: 80, prom: 1.2, area: true };
    if (t.building) return { k: 'building', sym: 'buildings', word: 'HOUSE', r: 220, prom: 2 };
    return null;
  }
  function pointInRing(p, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  /** OSM elements -> landmark list in projected metres; buildings and single trees grouped into clusters */
  function prepLandmarks(elements, P) {
    const out = [], bld = [], trees = [];
    for (const e of elements || []) {
      const L = landmarkKind(e.tags); if (!L) continue;
      // 0.4.0: BeamNG.Earth builds buildings (Overture footprints), not points: a ruin, mosque, fort, cemetery or storage
      // tank mapped only as a point has nothing to see in the game (a water tower point does: it is a world prop)
      if (e.type === 'node' && (/^(ruin|fort|worship|cemetery)$/.test(L.k) || (L.k === 'tank' && L.word !== 'WATER TOWER'))) continue;
      L.id = e.type + '/' + e.id;
      if (e.type === 'node') L.pts = [P.xy([e.lat, e.lon])];
      else if (e.geometry && e.geometry.length) { L.pts = e.geometry.filter(g => g && g.lat != null).map(g => P.xy([g.lat, g.lon])); L.closed = L.pts.length > 3 && e.geometry[0].lat === e.geometry[e.geometry.length - 1].lat && e.geometry[0].lon === e.geometry[e.geometry.length - 1].lon; if (!L.line && !L.area && !L.closed) L.pts = [L.pts[Math.floor(L.pts.length / 2)]]; else if (!L.line && !L.area) { const c = L.pts.reduce((a, p) => [a[0] + p[0] / L.pts.length, a[1] + p[1] / L.pts.length], [0, 0]); L.pts = [c]; } }
      else if (e.center) L.pts = [P.xy([e.center.lat, e.center.lon])];
      else continue;
      if (!L.pts.length) continue;
      if (L.k === 'building') bld.push(L); else if (L.k === 'tree' || L.k === 'palm') trees.push(L); else out.push(L);
    }
    // clusters: houses within 80 m of each other, trees within 40 m
    const cluster = (list, gap, make) => {
      const G = new Map(), key = (x, y) => Math.floor(x / gap) + ',' + Math.floor(y / gap), seen = new Set();
      list.forEach((L, i) => { const k = key(L.pts[0][0], L.pts[0][1]); if (!G.has(k)) G.set(k, []); G.get(k).push(i); });
      for (let i = 0; i < list.length; i++) {
        if (seen.has(i)) continue;
        const grp = [i]; seen.add(i);
        for (let q = 0; q < grp.length; q++) {
          const [x, y] = list[grp[q]].pts[0];
          for (let gx = Math.floor(x / gap) - 1; gx <= Math.floor(x / gap) + 1; gx++) for (let gy = Math.floor(y / gap) - 1; gy <= Math.floor(y / gap) + 1; gy++)
            for (const j of (G.get(gx + ',' + gy) || [])) if (!seen.has(j) && Math.hypot(list[j].pts[0][0] - x, list[j].pts[0][1] - y) <= gap) { seen.add(j); grp.push(j); }
        }
        out.push(make(grp.map(j => list[j])));
      }
    };
    cluster(bld, 80, g => { const n = g.length; return { k: 'building', sym: 'buildings', word: n === 1 ? 'HOUSE' : n <= 4 ? n + ' HOUSES' : n <= 40 ? 'HOUSES' : 'BUILT-UP', r: n === 1 ? 180 : 300, prom: n === 1 ? 2 : n <= 4 ? 2.5 : 3, n, town: n > 40, pts: g.map(L => L.pts[0]), id: g[0].id, group: true }; });
    cluster(trees, 40, g => { const n = g.length, palm = g.filter(L => L.k === 'palm').length * 2 >= n; return { k: palm ? 'palm' : 'tree', sym: n >= 5 ? (palm ? 'palm_tree' : 'trees') : (palm ? 'palm_tree' : 'tree'), word: n === 1 ? (palm ? 'PALM' : 'TREE') : n <= 4 ? n + (palm ? ' PALMS' : ' TREES') : (palm ? 'PALM GROVE' : 'TREES'), r: n >= 5 ? 200 : 120, prom: n >= 5 ? 2.8 : 2.2, n, pts: g.map(L => L.pts[0]), id: g[0].id, members: g.map(L => L.pts[0]) }; });
    return out;
  }
  /** distance (m) from p to a landmark and the nearest point on it */
  function landmarkNear(L, p) {
    let best = Infinity, np = L.pts[0];
    if ((L.line || L.area || L.closed) && L.pts.length > 1) {
      if ((L.area || L.closed) && !L.line && pointInRing(p, L.pts)) return { d: 0, np: p, inside: true };
      for (let i = 0; i + 1 < L.pts.length; i++) { const [d, t] = distToSeg(p, L.pts[i], L.pts[i + 1]); if (d < best) { best = d; np = [L.pts[i][0] + (L.pts[i + 1][0] - L.pts[i][0]) * t, L.pts[i][1] + (L.pts[i + 1][1] - L.pts[i][1]) * t]; } }
    } else for (const q of L.pts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < best) { best = d; np = q; } }
    return { d: best, np };
  }
  const sideWord = a => a < 0 ? 'onL' : 'onR';
  const round10 = d => Math.max(10, Math.round(d / 10) * 10);
  /** how a roadbook writes it: "RUIN onL 100", "TOWARDS MAST", "PALM onR" */
  const distWord = d => d < 30 ? '' : d <= 300 ? ' ' + round10(d) : d < 1000 ? ' ' + Math.round(d / 50) * 50 : ' ' + (d / 1000).toFixed(1) + ' KM';
  function landmarkText(L, d, a) {
    if (Math.abs(a) <= 15 && d > 80) return 'TOWARDS ' + L.word + (L.far ? distWord(d) : '');
    return L.word + ' ' + sideWord(a) + (d <= 300 || L.far || L.line || L.area ? distWord(d) : '');
  }
  /** features before assembly: power lines the route crosses, prominent things it passes close to */
  function landmarkFeatures(S, lms, o) {
    const F = [], P = projector(S[0].lat), q = S.map(s => P.xy([s.lat, s.lon])), N = S.length;
    for (const L of lms) {
      if (L.line && L.k === 'powerline') {
        let last = -1e9;
        for (let i = 0; i + 1 < N; i++) for (let k = 0; k + 1 < L.pts.length; k++) {
          const hit = segIntersect(q[i], q[i + 1], L.pts[k], L.pts[k + 1]);
          if (hit && (S[i].d - last) > 300) { last = S[i].d; F.push({ i: i + (hit[0] > 0.5 ? 1 : 0), kind: 'landmark_cross', what: L.k, word: L.word, sym: L.sym, lm: L.id, danger: 0 }); }
        }
        continue;
      }
      if (L.town || L.line || L.area || L.far || L.ground || (L.k === 'building' && L.n > 4) || L.prom < 2.2) continue;
      // nearest route sample (coarse: every other sample is enough at 20 m)
      let bi = -1, bd = Infinity;
      for (let i = 0; i < N; i += 2) { const { d } = landmarkNear(L, q[i]); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0 || bd > (L.prom >= 3.5 ? 80 : 40)) continue;
      for (let i = Math.max(0, bi - 2); i <= Math.min(N - 1, bi + 2); i++) { const { d } = landmarkNear(L, q[i]); if (d < bd) { bd = d; bi = i; } }
      const np = landmarkNear(L, q[bi]).np, a = rel(S[bi].hdg, (deg(Math.atan2(np[0] - q[bi][0], np[1] - q[bi][1])) + 360) % 360);
      const btw = L.members && L.n === 2 && L.members.map(m => Math.sign(rel(S[bi].hdg, (deg(Math.atan2(m[0] - q[bi][0], m[1] - q[bi][1])) + 360) % 360))).reduce((x, y) => x * y, 1) < 0;
      F.push({ i: bi, kind: 'landmark_pass', what: L.k, word: L.word, sym: L.sym, prom: L.prom, side: a < 0 ? 'L' : 'R', d: Math.round(bd), text: btw ? 'BTW 2 ' + (L.k === 'palm' ? 'PALMS' : 'TREES') : L.word + ' ' + sideWord(a) + (bd >= 30 ? ' ' + round10(bd) : ''), lm: L.id, danger: 0 });
    }
    return F;
  }
  /**
   * 0.4.0: stones and rocks where the game puts them. BeamNG.Earth (vegetation.py) scatters rocks per 6 m cell from ESA
   * WorldCover, the same tiles we read: bare ground (60) gets rocks only on slopes (2 % none .. 10 % full, slope over
   * +-40 m), shrub (20) a steady 4 %, nothing on roads, within 60 m of built-up land or on beaches; ground over 35 deg
   * is ROCK material. So: off-piste (and on paths, which the game does not build) on bare ground 5 %+ = STONY,
   * 10 %+ = ROCKY, in shrub = STONES IN VG, over 70 % = ROCK; on a track over bare 10 %+ ground = rocks both sides.
   */
  function rockFeatures(S, H, hl, hr, cov, cls, o) {
    const N = S.length, step = o.step, F = [];
    if (!cov || !H || N < 5) return F;
    // dune fields too (Wyans 18 Nov: "Note rocks in dune fields too"): the game's bare-ground rule puts stones on dune flanks
    const k = Math.max(1, Math.round(40 / step)), D = 2 * o.sideOffset;
    const slope = i => { const a = Math.max(0, i - k), b = Math.min(N - 1, i + k); const al = b > a ? (H[b] - H[a]) / ((b - a) * step) : 0;
      const xs = hl && hr && Number.isFinite(hl[i]) && Number.isFinite(hr[i]) ? (hl[i] - hr[i]) / D : 0; return Math.hypot(al, xs); };
    const lvl = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const c = cov[i], unbuilt = S[i].mode === 'direct' || cls[i] === 'offpiste' || cls[i] === 'path', sl = slope(i);
      if (!c || !Number.isFinite(sl)) continue;
      if (unbuilt && sl >= 0.7) lvl[i] = 4;
      else if (unbuilt && c === 'bare') lvl[i] = sl >= 0.10 ? 3 : sl >= 0.05 ? 2 : 0;
      else if (unbuilt && c === 'bush') lvl[i] = 1;
      else if (!unbuilt && /^(track|twotrack|sand|gravel)$/.test(cls[i] || '') && c === 'bare' && sl >= 0.10) lvl[i] = 5;   // edges
    }
    const gap = Math.round(100 / step);
    let lastKm = -1e9, lastL = 0;
    for (let i = 0; i < N;) {
      if (!lvl[i]) { i++; continue; }
      const kind5 = lvl[i] === 5; let j = i, miss = 0, mx = lvl[i], q = i;
      while (q + 1 < N && miss <= gap) { q++; if (lvl[q] && (lvl[q] === 5) === kind5) { j = q; miss = 0; if (!kind5) mx = Math.max(mx, lvl[q]); } else miss++; }
      const len = (j - i) * step;
      const level = kind5 ? 1 : mx === 4 ? 3 : mx === 3 ? 2 : 1;
      const minM = kind5 ? 400 : mx === 4 ? 40 : mx === 1 ? 400 : 200;
      // the same stony ground again within 3 km: once (unless it gets worse)
      if (len >= minM && (S[i].km - lastKm > 3 || level > lastL)) { F.push({ i, kind: 'rocks', level, edges: kind5, vg: mx === 1, len, danger: level >= 2 ? (level >= 3 ? 2 : 1) : 0 }); lastKm = S[j].km; lastL = level; }
      i = j + 1;
    }
    return F;
  }
  /**
   * 0.4.0: following a river or a wadi: an OSM waterway within 150 m, running the same way, for 600 m or more.
   * Rivers / streams / canals are built as water in the game; a dry wadi is not, so it needs the route in its bed
   * (< 40 m) or the valley in the DEM.
   */
  function alongWaterFeatures(S, ways, valleyDepth, o) {
    const N = S.length, step = o.step, F = [];
    if (!ways || !ways.length || N < 5) return F;
    const P = projector(S[0].lat), q = S.map(s => P.xy([s.lat, s.lon])), G = 200, grid = new Map();
    const seen = new Set();
    for (const w of ways) {
      if (seen.has(w.id) || !w.geometry) continue; seen.add(w.id);
      if (!/^(river|stream|wadi|canal)$/.test((w.tags && w.tags.waterway) || '')) continue;
      const pts = w.geometry.filter(g => g && g.lat != null).map(g => P.xy([g.lat, g.lon]));
      for (let k = 1; k < pts.length; k++) { const a = pts[k - 1], b = pts[k];
        for (const c of new Set([Math.floor(a[0] / G) + ',' + Math.floor(a[1] / G), Math.floor(b[0] / G) + ',' + Math.floor(b[1] / G), Math.floor((a[0] + b[0]) / 2 / G) + ',' + Math.floor((a[1] + b[1]) / 2 / G)])) { if (!grid.has(c)) grid.set(c, []); grid.get(c).push([w, a, b]); } }
    }
    if (!grid.size) return F;
    const hit = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const [x, y] = q[i]; let best = null;
      for (let gx = Math.floor(x / G) - 1; gx <= Math.floor(x / G) + 1; gx++) for (let gy = Math.floor(y / G) - 1; gy <= Math.floor(y / G) + 1; gy++) for (const [w, a, b] of (grid.get(gx + ',' + gy) || [])) {
        const [d, t] = distToSeg(q[i], a, b); if (d > 150) continue;
        const sb = (deg(Math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360, al = Math.abs(rel(S[i].hdg, sb));
        if (Math.min(al, 180 - al) > 35) continue;
        if (!best || d < best.d) { const np = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; best = { w, d, side: rel(S[i].hdg, (deg(Math.atan2(np[0] - x, np[1] - y)) + 360) % 360) < 0 ? 'L' : 'R' }; }
      }
      hit[i] = best;
    }
    const gap = Math.round(80 / step);
    for (let i = 0; i < N;) {
      if (!hit[i]) { i++; continue; }
      let j = i, miss = 0, qq = i; const list = [hit[i]];
      while (qq + 1 < N && miss <= gap) { qq++; if (hit[qq]) { j = qq; miss = 0; list.push(hit[qq]); } else miss++; }
      const len = (j - i) * step;
      if (len >= 600) {
        const cnt = new Map(); for (const h of list) cnt.set(h.w, (cnt.get(h.w) || 0) + 1);
        const w = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0], t = w.tags || {};
        const dry = t.intermittent === 'yes' || t.seasonal === 'yes' || t.waterway === 'wadi';
        let deep = 0; if (valleyDepth) for (let k = i; k <= j; k++) if (valleyDepth[k] >= 2) deep++;
        const ds = list.map(h => h.d).sort((a, b) => a - b), med = ds[Math.floor(ds.length / 2)];
        const sides = list.filter(h => h.side === 'L').length;
        // a dry wadi is not water in the game, but its bed is in the terrain (the DEM): in the bed, or a valley we see
        if (!dry || med < 40 || (valleyDepth && deep >= 0.4 * (j - i + 1))) F.push({ i, kind: 'along_water', len, dry, inBed: dry && med < 15, what: { river: 'RIVER', canal: 'CANAL' }[t.waterway] || 'STREAM',
          side: sides * 2 >= list.length ? 'L' : 'R', name: latinName(t), danger: 0 });
      }
      i = j + 1;
    }
    return F;
  }
  /**
   * 0.4.0: keep only the terrain notes the game's ground can have. BeamNG.Earth grades the ground under a built road
   * (grading.py: residential 14 m .. primary+ 40 m gaussian, tracks 6 m + a 10 m median; paths are not built), and the
   * DEM is a surface model (buildings, bridges and trees in it), so a DEM bump on a built road or in a town is mostly not
   * there in the game.
   */
  function gateTerrain(fs, S, grade, cls, cov, others) {
    const near = (i, kinds, m) => others.some(f => kinds.test(f.kind) && Math.abs(S[f.i].d - S[i].d) < m);
    return fs.filter(f => {
      const g = grade ? grade[f.i] || 0 : 0, c = cls ? cls[f.i] : null, built = cov && cov[f.i] === 'built';
      if (f.kind === 'bump' || f.kind === 'ditch') return g <= 6 && !built && !near(f.i, /^(bridge|cross_road|cross_railway|level_crossing|cross_water)$/, 80);
      if (/^step_/.test(f.kind)) return g <= 8 && !built;
      if (/^(crest|dip|compression|jump)$/.test(f.kind)) { if (g >= 25 && !f.blind) return false; if (f.kind === 'jump' && g >= 12) f.kind = 'crest'; return true; }
      if (f.kind === 'undulations') return g < 20;
      if ((f.kind === 'valley' || f.kind === 'ridge') && f.onWay) return !/^(tarmac|dual)$/.test(c || '');
      return true;
    });
  }
  /**
   * 0.4.0: the lie of the land (stony ground, a valley or wadi being followed, a ridge, rocky track, traces) is not worth a
   * box of its own on a sparse roadbook, so the density pruning used to drop it. When its own box was pruned, the note
   * rides on the next box that is there anyway (from 200 m before it to 1.5 km into it): no new boxes, so the spacing,
   * merge and density rules are unchanged; at most 4 note parts and 5 symbols per box, as in enrichBoxes.
   */
  function ambientNotes(boxes, S, feats) {
    let n = 0;
    const have = new Set(); for (const b of boxes) for (const f of b.features || []) have.add(f.kind + '@' + f.km);
    for (const f of feats) {
      const km = S[Math.max(0, Math.min(S.length - 1, f.i))].km, key = f.kind + '@' + km;
      if (boxes.some(b => (b.features || []).some(g => g.kind === f.kind && Math.abs((g.km != null ? g.km : b.km) - km) < 0.1))) continue;
      const d = describe(f), to = km + Math.min(1.5, Math.max(0.3, (f.len || 0) / 1000));
      const host = boxes.find(b => !b.pinned && !b.deleted && b.km >= km - 0.2 && b.km <= to && (b.notes ? b.notes.split('. ').length : 0) < 4 && (b.symbols || []).length + d.sym.length <= 5 &&
        !(b.notes || '').toUpperCase().includes(d.note.toUpperCase().split(' ')[0] + ' ' + (d.note.toUpperCase().split(' ')[1] || '')));
      if (!host) continue;
      host.notes = host.notes ? host.notes + '. ' + d.note : d.note;
      for (const y of d.sym) if (y && !host.symbols.includes(y)) host.symbols.push(y);
      const src = featureSource(f.kind); if (host.sources && !host.sources.includes(src)) host.sources.push(src);
      const cf = cleanFeature(f); cf.km = +km.toFixed(2); cf.ambient = true; (host.features = host.features || []).push(cf);
      if ((f.danger || 0) > (host.danger || 0)) host.danger = f.danger;
      have.add(key); n++;
    }
    return n;
  }
  const COVER_TEXT = { bush: ['vegetation', 'VG (BUSH)'], grass: ['camel_grass', 'GRASS TUFTS'], trees: ['trees', 'TREES'], crop: ['vegetation', 'FIELDS'], built: ['buildings', 'BUILT-UP'], water: ['water', 'WATER'], wet: ['water', 'MARSH'] };
  const TERRAIN_SYM = { flat: ['flat', 'FAST'], rolling: ['rolling', 'ROLLING'], broken: ['broken', 'BROKEN GROUND'], dunes: ['dunes', 'IN DUNES'] };
  /**
   * After assembly: what a crew sees from each box. Up to two landmarks in sight (side and distance), the vegetation
   * the box is in (off-piste), the ground character on bare CAP boxes, "R / L OVER CREST" when a turn is on a crest.
   * Only data: OSM objects, ESA WorldCover classes and the terrain profile. Returns counts for the stats.
   */
  function enrichBoxes(boxes, S, ctx, o) {
    const P = projector(S[0].lat), lms = ctx.landmarks || [], used = new Map(), cnt = { landmarks: 0, cover: 0, terrain: 0, overCrest: 0 };
    const saidAt = new Map(), say = (w, km) => { if (!saidAt.has(w)) saidAt.set(w, []); saidAt.get(w).push(km); };   // the same word again within 1.5 km is noise (ORCHARD, ORCHARD...)
    const saidNear = (w, km) => (saidAt.get(w) || []).some(k => Math.abs(k - km) < 1.5);
    for (const b of boxes) for (const f of b.features || []) if (f.lm) { used.set(f.lm, b.km); if (f.word) say(f.word, b.km); }
    const seen = (L, km) => used.has(L.id) && (!(L.line || L.area || L.far) || km - used.get(L.id) < 10);   // a shore, a sand sea, a peak: again 10 km on
    // grid for the landmarks (500 m cells)
    const G = 500, grid = new Map();
    lms.forEach(L => { const xs = L.pts.map(p => p[0]), ys = L.pts.map(p => p[1]); for (let gx = Math.floor((Math.min(...xs) - L.r) / G); gx <= Math.floor((Math.max(...xs) + L.r) / G); gx++) for (let gy = Math.floor((Math.min(...ys) - L.r) / G); gy <= Math.floor((Math.max(...ys) + L.r) / G); gy++) { const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(L); } });
    const bySi = new Map(); S.forEach((s, i) => bySi.set(s.km.toFixed(2), i));
    const siOf = b => { const k = (+b.km).toFixed(2); if (bySi.has(k)) return bySi.get(k); return sampleAtKm(S, b.km); };
    const addSym = (b, s) => { if (s && !b.symbols.includes(s)) b.symbols.push(s); };
    const addNote = (b, t) => { if (t && !(b.notes || '').toUpperCase().includes(t.toUpperCase())) b.notes = b.notes ? b.notes + '. ' + t : t; };
    const addSrc = (b, s) => { if (!b.sources.includes(s)) b.sources.push(s); };
    const nParts = b => (b.notes ? b.notes.split('. ').length : 0);
    let lastTerr = null;
    for (const b of boxes) {
      if (b.pinned || b.deleted) continue;
      const si = siOf(b), s = S[si], p = P.xy([b.lat, b.lon]), cap = b.capOut != null ? b.capOut : b.cap;
      const zone = (b.symbols || []).includes('village');
      // 1. landmarks in sight
      if (lms.length && !(b.features || []).some(f => f.kind === 'landmark_pass' || f.kind === 'landmark_cross')) {
        const cands = [];
        for (const L of (grid.get(Math.floor(p[0] / G) + ',' + Math.floor(p[1] / G)) || [])) {
          if (seen(L, b.km) || saidNear(L.far ? 'far:' + L.k : L.word, b.km) || (L.town && !b.offPiste) || (zone && L.k === 'building') || (L.ground && !b.offPiste) || (L.k === 'stony' && ctx.cover && ctx.cover[si] && !/^(bare|bush)$/.test(ctx.cover[si]))) continue;
          const { d, np, inside } = landmarkNear(L, p); if (d > L.r) continue;
          const a = inside ? 0 : rel(cap, (deg(Math.atan2(np[0] - p[0], np[1] - p[1])) + 360) % 360);
          if (Math.abs(a) > 120 && d > 40) continue;                         // behind you
          cands.push({ L, d, a, inside, score: L.prom * (1 - d / L.r) + (d < 60 ? 1 : 0) });
        }
        cands.sort((x, y) => y.score - x.score);
        const picked = [];
        // two single trees either side within 40 m: "BTW 2 TREES"
        const tl = cands.find(c => (c.L.k === 'tree' || c.L.k === 'palm') && c.L.n === 1 && c.d <= 40 && c.a < 0), tr = cands.find(c => (c.L.k === 'tree' || c.L.k === 'palm') && c.L.n === 1 && c.d <= 40 && c.a > 0);
        if (tl && tr) picked.push({ text: 'BTW 2 ' + (tl.L.k === 'palm' && tr.L.k === 'palm' ? 'PALMS' : 'TREES'), sym: tl.L.sym, list: [tl, tr] });
        else {
          const pair = cands.find(c => (c.L.k === 'tree' || c.L.k === 'palm') && c.L.n === 2 && c.d <= 40 && c.L.members.map(m => Math.sign(rel(cap, (deg(Math.atan2(m[0] - p[0], m[1] - p[1])) + 360) % 360))).reduce((x, y) => x * y, 1) < 0);
          if (pair) picked.push({ text: 'BTW 2 ' + (pair.L.k === 'palm' ? 'PALMS' : 'TREES'), sym: pair.L.k === 'palm' ? 'palm_tree' : 'tree', list: [pair] });
        }
        // a short note: at most 4 parts in all, so a busy box gets one landmark (or none)
        const room = Math.max(0, Math.min(2, 4 - nParts(b)));
        if (picked.length > room) picked.length = room;
        for (const c of cands) {
          if (picked.length >= room || b.symbols.length + picked.length >= 5) break;
          const fam = k => k === 'pylon' ? 'powerline' : k === 'palm' ? 'tree' : k;
          if (picked.some(x => x.list.some(y => y.L === c.L || fam(y.L.k) === fam(c.L.k)))) continue;
          if (picked.length && c.score < 0.6 * picked[0].list[0].score) break;
          const text = (c.L.area || c.L.closed) && c.inside ? (c.L.inWord || 'IN ' + c.L.word) : landmarkText(c.L, c.d, c.a);
          picked.push({ text, sym: c.L.sym || (/^TOWARDS/.test(text) ? 'towards' : null), list: [c] });
        }
        for (const x of picked) {
          addSym(b, x.sym); addNote(b, x.text); addSrc(b, 'auto-osm');
          for (const c of x.list) { used.set(c.L.id, b.km); say(c.L.far ? 'far:' + c.L.k : c.L.word, b.km); b.features.push({ kind: 'landmark', what: c.L.k, word: c.L.word, side: c.a < 0 ? 'L' : 'R', d: Math.round(c.d), osm: c.L.id }); }
          cnt.landmarks++;
        }
      }
      // 2. the vegetation the box is in (off-piste: what you drive through)
      if (b.offPiste && ctx.cover && !(b.features || []).some(f => f.kind === 'cover')) {
        const g = ctx.cover[si], ct = g && COVER_TEXT[g];
        if (ct && /^(bush|grass|trees|crop|wet)$/.test(g) && !b.symbols.includes(ct[0]) && nParts(b) < 4) { addSym(b, ct[0]); addNote(b, 'IN ' + ct[1]); addSrc(b, 'auto-landcover'); b.features.push({ kind: 'cover_in', cover: g }); cnt.cover++; }
      }
      // 3. ground character on a box that only says CAP, when it changed since the last box that said it (or 5 km on)
      if (!b.offPiste) lastTerr = null;
      else if (ctx.terrain) {
        const t = ctx.terrain[si], said = b.symbols.find(x => TERRAIN_SYM[x]);
        if (said) lastTerr = { t: said, km: b.km };
        else if (t && TERRAIN_SYM[t] && b.symbols.every(x => x === 'cap' || x === 'continue') && (!lastTerr || lastTerr.t !== t || b.km - lastTerr.km >= 5)) {
          const ts = TERRAIN_SYM[t]; addSym(b, ts[0]); if (!/flat|fast|rolling|broken|dune/i.test(b.notes || '')) addNote(b, ts[1]); cnt.terrain++; lastTerr = { t, km: b.km };
        }
      }
      // 4. a turn on a crest: "R OVER CREST"
      const turn = b.capIn != null && b.capOut != null ? rel(b.capIn, b.capOut) : 0;
      if (Math.abs(turn) >= 25 && b.symbols.some(x => x === 'crest' || x === 'jump') && !b.symbols.includes('over_crest')) { addSym(b, 'over_crest'); addNote(b, (turn < 0 ? 'L' : 'R') + ' OVER CREST'); cnt.overCrest++; }
    }
    return cnt;
  }

  // ------------------------------------------------------------------ profile analysis (pure, testable)
  function smooth(a, half) { // moving average, +-half samples, NaN-safe
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(a.length - 1, i + half); j++) if (Number.isFinite(a[j])) { s += a[j]; n++; }
      out[i] = n ? s / n : NaN;
    }
    return out;
  }
  function fillGaps(a) { // linear fill of NaN runs (sea / missing tiles)
    const out = Float64Array.from(a); let last = -1;
    for (let i = 0; i < out.length; i++) {
      if (Number.isFinite(out[i])) {
        if (last >= 0 && i - last > 1) for (let j = last + 1; j < i; j++) out[j] = out[last] + (out[i] - out[last]) * (j - last) / (i - last);
        else if (last < 0) for (let j = 0; j < i; j++) out[j] = out[i];
        last = i;
      }
    }
    if (last < 0) out.fill(0); else for (let j = last + 1; j < out.length; j++) out[j] = out[last];
    return out;
  }
  const DEFAULTS = {
    step: 20,              // m between samples
    density: 4,            // target boxes per 10 km (2 = sparse, long CAP legs; 25 = every wrinkle). Waypoints, junctions,
                           // danger >= 2, gates, leaving / joining tracks are always kept; the rest is ranked and pruned
    maxGapKm: null,        // longest stretch without a box before a filler CAP / FOLLOW box (null: 40 / density km, min 1)
    mergeM: 70,            // features closer than this share a box
    // 0.5.0 (Wyans 18 Nov: "notes jammed on top of each other"): 250 m / 300 m; 0.5.2 (19 Nov): 300 m everywhere. The Dakar roadbook lexicon flags any
    // partial under 300 m as a "short distance" (green box, arrow on the line before); several elements a short way
    // apart are drawn in ONE diagram with the distance between them ("extended note"). So: closer notes merge.
    minSpacingM: 300,      // no two boxes closer than this (fastSpacingM on fast roads); closer ones merge (AT n M ...) or the weaker goes
    fastSpacingM: 300,     // minimum spacing between boxes on tarmac / gravel roads (RO / PP)
    wpShortM: 100,         // a must-keep note this close before a waypoint merges into the waypoint's box (else it keeps its own, flagged short)
    shortFlagM: 300,       // partials under this are flagged `short` (the Dakar "short distance" mark)
    sideOffset: 60,        // m either side for the cross-section
    climbGrade: 7, climbMinLen: 150, climbMinRise: 12,
    crestMin: 9, dipMin: 9,
    duneAmp: 4, duneMinRev: 4, duneSteep: 10, duneGapM: 800,
    sideSlope: 15, ridgeRelief: 4,
    bumpMin: 2, ditchMin: 2, stepMin: 4, smallEveryKm: 2,   // DEM bumps / ditches / steps (m); at most one of them per smallEveryKm
    bendMin: 65,           // degrees of turn (no junction) for a bend note on a track
    capKeepTurn: 10,       // a planned-line CAP change of at least this many degrees is never pruned (the planner thins the line itself)
    roadFillerKm: null,    // on-piste: a "follow" box when nothing happens for this long (null: like maxGapKm, min 5)
    // Public OSM Overpass mirrors that send CORS headers (the editor runs in the browser).
    // Official first, so we use it when it answers in time (one OSM vintage per generate).
    // kumi.systems was renamed to private.coffee, so it is not listed twice.
    // lz4/z.overpass-api.de are the official cluster (same machines). Overpass France is
    // invite-only; OSM Japan failed TLS from here; OpenHistoricalMap is a different dataset.
    // overpass.osm.ch is Switzerland-only and returns HTTP 200 with 0 elements elsewhere, so
    // it is not in this worldwide list (it is added automatically only for Swiss bboxes).
    // NextGIS (worldwide, no key, CORS open, minutes-fresh data) first: on 17 Nov 2026 it answered in 1-3 s while the
    // official server was "at capacity" (HTTP 502) all morning. The official one is still asked when its /api/status
    // says it has room, and the racing below starts a second mirror if the first is slow.
    overpass: [
      'https://overpass.nextgis.com/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ],
    // Regional extracts, used only when every bbox in the query sits inside the extract.
    // Inserted after the official mirror, never instead of a timely official answer.
    overpassRegional: [
      { ep: 'https://overpass.osm.ch/api/interpreter', s: 45.75, w: 5.85, n: 47.85, e: 10.55 },  // Switzerland
      { ep: 'https://ovp.dresel.systems/api/interpreter', s: 34.9, w: -24.6, n: 81.2, e: 31.6 }, // Europe (Geofabrik, nightly)
      { ep: 'https://ovp.dresel.systems/api-na/interpreter', s: 14.3, w: -170, n: 83.5, e: -51 }  // North America (Geofabrik, nightly)
    ],
    overpassRadius: 35, placeRadius: 1500, landmarkRadius: 450, landformRadius: 1500, landmarkRounds: 2, overpassPieceM: 2000, overpassChunk: 30,
    overpassPauseMs: 2000,      // backoff base when a request fails (sequential / retry path)
    overpassGapMs: 400,         // pause between successful chunks on the same mirror (fair use)
    overpassTimeoutMs: 22000,   // abort a hung mirror and try the next (was 120 s); keep near [timeout:] so we do not leave a query running
    overpassStaggerMs: 4000,    // if the preferred mirror has not answered by then, start a second
    overpassMaxInFlight: 2,     // never race more than two mirrors at once
    overpassFirstByteMs: 10000, // a mirror that sends nothing (not even headers) for this long is dropped (busy servers queue silently)
    overpassStallMs: 20000,     // once data flows: give up only if it stops for this long (big answers may take a while)
    overpassStickyFastMs: 6000, // stay on a mirror for later queries only if it answered faster than this
    overpassStatusUrl: 'https://overpass-api.de/api/status', // official server: skip it at once when this says it is full
    overpassMaxPauseMs: 15000,
    junctionsInSpeedZones: 'turns', // 'all' | 'turns' (inside DZ..FZ only junctions where you turn / fork)
    // off-piste line planner (planOffPiste)
    planOffPiste: true, planCell: 30, planWidthFrac: 0.18, planMinHalfWidth: 500, planMaxHalfWidth: 2500, planMinLegM: 400, planMinGapM: 150, planFollow: true, followMinM: 300, followRiseM: 8, followMaxTurn: 50, planValleyCentre: true, valleyWallM: 10, valleyMaxHalfM: 600, valleySmoothM: 30, followDuneRoughM: 2,
    planNoise: 0.7, planNoiseCell: 450, planSlopeCost: 40, planCliff: 0.6, planClimbCost: 6, planDescentCost: 1.5,
    planMaxUp: 0.22, planMaxDown: 0.35, planFenceCost: 600, planSimplifyM: 45, planZeroIsSea: false, planMinSegM: 250,
    // 0.5.3 (Wyans 19 Nov 2026): heavy vegetation is avoided at all costs: forest / wood (OSM) and ESA WorldCover tree
    // cover cost planTreeCost x a cell (was 6x: effectively impassable, yet a waypoint inside a wood can still get out),
    // scrub planScrubCost x (was 2.5x). lineHazards() says what a straight line crosses (hazardMinM of a kind counts).
    planTreeCost: 400, planScrubCost: 40, planWetCost: 8, hazardStepM: 20, hazardMinM: 60, hazardEndM: 60,
    planMaxSegM: 1800, planMaxSegFlatM: 3000, planFlatSlope: 0.02, planJitterMinM: 50, planJitterMaxM: 140, planSeed: 0,
    planVertexShare: 0.6, planKeepTurn: 35,
    // 0.6.0 (Wyans 19 Nov 2026): in a dune field the roadbook path is a recce line (the CAP heading, maybe a broad
    // interdune corridor that really runs along it). It does not weave round single dunes; steep faces are cautions.
    // A field is OSM natural=sand/dune, or the same height-reversal test used for DNX notes.
    duneRecce: true, duneFrac: 0.35, duneMinStretchM: 600,
    recceStepM: 50, recceCorridorHalfM: 500, recceCorridorMinM: 1500, recceCorridorWallM: 12, recceMinOffsetM: 40,
    recceSmoothM: 1200, recceSimplifyM: 250, recceMaxTurn: 25,
    duneSpacingM: 800, duneDensity: 1, duneMaxGapKm: 25, duneFacePct: 35, duneFaceHardPct: 45
  };

  /**
   * Terrain features from heights along the route. `S` samples (with .mode), `h` heights (m), `hl`/`hr` heights 60 m
   * left / right (may be null). Returns [{i, kind, ...}] (i = sample index).
   */
  function analyseProfile(S, h, hl, hr, o) {
    const step = o.step, N = S.length, F = [];
    if (N < 5) return F;
    const H = smooth(fillGaps(h), Math.max(1, Math.round(20 / step)));           // ~60 m window: kills DEM pixel noise, keeps 150 m dunes
    const Hlong = smooth(H, Math.round(150 / step));                              // ~300 m: the "trend"
    const k50 = Math.max(1, Math.round(40 / step));
    const g = new Float64Array(N);                                                // grade % over ~100 m
    for (let i = 0; i < N; i++) { const a = Math.max(0, i - k50), b = Math.min(N - 1, i + k50); g[i] = b > a ? (H[b] - H[a]) / ((b - a) * step) * 100 : 0; }
    const off = i => S[i].mode === 'direct';

    // climbs / descents: runs of steady grade
    for (const sign of [1, -1]) {
      let i = 0;
      while (i < N) {
        if (sign * g[i] < o.climbGrade) { i++; continue; }
        let j = i, gap = 0, mx = 0;
        while (j + 1 < N && gap * step <= 40) { j++; if (sign * g[j] >= o.climbGrade * 0.7) { gap = 0; mx = Math.max(mx, sign * g[j]); } else gap++; }
        j -= gap;
        const len = (j - i) * step, rise = sign * (H[j] - H[i]);
        if (len >= o.climbMinLen && rise >= o.climbMinRise) {
          const avg = rise / len * 100, onRoad = !off(i);
          const danger = sign < 0 ? (mx >= 30 ? 3 : mx >= 22 ? 2 : mx >= (onRoad ? 14 : 15) ? 1 : 0) : (mx >= 35 ? 2 : mx >= 22 ? 1 : 0);
          F.push({ i, kind: sign > 0 ? 'climb' : 'descent', grade: Math.round(avg), maxGrade: Math.round(mx), len: Math.round(len), relief: Math.round(rise), danger });
        }
        i = j + 1;
      }
    }
    // dunes: many short steep up/down reversals (zig-zag with an amplitude threshold)
    const ext = []; // [index, height, type +1 peak / -1 trough]
    { let dir = 0, ei = 0;
      for (let i = 1; i < N; i++) {
        if (dir >= 0 && H[i] > H[ei]) { ei = i; if (dir === 0) dir = 1; }
        else if (dir <= 0 && H[i] < H[ei]) { ei = i; if (dir === 0) dir = -1; }
        if (dir === 1 && H[ei] - H[i] >= o.duneAmp) { ext.push([ei, H[ei], 1]); dir = -1; ei = i; }
        else if (dir === -1 && H[i] - H[ei] >= o.duneAmp) { ext.push([ei, H[ei], -1]); dir = 1; ei = i; }
      }
    }
    const duneAt = new Uint8Array(N), win = Math.round(1000 / step);
    for (let a = 0; a < ext.length; a++) {
      let b = a; while (b + 1 < ext.length && ext[b + 1][0] - ext[a][0] <= win) b++;
      const revs = b - a;
      if (revs >= o.duneMinRev) {
        let steep = 0; for (let i = ext[a][0]; i <= ext[b][0]; i++) steep = Math.max(steep, Math.abs(g[i]));
        if (steep >= o.duneSteep) for (let i = ext[a][0]; i <= ext[b][0]; i++) duneAt[i] = 1;
      }
    }
    if (S) for (let i = 0; i < N; i++) if (S[i] && S[i].inDune) duneAt[i] = 1;
    const dunes = [];
    for (let i = 0; i < N;) {
      if (!duneAt[i]) { i++; continue; }
      let j = i; while (j + 1 < N && (duneAt[j + 1] || (j + 1 + Math.round(o.duneGapM / step) < N && duneAt.slice(j + 1, j + 1 + Math.round(o.duneGapM / step)).some(Boolean)))) j++;
      if ((j - i) * step >= 600) {
        const amps = []; let steep = 0;
        for (let e = 1; e < ext.length; e++) if (ext[e][0] >= i && ext[e][0] <= j) amps.push(Math.abs(ext[e][1] - ext[e - 1][1]));
        for (let q = i; q <= j; q++) steep = Math.max(steep, Math.abs(g[q]));
        amps.sort((x, y) => x - y);
        const amp = amps.length ? amps[Math.floor(amps.length / 2)] : 0, big = amps.length ? amps[amps.length - 1] : 0;
        const size = amp >= 25 ? 'big' : amp >= 10 ? 'medium' : 'small';
        dunes.push([i, j]);
        F.push({ i, kind: 'dunes', end: j, lenKm: +((j - i) * step / 1000).toFixed(1), amp: Math.round(amp), maxAmp: Math.round(big), size, maxGrade: Math.round(steep), danger: size === 'big' ? 2 : 1 });
        F.push({ i: j, kind: 'dunes_end' });
      }
      i = j + 1;
    }
    const inDunes = i => dunes.some(([a, b]) => i >= a && i <= b);

    // 0.6.0: in a dune field, steep faces / drops and major cordon (ridge) crossings are cautions, not dodges
    {
      const face = o.duneFacePct, hard = o.duneFaceHardPct;
      for (let i = 0; i < N;) {
        if (!inDunes(i) || Math.abs(g[i]) < face) { i++; continue; }
        const sign = Math.sign(g[i]);
        let j = i, mx = Math.abs(g[i]);
        while (j + 1 < N && inDunes(j + 1) && Math.sign(g[j + 1]) === sign && Math.abs(g[j + 1]) >= face * 0.7) {
          j++; mx = Math.max(mx, Math.abs(g[j]));
        }
        const len = (j - i) * step;
        if (len >= 40 && mx >= face) {
          const danger = mx >= hard ? 2 : 1;
          F.push({ i, kind: sign > 0 ? 'steep_face' : 'steep_drop', grade: Math.round(mx), len: Math.round(len), danger, end: j });
        }
        i = j + 1;
      }
      const kcC = Math.max(1, Math.round(80 / step)), sepC = Math.round(1500 / step);
      for (let i = kcC; i < N - kcC; i++) {
        if (!inDunes(i)) continue;
        const before = (H[i] - H[i - kcC]) / (kcC * step) * 100, after = (H[i + kcC] - H[i]) / (kcC * step) * 100;
        const convC = (before >= 6 && after <= -6) ? before - after : 0;
        if (convC < 28) continue;
        let isMax = true;
        for (let j = Math.max(0, i - sepC); j <= Math.min(N - 1, i + sepC); j++) {
          if (j === i || !inDunes(j)) continue;
          const b2 = (H[j] - H[Math.max(0, j - kcC)]) / (kcC * step) * 100, a2 = (H[Math.min(N - 1, j + kcC)] - H[j]) / (kcC * step) * 100;
          if ((b2 >= 4 && a2 <= -4) && (b2 - a2) > convC) { isMax = false; break; }
        }
        if (!isMax) continue;
        const relief = Math.max(0, H[i] - Math.min(H[Math.max(0, i - kcC)], H[Math.min(N - 1, i + kcC)]));
        if (relief < 20) continue;
        F.push({ i, kind: 'cordon', relief: Math.round(relief), grade: Math.round(convC), danger: convC >= 40 || relief >= 40 ? 2 : 1 });
      }
    }

    // crests and dips: change of grade across the point
    const kc = Math.max(1, Math.round(50 / step));
    const conv = new Float64Array(N);
    for (let i = kc; i < N - kc; i++) {
      const before = (H[i] - H[i - kc]) / (kc * step) * 100, after = (H[i + kc] - H[i]) / (kc * step) * 100;
      conv[i] = (before >= 2 && after <= -2) ? before - after : (before <= -2 && after >= 2) ? -(after - before) : 0;
    }
    const sep = Math.round(120 / step);
    for (let i = kc; i < N - kc; i++) {
      const c = conv[i]; if (!c) continue;
      let isMax = true;
      for (let j = Math.max(0, i - sep); j <= Math.min(N - 1, i + sep); j++) if (j !== i && Math.abs(conv[j]) > Math.abs(c) && Math.sign(conv[j]) === Math.sign(c)) { isMax = false; break; }
      if (!isMax) continue;
      const before = (H[i] - H[i - kc]) / (kc * step) * 100, after = (H[i + kc] - H[i]) / (kc * step) * 100;
      if (c > 0 && c >= o.crestMin) {
        if (inDunes(i) && after > -25) continue;                 // inside a dune field only the steep drop-offs
        const onRoad = !off(i);
        const danger = c >= 30 ? 3 : c >= 18 ? 2 : c >= 12 ? 1 : 0;
        F.push({ i, kind: (onRoad && c >= 14 && kc * step <= 60) ? 'jump' : 'crest', severity: Math.round(c), before: Math.round(before), after: Math.round(after), danger, blind: c >= 18 });
      } else if (c < 0 && -c >= o.dipMin) {
        if (inDunes(i)) continue;
        const w = Math.round(100 / step), a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
        const depth = Math.min(H[a], H[b]) - H[i];
        let kind = 'dip';
        const k2 = Math.max(1, Math.round(60 / step)), narrow = i - k2 >= 0 && i + k2 < N && H[i - k2] - H[i] >= o.ditchMin && H[i + k2] - H[i] >= o.ditchMin && Math.abs(H[a] - H[i - k2]) < 1.5 && Math.abs(H[b] - H[i + k2]) < 1.5;
        if (narrow && depth < 4) { F.push({ i, kind: 'ditch', depth: +(Math.min(H[i - k2], H[i + k2]) - H[i]).toFixed(1), danger: Math.min(H[i - k2], H[i + k2]) - H[i] >= 3 ? 1 : 0 }); continue; }
        if (depth >= 4) kind = 'wadi'; else if (-c >= 16) kind = 'compression';
        const s = -c;
        F.push({ i, kind, severity: Math.round(s), depth: Math.round(depth * 10) / 10, danger: s >= 30 ? 3 : s >= 20 ? 2 : s >= 12 ? 1 : 0 });
      }
    }
    // three or more crests / dips within 250 m of each other: one "series" box instead of a box each
    {
      const cd = F.filter(f => /^(crest|dip|compression|jump)$/.test(f.kind)).sort((a, b) => a.i - b.i);
      const gapS = Math.round(250 / step); let run = [];
      const flush = () => {
        if (run.length >= 3) {
          for (const f of run) F.splice(F.indexOf(f), 1);
          F.push({ i: run[0].i, kind: 'undulations', count: run.length, len: (run[run.length - 1].i - run[0].i) * step, danger: Math.max(...run.map(f => f.danger)), blind: run.some(f => f.blind) });
        }
        run = [];
      };
      for (const f of cd) { if (run.length && f.i - run[run.length - 1].i > gapS) flush(); run.push(f); }
      flush();
    }
    // cross-section: side slopes, ridges, valley floors (off-piste only: a built track is cut into the slope)
    if (hl && hr) {
      const L = smooth(fillGaps(hl), Math.round(50 / step)), R = smooth(fillGaps(hr), Math.round(50 / step));
      const D = 2 * o.sideOffset;
      const xs = i => (L[i] - R[i]) / D * 100;                   // + = left side higher: falls away to the right
      const ridge = i => H[i] - Math.max(L[i], R[i]), valley = i => Math.min(L[i], R[i]) - H[i];
      const runs = (test, minM, emit, any) => {
        const ok = i => any ? !inDunes(i) : off(i);
        for (let i = 0; i < N;) {
          if (!ok(i) || !test(i)) { i++; continue; }
          let j = i; while (j + 1 < N && ok(j + 1) && test(j + 1) && off(j + 1) === off(i)) j++;
          if ((j - i) * step >= minM) emit(i, j);
          i = j + 1;
        }
      };
      runs(i => Math.abs(xs(i)) >= o.sideSlope && !inDunes(i), 200, (i, j) => {
        let m = 0; for (let q = i; q <= j; q++) if (Math.abs(xs(q)) > Math.abs(m)) m = xs(q);
        F.push({ i, kind: 'sideslope', side: m > 0 ? 'R' : 'L', grade: Math.round(Math.abs(m)), len: (j - i) * step, danger: Math.abs(m) >= 30 ? 2 : 1 });
      });
      // 0.4.0: ridges and valleys on tracks too (generate() drops them on tarmac): a crew reads "FOLLOW VALLEY" on any way
      runs(i => ridge(i) >= o.ridgeRelief, 300, (i, j) => F.push({ i, kind: 'ridge', len: (j - i) * step, onWay: !off(i), danger: off(i) ? 1 : 0 }), true);
      runs(i => valley(i) >= o.ridgeRelief && Math.abs(xs(i)) < o.sideSlope, 400, (i, j) => { let dm = 0; for (let q = i; q <= j; q++) dm = Math.max(dm, valley(q)); F.push({ i, kind: 'valley', len: (j - i) * step, depth: Math.round(dm), onWay: !off(i), danger: 0 }); }, true);
      F.valleyDepth = Array.from({ length: N }, (_, i) => valley(i));
    }
    // terrain character (off-piste): fast flat, rolling, broken; announced when it changes for at least 1 km
    {
      const half = Math.round(250 / step), cls = new Array(N);
      for (let i = 0; i < N; i++) {
        let sr = 0, sg = 0, n = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(N - 1, i + half); j++) { sr += (H[j] - Hlong[j]) ** 2; sg += Math.abs(g[j]); n++; }
        const rough = Math.sqrt(sr / n), mg = sg / n;
        cls[i] = duneAt[i] ? 'dunes' : (rough < 1.0 && mg < 2.5) ? 'flat' : (rough >= 4 || mg >= 9) ? 'broken' : 'rolling';
      }
      let cur = null, i = 0;
      const minRun = Math.round(1000 / step);
      while (i < N) {
        if (!off(i)) { cur = null; i++; continue; }
        let j = i; while (j + 1 < N && off(j + 1) && cls[j + 1] === cls[i]) j++;
        if (cls[i] !== cur && (j - i + 1 >= minRun || cur === null)) {
          if (cls[i] !== 'dunes' && (j - i + 1) >= minRun) F.push({ i, kind: 'terrain', terrain: cls[i], len: (j - i) * step, danger: cls[i] === 'broken' ? 1 : 0 });
          cur = cls[i];
        }
        i = j + 1;
      }
      F.terrainClass = cls;
    }
    // small things on the line from the 60 m profile: a bump (hump), a ditch (narrow trench), a step up / down (short
    // steep rise between gentler ground). Not inside dunes and not where a crest / dip / wadi box already is.
    {
      const cls = F.terrainClass;
      const k2 = Math.max(1, Math.round(40 / step)), k1 = Math.max(1, Math.round(20 / step)), k3 = Math.max(2, Math.round(80 / step));
      const taken = F.filter(f => /^(crest|jump|dip|compression|wadi|ditch|undulations|climb|descent)$/.test(f.kind)).map(f => f.i);
      const busy = i => inDunes(i) || duneAt[i] || cls[i] === 'broken' || cls[i] === 'dunes' || taken.some(t => Math.abs(t - i) * step < 120);
      const small = [];
      for (let i = k3; i < N - k3; i++) {
        const mid = (H[i - k2] + H[i + k2]) / 2, c = H[i] - mid;
        const loc = (sgn) => { for (let j = i - k2; j <= i + k2; j++) if (j !== i && sgn * (H[j] - (H[j - k2 < 0 ? 0 : j - k2] + H[Math.min(N - 1, j + k2)]) / 2) > sgn * c) return false; return true; };
        if (c >= o.bumpMin && loc(1)) small.push({ i, kind: 'bump', height: +c.toFixed(1), danger: c >= 3.5 ? 1 : 0 });
        else if (-c >= o.ditchMin && loc(-1)) small.push({ i, kind: 'ditch', depth: +(-c).toFixed(1), danger: -c >= 3 ? 1 : 0 });
        // step: >= stepMin over 40 m, the 60 m before and after less than a third as steep
        const d = H[i + k1] - H[i - k1], before = H[i - k1] - H[i - k3], after = H[i + k3] - H[i + k1];
        if (Math.abs(d) >= o.stepMin - 0.05 && Math.abs(before) * (2 * k1) / (k3 - k1) < Math.abs(d) / 3 && Math.abs(after) * (2 * k1) / (k3 - k1) < Math.abs(d) / 3) {
          let isMax = true; for (let j = i - k2; j <= i + k2; j++) if (j !== i && j - k1 >= 0 && j + k1 < N && Math.abs(H[j + k1] - H[j - k1]) > Math.abs(d)) { isMax = false; break; }
          if (isMax) small.push({ i, kind: d > 0 ? 'step_up' : 'step_down', height: Math.round(Math.abs(H[i + k3] - H[i - k3])), danger: d < 0 ? (-d >= 8 ? 2 : 1) : 0 });
        }
      }
      // strongest first, at most smallPerKm per km and 300 m apart
      const mag = f => (f.height || f.depth || 0) * (f.kind.startsWith('step') ? 0.6 : 1);
      small.sort((a, b) => mag(b) - mag(a));
      const keep = [], perKm = new Map();
      for (const f of small) {
        if (busy(f.i) || keep.some(k => Math.abs(k.i - f.i) * step < 300)) continue;
        const km = Math.floor(S[f.i].km / o.smallEveryKm); if ((perKm.get(km) || 0) >= 1) continue;
        perKm.set(km, (perKm.get(km) || 0) + 1); keep.push(f);
      }
      F.push(...keep);
    }
    F.H = H; F.grade = g;
    return F;
  }

  // ------------------------------------------------------------------ OpenStreetMap (Overpass)
  /* Overpass: the route is cut into ~2 km pieces and each piece's bounding box (padded) is asked for; the answers are
   * filtered by distance on our side. (Overpass's "around a line" filter returned nothing at all for some routes with
   * long straight off-piste legs, 2026-11-16, so plain boxes it is.) */
  function routeBoxes(S, pieceM, padM) {
    // contiguous runs only (a filtered sample list may jump across an off-piste leg)
    const runs = []; let r0 = 0;
    for (let i = 1; i <= S.length; i++) if (i === S.length || S[i].d - S[i - 1].d > 200) { if (i - r0 >= 2) runs.push(S.slice(r0, i)); r0 = i; }
    if (runs.length > 1 || (runs.length === 1 && runs[0].length !== S.length)) return runs.flatMap(R => routeBoxes1(R, pieceM, padM));
    return routeBoxes1(S, pieceM, padM);
  }
  function routeBoxes1(S, pieceM, padM) {
    const out = []; let a = 0;
    while (a < S.length - 1) {
      let b = a; while (b + 1 < S.length && S[b + 1].d - S[a].d <= pieceM) b++;
      if (b === a) b = a + 1;
      let s = 90, w = 180, n = -90, e = -180;
      for (let i = a; i <= b; i++) { s = Math.min(s, S[i].lat); n = Math.max(n, S[i].lat); w = Math.min(w, S[i].lon); e = Math.max(e, S[i].lon); }
      const dLat = padM / 111320, dLon = padM / (111320 * Math.cos(rad((s + n) / 2)));
      out.push([s - dLat, w - dLon, n + dLat, e + dLon]);
      a = b;
    }
    return out;
  }
  function overpassQuery(boxes, o) {
    const f = b => b.map(x => x.toFixed(5)).join(',');
    let q = '[out:json][timeout:20];(';
    for (const b of boxes) {
      const B = '(' + f(b) + ')';
      q += 'way[highway]' + B + ';way[waterway]' + B + ';way[barrier]' + B + ';way[railway]' + B + ';way[ford]' + B + ';way[natural=water]' + B + ';' +
        'node[barrier]' + B + ';node[ford]' + B + ';node[highway~"^(ford|traffic_signals|stop)$"]' + B + ';node[railway=level_crossing]' + B + ';';
    }
    q += ');out body geom;(';
    const pd = o.placeRadius / 111320;
    for (const b of boxes) q += 'node[place~"^(city|town|village|hamlet)$"](' + f([b[0] - pd, b[1] - pd * 1.1, b[2] + pd, b[3] + pd * 1.1]) + ');';
    return q + ');out body;';
  }
  async function fetchOsm(S, o, log, extraBoxes, onChunk) {
    const boxes = routeBoxes(S.filter(s => s.mode !== 'direct'), o.overpassPieceM, o.overpassRadius + 15).concat(extraBoxes || []);
    const chunks = [];
    for (let i = 0; i < boxes.length; i += o.overpassChunk) chunks.push(boxes.slice(i, i + o.overpassChunk));
    const els = new Map();
    let endpoint = null;
    for (let c = 0; c < chunks.length; c++) {
      const q = overpassQuery(chunks[c], o);
      let data = null;
      try { data = await askOverpass(q, o, log); endpoint = o._overpassSticky || endpoint; }
      catch (e) { throw new Error('Overpass failed: ' + (e && e.message)); }
      for (const e of data.elements) els.set(e.type + e.id, e);
      if (log) log('osm chunk ' + (c + 1) + '/' + chunks.length + ': ' + data.elements.length + ' elements' + (endpoint ? ' via ' + endpoint : ''));
      if (onChunk) onChunk(c + 1, chunks.length);
      if (c + 1 < chunks.length) await overpassGap(o);
    }
    return { elements: [...els.values()], endpoint, fetched: new Date().toISOString() };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /** wait before retry n: exponential with jitter, rotating mirrors in between */
  const backoff = (o, n) => Math.min(o.overpassMaxPauseMs || 15000, (o.overpassPauseMs || 2000) * Math.pow(2, Math.floor(n / Math.max(1, (o.overpass || []).length)))) * (0.75 + Math.random() * 0.5);
  function overpassQueryBoxes(q) {
    const boxes = [];
    const re = /\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/g;
    let m; while ((m = re.exec(q || ''))) boxes.push([+m[1], +m[2], +m[3], +m[4]]);
    return boxes;
  }
  function overpassInRegion(boxes, r) {
    if (!boxes.length || !r) return false;
    return boxes.every(b => b[0] >= r.s && b[1] >= r.w && b[2] <= r.n && b[3] <= r.e);
  }
  function overpassOrder(o, q) {
    const list = (o.overpass || DEFAULTS.overpass).slice();
    const regions = o.overpassRegional === false ? [] : (o.overpassRegional || DEFAULTS.overpassRegional || []);
    if (regions.length && q) {
      const boxes = overpassQueryBoxes(q);
      let at = Math.min(1, list.length);
      for (const r of regions) {
        if (r && r.ep && overpassInRegion(boxes, r) && list.indexOf(r.ep) < 0) { list.splice(at, 0, r.ep); at++; }
      }
    }
    const now = Date.now(), cool = o._overpassCool || {};
    const ready = list.filter(ep => !cool[ep] || cool[ep] <= now);
    const resting = list.filter(ep => cool[ep] && cool[ep] > now);
    const ordered = ready.concat(resting);
    const prefer = o._overpassSticky;
    const i = prefer ? ordered.indexOf(prefer) : -1;
    return i > 0 ? ordered.slice(i).concat(ordered.slice(0, i)) : ordered;
  }
  function overpassBad(r) {
    if (!r || !Array.isArray(r.elements)) return true;
    if (r.remark && /error|timed out|out of memory/i.test(r.remark)) return true;
    const ts = r.osm3s && r.osm3s.timestamp_osm_base;
    if (ts && !/^\d{4}-\d{2}-\d{2}T/.test(String(ts))) return true; // e.g. Switzerland extract reports "118529"
    return false;
  }
  function overpassMarkCool(o, ep, e) {
    const msg = String((e && e.message) || e || '');
    const wait = /HTTP 429|HTTP 406/.test(msg) ? 60000
      : /HTTP 502|HTTP 504|at capacity/.test(msg) ? 30000
      : /aborted|timed out|Timeout/i.test(msg) ? 8000
      : 10000;
    o._overpassCool = o._overpassCool || {};
    o._overpassCool[ep] = Date.now() + wait;
  }

  /**
   * POST one query to one mirror. Three clocks: no response at all within firstByteMs -> give up fast (a full server
   * queues silently); once data flows, give up only if it stalls for stallMs; never longer than timeout overall.
   */
  async function defaultOverpass(ep, q, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeout != null ? opts.timeout : 120000;
    const firstMs = opts.firstByte != null ? opts.firstByte : DEFAULTS.overpassFirstByteMs;
    const stallMs = opts.stall != null ? opts.stall : DEFAULTS.overpassStallMs;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let why = null, tStall = null;
    const stop = w => { if (!why) why = w; if (ctl) ctl.abort(); };
    const tAll = ctl ? setTimeout(() => stop('no complete answer in ' + Math.round(timeoutMs / 1000) + ' s'), timeoutMs) : null;
    const arm = ms => { if (!ctl) return; clearTimeout(tStall); tStall = setTimeout(() => stop(ms === firstMs ? 'no answer in ' + Math.round(ms / 1000) + ' s' : 'answer stalled for ' + Math.round(ms / 1000) + ' s'), ms); };
    if (opts.signal && ctl) {
      if (opts.signal.aborted) ctl.abort();
      else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'RallyRaidRoadbook/1.0 (https://rrearth.wyans.net)'
    };
    let text = '';
    try {
      arm(firstMs);
      const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers, signal: ctl ? ctl.signal : undefined });
      arm(stallMs);
      if (r.body && r.body.getReader && typeof TextDecoder !== 'undefined') {
        const rd = r.body.getReader(), dec = new TextDecoder(), parts = [];
        for (;;) { const c = await rd.read(); if (c.done) break; parts.push(dec.decode(c.value, { stream: true })); arm(stallMs); }
        parts.push(dec.decode()); text = parts.join('');
      } else text = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + (/at capacity/i.test(text) ? ' (at capacity)' : ''));
    } catch (e) {
      if (why && !(opts.signal && opts.signal.aborted)) throw new Error('mirror ' + why);   // our clock, not the caller's abort
      throw e;
    } finally { clearTimeout(tAll); clearTimeout(tStall); }
    try { return JSON.parse(text); }
    catch (e) {
      // NextGIS (Overpass dispatcher) answers HTTP 200 + an HTML error when the same query arrives again while the
      // first copy is still registered (~20 s): not a broken mirror, just "ask again in a moment"
      if (/duplicate_query/.test(text)) { const d = new Error('duplicate query (the server still has the same one)'); d.duplicate = true; throw d; }
      throw new Error('non-JSON response');
    }
  }

  // official server's /api/status, checked at most once a minute: "at capacity" / 502 -> rest it, ask the others
  const statusSeen = { at: 0, ok: true, p: null };
  function overpassStatus(o) {
    const url = o.overpassStatusUrl != null ? o.overpassStatusUrl : DEFAULTS.overpassStatusUrl;
    // on by default with the built-in fetch; callers with their own fetchOverpass (tests, caches) opt in with overpassStatusCheck: true
    if (!url || o.overpassStatusCheck === false || (o.fetchOverpass && o.overpassStatusCheck !== true) || typeof fetch === 'undefined') return Promise.resolve(true);
    if (Date.now() - statusSeen.at < 60000) return Promise.resolve(statusSeen.ok);
    if (statusSeen.p) return statusSeen.p;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, t = ctl ? setTimeout(() => ctl.abort(), 3000) : null;
    statusSeen.p = fetch(url, { signal: ctl ? ctl.signal : undefined }).then(r => r.text().then(t => r.ok && !/at capacity|queue is full/i.test(t) && !/^0 slots available/m.test(t)))
      .catch(() => true)   // status unknown: do not skip
      .then(ok => { clearTimeout(t); statusSeen.at = Date.now(); statusSeen.ok = ok; statusSeen.p = null; return ok; });
    return statusSeen.p;
  }
  const OFFICIAL = /^https:\/\/overpass-api\.de\//;
  // the same query with its server time limit raised by k seconds: identical data, but a different text, which gets past
  // NextGIS' "duplicate query" check (measured 17 Nov: a repeat is refused on and off for ~20-40 s; a +1 s variant is not)
  function queryVariant(q, k) {
    if (!k) return q;
    if (/\[timeout:(\d+)\]/.test(q)) return q.replace(/\[timeout:(\d+)\]/, (m, n) => '[timeout:' + (+n + k) + ']');
    return q.replace(/^\[out:json\]/, '[out:json][timeout:' + (180 + k) + ']');
  }
  // the same query already on its way (e.g. two tiles, a retry and the track router asking alike): share the answer
  const inFlight = new Map();
  // ... and the same query answered a moment ago (e.g. a leg re-routed, a retry): reuse that answer for 60 s
  const recent = new Map(), RECENT_MS = 60000, RECENT_MAX = 12;
  function remember(q, r) {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > RECENT_MS) recent.delete(k);
    recent.set(q, { at: now, r });
    while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  }

  /**
   * One Overpass query, with mirrors.
   * Default (real network): prefer the last mirror that worked (or the official one), wait overpassStaggerMs,
   * and only then start a second mirror. The first good answer wins; the other request is aborted.
   * At most two requests are in flight, so we do not hammer every public instance for every chunk.
   * Tests that pass fetchOverpass keep the old one-at-a-time loop (fast, deterministic).
   */
  function askOverpass(q, o, log) {
    o = o || {};
    if (o.overpassDedup === false) return askOverpassOnce(q, o, log);
    const hit = inFlight.get(q);
    if (hit) { if (log) log('overpass: same query already on its way, sharing it'); return hit; }
    // (only with the built-in fetch: callers that bring their own fetchOverpass have their own cache, and tests count calls)
    const useRecent = !o.fetchOverpass || o.overpassRecent === true;
    const old = useRecent && recent.get(q);
    if (old && Date.now() - old.at < RECENT_MS) { if (log) log('overpass: same query answered ' + Math.round((Date.now() - old.at) / 1000) + ' s ago, reusing it'); return Promise.resolve(old.r); }
    const p = askOverpassOnce(q, o, log).then(r => { if (useRecent) remember(q, r); return r; });
    inFlight.set(q, p);
    const done = () => { if (inFlight.get(q) === p) inFlight.delete(q); };
    p.then(done, done);
    return p;
  }
  async function askOverpassOnce(q, o, log) {
    const fetchOne = o.fetchOverpass || defaultOverpass;
    const order = overpassOrder(o, q);
    const race = o.overpassRace === true || (!o.fetchOverpass && o.overpassRace !== false);
    const maxAttempts = order.length * (o.overpassRounds != null ? o.overpassRounds : (race ? 1 : 3));
    if (!order.length) throw new Error('no Overpass mirrors');
    const badMsg = r => (r && r.remark) || 'unusable Overpass response';

    if (!race) {
      let lastErr = null, dups = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ep = order[attempt % order.length];
        try {
          const r = await fetchOne(ep, queryVariant(q, dups));
          if (overpassBad(r)) throw new Error(badMsg(r));
          o._overpassSticky = ep;
          return r;
        } catch (e) {
          lastErr = e;
          if (/^offline/.test(e && e.message)) throw e;
          if (e && e.duplicate && dups < 6) {   // the mirror still holds our earlier copy: same mirror again shortly
            dups++; if (log) log('overpass ' + ep + ': duplicate query, asking again'); await sleep(o.overpassDuplicateWaitMs != null ? o.overpassDuplicateWaitMs : 1000); attempt--; continue;
          }
          if (log) log('overpass ' + ep + ': ' + e.message);
          overpassMarkCool(o, ep, e);
          await sleep(backoff(o, attempt));
        }
      }
      throw lastErr || new Error('Overpass failed');
    }

    const timeoutMs = o.overpassTimeoutMs || DEFAULTS.overpassTimeoutMs || 22000;
    const staggerMs = o.overpassStaggerMs != null ? o.overpassStaggerMs : 4000;
    const maxInFlight = o.overpassMaxInFlight || 2;
    const fetchOpts = ctl => ({ timeout: timeoutMs, firstByte: o.overpassFirstByteMs != null ? o.overpassFirstByteMs : DEFAULTS.overpassFirstByteMs,
      stall: o.overpassStallMs != null ? o.overpassStallMs : DEFAULTS.overpassStallMs, signal: ctl && ctl.signal });
    const fastMs = o.overpassStickyFastMs != null ? o.overpassStickyFastMs : DEFAULTS.overpassStickyFastMs;
    // official server full? rest it now (costs one small request a minute, ~0.3 s)
    if (order.some(ep => OFFICIAL.test(ep)) && !(await overpassStatus(o))) {
      o._overpassCool = o._overpassCool || {};
      for (const ep of order) if (OFFICIAL.test(ep)) o._overpassCool[ep] = Math.max(o._overpassCool[ep] || 0, Date.now() + 60000);
      if (log) log('overpass-api.de says it is full: asking the other mirrors');
      if (o._overpassSticky && OFFICIAL.test(o._overpassSticky)) o._overpassSticky = null;
    }

    // The mirror that last answered fast is asked first (overpassOrder), but no longer alone: if it is slow, the
    // stagger starts a second one as for any query, and a slow winner is not stuck to.
    order.splice(0, order.length, ...overpassOrder(o, q));   // again: the status check may have rested the official one
    let lastErr = null, next = 0;
    const pending = [];
    const isCool = ep => (o._overpassCool && o._overpassCool[ep] || 0) > Date.now();

    const startNext = () => {
      if (pending.length >= maxInFlight || next >= maxAttempts) return;
      let ep = null, tries = 0;
      while (tries++ < order.length * 2 && next < maxAttempts) {
        const cand = order[next % order.length];
        next++;
        if (pending.some(p => p.ep === cand)) continue;
        if (isCool(cand) && order.some(x => !isCool(x) && !pending.some(p => p.ep === x))) continue;
        ep = cand; break;
      }
      if (!ep) return;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, t1 = Date.now();
      const dupWait = o.overpassDuplicateWaitMs != null ? o.overpassDuplicateWaitMs : 1000;
      let waited = 0;   // pauses for "duplicate query" do not make a mirror count as slow
      const ask = k => fetchOne(ep, queryVariant(q, k), fetchOpts(ctl)).catch(e => {
        // "duplicate query": the mirror is fine, it still holds our own earlier copy; wait a little and ask it again
        if (e && e.duplicate && k < 6 && !(ctl && ctl.signal.aborted)) { if (log) log('overpass ' + ep + ': duplicate query, asking again (slightly changed) in ' + (dupWait / 1000) + ' s'); waited += dupWait; return sleep(dupWait).then(() => ask(k + 1)); }
        throw e;
      });
      const promise = Promise.resolve()
        .then(() => ask(0))
        .then(r => { if (overpassBad(r)) throw new Error(badMsg(r)); return { ok: true, r, ep, ms: Date.now() - t1 - waited }; })
        .catch(e => ({ ok: false, e, ep }));
      pending.push({ ep, ctl, promise });
    };

    startNext();
    while (pending.length) {
      const ev = await Promise.race([
        sleep(staggerMs).then(() => ({ tick: true })),
        ...pending.map(p => p.promise.then(res => ({ res, p })))
      ]);
      if (ev.tick) { startNext(); continue; }
      const i = pending.indexOf(ev.p);
      if (i >= 0) pending.splice(i, 1);
      if (ev.res.ok) {
        pending.forEach(x => { try { if (x.ctl) x.ctl.abort(); } catch (e) {} });
        o._overpassSticky = ev.res.ms <= fastMs ? ev.res.ep : null;
        if (log && ev.res.ms > fastMs) log('overpass ' + ev.res.ep + ' answered but slowly (' + Math.round(ev.res.ms / 1000) + ' s): not sticking to it');
        return ev.res.r;
      }
      lastErr = ev.res.e;
      if (/^offline/.test(ev.res.e && ev.res.e.message)) throw ev.res.e;
      if (log) log('overpass ' + ev.res.ep + ': ' + ev.res.e.message);
      overpassMarkCool(o, ev.res.ep, ev.res.e);
      startNext();
    }
    throw lastErr || new Error('Overpass failed');
  }

  function overpassGap(o) {
    const ms = o.overpassGapMs != null ? o.overpassGapMs : (o.overpassPauseMs != null ? o.overpassPauseMs : 400);
    return sleep(ms);
  }

  const IGNORE_HW = new Set(['footway', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor', 'proposed', 'construction', 'elevator', 'platform', 'bus_stop', 'raceway', 'abandoned', 'razed', 'via_ferrata', 'escape', 'emergency_bay', 'rest_area', 'services']);
  const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'chipseal', 'metal']);
  /** what a roadbook draws: tarmac (double line), gravel (thick), track (single), twotrack (dashed), path (dotted thin) */
  function trackClass(t) {
    if (!t || !t.highway) return 'offpiste';
    const hw = t.highway, sf = t.surface;
    if (hw === 'path') return 'path';
    if (sf === 'sand') return 'sand';
    if (sf && PAVED.has(sf)) return 'tarmac';
    if (hw === 'track') return (t.tracktype === 'grade4' || t.tracktype === 'grade5') ? 'twotrack' : (t.tracktype === 'grade1' ? 'gravel' : 'track');
    if (sf) return 'gravel';
    if (/^(motorway|trunk)(_link)?$/.test(hw) && t.oneway === 'yes' && !/_link$/.test(hw)) return 'dual';
    if (/^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(hw) || hw === 'residential' || hw === 'living_street') return 'tarmac';
    return 'gravel';
  }
  const CLASS_WORD = { dual: 'dual carriageway', tarmac: 'tarmac', gravel: 'gravel road', track: 'track', twotrack: 'two-track', sand: 'sand track', path: 'path', offpiste: 'off-piste' };
  // highway classes BeamNG.Earth does not build (roads.py STYLE): driving one in the game is driving the bare ground
  const NOT_BUILT_HW = /^(path|footway|bridleway|cycleway|steps|pedestrian|corridor|via_ferrata)$/;
  /** BeamNG.Earth grading.py: how wide (m, gaussian sigma) the game smooths the ground under this way; 0 = not built */
  function gradeSigma(t) {
    const hw = (t && t.highway || '').replace('_link', '');
    if (!hw || NOT_BUILT_HW.test(hw)) return 0;
    const sf = t.surface, unpaved = sf ? !PAVED.has(sf) : hw === 'track';
    if (hw === 'track' || (unpaved && /^(unclassified|service|residential|living_street|road)$/.test(hw))) return 6;   // + 10 m median: tracks keep their small real bumps
    if (unpaved) return 8;
    return { motorway: 40, trunk: 40, primary: 40, secondary: 25, tertiary: 20, unclassified: 16, residential: 14 }[hw] || 12;
  }
  const ROAD_RANK = { motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5, unclassified: 4, residential: 3, track: 2, service: 1, path: 0 };

  /** OSM features along the route: junctions (with tulips), crossings, point hazards, surface changes, villages. */
  function analyseOsm(S, osm, o, isZone) {
    const F = [], step = o.step, N = S.length;
    const P = projector(S[0].lat), q = S.map(s => P.xy([s.lat, s.lon]));
    // grid index over route segments for "nearest route point" and crossings
    const G = 200, grid = new Map();
    const gk = (x, y) => Math.floor(x / G) + ',' + Math.floor(y / G);
    for (let i = 0; i + 1 < N; i++) {
      const x0 = Math.min(q[i][0], q[i + 1][0]), x1 = Math.max(q[i][0], q[i + 1][0]), y0 = Math.min(q[i][1], q[i + 1][1]), y1 = Math.max(q[i][1], q[i + 1][1]);
      for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G); gy++) {
        const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
    }
    function nearest(p, maxD) { // -> {i (segment), t, d, km}
      const [x, y] = p; let best = null;
      const r = Math.ceil(maxD / G);
      for (let gx = Math.floor(x / G) - r; gx <= Math.floor(x / G) + r; gx++) for (let gy = Math.floor(y / G) - r; gy <= Math.floor(y / G) + r; gy++) {
        for (const i of (grid.get(gx + ',' + gy) || [])) { const [d, t] = distToSeg(p, q[i], q[i + 1]); if (d <= maxD && (!best || d < best.d)) best = { i, t, d }; }
      }
      if (best) { best.km = S[best.i].km + (S[best.i + 1].km - S[best.i].km) * best.t; best.si = best.t < 0.5 ? best.i : best.i + 1; }
      return best;
    }
    const ways = osm.elements.filter(e => e.type === 'way' && e.geometry && e.tags);
    const roads = ways.filter(w => w.tags.highway && !IGNORE_HW.has(w.tags.highway) && !(w.tags.highway === 'service' && /driveway|parking_aisle|drive-through/.test(w.tags.service || '')) && w.tags.area !== 'yes');
    // which road the route is on at each sample (nearest road within 20 m, preferring one that runs the same way)
    const onWay = new Array(N).fill(null), onFit = new Array(N).fill(null);   // onFit: {d, al} of the raw match (bridges need a close, aligned one)
    { const wgrid = new Map();
      roads.forEach((w, wi) => w.geometry.forEach((g, k) => { if (k === 0) return; const a = P.xy([w.geometry[k - 1].lat, w.geometry[k - 1].lon]), b = P.xy([g.lat, g.lon]);
        for (const c of new Set([gk(a[0], a[1]), gk(b[0], b[1]), gk((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)])) { if (!wgrid.has(c)) wgrid.set(c, []); wgrid.get(c).push([wi, a, b]); } }));
      for (let i = 0; i < N; i++) {
        if (S[i].mode === 'direct') continue;
        let best = null;
        const [x, y] = q[i];
        for (let gx = Math.floor(x / G) - 1; gx <= Math.floor(x / G) + 1; gx++) for (let gy = Math.floor(y / G) - 1; gy <= Math.floor(y / G) + 1; gy++) for (const [wi, a, b] of (wgrid.get(gx + ',' + gy) || [])) {
          const [d] = distToSeg(q[i], a, b); if (d > 20) continue;
          const sb = (deg(Math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360, al = Math.abs(rel(S[i].hdg, sb));
          const cost = d + (Math.min(al, 180 - al) > 30 ? 25 : 0);
          if (!best || cost < best.c) best = { c: cost, wi, d, al: Math.min(al, 180 - al) };
        }
        onWay[i] = best ? roads[best.wi] : null;
        if (best) onFit[i] = { w: roads[best.wi], d: best.d, al: best.al };
      }
      // mode filter (+-3 samples) so one stray match does not flip the surface
      const raw = onWay.slice();
      for (let i = 0; i < N; i++) { const cnt = new Map(); for (let j = Math.max(0, i - 3); j <= Math.min(N - 1, i + 3); j++) if (raw[j]) cnt.set(raw[j], (cnt.get(raw[j]) || 0) + 1); let bw = raw[i], bc = 0; for (const [w, c] of cnt) if (c > bc) { bc = c; bw = w; } if (raw[i] || bc >= 4) onWay[i] = bw; }
    }
    // ---- junctions: nodes shared by two or more roads, on the route
    const nodeUse = new Map(); // node id -> [[way, pos]]
    for (const w of roads) (w.nodes || []).forEach((nid, k) => { if (!nodeUse.has(nid)) nodeUse.set(nid, []); nodeUse.get(nid).push([w, k]); });
    const branchDir = (w, k, dir) => { // bearing leaving node k of way w towards dir (+1/-1), measured ~40 m out
      const g0 = w.geometry[k]; let j = k + dir, d = 0, last = g0;
      while (j >= 0 && j < w.geometry.length) { const g = w.geometry[j]; d += dist([last.lat, last.lon], [g.lat, g.lon]); last = g; if (d >= 40) break; j += dir; }
      if (last === g0) return null;
      return bearing([g0.lat, g0.lon], [last.lat, last.lon]);
    };
    const junctions = [];
    for (const [nid, uses] of nodeUse) {
      const ends = uses.reduce((n, [w, k]) => n + ((k === 0 || k === (w.nodes || []).length - 1) ? 1 : 2), 0);
      if (ends < 3) continue;                                              // just a way split, not a junction
      const g = uses[0][0].geometry[uses[0][1]];
      const m = nearest(P.xy([g.lat, g.lon]), 18);
      if (!m || S[m.si].mode === 'direct') continue;
      const branches = [];
      for (const [w, k] of uses) for (const dir of [-1, 1]) { const b = branchDir(w, k, dir); if (b !== null) branches.push({ brg: b, tags: w.tags, way: w.id }); }
      junctions.push({ nid, lat: g.lat, lon: g.lon, m, branches });
    }
    junctions.sort((a, b) => a.m.km - b.m.km);
    // cluster junctions closer than 30 m (a dual carriageway, a tiny triangle) into one
    const clusters = [];
    for (const j of junctions) { const c = clusters[clusters.length - 1]; if (c && (j.m.km - c[0].m.km) * 1000 < 30) c.push(j); else clusters.push([j]); }
    for (const c of clusters) {
      const j = c.reduce((a, b) => b.branches.length > a.branches.length ? b : a);
      const si = j.m.si;
      const capIn = capAround(S, si, true, step), capOut = capAround(S, si, false, step);
      const back = (capIn + 180) % 360;
      let entry = null, exit = null; const side = [];
      for (const b of c.flatMap(x => x.branches)) {
        const dBack = Math.abs(rel(back, b.brg)), dOut = Math.abs(rel(capOut, b.brg));
        if (dBack < 35 && (!entry || dBack < entry.d)) { if (entry) side.push(entry.b); entry = { b, d: dBack }; continue; }
        if (dOut < 35 && (!exit || dOut < exit.d)) { if (exit) side.push(exit.b); exit = { b, d: dOut }; continue; }
        side.push(b);
      }
      const inTags = entry ? entry.b.tags : (onWay[Math.max(0, si - 3)] || {}).tags, outTags = exit ? exit.b.tags : (onWay[Math.min(N - 1, si + 3)] || {}).tags;
      // town noise: the other carriageway of the same road, slip lanes, service roads off a paved road
      const routeHw = (outTags && outTags.highway) || (inTags && inTags.highway) || '';
      const routeRank = ROAD_RANK[routeHw.replace('_link', '')] || 0, paved = routeRank >= (ROAD_RANK.unclassified || 4);
      const same = (t, r) => !!(r && ((t.ref && t.ref === r.ref) || (t.name && t.name === r.name)));
      const sides = [];
      for (const b of side) {
        const a = rel(capIn, b.brg), hw = b.tags.highway || '';
        // the other carriageway of the road we arrive on / leave on (not a fork where that road goes on and we turn off)
        if ((Math.abs(a) > 150 && same(b.tags, inTags)) || (Math.abs(rel(capOut, b.brg)) < 30 && same(b.tags, outTags))) continue;
        // an unnamed other carriageway: the same class of road running (almost) parallel, ahead or behind
        const base = h => (h || '').replace('_link', '');
        if (base(hw) === base(routeHw) && (Math.abs(rel(capOut, b.brg)) < 15 || Math.abs(a) > 165) && (b.tags.oneway === 'yes' || b.tags.oneway === '-1' || (inTags && inTags.oneway === 'yes') || (outTags && outTags.oneway === 'yes'))) continue;
        if (/_link$/.test(hw) && !/_link$/.test(routeHw)) continue;                          // slip lane
        if (paved && /^(service|living_street|pedestrian)$/.test(hw)) continue;               // car parks, yards, alleys
        if (!sides.some(s => Math.abs(s.angle - a) < 12)) sides.push({ angle: Math.round(a), track: trackClass(b.tags), highway: hw, name: b.tags.name || b.tags.ref || null });
      }
      if (!sides.length) continue;
      const relExit = rel(capIn, capOut);
      const near = sides.filter(s => Math.abs(s.angle - relExit) < 50);
      let instr, danger = 0;
      if (near.length) instr = near.every(s => s.angle < relExit) ? 'KEEP RIGHT' : near.every(s => s.angle > relExit) ? 'KEEP LEFT' : 'KEEP MIDDLE';
      else if (Math.abs(relExit) <= 25) instr = sides.some(s => s.angle < 0) && sides.some(s => s.angle > 0) ? 'STRAIGHT ON (crossroads)' : 'STRAIGHT ON';
      else { instr = (relExit < 0 ? 'TURN LEFT' : 'TURN RIGHT'); if (Math.abs(relExit) >= 110) { instr = 'SHARP ' + instr.slice(5); danger = 1; } }
      if (isZone(si) && o.junctionsInSpeedZones === 'turns' && /^STRAIGHT/.test(instr)) continue;
      // on a main road, carrying on past town streets is not a roadbook note (only turns and real side roads are)
      const minorSide = sd => /^(residential|service|living_street|pedestrian)$/.test(sd.highway) || (sd.highway === 'unclassified' && sd.track === 'tarmac');
      const ahead = Math.abs(relExit) <= 25 || /^KEEP/.test(instr);
      if (ahead && routeRank >= (ROAD_RANK.tertiary || 5) && sides.every(minorSide)) continue;
      const outName = outTags && (outTags.ref || outTags.name);
      // is this a real choice (a place a crew could go wrong)? a turn, a fork (a side road within 50 degrees of the way
      // on), or carrying straight on while a bigger road leaves. Straight on past smaller / crossing roads is not:
      // it can still get a box where nothing else happens for a while, but it is pruned and merged like any note.
      const rk = sd => (ROAD_RANK[(sd.highway || '').replace('_link', '')] || 0);
      const exitRank = ROAD_RANK[((outTags && outTags.highway) || '').replace('_link', '')] || 0;
      // following the same road round a bend past smaller streets is not a choice either (Merzouga: RP7111 through town)
      const sameRoad = !!(inTags && outTags && (inTags === outTags || same(inTags, outTags)));
      const followRoad = sameRoad && Math.abs(relExit) <= 60 && !near.length && sides.every(sd => rk(sd) < exitRank);
      const choice = !followRoad && (!ahead || /^KEEP/.test(instr) || sides.some(sd => rk(sd) > exitRank && Math.abs(sd.angle) < 60));
      // the same "carry on" on the same road again within 300 m: once is enough
      const prevJ = F.filter(f => f.kind === 'junction').pop();
      if (ahead && prevJ && prevJ.outName && prevJ.outName === (outName || null) && /^(STRAIGHT|KEEP)/.test(prevJ.instr) && (S[si].km - S[prevJ.i].km) < 0.3) continue;
      F.push({ i: si, kind: 'junction', lat: j.lat, lon: j.lon, instr, danger, outName: outName || null, choice,
        tulip: { entry: { track: trackClass(inTags) }, exit: { angle: Math.round(relExit), track: trackClass(outTags) }, branches: sides.sort((a, b) => a.angle - b.angle) } });
    }
    // 0.4.0: a bridge only where the route really is on it: the raw match is that way, close (12 m) and running the same
    // way (30 deg), and the way is one the game builds (paths, footways, bridleways are not built, so neither are their
    // bridges). Before, an overpass the route ran under, or a footbridge beside it, could give "BRIDGE".
    function bridgeAt(i) {
      const w = onWay[i], f = onFit[i];
      if (!w || !w.tags.bridge || w.tags.bridge === 'no' || !f || f.w !== w || f.d > 12 || f.al > 30) return false;
      return !NOT_BUILT_HW.test(w.tags.highway || '');
    }
    // ---- crossings: things the route line cuts through (tracks off-piste, rivers / wadis, fences, railways)
    const crossKinds = w => {
      const t = w.tags;
      if (t.waterway && /^(river|stream|wadi|canal|drain|ditch|brook|riverbank)$/.test(t.waterway)) return 'water';
      // 0.4.0: BeamNG.Earth builds chain-link fences, walls (stone, noise) and nothing else: a field fence, hedge,
      // ditch or embankment mapped in OSM is not there in the game
      if (t.barrier && (/^(wall|city_wall|retaining_wall|noise_barrier)$/.test(t.barrier) || (t.barrier === 'fence' && /chain/.test(t.fence_type || '')))) return 'fence';
      if (t.railway && /^(rail|light_rail|narrow_gauge|disused|abandoned)$/.test(t.railway)) return 'railway';
      if (t.highway && roads.includes(w)) return 'road';
      return null;
    };
    const crossSeen = new Map();
    for (const w of ways) {
      const kind = crossKinds(w); if (!kind) continue;
      const pts = w.geometry.map(g => P.xy([g.lat, g.lon]));
      for (let k = 0; k + 1 < pts.length; k++) {
        const x0 = Math.min(pts[k][0], pts[k + 1][0]), x1 = Math.max(pts[k][0], pts[k + 1][0]), y0 = Math.min(pts[k][1], pts[k + 1][1]), y1 = Math.max(pts[k][1], pts[k + 1][1]);
        const segs = new Set();
        for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G); gy++) for (const i of (grid.get(gx + ',' + gy) || [])) segs.add(i);
        for (const i of segs) {
          const hit = segIntersect(q[i], q[i + 1], pts[k], pts[k + 1]); if (!hit) continue;
          const si = hit[0] < 0.5 ? i : i + 1, offp = S[si].mode === 'direct';
          if (kind === 'road' && !offp) continue;                  // on a track, road crossings are junctions (or bridges)
          const onBridge = bridgeAt(si);
          const xb = bearing([w.geometry[k].lat, w.geometry[k].lon], [w.geometry[k + 1].lat, w.geometry[k + 1].lon]);
          const ang = Math.round(rel(S[si].hdg, xb));
          // running alongside a line (route and way a few metres apart) makes fake crossings: need a real angle,
          // and one crossing of the same way per 300 m
          if (Math.min(Math.abs(ang), 180 - Math.abs(ang)) < 25) continue;
          const last = crossSeen.get(w.id);
          if (last !== undefined && Math.abs(S[si].km - last) < 0.3) continue;
          crossSeen.set(w.id, S[si].km);
          const oldRail = kind === 'railway' && /disused|abandoned/.test(w.tags.railway);
          F.push({ i: si, kind: 'cross_' + kind, tags: w.tags, onBridge, crossAngle: ang, track: kind === 'road' ? trackClass(w.tags) : null,
            danger: kind === 'water' ? (onBridge ? 0 : (w.tags.intermittent === 'yes' || w.tags.waterway === 'wadi' ? 1 : (w.tags.waterway === 'river' ? 2 : 1)))
              : kind === 'fence' ? (offp ? 2 : 1) : kind === 'railway' ? (oldRail ? 0 : 1) : 0, oldRail });
        }
      }
    }
    // ---- point hazards on the route
    for (const e of osm.elements) {
      if (e.type !== 'node' || !e.tags || e.tags.place) continue;
      const m = nearest(P.xy([e.lat, e.lon]), 20); if (!m) continue;
      const t = e.tags; let kind = null, danger = 1;
      if (t.ford || t.highway === 'ford') { kind = 'ford'; danger = 1; }
      // 0.4.0: cattle grids, gates, chains, bollards and blocks are not built in the game (a gate node only leaves a gap
      // in a built fence): only a border post or toll (a real stop for the crew) is kept
      else if (t.barrier === 'border_control' || t.barrier === 'toll_booth') { kind = 'gate'; danger = 2; }
      else if (t.railway === 'level_crossing') kind = 'level_crossing';
      else if (t.highway === 'stop' || t.highway === 'traffic_signals') { kind = 'stop'; }
      if (kind) F.push({ i: m.si, kind, tags: t, danger });
    }
    // ---- runs along the route way: bridges, fords, surface / track changes
    const runOf = (test) => { const r = []; for (let i = 0; i < N;) { if (!test(i)) { i++; continue; } let j = i; while (j + 1 < N && test(j + 1)) j++; r.push([i, j]); i = j + 1; } return r; };
    for (const [a, b] of runOf(i => bridgeAt(i))) if ((b - a) * step >= 10) F.push({ i: a, kind: 'bridge', len: (b - a) * step, tags: onWay[a].tags, danger: 0 });
    for (const [a] of runOf(i => onWay[i] && (onWay[i].tags.ford === 'yes' || onWay[i].tags.ford === 'stepping_stones'))) F.push({ i: a, kind: 'ford', tags: onWay[a].tags, danger: 1 });
    // rough stretches the mappers flagged (smoothness=bad and worse), at least 300 m
    { const ROUGH = { bad: 1, very_bad: 2, horrible: 3, very_horrible: 4, impassable: 5 };
      for (const [a, b] of runOf(i => S[i].mode !== 'direct' && onWay[i] && ROUGH[onWay[i].tags.smoothness] && !/^(tarmac|dual)$/.test(trackClass(onWay[i].tags)))) if ((b - a) * step >= 300) {
        const sm = onWay[a].tags.smoothness; F.push({ i: a, kind: 'rough', smoothness: sm, track: trackClass(onWay[a].tags), len: (b - a) * step, danger: ROUGH[sm] >= 3 ? 1 : 0 });
      } }
    // rocky surface (surface=rock / rocky / bedrock: the game lays its ROCK ground material), at least 60 m
    for (const [a, b] of runOf(i => S[i].mode !== 'direct' && onWay[i] && /^(rock|rocky|bedrock)$/.test(onWay[i].tags.surface || ''))) if ((b - a) * step >= 60) F.push({ i: a, kind: 'rocky_track', len: (b - a) * step, track: trackClass(onWay[a].tags), danger: 1 });
    // how the game grades the way under each sample (BeamNG.Earth grading.py smoothing width, m; 0 = not built)
    F.grade = onWay.map((w, i) => S[i].mode === 'direct' || !w ? 0 : gradeSigma(w.tags));
    // waterways (OSM ways in the route query: within ~50 m) for FOLLOW WADI / ALONG RIVER
    F.waterways = ways.filter(w => /^(river|stream|wadi|canal)$/.test(w.tags.waterway || ''));
    { const cls = onWay.map((w, i) => S[i].mode === 'direct' ? 'offpiste' : w ? trackClass(w.tags) : null);
      // fill unknown (no OSM match) with the previous class
      for (let i = 1; i < N; i++) if (cls[i] === null) cls[i] = cls[i - 1];
      let cur = cls[0], i = 0; const minRun = Math.round(400 / step);
      while (i < N) {
        let j = i; while (j + 1 < N && cls[j + 1] === cls[i]) j++;
        if (cls[i] && cls[i] !== cur && (j - i + 1 >= minRun || cls[i] === 'offpiste' || cur === 'offpiste')) {
          if (cur !== null) F.push({ i, kind: cls[i] === 'offpiste' ? 'leave_track' : cur === 'offpiste' ? 'join_track' : 'surface', from: cur, to: cls[i], danger: 0 });
          cur = cls[i];
        }
        i = j + 1;
      }
      F.trackClass = cls;
    }
    // 0.4.0: "BRIDGE, BRIDGE OVER OUED ZGUID": the bridge run and the river under it are one thing, said once
    { const over = F.filter(f => f.kind === 'cross_water' && f.onBridge);
      for (let k = F.length - 1; k >= 0; k--) { const f = F[k]; if (f.kind === 'bridge' && over.some(w => S[w.i].d >= S[f.i].d - 20 && S[w.i].d <= S[f.i].d + (f.len || 0) + 20)) F.splice(k, 1); } }
    // ---- villages and towns near the route
    for (const e of osm.elements) {
      if (e.type !== 'node' || !e.tags || !e.tags.place || !/^(city|town|village|hamlet)$/.test(e.tags.place)) continue;
      const m = nearest(P.xy([e.lat, e.lon]), o.placeRadius); if (!m) continue;
      const big = e.tags.place === 'city' || e.tags.place === 'town';
      const sideAng = rel(S[m.si].hdg, bearing([S[m.si].lat, S[m.si].lon], [e.lat, e.lon]));
      F.push({ i: m.si, kind: 'village', name: e.tags.name || e.tags.place, place: e.tags.place, off: Math.round(m.d), side: sideAng < 0 ? 'L' : 'R', zone: isZone(m.si), danger: isZone(m.si) ? 0 : (m.d < 300 ? (big ? 2 : 1) : 0) });
    }
    return F;
  }

  // ------------------------------------------------------------------ notes, symbols, priorities
  const pct = x => Math.round(x) + '%';
  function describe(f) {
    const pctS = g => Math.round(g) + '%';
    const lenS = m => m >= 1000 ? (m / 1000).toFixed(1) + ' KM' : Math.round(m / 10) * 10 + ' M';
    switch (f.kind) {
      case 'climb': return { sym: ['climb'], note: (f.maxGrade >= 20 ? 'STEEP CLIMB ' : 'CLIMB ') + pctS(f.maxGrade >= 20 ? f.maxGrade : f.grade) + ', ' + lenS(f.len), pr: 30 };
      case 'descent': return { sym: ['descent'], note: (f.maxGrade >= 15 ? 'STEEP DESC. ' : 'DESC. ') + pctS(f.maxGrade >= 15 ? f.maxGrade : f.grade) + ', ' + lenS(f.len), pr: 35 };
      case 'crest': return { sym: ['crest'], note: f.blind ? 'BLIND CREST' : 'CREST', pr: 30 + f.danger * 10 };
      case 'jump': return { sym: ['jump'], note: 'CREST, JUMP', pr: 45 + f.danger * 5 };
      case 'dip': return { sym: ['dip'], note: 'DIP', pr: 25 + f.danger * 10 };
      case 'compression': return { sym: ['compression'], note: 'COMPRESSION', pr: 30 + f.danger * 10 };
      case 'wadi': return { sym: ['wadi'], note: 'WADI ' + Math.round(f.depth) + ' M DEEP', pr: 40 + f.danger * 10 };
      case 'dunes': return { sym: ['dunes'], note: 'DNX ' + f.lenKm + ' KM ' + ({ small: 'L1', medium: 'L2', big: 'L3' }[f.size]) + ' (~' + f.amp + ' M)', pr: 70 };
      case 'steep_face': return { sym: ['dunes', 'climb'], note: 'STEEP FACE ' + Math.round(f.grade) + '%, ' + (f.len >= 1000 ? (f.len / 1000).toFixed(1) + ' KM' : Math.round(f.len / 10) * 10 + ' M'), pr: 75 };
      case 'steep_drop': return { sym: ['dunes', 'descent'], note: 'STEEP DROP ' + Math.round(f.grade) + '%, ' + (f.len >= 1000 ? (f.len / 1000).toFixed(1) + ' KM' : Math.round(f.len / 10) * 10 + ' M'), pr: 80 };
      case 'cordon': return { sym: ['dunes', 'ridge'], note: 'CROSS CORDON' + (f.relief ? ' ' + f.relief + ' M' : ''), pr: 72 };
      case 'rough': return { sym: [f.danger ? 'ruts' : 'broken'], note: 'BAD ' + (TRACK_CODE[f.track] || 'P') + ' ' + lenS(f.len) + (f.danger ? ', 4x4' : ''), pr: 42 };
      case 'bump': return { sym: ['bump'], note: 'BUMP' + (f.danger ? ' !' : ''), pr: 32 + f.danger * 6 };
      case 'ditch': return { sym: ['ditch'], note: 'DITCH' + (f.danger ? ' !' : ''), pr: 40 + f.danger * 6 };
      case 'step_up': return { sym: ['step_up'], note: 'STEP UP ' + f.height + ' M', pr: 38 };
      case 'step_down': return { sym: ['step_down'], note: 'STEP DOWN ' + f.height + ' M', pr: 45 };
      case 'landmark_cross': return { sym: ['electric_line'], note: 'UNDER POWER LINE', pr: 55 };
      case 'landmark_pass': return { sym: [f.sym], note: f.text, pr: 18 + 3 * f.prom };
      case 'cover': { const t = COVER_TEXT[f.to]; return t ? { sym: [t[0]], note: (f.to === 'bush' || f.to === 'grass' ? 'VG: ' : 'IN ') + t[1], pr: 22 } : { sym: [], note: 'END VG', pr: 18 }; }
      case 'dunes_end': return { sym: ['dunes_end'], note: 'END DUNES', pr: 50 };
      case 'sideslope': return { sym: ['sideslope_' + f.side.toLowerCase()], note: 'SIDE SLOPE ' + pctS(f.grade) + ', DROPS ' + f.side, pr: 35 };
      case 'ridge': return { sym: ['ridge'], note: f.onWay ? 'ON RIDGE ' + lenS(f.len) : 'ON RIDGE, DROPS BOTH SIDES', pr: 30 };
      case 'valley': return { sym: ['valley'], note: 'FOLLOW VALLEY ' + lenS(f.len), pr: 26 };
      case 'terrain': return { sym: [f.terrain], note: { flat: 'FLAT, FAST', rolling: 'ROLLING', broken: 'BROKEN, SLOW' }[f.terrain], pr: 20 };
      case 'junction': return { sym: /^KEEP LEFT/.test(f.instr) ? ['junction', 'keep_left'] : /^KEEP RIGHT/.test(f.instr) ? ['junction', 'keep_right'] : ['junction'], note: junctionNote(f), pr: f.choice === false ? 35 : 80 };
      case 'cross_water': {
        const t = f.tags, nm = latinName(t), dry = t.intermittent === 'yes' || t.waterway === 'wadi';
        const what = dry ? 'WADI' : ({ river: 'RIVER', canal: 'CANAL' }[t.waterway] || 'STREAM');
        return f.onBridge ? { sym: ['bridge'], note: 'BRIDGE OVER ' + (nm || what), pr: 46 } : { sym: [dry ? 'wadi' : 'ford'], note: 'CROSS ' + what + (nm ? ' (' + nm + ')' : ''), pr: 60 };
      }
      case 'cross_fence': return { sym: [f.tags.barrier === 'wall' ? 'wall' : /barbed/.test(f.tags.fence_type || '') ? 'barbed_wire' : 'fence'], note: (f.tags.barrier === 'wall' ? 'WALL' : 'FENCE') + ', FIND GAP', pr: 65 };
      case 'cross_railway': return f.oldRail ? { sym: ['railway'], note: 'CROSS OLD RAILWAY', pr: 40 } : { sym: ['railway'], note: 'CROSS RAILWAY !', pr: 65 };
      case 'cross_road': { const nm = roadName(f.tags); return { sym: ['cross_track'], note: 'CROSS ' + TRACK_CODE[f.track] + (nm ? ' (' + nm + ')' : ''), pr: 70 }; }
      case 'ford': return { sym: ['ford'], note: 'FORD', pr: 75 };
      case 'gate': return { sym: ['gate'], note: ({ border_control: 'BORDER POST', toll_booth: 'TOLL' }[f.tags.barrier]) || 'GATE', pr: 75 };
      case 'cattle_grid': return { sym: ['cattle_grid'], note: 'CATTLE GRID', pr: 70 };
      case 'level_crossing': return { sym: ['railway'], note: 'LEVEL CROSSING !', pr: 70 };
      case 'stop': return { sym: ['stop'], note: f.tags.highway === 'stop' ? 'STOP' : 'TRAFFIC LIGHTS', pr: 65 };
      case 'bridge': return { sym: ['bridge'], note: 'BRIDGE' + (f.len > 60 ? ' ' + Math.round(f.len / 10) * 10 + ' M' : ''), pr: 45 };
      case 'surface': { const tr = TRACK_CODE[f.to] === 'TRACES', fromTr = TRACK_CODE[f.from] === 'TRACES';
        if (tr && fromTr) return { sym: [], note: 'FOLLOW TRACES', pr: 12 };
        return { sym: ['surface'], note: 'END ' + TRACK_CODE[f.from] + ', ' + (tr ? 'FOLLOW TRACES' : TRACK_CODE[f.to]), pr: 40 }; }
      case 'rocky_track': return { sym: ['rocks'], note: 'ROCKY ' + (TRACK_CODE[f.track] || 'P') + ' ' + lenS(f.len), pr: 48 };
      case 'rocks': return { sym: ['rocks'], note: f.level >= 3 ? 'ROCK, STEEP !' : f.level === 2 ? 'ROCKY, SLOW !' : f.edges ? 'ROCKS BOTH SIDES' : f.vg ? 'STONES IN VG' : 'STONY', pr: f.level >= 3 ? 56 : f.level === 2 ? 44 : f.edges ? 26 : 34 };
      case 'along_water': { const nm = f.name ? ' (' + f.name + ')' : '';
        return { sym: [f.dry ? 'wadi' : 'water'], note: (f.dry ? (f.inBed ? 'IN WADI BED' : 'FOLLOW WADI') : 'ALONG ' + f.what + ' on' + f.side) + nm + ' ' + lenS(f.len), pr: 36 }; }
      case 'leave_track': return { sym: ['offpiste'], note: 'QT ' + TRACK_CODE[f.from] + ', HP', pr: 70 };
      case 'join_track': return { sym: ['join_track'], note: 'RP ' + TRACK_CODE[f.to], pr: 70 };
      case 'village': { const nm = latinPart(f.name) || 'VILLAGE'; return { sym: ['village'], note: f.off < 300 ? 'THROUGH ' + nm + (f.zone ? '' : ', SLOW') : nm + ' ' + (f.off / 1000).toFixed(1) + ' KM on' + f.side, pr: 45 }; }
      case 'undulations': return { sym: ['undulations'], note: 'SUCC. CRESTS ' + lenS(f.len) + (f.blind ? ', BLIND' : ''), pr: 40 + f.danger * 10 };
      case 'bend': return { sym: [Math.abs(f.turn) >= 135 ? 'hairpin' : f.twisty ? 'twisty' : 'bend'], note: (Math.abs(f.turn) >= 135 ? 'HAIRPIN ' : f.twisty ? 'TWISTY, SHARP ' : 'SHARP ') + (f.turn < 0 ? 'L' : 'R'), pr: 40 };
      case 'cap': { const t = Math.abs(rel(f.from, f.to));
        if (f.follow) {   // 0.5.0: "CAP 140, FOLLOW VALLEY FLOOR 2.1 KM, GENERAL CAP 152"
          const g = f.followCap != null && Math.abs(rel(f.to, f.followCap)) >= 10 ? ', GENERAL CAP ' + pad3(f.followCap) : '';
          return { sym: f.obstacle ? ['cap', obstSym(f.obstacle)] : (/dune/.test(f.follow) ? ['cap', 'dunes'] : ['cap']),
            note: capLabel(f.to, f.offPiste || f.capType === 'C') + ', ' + capReason(f.follow) + (f.followKm >= 0.5 ? ' ' + f.followKm.toFixed(1) + ' KM' : '') + g + (f.reason ? ', ' + capReason(f.reason) : ''),
            pr: 28 + Math.min(45, t * 0.9) };
        }
        return { sym: f.obstacle ? ['cap', obstSym(f.obstacle)] : (f.reason && /dune/.test(f.reason) ? ['cap', 'dunes'] : ['cap']), note: capLabel(f.to, f.offPiste || f.capType === 'C') + (f.reason ? ', ' + capReason(f.reason) : ''),
        pr: 20 + Math.min(45, t * 0.9) + (f.reason ? 8 : 0) - (f.fabricated ? 8 : 0) }; }
      case 'follow': return { sym: /dune/.test(f.follow) ? ['dunes'] : [], note: capReason(f.follow) + (f.followKm >= 0.5 ? ' ' + f.followKm.toFixed(1) + ' KM' : '') + ', GENERAL CAP ' + pad3(f.followCap), pr: 50 };
      default: return { sym: [], note: String(f.kind).toUpperCase(), pr: 10 };
    }
  }
  // names in Latin script only (a crew cannot match Arabic / Tifinagh / Cyrillic / Mongolian to a sign quickly)
  const LATIN = /^[\x20-\u024f\u1e00-\u1eff]+$/;
  function latinName(t) { if (!t) return null; for (const k of ['name:en', 'int_name', 'name:latin', 'name:fr', 'name']) { const v = t[k]; if (v && LATIN.test(v)) return String(v).toUpperCase().slice(0, 28); } const lp = latinPart(t.name); return lp; }
  function roadName(t) { if (!t) return null; if (t.ref && LATIN.test(t.ref)) return String(t.ref).toUpperCase(); return latinName(t); }
  /** the Latin-script part of a mixed name ("Hassilabied ⵃⴰⵙⵉ حاسي" -> "HASSILABIED"), or null */
  function latinPart(n) { if (!n) return null; const v = String(n).replace(/[^\x20-\u024f\u1e00-\u1eff]+/g, ' ').replace(/[()\/:,;-]\s*$/, '').replace(/\s+/g, ' ').trim(); return v.length >= 2 && /[A-Za-z]/.test(v) ? v.toUpperCase().slice(0, 28) : null; }
  /** the planner's reason for a CAP change, as roadbook shorthand ("follow interdune corridor left" -> "FOLLOW CORRIDOR L") */
  function capReason(r) {
    return String(r).toUpperCase().replace(/\bLEFT\b/g, 'L').replace(/\bRIGHT\b/g, 'R').replace('INTERDUNE ', '').replace('AVOID STEEP GROUND', 'AVOID STEEP').replace('AVOID STEEP SLOPE', 'AVOID STEEP')
      .replace('ALONG FENCE TO A GAP,', 'ALONG FENCE TO GAP').replace('GO ROUND HIGH GROUND', 'ROUND HIGH GROUND').replace(/ +/g, ' ').trim();
  }
  // FIM roadbook shorthand for the kind of way (docs/ROADBOOK_FORMAT.md, abbreviations)
  // 0.4.0: a grade 4/5 track or a path (not a real piste; the game does not even build a path) is "TRACES" everywhere:
  // "FOLLOW TRACES", "TURN R ON TRACES", "END P, FOLLOW TRACES", "RP TRACES"
  const TRACK_CODE = { dual: 'RO', tarmac: 'RO', gravel: 'PP', track: 'P', twotrack: 'TRACES', sand: 'P SA', path: 'TRACES', offpiste: 'HP' };
  const TRACK_RANK = { dual: 6, tarmac: 5, gravel: 4, track: 3, sand: 3, twotrack: 2, path: 1, offpiste: 0 };
  /** "kpL FPP", "TURN R on P (D23)", "kpS, crossroads, FRO" */
  function junctionNote(f) {
    const out = f.tulip && f.tulip.exit && f.tulip.exit.track, sides = (f.tulip && f.tulip.branches) || [];
    const instr = f.instr.replace(/^KEEP LEFT/, 'kpL').replace(/^KEEP RIGHT/, 'kpR').replace(/^KEEP MIDDLE/, 'KEEP MIDDLE').replace(/^STRAIGHT ON \(crossroads\)/, 'X-ROADS kpS').replace(/^STRAIGHT ON/, 'kpS').replace(/^TURN LEFT/, 'TURN L').replace(/^TURN RIGHT/, 'TURN R').replace(/^SHARP LEFT/, 'SHARP L').replace(/^SHARP RIGHT/, 'SHARP R');
    const nm = f.outName && LATIN.test(f.outName) ? String(f.outName).toUpperCase().slice(0, 28) : null;
    if (!out || !TRACK_CODE[out]) return instr + (nm ? ' ON ' + nm : '');
    const main = /(kp|KEEP)/.test(instr) && sides.every(b => (TRACK_RANK[b.track] || 0) <= TRACK_RANK[out]) && TRACK_RANK[out] >= 4;
    return instr + ' ' + (main ? (TRACK_RANK[out] >= 5 ? 'FRO' : 'FPP') : 'ON ' + TRACK_CODE[out]) + (nm ? ' (' + nm + ')' : '');
  }
  const obstSym = ob => ({ buildings: 'buildings', trees: 'trees', water: 'water', wetland: 'water', fence: 'fence', cliff: 'cliff', scrub: 'vegetation', 'restricted area': 'danger' })[ob] || 'danger';
  const cap1 = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const pad3 = c => String(n360(c)).padStart(3, '0');

  // ------------------------------------------------------------------ assembling the roadbook
  /** sha-256 hex of the parts of a stage a roadbook depends on (waypoints and route), so a reader can tell it is stale */
  async function stageHash(stage) {
    const core = JSON.stringify({
      w: stage.waypoints.map(w => [w.id, w.type, +(+w.lat).toFixed(6), +(+w.lon).toFixed(6)]),
      r: ((stage.route && stage.route.legs) || []).map(l => [l.from, l.to, l.mode, l.points.map(p => [+(+p[0]).toFixed(6), +(+p[1]).toFixed(6)])])
    });
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : require('crypto').webcrypto.subtle;
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(core));
    return 'sha256:' + Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Build the roadbook from samples + features (pure; generate() does the fetching). Returns {boxes, stats}.
   */
  function assemble(stage, S, features, o) {
    const step = o.step, N = S.length;
    const wps = stage.waypoints || [];
    // waypoint boxes: each waypoint at its own km (or the nearest route sample)
    const anchors = [];
    for (const w of wps) {
      let si;
      if (typeof w.km === 'number') si = sampleAtKm(S, w.km);
      else { let bd = 1e18; S.forEach((s, i) => { const d = dist([s.lat, s.lon], [w.lat, w.lon]); if (d < bd) { bd = d; si = i; } }); }
      anchors.push({ si, wp: w });
    }
    // speed zones (DZ .. FZ) by sample range
    const zones = []; let dz = null;
    for (const a of anchors) { if (a.wp.type === 'DZ') dz = a; else if (a.wp.type === 'FZ' && dz) { zones.push([dz.si, a.si, dz.wp.speedLimit]); dz = null; } }
    const isZone = i => zones.some(([a, b]) => i >= a && i <= b);

    // features -> candidate items
    const items = features.map(f => { const d = describe(f); return { si: Math.max(0, Math.min(N - 1, f.i)), f, sym: d.sym, note: d.note, pr: d.pr + (f.danger || 0) * 8, danger: f.danger || 0 }; });
    items.sort((a, b) => S[a.si].km - S[b.si].km || b.pr - a.pr);

    const boxes = anchors.map(a => ({ si: a.si, wp: a.wp, items: [], pr: 1000 }));
    // attach items to a waypoint box when close, else cluster
    const free = [];
    for (const it of items) {
      const wb = boxes.find(b => Math.abs(S[b.si].km - S[it.si].km) * 1000 <= o.mergeM);
      if (wb && it.f.kind !== 'dunes_end') wb.items.push(it); else free.push(it);
    }
    const clusters = [];
    for (const it of free) {
      const c = clusters[clusters.length - 1];
      if (c && (S[it.si].km - S[c.items[0].si].km) * 1000 <= o.mergeM && !(it.f.kind === 'dunes_end' || c.items[0].f.kind === 'dunes_end')) c.items.push(it);
      else clusters.push({ items: [it] });
    }
    for (const c of clusters) {
      c.items.sort((a, b) => b.pr - a.pr);
      const lead = c.items.find(x => x.f.kind === 'junction') || c.items[0];
      boxes.push({ si: lead.si, items: c.items, pr: Math.max(...c.items.map(x => x.pr)) });
    }
    boxes.sort((a, b) => S[a.si].km - S[b.si].km || (b.wp ? 1 : 0) - (a.wp ? 1 : 0));

    // density: rank every box by importance and prune the least important until each 10 km window (counted on and
    // off piste separately) holds at most `density` boxes. Never pruned: waypoints, danger >= 2, junctions, gates /
    // grids, leaving / joining a track, crossing a fence / track / railway, CAP changes >= capKeepTurn of the line. Then a filler box only where the gap is longer than maxGapKm.
    const offAt = i => S[i].mode === 'direct';
    const MUST = /^(junction|gate|cattle_grid|leave_track|join_track|cross_fence|cross_road|cross_railway|level_crossing)$/;
    // straight on along the biggest road past smaller side tracks: a box worth having, but not a choice to make
    const obviousJunction = f => /^STRAIGHT/.test(f.instr) && f.tulip && f.tulip.exit && TRACK_RANK[f.tulip.exit.track] >= 3 && (f.tulip.branches || []).every(b => (TRACK_RANK[b.track] || 0) < TRACK_RANK[f.tulip.exit.track]);
    const duneAt = i => !!(S[i] && S[i].inDune);
    const DUNE_KEEP = /^(dunes|dunes_end|cordon|steep_face|steep_drop)$/;
    const importance = x => {
      if (x.wp) return Infinity;
      if (x.items.some(i => DUNE_KEEP.test(i.f.kind))) return Infinity;
      const DUNE_WEAVE = /^(cap|terrain|follow|crest|dip|undulations|compression|climb|descent|sideslope|bump|ditch|step_down|step_up|rocks)$/;
      if (duneAt(x.si) && x.items.every(i => DUNE_WEAVE.test(i.f.kind) && (i.f.kind !== 'cap' || !i.f.follow))) return 5;
      if (x.items.some(i => (i.danger >= 2 && !duneAt(x.si)) || (MUST.test(i.f.kind) && !(i.f.kind === 'junction' && (obviousJunction(i.f) || i.f.choice === false))) || (i.f.kind === 'cap' && i.f.planned && Math.abs(rel(i.f.from, i.f.to)) >= o.capKeepTurn && !duneAt(x.si)))) return Infinity;   // a CAP change of the line itself: the line was thinned to the density already
      return Math.max(0, ...x.items.map(i => i.pr)) + 3 * Math.max(0, x.items.length - 1);
    };
    boxes.forEach(x => { x.imp = importance(x); });
    // minimum spacing: a crew cannot read two boxes tens of metres apart. Two boxes closer than minSpacingM
    // (fastSpacingM when both are on a tarmac / gravel road) become one: things that matter (never-prune items,
    // anything with danger) move into the first box of the pair (a waypoint's own box when one is a waypoint), so a
    // run of junctions / crossings is one box describing the way through it; the rest of the weaker box is dropped.
    // A must-keep box just before a waypoint keeps its own spot (the waypoint box cannot move back to it).
    const tcl = features.trackClass || [];
    const fastAt = i => /^(tarmac|dual|gravel)$/.test(tcl[i] || '');
    const spacing = (i0, i1) => (duneAt(i0) && duneAt(i1)) ? o.duneSpacingM : ((!offAt(i0) && !offAt(i1) && fastAt(i0) && fastAt(i1)) ? o.fastSpacingM : o.minSpacingM);
    const worth = x => x.imp === Infinity || x.items.some(i => i.danger >= 1);
    let spacingKept = 0;
    for (let a = 0; a + 1 < boxes.length;) {
      const A = boxes[a], B = boxes[a + 1];
      if ((S[B.si].km - S[A.si].km) * 1000 >= spacing(A.si, B.si) || (A.wp && B.wp)) { a++; continue; }
      if (B.wp && worth(A) && (S[B.si].km - S[A.si].km) * 1000 >= o.wpShortM) { a++; spacingKept++; continue; }
      const kindOf = x => (x.items || []).map(i => i.f && i.f.kind);
      const duneEdge = x => kindOf(x).some(k => k === 'dunes' || k === 'dunes_end');
      if (duneEdge(A) && duneEdge(B) && (S[B.si].km - S[A.si].km) * 1000 >= 200) { a++; spacingKept++; continue; }
      if (duneAt(A.si) && duneAt(B.si) && worth(A) && worth(B) && duneEdge(A) !== duneEdge(B) && (S[B.si].km - S[A.si].km) * 1000 >= 200) { a++; spacingKept++; continue; }
      let host, guest;
      if (A.wp) { host = A; guest = B; } else if (B.wp) { host = B; guest = A; }
      else if (worth(A) && worth(B)) { host = A; guest = B; }
      else if (A.imp >= B.imp) { host = A; guest = B; } else { host = B; guest = A; }
      if (worth(guest) || guest.items.some(i => i.pr >= 40)) { host.items.push(...guest.items); host.merged = (host.merged || 0) + 1 + (guest.merged || 0); }
      boxes.splice(boxes.indexOf(guest), 1);
      host.imp = importance(host); host.pr = Math.max(host.pr, guest.pr);
      if (host === B) a = Math.max(0, a - 1);
    }
    const per = Math.max(1, o.density);
    for (let guard = 0; guard < 5000; guard++) {
      let worst = null;
      for (const side of [true, false]) {
        const list = boxes.filter(x => offAt(x.si) === side);
        for (let a = 0; a < list.length && !worst; a++) {
          let b = a; while (b + 1 < list.length && S[list[b + 1].si].km - S[list[a].si].km < 10) b++;
          const duneWin = list.slice(a, b + 1).filter(x => duneAt(x.si)).length > (b - a + 1) / 2;
          if (b - a + 1 <= (duneWin ? Math.max(1, o.duneDensity) : per)) continue;
          const cand = list.slice(a, b + 1).filter(x => x.imp !== Infinity);
          if (cand.length) worst = cand.reduce((p, x) => x.imp < p.imp ? x : p);
        }
        if (worst) break;
      }
      if (!worst) break;
      boxes.splice(boxes.indexOf(worst), 1);
    }
    const maxGapOff = o.maxGapKm || Math.max(1, 40 / per), maxGapOn = o.roadFillerKm || Math.max(5, 40 / per);
    const fill = [];
    for (let a = 0; a + 1 < boxes.length; a++) {
      const i0 = boxes[a].si, i1 = boxes[a + 1].si, gap = S[i1].km - S[i0].km;
      let offN = 0; for (let i = i0; i <= i1; i++) if (offAt(i)) offN++;
      const off = offN > (i1 - i0 + 1) / 2;
      let duneN = 0; for (let i = i0; i <= i1; i++) if (duneAt(i)) duneN++;
      const maxGap = (duneN > (i1 - i0 + 1) / 2) ? o.duneMaxGapKm : (off ? maxGapOff : maxGapOn);
      if (gap <= maxGap) continue;
      const n = Math.ceil(gap / maxGap) - 1;
      for (let k = 1; k <= n; k++) { const si = sampleAtKm(S, S[i0].km + gap * k / (n + 1)); fill.push({ si, items: [], pr: 5, filler: off ? 'offpiste' : 'road' }); }
    }
    boxes.push(...fill);
    boxes.sort((a, b) => S[a.si].km - S[b.si].km || (b.wp ? 1 : 0) - (a.wp ? 1 : 0));

    // final boxes
    const tclass = features.trackClass || [], terr = features.terrainClass || [];
    const out = [];
    const used = new Map();
    const typeCount = {};
    boxes.forEach((b, n) => {
      const s = S[b.si];
      const capIn = n === 0 ? capAround(S, b.si, false, step) : capAround(S, b.si, true, step);
      // a merged box (a run of junctions / turns): the CAP is the heading leaving the last of them
      const turnSi = b.merged ? Math.max(b.si, ...b.items.filter(it => /^(junction|cap|bend|leave_track|join_track)$/.test(it.f.kind)).map(it => it.si)) : b.si;
      const capOut = turnSi >= N - 1 ? capIn : capAround(S, turnSi, false, step);
      const symbols = [], notes = [];
      let danger = 0, tulip = null, label = 'NOTE', waypoint = null;
      const lead = [];   // waypoint texts come first
      if (b.wp) {
        waypoint = b.wp.id; label = b.wp.type + (b.wp.type === 'DSS' || b.wp.type === 'ASS' ? '' : ' ' + (b.wp.n != null ? b.wp.n : ''));
        symbols.push(b.wp.type);
        if (b.wp.type === 'DZ') { lead.push('SPEED ZONE ' + (b.wp.speedLimit || '')); symbols.push('speed_' + (b.wp.speedLimit || '')); }
        if (b.wp.type === 'FZ') lead.push('END SPEED ZONE');
        if (b.wp.name) lead.push(b.wp.name);
      }
      const hasGate = b.items.some(it => it.f.kind === 'gate' || it.f.kind === 'cattle_grid');
      const its = b.items.filter(it => !(hasGate && it.f.kind === 'cross_fence'));   // the gate / grid is the way through that fence
      const atOf = it => Math.max(0, Math.round((S[it.si].km - s.km) * 1000));
      for (const it of its) { for (const sy of it.sym) if (!symbols.includes(sy)) symbols.push(sy); danger = Math.max(danger, it.danger); }
      // ---- the way through: junctions and crossings in travel order -> tulip nodes (within 25 m = one node)
      // (straight on past side roads is not a node when the box has real choices: it would only clutter the drawing)
      const choiceJ = its.filter(it => it.f.kind === 'junction' && it.f.choice !== false);
      const jUse = choiceJ.length ? choiceJ : its.filter(it => it.f.kind === 'junction').slice(0, 1);
      const nodes = [];
      for (const it of its.filter(it => jUse.includes(it) || /^cross_/.test(it.f.kind)).sort((x, y) => x.si - y.si)) {
        const at = atOf(it); let nd = nodes[nodes.length - 1];
        // within 45 m = one node (both carriageways of a dual road, a junction on a river bank)
        if (!nd || at - nd.at > 45) { nd = { at, angle: null, track: null, branches: [], items: [] }; nodes.push(nd); }
        nd.items.push(it);
        if (it.f.kind === 'junction') {
          const a = it.f.tulip.exit.angle;
          if (!nd.main || Math.abs(a) > Math.abs(nd.angle)) { nd.main = it; nd.angle = a; nd.track = it.f.tulip.exit.track; if (!nd.entry) nd.entry = it.f.tulip.entry; }
          for (const x of it.f.tulip.branches) if (!nd.branches.some(y => !y.cross && Math.abs(y.angle - x.angle) < 15)) nd.branches.push(Object.assign({}, x));
        } else if (/^cross_/.test(it.f.kind)) nd.branches.push({ angle: it.f.crossAngle, track: it.f.kind === 'cross_road' ? it.f.track : it.f.kind.slice(6), cross: true });
      }
      // the turn at a node's main junction is the whole turn there; the other branches stay as side roads
      for (const nd of nodes) if (nd.main) { nd.branches = nd.branches.filter(x => x.cross || Math.abs(x.angle - nd.angle) >= 15); nd.at = atOf(nd.main); }
      for (const nd of nodes) if (nd.angle === null) { const k = nd.items[0].si; nd.angle = Math.round(rel(capAround(S, k, true, step), k >= N - 1 ? capAround(S, k, true, step) : capAround(S, k, false, step))); nd.track = tclass[Math.min(N - 1, k + 2)] || null; }
      // ---- notes, FIM style: danger first, then the action (the way through, in order; later steps "AT 80 ..."
      // metres after the box), then what confirms it (village, landmark), then terrain; at most 3 parts
      const GRP = k => /^(junction|cap|follow|leave_track|join_track|cross_\w+|gate|cattle_grid|ford|level_crossing|stop|bridge|surface|bend)$/.test(k) ? 1 : /^(village|landmark_pass|landmark_cross)$/.test(k) ? 2 : 3;
      const parts = [];   // {txt, grp, danger, pr, at}
      const caps = its.filter(it => it.f.kind === 'cap');
      const capMain = caps.length ? caps.reduce((x, y) => Math.abs(rel(y.f.from, y.f.to)) > Math.abs(rel(x.f.from, x.f.to)) ? y : x) : null;
      for (const it of its) {
        const k = it.f.kind;
        if (k === 'junction' && (!jUse.includes(it) || nodes.some(nd => nd.main && nd.main !== it && nd.items.includes(it)))) continue;
        if (k === 'ford' && its.some(x => x.f.kind === 'cross_water' && !x.f.onBridge && Math.abs(x.si - it.si) * step <= 45)) continue;   // "CROSS RIVER" says it
        if (k === 'cap' && it !== capMain) continue;
        if (k === 'surface' && jUse.length) continue;   // the junction already says which kind of road you go on to
        let txt = it.note;
        if (k === 'cap') txt = txt.replace(/^CAP \d{3}( C)?/, capLabel(capOut, s.mode === 'direct'));   // same CAP as the box's CAP column
        parts.push({ txt, grp: GRP(k), danger: it.danger, pr: it.pr, at: atOf(it), si: it.si });
      }
      parts.sort((x, y) => (y.danger >= 2) - (x.danger >= 2) || x.grp - y.grp || (x.grp === 1 ? x.at - y.at : y.pr - x.pr));
      // the same crossing twice (both carriageways of a dual road off-piste): once, "x2"
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++)
        if (parts[j].txt === parts[i].txt && /^CROSS /.test(parts[i].txt) && parts[j].at - parts[i].at <= 60) { parts[i].txt += ' x2'; parts.splice(j, 1); j--; }
      const seen = new Set(), keep = [];
      for (const pt of parts) { const key = pt.grp === 1 ? pt.txt + '@' + Math.round(pt.at / 30) : pt.txt; if (seen.has(key)) continue; seen.add(key); keep.push(pt); }
      // the action steps after the first one say where they are ("kpL FRO, AT 80 TURN R ON P")
      const acts = keep.filter(pt => pt.grp === 1 && !(pt.danger >= 2 && keep.indexOf(pt) === 0));
      const firstAt = acts.length ? acts[0].at : 0;
      for (const pt of acts.slice(1)) if (pt.at - firstAt >= 30) pt.txt = 'AT ' + Math.round((pt.at - firstAt) / 10) * 10 + ' ' + pt.txt;
      const MAXP = acts.length >= 2 ? 2 : 3, out1 = [];
      for (const pt of keep) {
        if (pt.grp === 1 && out1.length && out1[out1.length - 1].grp === 1 && out1[out1.length - 1].joined < 3) { const l = out1[out1.length - 1]; l.txt += ', ' + pt.txt; l.joined++; continue; }
        if (out1.length >= MAXP) continue;
        out1.push(Object.assign({}, pt, { joined: 1 }));
      }
      for (const t of lead) notes.push(t);
      for (const pt of out1) if (!notes.includes(pt.txt)) notes.push(pt.txt);
      if (duneAt(b.si) && s.mode === 'direct' && (!b.wp || b.wp.type !== 'ASS') && !notes.some(t => /^CAP /.test(t))) notes.unshift(capLabel(capOut, true));
      if (b.wp && !b.items.length && b.wp.type !== 'ASS' && !notes.length) notes.push(capLabel(capOut, s.mode === 'direct'));
      // 0.4.0: a waypoint box whose only items are the lie of the land (rocks, a river followed) still gives its CAP first
      else if (b.wp && b.wp.type !== 'ASS' && b.items.length && b.items.every(it => /^(rocks|along_water|rocky_track)$/.test(it.f.kind)) && !notes.some(t => /^CAP /.test(t))) notes.unshift(capLabel(capOut, s.mode === 'direct'));
      if (b.filler) {
        if (b.filler === 'offpiste') { const t = terr[b.si]; notes.push(capLabel(capOut, true) + (t && t !== 'dunes' ? ', ' + ({ flat: 'FLAT, FAST', rolling: 'ROLLING', broken: 'BROKEN, SLOW' }[t]) : t === 'dunes' ? ', IN DUNES' : '')); symbols.push('cap'); }
        else { const tc = tclass[b.si]; notes.push(tc === 'dual' || tc === 'tarmac' ? 'FRO' : tc === 'gravel' ? 'FPP' : 'FOLLOW ' + (TRACK_CODE[tc] || 'P')); symbols.push('continue'); }
      }
      const trIn = tclass[Math.max(0, b.si - 2)] || (s.mode === 'direct' ? 'offpiste' : 'track');
      const trOut = tclass[Math.min(N - 1, b.si + 2)] || trIn;
      // ---- tulip: one node as before; a complex (2+ nodes) as a path (tulip.pre = the earlier nodes)
      const nb = nd => nd.branches.sort((x, y) => x.angle - y.angle);
      if (nodes.length >= 2) {
        const last = nodes[nodes.length - 1];
        tulip = { entry: (nodes[0].entry && { track: nodes[0].entry.track }) || { track: trIn }, exit: { angle: last.angle, track: last.track || trOut }, branches: nb(last), at: last.at,
          pre: nodes.slice(0, -1).map(nd => ({ at: nd.at, angle: nd.angle, track: nd.track || trOut, branches: nb(nd) })) };
      } else if (nodes.length === 1 && nodes[0].items.some(it => it.f.kind === 'junction')) {
        const nd = nodes[0]; tulip = { entry: { track: (nd.entry && nd.entry.track) || trIn }, exit: { angle: nd.angle, track: nd.track || trOut }, branches: nb(nd) };
      }
      if (!tulip) {
        tulip = { entry: { track: trIn }, exit: { angle: Math.round(rel(capIn, capOut)), track: trOut }, branches: [] };
        for (const it of its) if (/^cross_/.test(it.f.kind)) tulip.branches.push({ angle: it.f.crossAngle, track: it.f.kind === 'cross_road' ? it.f.track : it.f.kind.slice(6), cross: true });
      }
      if (danger === 3) label = 'DANGER';
      const kinds = b.items.map(i => i.f.kind);
      let id = b.wp ? b.wp.id : 'rb-' + (kinds[0] || (b.filler ? 'cap' : 'note')) + '-' + Math.round(s.km * 100);
      while (used.has(id)) id += 'b'; used.set(id, 1);
      if (!b.wp) typeCount[kinds[0] || 'filler'] = (typeCount[kinds[0] || 'filler'] || 0) + 1;
      out.push({
        n: n + 1, id, km: +s.km.toFixed(2), partial: 0, capIn: n360(capIn), capOut: n360(capOut), cap: n360(capOut), capType: s.mode === 'direct' ? 'C' : null,
        waypoint, label, lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6),
        offPiste: s.mode === 'direct', symbols, danger, notes: notes.join('. '),
        tulip, features: b.items.map(i => cleanFeature(i.f)),
        // provenance, for regeneration / recce / editor merges (docs/ROADBOOK_FORMAT.md "Provenance and merging")
        source: b.wp || b.filler ? 'auto-route' : kinds.some(k => OSM_KINDS.has(k)) ? 'auto-osm' : kinds.every(k => k === 'cover') ? 'auto-landcover' : 'auto-dem',
        sources: [...new Set((b.wp || b.filler ? ['auto-route'] : []).concat(kinds.map(featureSource)))],
        autoKey: (b.wp ? 'wp:' + b.wp.id : (kinds[0] || 'filler') + ':' + s.km.toFixed(2)),
        verified: false, pinned: false, rev: 1, history: []
      });
    });
    for (let i = 0; i < out.length; i++) { out[i].partial = i ? +(out[i].km - out[i - 1].km).toFixed(2) : 0; if (i && out[i].partial * 1000 < o.shortFlagM) out[i].short = true; }
    // stats: boxes per 10 km on and off piste
    let offKm = 0, onKm = 0; for (let i = 1; i < N; i++) { const d = S[i].km - S[i - 1].km; if (S[i].mode === 'direct') offKm += d; else onKm += d; }
    const offB = out.filter(b => b.offPiste).length, onB = out.length - offB;
    const total = S[N - 1].km;
    return { boxes: out, zones, stats: { boxes: out.length, lengthKm: +total.toFixed(2), offPisteKm: +offKm.toFixed(1), onPisteKm: +onKm.toFixed(1),
      per10km: { overall: +(out.length / total * 10).toFixed(1), offPiste: offKm > 0.5 ? +(offB / offKm * 10).toFixed(1) : null, onPiste: onKm > 0.5 ? +(onB / onKm * 10).toFixed(1) : null },
      byKind: typeCount, danger: [0, 1, 2, 3].map(d => out.filter(b => b.danger === d).length), merged: boxes.filter(b => b.merged).length, spacingKept } };
  }
  /**
   * Stage files from before the roadbook editor carry roadbook text on the stage's own boxes (stage.roadbook.boxes:
   * notes, danger; NOTE points have no waypoint). That field is deprecated: roadbook text lives only in the roadbook.
   * When a roadbook is generated, that text moves into it as pinned boxes with editor provenance, so it is never lost
   * and a regenerate keeps it: a waypoint's text goes on that waypoint's box, a NOTE point's text on the auto box
   * within mergeM of it (or a new box there). Plain NOTE points without text still get a box at their spot.
   * Mutates `boxes` (sorted by km afterwards); returns how many stage boxes were moved.
   */
  function migrateStageNotes(boxes, stage, S, o) {
    const old = ((stage.roadbook && stage.roadbook.boxes) || []).filter(b => b && typeof b === 'object');
    if (!old.length || !S || !S.length) return 0;
    const legacyText = b => (typeof b.notes === 'string' ? b.notes.trim() : '');
    const at = new Date().toISOString();
    const mark = (box, sb, text) => {
      // the author's text first; what the generator found there is kept after it (unless it is only a CAP)
      if (text) { const auto = (box.notes || '').trim(); box.notes = auto && !/^CAP \d{3}$/.test(auto) && !text.toLowerCase().includes(auto.toLowerCase()) ? text + '. ' + auto : text; }
      if (+sb.danger > (box.danger || 0)) box.danger = Math.min(3, +sb.danger);
      box.source = box.source && /^auto/.test(box.source) && !text ? box.source : 'editor';
      box.sources = [...new Set((box.sources || []).concat(['editor']))];
      box.pinned = true;
      box.autoKey = box.autoKey || ('stage-note:' + (sb.id || sb.waypoint || box.km));
      box.rev = (box.rev || 1) + 1;
      box.history = (box.history || []).concat([{ rev: box.rev, at, by: 'stage-file', change: 'roadbook text moved here from the stage file (deprecated field)' }]);
      box.migrated = true;
    };
    let n = 0;
    for (const sb of old) {
      const text = legacyText(sb), danger = +sb.danger || 0;
      if (sb.waypoint) {
        if (!text && !danger) continue;
        const box = boxes.find(b => b.waypoint === sb.waypoint);
        if (box) { mark(box, sb, text); n++; }
        continue;
      }
      // a NOTE point (roadbook-only point plotted in the builder)
      if (sb.lat == null || sb.lon == null) continue;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < S.length; i++) { const d = dist([S[i].lat, S[i].lon], [+sb.lat, +sb.lon]); if (d < bd) { bd = d; bi = i; } }
      const s = S[bi];
      // 0.5.0: a plotted NOTE point closer than the box spacing to a box rides on that box (a waypoint's too)
      const near = boxes.filter(b => Math.abs(b.km - s.km) * 1000 < Math.max(o.mergeM, o.minSpacingM)).sort((a, b) => Math.abs(a.km - s.km) - Math.abs(b.km - s.km))[0];
      if (near) { if (text || danger) { mark(near, sb, text); n++; } continue; }
      const cIn = capAround(S, bi, true, o.step), cOut = capAround(S, bi, false, o.step), tr = s.mode === 'direct' ? 'offpiste' : 'track';
      const box = { n: 0, id: 'stage-' + (sb.id || ('note-' + Math.round(s.km * 100))), km: +s.km.toFixed(2), partial: 0, capIn: n360(cIn), capOut: n360(cOut), cap: n360(cOut),
        waypoint: null, label: 'NOTE', lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6), offPiste: s.mode === 'direct', symbols: [], danger: 0,
        notes: text || ('CAP ' + String(n360(cOut)).padStart(3, '0')), tulip: { entry: { track: tr }, exit: { angle: Math.round(rel(cIn, cOut)), track: tr }, branches: [] },
        features: [], source: 'auto-route', sources: ['auto-route'], autoKey: 'stage-note:' + (sb.id || s.km.toFixed(2)), verified: false, pinned: false, rev: 1, history: [] };
      if (text || danger) { mark(box, sb, text); n++; }
      boxes.push(box);
    }
    boxes.sort((a, b) => a.km - b.km || (b.waypoint ? 1 : 0) - (a.waypoint ? 1 : 0));
    boxes.forEach((b, i) => { b.n = i + 1; b.partial = i ? +(b.km - boxes[i - 1].km).toFixed(2) : 0; if (i && b.partial * 1000 < o.shortFlagM) b.short = true; else delete b.short; });
    return n;
  }
  const OSM_KINDS = new Set(['junction', 'cross_water', 'cross_fence', 'cross_railway', 'cross_road', 'ford', 'gate', 'cattle_grid', 'level_crossing', 'stop', 'bridge', 'surface', 'leave_track', 'join_track', 'village', 'landmark_cross', 'landmark_pass', 'rough', 'along_water', 'rocky_track']);
  const featureSource = k => OSM_KINDS.has(k) ? 'auto-osm' : k === 'cover' || k === 'rocks' ? 'auto-landcover' : 'auto-dem';
  function cleanFeature(f) { const o = {}; for (const k in f) if (!['i', 'tags', 'tulip', 'lat', 'lon'].includes(k)) o[k] = f[k]; if (f.tags) { o.osm = {}; for (const k of ['highway', 'surface', 'tracktype', 'waterway', 'intermittent', 'barrier', 'name', 'ref', 'bridge', 'ford', 'railway']) if (f.tags[k]) o.osm[k] = f.tags[k]; } return o; }

  /** bends on tracks with no junction (turn over ~80 m) */
  function bends(S, o, stage) {
    const F = [], k = Math.max(1, Math.round(40 / o.step)), N = S.length;
    const turn = new Float64Array(N);
    for (let i = k; i < N - k; i++) if (S[i].mode !== 'direct') turn[i] = rel(bearing([S[i - k].lat, S[i - k].lon], [S[i].lat, S[i].lon]), bearing([S[i].lat, S[i].lon], [S[i + k].lat, S[i + k].lon]));
    for (let i = k; i < N - k; i++) {
      if (Math.abs(turn[i]) < o.bendMin) continue;
      let mx = true; for (let j = i - 2 * k; j <= i + 2 * k; j++) if (j >= 0 && j < N && Math.abs(turn[j]) > Math.abs(turn[i])) { mx = false; break; }
      if (mx) F.push({ i, kind: 'bend', turn: Math.round(turn[i]), danger: Math.abs(turn[i]) >= 120 ? 1 : 0 });
    }
    // FIM "twisty / sinuous": three or more bends with under ~150 m between them
    for (let a = 0; a < F.length; a++) { let b = a; while (b + 1 < F.length && S[F[b + 1].i].km - S[F[b].i].km < 0.15) b++; if (b - a >= 2) for (let j = a; j <= b; j++) F[j].twisty = true; a = b; }
    // direct legs / GPX tracks: CAP changes at interior vertices of the plotted line (planned off-piste lines: every
    // vertex, with the planner's reason)
    const legs = (stage && stage.route && stage.route.legs) || [];
    for (let i = 1; i < N - 1; i++) if (S[i].mode !== 'road' && S[i].leg === S[i - 1].leg && S[i].vtx !== S[i - 1].vtx && i + k < N && i - k >= 0) {
      const leg = legs[S[i].leg], planned = leg && (leg.planned || (leg.gapsPlanned && leg.vertexInfo && leg.vertexInfo[S[i].vtx - 1] && leg.vertexInfo[S[i].vtx - 1].gap));
      const a = bearing([S[i - k].lat, S[i - k].lon], [S[i].lat, S[i].lon]), b = bearing([S[i].lat, S[i].lon], [S[i + k].lat, S[i + k].lon]);
      // the sample nearest the vertex
      const vi = S[i].vtx - 1, vx = leg && leg.points[vi];
      let si = i; if (vx && dist([S[i - 1].lat, S[i - 1].lon], vx) < dist([S[i].lat, S[i].lon], vx)) si = i - 1;
      const inf = planned && leg.vertexInfo ? leg.vertexInfo[vi] : null;
      // 0.5.0: terrain to follow. A bend inside a run with the same guidance ("follow valley floor") is no new box;
      // the bend where a run starts says it, with the run's length and its general CAP
      if (inf && planned) {
        const prev = leg.vertexInfo[vi - 1], fIn = prev && prev.follow, fOut = inf.follow;
        if (fOut && fOut === fIn && !inf.obstacle && Math.abs(rel(a, b)) < o.followMaxTurn && i > 0) continue;
        if (fOut) {
          let e = vi + 1; while (e < leg.points.length - 1 && leg.vertexInfo[e] && leg.vertexInfo[e].follow === fOut) e++;
          let m = 0; for (let z = vi + 1; z <= e; z++) m += dist(leg.points[z - 1], leg.points[z]);
          F.push({ i: si, kind: 'cap', from: a, to: b, danger: 0, planned: true, reason: inf.obstacle ? inf.reason : null, follow: fOut, followKm: +(m / 1000).toFixed(1), followCap: Math.round(bearing(leg.points[vi], leg.points[e])) % 360, fabricated: false, obstacle: inf.obstacle || null });
          continue;
        }
      }
      if (Math.abs(rel(a, b)) >= (planned ? 3 : 10)) F.push({ i: si, kind: 'cap', from: a, to: b, danger: 0, planned: !!planned, reason: inf ? inf.reason : null, fabricated: !!(inf && inf.fabricated), obstacle: inf ? inf.obstacle : null });
    }
    // a run that starts at the first point of a planned leg / gap: said at that point
    for (let i = 0; i < N - 1; i++) if (S[i].mode === 'direct' && (i === 0 || S[i].leg !== S[i - 1].leg || S[i - 1].mode !== 'direct')) {
      const leg = legs[S[i].leg]; if (!leg || !leg.vertexInfo) continue;
      const v0 = Math.max(0, S[i].vtx - 1), inf = leg.vertexInfo[v0]; if (!inf || !inf.follow) continue;
      if (F.some(f => f.kind === 'cap' && f.follow === inf.follow && Math.abs(S[f.i].km - S[i].km) < 0.05)) continue;
      let e = v0 + 1; while (e < leg.points.length - 1 && leg.vertexInfo[e] && leg.vertexInfo[e].follow === inf.follow) e++;
      let m = 0; for (let z = v0 + 1; z <= e; z++) m += dist(leg.points[z - 1], leg.points[z]);
      const cp = Math.round(bearing(leg.points[v0], leg.points[e])) % 360;
      F.push({ i: Math.max(0, i - 1), kind: 'follow', danger: 0, follow: inf.follow, followKm: +(m / 1000).toFixed(1), followCap: cp });
    }
    return F;
  }

  // ------------------------------------------------------------------ off-piste line planner
  /*
   * A real off-piste section is not driven on the straight line between two waypoints: the roadbook leads round
   * dunes, trees, buildings, water, fences, gullies and steep slopes, and every heading change is a box with a CAP.
   * planOffPiste() replaces each `direct` leg with such a line:
   *   1. a corridor grid (30 m cells) along the leg, as wide as ~18 % of its length (0.5-2.5 km each side);
   *   2. a cost per cell from the same terrain tiles (slope, cliffs blocked), OSM obstacles (buildings / water /
   *      military blocked; trees, scrub, wetland expensive; fences and walls cost a detour's worth to cross) and a
   *      smooth seeded noise field (the "fabricated" variation: on a featureless pan the line still wanders a little,
   *      like a human-picked line, and the same stage always gives the same line);
   *   3. A* over 16 directions, with each move costing its length, extra for climbing (so dunes are crossed at
   *      saddles and interdune corridors are followed) and a lot for faces steeper than ~25 %;
   *   4. the cell path simplified into drivable legs (no leg under ~250 m, heading changes of 5 deg or more), and long
   *      straights broken with small seeded doglegs (max ~1.8 km straight, ~3 km on a genuinely flat pan);
   *   5. a reason for every heading change, found by comparing the line with the chord it replaces ("go left round
   *      dune", "keep right of trees", "follow interdune corridor", ...); null when the bend is only variation.
   * The line always starts and ends exactly at the leg's waypoints, so every waypoint is passed at 0 m.
   */
  function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function noise2(seed, cellM) { // smooth value noise in [0,1], lattice every cellM metres
    const v = (i, j) => (hash32(seed + ':' + i + ':' + j) % 10007) / 10006;
    const sm = t => t * t * (3 - 2 * t);
    return (x, y) => { const fx = x / cellM, fy = y / cellM, i = Math.floor(fx), j = Math.floor(fy), tx = sm(fx - i), ty = sm(fy - j);
      return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty; };
  }
  const OBST = { 1: 'buildings', 2: 'trees', 3: 'water', 4: 'wetland', 5: 'restricted area', 6: 'fence', 7: 'cliff', 8: 'scrub', 9: 'sea' };
  /** 0.5.3: ESA WorldCover class -> OBST kind (10 tree cover, 95 mangroves -> trees; 80 open water; 90 wetland) */
  function coverObstacle(raw) { return raw === 10 || raw === 95 ? 2 : raw === 80 ? 3 : raw === 90 ? 4 : 0; }
  function obstacleKind(t) {
    if (!t) return 0;
    if (t.building) return 1;
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') return 3;
    if (t.landuse === 'military' || t.military) return 5;
    if (t.natural === 'wetland') return 4;
    if (t.natural === 'wood' || t.landuse === 'forest' || t.landuse === 'orchard') return 2;
    if (t.natural === 'scrub') return 8;
    if (t.natural === 'cliff') return 7;
    if (t.barrier === 'fence' || t.barrier === 'wall') return 6;
    return 0;
  }
  /**
   * 0.5.0: the off-piste pieces of a stage. A `direct` leg is one piece. A `track` / `road` leg has a piece for each
   * stretch that is not on a mapped way and is still a single straight segment: the straight gaps of a track leg
   * (leg.cover.gaps) and the connectors the builder marks in leg.off (waypoint -> road, road -> waypoint, gaps),
   * when at least planMinGapM long. Pieces the builder already planned (more than one segment) are kept as they are.
   * -> [{ li, i0, i1, whole }] (point indexes in leg.points)
   */
  function offPieces(stage, o) {
    const out = [];
    ((stage.route && stage.route.legs) || []).forEach((leg, li) => {
      const P = leg.points || []; if (P.length < 2) return;
      if (leg.mode === 'direct') { out.push({ li, i0: 0, i1: P.length - 1, whole: true }); return; }
      if (leg.via === 'gpx' || o.planGaps === false) return;
      const pairs = [].concat((leg.cover && leg.cover.gaps) || [], leg.off || []).map(g => [+g[0], +g[1]])
        .filter(g => g[1] === g[0] + 1 && g[0] >= 0 && g[1] < P.length && dist(P[g[0]], P[g[1]]) >= o.planMinGapM).sort((a, b) => a[0] - b[0]);
      const kept = (leg.off || []).map(g => [+g[0], +g[1]]).filter(g => g[1] > g[0] + 1 && g[0] >= 0 && g[1] < P.length);
      const all = pairs.map(g => ({ li, i0: g[0], i1: g[1], whole: false })).concat(kept.map(g => ({ li, i0: g[0], i1: g[1], whole: false, kept: true }))).sort((a, b) => a.i0 - b.i0);
      let last = -1;
      for (const g of all) if (g.i0 >= last) { out.push(g); last = g.i1; }
    });
    return out;
  }
  function corridorBoxes(stage, o) { // [s,w,n,e] per off-piste piece (for the obstacle query)
    const out = [], legs = (stage.route && stage.route.legs) || [];
    for (const pc of offPieces(stage, o)) {
      if (pc.kept) continue;
      const leg = legs[pc.li];
      const A = leg.points[pc.i0], B = leg.points[pc.i1], L = dist(A, B);
      const W = Math.max(o.planMinHalfWidth, Math.min(o.planMaxHalfWidth, L * o.planWidthFrac)) + 300;
      const dLat = W / 111320, dLon = W / (111320 * Math.cos(rad(A[0])));
      out.push([Math.min(A[0], B[0]) - dLat, Math.min(A[1], B[1]) - dLon, Math.max(A[0], B[0]) + dLat, Math.max(A[1], B[1]) + dLon]);
    }
    return out;
  }
  function corridorSamplePoints(stage, o) { // points every ~250 m over every corridor (to load DEM tiles)
    const pts = [];
    for (const b of corridorBoxes(stage, o)) {
      const n = Math.max(2, Math.ceil((b[2] - b[0]) * 111320 / 250)), m = Math.max(2, Math.ceil((b[3] - b[1]) * 111320 * Math.cos(rad(b[0])) / 250));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) pts.push([b[0] + (b[2] - b[0]) * i / n, b[1] + (b[3] - b[1]) * j / m]);
    }
    return pts;
  }
  function obstacleQuery(boxes) {
    let q = '[out:json][timeout:20];(';
    for (const b of boxes) {
      const B = '(' + b.map(x => x.toFixed(5)).join(',') + ')';
      q += 'way[building]' + B + ';way[natural~"^(water|wetland|wood|scrub|cliff)$"]' + B + ';way[landuse~"^(forest|military|reservoir|basin|orchard)$"]' + B +
        ';way[waterway=riverbank]' + B + ';way[barrier~"^(fence|wall)$"]' + B + ';';
    }
    return q + ');out body geom;';
  }
  async function fetchObstacles(stage, o, log) {
    const boxes = corridorBoxes(stage, o); if (!boxes.length) return { elements: [] };
    const q = obstacleQuery(boxes);
    try {
      const r = await askOverpass(q, o, log);
      if (log) log('obstacles: ' + r.elements.length + ' OSM elements' + (o._overpassSticky ? ' via ' + o._overpassSticky : ''));
      return r;
    } catch (e) {
      if (log) log('obstacles: Overpass unavailable, planning on terrain only (' + (e && e.message) + ')');
      return { elements: [], failed: true };
    }
  }

  // ------------------------------------------------------------------ landmarks (what a crew sees from a box)
  /* A second Overpass query (its own cache entry, so the route query above stays cache-friendly): things a roadbook
   * names beside the line: trees, ruins, towers, wells, cairns, pylons and power lines, fuel, places of worship,
   * cemeteries, sign posts, road works, fields, buildings (centres only). Boxes: the whole route padded by the largest
   * visibility radius, plus the off-piste corridors. */
  function landmarkQuery(boxes) {
    const f = b => '(' + b.map(x => x.toFixed(5)).join(',') + ')';
    let q = '[out:json][timeout:20];(';
    for (const b of boxes) {
      const B = f(b);
      q += 'node[natural~"^(tree|rock|stone|spring)$"]' + B + ';way[natural=tree_row]' + B +
        ';node[man_made~"^(water_tower|storage_tank|tower|mast|water_well|cairn|survey_point|silo|windmill|windpump|chimney|communications_tower|antenna)$"]' + B +
        ';way[man_made~"^(water_tower|storage_tank|tower|silo|reservoir_covered)$"]' + B +
        ';node[power~"^(tower|generator)$"]' + B + ';way[power=line]' + B +
        ';node[historic]' + B + ';way[historic]' + B + ';node[ruins=yes]' + B + ';way[ruins=yes]' + B +
        ';node[amenity~"^(place_of_worship|fuel|grave_yard|water_point)$"]' + B + ';way[amenity~"^(place_of_worship|fuel|grave_yard)$"]' + B +
        ';way[landuse~"^(cemetery|orchard|farmland)$"]' + B + ';node[information=guidepost]' + B + ';way[highway=construction]' + B + ';';
    }
    q += ');out body geom;(';
    for (const b of boxes) q += 'way[building]' + f(b) + ';';
    return q + ');out center;';
  }
  /** the lie of the land: named peaks (seen from far), the sea shore, sand / stony / salt / marsh areas */
  function landformQuery(boxes) {
    const f = b => '(' + b.map(x => x.toFixed(5)).join(',') + ')';
    let q = '[out:json][timeout:20];(';
    for (const b of boxes) { const B = f(b); q += 'node[natural~"^(peak|hill|volcano|saddle)$"]' + B + ';way[natural~"^(coastline|beach|sand|dune|scree|shingle|bare_rock|wetland|water)$"]' + B + ';way[landuse=salt_pond]' + B + ';way[waterway~"^(river|wadi)$"]' + B + ';'; }
    return q + ');out body geom;';
  }
  function landformBoxes(stage, o) {
    const S0 = resampleRoute(stage, 50);
    return routeBoxes(S0, o.overpassPieceM * 2, o.landformRadius + 50).concat(corridorBoxes(stage, o));
  }
  function landmarkBoxes(stage, o) {
    const S0 = resampleRoute(stage, 50);
    return routeBoxes(S0, o.overpassPieceM, o.landmarkRadius + 50).concat(corridorBoxes(stage, o));
  }
  async function fetchChunks(boxes, qfn, label, o, log, onChunk) {
    const els = new Map(); let failed = 0;
    for (let c = 0; c < boxes.length; c += o.overpassChunk) {
      const q = qfn(boxes.slice(c, c + o.overpassChunk));
      let data = null;
      try { data = await askOverpass(q, o, log); }
      catch (e) {
        if (/^offline/.test(e && e.message)) throw e;
        failed++; if (log) log(label + ': chunk ' + (c / o.overpassChunk + 1) + ' failed: ' + (e && e.message)); continue;
      }
      for (const e of data.elements) if (!els.has(e.type + e.id)) els.set(e.type + e.id, e);
      if (onChunk) onChunk(c / o.overpassChunk + 1, Math.ceil(boxes.length / o.overpassChunk));
      if (c + o.overpassChunk < boxes.length) await overpassGap(o);
    }
    return { elements: [...els.values()], failed, chunks: Math.ceil(boxes.length / o.overpassChunk) };
  }
  /** OSM objects a crew can see from the line (landmarks) and the lie of the land (landforms); never fatal per chunk */
  async function fetchLandmarks(stage, o, log, onChunk) {
    o = Object.assign({}, DEFAULTS, o || {});
    if (o.landmarkRounds) o.overpassRounds = Math.min(o.overpassRounds || 3, o.landmarkRounds);   // extras: give up sooner than for the route itself
    const a = await fetchChunks(landmarkBoxes(stage, o), landmarkQuery, 'landmarks', o, log, onChunk);
    const b = o.useLandforms === false ? { elements: [], failed: 0, chunks: 0 } : await fetchChunks(landformBoxes(stage, o), landformQuery, 'landforms', o, log, onChunk);
    const failed = a.failed + b.failed, chunks = a.chunks + b.chunks;
    if (log) log('landmarks: ' + a.elements.length + ' + landforms: ' + b.elements.length + ' OSM elements' + (failed ? ', ' + failed + ' of ' + chunks + ' chunk(s) failed' : ''));
    if (chunks && failed >= chunks) throw new Error('Overpass (landmarks) failed');
    return { elements: a.elements.concat(b.elements), failed };
  }

  /** plan one leg: A, B [lat,lon] -> {points, vertexInfo, stats} */
  function planLeg(A, B, hfn, obstacles, o, seedStr) {
    const L = dist(A, B);
    if (L < (o._gap ? o.planMinGapM : o.planMinLegM)) return { points: [A, B], vertexInfo: [null, null], stats: { straight: true, reason: 'short' } };
    const P = projector(A[0]), a = P.xy(A), b = P.xy(B);
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy, ny = ux;   // n = left of travel
    const c = o.planCell, W = Math.max(o.planMinHalfWidth, Math.min(o.planMaxHalfWidth, L * o.planWidthFrac));
    const i0 = -Math.round(250 / c), i1 = Math.round(L / c) + Math.round(250 / c), J = Math.round(W / c);
    const NI = i1 - i0 + 1, NJ = 2 * J + 1, NC = NI * NJ;
    const idx = (i, j) => (i - i0) * NJ + (j + J);
    const xyOf = (i, j) => [a[0] + ux * i * c + nx * j * c, a[1] + uy * i * c + ny * j * c];
    // heights
    const H = new Float32Array(NC);
    for (let i = i0; i <= i1; i++) for (let j = -J; j <= J; j++) { const ll = P.ll(xyOf(i, j)); const v = hfn(ll[0], ll[1]); H[idx(i, j)] = Number.isFinite(v) ? v : NaN; }
    // obstacles raster
    const OB = new Uint8Array(NC);
    // Mapterhorn / GLO-30 reads exactly 0 m on the sea (and on a strip of some coasts): treat it as "sea / coastal
    // flat": allowed (a waypoint may sit there) but 3x the cost, so the line keeps inland where it can
    for (let k = 0; k < NC; k++) if (!Number.isFinite(H[k]) || (o.planZeroIsSea && H[k] === 0)) { H[k] = Number.isFinite(H[k]) ? H[k] : 0; if (o.planZeroIsSea) OB[k] = 9; }
    const toIJ = (lat, lon) => { const q = P.xy([lat, lon]), dx = q[0] - a[0], dy = q[1] - a[1]; return [(dx * ux + dy * uy) / c, (dx * nx + dy * ny) / c]; };
    for (const e of (obstacles || [])) {
      const kind = obstacleKind(e.tags); if (!kind || !e.geometry || e.geometry.length < 2) continue;
      const pts = e.geometry.map(g => toIJ(g.lat, g.lon));
      const closed = e.geometry.length > 3 && e.geometry[0].lat === e.geometry[e.geometry.length - 1].lat && e.geometry[0].lon === e.geometry[e.geometry.length - 1].lon;
      if (closed && kind !== 6 && kind !== 7) {
        let mi = 1e9, Mi = -1e9, mj = 1e9, Mj = -1e9; for (const [pi, pj] of pts) { mi = Math.min(mi, pi); Mi = Math.max(Mi, pi); mj = Math.min(mj, pj); Mj = Math.max(Mj, pj); }
        for (let i = Math.max(i0, Math.floor(mi)); i <= Math.min(i1, Math.ceil(Mi)); i++) for (let j = Math.max(-J, Math.floor(mj)); j <= Math.min(J, Math.ceil(Mj)); j++) {
          let inside = false;
          for (let k = 0, l = pts.length - 1; k < pts.length; l = k++) { const [xi, yi] = pts[k], [xl, yl] = pts[l]; if (((yi > j) !== (yl > j)) && (i < (xl - xi) * (j - yi) / (yl - yi) + xi)) inside = !inside; }
          if (inside) OB[idx(i, j)] = kind;
        }
        // small buildings are smaller than a cell: mark the cell they sit in too
        if (Mi - mi < 1 && Mj - mj < 1) { const ci = Math.round((mi + Mi) / 2), cj = Math.round((mj + Mj) / 2); if (ci >= i0 && ci <= i1 && Math.abs(cj) <= J) OB[idx(ci, cj)] = kind; }
      } else { // a line: fence, wall, cliff
        for (let k = 1; k < pts.length; k++) {
          const [p0i, p0j] = pts[k - 1], [p1i, p1j] = pts[k], n = Math.ceil(Math.hypot(p1i - p0i, p1j - p0j) * 2) + 1;
          for (let s = 0; s <= n; s++) { const i = Math.round(p0i + (p1i - p0i) * s / n), j = Math.round(p0j + (p1j - p0j) * s / n); if (i >= i0 && i <= i1 && Math.abs(j) <= J) OB[idx(i, j)] = kind; }
        }
      }
    }
    // 0.5.3: ESA WorldCover where OSM maps nothing: tree cover / mangroves -> trees, open water -> water, wetland
    if (o.coverAt) for (let i = i0; i <= i1; i++) for (let j = -J; j <= J; j++) {
      const k = idx(i, j); if (OB[k] && OB[k] !== 9) continue;
      const ll = P.ll(xyOf(i, j)), kind = coverObstacle(o.coverAt(ll[0], ll[1])); if (kind) OB[k] = kind;
    }
    // per-cell cost multiplier
    const nz = noise2(seedStr, o.planNoiseCell), nz2 = noise2(seedStr + 'b', o.planNoiseCell / 3);
    const CM = new Float32Array(NC), SL = new Float32Array(NC);
    for (let i = i0; i <= i1; i++) for (let j = -J; j <= J; j++) {
      const k = idx(i, j);
      const hx = (H[idx(Math.min(i1, i + 1), j)] - H[idx(Math.max(i0, i - 1), j)]) / (2 * c), hy = (H[idx(i, Math.min(J, j + 1))] - H[idx(i, Math.max(-J, j - 1))]) / (2 * c);
      const s = Math.hypot(hx, hy); SL[k] = s;
      const [x, y] = xyOf(i, j);
      let m = 1 + o.planNoise * (0.7 * nz(x, y) + 0.3 * nz2(x, y)) + o.planSlopeCost * Math.max(0, s - 0.05) ** 2;
      if (s > o.planCliff) m = Infinity;
      const ob = OB[k];
      if (ob === 1 || ob === 3 || ob === 5 || ob === 7) m = Infinity;
      else if (ob === 2) m *= o.planTreeCost; else if (ob === 4) m *= o.planWetCost; else if (ob === 8) m *= o.planScrubCost; else if (ob === 9) m *= 3;
      CM[k] = m;
    }
    // the endpoints are always open
    CM[idx(0, 0)] = Math.min(CM[idx(0, 0)], 1); const gi = Math.round(L / c); CM[idx(gi, 0)] = Math.min(CM[idx(gi, 0)], 1);
    // A* (16 directions)
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
    const g = new Float64Array(NC).fill(Infinity), from = new Int32Array(NC).fill(-1), closed = new Uint8Array(NC);
    const heap = []; // [f, k]
    const push = (f, k) => { heap.push([f, k]); let n = heap.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (heap[p][0] <= heap[n][0]) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } } return top; };
    const s0 = idx(0, 0), goal = idx(gi, 0);
    const hfun = (i, j) => Math.hypot(gi - i, j) * c;
    g[s0] = 0; push(hfun(0, 0), s0);
    while (heap.length) {
      const [, k] = pop(); if (closed[k]) continue; closed[k] = 1;
      if (k === goal) break;
      const i = Math.floor(k / NJ) + i0, j = (k % NJ) - J;
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj; if (ni < i0 || ni > i1 || nj < -J || nj > J) continue;
        const nk = idx(ni, nj); if (closed[nk] || CM[nk] === Infinity) continue;
        if (Math.abs(di) === 2 || Math.abs(dj) === 2) { const mk = idx(i + Math.sign(di) * (Math.abs(di) === 2 ? 1 : 0), j + Math.sign(dj) * (Math.abs(dj) === 2 ? 1 : 0)); if (CM[mk] === Infinity) continue; }
        const d = Math.hypot(di, dj) * c, dh = H[nk] - H[k], gr = dh / d;
        let cost = d * (CM[k] + CM[nk]) / 2 + o.planClimbCost * Math.max(0, dh) + o.planDescentCost * Math.max(0, -dh);
        if (gr > o.planMaxUp) cost += (gr - o.planMaxUp) * d * 60;
        if (gr < -o.planMaxDown) cost += (-gr - o.planMaxDown) * d * 30;
        if (OB[nk] === 6 && OB[k] !== 6) cost += o.planFenceCost;
        const ng = g[k] + cost;
        if (ng < g[nk]) { g[nk] = ng; from[nk] = k; push(ng + hfun(ni, nj), nk); }
      }
    }
    if (from[goal] < 0) return { points: [A, B], vertexInfo: [null, null], stats: { straight: true, reason: 'no path' } };
    let cells = []; for (let k = goal; k >= 0; k = from[k]) { cells.push(k); if (k === s0) break; }
    cells.reverse();
    const cellIJ = k => [Math.floor(k / NJ) + i0, (k % NJ) - J];
    // sample along a straight piece in grid space
    const along = (p, q, fn) => { const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]))); for (let s = 0; s <= n; s++) { const i = Math.round(p[0] + (q[0] - p[0]) * s / n), j = Math.round(p[1] + (q[1] - p[1]) * s / n); if (i < i0 || i > i1 || j < -J || j > J) { if (fn(-1) === false) return false; continue; } if (fn(idx(i, j)) === false) return false; } return true; };
    const chordOK = (p, q) => along(p, q, k => k >= 0 && CM[k] !== Infinity && !(OB[k] === 6));
    const pieceCost = (p, q) => { let cst = 0, last = null; along(p, q, k => { if (k < 0) { cst = Infinity; return false; } if (last !== null) { const dh = H[k] - H[last]; cst += c * CM[k] + o.planClimbCost * Math.max(0, dh) + o.planDescentCost * Math.max(0, -dh); } last = k; }); return cst; };
    // 1) Douglas-Peucker in grid units, but never across a blocked cell
    let V = cells.map(cellIJ);
    { const keep = new Uint8Array(V.length); keep[0] = keep[V.length - 1] = 1; const st = [[0, V.length - 1]]; const tol = o.planSimplifyM / c;
      while (st.length) { const [p, q] = st.pop(); let md = 0, mi = -1; for (let k = p + 1; k < q; k++) { const d = distToSeg(V[k], V[p], V[q])[0]; if (d > md) { md = d; mi = k; } }
        if (mi >= 0 && (md > tol || !chordOK(V[p], V[q]))) { keep[mi] = 1; st.push([p, mi], [mi, q]); } }
      V = V.filter((_, k) => keep[k]); }
    const segLen = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]) * c;
    const turnAt = (V, k) => { const b1 = Math.atan2(V[k][1] - V[k - 1][1], V[k][0] - V[k - 1][0]), b2 = Math.atan2(V[k + 1][1] - V[k][1], V[k + 1][0] - V[k][0]); return Math.abs(((deg(b2 - b1) + 540) % 360) - 180); };
    // 2) no legs shorter than planMinSegM, no wiggles under 5 deg (dropping the vertex whose removal costs least)
    for (let guard = 0; guard < 500 && V.length > 2; guard++) {
      let best = -1, bestCost = Infinity;
      for (let k = 1; k < V.length - 1; k++) {
        const short = segLen(V[k - 1], V[k]) < o.planMinSegM || segLen(V[k], V[k + 1]) < o.planMinSegM, flat = turnAt(V, k) < 5;
        if (!short && !flat) continue;
        if (!chordOK(V[k - 1], V[k + 1])) continue;
        const extra = pieceCost(V[k - 1], V[k + 1]) - pieceCost(V[k - 1], V[k]) - pieceCost(V[k], V[k + 1]);
        if (extra < bestCost) { bestCost = extra; best = k; }
      }
      if (best < 0) break;
      V.splice(best, 1);
    }
    // 2b) a vertex budget from the density: fewer, longer CAP legs when the roadbook is sparse. Drop the vertex that
    // matters least (small turn, cheap to cut) while the chord is clear, until the budget is met; real turns round
    // obstacles (> planKeepTurn degrees, or cutting costs > 25 % more) stay whatever the budget says.
    { const lenKm = V.reduce((a2, v, k) => k ? a2 + segLen(V[k - 1], v) : 0, 0) / 1000, budget = Math.max(0, Math.round(lenKm * (o.density || 10) / 10 * o.planVertexShare));
      for (let guard = 0; guard < 1000 && V.length - 2 > budget; guard++) {
        let best = -1, bs = Infinity;
        for (let k = 1; k < V.length - 1; k++) {
          if (!chordOK(V[k - 1], V[k + 1])) continue;
          const pc = pieceCost(V[k - 1], V[k]) + pieceCost(V[k], V[k + 1]), extra = pieceCost(V[k - 1], V[k + 1]) - pc, relX = pc > 0 ? Math.max(0, extra) / pc : 0;
          const t = turnAt(V, k); if (t > o.planKeepTurn || relX > 0.25) continue;
          const sc = t + 100 * relX; if (sc < bs) { bs = sc; best = k; }
        }
        if (best < 0) break;
        V.splice(best, 1);
      } }
    const info = V.map(() => null);
    const segScale = Math.max(1, 12 / (o.density || 10) - 0.2);   // sparse roadbook: longer straights before a dogleg is added
    // 3) long straights: seeded doglegs (a long dead-straight line is not how anyone drives off-piste)
    const rnd = mulberry(hash32(seedStr + ':jit')); let jitGuard = 0;
    for (let k = 0; k + 1 < V.length; k++) {
      const len = segLen(V[k], V[k + 1]);
      let flatSum = 0, n = 0; along(V[k], V[k + 1], q => { if (q >= 0) { flatSum += SL[q]; n++; } });
      const flat = n && flatSum / n < o.planFlatSlope;
      const maxSeg = (flat ? o.planMaxSegFlatM : o.planMaxSegM) * segScale;
      if (len <= maxSeg) continue;
      const parts = Math.ceil(len / maxSeg);
      const dx = V[k + 1][0] - V[k][0], dy = V[k + 1][1] - V[k][1], L2 = Math.hypot(dx, dy);
      // a few seeded tries (offset side, size and position); the first whose pieces are all clear wins
      let ins = null;
      for (let tr = 0; tr < 8 && !ins; tr++) {
        const cand = [];
        for (let p = 1; p < parts; p++) {
          const t = (p + (rnd() - 0.5) * 0.5) / parts, mag = (o.planJitterMinM + rnd() * (o.planJitterMaxM - o.planJitterMinM)) * (tr < 4 ? 1 : 0.5);
          const off = mag * (rnd() < 0.5 ? -1 : 1) / c;
          const pnt = [Math.round(V[k][0] + dx * t - dy / L2 * off), Math.round(V[k][1] + dy * t + dx / L2 * off)];
          if (pnt[0] < i0 || pnt[0] > i1 || Math.abs(pnt[1]) > J || CM[idx(pnt[0], pnt[1])] === Infinity) { cand.length = 0; break; }
          cand.push(pnt);
        }
        const chain = [V[k]].concat(cand, [V[k + 1]]);
        if (cand.length && chain.every((q, m) => m === 0 || along(chain[m - 1], q, kk => kk >= 0 && CM[kk] !== Infinity))) ins = cand;
      }
      if (ins && jitGuard++ < 200) { V.splice(k + 1, 0, ...ins); for (let m = 0; m < ins.length; m++) info.splice(k + 1, 0, { reason: null, fabricated: true }); k--; }   // re-check the new pieces
    }
    // 4) why does the line bend here? compare with the chord it replaces
    const dunesNear = (p) => { let s = 0, s2 = 0, n = 0; for (let di = -5; di <= 5; di++) { const i = p[0] + di; if (i < i0 || i > i1) continue; const h = H[idx(i, Math.max(-J, Math.min(J, p[1])))]; s += h; s2 += h * h; n++; } return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) > 4; };
    for (let k = 1; k + 1 < V.length; k++) {
      if (info[k] && info[k].fabricated) continue;
      const p = V[k - 1], q = V[k + 1], m = V[k];
      const cross = (q[0] - p[0]) * (m[1] - p[1]) - (q[1] - p[1]) * (m[0] - p[0]); // > 0: the line goes left of the chord
      const side = cross > 0 ? 'left' : 'right', other = cross > 0 ? 'right' : 'left';
      let ob = 0, climbC = 0, maxG = 0, hsum = 0, n = 0, last = null;
      along(p, q, k2 => { if (k2 < 0) return; if (OB[k2] && !ob) ob = OB[k2]; if (last !== null) { const dh = H[k2] - H[last]; climbC += Math.abs(dh); } maxG = Math.max(maxG, SL[k2]); hsum += H[k2]; n++; last = k2; });
      const hC = n ? hsum / n : 0;
      let climbP = 0, hp = 0, np = 0; last = null;
      for (const [s, t] of [[p, m], [m, q]]) along(s, t, k2 => { if (k2 < 0) return; if (last !== null) climbP += Math.abs(H[k2] - H[last]); hp += H[k2]; np++; last = k2; });
      const hP = np ? hp / np : 0, dun = dunesNear(m);
      let reason = null;
      if (ob) reason = ob === 6 ? 'along fence to a gap, ' + side : ob === 7 ? 'go ' + side + ' round cliff' : ob === 1 ? 'keep ' + side + ' of buildings' : ob === 3 ? 'go ' + side + ' round water' : ob === 9 ? 'keep inland, ' + side : 'keep ' + side + ' of ' + OBST[ob];
      else if (dun && hP < hC - 3) reason = 'follow interdune corridor ' + side;
      else if (climbC > climbP + 8) reason = dun ? 'go ' + side + ' round dune' : (maxG > 0.2 ? 'avoid steep slope, go ' + side : 'go ' + side + ' round high ground');
      else if (maxG > 0.25) reason = 'avoid steep ground ' + other;
      info[k] = { reason, side, obstacle: ob ? OBST[ob] : null, climbSaved: Math.round(climbC - climbP) };
    }
    // 5) 0.5.0: what the line follows on each piece (the piece leaving vertex k): ground either side ~150 m off the
    // line compared with the line itself. A roadbook box says "FOLLOW VALLEY FLOOR" once instead of a CAP at every
    // bend along it (bends() drops the bends inside a run with the same guidance)
    if (o.planFollow !== false) for (let k = 0; k + 1 < V.length; k++) {
      const p = V[k], q = V[k + 1], Lc = Math.hypot(q[0] - p[0], q[1] - p[1]); if (Lc * c < o.followMinM) continue;
      const ui = (q[0] - p[0]) / Lc, uj = (q[1] - p[1]) / Lc, li = -uj, lj = ui;   // left of travel in grid steps
      const off = Math.max(2, Math.round(150 / c));
      let dl = 0, dr = 0, sl = 0, sr = 0, n = 0;
      const at = (i, j) => { i = Math.round(i); j = Math.round(j); return i < i0 || i > i1 || j < -J || j > J ? -1 : idx(i, j); };
      for (let t = 0.1; t <= 0.9001; t += 0.1) {
        const ci = p[0] + (q[0] - p[0]) * t, cj = p[1] + (q[1] - p[1]) * t, k0 = at(ci, cj), kl = at(ci + li * off, cj + lj * off), kr = at(ci - li * off, cj - lj * off);
        if (k0 < 0 || kl < 0 || kr < 0) continue;
        const kl2 = at(ci + li * off / 2, cj + lj * off / 2), kr2 = at(ci - li * off / 2, cj - lj * off / 2);
        // the walls of a wide valley can be 300-600 m off the line: the highest of 150 / 300 / 600 m each side
        let hl = H[kl], hr = H[kr];
        for (const f of [2, 4]) { const a1 = at(ci + li * off * f, cj + lj * off * f), b1 = at(ci - li * off * f, cj - lj * off * f); if (a1 >= 0) hl = Math.max(hl, H[a1]); if (b1 >= 0) hr = Math.max(hr, H[b1]); }
        dl += hl - H[k0]; dr += hr - H[k0]; sl += Math.max(SL[kl], kl2 >= 0 ? SL[kl2] : 0); sr += Math.max(SL[kr], kr2 >= 0 ? SL[kr2] : 0); n++;
      }
      if (n < 5) continue;
      dl /= n; dr /= n; sl /= n; sr /= n;
      // dunes: short ups and downs along the piece itself (heights minus their ~200 m running mean), not just
      // ground that varies along the leg's axis (a winding valley does that too)
      const hs = []; along(p, q, kk => { if (kk >= 0) hs.push(H[kk]); });
      let rough = 0; if (hs.length > 9) { let s2 = 0, nn = 0; for (let m = 3; m < hs.length - 3; m++) { let mean = 0; for (let d = -3; d <= 3; d++) mean += hs[m + d]; mean /= 7; s2 += (hs[m] - mean) ** 2; nn++; } rough = Math.sqrt(s2 / nn); }
      const dun = rough > o.followDuneRoughM && dunesNear([Math.round((p[0] + q[0]) / 2), Math.round((p[1] + q[1]) / 2)]);
      const hiL = dl > o.followRiseM, hiR = dr > o.followRiseM, side = dl > dr ? 'left' : 'right', sS = dl > dr ? sl : sr;
      let follow = null;
      if (dun && hiL && hiR) follow = 'follow dune corridor';
      else if (hiL && hiR) follow = 'follow valley floor';
      else if ((hiL || hiR) && Math.max(dl, dr) > o.followRiseM * 1.5) follow = sS > 0.3 ? 'follow foot of escarpment on ' + side : 'skirt high ground on ' + side;
      if (!follow) continue;
      info[k] = Object.assign(info[k] || { reason: null }, { follow });
    }
    // 6) 0.5.0 (Wyans, 18 Nov): along a valley floor, two candidate lines for the run: (a) the minimum-slope line
    // (the cost-surface path above) and (b) the approximate centre of the valley (midway between the walls found on a
    // cross-section every 60 m, smoothed). The shorter one is driven, if it keeps within the slope / obstacle limits;
    // otherwise the other. The pick is simplified so it does not zig-zag.
    const valleyRuns = [];
    if (o.planValleyCentre !== false) {
      const Hat = (i, j) => { i = Math.round(i); j = Math.round(j); return i < i0 || i > i1 || j < -J || j > J ? NaN : H[idx(i, j)]; };
      const polyLen = Q => { let m = 0; for (let k = 1; k < Q.length; k++) m += segLen(Q[k - 1], Q[k]); return m; };
      const grades = Q => { let up = 0, dn = 0, ok = true;   // along-line grades over 60 m steps, and blocked cells
        for (let k = 1; k < Q.length; k++) { let last = null, lk = -1; along(Q[k - 1], Q[k], kk => { if (kk < 0 || CM[kk] === Infinity || OB[kk] === 6) { ok = false; return false; } if (lk < 0 || ++lk >= 2) { if (last !== null) { const g = (H[kk] - H[last]) / (2 * c); up = Math.max(up, g); dn = Math.max(dn, -g); } last = kk; lk = 0; } }); if (!ok) break; }
        return { ok, up, dn, max: Math.max(up, dn) }; };
      const dp = (Q, tol) => { if (Q.length < 3) return Q.slice(); let mx = 0, at = 0; const [p, q] = [Q[0], Q[Q.length - 1]], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1e-9;
        for (let k = 1; k < Q.length - 1; k++) { const d = Math.abs((q[0] - p[0]) * (p[1] - Q[k][1]) - (p[0] - Q[k][0]) * (q[1] - p[1])) / L; if (d > mx) { mx = d; at = k; } }
        return mx <= tol ? [p, q] : dp(Q.slice(0, at + 1), tol).slice(0, -1).concat(dp(Q.slice(at), tol)); };
      for (let a0 = 0; a0 + 1 < V.length; a0++) {
        if (!(info[a0] && info[a0].follow === 'follow valley floor')) continue;
        let b0 = a0 + 1; while (b0 + 1 < V.length && info[b0] && info[b0].follow === 'follow valley floor') b0++;
        const run0 = V.slice(a0, b0 + 1), lenRun = polyLen(run0);
        if (lenRun < o.followMinM) { a0 = b0 - 1; continue; }
        // (a) minimum-slope line: A* between the run's ends over the run's box (+ 600 m), cost = length x (1 + 12 x
        // terrain slope^2) + climbing; no noise, no doglegs. Smoothed and simplified like (b)
        const pA0 = run0[0].map(Math.round), pB0 = run0[run0.length - 1].map(Math.round), pad = Math.round(o.valleyMaxHalfM / c);
        const bi0 = Math.max(i0, Math.min(...run0.map(v => v[0])) - pad), bi1 = Math.min(i1, Math.max(...run0.map(v => v[0])) + pad);
        const bj0 = Math.max(-J, Math.min(...run0.map(v => v[1])) - pad), bj1 = Math.min(J, Math.max(...run0.map(v => v[1])) + pad);
        let minLine = null;
        { g.fill(Infinity); from.fill(-1); closed.fill(0); heap.length = 0;
          const sK = idx(pA0[0], pA0[1]), gK = idx(pB0[0], pB0[1]); g[sK] = 0; push(0, sK);
          while (heap.length) { const [, k] = pop(); if (closed[k]) continue; closed[k] = 1; if (k === gK) break;
            const i = Math.floor(k / NJ) + i0, j = (k % NJ) - J;
            for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < bi0 || ni > bi1 || nj < bj0 || nj > bj1) continue; const nk = idx(ni, nj); if (closed[nk] || CM[nk] === Infinity || OB[nk] === 6) continue;
              const d = Math.hypot(di, dj) * c, dh = H[nk] - H[k], sl = (SL[k] + SL[nk]) / 2, ng = g[k] + d * (1 + 12 * sl * sl) + 2 * Math.abs(dh);
              if (ng < g[nk]) { g[nk] = ng; from[nk] = k; push(ng + Math.hypot(pB0[0] - ni, pB0[1] - nj) * c, nk); } } }
          if (from[gK] >= 0 || sK === gK) { const cl = []; for (let k = gK; k >= 0; k = from[k]) { cl.push(cellIJ(k)); if (k === sK) break; } minLine = cl.reverse(); } }
        const smoothLine = (Q, ends) => {
          const W2 = 3, Sm = Q.map((q, m) => { if (m === 0 || m === Q.length - 1) return q; let si = 0, sj = 0, n = 0; for (let d = -W2; d <= W2; d++) { const r = Q[Math.max(0, Math.min(Q.length - 1, m + d))]; si += r[0]; sj += r[1]; n++; } return [si / n, sj / n]; });
          Sm[0] = ends[0]; Sm[Sm.length - 1] = ends[1];
          const out = dp(Sm, o.valleySmoothM / c);
          for (let k = 1; k < out.length - 1; k++) if (segLen(out[k - 1], out[k]) < 150) { out.splice(k, 1); k--; }   // no zig-zag pieces
          return out; };
        const run = minLine && minLine.length > 2 ? smoothLine(minLine, [run0[0], run0[run0.length - 1]]) : run0, lenMin = polyLen(run);
        // (b) the valley centre: samples every 2 cells along the min-slope line, a cross-section at each
        const S2 = []; for (let k = 1; k < run.length; k++) { const n = Math.max(1, Math.round(segLen(run[k - 1], run[k]) / (2 * c))); for (let t = (k === 1 ? 0 : 1); t <= n; t++) S2.push([run[k - 1][0] + (run[k][0] - run[k - 1][0]) * t / n, run[k - 1][1] + (run[k][1] - run[k - 1][1]) * t / n]); }
        const maxT = Math.round(o.valleyMaxHalfM / c), C2 = [];
        for (let m = 0; m < S2.length; m++) {
          const pA = S2[Math.max(0, m - 2)], pB = S2[Math.min(S2.length - 1, m + 2)], L = Math.hypot(pB[0] - pA[0], pB[1] - pA[1]) || 1, li = -(pB[1] - pA[1]) / L, lj = (pB[0] - pA[0]) / L;
          const h0 = Hat(S2[m][0], S2[m][1]); let dL = 0, dR = 0;
          for (let t = 1; t <= maxT && !dL; t++) { const h = Hat(S2[m][0] + li * t, S2[m][1] + lj * t); if (!Number.isFinite(h)) break; if (h - h0 >= o.valleyWallM) dL = t; }
          for (let t = 1; t <= maxT && !dR; t++) { const h = Hat(S2[m][0] - li * t, S2[m][1] - lj * t); if (!Number.isFinite(h)) break; if (h - h0 >= o.valleyWallM) dR = t; }
          const sh = dL && dR ? (dL - dR) / 2 : 0;   // + = towards the left wall
          C2.push([S2[m][0] + li * sh, S2[m][1] + lj * sh]);
        }
        // smoothed (moving average over ~400 m), ends pinned to the run's ends, simplified
        const cen = smoothLine(C2, [run0[0], run0[run0.length - 1]]);
        const lenCen = polyLen(cen), gMin = grades(run), gCen = grades(cen), gOld = grades(run0);
        const safe = g => g.ok && g.up <= o.planMaxUp && g.dn <= o.planMaxDown;
        // 0.5.2 (Wyans, 19 Nov): the valley centre unless it is untenable (over the grade limits or blocked); then the
        // minimum-slope line; neither: the planner's own line. Length does not decide
        const bad = g => !g.ok ? 'blocked' : 'grade ' + Math.round(g.max * 100) + '%';
        let pick, why;
        if (safe(gCen)) { pick = { k: 'centre', Q: cen }; why = 'centre within limits'; }
        else if (safe(gMin)) { pick = { k: 'min-slope', Q: run }; why = 'centre untenable (' + bad(gCen) + ')'; }
        else { pick = { k: 'planner line', Q: run0 }; why = 'both untenable (centre ' + bad(gCen) + ', min-slope ' + bad(gMin) + ')'; }
        const chosen = pick.k;
        valleyRuns.push({ fromV: a0, toV: b0, plannerLineM: Math.round(lenRun), maxGradePlannerPct: Math.round(gOld.max * 100), lenMinSlopeM: Math.round(lenMin), lenCentreM: Math.round(lenCen), chosen, why, maxGradeMinSlopePct: Math.round(gMin.max * 100), maxGradeCentrePct: Math.round(gCen.max * 100), centreVertices: cen.length - 2, minSlopeVertices: run.length - 2,
          ...(o.planDebug ? { centreLine: cen.map(v => P.ll(xyOf(v[0], v[1])).map(x => +x.toFixed(6))), minSlopeLine: run.map(v => P.ll(xyOf(v[0], v[1])).map(x => +x.toFixed(6))) } : {}) });
        if (chosen !== 'planner line') {
          const inner = pick.Q.slice(1, -1);
          V.splice(a0 + 1, b0 - a0 - 1, ...inner);
          info.splice(a0 + 1, b0 - a0 - 1, ...inner.map(() => ({ reason: null, follow: 'follow valley floor', valley: chosen })));
          b0 = a0 + inner.length + 1;
        }
        a0 = b0 - 1;
      }
    }
    const pts = V.map((v, k) => k === 0 ? A : k === V.length - 1 ? B : P.ll(xyOf(v[0], v[1])).map(x => +x.toFixed(6)));
    const segs = []; for (let k = 1; k < pts.length; k++) segs.push(dist(pts[k - 1], pts[k]));
    return { points: pts, vertexInfo: info, stats: { straight: pts.length === 2, vertices: pts.length - 2, longestStraightM: Math.round(Math.max(...segs)), meanSegM: Math.round(segs.reduce((x, y) => x + y, 0) / segs.length),
      valley: valleyRuns.length ? valleyRuns : undefined,
      straightLenM: Math.round(L), lineLenM: Math.round(segs.reduce((x, y) => x + y, 0)), fabricated: info.filter(x => x && x.fabricated).length, reasoned: info.filter(x => x && x.reason).length } };
  }

  /**
   * A copy of the stage with every `direct` leg replaced by a planned line (`planned: true`, `vertexInfo`), its
   * `km` the new line's length and the waypoints' `km` re-summed. Waypoint `cap`s are left alone (the in-game GPS keeps
   * the waypoint CAP; the roadbook CAPs follow the line).
   */

  // ------------------------------------------------------------------ 0.6.0 dune fields: recce line, not an A* weave
  /** OSM natural=sand / natural=dune (ways and relation outers) as a point-in-polygon index. */
  function isSandTag(tags) { return !!(tags && (tags.natural === 'sand' || tags.natural === 'dune')); }
  function stitchRings(parts) {
    const unused = parts.map(p => p.slice());
    const rings = [];
    while (unused.length) {
      let ring = unused.pop();
      if (!ring || ring.length < 2) continue;
      let guard = 0;
      while (guard++ < 4000) {
        const a = ring[0], b = ring[ring.length - 1];
        if (a[0] === b[0] && a[1] === b[1] && ring.length >= 4) { rings.push(ring); break; }
        let found = -1, rev = false;
        for (let i = 0; i < unused.length; i++) {
          const q = unused[i], q0 = q[0], q1 = q[q.length - 1];
          if (q0[0] === b[0] && q0[1] === b[1]) { found = i; rev = false; break; }
          if (q1[0] === b[0] && q1[1] === b[1]) { found = i; rev = true; break; }
        }
        if (found < 0) { if (ring.length >= 4) { ring.push(ring[0]); rings.push(ring); } break; }
        const add = unused.splice(found, 1)[0];
        if (rev) add.reverse();
        ring = ring.concat(add.slice(1));
      }
    }
    return rings;
  }
  function ringsFromElement(e) {
    if (!e) return [];
    if (e.type === 'way' && e.geometry && e.geometry.length >= 4) {
      const g = e.geometry.map(p => [p.lat, p.lon]);
      const a = g[0], b = g[g.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) return [g];
      return [];
    }
    if (e.type === 'relation' && e.members && e.members.length) {
      const parts = [];
      for (const m of e.members) {
        if (m.role === 'inner') continue;
        if (m.geometry && m.geometry.length >= 2) parts.push(m.geometry.map(p => [p.lat, p.lon]));
        else if (m.type === 'way' && m.nodes && e.elements) continue;
      }
      return stitchRings(parts);
    }
    return [];
  }
  function latLonInRing(lat, lon, ring) {
    return pointInRing([lon, lat], ring.map(p => [p[1], p[0]]));
  }
  function makeSandIndex(elements) {
    const polys = [];
    for (const e of elements || []) {
      if (!isSandTag(e.tags || {})) continue;
      for (const ring of ringsFromElement(e)) {
        if (ring.length < 4) continue;
        let s = 90, n = -90, w = 180, ea = -180;
        for (const p of ring) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); ea = Math.max(ea, p[1]); }
        polys.push({ ring, bb: [s, w, n, ea], name: (e.tags && (e.tags.name || e.tags['name:en'])) || null });
      }
    }
    return {
      count: polys.length,
      at(lat, lon) {
        for (const p of polys) {
          if (lat < p.bb[0] || lat > p.bb[2] || lon < p.bb[1] || lon > p.bb[3]) continue;
          if (latLonInRing(lat, lon, p.ring)) return p;
        }
        return null;
      }
    };
  }
  function sandQuery(bbox) {
    const B = '(' + bbox.map(x => (+x).toFixed(5)).join(',') + ')';
    return '[out:json][timeout:40];(way["natural"="sand"]' + B + ';way["natural"="dune"]' + B +
      ';relation["natural"="sand"]' + B + ';relation["natural"="dune"]' + B + ';);out body geom;';
  }
  async function fetchSand(stage, o, log) {
    if (o.sandIndex) return o.sandIndex;
    const supplied = o.sand ? (Array.isArray(o.sand) ? o.sand : (o.sand.elements || [])) : null;
    if (supplied) return makeSandIndex(supplied);
    if (o.useOsm === false || o.osm === false) return makeSandIndex([]);
    if (o.osm && o.osm.elements) {
      const idx = makeSandIndex(o.osm.elements);
      if (idx.count) return idx;
    }
    const S = resampleRoute(stage, 200); if (!S.length) return makeSandIndex([]);
    const pad = 2000 / 111320;
    let s = 90, n = -90, w = 180, e = -180;
    for (const p of S) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    const bbox = [s - pad, w - pad, n + pad, e + pad];
    try {
      const r = await askOverpass(sandQuery(bbox), o, log);
      if (log) log('sand: ' + (r.elements || []).length + ' OSM sand/dune objects');
      return makeSandIndex(r.elements || []);
    } catch (err) {
      if (log) log('sand: Overpass unavailable (' + (err && err.message) + ')');
      return makeSandIndex([]);
    }
  }

  /** height-reversal dune mask along samples S with heights h, same thresholds as analyseProfile (DNX notes). */
  function heightReversalMask(S, h, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const N = S.length, step = (S.length >= 2) ? Math.max(1, (S[N - 1].d - S[0].d) / (N - 1)) : o.step;
    const mask = new Uint8Array(N);
    if (N < 8) return mask;
    const H = smooth(fillGaps(h), Math.max(1, Math.round(20 / step)));
    const ext = [];
    { let dir = 0, ei = 0;
      for (let i = 1; i < N; i++) {
        if (dir >= 0 && H[i] > H[ei]) { ei = i; if (dir === 0) dir = 1; }
        else if (dir <= 0 && H[i] < H[ei]) { ei = i; if (dir === 0) dir = -1; }
        if (dir === 1 && H[ei] - H[i] >= o.duneAmp) { ext.push([ei, H[ei], 1]); dir = -1; ei = i; }
        else if (dir === -1 && H[i] - H[ei] >= o.duneAmp) { ext.push([ei, H[ei], -1]); dir = 1; ei = i; }
      }
    }
    const k50 = Math.max(1, Math.round(40 / step));
    const g = new Float64Array(N);
    for (let i = 0; i < N; i++) { const a = Math.max(0, i - k50), b = Math.min(N - 1, i + k50); g[i] = b > a ? (H[b] - H[a]) / ((b - a) * step) * 100 : 0; }
    const win = Math.round(1000 / Math.max(1, step));
    for (let a = 0; a < ext.length; a++) {
      let b = a; while (b + 1 < ext.length && ext[b + 1][0] - ext[a][0] <= win) b++;
      const revs = b - a;
      if (revs >= o.duneMinRev) {
        let steep = 0; for (let i = ext[a][0]; i <= ext[b][0]; i++) steep = Math.max(steep, Math.abs(g[i]));
        if (steep >= o.duneSteep) for (let i = ext[a][0]; i <= ext[b][0]; i++) mask[i] = 1;
      }
    }
    const gap = Math.round(o.duneGapM / Math.max(1, step));
    for (let i = 0; i < N;) {
      if (!mask[i]) { i++; continue; }
      let j = i;
      while (j + 1 < N && (mask[j + 1] || (j + 1 + gap < N && mask.slice(j + 1, j + 1 + gap).some(Boolean)))) j++;
      if ((j - i) * step < o.duneMinStretchM) for (let k = i; k <= j; k++) mask[k] = 0;
      i = j + 1;
    }
    return mask;
  }

  /** samples along A->B every stepM, with height, sand, and reversal flags. */
  function sampleLegLine(A, B, hfn, sandIndex, o, stepM) {
    o = Object.assign({}, DEFAULTS, o || {});
    const L = dist(A, B), step = stepM || o.step || 20;
    const n = Math.max(1, Math.round(L / step)), cap = bearing(A, B), out = [];
    for (let i = 0; i <= n; i++) {
      const p = i === 0 ? A : (i === n ? B : dest(A, cap, (i / n) * L));
      const h = hfn ? hfn(p[0], p[1]) : 0;
      out.push({ lat: p[0], lon: p[1], d: (i / n) * L, h: Number.isFinite(h) ? h : NaN, sand: !!(sandIndex && sandIndex.at(p[0], p[1])) });
    }
    const mask = heightReversalMask(out, out.map(s => s.h), o);
    for (let i = 0; i < out.length; i++) out[i].rev = !!mask[i];
    return out;
  }

  function legInDuneField(A, B, hfn, sandIndex, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const S = sampleLegLine(A, B, hfn, sandIndex, o);
    if (S.length < 2) return { yes: false, fracSand: 0, fracRev: 0, frac: 0, samples: S };
    const fracSand = S.filter(s => s.sand).length / S.length;
    const fracRev = S.filter(s => s.rev).length / S.length;
    const frac = S.filter(s => s.sand || s.rev).length / S.length;
    // dense height reversals (real dunes), not a few mountain ridges joined by the 800 m gap fill
    const extD = [];
    { let dir = 0, ei = 0;
      for (let i = 1; i < S.length; i++) {
        const H = S[i].h, He = S[ei].h;
        if (!Number.isFinite(H) || !Number.isFinite(He)) continue;
        if (dir >= 0 && H > He) { ei = i; if (dir === 0) dir = 1; }
        else if (dir <= 0 && H < He) { ei = i; if (dir === 0) dir = -1; }
        if (dir === 1 && S[ei].h - H >= o.duneAmp) { extD.push(S[ei].d); dir = -1; ei = i; }
        else if (dir === -1 && H - S[ei].h >= o.duneAmp) { extD.push(S[ei].d); dir = 1; ei = i; }
      }
    }
    const spacings = [];
    for (let i = 1; i < extD.length; i++) spacings.push(extD[i] - extD[i - 1]);
    spacings.sort((a, b) => a - b);
    const medSp = spacings.length ? spacings[Math.floor(spacings.length / 2)] : Infinity;
    const km = Math.max(0.001, (S[S.length - 1].d - S[0].d) / 1000);
    const denseRev = extD.length >= 6 && medSp <= 600 && (extD.length / km) >= 3;
    // OSM sand, or a genuinely rippled dune field. A sparse ridge / valley is not a sand sea.
    const yes = fracSand >= o.duneFrac * 0.8 || (denseRev && fracRev >= o.duneFrac);
    return { yes, fracSand, fracRev, frac, denseRev, medSp: Number.isFinite(medSp) ? Math.round(medSp) : null, samples: S };
  }

  /**
   * Recce line for a dune-field leg: stay on the CAP heading, or drift into a broad interdune corridor that really
   * runs along that heading for a long stretch. Never weave around single dunes. Ends stay on the waypoints.
   */
  function planLegRecce(A, B, hfn, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const L = dist(A, B);
    if (L < (o._gap ? o.planMinGapM : o.planMinLegM)) return { points: [A, B], vertexInfo: [null, null], stats: { recce: true, straight: true, reason: 'short' } };
    const P = projector(A[0]), a = P.xy(A), b = P.xy(B);
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy, ny = ux;
    const step = o.recceStepM, n = Math.max(2, Math.round(L / step));
    const half = o.recceCorridorHalfM, wall = o.recceCorridorWallM;
    const raw = new Float64Array(n + 1); // preferred offset (m, + = left), NaN if none
    const hAt = (i, off) => {
      const x = a[0] + ux * (i / n) * L + nx * off, y = a[1] + uy * (i / n) * L + ny * off;
      const ll = P.ll([x, y]); const v = hfn(ll[0], ll[1]); return Number.isFinite(v) ? v : NaN;
    };
    for (let i = 0; i <= n; i++) {
      const offs = [];
      for (let off = -half; off <= half; off += 30) offs.push({ off, h: hAt(i, off) });
      let best = null, bestScore = Infinity;
      for (let k = 2; k < offs.length - 2; k++) {
        const h0 = offs[k].h; if (!Number.isFinite(h0)) continue;
        let left = -Infinity, right = -Infinity;
        for (let j = 0; j < k; j++) if (Number.isFinite(offs[j].h)) left = Math.max(left, offs[j].h);
        for (let j = k + 1; j < offs.length; j++) if (Number.isFinite(offs[j].h)) right = Math.max(right, offs[j].h);
        if (!(left - h0 >= wall && right - h0 >= wall)) continue;
        const score = Math.abs(offs[k].off) + (h0 - Math.min(left, right)) * 0.25;
        if (score < bestScore) { bestScore = score; best = offs[k].off; }
      }
      raw[i] = best == null ? NaN : best;
    }
    // fill tiny gaps, then smooth
    let last = 0;
    for (let i = 0; i <= n; i++) if (Number.isFinite(raw[i])) { if (last < i) { /* leave NaN */ } last = i; }
    const win = Math.max(1, Math.round(o.recceSmoothM / step));
    const sm = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let s = 0, c = 0;
      for (let k = i - win; k <= i + win; k++) {
        const j = Math.max(0, Math.min(n, k));
        if (Number.isFinite(raw[j])) { s += raw[j]; c++; }
      }
      sm[i] = c ? s / c : 0;
    }
    // only keep a corridor offset if it holds on one side for recceCorridorMinM and stays near the heading
    const need = Math.max(2, Math.round(o.recceCorridorMinM / step));
    const use = new Float64Array(n + 1);
    for (let i = 0; i <= n;) {
      const side = sm[i] >= o.recceMinOffsetM ? 1 : (sm[i] <= -o.recceMinOffsetM ? -1 : 0);
      if (!side) { use[i] = 0; i++; continue; }
      let j = i; while (j + 1 <= n && Math.sign(sm[j + 1]) === side && Math.abs(sm[j + 1]) >= o.recceMinOffsetM * 0.6) j++;
      const runM = (j - i) * step;
      const used = runM >= o.recceCorridorMinM;
      for (let k = i; k <= j; k++) use[k] = used ? sm[k] : 0;
      i = j + 1;
    }
    // pin ends to 0, build the line, simplify
    use[0] = 0; use[n] = 0;
    const fade = Math.max(1, Math.round(200 / step));
    for (let k = 1; k <= fade && k < n; k++) { use[k] *= k / fade; use[n - k] *= k / fade; }
    const xy = [];
    for (let i = 0; i <= n; i++) xy.push([a[0] + ux * (i / n) * L + nx * use[i], a[1] + uy * (i / n) * L + ny * use[i]]);
    const keep = new Uint8Array(xy.length); keep[0] = keep[xy.length - 1] = 1;
    const tol = o.recceSimplifyM;
    const st = [[0, xy.length - 1]];
    while (st.length) {
      const [p, q] = st.pop();
      let md = 0, mi = -1;
      for (let k = p + 1; k < q; k++) { const d = distToSeg(xy[k], xy[p], xy[q])[0]; if (d > md) { md = d; mi = k; } }
      if (mi >= 0 && md > tol) { keep[mi] = 1; st.push([p, mi], [mi, q]); }
    }
    const V = [], vIdx = [];
    for (let i = 0; i < xy.length; i++) if (keep[i]) { V.push(xy[i]); vIdx.push(i); }
    const points = V.map((q, i) => i === 0 ? A : (i === V.length - 1 ? B : P.ll(q)));
    const info = points.map(() => null);
    let corridorM = 0; for (let i = 1; i <= n; i++) if (use[i] && use[i - 1]) corridorM += step;
    // a follow flag at the start of a long corridor run
    for (let i = 1; i + 1 < vIdx.length; i++) {
      const ia = vIdx[i];
      if (Math.abs(use[ia]) >= o.recceMinOffsetM) {
        const side = use[ia] > 0 ? 'left' : 'right';
        info[i] = { reason: null, follow: 'along interdune corridor ' + side, recce: true };
        break;
      }
    }
    for (let i = 1; i + 1 < points.length; i++) if (!info[i]) info[i] = { reason: null, recce: true };
    const len = points.reduce((s, p, k) => k ? s + dist(points[k - 1], p) : 0, 0);
    return { points, vertexInfo: info, stats: { recce: true, corridorM: Math.round(corridorM), vertices: points.length - 2, longestStraightM: Math.round(Math.max(...points.slice(1).map((p, k) => dist(points[k], p)))), recceLenM: Math.round(len) } };
  }

  function capLabel(cap, offPiste) { return 'CAP ' + pad3(cap) + (offPiste ? ' C' : ''); }

  /**
   * Suggested waypoint type. Never overrides a type the user already set (opts.userSet).
   * In a dune field, the next type after DSS / FZ (and a blank mid-stage type) is WPN.
   */
  function suggestWpType(opts) {
    opts = opts || {};
    if (opts.userSet) return opts.current || opts.prevType;
    const prev = opts.prevType, cur = opts.current;
    if (prev === 'DZ') return 'FZ';
    if (opts.inDune && (prev === 'DSS' || prev === 'FZ' || cur === 'WPM' || cur === 'WPV' || !cur) && !/^(DSS|ASS|DZ|FZ|WPS)$/.test(cur || '')) return 'WPN';
    if (prev === 'DSS' || prev === 'FZ') return cur || 'WPM';
    return cur || prev;
  }


  function planOffPiste(stage, hfn, obstacles, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const st = JSON.parse(JSON.stringify(stage)), legs = (st.route && st.route.legs) || [], stats = [];
    // 0.5.0: off-piste stretches of track / road legs (gaps, connectors) are planned round obstacles too, spliced
    // into the leg; their segments are marked in leg.offSegs (resampled as off-piste, CAPs from the planned line)
    const gapsByLeg = new Map();
    for (const pc of offPieces(stage, o)) if (!pc.whole) (gapsByLeg.get(pc.li) || gapsByLeg.set(pc.li, []).get(pc.li)).push(pc);
    for (const [li, pcs] of gapsByLeg) {
      const leg = legs[li], key = leg.from + '>' + leg.to, P0 = leg.points;
      const pts = [P0[0]], info = [null], offSegs = [];
      let at = 0;
      for (const pc of pcs.sort((a, b) => a.i0 - b.i0)) {
        for (let k = at + 1; k <= pc.i0; k++) { pts.push(P0[k]); info.push(null); }
        let r;
        if (pc.kept) r = { points: P0.slice(pc.i0, pc.i1 + 1), vertexInfo: P0.slice(pc.i0, pc.i1 + 1).map(() => null), stats: { kept: true } };
        else if (o.duneRecce !== false && legInDuneField(P0[pc.i0], P0[pc.i1], hfn, o.sandIndex, o).yes)
          r = planLegRecce(P0[pc.i0], P0[pc.i1], hfn, Object.assign({}, o, { _gap: true }));
        else r = planLeg(P0[pc.i0], P0[pc.i1], hfn, obstacles, Object.assign({}, o, { _gap: true }), (stage.id || '') + ':' + key + ':gap' + pc.i0 + ':' + (o.planSeed || 0));
        // the piece's first point is a road / track point: it keeps no CAP, only what the first piece follows
        if (r.vertexInfo[0] && r.vertexInfo[0].follow) info[info.length - 1] = { reason: null, follow: r.vertexInfo[0].follow, gapStart: true };
        for (let k = 1; k < r.points.length; k++) { pts.push(r.points[k]); info.push(k < r.points.length - 1 ? Object.assign({ gap: true }, r.vertexInfo[k] || {}) : null); offSegs.push(pts.length - 1); }
        at = pc.i1;
        stats.push(Object.assign({ from: leg.from, to: leg.to, gap: true }, r.stats));
      }
      for (let k = at + 1; k < P0.length; k++) { pts.push(P0[k]); info.push(null); }
      const L0 = P0.reduce((x, p, k) => k ? x + dist(P0[k - 1], p) : 0, 0), L1 = pts.reduce((x, p, k) => k ? x + dist(pts[k - 1], p) : 0, 0);
      leg.points = pts; leg.vertexInfo = info; leg.offSegs = offSegs; leg.gapsPlanned = true;
      if (typeof leg.km === 'number' && leg.km > 0) leg.km = +(leg.km + (L1 - L0) / 1000).toFixed(3); else leg.km = +(L1 / 1000).toFixed(3);
    }
    for (const leg of legs) {
      if (leg.mode !== 'direct' || leg.points.length < 2 || o.planDirect === false) continue;
      const A = leg.points[0], B = leg.points[leg.points.length - 1], key = leg.from + '>' + leg.to;
      const ov = o.lineOverrides && o.lineOverrides[key], seed = (o.legSeeds && o.legSeeds[key]) || 0;
      let r;
      if (ov && ov.length >= 2) {   // a line drawn / dragged by hand in the editor: used as it is (ends snapped to the waypoints)
        const pts = ov.map(p => [+p[0], +p[1]]); pts[0] = A; pts[pts.length - 1] = B;
        r = { points: pts, vertexInfo: pts.map((_, k) => (k && k < pts.length - 1) ? { reason: null, edited: true } : null), stats: { edited: true, vertices: pts.length - 2, longestStraightM: 0 } };
        leg.edited = true;
      } else if (o.duneRecce !== false && legInDuneField(A, B, hfn, o.sandIndex, o).yes) {
        r = planLegRecce(A, B, hfn, o);
        leg.duneField = true; leg.recce = true;
      } else r = planLeg(A, B, hfn, obstacles, o, (stage.id || '') + ':' + key + ':' + (o.planSeed || 0) + (seed ? ':' + seed : ''));
      if (seed) leg.seed = seed;
      if (r && r.stats && r.stats.recce) { leg.duneField = true; leg.recce = true; }
      leg.points = r.points; leg.vertexInfo = r.vertexInfo; leg.planned = true;
      const L = r.points.reduce((s, p, k) => k ? s + dist(r.points[k - 1], p) : 0, 0);
      leg.km = +(L / 1000).toFixed(3);
      stats.push(Object.assign({ from: leg.from, to: leg.to }, r.stats));
    }
    // waypoint km = sum of leg km
    let km = 0; const at = {}; if (legs.length) at[legs[0].from] = 0;
    for (const leg of legs) { if (!(typeof leg.km === 'number')) leg.km = +(leg.points.reduce((x, p, k) => k ? x + dist(leg.points[k - 1], p) : 0, 0) / 1000).toFixed(3); km += leg.km; at[leg.to] = +km.toFixed(3); }
    for (const w of st.waypoints) if (at[w.id] !== undefined) w.km = at[w.id];
    if (legs.length) st.lengthKm = +km.toFixed(3);
    return { stage: st, stats };
  }
  /*
   * 0.5.3 (Wyans 19 Nov 2026): what a straight off-piste line crosses that no crew would drive through: tree cover and
   * forest, scrub, open water and wetland, buildings, restricted areas (OSM obstacles and ESA WorldCover), a mapped
   * cliff, and ground steeper than planCliff (60 %). The line is sampled every hazardStepM (20 m); the first and last
   * hazardEndM (60 m) are left out (a waypoint may stand in a wood or a village); a kind counts once it adds up to
   * hazardMinM (60 m: the planner's 30 m cells may clip an edge), a cliff when the line crosses it.
   * ctx { hfn, coverAt, obstacles } -> { blocked, m: { trees: 420, ... }, text: 'trees 420 m, ...', at: [lat, lon] }
   */
  const HAZARD_NAME = { 1: 'buildings', 2: 'trees', 3: 'water', 4: 'wetland', 5: 'restricted area', 7: 'cliff', 8: 'scrub', steep: 'ground over 60 %' };
  function hazardIndex(obstacles, P) {
    const polys = [], lines = [], G = new Map(), C = 500;
    for (const e of obstacles || []) {
      const kind = obstacleKind(e.tags); if (!kind || kind === 6 || !e.geometry || e.geometry.length < 2) continue;
      const pts = e.geometry.filter(Boolean).map(g => P.xy([g.lat, g.lon]));
      const closed = pts.length > 3 && e.geometry[0].lat === e.geometry[e.geometry.length - 1].lat && e.geometry[0].lon === e.geometry[e.geometry.length - 1].lon;
      let x0 = 1e15, y0 = 1e15, x1 = -1e15, y1 = -1e15; for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      const it = { kind, pts, bb: [x0, y0, x1, y1] };
      if (closed && kind !== 7) polys.push(it); else if (kind === 7) lines.push(it); else continue;
      if ((x1 - x0) * (y1 - y0) / (C * C) > 4000) { (G.get('big') || G.set('big', []).get('big')).push(it); continue; }
      for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) for (let cy = Math.floor(y0 / C); cy <= Math.floor(y1 / C); cy++) { const k = cx + ',' + cy; (G.get(k) || G.set(k, []).get(k)).push(it); }
    }
    const near = q => (G.get(Math.floor(q[0] / C) + ',' + Math.floor(q[1] / C)) || []).concat(G.get('big') || []);
    const inside = (q, pts) => { let c = false; for (let k = 0, l = pts.length - 1; k < pts.length; l = k++) { const a = pts[k], b = pts[l]; if (((a[1] > q[1]) !== (b[1] > q[1])) && (q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0])) c = !c; } return c; };
    return { near, inside, lines };
  }
  function lineHazards(points, ctx, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    const out = { blocked: false, m: {}, text: '', at: null };
    if (!points || points.length < 2) return out;
    const P = projector(points[0][0]), X = hazardIndex(ctx.obstacles, P);
    let total = 0; for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
    const step = o.hazardStepM, firstAt = {}, Q = points.map(p => P.xy(p)), cum = [0];
    for (let i = 1; i < Q.length; i++) cum.push(cum[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
    const add = (nm, ll, m) => { out.m[nm] = (out.m[nm] || 0) + m; if (!firstAt[nm]) firstAt[nm] = ll; };
    let seg = 1;
    for (let along = o.hazardEndM; along <= total - o.hazardEndM; along += step) {
      while (seg < Q.length - 1 && cum[seg] < along) seg++;
      const L = cum[seg] - cum[seg - 1], t = L ? (along - cum[seg - 1]) / L : 0;
      const q = [Q[seg - 1][0] + (Q[seg][0] - Q[seg - 1][0]) * t, Q[seg - 1][1] + (Q[seg][1] - Q[seg - 1][1]) * t], ll = P.ll(q);
      let kind = 0;
      for (const it of X.near(q)) { if (it.kind === 7 || q[0] < it.bb[0] || q[0] > it.bb[2] || q[1] < it.bb[1] || q[1] > it.bb[3]) continue; if (X.inside(q, it.pts)) { kind = it.kind; if (kind !== 8) break; } }
      if (!kind && ctx.coverAt) kind = coverObstacle(ctx.coverAt(ll[0], ll[1]));
      if (!kind && ctx.hfn) {   // slope over planCliff, measured like the planner does (terrain planCell either side)
        const e = o.planCell, dl = e / 111320, dn = e / (111320 * Math.cos(rad(ll[0])));
        const hx = (ctx.hfn(ll[0], ll[1] + dn) - ctx.hfn(ll[0], ll[1] - dn)) / (2 * e), hy = (ctx.hfn(ll[0] + dl, ll[1]) - ctx.hfn(ll[0] - dl, ll[1])) / (2 * e);
        if (Number.isFinite(hx) && Number.isFinite(hy) && Math.hypot(hx, hy) > o.planCliff) kind = 'steep';
      }
      if (kind) add(HAZARD_NAME[kind], ll, step);
    }
    // mapped cliffs the line crosses
    for (let i = 1; i < Q.length; i++) for (const it of X.lines) for (let k = 1; k < it.pts.length; k++) if (segIntersect(Q[i - 1], Q[i], it.pts[k - 1], it.pts[k])) { add('cliff', P.ll(it.pts[k]), o.hazardMinM); break; }
    const big = Object.keys(out.m).filter(k => out.m[k] >= o.hazardMinM).sort((a, b) => out.m[b] - out.m[a]);
    out.blocked = big.length > 0;
    out.text = big.map(k => k === 'cliff' ? 'a cliff' : k + ' ' + Math.round(out.m[k]) + ' m').join(', ');
    out.at = big.length ? firstAt[big[0]] : null;
    return out;
  }
  /**
   * 0.5.3, for the builder's Auto routing: load what lineHazards() needs round a leg (terrain tiles, ESA WorldCover,
   * OSM obstacles for the off-piste corridor) and check the straight line. -> Promise<{ hazards, ctx }>; ctx.more(points)
   * loads tiles for other lines (a route's off-piste hops), ctx.check(points) / ctx.plan() reuse what is loaded.
   * opts: fetchBytes / decodeImage, Overpass options as for generate, stageId, obstacles / heightFn / coverAt (tests).
   */
  async function checkLine(points, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const A = points[0], B = points[points.length - 1];
    const stage = { id: o.stageId || 'leg', waypoints: [], route: { legs: [{ from: 'a', to: 'b', mode: 'direct', points: [A, B] }] } };
    const dem = o.heightFn ? null : createDem({ fetchBytes: o.fetchBytes, decodeImage: o.decodeImage, sources: o.demSources, concurrency: o.demConcurrency });
    const lc = o.coverAt || o.useLandCover === false ? null : createLandCover({ fetchBytes: o.fetchBytes, decodeImage: o.decodeImage, maxFailures: 10 });
    const cps = corridorSamplePoints(stage, o);
    await Promise.all([dem ? dem.load(cps) : null, lc ? lc.load(cps) : null]);
    const obst = o.obstacles ? { elements: o.obstacles } : await fetchObstacles(stage, o, o.log);
    const ctx = { hfn: o.heightFn || dem.h, coverAt: o.coverAt || (lc && lc.loaded ? lc.at : null), obstacles: obst.elements || [], obstaclesFailed: !!obst.failed };
    const samples = pts => { const S = []; for (let i = 1; i < pts.length; i++) { const n = Math.max(1, Math.ceil(dist(pts[i - 1], pts[i]) / 100)); for (let k = 0; k <= n; k++) S.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / n, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / n]); } return S; };
    ctx.more = async pts => { const S = samples(pts); await Promise.all([dem ? dem.load(S) : null, lc ? lc.load(S) : null]); if (lc && lc.loaded && !ctx.coverAt) ctx.coverAt = lc.at; };
    ctx.check = pts => lineHazards(pts, ctx, o);
    // the off-piste line round what the straight line crosses (the roadbook's planner, with the same data)
    ctx.plan = () => { const r = planLeg(A, B, ctx.hfn, ctx.obstacles, Object.assign({}, o, { planZeroIsSea: true, coverAt: ctx.coverAt }), (o.stageId || 'leg') + ':auto:' + A.join(',') + '>' + B.join(','));
      return { points: r.points, stats: r.stats, hazards: lineHazards(r.points, ctx, o) }; };
    return { hazards: lineHazards(points, ctx, o), ctx };
  }
  // planned gap segments [s, ...] (segment s = points[s-1] -> points[s]) -> [[i0, i1]] point-index runs
  function offRuns(segs) { const out = []; for (const sg of (segs || []).slice().sort((a, b) => a - b)) { const l = out[out.length - 1]; if (l && l[1] === sg - 1) l[1] = sg; else out.push([sg - 1, sg]); } return out; }
  /**
   * 0.5.0, for the builder: plan the off-piste gaps / connectors of one track or road leg round obstacles (terrain
   * tiles + OSM obstacles, the same planner as off-piste legs). leg {from, to, mode, points, cover?, off?} ->
   * Promise<{ points, off: [[i0, i1]], stats }> (off = the planned runs, point indexes) or null when nothing to plan.
   * opts: fetchBytes / decodeImage (tiles), Overpass options as for generate, log.
   */
  async function planLegGaps(leg, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {}, { planDirect: false });
    const stage = { id: o.stageId || 'leg', waypoints: [], route: { legs: [JSON.parse(JSON.stringify(leg))] } };
    if (!offPieces(stage, o).some(p => !p.whole && !p.kept)) return null;
    const dem = createDem({ fetchBytes: o.fetchBytes, decodeImage: o.decodeImage, sources: o.demSources, concurrency: o.demConcurrency });
    await dem.load(corridorSamplePoints(stage, o));
    const obst = o.obstacles ? { elements: o.obstacles } : await fetchObstacles(stage, o, o.log);
    let coverAt = o.coverAt || null;   // 0.5.3: tree cover / water from ESA WorldCover too
    if (!coverAt && o.useLandCover !== false) { const lc = createLandCover({ fetchBytes: o.fetchBytes, decodeImage: o.decodeImage, maxFailures: 10 }); await lc.load(corridorSamplePoints(stage, o)); if (lc.loaded) coverAt = lc.at; }
    const plan = planOffPiste(stage, dem.h, obst.elements || [], Object.assign({}, o, { planZeroIsSea: true, coverAt }));
    const l = plan.stage.route.legs[0];
    if (!l.gapsPlanned) return null;
    return { points: l.points, off: offRuns(l.offSegs), stats: plan.stats, obstacles: (obst.elements || []).length };
  }
  /** the stage file with its off-piste legs replaced by the roadbook's planned line (optional "update the stage") */
  function applyPlannedLine(stage, rb) {
    const st = JSON.parse(JSON.stringify(stage));
    const byKey = new Map(((rb.route && rb.route.legs) || []).filter(l => l.planned || l.gapsPlanned).map(l => [l.from + '>' + l.to, l]));
    let km = 0;
    for (const leg of st.route.legs) {
      const p = byKey.get(leg.from + '>' + leg.to);
      if (p && p.planned) { leg.points = p.points.map(q => [q[0], q[1]]); leg.km = p.km; leg.planned = true; if (p.recce) leg.recce = true; if (p.duneField) leg.duneField = true; }
      else if (p) { leg.points = p.points.map(q => [q[0], q[1]]); leg.km = p.km != null ? p.km : +(leg.points.reduce((m, q, i) => i ? m + dist(leg.points[i - 1], q) : 0, 0) / 1000).toFixed(3); leg.off = offRuns(p.offSegs); delete leg.cover; }
      km += leg.km;
      const w = st.waypoints.find(x => x.id === leg.to); if (w) w.km = +km.toFixed(3);
    }
    st.lengthKm = +km.toFixed(3);
    if (st.roadbook && st.roadbook.boxes) for (const b of st.roadbook.boxes) { const w = st.waypoints.find(x => x.id === b.waypoint); if (w) b.km = w.km; }
    st.modified = new Date().toISOString();
    return st;
  }

  /**
   * Generate a roadbook for a stage.
   * opts: density, step, ... (DEFAULTS); fetchBytes/decodeImage (DEM tiles); fetchOverpass(ep, query) or osm
   * ({elements}) to skip the network; heightFn(lat, lon) to skip the DEM entirely (tests); log(msg).
   */
  async function generate(stage, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const log = o.log || (() => {});
    const progress = (phase, done, total, msg) => { if (o.onProgress) try { o.onProgress({ phase, done, total, msg }); } catch (e) { /* UI errors must not stop us */ } };
    let hfn = o.heightFn, demInfo = null, dem = null;
    if (!hfn) { dem = createDem({ fetchBytes: o.fetchBytes, decodeImage: o.decodeImage, sources: o.demSources, concurrency: o.demConcurrency }); hfn = dem.h; }
    const demProgress = (d, t) => { progress('terrain', d, t); if (o.onDemProgress) o.onDemProgress(d, t); };
    const hasDirect = offPieces(stage, Object.assign({}, DEFAULTS, opts || {})).length > 0;   // direct legs, or off-piste gaps / connectors of track / road legs (0.5.0)
    const planning = o.planOffPiste && hasDirect;
    const zeroIsSea = opts && opts.planZeroIsSea != null ? opts.planZeroIsSea : !!dem;
    const willFetch = !o.osm && o.useOsm !== false;
    if (planning && dem) { progress('terrain', 0, 1, 'terrain tiles for the off-piste corridors'); await dem.load(corridorSamplePoints(stage, o), demProgress); }
    const hash = await stageHash(stage);
    // land cover only with the real DEM (a supplied heightFn means a test / offline run: keep it deterministic)
    const landCover = !o.landCover && dem && o.useLandCover !== false ? createLandCover({ fetchBytes: o.fetchBytes, decodeImage: o.decodeImage, maxFailures: 30 }) : null;
    let lmData = o.landmarks ? (Array.isArray(o.landmarks) ? { elements: o.landmarks, supplied: true } : Object.assign({ supplied: true }, o.landmarks)) : null;
    if (planning || o.duneRecce !== false) {
      progress('sand', 0, 1, 'sand and dune areas');
      o.sandIndex = await fetchSand(stage, o, log);
    }

    // one full pass: plan the off-piste line (with the obstacles known so far), sample, analyse, assemble
    async function pass(obstacles, osm, osmInfo, obstInfo, lmData) {
      let st = stage, plan = null;
      if (planning) {
        // 0.5.3: the planner avoids ESA WorldCover tree cover / water as well as the OSM obstacles
        let coverAt = typeof o.landCover === 'function' ? o.landCover : null;
        if (!coverAt && landCover) { if (!landCover._corridor) { await landCover.load(corridorSamplePoints(stage, o)); landCover._corridor = true; } if (landCover.loaded) coverAt = landCover.at; }
        plan = planOffPiste(stage, hfn, obstacles || [], Object.assign({}, o, { planZeroIsSea: zeroIsSea, coverAt }));
        st = plan.stage;
        log('planner: ' + plan.stats.map(x => x.from + '>' + x.to + ' ' + (x.recce ? 'recce' : (x.vertices + ' bends')) + ', longest ' + x.longestStraightM + ' m').join('; '));
      }
      const S = resampleRoute(st, o.step);
      const side = S.map(s => [dest([s.lat, s.lon], s.hdg - 90, o.sideOffset), dest([s.lat, s.lon], s.hdg + 90, o.sideOffset)]);
      if (dem) {
        await dem.load(S.map(s => [s.lat, s.lon]).concat(side.flat()), demProgress);
        const prim = dem.sources[0];
        demInfo = { name: Object.keys(dem.used).join('+') || 'none', primary: prim.name, url: prim.url, zoom: prim.zoom, tiles: dem.used, failures: dem.failures, attribution: dem.sources.filter(s => dem.used[s.name]).map(s => s.attribution).join('; ') };
      }
      const h = S.map(s => hfn(s.lat, s.lon)), hl = side.map(p => hfn(p[0][0], p[0][1])), hr = side.map(p => hfn(p[1][0], p[1][1]));
      const anchorsZ = (() => { const z = []; let d = null; for (const w of st.waypoints) { const si = sampleAtKm(S, typeof w.km === 'number' ? w.km : 0); if (w.type === 'DZ') d = si; else if (w.type === 'FZ' && d !== null) { z.push([d, si]); d = null; } } return z; })();
      const isZone = i => anchorsZ.some(([a, b]) => i >= a && i <= b);
      const hmask = heightReversalMask(S, h, o);
      for (let i = 0; i < S.length; i++) {
        const leg = st.route && st.route.legs && st.route.legs[S[i].leg];
        S[i].inDune = !!(hmask[i] || (o.sandIndex && o.sandIndex.at(S[i].lat, S[i].lon)) || (leg && leg.duneField));
      }
      const fProf = analyseProfile(S, h, hl, hr, o);
      const fOsm = osm ? analyseOsm(S, osm, o, isZone) : [];
      const fBend = bends(S, o, st).filter(b => !fOsm.some(j => j.kind === 'junction' && Math.abs(S[j.i].km - S[b.i].km) < 0.08));
      // landmarks (OSM objects you can see) and land cover (ESA WorldCover) along the line
      const P = projector(S[0].lat);
      const lms = lmData && lmData.elements ? prepLandmarks(lmData.elements, P) : [];
      const fLm = lms.length ? landmarkFeatures(S, lms, o).filter(f => !(f.kind === 'landmark_pass' && isZone(f.i) && /building|tree|palm/.test(f.what))) : [];
      let cov = null;
      if (o.landCover) cov = coverAlong(S, o.landCover, o);
      else if (landCover) { await landCover.load(S.filter((_, i) => i % 2 === 0).map(s => [s.lat, s.lon]), (d, t) => progress('landcover', d, t)); if (landCover.loaded) cov = coverAlong(S, landCover.at, o); }
      const fCov = cov ? coverFeatures(S, cov, o) : [];
      const tcls = fOsm.trackClass || S.map(s => s.mode === 'direct' ? 'offpiste' : null);
      const fRock = rockFeatures(S, fProf.H, hl, hr, cov, tcls, o);
      const wways = (fOsm.waterways || []).concat(lmData && lmData.elements ? lmData.elements.filter(e => e.type === 'way' && e.tags && e.tags.waterway && e.geometry) : []);
      const fAlong = alongWaterFeatures(S, wways, fProf.valleyDepth, o);
      // a valley we already follow a river / wadi in: one note
      const inAlong = i => fAlong.some(f => i >= f.i - 10 && S[i].d <= S[f.i].d + f.len);
      const fTerr = gateTerrain(fProf, S, fOsm.grade, tcls, cov, fOsm).filter(f => !(f.kind === 'valley' && inAlong(f.i)));
      const features = fTerr.concat(fOsm, fBend, fLm, fCov, fRock, fAlong);
      features.trackClass = tcls;
      features.terrainClass = fProf.terrainClass;
      const res = assemble(st, S, features, o);
      const amb = ambientNotes(res.boxes, S, fRock.concat(fAlong, fTerr.filter(f => f.kind === 'valley' || f.kind === 'ridge'), fOsm.filter(f => f.kind === 'rocky_track' || (f.kind === 'surface' && TRACK_CODE[f.to] === 'TRACES'))));
      // 0.5.0: a mapped wadi / valley said by the ambient note beats the planner's own terrain guess on the same box
      // "GENERAL CAP 098" next to the box's own "CAP 098" says the same thing twice
      for (const b of res.boxes) { const m = b.notes.match(/, GENERAL CAP (\d{3})/); if (m && new RegExp('(^|[^L] )CAP ' + m[1]).test(b.notes.replace(m[0], ''))) b.notes = b.notes.replace(m[0], ''); }
      for (const b of res.boxes) if (/FOLLOW WADI|IN WADI BED|FOLLOW VALLEY [A-Z]/.test(b.notes.replace(/FOLLOW VALLEY FLOOR/g, '')))
        b.notes = b.notes.replace(/,? ?(FOLLOW VALLEY FLOOR|FOLLOW DUNE CORRIDOR|SKIRT HIGH GROUND ON [LR]|FOLLOW FOOT OF ESCARPMENT ON [LR])( \d+\.\d KM)?(, GENERAL CAP \d{3})?/, '').replace(/^[,. ]+/, '');
      const enr = enrichBoxes(res.boxes, S, { landmarks: lms, cover: cov, terrain: fProf.terrainClass }, o);
      const offB = res.boxes.filter(b => b.offPiste && !b.waypoint), bare = b => b.symbols.every(x => x === 'cap' || x === 'continue');
      res.stats.enrich = Object.assign(enr, { landmarkObjects: lms.length, landmarkPass: fLm.filter(f => f.kind === 'landmark_pass').length, powerLineCrossings: fLm.filter(f => f.kind === 'landmark_cross').length,
        coverChanges: fCov.length, coverKnownPct: cov ? Math.round(cov.filter(Boolean).length / cov.length * 100) : 0,
        bumps: fTerr.filter(f => f.kind === 'bump').length, ditches: fTerr.filter(f => f.kind === 'ditch').length, steps: fTerr.filter(f => /^step_/.test(f.kind)).length,
        terrainDropped: fProf.length - fTerr.length, rocks: fRock.length, alongWater: fAlong.length, ambient: amb,
        offPisteCapOnlyPct: offB.length ? Math.round(offB.filter(bare).length / offB.length * 100) : null });
      const migrated = o.migrateStageNotes === false ? 0 : migrateStageNotes(res.boxes, stage, S, o);
      if (migrated) { res.stats.boxes = res.boxes.length; res.stats.migratedFromStage = migrated; }
      const every = Math.max(1, Math.round(50 / o.step));
      const prof = []; for (let i = 0; i < S.length; i += every) prof.push(Number.isFinite(fProf.H ? fProf.H[i] : h[i]) ? Math.round((fProf.H ? fProf.H[i] : h[i]) * 10) / 10 : null);
      const now = new Date().toISOString();
      return {
        format: 'rallyraid-roadbook', schemaVersion: 1, id: stage.id + '-rb', name: 'Roadbook: ' + (stage.name || stage.id),
        stage: { id: stage.id, name: stage.name || null, hash, lengthKm: stage.lengthKm != null ? stage.lengthKm : res.stats.lengthKm },
        generator: GENERATOR, created: now, modified: now, revision: 1, conflicts: [],
        partial: osm ? undefined : (willFetch ? 'terrain-only' : undefined),
        settings: { density: o.density, stepM: o.step, mergeM: o.mergeM, junctionsInSpeedZones: o.junctionsInSpeedZones },
        sources: { elevation: demInfo || { name: 'supplied' }, osm: osmInfo, landmarks: lmData ? { elements: (lmData.elements || []).length, failedChunks: lmData.failed || 0, supplied: lmData.supplied || undefined } : null,
          landcover: cov ? (landCover ? { name: LANDCOVER.name, tiles: landCover.loaded, failures: landCover.failures, knownPct: res.stats.enrich.coverKnownPct } : { name: 'supplied' }) : null,
          attribution: 'OpenStreetMap contributors (ODbL)' + (demInfo ? '; ' + demInfo.attribution : '') + (cov && landCover ? '; ' + LANDCOVER.attribution : '') },
        stats: res.stats,
        route: { legs: ((st.route && st.route.legs) || []).map(l => Object.assign({ from: l.from, to: l.to, mode: l.mode, km: l.km }, l.planned ? { planned: true, recce: l.recce || undefined, duneField: l.duneField || undefined, points: l.points, vertexInfo: l.vertexInfo, edited: l.edited || undefined, seed: l.seed || undefined } : l.gapsPlanned ? { gapsPlanned: true, recce: l.recce || undefined, duneField: l.duneField || undefined, points: l.points, offSegs: l.offSegs, vertexInfo: l.vertexInfo } : { points: l.points, recce: l.recce || undefined, duneField: l.duneField || undefined })) },
        planner: plan ? { settings: { cell: o.planCell, maxSegM: o.planMaxSegM, maxSegFlatM: o.planMaxSegFlatM, seed: o.planSeed }, obstacles: obstInfo, legs: plan.stats } : null,
        speedZones: res.zones.map(([a, b, lim]) => ({ fromKm: +S[a].km.toFixed(2), toKm: +S[b].km.toFixed(2), limit: lim || null })),
        profile: { stepKm: +(every * o.step / 1000).toFixed(3), km: prof.map((_, k) => +S[Math.min(S.length - 1, k * every)].km.toFixed(3)), h: prof },
        boxes: res.boxes
      };
    }

    // 1. terrain first: shown at once (onPartial) while OpenStreetMap loads
    let obst = o.obstacles || (o.osm ? o.osm : null), obstInfo = null;
    if (willFetch && o.onPartial) {
      const first = await pass(obst ? obst.elements : [], null, null, null, lmData);
      try { o.onPartial(first); } catch (e) { /* ignore UI errors */ }
    }
    // 2. OpenStreetMap: obstacles for the planner + the route's own features
    let osm = o.osm, osmInfo = null;
    if (willFetch) {
      if (planning && !obst) { progress('osm', 0, 1, 'obstacles in the off-piste corridors'); obst = await fetchObstacles(stage, o, log); obstInfo = { elements: obst.elements.length, failed: !!obst.failed }; }
      const S0 = resampleRoute(stage, o.step);
      try {
        osm = await fetchOsm(S0, o, log, planning ? corridorBoxes(stage, o) : null, (d, t) => progress('osm', d, t));
        osmInfo = { endpoint: osm.endpoint, fetched: osm.fetched, elements: osm.elements.length };
      } catch (e) {
        if (!o.osmOptional) throw e;
        osm = null; osmInfo = { failed: true, error: String(e.message || e) }; log('OSM failed: ' + e.message);
      }
    } else if (osm) osmInfo = { endpoint: osm.endpoint || 'supplied', fetched: osm.fetched || null, elements: osm.elements.length };
    if (!lmData && willFetch && o.useLandmarks !== false && (osm || o.landmarksWithoutOsm)) {
      progress('landmarks', 0, 1, 'landmarks along the route');
      try { lmData = await fetchLandmarks(stage, o, log, (d, t) => progress('landmarks', d, t)); } catch (e) { log('landmarks failed: ' + e.message); lmData = { elements: [], failed: -1 }; }
    }
    progress('assemble', 0, 1);
    const rb = await pass(obst ? obst.elements : [], osm, osmInfo, obstInfo, lmData);
    if (osmInfo && osmInfo.failed) rb.partial = 'terrain-only';
    progress('done', 1, 1);
    return rb;
  }

  // ------------------------------------------------------------------ merging (regeneration, recce, editor)
  const KEEP_SOURCES = new Set(['recce-auto', 'recce-manual', 'editor']);
  const isKept = b => b.pinned || b.verified || KEEP_SOURCES.has(b.source) || b.deleted;
  function renumber(rb) {
    rb.boxes.sort((a, b) => a.km - b.km || (b.waypoint ? 1 : 0) - (a.waypoint ? 1 : 0));
    let n = 0, prev = null;
    for (const b of rb.boxes) { if (b.deleted) { b.n = null; continue; } b.n = ++n; b.partial = prev ? +(b.km - prev.km).toFixed(2) : 0; prev = b; }
    return rb;
  }
  /** km of a lat/lon on the stage's route (nearest sample), for boxes kept across a route change */
  function kmOnRoute(S, lat, lon) { let best = 0, bd = 1e18; for (let i = 0; i < S.length; i++) { const d = dist([S[i].lat, S[i].lon], [lat, lon]); if (d < bd) { bd = d; best = i; } } return { km: +S[best].km.toFixed(2), off: bd }; }
  /**
   * Regenerate without losing work: everything pinned / verified / recce / editor (and tombstones of deleted auto
   * boxes) is kept; plain auto boxes are replaced by the fresh run, except where a kept box already covers them
   * (same autoKey, or within mergeM of a kept box). If the stage changed, kept boxes get their km re-measured from
   * their lat/lon on the new route (boxes now > 150 m off the route are flagged `orphan`).
   */
  function mergeRegenerated(old, fresh, stage, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const kept = (old.boxes || []).filter(isKept).map(b => Object.assign({}, b));
    const lineChanged = JSON.stringify((old.route || {}).legs || null) !== JSON.stringify((fresh.route || {}).legs || null);
    if (stage && ((old.stage && fresh.stage && old.stage.hash !== fresh.stage.hash) || (fresh.route && lineChanged))) {
      // kept boxes are re-measured on the line the fresh roadbook follows (planned off-piste line included)
      const S = resampleRoute(fresh.route ? { waypoints: stage.waypoints, route: fresh.route } : stage, o.step);
      for (const b of kept) { const m = kmOnRoute(S, b.lat, b.lon); if (Math.abs(m.km - b.km) > 0.005) { b.km = m.km; b.rev = (b.rev || 1) + 1; b.history = (b.history || []).concat([{ rev: b.rev, at: fresh.modified, by: 'regenerate', change: 'km re-measured on the changed route' }]); } b.orphan = m.off > 150 || undefined; }
    }
    const keys = new Set(kept.map(b => b.autoKey).filter(Boolean));
    const near = b => kept.some(k => Math.abs(k.km - b.km) * 1000 <= o.mergeM && (k.waypoint === b.waypoint || !b.waypoint || k.deleted));
    const add = fresh.boxes.filter(b => !keys.has(b.autoKey) && !(b.waypoint && kept.some(k => k.waypoint === b.waypoint)) && !near(b));
    const out = Object.assign({}, fresh, { created: old.created || fresh.created, boxes: kept.concat(add), revision: (old.revision || 1) + 1, conflicts: old.conflicts || [] });
    return renumber(out);
  }
  /**
   * Apply a list of changes (from recce mode or an editor) to a roadbook. Each change:
   *   {op: 'add'|'update'|'confirm'|'move'|'delete', id, baseRev, by: 'recce-auto'|'recce-manual'|'editor', at, box?, fields?, lat?, lon?, km?, note?}
   * A change made against an older revision of a box that someone pinned since (rev > baseRev and pinned) is not
   * applied; it goes to rb.conflicts for the editor to resolve. Returns {rb, applied, conflicts}.
   */
  function applyChanges(rb, changes) {
    const byId = new Map(rb.boxes.map(b => [b.id, b])); let applied = 0; const conflicts = [];
    rb.conflicts = rb.conflicts || [];
    for (const c of changes) {
      const b = byId.get(c.id);
      const hist = (box, what) => { box.rev = (box.rev || 1) + 1; box.history = (box.history || []).concat([{ rev: box.rev, at: c.at || null, by: c.by, change: what, note: c.note }]); };
      if (c.op === 'add') {
        if (b) { conflicts.push({ change: c, reason: 'id exists' }); continue; }
        const nb = Object.assign({ symbols: [], danger: 0, notes: '', tulip: null, features: [], waypoint: null, label: 'NOTE' }, c.box || {}, { id: c.id, source: c.by, sources: [c.by], verified: c.by !== 'recce-auto', pinned: c.by === 'recce-manual' || c.by === 'editor', rev: 1, history: [{ rev: 1, at: c.at || null, by: c.by, change: 'added', note: c.note }] });
        rb.boxes.push(nb); byId.set(nb.id, nb); applied++; continue;
      }
      if (!b) { conflicts.push({ change: c, reason: 'no such box' }); continue; }
      if (c.baseRev != null && (b.rev || 1) > c.baseRev && b.pinned && (b.source === 'editor' || (b.sources || []).includes('editor')) && c.by !== 'editor') { conflicts.push({ change: c, reason: 'box changed in the editor since rev ' + c.baseRev }); continue; }
      if (c.op === 'confirm') { b.verified = true; hist(b, 'confirmed'); }
      else if (c.op === 'delete') { b.deleted = true; b.pinned = true; hist(b, 'deleted'); }
      else if (c.op === 'move') { for (const k of ['lat', 'lon', 'km']) if (c[k] != null) b[k] = c[k]; b.verified = true; b.pinned = true; hist(b, 'moved'); }
      else if (c.op === 'update') { Object.assign(b, c.fields || {}); b.verified = c.by !== 'recce-auto' || b.verified; b.pinned = true; hist(b, 'updated ' + Object.keys(c.fields || {}).join(',')); }
      else { conflicts.push({ change: c, reason: 'unknown op' }); continue; }
      b.sources = [...new Set((b.sources || [b.source]).concat([c.by]))];
      applied++;
    }
    rb.conflicts.push(...conflicts);
    rb.revision = (rb.revision || 1) + 1;
    renumber(rb);
    return { rb, applied, conflicts };
  }

  // ---------------------------------------------------------------- recce files (the game's recce mode)
  // {format: 'rallyraid-recce', schemaVersion, stage: {id, hash}, roadbook: {id, revision}, driven: {stepM, points:
  // [[lat, lon, km]], breaks: [index of the first point of a new piece], km}, changes: [...], applied: [...]}
  // The game's JSON writer may write an empty list as {} and a list as {"1": ...}: lists are normalised here.
  const asList = x => Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]) : []);
  function readRecce(doc, rb) {
    const errors = [], warnings = [];
    if (!doc || doc.format !== 'rallyraid-recce') return { errors: ['not a recce file (format "rallyraid-recce")'], warnings, changes: [], driven: { points: [], breaks: [] }, applied: [] };
    if ((doc.schemaVersion || 1) > 1) errors.push('recce schemaVersion ' + doc.schemaVersion + ' is newer than this editor');
    const st = doc.stage || {}, rs = (rb && rb.stage) || {};
    if (st.id && rs.id && st.id !== rs.id) errors.push('recorded on stage ' + st.id + ', this roadbook is for ' + rs.id);
    if (st.hash && rs.hash && st.hash !== rs.hash) warnings.push('recorded on another version of the stage (the route changed since): positions are kept, km may be off');
    const rrev = doc.roadbook && doc.roadbook.revision;
    if (rb && rrev != null && (rb.revision || 1) > rrev) warnings.push('the roadbook changed since the recce read it (rev ' + rrev + ' \u2192 ' + rb.revision + '): changes on boxes edited in between become conflicts');
    const fix = c => { c = JSON.parse(JSON.stringify(c)); if (c.box) { c.box.symbols = asList(c.box.symbols); c.box.features = asList(c.box.features); } if (c.fields && c.fields.symbols) c.fields.symbols = asList(c.fields.symbols); return c; };
    const d = doc.driven || {};
    return { errors, warnings, changes: asList(doc.changes).map(fix), applied: asList(doc.applied).map(fix),
      driven: { stepM: d.stepM, km: d.km, points: asList(d.points).map(asList), breaks: asList(d.breaks).map(Number) }, doc };
  }
  // what each change would do to this roadbook, in order, without touching it: ok / conflict (reason) / done (already in)
  function previewChanges(rb, changes) {
    const clone = JSON.parse(JSON.stringify(rb)); clone.conflicts = [];
    return changes.map(c => {
      const b = clone.boxes.find(x => x.id === c.id);
      if (b && c.at && (b.history || []).some(h => h.at === c.at && h.by === c.by)) return { status: 'done', reason: 'already in this roadbook' };
      const r = applyChanges(clone, [c]);
      return r.conflicts.length ? { status: 'conflict', reason: r.conflicts[0].reason } : { status: 'ok' };
    });
  }
  function describeChange(c, rb) {
    const b = rb && rb.boxes.find(x => x.id === c.id);
    const where = b ? 'box ' + (b.deleted ? '(deleted)' : b.n) + ' at ' + (+b.km).toFixed(2) + ' km' + (b.notes ? ' "' + String(b.notes).slice(0, 40) + '"' : '') : 'box ' + c.id;
    const who = c.by === 'recce-auto' ? ' (detected)' : c.by === 'recce-manual' ? ' (driver)' : '';
    if (c.op === 'add') { const x = c.box || {}; return 'New box at ' + (+x.km || 0).toFixed(2) + ' km: ' + ((x.notes || (x.symbols || []).join(', ')) || 'NOTE') + (x.danger ? ' ' + '!'.repeat(x.danger) : '') + who; }
    if (c.op === 'confirm') return 'Confirm ' + where + who;
    if (c.op === 'delete') return 'Delete ' + where + who;
    if (c.op === 'move') return 'Move ' + where + (b && b.lat != null && c.lat != null ? ' by ' + Math.round(dist([b.lat, b.lon], [c.lat, c.lon])) + ' m' : '') + (c.km != null ? ' (to ' + (+c.km).toFixed(2) + ' km)' : '') + who;
    if (c.op === 'update') { const f = c.fields || {}; return 'Retag ' + where + ': ' + [f.notes, (f.symbols || []).join(', '), f.danger ? '!'.repeat(f.danger) : ''].filter(Boolean).join(' \u00b7 ') + who; }
    return c.op + ' ' + where;
  }
  // re-measure km from the driven line (the same rule as the game's recce merge, rallyRaid/recce.lua M.rescale):
  // boxes within maxOffM of the line get the distance driven to them, counted from the first box on the line (which
  // keeps its km); boxes off the line are spaced in proportion between those. Returns the number of boxes on the line.
  function rescaleToDriven(rb, driven, maxOffM) {
    maxOffM = maxOffM || 60;
    const pts = asList(driven && driven.points); if (pts.length < 2) return 0;
    const brk = new Set(asList(driven.breaks).map(Number));
    const kx = 111320 * Math.cos(pts[0][0] * Math.PI / 180), ky = 110540;
    const onLine = (lat, lon) => {
      let best = null, bd = maxOffM; const px = lon * kx, py = lat * ky;
      for (let i = 1; i < pts.length; i++) {
        if (brk.has(i + 1)) continue;                  // Lua indexes from 1: a break at point i+1 starts a new piece
        const a = pts[i - 1], b = pts[i], ax = a[1] * kx, ay = a[0] * ky, vx = b[1] * kx - ax, vy = b[0] * ky - ay, L = vx * vx + vy * vy;
        const u = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L)) : 0;
        const d = Math.hypot(ax + vx * u - px, ay + vy * u - py);
        if (d < bd) { bd = d; best = a[2] + (b[2] - a[2]) * u; }
      }
      return best;
    };
    const live = rb.boxes.filter(b => !b.deleted && isFinite(b.km)).sort((a, b) => a.km - b.km);
    const m = []; let last = -1;
    live.forEach((b, i) => { if (b.lat != null && b.lon != null) { const k = onLine(b.lat, b.lon); if (k != null && k >= last) { m[i] = k; last = k; } } });
    const first = m.findIndex(x => x != null); if (first < 0) return 0;
    const base = live[first].km, off = m[first], nk = []; let n = 0;
    live.forEach((b, i) => { if (m[i] != null) { nk[i] = base + (m[i] - off); n++; } });
    let prev = null;
    for (let i = 0; i < live.length; i++) {
      if (nk[i] != null) { prev = i; continue; }
      let nxt = null; for (let j = i + 1; j < live.length; j++) if (nk[j] != null) { nxt = j; break; }
      if (prev != null && nxt != null) { const span = live[nxt].km - live[prev].km, u = span > 0 ? (live[i].km - live[prev].km) / span : 0; nk[i] = nk[prev] + (nk[nxt] - nk[prev]) * u; }
      else if (prev != null) nk[i] = nk[prev] + (live[i].km - live[prev].km);
      else nk[i] = live[i].km;
    }
    const at = new Date().toISOString();
    live.forEach((b, i) => { const k = Math.round(nk[i] * 1000) / 1000; if (Math.abs(k - b.km) >= 0.001) { b.history = (b.history || []).concat([{ rev: b.rev || 1, at, by: 'recce', change: 'km ' + b.km.toFixed(2) + ' -> ' + k.toFixed(2) + ' (driven line)' }]); b.km = k; } });
    rb.recce = { drivenKm: driven.km, matched: n, at };
    renumber(rb);
    return n;
  }

  return { VERSION, GENERATOR, planLegGaps, checkLine, lineHazards, coverObstacle, offPieces, offRuns, migrateStageNotes, mergeRegenerated, applyChanges, readRecce, previewChanges, describeChange, rescaleToDriven, renumber, DEFAULTS, DEM_SOURCES, generate, resampleRoute, routeBoxes, planOffPiste, planLeg, applyPlannedLine, corridorBoxes, obstacleQuery, analyseProfile, analyseOsm, assemble, bends, createDem, fetchOsm, overpassQuery, askOverpass, overpassOrder, defaultOverpass, overpassStatus, queryVariant, landmarkQuery, landmarkBoxes, landformQuery, landformBoxes, fetchLandmarks, fetchChunks, landmarkKind, prepLandmarks, landmarkFeatures, enrichBoxes, createLandCover, coverAlong, coverFeatures, rockFeatures, alongWaterFeatures, gateTerrain, gradeSigma, worldCoverItem, LANDCOVER, LC_GROUP, TRACK_CODE, junctionNote, projector, stageHash, trackClass, describe,
    geo: { dist, bearing, dest, rel, simplify, projector }, makeSandIndex, sandQuery, fetchSand, heightReversalMask, legInDuneField, sampleLegLine, planLegRecce, capLabel, suggestWpType };
});
