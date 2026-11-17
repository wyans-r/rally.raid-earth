#!/usr/bin/env node
/**
 * Build compressed Overpass extracts for the 15 example stage regions.
 * Local only: writes stage-builder/overpass-extracts/*.json.gz and index.json.
 * Does not deploy. Uses NextGIS first, then the other public mirrors, with a pause
 * between tiles so we do not hammer them.
 *
 *   node stage-builder/scripts/build-overpass-extracts.js --estimate
 *   node stage-builder/scripts/build-overpass-extracts.js
 *   node stage-builder/scripts/build-overpass-extracts.js --region moab-sand-flats-ss1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples');
const OUT = path.join(ROOT, 'overpass-extracts');
const TILE = 0.25;          // fetch / coverage grid (same size as a split Stage-Gen tile)
const PAD_KM = 12;          // corridor around the route, not a snapped rectangle around the bbox
const MAX_TILE = 0.25;
const GAP_MS = 800;
const MIRRORS = [
  'https://overpass.nextgis.com/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

function args() {
  const a = process.argv.slice(2), out = { estimate: false, region: null, force: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--estimate') out.estimate = true;
    else if (a[i] === '--force') out.force = true;
    else if (a[i] === '--region') out.region = a[++i];
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadIndex() {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'index.json'), 'utf8'));
}

function waypointLLs(stage) {
  const pts = [];
  for (const w of stage.waypoints || []) {
    if (w.lat != null && w.lon != null) pts.push([+w.lat, +w.lon]);
  }
  return pts;
}

function routeBbox(stage) {
  const pts = waypointLLs(stage);
  if (!pts.length) throw new Error('no waypoints in ' + stage.id);
  const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}

function padFor(lat) {
  return { dlat: PAD_KM / 111.32, dlon: PAD_KM / (111.32 * Math.max(0.2, Math.cos(lat * Math.PI / 180))) };
}

function r4(x) { return +(+x).toFixed(4); }

function paddedUnion(pts) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of pts) {
    const { dlat, dlon } = padFor(p[0]);
    s = Math.min(s, p[0] - dlat); w = Math.min(w, p[1] - dlon);
    n = Math.max(n, p[0] + dlat); e = Math.max(e, p[1] + dlon);
  }
  return [r4(s), r4(w), r4(n), r4(e)];
}

function rectsOverlap(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** One aligned grid over the padded union; keep only cells that hit the PAD_KM corridor. */
function corridorTiles(pts, deg) {
  const u = paddedUnion(pts);
  const out = [];
  for (let ts = u[0]; ts < u[2] - 1e-12; ts = r4(ts + deg)) {
    for (let tw = u[1]; tw < u[3] - 1e-12; tw = r4(tw + deg)) {
      const t = [ts, tw, r4(Math.min(ts + deg, u[2])), r4(Math.min(tw + deg, u[3]))];
      const midLat = (t[0] + t[2]) / 2;
      const { dlat, dlon } = padFor(midLat);
      const grow = [t[0] - dlat, t[1] - dlon, t[2] + dlat, t[3] + dlon];
      let hit = false;
      for (let i = 0; i < pts.length && !hit; i++) {
        const p = pts[i];
        if (p[0] >= grow[0] && p[0] <= grow[2] && p[1] >= grow[1] && p[1] <= grow[3]) hit = true;
        else if (i) {
          const a = pts[i - 1], b = p;
          const seg = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
          if (rectsOverlap(grow, seg)) hit = true;
        }
      }
      if (hit) out.push(t);
    }
  }
  return out;
}

function unionBbox(tiles) {
  return [
    Math.min(...tiles.map((t) => t[0])),
    Math.min(...tiles.map((t) => t[1])),
    Math.max(...tiles.map((t) => t[2])),
    Math.max(...tiles.map((t) => t[3]))
  ];
}

function areaKm2(b) {
  const mid = (b[0] + b[2]) / 2;
  const dlat = (b[2] - b[0]) * 111.32;
  const dlon = (b[3] - b[1]) * 111.32 * Math.cos(mid * Math.PI / 180);
  return dlat * dlon;
}

function extractQuery(b) {
  const B = '(' + b.map((x) => x.toFixed(4)).join(',') + ')';
  return '[out:json][timeout:90];(' +
    'way[highway]' + B + ';' +
    'way[waterway]' + B + ';' +
    'way[barrier]' + B + ';' +
    'way[railway]' + B + ';' +
    'way[natural]' + B + ';' +
    'way[landuse~"^(forest|military|reservoir|basin|orchard|cemetery|farmland|salt_pond)$"]' + B + ';' +
    'way[power=line]' + B + ';' +
    'way[historic]' + B + ';' +
    'way[amenity~"^(place_of_worship|fuel|grave_yard)$"]' + B + ';' +
    'way[man_made~"^(water_tower|storage_tank|tower|silo|reservoir_covered)$"]' + B + ';' +
    'way[aeroway=aerodrome]' + B + ';' +
    'way[highway=construction]' + B + ';' +
    'node[barrier]' + B + ';' +
    'node[ford]' + B + ';' +
    'node[highway~"^(ford|traffic_signals|stop)$"]' + B + ';' +
    'node[railway=level_crossing]' + B + ';' +
    'node[place~"^(city|town|village|hamlet)$"]' + B + ';' +
    'node[natural~"^(tree|rock|stone|spring|peak|hill|volcano|saddle)$"]' + B + ';' +
    'node[man_made~"^(water_tower|storage_tank|tower|mast|water_well|cairn|survey_point|silo|windmill|windpump|chimney|communications_tower|antenna)$"]' + B + ';' +
    'node[power~"^(tower|generator)$"]' + B + ';' +
    'node[historic]' + B + ';' +
    'node[amenity~"^(place_of_worship|fuel|grave_yard|water_point)$"]' + B + ';' +
    'node[information=guidepost]' + B + ';' +
    'node[ruins=yes]' + B + ';' +
    ');out body geom;';
}

async function post(ep, q) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(ep, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'RallyRaidExtractBuilder/1.0 (https://stagebuilder.wyans.net; one-off local bundle of 15 example regions)'
      },
      signal: ctl.signal
    });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 180));
    if (/duplicate_query/.test(text)) throw new Error('duplicate query');
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.elements)) throw new Error('unusable response');
    return j;
  } finally { clearTimeout(t); }
}

async function fetchTile(q) {
  let last;
  for (const ep of MIRRORS) {
    try { return { data: await post(ep, q), ep }; }
    catch (e) { last = e; process.stderr.write('  ' + ep + ': ' + e.message + '\n'); }
  }
  throw last || new Error('all mirrors failed');
}


const DROP_HW = new Set(['footway', 'cycleway', 'steps', 'pedestrian', 'corridor', 'proposed', 'elevator', 'platform', 'bus_stop', 'abandoned', 'razed', 'via_ferrata']);
const KEEP_TAGS = ['highway', 'surface', 'tracktype', 'natural', 'landuse', 'waterway', 'barrier', 'railway', 'ford', 'aeroway', 'place', 'name', 'name:en', 'ref', 'power', 'historic', 'amenity', 'man_made', 'information', 'ruins', 'intermittent', 'bridge'];
function r5(x) { return Math.round(+x * 1e5) / 1e5; }
function compactElement(el) {
  if (el.type === 'way' && el.tags && DROP_HW.has(el.tags.highway)) return null;
  const tags = {};
  if (el.tags) for (const k of KEEP_TAGS) if (el.tags[k] != null) tags[k] = el.tags[k];
  const out = { type: el.type, id: el.id };
  if (Object.keys(tags).length) out.tags = tags;
  if (el.lat != null) { out.lat = r5(el.lat); out.lon = r5(el.lon); }
  if (Array.isArray(el.geometry)) {
    const g = [];
    for (const p of el.geometry) if (p && p.lat != null) g.push({ lat: r5(p.lat), lon: r5(p.lon) });
    if (g.length) out.geometry = g;
  }
  if (el.center && el.center.lat != null) out.center = { lat: r5(el.center.lat), lon: r5(el.center.lon) };
  return out;
}

function mergeElements(parts) {
  const seen = new Set(), elements = [];
  for (const p of parts) {
    for (const raw of p.elements || []) {
      const el = compactElement(raw);
      if (!el) continue;
      const k = el.type + '/' + el.id;
      if (seen.has(k)) continue;
      seen.add(k);
      elements.push(el);
    }
  }
  return elements;
}

function regionsFromExamples() {
  const idx = loadIndex();
  return idx.stages.map((s) => {
    const st = JSON.parse(fs.readFileSync(path.join(EXAMPLES, s.file), 'utf8'));
    const raw = routeBbox(st);
    const pts = waypointLLs(st);
    const cov = corridorTiles(pts, MAX_TILE);
    const bbox = unionBbox(cov);
    return {
      id: s.id,
      name: s.name,
      region: s.region,
      raw,
      bbox,
      lengthKm: s.lengthKm,
      file: s.id + '.json.gz',
      tiles: cov
    };
  });
}

function printEstimate(regions) {
  console.log('Example-region Overpass extracts (12 km corridor, 0.25 deg tiles):\n');
  let area = 0, nTiles = 0;
  for (const r of regions) {
    const dlat = (r.bbox[2] - r.bbox[0]) * 111.32;
    const mid = (r.bbox[0] + r.bbox[2]) / 2;
    const dlon = (r.bbox[3] - r.bbox[1]) * 111.32 * Math.cos(mid * Math.PI / 180);
    const a = areaKm2(r.bbox);
    area += a; nTiles += r.tiles.length;
    console.log(r.id.padEnd(42), r.bbox.map((x) => x.toFixed(2)).join(',').padEnd(42),
      (dlat.toFixed(0) + 'x' + dlon.toFixed(0)).padEnd(14), String(Math.round(a)).padStart(10), String(r.tiles.length).padStart(6));
  }
  console.log('\n' + regions.length + ' regions, ' + nTiles + ' tiles of ' + MAX_TILE + ' deg, total area ~' + Math.round(area) + ' km2.');
  console.log('Size is unknown until a fetch: desert tiles are often 50-400 KB gzip, denser Baja/Moab tiles maybe 0.5-2 MB gzip.');
  console.log('Budget: stay under the 25 MiB per-file static-asset cap, aim for a total under 8 MB gzip.');
  console.log('Buildings are left out of the bundle so towns do not blow the size; those still go through /api/overpass.');
}

async function buildOne(r, force) {
  const dest = path.join(OUT, r.file);
  if (fs.existsSync(dest) && !force) {
    const sz = fs.statSync(dest).size;
    console.log(r.id + ': exists (' + (sz / 1024).toFixed(1) + ' KiB gzip), skip (use --force)');
    return { id: r.id, file: r.file, bytes: sz, skipped: true };
  }
  console.log(r.id + ': fetching ' + r.tiles.length + ' tile(s)...');
  const parts = [];
  for (let i = 0; i < r.tiles.length; i++) {
    const b = r.tiles[i];
    const { data, ep } = await fetchTile(extractQuery(b));
    console.log('  tile ' + (i + 1) + '/' + r.tiles.length + ' ' + b.join(',') + ' -> ' + data.elements.length + ' els via ' + ep);
    parts.push(data);
    if (i + 1 < r.tiles.length) await sleep(GAP_MS);
  }
  const elements = mergeElements(parts);
  const body = {
    format: 'rallyraid-overpass-extract',
    schemaVersion: 1,
    id: r.id,
    name: r.name,
    region: r.region,
    bbox: r.bbox,
    attribution: 'OpenStreetMap contributors (ODbL)',
    fetched: new Date().toISOString(),
    tiles: r.tiles,
    elements
  };
  const raw = Buffer.from(JSON.stringify(body));
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(dest, gz);
  console.log(r.id + ': wrote ' + r.file + '  ' + (raw.length / 1024).toFixed(1) + ' KiB raw, ' + (gz.length / 1024).toFixed(1) + ' KiB gzip, ' + elements.length + ' elements');
  return { id: r.id, file: r.file, bytes: gz.length, raw: raw.length, elements: elements.length };
}

async function main() {
  const opt = args();
  const regions = regionsFromExamples().filter((r) => !opt.region || r.id === opt.region);
  if (!regions.length) throw new Error('no matching region');
  printEstimate(regions);
  if (opt.estimate) return;
  fs.mkdirSync(OUT, { recursive: true });
  for (const r of regions) await buildOne(r, opt.force);
  const all = regionsFromExamples();
  const index = {
    format: 'rallyraid-overpass-extracts',
    schemaVersion: 1,
    attribution: 'OpenStreetMap contributors (ODbL)',
    built: new Date().toISOString(),
    regions: all.map((r) => {
      const dest = path.join(OUT, r.file);
      const bytes = fs.existsSync(dest) ? fs.statSync(dest).size : null;
      return { id: r.id, name: r.name, region: r.region, bbox: r.bbox, tiles: r.tiles, file: r.file, bytes };
    })
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  const total = index.regions.reduce((s, r) => s + (r.bytes || 0), 0);
  console.log('\nindex.json written. gzip total so far: ' + (total / 1024).toFixed(1) + ' KiB');
}

main().catch((e) => { console.error(e); process.exit(1); });
