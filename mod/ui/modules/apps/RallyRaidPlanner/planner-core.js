/*
 * Rally Raid in-game planner: the stage / roadbook model, with no game and no DOM in it (Node-testable).
 * The Angular app (app.js) draws it; Lua (rallyRaid/planner.lua) gives the car's position, the driven line and file
 * access. Stage files are read and written exactly as the stage builder does (stage-builder/index.html importStage /
 * exportStage), roadbooks through RoadbookGen (roadbook-gen.js, a byte-identical copy of the website's), so a file can
 * go website -> game -> website and back without losing anything. docs/INGAME_PLANNER.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlannerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '0.1.0';
  const GENERATOR = 'rallyraid-ingame-planner ' + VERSION;
  const BUILDER_VERSION = '0.1.0';                   // the stage builder's own VERSION, written as its generator would
  const TYPES = ['DSS', 'WPV', 'WPE', 'WPM', 'WPN', 'WPS', 'WPC', 'WPP', 'DZ', 'FZ', 'ASS', 'NOTE'];
  const TYPE_NAMES = { DSS: 'Start of stage', WPV: 'Visible', WPE: 'Eclipse', WPM: 'Masked', WPN: 'Navigation', WPS: 'Safety',
    WPC: 'Control', WPP: 'Precise', DZ: 'Speed zone start', FZ: 'Speed zone end', ASS: 'Finish', NOTE: 'Roadbook note (no GPS)' };
  // the builder's FIM 2026 defaults (stage-builder/index.html FIM2026)
  const FIM2026 = {
    preset: 'FIM-2026',
    waypoints: {
      DSS: { reveal: 'prev', radius: 1000, validate: 200, penalty: null }, WPV: { reveal: 'always', validate: 200, penalty: 900 },
      WPE: { reveal: 'prev', radius: 1000, validate: 90, penalty: 900 }, WPM: { reveal: 'radius', radius: 800, validate: 90, penalty: 900 },
      WPN: { reveal: 'radius', radius: 800, validate: 200, penalty: 3600 }, WPS: { reveal: 'radius', radius: 1000, validate: 30, penalty: 900 },
      WPC: { reveal: 'never', validate: 300, penalty: 900 }, WPP: { reveal: 'radius', radius: 100, validate: 20, penalty: 120 },
      DZ: { reveal: 'radiusOrPrev', radius: 1000, validate: 90, penalty: 900 }, FZ: { reveal: 'prev', radius: 1000, validate: 90, penalty: 900 },
      ASS: { reveal: 'radius', radius: 800, validate: 90, penalty: null }
    },
    speedZone: { tolerance: 90, warnBefore: 90, alertMargin: 5, impulseDistance: 150, impulseTime: 10,
      bands: [{ upTo: 5, penalty: 10 }, { upTo: 15, penalty: 60 }, { upTo: 40, penalty: 120 }, { upTo: null, penalty: 360 }] },
    globalMaxKmh: null, globalImpulsePenalty: 60, lookahead: 5, tripSnapToWaypoint: true, startMode: 'auto', countdown: 5, falseStartPenalty: 60
  };
  const SPLIT_MAX_M = 200;     // INSERT HERE: the car must be this close to the route
  const KEEP_LINE_M = 150;     // moving a point further than this straightens its routed / driven legs
  const JOIN_M = 300;          // a driven piece is used as a leg only if it starts this close to the previous point
  const BOX_MAX_M = 300;       // roadbook box here: the car must be this close to the roadbook's line

  // ---------------------------------------------------------------- small helpers
  const clone = o => JSON.parse(JSON.stringify(o));
  const r6 = x => Math.round(x * 1e6) / 1e6;
  const rad = d => d * Math.PI / 180;
  const R = 6371008.8;
  function dist(a, b) {
    const p1 = rad(a[0]), p2 = rad(b[0]), dp = p2 - p1, dl = rad(b[1] - a[1]);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const rel = (a, b) => ((b - a + 540) % 360) - 180;
  function polyLen(pts) { let m = 0; for (let i = 1; i < pts.length; i++) m += dist(pts[i - 1], pts[i]); return m; }
  function capOf(pts) { // the builder's capOf: heading towards the point ~40 m along
    if (!pts || pts.length < 2) return null;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) { acc += dist(pts[i - 1], pts[i]); if (acc >= 40) return bearing(pts[0], pts[i]); }
    return bearing(pts[0], pts[pts.length - 1]);
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  let uid = 1;
  function newId() { return 'p' + Date.now().toString(36) + (uid++); }
  // flat metres round a latitude, and the nearest point on segment ab to p: {t, d, q}
  function projectSeg(p, a, b) {
    const kx = 111320 * Math.cos(rad(p[0])), ky = 110540;
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { t, d: Math.sqrt(x * x + y * y), q: [r6(a[0] + t * (b[0] - a[0])), r6(a[1] + t * (b[1] - a[1]))] };
  }
  // any JSON with every character above 0x7e written as \uXXXX: the text can travel to Lua as plain ASCII and is
  // still the same JSON for every reader (the website, the game's jsonReadFile)
  function asciiJSON(obj, indent) {
    return JSON.stringify(obj, null, indent == null ? 1 : indent).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }

  // ---------------------------------------------------------------- SHA-256 (the roadbook's stage hash needs it; the
  // game's UI page may not be a "secure context", where browsers hide crypto.subtle)
  const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
    0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256Bytes(msg) { // Uint8Array -> Uint8Array(32)
    const n = msg.length, L = ((n + 9 + 63) >> 6) << 6, b = new Uint8Array(L);
    b.set(msg); b[n] = 0x80;
    const bits = n * 8; b[L - 4] = bits >>> 24; b[L - 3] = bits >>> 16; b[L - 2] = bits >>> 8; b[L - 1] = bits; b[L - 5] = Math.floor(bits / 4294967296);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const ror = (x, s) => (x >>> s) | (x << (32 - s));
    for (let o = 0; o < L; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = H[i] >>> 16; out[4 * i + 2] = H[i] >>> 8; out[4 * i + 3] = H[i]; }
    return out;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function sha256Hex(s) { return Array.from(sha256Bytes(utf8(s)), x => x.toString(16).padStart(2, '0')).join(''); }
  // give the page a crypto.subtle.digest('SHA-256') when it has none; returns 'native' | 'shim' | 'failed'
  function installCryptoShim(win) {
    try {
      if (win.crypto && win.crypto.subtle && win.crypto.subtle.__rplShim) return 'shim';
      if (win.crypto && win.crypto.subtle && win.crypto.subtle.digest) return 'native';
      const subtle = { __rplShim: true, digest: (alg, data) => {
        const name = typeof alg === 'string' ? alg : alg && alg.name;
        if (String(name).toUpperCase() !== 'SHA-256') return Promise.reject(new Error('only SHA-256'));
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ? data.buffer : data);
        return Promise.resolve(sha256Bytes(u8).buffer);
      } };
      if (!win.crypto) Object.defineProperty(win, 'crypto', { value: {}, configurable: true });
      Object.defineProperty(win.crypto, 'subtle', { value: subtle, configurable: true });
      return win.crypto.subtle === subtle ? 'shim' : 'failed';
    } catch (e) { return 'failed'; }
  }

  // ---------------------------------------------------------------- the stage model (the builder's `st`)
  // { meta, rules, points: [{id, type, lat, lon, name, notes, danger, speedLimit, validate, revealRadius,
  //   leg: {mode, points} (the leg arriving here), extra: {unknown waypoint fields}}], orig: the file as read }
  // the fields of a box in the order the file had them (so an untouched stage saves byte-for-byte the same)
  function keyOrder(keys, o) {
    if (!keys) return o;
    const out = {};
    keys.forEach(k => { if (k in o) out[k] = o[k]; });
    Object.keys(o).forEach(k => { if (!(k in out)) out[k] = o[k]; });
    return out;
  }
  function newStage(name, id) {
    return { meta: { name: name || '', id: id || slug(name) || '', region: '', author: '', description: '', vehicleClass: '', start: null, created: new Date().toISOString() },
      rules: clone(FIM2026), points: [], orig: null };
  }
  const KNOWN_WP = new Set(['id', 'n', 'type', 'lat', 'lon', 'km', 'cap', 'name', 'speedLimit', 'validate', 'revealRadius', 'box']);
  const KNOWN_BOX = new Set(['n', 'id', 'km', 'partial', 'cap', 'waypoint', 'label', 'lat', 'lon', 'notes', 'danger']);
  // the builder's importStage, plus: unknown waypoint fields and the whole original file are kept for export
  function importStage(j) {
    if (!j || j.format !== 'rallyraid-stage') throw new Error('not a rally raid stage file');
    if ((j.schemaVersion || 0) > 1) throw new Error('made by a newer builder (schema ' + j.schemaVersion + ')');
    const s = newStage();
    s.meta = { name: j.name || '', id: j.id || '', region: j.region || '', author: j.author || '', description: j.description || '', vehicleClass: j.vehicleClass || '', start: j.start || null, created: j.created || new Date().toISOString() };
    s.rules = Object.assign(clone(FIM2026), j.rules || {});
    s.rules.waypoints = Object.assign(clone(FIM2026.waypoints), (j.rules && j.rules.waypoints) || {});
    s.rules.speedZone = Object.assign(clone(FIM2026.speedZone), (j.rules && j.rules.speedZone) || {});
    const legs = {}; ((j.route && j.route.legs) || []).forEach(l => { legs[l.to] = l; });
    const boxes = (j.roadbook && j.roadbook.boxes) || [];
    const byId = {}; (j.waypoints || []).forEach(w => { byId[w.id] = w; });
    const extraOf = w => { const e = {}; if (w) Object.keys(w).forEach(k => { if (!KNOWN_WP.has(k)) e[k] = clone(w[k]); }); return e; };
    const legOf = id => legs[id] ? Object.assign({}, clone(legs[id]), { mode: legs[id].mode, points: clone(legs[id].points) }) : null;
    const pts = [];
    if (Array.isArray(boxes) && boxes.length && boxes.every(b => b.lat != null)) {
      boxes.forEach((b, i) => {
        const w = b.waypoint ? byId[b.waypoint] : null;
        const id = w ? w.id : (b.id || ('note' + i + '_' + newId()));
        pts.push({ id, type: w ? w.type : 'NOTE', lat: w ? w.lat : b.lat, lon: w ? w.lon : b.lon, name: w ? (w.name || '') : '', notes: b.notes || '', danger: b.danger || 0,
          speedLimit: w ? w.speedLimit : null, validate: w ? w.validate : null, revealRadius: w ? w.revealRadius : null, extra: extraOf(w), leg: legOf(id),
          boxExtra: (() => { const e = {}; Object.keys(b).forEach(k => { if (!KNOWN_BOX.has(k)) e[k] = clone(b[k]); }); return e; })(), boxKeys: Object.keys(b) });
      });
    } else {
      (j.waypoints || []).forEach(w => {
        pts.push({ id: w.id || newId(), type: w.type, lat: w.lat, lon: w.lon, name: w.name || '', notes: '', danger: 0, speedLimit: w.speedLimit, validate: w.validate, revealRadius: w.revealRadius,
          extra: extraOf(w), leg: legOf(w.id) || { mode: 'direct' } });
      });
    }
    pts.forEach((p, i) => { if (i && (!p.leg || !p.leg.points)) p.leg = { mode: (p.leg && p.leg.mode) || 'direct', points: [[pts[i - 1].lat, pts[i - 1].lon], [p.lat, p.lon]] }; });
    if (pts[0]) pts[0].leg = null;
    s.points = pts;
    s.orig = clone(j);
    return s;
  }
  function legPts(s, i) {
    const p = s.points[i], q = s.points[i - 1];
    if (!p || !q) return null;
    if (p.leg && p.leg.points && p.leg.points.length > 1) return p.leg.points;
    return [[q.lat, q.lon], [p.lat, p.lon]];
  }
  // the builder's derive(): _km, _n, _cap, _legKm on every point; returns the length (km)
  function derive(s) {
    const pts = s.points; let km = 0, num = 0;
    const gpsCount = pts.filter(p => p.type !== 'NOTE' && p.type !== 'DSS' && p.type !== 'ASS').length;
    pts.forEach((p, i) => {
      if (i > 0) { p._legKm = polyLen(legPts(s, i)) / 1000; km += p._legKm; } else p._legKm = 0;
      p._km = km;
      if (p.type === 'NOTE') p._n = null; else if (p.type === 'DSS') p._n = 0; else if (p.type === 'ASS') p._n = gpsCount + 1; else p._n = ++num;
      p._cap = pts[i + 1] ? capOf(legPts(s, i + 1)) : null;
    });
    return km;
  }
  function labelOf(p) { return p.type === 'NOTE' ? 'NOTE' : p.type + (p.type === 'DSS' || p.type === 'ASS' ? '' : ' ' + p._n); }
  function ruleOf(s, p) {
    const r = s.rules.waypoints[p.type];
    if (!r) return null;
    return { reveal: p.reveal || r.reveal, radius: p.revealRadius != null && p.revealRadius !== '' ? +p.revealRadius : r.radius,
      validate: p.validate != null && p.validate !== '' ? +p.validate : r.validate };
  }
  // the builder's problems(): [['err' | 'warn', text]]; 'err' ones are what the game refuses (rallyRaid/stages.lua)
  function problems(s) {
    derive(s);
    const out = [], pts = s.points.filter(p => p.type !== 'NOTE');
    if (!pts.length) { out.push(['err', 'No points yet: drive to the start and press ADD HERE (a DSS).']); return out; }
    if (pts.length < 2) out.push(['err', 'A stage needs at least a DSS and an ASS.']);
    if (pts[0].type !== 'DSS') out.push(['err', 'The first GPS point must be the DSS.']);
    if (pts[pts.length - 1].type !== 'ASS') out.push(['err', 'The last GPS point must be the ASS.']);
    let z = false;
    pts.forEach((p, i) => {
      if ((p.type === 'DSS' && i) || (p.type === 'ASS' && i !== pts.length - 1)) out.push(['err', p.type + ' only at the start / end (' + labelOf(p) + ').']);
      if (p.type === 'DZ') { if (z) out.push(['err', 'DZ inside another speed zone.']); z = true; if (!(+p.speedLimit > 0)) out.push(['err', labelOf(p) + ' needs a speed limit.']); }
      if (p.type === 'FZ') { if (!z) out.push(['err', 'FZ without a DZ before it.']); z = false; }
      if (i) {
        const q = pts[i - 1], d = dist([q.lat, q.lon], [p.lat, p.lon]), rq = ruleOf(s, q), rp = ruleOf(s, p);
        if (rq && rp && d < rq.validate + rp.validate) out.push(['warn', labelOf(q) + ' and ' + labelOf(p) + ' are ' + Math.round(d) + ' m apart: their validation circles overlap.']);
      }
    });
    if (z) out.push(['err', 'A speed zone is never closed with an FZ.']);
    s.points.forEach(p => {
      if (p.leg && p.leg.failed) out.push(['warn', 'Leg to ' + labelOf(p) + ' could not be routed on roads (drawn straight).']);
      if (p.leg && p.leg.straightened) out.push(['warn', 'Leg to ' + labelOf(p) + ' was made straight when a point moved: re-route it (ROAD) or re-drive it.']);
    });
    if (!s.meta.id) out.push(['err', 'The stage needs a name.']);
    const st = s.meta.start, d0 = s.points.find(p => p.type === 'DSS');
    if (st && d0 && dist([+st.lat, +st.lon], [d0.lat, d0.lon]) > 2000) out.push(['warn', 'The start position (TP TO DSS) is ' + (dist([+st.lat, +st.lon], [d0.lat, d0.lon]) / 1000).toFixed(1) + ' km from the DSS.']);
    return out;
  }
  // the builder's exportStage(), on top of the file as it was read (fields the planner does not know are kept)
  function exportStage(s) {
    const total = derive(s);
    const gps = s.points.filter(p => p.type !== 'NOTE');
    const id = s.meta.id || slug(s.meta.name) || 'stage';
    const boxes = []; let prevKm = 0;
    s.points.forEach((p, i) => {
      boxes.push(keyOrder(p.boxKeys, Object.assign(clone(p.boxExtra || {}), { n: i + 1, id: p.id, km: +p._km.toFixed(3), partial: +(p._km - prevKm).toFixed(3), cap: p._cap != null ? Math.round(p._cap) : null,
        waypoint: p.type === 'NOTE' ? null : p.id, label: labelOf(p), lat: p.lat, lon: p.lon, notes: p.notes || undefined, danger: p.danger || undefined })));
      prevKm = p._km;
    });
    const base = s.orig ? clone(s.orig) : {};
    const out = Object.assign(base, {
      format: 'rallyraid-stage', schemaVersion: 1, generator: base.generator && !/ingame-planner/.test(base.generator) ? base.generator + '; ' + GENERATOR : (base.generator || 'rallyraid-stage-builder ' + BUILDER_VERSION + '; ' + GENERATOR),
      id, name: s.meta.name || id, region: s.meta.region || '', author: s.meta.author || '', description: s.meta.description || '',
      vehicleClass: s.meta.vehicleClass || '', created: s.meta.created, modified: new Date().toISOString(),
      dataSource: base.dataSource || 'OpenStreetMap contributors (ODbL), routed with OSRM; driven in game (BeamNG.Earth)',
      lengthKm: +total.toFixed(3),
      start: s.meta.start || undefined,
      rules: s.rules,
      waypoints: gps.map(p => {
        const w = Object.assign(clone(p.extra || {}), { id: p.id, n: p._n, type: p.type, lat: p.lat, lon: p.lon, km: +p._km.toFixed(3), cap: p._cap != null ? Math.round(p._cap) : null });
        if (p.name) w.name = p.name; else delete w.name;
        if (p.type === 'DZ') w.speedLimit = +p.speedLimit; else delete w.speedLimit;
        if (p.validate != null && p.validate !== '') w.validate = +p.validate;
        if (p.revealRadius != null && p.revealRadius !== '') w.revealRadius = +p.revealRadius;
        w.box = s.points.indexOf(p) + 1;
        return w;
      }),
      roadbook: Object.assign({}, base.roadbook && typeof base.roadbook === 'object' ? base.roadbook : {}, { boxes, file: (base.roadbook && base.roadbook.file) || null }),
      route: { legs: s.points.slice(1).map((p, i) => {
        const keep = p.leg ? Object.assign({}, p.leg) : {};
        ['straightened', 'failed', 'pending', 'mode', 'points', 'km', 'from', 'to'].forEach(k => delete keep[k]);
        return Object.assign(keep, { from: s.points[i].id, to: p.id, mode: p.leg ? p.leg.mode : 'direct', km: +p._legKm.toFixed(3),
          points: legPts(s, i + 1).map(q => [r6(q[0]), r6(q[1])]) });
      }) },
      builder: Object.assign({}, base.builder || {}, { notes: s.points.filter(p => p.type === 'NOTE').map(p => p.id) })
    });
    if (out.start === undefined) delete out.start;
    // a planned (roadbook) line on a leg whose ends moved is no longer the planner's line
    out.route.legs.forEach(l => { if (l.planned && l.mode !== 'direct') delete l.planned; });
    return out;
  }

  // ---------------------------------------------------------------- editing the route (positions come from the car)
  // the type a new point gets by default: DSS first, then WPV
  function nextType(s) { return s.points.some(p => p.type === 'DSS') ? (s.points.length && s.points[s.points.length - 1].type === 'ASS' ? 'ASS' : 'WPV') : 'DSS'; }
  // the leg into a new point from a driven piece [[lat, lon, alt], ...] (Lua: planner mark), or straight
  function legFrom(prev, at, piece) {
    const seg = (piece || []).filter(q => Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]));
    if (prev && seg.length >= 2 && dist([prev.lat, prev.lon], [seg[0][0], seg[0][1]]) <= JOIN_M) {
      const pts = [[prev.lat, prev.lon]].concat(seg.map(q => [r6(q[0]), r6(q[1])]), [[at.lat, at.lon]]);
      return { mode: 'track', points: dedupe(pts) };
    }
    return { mode: 'direct', points: prev ? [[prev.lat, prev.lon], [at.lat, at.lon]] : null };
  }
  function dedupe(pts) { const o = []; pts.forEach(p => { const l = o[o.length - 1]; if (!l || dist(l, p) > 0.5) o.push(p); }); if (o.length === 1 && pts.length > 1) o.push(pts[pts.length - 1]); return o; }
  // ADD HERE: a new point at the end of the stage. Adding after an ASS turns that ASS into a WPV (the finish moves on).
  function addPoint(s, at, opts) {
    opts = opts || {};
    const type = opts.type || nextType(s);
    if (TYPES.indexOf(type) < 0) throw new Error('unknown point type ' + type);
    const lat = r6(+at.lat), lon = r6(+at.lon);
    const prev = s.points[s.points.length - 1];
    const said = [];
    if (prev && prev.type === 'ASS') { prev.type = 'WPV'; said.push('the old ASS is now a WPV'); }
    if (type === 'DSS' && s.points.some(p => p.type === 'DSS')) said.push('this stage already has a DSS');
    const p = { id: opts.id || newId(), type, lat, lon, name: opts.name || '', notes: '', danger: 0, speedLimit: type === 'DZ' ? (opts.speedLimit || 50) : null, validate: null, revealRadius: null, extra: {},
      leg: prev ? legFrom(prev, { lat, lon }, opts.piece) : null };
    s.points.push(p);
    return { point: p, index: s.points.length - 1, said };
  }
  // INSERT HERE: a new point on the route where the car is (nearest leg, within SPLIT_MAX_M); the leg is split there
  function nearestOnStage(s, at) {
    let best = null;
    for (let i = 1; i < s.points.length; i++) {
      const pts = legPts(s, i);
      for (let k = 1; k < pts.length; k++) { const pr = projectSeg([at.lat, at.lon], pts[k - 1], pts[k]); if (!best || pr.d < best.d) best = { i, k, d: pr.d, q: pr.q, t: pr.t }; }
    }
    return best;
  }
  function insertPoint(s, at, opts) {
    opts = opts || {};
    const n = nearestOnStage(s, at);
    if (!n) return { error: 'Add a DSS and at least one more point first.' };
    if (n.d > SPLIT_MAX_M) return { error: 'You are ' + Math.round(n.d) + ' m from the route: drive to it (within ' + SPLIT_MAX_M + ' m), or use ADD HERE to extend the stage.' };
    const p = s.points[n.i], pts = legPts(s, n.i), mode = p.leg ? p.leg.mode : 'direct';
    const q = [r6(+at.lat), r6(+at.lon)];
    const a = dedupe(pts.slice(0, n.k).concat([n.q, q])), b = dedupe([q, n.q].concat(pts.slice(n.k)));
    const type = opts.type && opts.type !== 'DSS' && opts.type !== 'ASS' ? opts.type : 'WPV';
    const np = { id: opts.id || newId(), type, lat: q[0], lon: q[1], name: opts.name || '', notes: '', danger: 0, speedLimit: type === 'DZ' ? (opts.speedLimit || 50) : null, validate: null, revealRadius: null, extra: {},
      leg: { mode, points: a } };
    p.leg = Object.assign({}, p.leg || {}, { mode, points: b });
    delete p.leg.planned;
    s.points.splice(n.i, 0, np);
    return { point: np, index: n.i, offM: Math.round(n.d) };
  }
  function straight(s, i, why) {
    const p = s.points[i], q = s.points[i - 1];
    if (!p || !q) return;
    const was = p.leg ? p.leg.mode : 'direct';
    p.leg = { mode: 'direct', points: [[q.lat, q.lon], [p.lat, p.lon]] };
    if (why && was !== 'direct') p.leg.straightened = true;
  }
  // MOVE HERE: the point goes to the car. Its legs keep their line when it moved a little (the end is re-joined),
  // and are made straight (flagged) when it moved further.
  function movePoint(s, i, at) {
    const p = s.points[i]; if (!p) return { error: 'no such point' };
    const to = [r6(+at.lat), r6(+at.lon)], moved = dist([p.lat, p.lon], to);
    p.lat = to[0]; p.lon = to[1];
    const fix = (j, end) => {
      const x = s.points[j]; if (!x || !x.leg) return;
      if (x.leg.mode === 'direct' || !x.leg.points || x.leg.points.length < 2) { straight(s, j); return; }
      if (moved > KEEP_LINE_M) { straight(s, j, true); return; }
      const pts = x.leg.points.slice();
      if (end) pts[pts.length - 1] = to; else pts[0] = to;
      x.leg = Object.assign({}, x.leg, { points: pts }); delete x.leg.planned;
    };
    fix(i, true); fix(i + 1, false);
    if (i === 0 && s.points[0]) s.points[0].leg = null;
    return { movedM: Math.round(moved), straightened: moved > KEEP_LINE_M };
  }
  // DELETE: the two legs either side become one (joined if both follow a line, else straight)
  function deletePoint(s, i) {
    const p = s.points[i]; if (!p) return;
    const nx = s.points[i + 1];
    if (nx && i > 0) {
      const a = legPts(s, i), b = legPts(s, i + 1), ma = p.leg ? p.leg.mode : 'direct', mb = nx.leg ? nx.leg.mode : 'direct';
      if (ma === mb && ma !== 'direct') nx.leg = { mode: ma, points: dedupe(a.concat(b.slice(1))) };
      else nx.leg = { mode: 'direct', points: [[s.points[i - 1].lat, s.points[i - 1].lon], [nx.lat, nx.lon]] };
    }
    s.points.splice(i, 1);
    if (s.points[0]) s.points[0].leg = null;
  }
  // UP / DOWN: swap with the neighbour; the legs touched are straight (the order changed, the lines no longer fit)
  function shiftPoint(s, i, dir) {
    const j = i + dir; if (j < 0 || j >= s.points.length) return false;
    const t = s.points[i]; s.points[i] = s.points[j]; s.points[j] = t;
    const lo = Math.min(i, j);
    for (let k = Math.max(1, lo); k <= Math.min(s.points.length - 1, lo + 2); k++) straight(s, k);
    if (s.points[0]) s.points[0].leg = null;
    return true;
  }
  function setType(s, i, type) {
    const p = s.points[i]; if (!p || TYPES.indexOf(type) < 0) return;
    p.type = type;
    if (type === 'DZ' && !(+p.speedLimit > 0)) p.speedLimit = 50;
  }
  // a leg's mode: 'direct' (straight), 'road' (needs routeRoadLeg), 'track' (only a leg that has a driven line)
  function setLegMode(s, i, mode) {
    const p = s.points[i]; if (!p || i === 0) return 'none';
    if (mode === 'direct') { straight(s, i); return 'ok'; }
    if (mode === 'track') { if (p.leg && p.leg.points && p.leg.points.length > 2) { p.leg.mode = 'track'; delete p.leg.straightened; return 'ok'; } return 'no-line'; }
    if (mode === 'road') return 'needs-route';
    return 'none';
  }
  // the builder's OSRM routing for a leg (online only). fetchJson(url) -> Promise<object>
  async function routeRoadLeg(s, i, fetchJson) {
    const p = s.points[i], q = s.points[i - 1];
    if (!p || !q) throw new Error('no leg');
    const a = [q.lat, q.lon], b = [p.lat, p.lon];
    const url = 'https://router.project-osrm.org/route/v1/driving/' + a[1] + ',' + a[0] + ';' + b[1] + ',' + b[0] + '?overview=full&geometries=geojson';
    try {
      const j = await fetchJson(url);
      if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error((j && (j.message || j.code)) || 'no route');
      const pts = j.routes[0].geometry.coordinates.map(c => [r6(c[1]), r6(c[0])]);
      pts[0] = a; pts[pts.length - 1] = b;
      p.leg = { mode: 'road', points: pts };
      return { ok: true, km: polyLen(pts) / 1000 };
    } catch (e) {
      p.leg = { mode: 'direct', points: [a, b], failed: true };
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // ---------------------------------------------------------------- the roadbook (RoadbookGen = RB)
  function routeStageFor(rb, stage) {
    if (rb && rb.route && rb.route.legs && rb.route.legs.length) return { waypoints: stage.waypoints, route: { legs: rb.route.legs } };
    return stage;
  }
  function samples(RB, rb, stage) { return RB.resampleRoute(routeStageFor(rb, stage), 20); }
  function nearestSample(S, lat, lon) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < S.length; i++) { const d = dist([S[i].lat, S[i].lon], [lat, lon]); if (d < bd) { bd = d; best = i; } }
    return { i: best, s: S[best], d: bd };
  }
  function sampleAtKm(S, km) { let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].km < km) lo = m + 1; else hi = m; } return S[lo]; }
  const capAt = s => Math.round(((s.hdg % 360) + 360) % 360);
  const NOTE_BY = 'in-game planner';
  function change(RB, rb, list) {
    const at = new Date().toISOString();
    const res = RB.applyChanges(rb, list.map(c => Object.assign({ by: 'editor', at, note: NOTE_BY }, c)));
    rb.modified = at;
    return res;
  }
  // BOX HERE: a new box on the roadbook's line at the car (the editor's newBoxAt)
  function addBoxHere(RB, rb, stage, at, extra) {
    const S = samples(RB, rb, stage), n = nearestSample(S, at.lat, at.lon);
    if (!n.s || n.d > BOX_MAX_M) return { error: 'You are ' + Math.round(n.d) + ' m from the roadbook\'s line (a box must be within ' + BOX_MAX_M + ' m).' };
    const s = n.s, prev = sampleAtKm(S, Math.max(0, s.km - 0.06));
    const id = 'ed-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const off = s.mode === 'direct';
    const box = Object.assign({ km: +s.km.toFixed(2), lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6), capIn: capAt(prev), capOut: capAt(s), cap: capAt(s), offPiste: off,
      label: 'NOTE', notes: '', symbols: [], danger: 0, tulip: { entry: { track: off ? 'offpiste' : 'track' }, exit: { angle: Math.round(rel(capAt(prev), capAt(s))), track: off ? 'offpiste' : 'track' }, branches: [] } }, extra || {});
    const res = change(RB, rb, [{ op: 'add', id, box }]);
    return { id, offM: Math.round(n.d), res };
  }
  // MOVE HERE: the box goes to the car's spot on the line (km re-measured)
  function moveBoxHere(RB, rb, stage, id, at) {
    const b = rb.boxes.find(x => x.id === id); if (!b) return { error: 'no such box' };
    const S = samples(RB, rb, stage), n = nearestSample(S, at.lat, at.lon);
    if (!n.s || n.d > BOX_MAX_M) return { error: 'You are ' + Math.round(n.d) + ' m from the roadbook\'s line.' };
    const res = change(RB, rb, [{ op: 'move', id, baseRev: b.rev, lat: +n.s.lat.toFixed(6), lon: +n.s.lon.toFixed(6), km: +n.s.km.toFixed(2) }]);
    const x = rb.boxes.find(y => y.id === id); if (x) x.capOut = x.cap = capAt(n.s);
    return { res, offM: Math.round(n.d) };
  }
  function updateBox(RB, rb, id, fields) {
    const b = rb.boxes.find(x => x.id === id); if (!b) return { error: 'no such box' };
    return { res: change(RB, rb, [{ op: 'update', id, baseRev: b.rev, fields: clone(fields) }]) };
  }
  function deleteBox(RB, rb, id) {
    const b = rb.boxes.find(x => x.id === id); if (!b) return { error: 'no such box' };
    if (b.waypoint) return { error: 'A waypoint\'s box cannot be deleted (delete the waypoint on the ROUTE tab).' };
    return { res: change(RB, rb, [{ op: 'delete', id, baseRev: b.rev }]) };
  }
  // the tulip with its exit turned by `deg` (the drawing's own data: exit.angle, -180..180, 0 = straight on)
  function turnedTulip(b, deg) {
    const t = clone(b.tulip && typeof b.tulip === 'object' ? b.tulip : { entry: { track: 'track' }, exit: { angle: 0, track: 'track' }, branches: [] });
    t.exit = t.exit || { angle: 0, track: 'track' };
    t.exit.angle = Math.max(-180, Math.min(180, Math.round(((+t.exit.angle || 0) + deg) / 5) * 5));
    return t;
  }
  function toggleSymbol(b, code) {
    const s = Array.isArray(b.symbols) ? b.symbols.slice() : [];
    const i = s.indexOf(code); if (i >= 0) s.splice(i, 1); else s.push(code);
    return s;
  }
  function liveBoxes(rb) { return rb ? rb.boxes.filter(b => !b.deleted) : []; }

  // ---------------------------------------------------------------- generating without the website's data
  // heights from the car's own driven line ([[lat, lon, alt], ...]): the nearest point within 40 m, else NaN (the
  // generator fills gaps). null when the line covers less than half the route.
  function heightFnFromDrive(points, stage) {
    const P = (points || []).filter(q => q && isFinite(q[0]) && isFinite(q[1]) && isFinite(q[2]));
    if (P.length < 10) return null;
    const cell = 0.0005, grid = new Map(), key = (a, b) => a + ',' + b;
    P.forEach(q => { const k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(q); });
    const near = (lat, lon) => {
      const a = Math.floor(lat / cell), b = Math.floor(lon / cell); let best = null, bd = 40;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) (grid.get(key(a + i, b + j)) || []).forEach(q => { const d = dist([lat, lon], q); if (d < bd) { bd = d; best = q; } });
      return best;
    };
    const fn = (lat, lon) => { const q = near(lat, lon); return q ? q[2] : NaN; };
    if (stage) {
      let n = 0, hit = 0;
      ((stage.route && stage.route.legs) || []).forEach(l => (l.points || []).forEach((p, k) => { if (k % 3) return; n++; if (near(p[0], p[1])) hit++; }));
      fn.coverage = n ? hit / n : 0;
      if (fn.coverage < 0.5) return null;
    }
    return fn;
  }
  // is the map data online? (a game may have no network for its UI) fetchFn(url, {signal}) -> Response
  async function probeOnline(fetchFn, url, timeoutMs) {
    if (!fetchFn) return false;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs || 6000);
    try { const r = await fetchFn(url || 'https://tiles.mapterhorn.com/12/2048/1361.webp', ctl ? { signal: ctl.signal, cache: 'no-store' } : {}); return !!(r && (r.ok || r.status === 404)); }
    catch (e) { return false; } finally { clearTimeout(t); }
  }
  // generate (or regenerate, keeping every edited / pinned box) the roadbook for the exported stage.
  // online: the website's full generator (terrain, OpenStreetMap, landmarks, the off-piste planner).
  // offline: the route's own geometry (waypoints, bends, CAPs), plus climbs / crests / dips from the heights the car
  // recorded when the stage was driven in the planner. mode is written to rb.ingame and rb.partial.
  async function generateRoadbook(RB, stage, opts) {
    opts = opts || {};
    const old = opts.old || null, ed = (old && old.editor) || {};
    const density = opts.density || (old && old.settings && old.settings.density) || 4;
    let fresh = null, mode = 'full', why = null;
    const common = { density, onProgress: opts.onProgress, log: opts.log };
    if (opts.online) {
      // one terrain tile first: a game UI with half a network should not wait for every map server to time out
      try {
        const dem = RB.createDem({ fetchBytes: opts.fetchBytes, decodeImage: opts.decodeImage }), w0 = stage.waypoints[0];
        await dem.load([[w0.lat, w0.lon]]);
        if (!Number.isFinite(dem.h(w0.lat, w0.lon))) why = 'the terrain tiles could not be read';
      } catch (e) { why = 'the terrain tiles could not be read (' + String(e && e.message || e) + ')'; }
    }
    if (opts.online && !why) {
      try { fresh = await RB.generate(stage, Object.assign({}, common, { osmOptional: true, lineOverrides: ed.lineOverrides || {}, legSeeds: ed.legSeeds || {}, fetchBytes: opts.fetchBytes, decodeImage: opts.decodeImage })); if (fresh.partial === 'terrain-only') mode = 'terrain-only'; }
      catch (e) { fresh = null; why = String(e && e.message || e); }
      if (fresh && fresh.sources && fresh.sources.elevation && fresh.sources.elevation.name === 'none') { fresh = null; why = 'no terrain tiles came back'; }
    }
    if (!fresh) {
      const hf = heightFnFromDrive(opts.drive, stage);
      mode = hf ? 'driven-heights' : 'route-only';
      fresh = await RB.generate(stage, Object.assign({}, common, { heightFn: hf || (() => 0), useOsm: false, planOffPiste: false, useLandCover: false, useLandmarks: false }));
      fresh.partial = mode;
      fresh.sources = Object.assign({}, fresh.sources || {}, { elevation: hf ? { name: 'driven-line', primary: 'heights the car recorded in the in-game planner', coveragePct: Math.round(hf.coverage * 100) } : null, osm: null });
      if (!hf && fresh.profile) fresh.profile.h = fresh.profile.h.map(() => null);
    }
    fresh.editor = { lineOverrides: ed.lineOverrides || {}, legSeeds: ed.legSeeds || {} };
    fresh.ingame = { mode, at: new Date().toISOString(), by: GENERATOR, offlineReason: why };
    if (old && old.boxes && old.boxes.length) {
      const m = RB.mergeRegenerated(old, fresh, stage, { density });
      m.editor = fresh.editor; m.route = fresh.route; m.planner = fresh.planner; m.ingame = fresh.ingame;
      if (mode !== 'full') m.partial = mode; else delete m.partial;
      return { rb: m, mode, merged: true, why };
    }
    return { rb: fresh, mode, merged: false, why };
  }
  // what a roadbook says about the stage it belongs to: 'ok' | 'stale' (the route changed since) | 'other' | 'none'
  async function roadbookFits(RB, rb, stage) {
    if (!rb) return 'none';
    if (rb.stage && rb.stage.id && rb.stage.id !== stage.id) return 'other';
    const h = await RB.stageHash(stage);
    return rb.stage && rb.stage.hash && rb.stage.hash !== h ? 'stale' : 'ok';
  }

  // ---------------------------------------------------------------- a draft (unsaved work survives a UI reload)
  function draft(s, rb, drive) { return { format: 'rallyraid-planner-draft', schemaVersion: 1, saved: new Date().toISOString(), stage: exportStage(s), roadbook: rb || null, drive: drive || [] }; }
  function readDraft(d) {
    if (!d || d.format !== 'rallyraid-planner-draft') throw new Error('not a planner draft');
    return { stage: importStage(d.stage), rb: d.roadbook || null, drive: Array.isArray(d.drive) ? d.drive : [] };
  }

  return { VERSION, GENERATOR, TYPES, TYPE_NAMES, FIM2026, SPLIT_MAX_M, KEEP_LINE_M, JOIN_M, BOX_MAX_M,
    dist, bearing, rel, polyLen, capOf, slug, newId, r6, projectSeg, asciiJSON, sha256Hex, sha256Bytes, installCryptoShim,
    newStage, importStage, exportStage, derive, labelOf, problems, legPts, nextType, addPoint, insertPoint, nearestOnStage, movePoint,
    deletePoint, shiftPoint, setType, setLegMode, routeRoadLeg,
    samples, nearestSample, sampleAtKm, addBoxHere, moveBoxHere, updateBox, deleteBox, turnedTulip, toggleSymbol, liveBoxes,
    heightFnFromDrive, probeOnline, generateRoadbook, roadbookFits, draft, readDraft, clone };
});
