// rally.raid Earth rally tools: shared logic for the batch runner (rally-batch.js) and the compiler (rally-compile.js).
// Rally file format: docs/RALLY_FORMAT.md. Pure node, no network.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FORMAT = 'rallyraid-rally', VERSION = 1;
const DISCLAIMER_RE = /^Inspired by the \d{4} .+ route\. Unofficial, not affiliated\.$/;
const BANNED = /\b(dakar|a\.?s\.?o\.?|amaury|w2rc|world rally-?raid championship|fia|fim)\b/i;   // marks never in titles / ids / file names
const LIAISON_DEFAULTS = { kmh: 60, extraMin: 30, roundMin: 5 };
const R = 6371008.8, rad = d => d * Math.PI / 180;
function dist(a, b) { const p1 = rad(a[0]), p2 = rad(b[0]), dp = p2 - p1, dl = rad(b[1] - a[1]); const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
/** liaison time allowance (minutes): km at kmh, plus extraMin, rounded UP to roundMin. 0 km -> 0 */
function allowanceMin(km, cfg) { const c = Object.assign({}, LIAISON_DEFAULTS, cfg || {}); if (!(km > 0)) return 0; return Math.ceil((km / c.kmh * 60 + c.extraMin) / c.roundMin) * c.roundMin; }
function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function stageIdFor(spec, day) { return (spec.idPrefix + '-' + String(day.code).toLowerCase()).replace(/[^a-z0-9-]/g, '-'); }
function landmarkOf(spec, id) { const l = (spec.landmarks || []).find(x => x.id === id); if (!l) throw new Error('unknown landmark ' + id); return l; }
function viasOf(spec, day) { return (day.vias || []).map(v => v[0] === 'landmark' ? (l => [l.lat, l.lon])(landmarkOf(spec, v[1])) : v.map(Number)); }
function stageDays(spec) { return spec.days.filter(d => d.ssKm > 0); }
/** the Stage-Gen (chain) inputs for one stage day */
function stageInputs(spec, day) {
  const g = spec.generation || {};
  return { dss: day.dss, ass: day.ass, lengthKm: day.ssKm, preset: day.preset || 'mixed', offShare: day.offShare, region: day.title.replace(/^(SS\d+|Prologue)\s*/, ''),
    vias: viasOf(spec, day), side: day.side || 'left', loopBearing: day.loopBearing };
}
function chainOpts(spec) { const g = spec.generation || {}; return { segMaxKm: g.segMaxKm || 150, ratio: g.ratio || 1.3 }; }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * Compile: event spec + generated stage files -> rally file (+ the list of stage files to ship).
 * stageDir: folder with <stageId>.json (and optionally <stageId>.roadbook.json).
 * Returns {rally, stages: [{id, file, roadbook}], problems: []}
 */
function compile(spec, stageDir, opts) {
  opts = opts || {};
  const problems = [], warn = [], out = [];
  const cfg = Object.assign({}, LIAISON_DEFAULTS, spec.liaison || {});
  const B = {}; for (const b of spec.bivouacs) B[b.id] = b;
  const tol = opts.tolerance != null ? opts.tolerance : 0.10;
  const days = spec.days.map(d => {
    const from = B[d.from], to = B[d.to];
    if (!from || !to) problems.push('day ' + d.n + ': unknown bivouac ' + (!from ? d.from : d.to));
    const lzIn = d.ssKm > 0 ? +d.liaisonInKm || 0 : 0, lzOut = d.type === 'rest' ? 0 : +d.liaisonOutKm || 0;
    const day = { n: d.n, date: d.date, type: d.type, code: d.code, title: d.title, from: d.from, to: d.to,
      marathon: d.type === 'marathon', totalKm: d.totalKm || 0, note: d.note || undefined, via: d.via || undefined };
    if (d.type !== 'rest') {
      day.liaisonOut = { km: lzOut, allowanceMin: allowanceMin(lzOut, cfg), to: d.ssKm > 0 ? 'dss' : d.to, drive: !d.ferry, ferry: !!d.ferry || undefined };
      if (d.ssKm > 0) day.liaisonIn = { km: lzIn, allowanceMin: allowanceMin(lzIn, cfg), from: 'ass', drive: true };
    }
    if (d.ssKm > 0) {
      const id = stageIdFor(spec, d), f = path.join(stageDir, id + '.json');
      day.stage = { id, file: spec.id + '/stages/' + id + '.json', targetKm: d.ssKm, km: null, landmarks: d.landmarks || [] };
      if (fs.existsSync(f)) {
        const st = loadJson(f);
        day.stage.km = st.lengthKm; day.stage.name = st.name;
        const dss = st.waypoints[0], ass = st.waypoints[st.waypoints.length - 1];
        day.stage.dss = { lat: dss.lat, lon: dss.lon }; day.stage.ass = { lat: ass.lat, lon: ass.lon };
        day.stage.waypoints = st.waypoints.length; day.stage.boxes = st.roadbook.boxes.length;
        day.stage.parts = st.builder && st.builder.stagegen && st.builder.stagegen.chain ? st.builder.stagegen.chain.segments.length : 1;
        const dev = (st.lengthKm - d.ssKm) / d.ssKm;
        day.stage.deviation = +dev.toFixed(3);
        if (Math.abs(dev) > tol) warn.push(d.code + ': generated ' + st.lengthKm.toFixed(1) + ' km vs target ' + d.ssKm + ' km (' + (dev * 100).toFixed(1) + '%, outside +-' + tol * 100 + '%)');
        const rbf = path.join(stageDir, id + '.roadbook.json');
        day.stage.roadbook = fs.existsSync(rbf) ? spec.id + '/stages/' + id + '.roadbook.json' : null;
        day.stage.preview = preview(st, opts.previewM || 1500);
        out.push({ id, file: f, roadbook: fs.existsSync(rbf) ? rbf : null, sha256: sha256(fs.readFileSync(f)) });
        // liaison geometry: straight line bivouac -> DSS and ASS -> bivouac (the drive option is free routing on roads)
        day.liaisonOut.straightKm = from ? +(dist([from.lat, from.lon], [dss.lat, dss.lon]) / 1000).toFixed(1) : null;
        day.liaisonIn.straightKm = to ? +(dist([ass.lat, ass.lon], [to.lat, to.lon]) / 1000).toFixed(1) : null;
      } else if (!opts.allowMissing) problems.push(d.code + ': stage file missing (' + f + ')');
      else warn.push(d.code + ': stage not generated yet');
    }
    return day;
  });
  const stageKm = days.filter(d => d.stage && d.stage.km).reduce((a, d) => a + d.stage.km, 0);
  const rally = {
    format: FORMAT, schemaVersion: VERSION, id: spec.id, name: spec.name, shortName: spec.shortName, season: spec.season,
    disclaimer: spec.disclaimer, description: spec.description, region: spec.region, startDate: spec.startDate, endDate: spec.endDate,
    experimental: true, generator: 'rallyraid-rally-compile 1.0.0', created: opts.created || new Date().toISOString(),
    dataSource: 'Stage lines: rally.raid Earth Stage-Gen on OpenStreetMap contributors (ODbL), Mapterhorn terrain, ESA WorldCover 2021 (CC BY 4.0). Route facts (towns, dates, distances): ' + ((spec.source && spec.source.facts) || ''),
    source: spec.source,
    rules: {
      liaison: cfg,
      teleport: 'A teleported liaison counts its full allowance as elapsed time.',
      bivouac: 'Allowance not used on liaisons that day is added to the evening bivouac repair time (repairConfig.lua rally section).',
      marathon: 'Marathon days: no assistance at the refuge; the bivouac repair is limited (repairConfig.lua rally.marathon).',
      lateMin: 'Arriving after the allowance: rally.latePenaltyPerMinS seconds per started minute late (repairConfig.lua).'
    },
    bivouacs: spec.bivouacs.map(b => { const o = { id: b.id, name: b.name, lat: b.lat, lon: b.lon, kind: b.kind }; if (b.country) o.country = b.country; if (/INVENTED/.test(b.where || '')) o.invented = true; return o; }),
    landmarks: (spec.landmarks || []).map(l => ({ id: l.id, name: l.name, lat: l.lat, lon: l.lon, osm: l.osm })),
    totals: { days: days.length, stages: days.filter(d => d.stage).length, ssTargetKm: stageDays(spec).reduce((a, d) => a + d.ssKm, 0), ssKm: +stageKm.toFixed(1),
      liaisonKm: days.reduce((a, d) => a + (d.liaisonOut ? d.liaisonOut.km : 0) + (d.liaisonIn ? d.liaisonIn.km : 0), 0), publishedTotalKm: spec.days.reduce((a, d) => a + (d.totalKm || 0), 0) },
    days
  };
  problems.push(...validate(rally));
  return { rally, stages: out, problems, warnings: warn };
}

/** a light line for maps (every ~stepM metres along the route), [[lat, lon], ...] with 4 decimals */
function preview(st, stepM) {
  const pts = []; let acc = stepM;
  for (const l of st.route.legs) for (let i = 0; i < l.points.length; i++) {
    const p = l.points[i];
    if (pts.length) acc += dist(pts[pts.length - 1].raw, p);
    if (!pts.length || acc >= stepM) { pts.push({ raw: p }); acc = 0; }
  }
  const last = st.route.legs[st.route.legs.length - 1]; const lp = last.points[last.points.length - 1]; pts.push({ raw: lp });
  return pts.map(p => [+p.raw[0].toFixed(4), +p.raw[1].toFixed(4)]);
}
/** rally file checks: [] = OK */
function validate(r) {
  const e = [];
  if (r.format !== FORMAT) e.push('format must be ' + FORMAT);
  if (r.schemaVersion !== VERSION) e.push('schemaVersion must be ' + VERSION);
  if (!/^[a-z0-9-]+$/.test(r.id || '')) e.push('id must be [a-z0-9-]');
  if (!r.name) e.push('name missing');
  if (!DISCLAIMER_RE.test(r.disclaimer || '')) e.push('disclaimer must be one "Inspired by the <year> ... route. Unofficial, not affiliated." line');
  for (const [k, v] of [['id', r.id], ['name', r.name], ['shortName', r.shortName]]) if (v && BANNED.test(v)) e.push(k + ' uses an event / organiser mark: ' + v);
  const bids = new Set();
  for (const b of r.bivouacs || []) {
    if (!b.id || bids.has(b.id)) e.push('bivouac id missing or repeated: ' + b.id); bids.add(b.id);
    if (!(Math.abs(b.lat) <= 90 && Math.abs(b.lon) <= 180)) e.push('bivouac ' + b.id + ': bad lat / lon');
    if (!/^(bivouac|marathon|rest|port)$/.test(b.kind)) e.push('bivouac ' + b.id + ': kind ' + b.kind);
    if (BANNED.test(b.name)) e.push('bivouac ' + b.id + ' name uses a mark');
  }
  const days = r.days || []; let prevTo = null, prevDate = null;
  days.forEach((d, i) => {
    const w = 'day ' + d.n + ': ';
    if (d.n !== i + 1) e.push(w + 'days must be numbered 1..N in order');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) e.push(w + 'date'); else { if (prevDate && d.date <= prevDate) e.push(w + 'dates must increase'); prevDate = d.date; }
    if (!/^(stage|marathon|rest|transfer)$/.test(d.type)) e.push(w + 'type ' + d.type);
    if (!bids.has(d.from) || !bids.has(d.to)) e.push(w + 'from / to must be bivouac ids');
    if (prevTo && d.from !== prevTo) e.push(w + 'starts at ' + d.from + ' but the day before ended at ' + prevTo);
    prevTo = d.to;
    if (BANNED.test(d.title || '')) e.push(w + 'title uses a mark: ' + d.title);
    if ((d.type === 'stage' || d.type === 'marathon') && !d.stage) e.push(w + 'a stage day needs stage');
    if (d.type === 'rest' && (d.stage || d.from !== d.to)) e.push(w + 'a rest day has no stage and stays put');
    if (d.type === 'transfer' && d.stage) e.push(w + 'a transfer has no stage');
    if (d.marathon !== (d.type === 'marathon')) e.push(w + 'marathon flag must match type');
    for (const k of ['liaisonOut', 'liaisonIn']) if (d[k]) { if (!(d[k].km >= 0) || !(d[k].allowanceMin >= 0)) e.push(w + k + ' km / allowanceMin'); }
    if (d.stage) { if (!/^[a-z0-9-]+$/.test(d.stage.id)) e.push(w + 'stage id'); if (!(d.stage.targetKm > 0)) e.push(w + 'stage targetKm'); if (BANNED.test(d.stage.id) || BANNED.test(d.stage.file)) e.push(w + 'stage id / file uses a mark'); }
  });
  return e;
}

/** stage-file checks for a (chained) generated stage: continuity of km and line, first DSS, last ASS */
function checkStage(st) {
  const e = [];
  if (st.format !== 'rallyraid-stage' || st.schemaVersion !== 1) e.push('not a stage v1 file');
  const W = st.waypoints || [];
  if (!W.length || W[0].type !== 'DSS' || W[W.length - 1].type !== 'ASS') e.push('first must be DSS, last ASS');
  for (let i = 1; i < W.length; i++) if (!(W[i].km >= W[i - 1].km)) e.push('waypoint km not increasing at ' + W[i].id);
  const B = (st.roadbook && st.roadbook.boxes) || [];
  for (let i = 1; i < B.length; i++) { if (!(B[i].km >= B[i - 1].km)) e.push('box km not increasing at ' + B[i].id); if (Math.abs(B[i].km - B[i - 1].km - B[i].partial) > 0.002) e.push('box partial wrong at ' + B[i].id); }
  const legs = (st.route && st.route.legs) || [];
  let sum = 0;
  for (let i = 0; i < legs.length; i++) {
    sum += legs[i].km;
    if (i && dist(legs[i - 1].points[legs[i - 1].points.length - 1], legs[i].points[0]) > 1) e.push('route gap before leg ' + i + ' (' + legs[i].from + ')');
  }
  if (Math.abs(sum - st.lengthKm) > 0.05) e.push('legs sum ' + sum.toFixed(3) + ' km != lengthKm ' + st.lengthKm);
  if (B.length && Math.abs(B[B.length - 1].km - st.lengthKm) > 0.01) e.push('last box km != lengthKm');
  const ids = new Set(); for (const w of W) { if (ids.has(w.id)) e.push('repeated waypoint id ' + w.id); ids.add(w.id); }
  return e;
}
module.exports = { FORMAT, VERSION, DISCLAIMER_RE, BANNED, LIAISON_DEFAULTS, allowanceMin, loadJson, stageIdFor, viasOf, stageDays, stageInputs, chainOpts, compile, validate, checkStage, dist, sha256 };
