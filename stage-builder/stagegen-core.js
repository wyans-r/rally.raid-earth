/* Rally Raid Stage-Gen core (B4), v1.2.0: automatic stage routes between a DSS and an ASS.
 *
 * Pure logic, no DOM: runs in the browser (window.StageGen, needs window.RoadbookGen loaded first) and in node
 * (require(...)(RoadbookGen)). The web builder's UI is stagegen.js; the in-game planner can reuse this file as it is.
 *
 *   1. region   : the ellipse every route of the target length must stay inside (foci DSS and ASS), as a cost grid.
 *   2. data     : OpenStreetMap (Overpass, through the same helper the roadbook generator uses, so the mirrors apply;
 *                 0.5 degree tiles on a fixed world grid so answers are reused, fetched two at a time; a tile that fails
 *                 twice is split into 0.25 degree quarters, each tried 4 times; one that never answers leaves a gap
 *                 with a warning instead of failing the whole generate), heights (Mapterhorn, coarse zoom) and
 *                 land cover (ESA WorldCover).
 *   3. costs    : off-piste cost per cell from land cover, slope, sand, water / trees / buildings / towns / fences;
 *                 piste = an OSM track graph with only unpaved, non-highway ways outside towns.
 *   4. search   : A* over the grid + track graph together; seeded via points stretch the route to the target length
 *                 (solved numerically); the off-piste weight is tuned towards the wanted piste / off-piste split.
 *   5. options  : 3 different shapes (left / right / zig-zag, or loops), later ones penalised for reusing earlier ones.
 *   6. stage    : the picked option becomes a normal stage file (docs/STAGE_FORMAT.md): DSS, ASS, WPM / WPV / WPS
 *                 (+ DZ / FZ if a village cannot be avoided) and a few NOTE (Route) points only where they pin a
 *                 corridor or a track the roadbook planner would not pick on its own; off-piste legs are planned in
 *                 detail with the roadbook generator's own planner (same seed), so the roadbook editor draws the same line.
 *   7. blind    : seeded and deterministic; a public receipt (commitment), a private seed file to publish afterwards,
 *                 and verify() to check that the published seed reproduces the distributed stage.
 *
 * Network goes through an injected io: { overpass(q), fetchBytes(url), decodeImage(buf), sha256(text), log, progress }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.StageGen = factory(root.RoadbookGen);
})(typeof self !== 'undefined' ? self : this, function (RB) {
  'use strict';
  const VERSION = '1.2.0';
  const LEGACY_NOTE_VERSIONS = { '1.0.0': 1, '1.1.0': 1 };
  const GENERATOR = 'rallyraid-stagegen ' + VERSION;
  if (!RB) throw new Error('StageGen needs RoadbookGen (roadbook-gen.js)');

  // ------------------------------------------------------------------ defaults (every tunable value in one place)
  const PRESETS = {
    mixed: { label: 'Mixed', offShare: 0.40, lambda: 1.0, sandF: 0.85, note: 'tracks and open terrain, about 60 / 40' },
    dunes: { label: 'Dunes', offShare: 0.70, lambda: 0.6, sandF: 0.6, note: 'mostly open terrain, sand and dunes preferred' },
    piste: { label: 'Piste', offShare: 0.15, lambda: 2.0, sandF: 1.0, note: 'mostly unpaved tracks' }
  };
  const DEFAULTS = {
    options: 3,
    tolerance: 0.10,          // the route must be within +-10 % of the target length
    aim: 0.035,               // ... and the length solver stops when within +-3.5 %
    maxEvals: 10,             // length solver: tries per option and split round
    splitRounds: 5,           // rounds tuning the off-piste weight towards the wanted split
    splitSlack: 0.10,         // accept the split within +-10 points
    maxCells: 70000, minCell: 120, maxCell: 450, marginM: 2500, maxRegionKm: 170,
    osmTileDeg: 0.5,          // first try; a tile that fails osmSplitAfter times is split into 0.25 deg quarters
    osmMinTileDeg: 0.25,
    osmSplitAfter: 2,
            // Overpass tiles on a fixed world grid (cache friendly); only tiles touching the ellipse
    osmTimeoutS: 60,          // Overpass [timeout:] for one tile (the client waits a little longer, see stagegen.js)
    osmConcurrency: 2,        // tiles in flight at once (public servers allow about 2 per user)
    osmTries: 4,              // tries per tile (each try asks the mirrors in turn) ...
    osmBackoffMs: [6000, 15000, 30000],   // ... with these pauses between them
    osmBudgetMs: 240000,      // after 4 minutes no new retries: the tiles still missing are left out (with a warning)
    pisteCost: 0.55,          // cost per metre on a track (off-piste on bare ground costs 1 x lambda)
    transferCost: 90,         // leaving / joining a track (m equivalent): stops the line flickering on and off a track
    townCost: 60, roadNearF: 3, roadCrossCost: 250, fenceCost: 900,
    slopeCost: 60, slopeFree: 0.04, maxSlope: 0.32, climbCost: 2.5, descentCost: 0.4,
    noiseAmp: 0.35, noiseCellM: 2500,
    reusePen: 1.6,            // same route: cells already used by an earlier part of it (brief reuse stays possible)
    diversityPen: 2.2,        // later options: cells used by earlier options
    duneRelief: 3.5, duneMaxSlope: 0.16,
    townRadius: { city: 4000, town: 2000, village: 800, hamlet: 300 },
    landCover: { 0: 1.2, 10: Infinity, 95: Infinity, 20: 1.6, 30: 1.25, 40: 6, 50: 'town', 60: 1.0, 70: 3, 80: Infinity, 90: Infinity, 100: 2 },
    // waypoints (FIM 2026 types; radii / penalties stay the builder's FIM defaults)
    wp: { wpmMinOffKm: 3, wpmEveryKm: 10, wpvPisteKm: 15, minGapM: 1200, maxSubLegKm: 5, minSubLegM: 400, dzSpeed: 50, dzBeforeM: 300, density: 4, thinNotes: true, pinTolM: 400, wanderSlackM: 400 },
    simplifyCells: 1.2,
    demZoomCoarse: 10, demZoomFine: 11, lcZoomCoarse: 11, lcZoomFine: 12,
    fine: true                // plan off-piste legs in detail (roadbook planner, 30 m cells, buildings / fences)
  };
  const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'chipseal', 'metal', 'cobblestone', 'unhewn_cobblestone', 'bricks']);
  const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'earth', 'ground', 'sand', 'mud', 'rock', 'pebblestone', 'grass', 'salt', 'stone', 'shells', 'clay', 'dirt;sand', 'sand;gravel']);
  const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;

  /** what a way is for Stage-Gen: 'ok' (a piste we may drive along), 'road' (asphalt / highway: cross only), null */
  function pisteClass(t) {
    if (!t || !t.highway) return null;
    const hw = t.highway, sf = t.surface;
    if (MAJOR.test(hw)) return 'road';
    if (sf && PAVED.has(sf)) return 'road';
    if (hw === 'track') return 'ok';
    if (/^(tertiary|tertiary_link|unclassified|road|service)$/.test(hw)) return sf && UNPAVED.has(sf) ? 'ok' : 'road';
    return 'road';
  }

  // ------------------------------------------------------------------ small helpers
  const { dist, bearing, projector } = RB.geo;
  const rad = d => d * Math.PI / 180;
  function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seedStr) { let a = hash32(String(seedStr)); return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function noise2(seed, cellM) {
    const v = (i, j) => (hash32(seed + ':' + i + ':' + j) % 10007) / 10006, sm = t => t * t * (3 - 2 * t);
    return (x, y) => { const fx = x / cellM, fy = y / cellM, i = Math.floor(fx), j = Math.floor(fy), tx = sm(fx - i), ty = sm(fy - j);
      return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty; };
  }
  const r6 = x => Math.round(x * 1e6) / 1e6;
  const polyLen = pts => { let m = 0; for (let i = 1; i < pts.length; i++) m += dist(pts[i - 1], pts[i]); return m; };
  function capOf(pts) { // as the builder: heading towards the point ~40 m along
    if (!pts || pts.length < 2) return null;
    let acc = 0; for (let i = 1; i < pts.length; i++) { acc += dist(pts[i - 1], pts[i]); if (acc >= 40) return bearing(pts[0], pts[i]); }
    return bearing(pts[0], pts[pts.length - 1]);
  }
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
  /** canonical JSON (sorted keys) for hashing */
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  async function sha256(text, io) {
    if (io && io.sha256) return io.sha256(text);
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : require('crypto').webcrypto.subtle;
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  function newSeed() {
    const b = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b); else require('crypto').randomFillSync(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------ inputs
  /** clean, canonical inputs: {dss:[lat,lon], ass:[lat,lon], lengthKm, preset, offShare, region} */
  function normInputs(inp) {
    const P = PRESETS[inp.preset] ? inp.preset : 'mixed';
    const off = inp.offShare != null && isFinite(+inp.offShare) ? Math.max(0, Math.min(1, +inp.offShare)) : PRESETS[P].offShare;
    const ll = p => [r6(+p[0]), r6(+p[1])];
    return { dss: ll(inp.dss), ass: ll(inp.ass), lengthKm: Math.round(+inp.lengthKm * 10) / 10, preset: P, offShare: Math.round(off * 100) / 100, region: String(inp.region || '').trim().slice(0, 80) };
  }
  function checkInputs(inp) {
    const errs = [];
    if (!inp.dss || !inp.ass || !inp.dss.every(isFinite) || !inp.ass.every(isFinite)) errs.push('Place the DSS (start) and the ASS (finish).');
    if (!(inp.lengthKm >= 5)) errs.push('The target length must be at least 5 km.');
    if (inp.lengthKm > DEFAULTS.maxRegionKm * 1.2) errs.push('One Stage-Gen run makes stages up to ' + Math.round(DEFAULTS.maxRegionKm * 1.2) + ' km; longer stages are built as a chain of parts (stage-chain.js).');
    if (!errs.length) {
      const D = dist(inp.dss, inp.ass) / 1000;
      if (D > inp.lengthKm * 0.95) errs.push('The target length (' + inp.lengthKm + ' km) is shorter than the straight line from DSS to ASS (' + D.toFixed(1) + ' km). Make it at least ' + Math.ceil(D * 1.15) + ' km.');
    }
    return errs;
  }

  // ------------------------------------------------------------------ region
  function regionFor(inp, o) {
    const A = inp.dss, B = inp.ass, D = dist(A, B), L = Math.max(inp.lengthKm * 1000, D * 1.05);
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], P = projector(mid[0]);
    const a = Math.min(L / 2, o.maxRegionKm * 500), c = D / 2, b = Math.sqrt(Math.max(a * a - c * c, (0.35 * a) ** 2));
    const th = rad(90 - bearing(A, B));     // axis angle from east, counter-clockwise
    const ex = Math.sqrt((a * Math.cos(th)) ** 2 + (b * Math.sin(th)) ** 2) + o.marginM, ey = Math.sqrt((a * Math.sin(th)) ** 2 + (b * Math.cos(th)) ** 2) + o.marginM;
    const m = P.xy(mid);
    const W = 2 * ex, H = 2 * ey;
    const cell = Math.max(o.minCell, Math.min(o.maxCell, Math.sqrt(W * H / o.maxCells)));
    const NX = Math.ceil(W / cell), NY = Math.ceil(H / cell);
    const x0 = m[0] - NX * cell / 2, y0 = m[1] - NY * cell / 2;
    const sw = P.ll([x0, y0]), ne = P.ll([x0 + NX * cell, y0 + NY * cell]);
    return { P, cell, NX, NY, x0, y0, bbox: [sw[0], sw[1], ne[0], ne[1]], D, L, mid, a, b, c, th, m };
  }

  // ------------------------------------------------------------------ OpenStreetMap
  function osmTiles(bbox, deg) {
    const out = [];
    for (let s = Math.floor(bbox[0] / deg) * deg; s < bbox[2]; s += deg)
      for (let w = Math.floor(bbox[1] / deg) * deg; w < bbox[3]; w += deg) out.push([+s.toFixed(4), +w.toFixed(4), +(s + deg).toFixed(4), +(w + deg).toFixed(4)]);
    return out;
  }
  /* One query per tile. Forests, fields, large lakes and built-up land come from ESA WorldCover, so OSM is only asked for
   * what land cover cannot see: tracks / roads, fences, cliffs, small water, sand areas, towns and villages. */
  // (v1.1: no residential / commercial / farmland landuse any more: they made town tiles huge, and towns come from the
  // place nodes and WorldCover's built-up class anyway. Service ways stay: many desert farm / access tracks are tagged so.)
  function osmQuery(t, o) {
    const B = '(' + t.map(x => x.toFixed(4)).join(',') + ')';
    return '[out:json][timeout:' + ((o && o.osmTimeoutS) || 60) + '];(' +
      'way[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|road|track|service)$"]' + B + ';' +
      'way[natural~"^(water|wetland|sand|dune|cliff|beach)$"]' + B + ';' +
      'way[landuse~"^(military|quarry)$"]' + B + ';' +
      'way[barrier~"^(fence|wall)$"]' + B + ';way[aeroway=aerodrome]' + B + ';' +
      ');out body geom qt;' +
      'node[place~"^(city|town|village|hamlet)$"]' + B + ';out body qt;';
  }
  const KEEP_TAGS = ['highway', 'surface', 'tracktype', 'natural', 'landuse', 'waterway', 'barrier', 'aeroway', 'place', 'name', 'name:en'];
  function compactOsm(results) {
    const ways = new Map(), rels = new Map(), places = new Map();
    const tagsOf = t => { const o = {}; for (const k of KEEP_TAGS) if (t && t[k] != null) o[k] = String(t[k]); return o; };
    for (const r of results) for (const e of (r.elements || [])) {
      if (e.type === 'way' && e.geometry) {
        if (ways.has(e.id)) continue;
        ways.set(e.id, { id: e.id, t: tagsOf(e.tags), n: e.nodes || [], g: e.geometry.map(p => p ? [r6(p.lat), r6(p.lon)] : null) });
      } else if (e.type === 'relation' && e.members) {
        if (rels.has(e.id)) continue;
        const segs = e.members.filter(m => m.type === 'way' && m.geometry && m.geometry.length > 1).map(m => m.geometry.filter(Boolean).map(p => [r6(p.lat), r6(p.lon)]));
        if (segs.length) rels.set(e.id, { id: e.id, t: tagsOf(e.tags), segs });
      } else if (e.type === 'node' && e.tags && e.tags.place) {
        if (!places.has(e.id)) places.set(e.id, { id: e.id, t: tagsOf(e.tags), ll: [r6(e.lat), r6(e.lon)] });
      }
    }
    const byId = (a, b) => a.id - b.id;
    return { ways: [...ways.values()].sort(byId), rels: [...rels.values()].sort(byId), places: [...places.values()].sort(byId) };
  }
  /** does a tile touch the region's ellipse (plus its margin)? */
  function touches(G, o, t) {
    const grow = o.marginM, c = Math.cos(G.th), sn = Math.sin(G.th);
    const inside = ll => { const q = G.P.xy(ll), dx = q[0] - G.m[0], dy = q[1] - G.m[1], u = dx * c + dy * sn, v = -dx * sn + dy * c;
      return (u / (G.a + grow)) ** 2 + (v / (G.b + grow)) ** 2 <= 1; };
    const mid = G.P.ll(G.m);
    if (mid[0] >= t[0] && mid[0] <= t[2] && mid[1] >= t[1] && mid[1] <= t[3]) return true;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) if (inside([t[0] + (t[2] - t[0]) * i / 8, t[1] + (t[3] - t[1]) * j / 8])) return true;
    return false;
  }
  /** the world-grid tiles that touch the region's ellipse (plus its margin) */
  function osmTilesFor(G, o, deg) { return osmTiles(G.bbox, deg || o.osmTileDeg).filter(t => touches(G, o, t)); }
  /** a tile's four quarters (on the finer world grid) that still touch the ellipse */
  function quarters(G, o, t) {
    const h = (t[2] - t[0]) / 2, out = [];
    for (const s of [t[0], t[0] + h]) for (const w of [t[1], t[1] + h]) out.push([+s.toFixed(4), +w.toFixed(4), +(s + h).toFixed(4), +(w + h).toFixed(4)]);
    return out.filter(q => touches(G, o, q));
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tileKey = t => t.join(',');
  /**
   * OpenStreetMap for the region, in world-grid tiles (0.5 deg), two at a time. The public Overpass servers are often
   * overloaded, so: a tile that fails twice is split into its four 0.25 deg quarters (smaller answers get through more
   * easily); a smallest tile is tried up to osmTries times with pauses. A tile that never answers is left out
   * (osm.missing) and generate() warns; only when nothing at all answers does it fail, in plain words.
   * osm.tiles (the tiles that make up the data) and osm.missing are part of the data and of its hash, so a blind stage
   * made with a gap regenerates the same from its seed file.
   */
  async function loadOsm(G, o, io) {
    const log = io.log || (() => {}), t0 = Date.now();
    const queue = osmTilesFor(G, o).map(t => ({ t, tries: 0 })), got = [], missing = [];
    let done = 0, total = queue.length, active = 0, retrying = 0, lastErr = null;
    const report = () => io.progress && io.progress('osm', done, total, 'map data (OpenStreetMap): ' + done + ' of ' + total + ' tiles' + (retrying ? ', ' + retrying + ' retrying (the map servers are slow)' : ''));
    report();
    const canSplit = t => t[2] - t[0] > o.osmMinTileDeg + 1e-9;
    async function one(job) {
      const t = job.t, big = canSplit(t), tries = big ? o.osmSplitAfter : o.osmTries;
      for (let a = 0; a < tries; a++) {
        try {
          const r = await io.overpass(osmQuery(t, o), { attempt: a });
          if (r && r.remark && /error|timed out|out of memory|runtime/i.test(r.remark)) throw new Error('server: ' + r.remark.slice(0, 120));
          got.push({ t, r }); return;
        } catch (e) {
          lastErr = e; log('map tile ' + tileKey(t) + ' try ' + (a + 1) + ': ' + (e && e.message));
          if (/^offline/.test(e && e.message)) break;
          if (a === tries - 1 || Date.now() - t0 > o.osmBudgetMs) break;
          retrying++; report(); await sleep(o.osmBackoffMs[Math.min(a, o.osmBackoffMs.length - 1)]); retrying--; report();
        }
      }
      if (big && !/^offline/.test(lastErr && lastErr.message) && Date.now() - t0 <= o.osmBudgetMs) {
        const qs = quarters(G, o, t); log('map tile ' + tileKey(t) + ': splitting into ' + qs.length + ' smaller tiles');
        total += qs.length - 1; for (const q of qs) queue.push({ t: q, tries: 0 }); return 'split';
      }
      missing.push(t);
    }
    const worker = async () => {
      while (queue.length || active) {
        if (!queue.length) { await sleep(25); continue; }
        const job = queue.shift(); active++;
        try { if (await one(job) !== 'split') done++; } finally { active--; }
        report();
      }
    };
    await Promise.all(Array.from({ length: o.osmConcurrency }, worker));
    if (!got.length) {
      const err = new Error('The OpenStreetMap servers did not answer (' + missing.length + ' map tiles, tried over ' + Math.round((Date.now() - t0) / 1000) + ' s). They are often overloaded; try again in a few minutes. Nothing you entered is lost.');
      err.code = 'osm-unavailable'; err.cause = lastErr; throw err;
    }
    const byT = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    got.sort((a, b) => byT(a.t, b.t));
    const osm = compactOsm(got.map(x => x.r));
    osm.missing = missing.sort(byT);
    osm.tiles = got.map(x => x.t).concat(osm.missing).sort(byT);
    return osm;
  }

  // ------------------------------------------------------------------ raster helpers
  function cellOf(G, x, y) { const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((y - G.y0) / G.cell); return (i < 0 || j < 0 || i >= G.NX || j >= G.NY) ? -1 : j * G.NX + i; }
  function cellXY(G, k) { const i = k % G.NX, j = (k - i) / G.NX; return [G.x0 + (i + 0.5) * G.cell, G.y0 + (j + 0.5) * G.cell]; }
  function cellLL(G, k) { return G.P.ll(cellXY(G, k)); }
  /** even-odd fill of a set of rings / segment chains (holes work), calls fn(k) for every cell centre inside */
  function fillPoly(G, chains, fn) {
    const segs = []; let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const ch of chains) { const xy = ch.filter(Boolean).map(p => G.P.xy(p)); for (let k = 1; k < xy.length; k++) segs.push([xy[k - 1], xy[k]]); for (const q of xy) { mnx = Math.min(mnx, q[0]); mxx = Math.max(mxx, q[0]); mny = Math.min(mny, q[1]); mxy = Math.max(mxy, q[1]); } }
    if (!segs.length) return;
    const j0 = Math.max(0, Math.floor((mny - G.y0) / G.cell)), j1 = Math.min(G.NY - 1, Math.floor((mxy - G.y0) / G.cell));
    let any = false;
    for (let j = j0; j <= j1; j++) {
      const y = G.y0 + (j + 0.5) * G.cell, xs = [];
      for (const [p, q] of segs) if ((p[1] > y) !== (q[1] > y)) xs.push(p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
      xs.sort((a, b) => a - b);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - G.x0) / G.cell - 0.5)), i1 = Math.min(G.NX - 1, Math.floor((xs[n + 1] - G.x0) / G.cell - 0.5));
        for (let i = i0; i <= i1; i++) { fn(j * G.NX + i); any = true; }
      }
    }
    // a polygon smaller than a cell: mark the cell it sits in
    if (!any && mxx - mnx < G.cell * 1.5 && mxy - mny < G.cell * 1.5) { const k = cellOf(G, (mnx + mxx) / 2, (mny + mxy) / 2); if (k >= 0) fn(k); }
  }
  function drawLine(G, pts, fn) {
    const xy = pts.filter(Boolean).map(p => G.P.xy(p)), step = G.cell / 2;
    let last = -2;
    for (let k = 1; k < xy.length; k++) {
      const [ax, ay] = xy[k - 1], [bx, by] = xy[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let s = 0; s <= n; s++) { const c = cellOf(G, ax + (bx - ax) * s / n, ay + (by - ay) * s / n); if (c >= 0 && c !== last) { fn(c); last = c; } }
    }
  }
  const isClosed = g => g.length > 3 && g[0] && g[g.length - 1] && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];

  // ------------------------------------------------------------------ the cost grid (data that does not depend on the seed)
  const F_TOWN = 1, F_ROAD = 2, F_FENCE = 4, F_SAND = 8, F_DUNE = 16, F_WATER = 32, F_BLOCK = 64, F_FIELD = 128;
  async function buildGrid(inp, o, io, data) {
    const G = regionFor(inp, o), NC = G.NX * G.NY;
    G.NC = NC;
    const log = io.log || (() => {});
    // 1. OpenStreetMap
    const osm = data && data.osm ? data.osm : await loadOsm(G, o, io);
    G.osm = osm;
    // v1.1 data: cells outside every map tile asked for lie outside the ellipse: no route goes there. Cells inside a
    // tile that did not answer are kept (open ground as far as we know) and counted for the warning.
    G.outside = null; G.unmapped = 0;
    if (osm.tiles) {
      const inT = (ll, ts) => ts.some(t => ll[0] >= t[0] && ll[0] < t[2] && ll[1] >= t[1] && ll[1] < t[3]);
      G.outside = new Uint8Array(NC);
      for (let k = 0; k < NC; k++) { const ll = cellLL(G, k); if (!inT(ll, osm.tiles)) G.outside[k] = 1; else if (osm.missing.length && inT(ll, osm.missing)) G.unmapped++; }
    }
    // 2. heights (coarse Mapterhorn zoom: a pixel is about half a cell)
    const zDem = G.cell >= 200 ? o.demZoomCoarse : o.demZoomFine;
    const srcs = RB.DEM_SOURCES.map((s, i) => Object.assign({}, s, { zoom: zDem + (i ? 1 : 0) }));
    const dem = RB.createDem({ fetchBytes: io.fetchBytes, decodeImage: io.decodeImage, sources: srcs, concurrency: 6 });
    const centres = new Array(NC); for (let k = 0; k < NC; k++) centres[k] = cellLL(G, k);
    if (io.progress) io.progress('terrain', 0, 1, 'terrain heights');
    await dem.load(centres.filter((_, k) => (k % G.NX) % 3 === 0 && Math.floor(k / G.NX) % 3 === 0).concat([centres[0], centres[NC - 1], cellLL(G, G.NX - 1), cellLL(G, NC - G.NX)]), (d, t) => io.progress && io.progress('terrain', d, t));
    const H = new Float32Array(NC); let nan = 0;
    for (let k = 0; k < NC; k++) { const v = dem.h(centres[k][0], centres[k][1]); if (Number.isFinite(v)) H[k] = Math.round(v * 10) / 10; else { H[k] = 0; nan++; } }
    if (nan) log('terrain: ' + nan + ' cells without height');
    G.H = H; G.demZoom = zDem; G.demFailures = dem.failures; G.demMissing = nan;
    // 3. land cover (majority of 5 samples per cell)
    const zLc = G.cell >= 200 ? o.lcZoomCoarse : o.lcZoomFine;
    const lc = RB.createLandCover({ fetchBytes: io.fetchBytes, decodeImage: io.decodeImage, source: Object.assign({}, RB.LANDCOVER, { zoom: zLc }), maxFailures: 40 });
    const q = G.cell / 4, offs = [[0, 0], [-q, -q], [q, -q], [-q, q], [q, q]];
    const lcPts = []; for (let k = 0; k < NC; k++) { const [x, y] = cellXY(G, k); lcPts.push(G.P.ll([x - q, y - q])); lcPts.push(G.P.ll([x + q, y + q])); }
    if (io.progress) io.progress('landcover', 0, 1, 'land cover');
    await lc.load(lcPts, (d, t) => io.progress && io.progress('landcover', d, t));
    const LC = new Uint8Array(NC);
    for (let k = 0; k < NC; k++) {
      const [x, y] = cellXY(G, k), cnt = {}; let best = 0, bn = 0;
      for (const [dx, dy] of offs) { const ll = G.P.ll([x + dx, y + dy]); const v = lc.at(ll[0], ll[1]); cnt[v] = (cnt[v] || 0) + 1; }
      for (const v of Object.keys(cnt).map(Number).sort((a, b) => a - b)) { const n = cnt[v] + (v === 50 || v === 80 ? 1 : 0); if (v && n > bn) { bn = n; best = v; } }   // built / water win ties
      LC[k] = best;
    }
    G.LC = LC; G.lcZoom = zLc; G.lcLoaded = lc.loaded; G.lcFailures = lc.failures;
    // 4. flags from OSM
    const FL = new Uint8Array(NC), OSMF = new Float32Array(NC).fill(1);
    if (G.outside) for (let k = 0; k < NC; k++) if (G.outside[k]) FL[k] |= F_BLOCK;
    // no-go areas (opts.avoid: polygons [[lat, lon], ...], e.g. a border strip): impassable, and no track through them
    G.avoidMask = null;
    if (o.avoid && o.avoid.length) {
      const polys = o.avoid.filter(p => p && p.length >= 3).map(p => ({ p, s: Math.min(...p.map(q => q[0])), n: Math.max(...p.map(q => q[0])), w: Math.min(...p.map(q => q[1])), e: Math.max(...p.map(q => q[1])) }))
        .filter(b => !(b.n < G.bbox[0] || b.s > G.bbox[2] || b.e < G.bbox[1] || b.w > G.bbox[3]));
      const inPoly = (ll, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { if ((P[i][0] > ll[0]) !== (P[j][0] > ll[0]) && ll[1] < (P[j][1] - P[i][1]) * (ll[0] - P[i][0]) / (P[j][0] - P[i][0]) + P[i][1]) c = !c; } return c; };
      if (polys.length) { G.avoidMask = new Uint8Array(NC); for (let k = 0; k < NC; k++) { const ll = cellLL(G, k); for (const b of polys) if (ll[0] >= b.s && ll[0] <= b.n && ll[1] >= b.w && ll[1] <= b.e && inPoly(ll, b.p)) { G.avoidMask[k] = 1; FL[k] |= F_BLOCK; break; } } }
    }
    const polyKind = t => {
      if (t.natural === 'water' || t.natural === 'wetland' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
      if (t.natural === 'wood' || t.landuse === 'forest' || t.landuse === 'orchard' || t.landuse === 'military' || t.landuse === 'cemetery' || t.landuse === 'quarry' || t.landuse === 'landfill' || t.aeroway) return 'block';
      if (/^(residential|industrial|commercial|retail)$/.test(t.landuse || '')) return 'town';
      if (t.natural === 'sand' || t.natural === 'dune' || t.natural === 'beach') return 'sand';
      if (t.natural === 'scrub') return 'scrub';
      if (/^(farmland|farmyard|greenhouse_horticulture)$/.test(t.landuse || '')) return 'field';
      return null;
    };
    const apply = (kind, k) => {
      if (kind === 'water') FL[k] |= F_WATER; else if (kind === 'block') FL[k] |= F_BLOCK; else if (kind === 'town') FL[k] |= F_TOWN;
      else if (kind === 'sand') FL[k] |= F_SAND; else if (kind === 'scrub') OSMF[k] = Math.max(OSMF[k], 1.6); else if (kind === 'field') FL[k] |= F_FIELD;
    };
    for (const w of osm.ways) {
      const t = w.t;
      if (t.highway) { if (pisteClass(t) === 'road') drawLine(G, w.g, k => { FL[k] |= F_ROAD; }); continue; }
      if (t.barrier) { drawLine(G, w.g, k => { FL[k] |= F_FENCE; }); continue; }
      if (t.natural === 'cliff') { drawLine(G, w.g, k => { FL[k] |= F_BLOCK; }); continue; }
      const kind = polyKind(t); if (!kind) continue;
      if (isClosed(w.g)) fillPoly(G, [w.g], k => apply(kind, k));
      else if (kind === 'water' || kind === 'block') drawLine(G, w.g, k => apply(kind, k));
    }
    for (const r of osm.rels) { const kind = polyKind(r.t); if (kind) fillPoly(G, r.segs, k => apply(kind, k)); }
    for (const p of osm.places) {
      const rM = o.townRadius[p.t.place]; if (!rM) continue;
      const c = G.P.xy(p.ll), n = Math.ceil(rM / G.cell);
      const ci = Math.floor((c[0] - G.x0) / G.cell), cj = Math.floor((c[1] - G.y0) / G.cell);
      for (let j = cj - n; j <= cj + n; j++) for (let i = ci - n; i <= ci + n; i++) {
        if (i < 0 || j < 0 || i >= G.NX || j >= G.NY) continue;
        const k = j * G.NX + i, xy = cellXY(G, k); if (Math.hypot(xy[0] - c[0], xy[1] - c[1]) <= rM) FL[k] |= F_TOWN;
      }
    }
    // 5. slope and a dune estimate
    const SL = new Float32Array(NC), c = G.cell;
    for (let j = 0; j < G.NY; j++) for (let i = 0; i < G.NX; i++) {
      const k = j * G.NX + i, i1 = Math.min(G.NX - 1, i + 1), i0 = Math.max(0, i - 1), j1 = Math.min(G.NY - 1, j + 1), j0 = Math.max(0, j - 1);
      SL[k] = Math.hypot((H[j * G.NX + i1] - H[j * G.NX + i0]) / ((i1 - i0) * c), (H[j1 * G.NX + i] - H[j0 * G.NX + i]) / ((j1 - j0) * c));
      if (LC[k] === 60 || LC[k] === 0) {
        let s = 0, s2 = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= G.NX || jj >= G.NY) continue; const v = H[jj * G.NX + ii]; s += v; s2 += v * v; n++; }
        const sd = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
        // dunes: bumpy ground that is not steep on average (flat sand only comes from OSM sand areas)
        if (sd > o.duneRelief && SL[k] < o.duneMaxSlope && sd < 40) FL[k] |= F_DUNE;
      }
      if (LC[k] === 50) FL[k] |= F_TOWN;
      if (LC[k] === 80 || LC[k] === 90) FL[k] |= F_WATER;
    }
    G.FL = FL; G.SL = SL; G.OSMF = OSMF;
    // 6. the track graph (allowed pistes only)
    buildGraph(G, osm, o);
    log('grid ' + G.NX + ' x ' + G.NY + ' cells of ' + Math.round(G.cell) + ' m, ' + osm.ways.length + ' OSM ways, ' + G.gN + ' track nodes');
    return G;
  }

  function buildGraph(G, osm, o) {
    const id2 = new Map(), nll = [], ncell = [], edges = [];
    const nodeOf = (id, ll) => {
      let n = id2.get(id); if (n !== undefined) return n;
      const xy = G.P.xy(ll), c = cellOf(G, xy[0], xy[1]); if (c < 0 || (G.avoidMask && G.avoidMask[c])) return -1;
      n = nll.length; id2.set(id, n); nll.push(ll); ncell.push(c); return n;
    };
    const ways = [];
    for (const w of osm.ways) {
      if (pisteClass(w.t) !== 'ok') continue;
      const f = w.t.surface === 'sand' ? 0.95 : (w.t.tracktype === 'grade4' || w.t.tracktype === 'grade5') ? 1.08 : 1;
      const wi = ways.length; ways.push(w);
      let prev = -1;
      for (let k = 0; k < w.g.length; k++) {
        const ll = w.g[k]; if (!ll) { prev = -1; continue; }
        const n = nodeOf(w.n[k] != null ? w.n[k] : ('w' + w.id + ':' + k), ll);
        if (n >= 0 && prev >= 0 && n !== prev) edges.push([prev, n, dist(nll[prev], nll[n]), f, wi]);
        prev = n;
      }
    }
    const M = nll.length, deg = new Int32Array(M + 1);
    for (const e of edges) { deg[e[0]]++; deg[e[1]]++; }
    const start = new Int32Array(M + 1); for (let i = 0; i < M; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice(0, M), to = new Int32Array(start[M]), len = new Float32Array(start[M]), fac = new Float32Array(start[M]), way = new Int32Array(start[M]);
    for (const [a, b, L, f, wi] of edges) {
      const town = (G.FL[ncell[a]] & F_TOWN) || (G.FL[ncell[b]] & F_TOWN);
      const ff = f * (town ? o.townCost : 1);
      to[fill[a]] = b; len[fill[a]] = L; fac[fill[a]] = ff; way[fill[a]++] = wi;
      to[fill[b]] = a; len[fill[b]] = L; fac[fill[b]] = ff; way[fill[b]++] = wi;
    }
    const cnt = new Int32Array(G.NC + 1); for (let i = 0; i < M; i++) cnt[ncell[i] + 1]++;
    for (let k = 0; k < G.NC; k++) cnt[k + 1] += cnt[k];
    const cfill = cnt.slice(0, G.NC), cnodes = new Int32Array(M); for (let i = 0; i < M; i++) cnodes[cfill[ncell[i]]++] = i;
    Object.assign(G, { gN: M, gLL: nll, gCell: Int32Array.from(ncell), gStart: start, gTo: to, gLen: len, gFac: fac, gWay: way, gWays: ways, cStart: cnt, cNodes: cnodes });
  }

  /** the off-piste cost multiplier per cell for one option (preset + seeded noise); Infinity = impassable */
  function cellCosts(G, preset, o, seedStr) {
    const NC = G.NC, CM = new Float32Array(NC), nz = noise2(seedStr + ':noise', o.noiseCellM);
    for (let k = 0; k < NC; k++) {
      const fl = G.FL[k];
      let lcF = o.landCover[G.LC[k]]; if (lcF === undefined) lcF = 1.2;
      if (lcF === 'town') lcF = 1.0;
      let m = lcF * G.OSMF[k];
      if (fl & (F_WATER | F_BLOCK)) m = Infinity;
      if (fl & F_FIELD) m *= 8;
      const s = G.SL[k]; if (s > o.maxSlope) m = Infinity; else m *= 1 + o.slopeCost * Math.max(0, s - o.slopeFree) ** 2;
      if (fl & (F_SAND | F_DUNE)) m *= preset.sandF;
      if (fl & F_ROAD) m *= o.roadNearF;
      if (m !== Infinity) { const [x, y] = cellXY(G, k); m *= 1 + o.noiseAmp * (nz(x, y) - 0.5) * 2; }
      if (fl & F_TOWN) m = Number.isFinite(m) ? Math.max(m, 1) * o.townCost : o.townCost * 4;
      CM[k] = Math.round(m * 1000) / 1000;      // quantised: the same answer on every JS engine
    }
    return CM;
  }

  // ------------------------------------------------------------------ A* over grid cells + track nodes together
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
  function makeSearch(G) {
    const N = G.NC + G.gN;
    const g = new Float64Array(N), from = new Int32Array(N), stamp = new Uint32Array(N), done = new Uint32Array(N);
    let gen = 0;
    let hk = new Float64Array(1 << 16), hv = new Int32Array(1 << 16), hn = 0;
    const less = (a, b) => hk[a] < hk[b] || (hk[a] === hk[b] && hv[a] < hv[b]);
    const swap = (a, b) => { const k = hk[a]; hk[a] = hk[b]; hk[b] = k; const v = hv[a]; hv[a] = hv[b]; hv[b] = v; };
    const push = (f, v) => {
      if (hn === hk.length) { const k2 = new Float64Array(hn * 2); k2.set(hk); hk = k2; const v2 = new Int32Array(hn * 2); v2.set(hv); hv = v2; }
      hk[hn] = f; hv[hn] = v; let n = hn++;
      while (n > 0) { const p = (n - 1) >> 1; if (!less(n, p)) break; swap(n, p); n = p; }
    };
    const pop = () => {
      const v = hv[0]; hn--;
      if (hn) { hk[0] = hk[hn]; hv[0] = hv[hn]; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < hn && less(l, m)) m = l; if (r < hn && less(r, m)) m = r; if (m === n) break; swap(m, n); n = m; } }
      return v;
    };
    const gx = new Float64Array(G.gN), gy = new Float64Array(G.gN);
    for (let n = 0; n < G.gN; n++) { const p = G.P.xy(G.gLL[n]); gx[n] = p[0]; gy[n] = p[1]; }
    /** cheapest path s -> t (cell indices); CM: cell costs, lam: off-piste weight, PEN: per-cell penalty (or null) */
    return function search(s, t, CM, lam, PEN, o) {
      gen++; hn = 0;
      const c = G.cell, NX = G.NX, NY = G.NY, NC = G.NC, x0 = G.x0, y0 = G.y0;
      const ti = t % NX, tj = (t - ti) / NX, tx = x0 + (ti + 0.5) * c, ty = y0 + (tj + 0.5) * c;
      let minC = Infinity; for (let k = 0; k < NC; k += 5) if (CM[k] < minC) minC = CM[k];
      const hmin = Math.min(o.pisteCost * 0.95, lam * minC) * 0.98;
      const hf = v => { let x, y; if (v < NC) { const i = v % NX; x = x0 + (i + 0.5) * c; y = y0 + ((v - i) / NX + 0.5) * c; } else { x = gx[v - NC]; y = gy[v - NC]; } return Math.hypot(x - tx, y - ty) * hmin; };
      const relax = (v, u, cost) => { const ng = g[u] + cost; if (stamp[v] !== gen || ng < g[v]) { stamp[v] = gen; g[v] = ng; from[v] = u; push(ng + hf(v), v); } };
      stamp[s] = gen; g[s] = 0; from[s] = -1; push(hf(s), s);
      let found = false, pops = 0;
      while (hn) {
        const u = pop(); if (done[u] === gen) continue; done[u] = gen; pops++;
        if (u === t) { found = true; break; }
        if (u < NC) {
          const i = u % NX, j = (u - i) / NX, cu = CM[u], pu = PEN ? PEN[u] : 1, hu = G.H[u], fu = G.FL[u];
          if (cu !== Infinity) for (let q = 0; q < 16; q++) {
            const di = DIRS[q][0], dj = DIRS[q][1], ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
            const v = nj * NX + ni, cv = CM[v]; if (cv === Infinity || done[v] === gen) continue;
            if (q >= 8) { const mk = (j + (dj === 2 || dj === -2 ? Math.sign(dj) : 0)) * NX + (i + (di === 2 || di === -2 ? Math.sign(di) : 0)); if (CM[mk] === Infinity) continue; }
            const d = (q < 4 ? 1 : q < 8 ? Math.SQRT2 : 2.23606797749979) * c, dh = G.H[v] - hu;
            let cost = d * lam * (cu + cv) / 2 * (PEN ? (pu + PEN[v]) / 2 : 1) + lam * (o.climbCost * (dh > 0 ? dh : 0) + o.descentCost * (dh < 0 ? -dh : 0));
            const fv = G.FL[v];
            if ((fv & F_FENCE) && !(fu & F_FENCE)) cost += o.fenceCost;
            if ((fv & F_ROAD) && !(fu & F_ROAD)) cost += o.roadCrossCost;
            relax(v, u, cost);
          }
          for (let q = G.cStart[u]; q < G.cStart[u + 1]; q++) { const v = NC + G.cNodes[q]; if (done[v] !== gen) relax(v, u, o.transferCost); }
        } else {
          const n = u - NC, cu = G.gCell[n];
          for (let q = G.gStart[n]; q < G.gStart[n + 1]; q++) {
            const m = G.gTo[q], v = NC + m; if (done[v] === gen) continue;
            relax(v, u, G.gLen[q] * o.pisteCost * G.gFac[q] * (PEN ? (PEN[cu] + PEN[G.gCell[m]]) / 2 : 1));
          }
          if (CM[cu] !== Infinity && done[cu] !== gen) relax(cu, u, o.transferCost);
        }
      }
      if (!found) return null;
      const path = []; for (let v = t; v >= 0; v = from[v]) { path.push(v); if (v === s) break; }
      path.reverse();
      return { path, cost: g[t], pops };
    };
  }

  // ------------------------------------------------------------------ path -> sections and stats
  /** [{kind: 'piste'|'off', pts: [[lat,lon]...]}] in route order; off-piste pieces start / end on the track node */
  function sectionsOf(G, path, A, B) {
    const secs = []; let cur = null;
    for (let q = 0; q < path.length; q++) {
      const v = path[q], kind = v < G.NC ? 'off' : 'piste';
      if (!cur || cur.kind !== kind) {
        const prev = cur && cur.pts[cur.pts.length - 1];
        cur = { kind, pts: [] }; secs.push(cur);
        if (prev) cur.pts.push(prev);
      }
      cur.pts.push(v < G.NC ? cellLL(G, v) : G.gLL[v - G.NC]);
    }
    // an off-piste piece next to a track: drop the transfer cell centre, end on the track node itself
    for (let s = 0; s < secs.length; s++) {
      const S = secs[s]; if (S.kind !== 'off') continue;
      if (s > 0 && S.pts.length > 2) S.pts.splice(1, 1);
      if (s + 1 < secs.length) { const nx = secs[s + 1], on = nx.pts[1] || nx.pts[0]; if (S.pts.length > 2) { S.pts.pop(); S.pts.push(on); } else S.pts[S.pts.length - 1] = on; nx.pts.shift(); }
    }
    let out = secs.filter(s => s.pts.length >= 2);
    if (out.length) {
      const f = out[0], l = out[out.length - 1];
      if (f.kind === 'piste' && dist(f.pts[0], A) > 30) f.pts.unshift(A.slice()); else f.pts[0] = A.slice();
      if (l.kind === 'piste' && dist(l.pts[l.pts.length - 1], B) > 30) l.pts.push(B.slice()); else l.pts[l.pts.length - 1] = B.slice();
    }
    // very short pieces (< 150 m) merge with the previous piece
    const merged = [];
    for (const s of out) {
      const L = polyLen(s.pts);
      if (merged.length && (L < 150 || merged[merged.length - 1].kind === s.kind)) { const m = merged[merged.length - 1]; m.pts = m.pts.concat(s.pts.slice(1)); }
      else merged.push({ kind: s.kind, pts: s.pts.slice() });
    }
    return merged;
  }
  /** Douglas-Peucker on an off-piste piece, never across an impassable or town cell */
  function simplifyOff(G, pts, CM, tolM) {
    if (pts.length <= 2) return pts.slice();
    const P = G.P, xy = pts.map(p => P.xy(p));
    const clear = (a, b) => { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (G.cell / 3))); for (let s = 1; s < n; s++) { const k = cellOf(G, a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n); if (k >= 0 && (CM[k] === Infinity || (G.FL[k] & F_TOWN))) return false; } return true; };
    const keep = new Uint8Array(xy.length); keep[0] = keep[xy.length - 1] = 1;
    const stk = [[0, xy.length - 1]];
    while (stk.length) {
      const [p, q] = stk.pop(); let md = -1, mi = -1;
      const ax = xy[p][0], ay = xy[p][1], dx = xy[q][0] - ax, dy = xy[q][1] - ay, L2 = dx * dx + dy * dy;
      for (let k = p + 1; k < q; k++) { let t = L2 ? ((xy[k][0] - ax) * dx + (xy[k][1] - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const d = Math.hypot(xy[k][0] - ax - t * dx, xy[k][1] - ay - t * dy); if (d > md) { md = d; mi = k; } }
      if (mi > 0 && (md > tolM || !clear(xy[p], xy[q]))) { keep[mi] = 1; stk.push([p, mi], [mi, q]); }
    }
    return pts.filter((_, k) => keep[k]);
  }
  function routeGeometry(G, secs, CM, o) {
    return secs.map(s => ({ kind: s.kind, pts: s.pts, line: s.kind === 'off' ? simplifyOff(G, s.pts, CM, G.cell * o.simplifyCells) : s.pts }));
  }
  function statsOf(G, secs) {
    let piste = 0, off = 0, town = 0, sand = 0, bare = 0, veg = 0, other = 0, climb = 0, hmin = Infinity, hmax = -Infinity, cross = 0;
    for (const s of secs) {
      const L = polyLen(s.line); if (s.kind === 'off') off += L; else piste += L;
      const pts = s.line; let lastH = null, lastCell = -1;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], d = dist(a, b), n = Math.max(1, Math.ceil(d / 100));
        for (let m = 0; m < n; m++) {
          const t = (m + 0.5) / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], xy = G.P.xy(p), c = cellOf(G, xy[0], xy[1]), seg = d / n;
          if (c < 0) continue;
          const fl = G.FL[c], lc = G.LC[c];
          if (fl & F_TOWN) town += seg;
          if (fl & (F_SAND | F_DUNE)) sand += seg; else if (lc === 60) bare += seg; else if (lc === 20 || lc === 30 || lc === 100) veg += seg; else other += seg;
          if ((fl & F_ROAD) && lastCell >= 0 && c !== lastCell && !(G.FL[lastCell] & F_ROAD)) cross++;
          const h = G.H[c]; if (lastH !== null && h > lastH) climb += h - lastH; lastH = h; hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); lastCell = c;
        }
      }
    }
    const tot = piste + off || 1, tt = sand + bare + veg + other || 1;
    return { lengthKm: +(tot / 1000).toFixed(2), pisteKm: +(piste / 1000).toFixed(2), offKm: +(off / 1000).toFixed(2), offShare: +(off / tot).toFixed(3),
      townKm: +(town / 1000).toFixed(2), terrain: { sandDunes: Math.round(sand / tt * 100), bare: Math.round(bare / tt * 100), vegetation: Math.round(veg / tt * 100), other: Math.round(other / tt * 100) },
      climbM: Math.round(climb), minAltM: Math.round(hmin), maxAltM: Math.round(hmax), roadCrossings: cross };
  }
  function terrainText(st) {
    const t = st.terrain, parts = [];
    if (t.sandDunes) parts.push(t.sandDunes + '% sand / dunes');
    if (t.bare) parts.push(t.bare + '% bare ground / gravel');
    if (t.vegetation) parts.push(t.vegetation + '% scrub / grass');
    if (t.other) parts.push(t.other + '% other');
    return parts.join(', ') + '; climb ' + st.climbM + ' m';
  }

  // ------------------------------------------------------------------ options
  /** the nearest usable cell to a point; want = 'track' | 'sand' prefers such a cell within 3 km */
  function snapCell(G, CM, xy, want) {
    const cx = Math.max(G.x0 + 1, Math.min(G.x0 + G.NX * G.cell - 1, xy[0])), cy = Math.max(G.y0 + 1, Math.min(G.y0 + G.NY * G.cell - 1, xy[1]));
    const k0 = cellOf(G, cx, cy), i0 = k0 % G.NX, j0 = (k0 - i0) / G.NX;
    const ok = k => CM[k] !== Infinity && !(G.FL[k] & (F_TOWN | F_ROAD));
    const good = k => want === 'track' ? G.cStart[k + 1] > G.cStart[k] : want === 'sand' ? !!(G.FL[k] & (F_SAND | F_DUNE)) : true;
    let best = -1, bd = Infinity, fallback = -1;
    const R = Math.ceil((want ? 3000 : 1500) / G.cell);
    for (let r = 0; r <= R; r++) {
      for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
        if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || i < 0 || j < 0 || i >= G.NX || j >= G.NY) continue;
        const k = j * G.NX + i; if (!ok(k)) continue;
        if (fallback < 0) fallback = k;
        if (!good(k)) continue;
        const d = Math.hypot(i - i0, j - j0); if (d < bd) { bd = d; best = k; }
      }
      if (best >= 0) break;
    }
    return best >= 0 ? best : fallback >= 0 ? fallback : k0;
  }
  const SHAPES_LINE = ['arcL', 'arcR', 'zig'], SHAPES_LOOP = ['loopL', 'loopR', 'petal'];
  /** via-point layout for one option, as a function of the amplitude A (metres) */
  function shapeFor(G, inp, kind, r) {
    const a = G.P.xy(inp.dss), b = G.P.xy(inp.ass), D = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = D ? (b[0] - a[0]) / D : 1, uy = D ? (b[1] - a[1]) / D : 0, nx = -uy, ny = ux;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (/^(loop|petal)/.test(kind)) {
      const k = kind === 'petal' ? 4 : 3, base = r() * Math.PI * 2, dir = kind === 'loopR' ? -1 : 1, u = Array.from({ length: k }, () => 0.8 + 0.4 * r());
      return { k, at: A => {
        const cx = mid[0] + Math.cos(base) * A, cy = mid[1] + Math.sin(base) * A;
        return Array.from({ length: k }, (_, i) => {
          const th = base + Math.PI + dir * (i + 1) * 2 * Math.PI / (k + 1), rr = A * u[i] * (kind === 'petal' && i % 2 ? 0.5 : 1);
          return [cx + Math.cos(th) * rr, cy + Math.sin(th) * rr];
        });
      } };
    }
    const ratio = G.L / Math.max(D, 1), k = ratio < 1.3 ? 1 : ratio < 1.9 ? 2 : 3;
    const t = Array.from({ length: k }, (_, i) => (i + 1) / (k + 1) + (r() - 0.5) * 0.12);
    const first = r() < 0.5 ? 1 : -1;
    const sg = Array.from({ length: k }, (_, i) => kind === 'arcL' ? 1 : kind === 'arcR' ? -1 : (i % 2 ? -first : first));
    const u = Array.from({ length: k }, () => 0.75 + 0.25 * r());
    return { k, at: A => t.map((tt, i) => [a[0] + ux * D * tt + nx * A * sg[i] * u[i], a[1] + uy * D * tt + ny * A * sg[i] * u[i]]) };
  }
  function insideEllipse(G, xy, f) {
    const dx = xy[0] - G.m[0], dy = xy[1] - G.m[1], c = Math.cos(G.th), s = Math.sin(G.th);
    const u = dx * c + dy * s, v = -dx * s + dy * c; return (u / (G.a * f)) ** 2 + (v / (G.b * f)) ** 2 <= 1;
  }
  function routeVia(G, search, s, t, vias, CM, lam, PEN0, o) {
    const NC = G.NC, PEN = new Float32Array(NC);
    if (PEN0) PEN.set(PEN0); else PEN.fill(1);
    const stops = [s].concat(vias, [t]).filter((v, i, a) => i === 0 || v !== a[i - 1]), path = [];
    let skipped = 0;
    for (let q = 0; q + 1 < stops.length; q++) {
      const r = search(stops[q], stops[q + 1], CM, lam, PEN, o);
      // a via point that cannot be reached (a pocket shut in by cliffs or water) is skipped
      if (!r) { if (q + 2 < stops.length) { stops.splice(q + 1, 1); skipped++; q--; continue; } return null; }
      for (const v of (path.length ? r.path.slice(1) : r.path)) path.push(v);
      // brief reuse is allowed, but the next part prefers fresh ground
      for (const v of r.path) { const c = v < NC ? v : G.gCell[v - NC]; PEN[c] *= o.reusePen; }
    }
    path.skipped = skipped;
    return path;
  }
  function measure(G, path, CM, inp, o) {
    const secs = routeGeometry(G, sectionsOf(G, path, inp.dss, inp.ass), CM, o);
    return { secs, stats: statsOf(G, secs) };
  }
  /** n options, each {id, index, shape, secs, stats, lambda, A, lengthOk} */
  function makeOptions(G, inp, seed, o, io) {
    const preset = PRESETS[inp.preset], n = o.options, search = makeSearch(G), log = io.log || (() => {});
    const loop = G.D < 0.3 * G.L;
    const order = (loop ? SHAPES_LOOP : SHAPES_LINE).slice(), r0 = rng(seed + ':shapes'), rot = Math.floor(r0() * 3);
    const shapes = order.slice(rot).concat(order.slice(0, rot));
    const PEN = new Float32Array(G.NC).fill(1), out = [];
    const target = G.L, aimLen = target / (1 + 0.03 * inp.offShare);   // the detailed off-piste line adds ~3 % on its part
    const tolA = aimLen * o.aim;
    const okLen = r => Math.abs(r.len - target) / target <= o.tolerance;
    for (let j = 0; j < n; j++) {
      const tryShape = (kind, tag) => {
        const rj = rng(seed + ':opt' + j + tag), shape = shapeFor(G, inp, kind, rj);
        const CM = cellCosts(G, preset, o, seed + ':opt' + j);
        const endCell = ll => { const xy = G.P.xy(ll), k = cellOf(G, xy[0], xy[1]); return k >= 0 && CM[k] !== Infinity ? k : snapCell(G, CM, xy); };
        const sCell = endCell(inp.dss), tCell = endCell(inp.ass);
        const want = inp.offShare < 0.3 ? 'track' : (inp.preset === 'dunes' ? 'sand' : null);
        let Amax = Math.max(G.a, G.b) * 1.5;
        { let lo = 0, hi = Amax; for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (shape.at(mid).every(xy => insideEllipse(G, xy, 0.92))) lo = mid; else hi = mid; } Amax = lo; }
        let wantCur = want, lam = preset.lambda, lamLo = 0, lamHi = 0, best = null, tries = 0;
        const evalA = (A, lamX) => {
          tries++;
          const vias = shape.at(A).map(xy => snapCell(G, CM, xy, wantCur));
          const path = routeVia(G, search, sCell, tCell, vias, CM, lamX, PEN, o);
          if (!path || (path.skipped && A > 0)) { if (o.debug) log('  A ' + Math.round(A) + ': no path'); return null; }
          const m = measure(G, path, CM, inp, o);
          if (o.debug) log('  A ' + Math.round(A) + ' (max ' + Math.round(Amax) + '): ' + m.stats.lengthKm + ' km, off ' + m.stats.offShare);
          return Object.assign(m, { A, vias, path, len: m.stats.lengthKm * 1000, lambda: lamX });
        };
        const solve = lamX => {
          let bestR = null; const consider = r => { if (r && (!bestR || Math.abs(r.len - aimLen) < Math.abs(bestR.len - aimLen))) bestR = r; };
          let lo = { A: 0, r: evalA(0, lamX) }; consider(lo.r);
          if (!lo.r || lo.r.len >= aimLen - tolA) return bestR;
          let hi = { A: Amax, r: evalA(Amax, lamX) };
          // no way through at full swing (mountains, water): shrink it until there is one
          for (let k = 0; !hi.r && k < 5; k++) { const A = hi.A * 0.7; hi = { A, r: evalA(A, lamX) }; }
          if (!hi.r) return bestR;
          consider(hi.r);
          if (!hi.r || hi.r.len <= aimLen) return bestR;
          let flo = lo.r.len - aimLen, fhi = hi.r.len - aimLen, side = 0;
          for (let it = 2; it < o.maxEvals; it++) {
            let A = (lo.A * fhi - hi.A * flo) / (fhi - flo); if (!(A > lo.A && A < hi.A)) A = (lo.A + hi.A) / 2;
            const r = evalA(A, lamX); if (!r) { hi = { A, r: hi.r }; continue; }
            consider(r); const f = r.len - aimLen;
            if (Math.abs(f) <= tolA) break;
            if (f > 0) { hi = { A, r }; fhi = f; if (side === 1) flo /= 2; side = 1; }
            else { lo = { A, r }; flo = f; if (side === -1) fhi /= 2; side = -1; }
          }
          return bestR;
        };
        for (let round = 0; round < o.splitRounds; round++) {
          const cand = solve(lam);
          if (!cand) break;
          const better = !best || (okLen(cand) && !okLen(best)) || (okLen(cand) === okLen(best) && Math.abs(cand.stats.offShare - inp.offShare) < Math.abs(best.stats.offShare - inp.offShare));
          if (better) best = cand;
          const sh = cand.stats.offShare;
          log('option ' + (j + 1) + ' (' + kind + ') round ' + (round + 1) + ': ' + cand.stats.lengthKm + ' km, off-piste ' + Math.round(sh * 100) + '% (want ' + Math.round(inp.offShare * 100) + '%), weight ' + lam.toFixed(2) + ', ' + tries + ' tries');
          if (io.progress) io.progress('route', j * o.splitRounds + round + 1, n * o.splitRounds, 'route option ' + 'ABC'[j]);
          if (Math.abs(sh - inp.offShare) <= o.splitSlack && okLen(cand)) break;
          // more off-piste than wanted: make it dearer, and the other way round
          // (bracketed: once there is a weight that gave too much and one that gave too little, take their geometric mean)
          // length comes first: a route that cannot reach the length with this weight gets more freedom off the tracks
          if (!okLen(cand) && cand.len < target && wantCur) { wantCur = null; continue; }   // vias pinned to tracks cannot stretch it: free them first
          if (!okLen(cand) && cand.len < target) { lamHi = lam; lam = lamLo ? Math.sqrt(lamLo * lam) : lam * 0.55; continue; }
          if (sh > inp.offShare) lamLo = lam; else lamHi = lam;
          lam = lamLo && lamHi ? Math.sqrt(lamLo * lamHi) : lam * Math.max(0.3, Math.min(3.5, Math.pow(Math.max(sh, 0.02) / Math.max(inp.offShare, 0.02), 1.3)));
          lam = Math.min(lam, preset.lambda * 8);
          if (lam === cand.lambda) break;   // already at the limit
        }
        return best && Object.assign(best, { kind, tries, CM });
      };
      // a shape that cannot reach the length here (mountains or water in the way) is replaced by another one
      let best = tryShape(shapes[j % shapes.length], '');
      if (!best || !okLen(best)) for (const alt of shapes.filter((_, i) => i !== j % shapes.length).concat([shapes[j % shapes.length]])) {
        const b2 = tryShape(alt, ':alt');
        if (b2 && (!best || (okLen(b2) && !okLen(best)) || (!okLen(best) && Math.abs(b2.len - target) < Math.abs(best.len - target)))) best = b2;
        if (best && okLen(best)) break;
      }
      if (!best) { log('option ' + (j + 1) + ': no route found'); continue; }
      for (const v of best.path) { const c = v < G.NC ? v : G.gCell[v - G.NC]; for (const dk of [0, -1, 1, -G.NX, G.NX]) { const k = c + dk; if (k >= 0 && k < G.NC) PEN[k] = Math.max(PEN[k], o.diversityPen); } }
      out.push({ id: 'ABCDEFGH'[out.length], index: out.length, shape: best.kind, secs: best.secs, stats: best.stats, lambda: +best.lambda.toFixed(3), A: Math.round(best.A), tries: best.tries, CM: best.CM, lengthOk: okLen(best) });
    }
    return out;
  }
  /** share of route a (list of lines) lying within tolM of route b */
  function overlap(linesA, linesB, P, tolM) {
    const segs = []; for (const l of linesB) for (let k = 1; k < l.length; k++) segs.push([P.xy(l[k - 1]), P.xy(l[k])]);
    let tot = 0, near = 0;
    for (const l of linesA) for (let k = 1; k < l.length; k++) {
      const a = P.xy(l[k - 1]), b = P.xy(l[k]), d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(d / 100));
      for (let m = 0; m < n; m++) {
        const p = [a[0] + (b[0] - a[0]) * (m + 0.5) / n, a[1] + (b[1] - a[1]) * (m + 0.5) / n]; tot += d / n;
        for (const [s, e] of segs) { const dx = e[0] - s[0], dy = e[1] - s[1], L2 = dx * dx + dy * dy; let t = L2 ? ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); if (Math.hypot(p[0] - s[0] - t * dx, p[1] - s[1] - t * dy) <= tolM) { near += d / n; break; } }
      }
    }
    return tot ? near / tot : 0;
  }

  // ------------------------------------------------------------------ stage file
  function splitAt(line, frac) { // a polyline cut at a fraction of its length -> [first, second], the cut point shared
    const L = polyLen(line), want = L * frac; let acc = 0;
    for (let k = 1; k < line.length; k++) {
      const d = dist(line[k - 1], line[k]);
      if (acc + d >= want) { const t = d ? (want - acc) / d : 0, p = [r6(line[k - 1][0] + (line[k][0] - line[k - 1][0]) * t), r6(line[k - 1][1] + (line[k][1] - line[k - 1][1]) * t)]; return [line.slice(0, k).concat([p]), [p].concat(line.slice(k))]; }
      acc += d;
    }
    return [line.slice(), [line[line.length - 1]]];
  }
  /** where a line crosses an asphalt / major road: [{along (m), frac, way, hw}] */
  function roadCrossings(G, line) {
    const P = G.P, xy = line.map(p => P.xy(p));
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity; for (const q of xy) { lx0 = Math.min(lx0, q[0]); ly0 = Math.min(ly0, q[1]); lx1 = Math.max(lx1, q[0]); ly1 = Math.max(ly1, q[1]); }
    const accs = [0]; for (let k = 1; k < xy.length; k++) accs.push(accs[k - 1] + Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]));
    const out = [];
    for (const w of G.osm.ways) {
      if (pisteClass(w.t) !== 'road') continue;
      const g = w.g.filter(Boolean).map(p => P.xy(p));
      for (let m = 1; m < g.length; m++) {
        const c = g[m - 1], d = g[m];
        if (Math.max(c[0], d[0]) < lx0 || Math.min(c[0], d[0]) > lx1 || Math.max(c[1], d[1]) < ly0 || Math.min(c[1], d[1]) > ly1) continue;
        for (let k = 1; k < xy.length; k++) {
          const a = xy[k - 1], b = xy[k], d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = d[0] - c[0], d2y = d[1] - c[1], den = d1x * d2y - d1y * d2x;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((c[0] - a[0]) * d2y - (c[1] - a[1]) * d2x) / den, u = ((c[0] - a[0]) * d1y - (c[1] - a[1]) * d1x) / den;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) out.push({ along: accs[k - 1] + t * Math.hypot(d1x, d1y), way: w.id, hw: w.t.highway });
        }
      }
    }
    out.sort((a, b) => a.along - b.along || a.way - b.way);
    const L = accs[accs.length - 1] || 1, merged = [];
    for (const c of out) if (!merged.length || c.along - merged[merged.length - 1].along > 150) merged.push(c);
    return merged.map(c => Object.assign(c, { frac: c.along / L }));
  }

  /** roadbook planner half-width (m) for a straight leg of length L: 18 % of L, clamped 500..2500 */
  function plannerHalfWidth(L) { return Math.max(500, Math.min(2500, L * 0.18)); }
  /** sample a [lat,lon] polyline every stepM and flag blocked / impassable cells (forest, water, cliff, town) */
  function lineBlocked(G, CM, line, stepM) {
    if (!line || line.length < 2) return false;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], d = dist(a, b), n = Math.max(1, Math.ceil(d / (stepM || 80)));
      for (let s = 0; s <= n; s++) {
        const t = s / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], q = G.P.xy(p), k = cellOf(G, q[0], q[1]);
        if (k < 0) return true;
        if (CM && CM[k] === Infinity) return true;
        if (G.FL[k] & (F_WATER | F_BLOCK | F_TOWN)) return true;
      }
    }
    return false;
  }
  function lineHasTown(G, line, stepM) {
    if (!line || line.length < 2) return false;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], d = dist(a, b), n = Math.max(1, Math.ceil(d / (stepM || 80)));
      for (let s = 0; s <= n; s++) {
        const t = s / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], q = G.P.xy(p), k = cellOf(G, q[0], q[1]);
        if (k >= 0 && (G.FL[k] & F_TOWN)) return true;
      }
    }
    return false;
  }
  function maxDevM(P, line) {
    if (!line || line.length < 3) return { dev: 0, i: -1 };
    const A = P.xy(line[0]), B = P.xy(line[line.length - 1]), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    let md = 0, mi = -1;
    for (let k = 1; k < line.length - 1; k++) {
      const q = P.xy(line[k]); let t = L2 ? ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(q[0] - A[0] - t * dx, q[1] - A[1] - t * dy);
      if (d > md) { md = d; mi = k; }
    }
    return { dev: md, i: mi };
  }
  function mirrorLine(P, line) {
    const A = P.xy(line[0]), B = P.xy(line[line.length - 1]), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1;
    return line.map((p, i) => {
      if (i === 0 || i === line.length - 1) return p;
      const q = P.xy(p), t = ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2, fx = A[0] + t * dx, fy = A[1] + t * dy;
      return P.ll([2 * fx - q[0], 2 * fy - q[1]]);
    });
  }
  /**
   * Does this stretch need a Route (NOTE) pin? Yes when the intended line would leave the roadbook planner's
   * corridor, or when the swing is a choice (a clear chord, or two similar ways around an obstacle). No when
   * the line only wiggles, or only goes around something the planner will also have to go around the same way.
   */
  function needsPin(G, CM, line, o) {
    if (!line || line.length < 3) return false;
    const L = dist(line[0], line[line.length - 1]), half = plannerHalfWidth(L), { dev } = maxDevM(G.P, line);
    const pinTol = (o.wp && o.wp.pinTolM) || 400;
    const wander = (o.wp && o.wp.wanderSlackM != null) ? o.wp.wanderSlackM : 400;
    const step = Math.min(80, G.cell / 3);
    const chord = [line[0], line[line.length - 1]];
    // the roadbook planner does not treat villages as hard obstacles, so a swing that
    // avoids a town the straight chord would cut must be pinned even if it is small
    if (lineHasTown(G, chord, step) && !lineHasTown(G, line, step)) return true;
    // a long, nearly straight intended line still needs a mid pin: otherwise the planner's
    // corridor (up to 2.5 km each side) can wander far from the route Stage-Gen chose
    if (dev <= pinTol && half <= pinTol + wander) return false;
    if (half > pinTol + wander) return true;
    if (dev > half * 0.85) return true;
    if (lineHasTown(G, chord, step)) return true;
    if (!CM || !lineBlocked(G, CM, chord, step)) return true;
    const mir = mirrorLine(G.P, line), intLen = polyLen(line), mirLen = polyLen(mir);
    if (!lineBlocked(G, CM, mir, Math.min(80, G.cell / 3)) && mirLen < intLen * 1.5) return true;
    return false;
  }
  /**
   * Drop Route (NOTE) points that only smooth the line or avoid an obstacle the roadbook planner will handle.
   * Always keeps required GPS types and a NOTE that changes leg mode (piste ↔ off-piste, which pins a track).
   */
  function thinRouteNotes(pts, G, opt, o) {
    if (!o.wp || !o.wp.thinNotes || pts.length < 3) return;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], nx = pts[i + 1];
      if (p.type !== 'NOTE') keep[i] = 1;
      else if (p.leg && nx && nx.leg && p.leg.mode !== nx.leg.mode) keep[i] = 1;
    }
    const lineBetween = (i, j) => {
      let line = [];
      for (let k = i + 1; k <= j; k++) {
        const g = pts[k].leg && pts[k].leg.points;
        if (!g || g.length < 2) { line = line.concat([[pts[k].lat, pts[k].lon]]); continue; }
        line = line.length ? line.concat(g.slice(1)) : g.slice();
      }
      return line;
    };
    const stk = [];
    for (let i = 0, last = 0; i < pts.length; i++) if (keep[i]) { if (i > last) stk.push([last, i]); last = i; }
    const CM = opt && opt.CM;
    while (stk.length) {
      const [i, j] = stk.pop();
      if (j <= i + 1) continue;
      const line = lineBetween(i, j);
      if (!needsPin(G, CM, line, o)) continue;
      const P = G.P, A = P.xy([pts[i].lat, pts[i].lon]), B = P.xy([pts[j].lat, pts[j].lon]);
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      let md = -1, mi = -1;
      for (let k = i + 1; k < j; k++) {
        if (pts[k].type !== 'NOTE' || keep[k]) continue;
        const q = P.xy([pts[k].lat, pts[k].lon]);
        let t = L2 ? ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d0 = Math.hypot(q[0] - A[0] - t * dx, q[1] - A[1] - t * dy);
        if (d0 > md) { md = d0; mi = k; }
      }
      if (mi < 0) continue;
      keep[mi] = 1;
      stk.push([i, mi], [mi, j]);
    }
    const out = [pts[0]];
    let acc = null;
    for (let i = 1; i < pts.length; i++) {
      const g = pts[i].leg && pts[i].leg.points;
      if (g && g.length) acc = acc ? acc.concat(g.slice(1)) : g.slice();
      else acc = acc ? acc.concat([[pts[i].lat, pts[i].lon]]) : [[pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]];
      if (!keep[i]) continue;
      const p = Object.assign({}, pts[i], { leg: { mode: pts[i].leg.mode, points: acc } });
      out.push(p); acc = null;
    }
    pts.length = 0; for (const p of out) pts.push(p);
  }

  /**
   * The picked option as builder points: [{id, type, lat, lon, name, speedLimit, leg: {mode, points}}].
   * Waypoint rules (o.wp): WPM at the end of every off-piste piece >= wpmMinOffKm and every wpmEveryKm inside long
   * ones; WPV halfway along piste pieces >= wpvPisteKm; WPS where the line crosses an asphalt / major road; DZ / FZ
   * round a village the line could not avoid. Route (NOTE) points that only smooth the line or avoid an obstacle are
   * dropped (the roadbook planner already routes off-piste legs around trees, buildings, dunes, water and fences).
   * A NOTE is kept when it changes piste / off-piste, or when it pins a corridor or a track the planner would not
   * pick on its own. A GPS waypoint closer than minGapM to the previous one becomes a NOTE.
   */
  function stagePoints(G, opt, inp, o) {
    const W = o.wp, pts = [];
    let nId = 0; const nid = () => 'sg' + (++nId);
    const push = (ll, type, leg, extra) => pts.push(Object.assign({ id: type === 'DSS' ? 'dss' : type === 'ASS' ? 'ass' : nid(), type, lat: r6(ll[0]), lon: r6(ll[1]), name: '', leg }, extra || {}));
    push(inp.dss, 'DSS', null);
    const secs = opt.secs;
    for (let si = 0; si < secs.length; si++) {
      const s = secs[si], line = s.line.map(p => [r6(p[0]), r6(p[1])]), lastSec = si === secs.length - 1;
      if (s.kind === 'piste') {
        const L = polyLen(line) / 1000;
        if (L >= W.wpvPisteKm) { const [a, b] = splitAt(line, 0.5); push(a[a.length - 1], 'WPV', { mode: 'road', points: a }); push(b[b.length - 1], lastSec ? 'ASS' : 'NOTE', { mode: 'road', points: b }); }
        else push(line[line.length - 1], lastSec ? 'ASS' : 'NOTE', { mode: 'road', points: line });
      } else {
        // off-piste: the simplified line's vertices, long chords cut into sub-legs of <= maxSubLegKm
        const verts = [line[0]];
        for (let k = 1; k < line.length; k++) {
          const d = dist(line[k - 1], line[k]), n = Math.ceil(d / (W.maxSubLegKm * 1000));
          for (let m = 1; m < n; m++) verts.push([r6(line[k - 1][0] + (line[k][0] - line[k - 1][0]) * m / n), r6(line[k - 1][1] + (line[k][1] - line[k - 1][1]) * m / n)]);
          verts.push(line[k]);
        }
        const v2 = [verts[0]]; for (let k = 1; k < verts.length; k++) { if (k < verts.length - 1 && dist(v2[v2.length - 1], verts[k]) < W.minSubLegM) continue; v2.push(verts[k]); }
        if (v2.length > 2 && dist(v2[v2.length - 2], v2[v2.length - 1]) < W.minSubLegM) v2.splice(v2.length - 2, 1);
        const offKm = polyLen(v2) / 1000; let acc = 0, lastWpm = 0;
        for (let k = 1; k < v2.length; k++) {
          acc += dist(v2[k - 1], v2[k]) / 1000;
          const end = k === v2.length - 1;
          let type = 'NOTE';
          if (end && lastSec) type = 'ASS';
          else if (end && offKm >= W.wpmMinOffKm) type = 'WPM';
          else if (!end && acc - lastWpm >= W.wpmEveryKm && offKm - acc >= W.wpmEveryKm / 3) { type = 'WPM'; lastWpm = acc; }
          push(v2[k], type, { mode: 'direct', points: [v2[k - 1], v2[k]] });
        }
      }
    }
    // WPS where the line crosses an asphalt / major road (the leg is cut there)
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]; if (!p.leg) continue;
      const cr = roadCrossings(G, p.leg.points).filter(c => c.frac > 0.03 && c.frac < 0.97);
      if (!cr.length) continue;
      const [a, b] = splitAt(p.leg.points, cr[0].frac), at = a[a.length - 1];
      pts.splice(i, 0, { id: nid(), type: 'WPS', lat: at[0], lon: at[1], name: 'road crossing', leg: { mode: p.leg.mode, points: a } });
      p.leg = { mode: p.leg.mode, points: b };
    }
    // DZ / FZ round a village the line passes (normally none: towns are avoided)
    const inTown = ll => { const q = G.P.xy(ll), k = cellOf(G, q[0], q[1]); return k >= 0 && !!(G.FL[k] & F_TOWN); };
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]; if (!p.leg) continue;
      const line = p.leg.points, L = polyLen(line); if (L < 400) continue;
      const fr = []; for (let s2 = 1; s2 < 20; s2++) fr.push(inTown(splitAt(line, s2 / 20)[0].slice(-1)[0]));
      const a = fr.indexOf(true), b = fr.lastIndexOf(true);
      if (a < 0) continue;
      const f0 = Math.max(0.02, (a + 1) / 20 - W.dzBeforeM / L), f1 = Math.min(0.98, (b + 1) / 20 + W.dzBeforeM / L);
      if (f1 - f0 < 0.05) continue;
      const [l1, rest] = splitAt(line, f0), [l2, l3] = splitAt(rest, (f1 - f0) / (1 - f0));
      const dz = l1[l1.length - 1], fz = l2[l2.length - 1];
      pts.splice(i, 0, { id: nid(), type: 'DZ', lat: dz[0], lon: dz[1], name: 'village', speedLimit: W.dzSpeed, leg: { mode: p.leg.mode, points: l1 } },
        { id: nid(), type: 'FZ', lat: fz[0], lon: fz[1], name: '', leg: { mode: p.leg.mode, points: l2 } });
      p.leg = { mode: p.leg.mode, points: l3 }; i += 2;
    }
    // two speed zones almost touching (an FZ and the next DZ less than 500 m apart along the route) become one:
    // the FZ and that DZ turn into plain roadbook points
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].type !== 'FZ') continue;
      let along = 0;
      for (let k = i + 1; k < pts.length && along < 500; k++) {
        along += polyLen(pts[k].leg.points);
        if (pts[k].type === 'DZ' && along < 500) { pts[i].type = 'NOTE'; pts[k].type = 'NOTE'; delete pts[k].speedLimit; pts[i].name = pts[k].name = ''; break; }
        if (pts[k].type === 'FZ' || pts[k].type === 'ASS') break;
      }
    }
    // spacing: a GPS waypoint too close to the previous one becomes a roadbook NOTE (DSS / ASS / DZ / FZ / WPS stay)
    const keep = { DSS: 1, ASS: 1, DZ: 1, FZ: 1, WPS: 1 };
    let last = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]; if (p.type === 'NOTE') continue;
      if (!keep[p.type] && dist([last.lat, last.lon], [p.lat, p.lon]) < W.minGapM) { p.type = 'NOTE'; continue; }
      last = p;
    }
    // validation circles (the builder's FIM-2026 radii) must not overlap: demote a WPM / WPV / WPS to a roadbook NOTE, or
    // drop a speed zone squeezed against the DSS or the ASS (a start or finish inside a village)
    const VAL = { DSS: 200, WPV: 200, WPE: 90, WPM: 90, WPN: 200, WPS: 30, WPC: 300, WPP: 20, DZ: 90, FZ: 90, ASS: 90 };
    const zoneMate = (i, dir) => { for (let k = i + dir; k >= 0 && k < pts.length; k += dir) if (pts[k].type === (dir > 0 ? 'FZ' : 'DZ')) return k; return -1; };
    const toNote = k => { pts[k].type = 'NOTE'; delete pts[k].speedLimit; };
    for (let changed = true, guard = 0; changed && guard < 50; guard++) {
      changed = false;
      const g = pts.map((p, i) => i).filter(i => pts[i].type !== 'NOTE');
      for (let n = 1; n < g.length && !changed; n++) {
        const qi = g[n - 1], pi = g[n], q = pts[qi], p = pts[pi];
        if (dist([q.lat, q.lon], [p.lat, p.lon]) >= (VAL[q.type] || 0) + (VAL[p.type] || 0)) continue;
        const soft = t => t === 'WPM' || t === 'WPV' || t === 'WPS';
        if (soft(p.type)) toNote(pi); else if (soft(q.type)) toNote(qi);
        else if (q.type === 'FZ' && p.type === 'ASS') { const d0 = zoneMate(qi, -1); toNote(qi); if (d0 >= 0) toNote(d0); }
        else if (q.type === 'DSS' && p.type === 'DZ') { const f0 = zoneMate(pi, 1); toNote(pi); if (f0 >= 0) toNote(f0); }
        else if (q.type === 'FZ' && p.type === 'DZ') { toNote(qi); toNote(pi); }
        else continue;
        changed = true;
      }
    }
    // a NOTE almost on top of the next point (< 60 m) is merged into it
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      if (p.type === 'NOTE' && dist([p.lat, p.lon], [q.lat, q.lon]) < 60 && p.leg.mode === q.leg.mode) { q.leg = { mode: q.leg.mode, points: p.leg.points.concat(q.leg.points.slice(1)) }; pts.splice(i, 1); i--; }
    }
    thinRouteNotes(pts, G, opt, o);
    pts.forEach((p, i) => { if (i && p.leg) { p.leg.points[0] = [pts[i - 1].lat, pts[i - 1].lon]; p.leg.points[p.leg.points.length - 1] = [p.lat, p.lon]; } });
    return pts;
  }
  /** builder points -> a stage file, the same shape as the builder's exportStage */
  function stageFile(points, meta) {
    let km = 0, num = 0;
    const gpsCount = points.filter(p => p.type !== 'NOTE' && p.type !== 'DSS' && p.type !== 'ASS').length;
    const D = points.map((p, i) => {
      const legKm = i ? polyLen(p.leg.points) / 1000 : 0; km += legKm;
      return { legKm, km, n: p.type === 'NOTE' ? null : p.type === 'DSS' ? 0 : p.type === 'ASS' ? gpsCount + 1 : ++num, cap: points[i + 1] ? capOf(points[i + 1].leg.points) : null };
    });
    const label = (p, i) => p.type === 'NOTE' ? 'NOTE' : p.type + (p.type === 'DSS' || p.type === 'ASS' ? '' : ' ' + D[i].n);
    const boxes = points.map((p, i) => ({ n: i + 1, id: p.id, km: +D[i].km.toFixed(3), partial: +(D[i].km - (i ? D[i - 1].km : 0)).toFixed(3), cap: D[i].cap != null ? Math.round(D[i].cap) : null, waypoint: p.type === 'NOTE' ? null : p.id, label: label(p, i), lat: p.lat, lon: p.lon }));
    return {
      format: 'rallyraid-stage', schemaVersion: 1, generator: GENERATOR,
      id: meta.id, name: meta.name, region: meta.region || '', author: meta.author || '', description: meta.description || '', vehicleClass: meta.vehicleClass || '',
      created: meta.created, modified: meta.created,
      dataSource: 'OpenStreetMap contributors (ODbL); terrain: Mapterhorn (Copernicus GLO-30 and others); land cover: ESA WorldCover 2021 (CC BY 4.0); route: ' + GENERATOR,
      lengthKm: +km.toFixed(3), rules: { preset: 'FIM-2026' },
      waypoints: points.map((p, i) => [p, i]).filter(([p]) => p.type !== 'NOTE').map(([p, i]) => {
        const w = { id: p.id, n: D[i].n, type: p.type, lat: p.lat, lon: p.lon, km: +D[i].km.toFixed(3), cap: D[i].cap != null ? Math.round(D[i].cap) : null };
        if (p.name) w.name = p.name; if (p.type === 'DZ') w.speedLimit = +p.speedLimit;
        w.box = i + 1; return w;
      }),
      roadbook: { boxes, file: null },
      route: { legs: points.slice(1).map((p, i) => ({ from: points[i].id, to: p.id, mode: p.leg.mode, km: +D[i + 1].legKm.toFixed(3), points: p.leg.points.map(q => [r6(q[0]), r6(q[1])]) })) },
      builder: { notes: points.filter(p => p.type === 'NOTE').map(p => p.id) }
    };
  }
  function stageToPoints(stage) {
    const legs = {}; for (const l of stage.route.legs) legs[l.to] = l;
    const byId = {}; for (const w of stage.waypoints) byId[w.id] = w;
    return stage.roadbook.boxes.map(b => { const w = b.waypoint ? byId[b.waypoint] : null, l = legs[b.id];
      return Object.assign({ id: b.id, type: w ? w.type : 'NOTE', lat: b.lat, lon: b.lon, name: (w && w.name) || '', leg: l ? { mode: l.mode, points: l.points } : null }, w && w.speedLimit ? { speedLimit: w.speedLimit } : {}); });
  }
  function corridorSamplePoints(stage, ro) { // as roadbook-gen.js: points every ~250 m over every off-piste corridor
    const pts = [];
    for (const b of RB.corridorBoxes(stage, ro)) {
      const n = Math.max(2, Math.ceil((b[2] - b[0]) * 111320 / 250)), m = Math.max(2, Math.ceil((b[3] - b[1]) * 111320 * Math.cos(rad(b[0])) / 250));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) pts.push([b[0] + (b[2] - b[0]) * i / n, b[1] + (b[3] - b[1]) * j / m]);
    }
    return pts;
  }
  /**
   * Detailed off-piste lines with the roadbook generator's own planner (30 m cells; buildings, fences, water and trees
   * from OSM; Mapterhorn zoom 12) with the same query and seed as the roadbook editor, so it draws the same line.
   */
  async function planFine(stage, io, o) {
    const ro = Object.assign({}, RB.DEFAULTS, { density: o.wp.density, planZeroIsSea: true });
    const boxes = RB.corridorBoxes(stage, ro);
    if (!boxes.length) return { stage, info: { legs: 0, obstacles: 0 } };
    let obst = { elements: [] }, failed = false;
    if (io.progress) io.progress('detail', 0, 2, 'obstacles along the off-piste legs');
    for (let a = 0; a < 2; a++) {   // two tries; without them the legs keep the grid line (a warning says so)
      try { obst = await io.overpass(RB.obstacleQuery(boxes)); failed = false; break; }
      catch (e) { failed = true; if (io.log) io.log('obstacles try ' + (a + 1) + ' failed: ' + e.message); if (/^offline/.test(e.message)) break; if (!a) await sleep(5000); }
    }
    const dem = RB.createDem({ fetchBytes: io.fetchBytes, decodeImage: io.decodeImage });
    if (io.progress) io.progress('detail', 1, 2, 'detailed terrain');
    await dem.load(corridorSamplePoints(stage, ro), (d, t) => io.progress && io.progress('detail', 1 + d / t, 2, 'detailed terrain'));
    const plan = RB.planOffPiste(stage, dem.h, obst.elements || [], ro);
    return { stage: plan.stage, obstacles: obst.elements || [], info: { legs: plan.stats.length, obstacles: (obst.elements || []).length, obstaclesFailed: failed || undefined, demFailures: dem.failures } };
  }

  // ------------------------------------------------------------------ public API
  /**
   * Step 1: read the map for the region and make the options.
   * inp: {dss:[lat,lon], ass:[lat,lon], lengthKm, preset, offShare (0..1), region}; seed: any string; io: see the header;
   * opts: DEFAULTS overrides; data: {osm} to regenerate from saved map data (blind verification, tests).
   */
  async function generate(inp0, seed, io, opts, data) {
    io = io || {};
    const t0 = Date.now(), o = Object.assign({}, DEFAULTS, opts || {}), inp = normInputs(inp0);
    o.wp = Object.assign({}, DEFAULTS.wp, (opts && opts.wp) || {});
    const errs = checkInputs(inp); if (errs.length) throw new Error(errs.join(' '));
    const G = await buildGrid(inp, o, io, data);
    const tData = Date.now();
    const options = makeOptions(G, inp, String(seed), o, io);
    const dataHash = 'sha256:' + await sha256(canon(G.osm), io);
    for (const op of options) { op.summary = terrainText(op.stats); op.lines = op.secs.map(s => ({ kind: s.kind, line: s.line })); }
    for (const a of options) {
      a.overlap = 0;
      for (const b of options) if (a !== b) a.overlap = Math.max(a.overlap, +overlap(a.secs.map(s => s.line), b.secs.map(s => s.line), G.P, 300).toFixed(3));
    }
    const warnings = [];
    if (G.osm.missing && G.osm.missing.length) {
      let inside = G.NC; if (G.outside) for (let k = 0; k < G.NC; k++) inside -= G.outside[k];
      const share = Math.max(1, Math.round(100 * G.unmapped / Math.max(1, inside)));
      warnings.push({ code: 'osm-partial', tiles: G.osm.missing.length, of: G.osm.tiles.length, sharePct: share,
        text: G.osm.missing.length + ' of ' + G.osm.tiles.length + ' map tiles (about ' + share + '% of the area) did not load: the OpenStreetMap servers did not answer. There the routes know no tracks, roads, fences or villages, so they may cross some. Generate again later for complete map data.' });
    }
    return { inputs: inp, seed: String(seed), options, grid: G, dataHash, o, warnings,
      timing: { dataMs: tData - t0, routeMs: Date.now() - tData },
      region: { bbox: G.bbox.map(x => +x.toFixed(5)), cellM: Math.round(G.cell), cells: G.NC, trackNodes: G.gN, osmWays: G.osm.ways.length, osmTiles: G.osm.tiles ? G.osm.tiles.length : osmTiles(G.bbox, o.osmTileDeg).length, osmMissing: G.osm.missing ? G.osm.missing.length : 0, demZoom: G.demZoom, lcZoom: G.lcZoom, landCoverTiles: G.lcLoaded, demMissing: G.demMissing } };
  }
  function stageMeta(inp, seed, opt, blind) {
    const L = Math.round(inp.lengthKm), reg = inp.region || 'Auto stage';
    const tag = hash32(String(seed) + ':' + (opt ? opt.index : 0) + ':' + canon(inp)).toString(36).padStart(6, '0').slice(0, 6);
    return { id: ('sg-' + (slug(inp.region) || 'stage')).slice(0, 34).replace(/-+$/, '') + '-' + tag, name: 'SS ' + reg + ' (Stage-Gen ' + L + ' km)', region: inp.region,
      description: blind ? 'Blind Stage-Gen stage: made from a secret seed and not seen by the organizer. The seed is published after the event so anyone can regenerate it and check.'
        : 'Made by Stage-Gen (' + PRESETS[inp.preset].label + ', about ' + Math.round((1 - inp.offShare) * 100) + '% piste). Edit it like any stage.' };
  }
  /** Step 2: the picked option -> a stage file (async: the detailed off-piste lines need terrain and obstacles) */
  async function buildStage(res, optIndex, io, extra) {
    io = io || {};
    const o0 = res.o, G = res.grid, opt = res.options.find(x => x.index === optIndex);
    if (!opt) throw new Error('no such option');
    const blind = !!(extra && extra.blind);
    const genVersion = (extra && extra.genVersion) || VERSION;
    const o = (LEGACY_NOTE_VERSIONS[genVersion]) ? Object.assign({}, o0, { wp: Object.assign({}, o0.wp, { thinNotes: false }) }) : o0;
    const meta = Object.assign(stageMeta(res.inputs, res.seed, opt, blind), { created: (extra && extra.created) || new Date().toISOString() });
    let stage = stageFile(stagePoints(G, opt, res.inputs, o), meta), fine = null;
    if (o.fine) { const f = await planFine(stage, io, o); stage = f.stage; fine = f.info; res.obstacles = f.obstacles; }
    stage = stageFile(stageToPoints(stage), meta);     // km, caps and boxes from the final lines
    const st = statsOf(G, stage.route.legs.map(l => ({ kind: l.mode === 'direct' ? 'off' : 'piste', line: l.points })));
    stage.builder.stagegen = { version: VERSION, inputs: res.inputs, option: opt.id, shape: opt.shape, stats: st, dataHash: res.dataHash, blind: blind || undefined,
      seed: blind ? undefined : res.seed, detail: fine };
    return stage;
  }

  // ------------------------------------------------------------------ blind mode
  /**
   * Blind mode: what the organizer hands out without looking.
   *   receipt  (public now)    : inputs, stage id / name / length / region, stageHash, dataHash and the commitment.
   *   seedFile (publish after) : the seed and the OpenStreetMap data used, so the route can be regenerated even after the
   *                              map has been edited.
   * commitment = sha256(canonical {v, inputs, seed, stageHash, dataHash})
   */
  async function seal(res, stage, io) {
    const stageHash = await RB.stageHash(stage);
    const core = { v: VERSION, inputs: res.inputs, seed: res.seed, stageHash, dataHash: res.dataHash };
    const commitment = 'sha256:' + await sha256(canon(core), io);
    const receipt = { format: 'rallyraid-stagegen-receipt', version: VERSION, generator: GENERATOR, created: stage.created, inputs: res.inputs, region: res.inputs.region,
      stageId: stage.id, stageName: stage.name, lengthKm: stage.lengthKm, stageHash, dataHash: res.dataHash, commitment,
      howToVerify: 'After the event the organizer publishes the seed file. In the rally.raid Earth stage builder open Auto stage > Verify a blind stage and give it this receipt and the seed file: it regenerates the stage and checks the stage hash and the commitment.' };
    const seedFile = { format: 'rallyraid-stagegen-seed', version: VERSION, generator: GENERATOR, created: stage.created, inputs: res.inputs, seed: res.seed, dataHash: res.dataHash, commitment, osm: res.grid.osm,
      note: 'KEEP PRIVATE until the event has closed: with this file anyone can regenerate the route. Publish it afterwards so everyone can verify.' };
    return { receipt, seedFile, stageHash, commitment };
  }
  /** regenerate from a receipt and a published seed file: {ok, checks[], stage} */
  async function verify(receipt, seedFile, io, opts) {
    const checks = [], add = (ok, what) => checks.push({ ok: !!ok, what });
    if (!receipt || receipt.format !== 'rallyraid-stagegen-receipt') throw new Error('That is not a Stage-Gen receipt.');
    if (!seedFile || seedFile.format !== 'rallyraid-stagegen-seed') throw new Error('That is not a Stage-Gen seed file.');
    const supported = receipt.version === VERSION || !!LEGACY_NOTE_VERSIONS[receipt.version];
    add(supported, 'Made with Stage-Gen ' + receipt.version + (receipt.version === VERSION ? '' : (supported ? ' (still verified by ' + VERSION + ')' : ' (this is ' + VERSION + ', so the result may differ)')));
    add(canon(receipt.inputs) === canon(seedFile.inputs), 'The receipt and the seed file have the same inputs (DSS, ASS, length, terrain)');
    const dh = 'sha256:' + await sha256(canon(seedFile.osm), io);
    add(dh === receipt.dataHash, 'The map data in the seed file is the data the receipt names');
    const cm = 'sha256:' + await sha256(canon({ v: receipt.version, inputs: seedFile.inputs, seed: seedFile.seed, stageHash: receipt.stageHash, dataHash: receipt.dataHash }), io);
    add(cm === receipt.commitment, 'The seed matches the commitment published before the event');
    const res = await generate(seedFile.inputs, seedFile.seed, io, Object.assign({}, opts, { options: 1 }), { osm: seedFile.osm });
    const stage = await buildStage(res, 0, io, { blind: true, created: receipt.created, genVersion: receipt.version });
    const sh = await RB.stageHash(stage);
    add(sh === receipt.stageHash, 'Regenerating from the seed gives exactly the stage in the receipt');
    return { ok: checks.every(c => c.ok), checks, stage, stageHash: sh };
  }
  /** is this stage file the sealed one (same route and waypoints as the receipt)? */
  async function matchesReceipt(stage, receipt) { return (await RB.stageHash(stage)) === receipt.stageHash; }

  return { VERSION, GENERATOR, PRESETS, DEFAULTS, pisteClass, normInputs, checkInputs, regionFor, osmTiles, osmTilesFor, osmQuery, compactOsm, generate, buildStage, seal, verify, matchesReceipt,
    newSeed, canon, sha256, overlap, terrainText, stageFile, stageToPoints, roadCrossings, cellOf, cellLL, flags: { F_TOWN, F_ROAD, F_FENCE, F_SAND, F_DUNE, F_WATER, F_BLOCK, F_FIELD } };
});
