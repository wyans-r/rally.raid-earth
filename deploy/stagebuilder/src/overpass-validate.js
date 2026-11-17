/**
 * Shared Overpass QL checks for the stagebuilder /api/overpass Worker.
 * Only the query shapes our own clients send (Stage-Gen, roadbook, track router,
 * obstacles, landmarks, landforms) are allowed, and only in a capped area.
 * Pure functions: used by the Worker and by node tests. No secrets, no I/O.
 */
'use strict';

const MAX_TIMEOUT_S = 240;
const MIN_TIMEOUT_S = 5;
const MAX_BOX_DEG = 1.05;       // Stage-Gen tiles are 0.5° (sometimes 0.25°); 1° is the cap
const MAX_BOXES = 40;           // roadbook chunks use up to 30
const MAX_TOTAL_DEG2 = 2.5;     // ~30,000 km² near the equator; far above one 0.5° tile
const MAX_QUERY_CHARS = 20000;

// One tag filter: [highway], [highway=track], [highway~"^(track|path)$"], [!surface]
const FILTER = String.raw`\[(?:\![A-Za-z0-9:_]+|[A-Za-z0-9:_]+(?:=[A-Za-z0-9:_-]+|~"[^"]+")?)\]`;
const BBOX = String.raw`\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\)`;
const STMT = new RegExp(String.raw`^(?:node|way)(?:${FILTER})+${BBOX}$`);
const OUT = /^(?:out (?:body geom qt|body geom|body qt|center|body))$/;

function normalizeQuery(q) {
  return String(q || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\[timeout:\d+\]/g, '[timeout:20]')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, ';')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s+/g, ',')
    .replace(/\s*\[/g, '[')
    .replace(/\]\s*/g, ']')
    .replace(/;+$/g, ';');
}

function parseBboxes(q) {
  const boxes = [];
  const re = /\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/g;
  let m;
  while ((m = re.exec(q))) {
    boxes.push([+m[1], +m[2], +m[3], +m[4]]);
  }
  return boxes;
}

function boxSpanOk(b) {
  const s = b[0], w = b[1], n = b[2], e = b[3];
  if (!(s < n)) return false;
  if (![s, w, n, e].every(Number.isFinite)) return false;
  if (s < -90.1 || n > 90.1 || w < -180.1 || e > 180.1) return false;
  const dLat = n - s;
  // no antimeridian wrap in our clients; reject a wrap or a huge lon span
  const dLon = e - w;
  if (dLon < 0) return false;
  if (dLat > MAX_BOX_DEG || dLon > MAX_BOX_DEG) return false;
  return true;
}

function totalDeg2(boxes) {
  let a = 0;
  for (const b of boxes) a += (b[2] - b[0]) * (b[3] - b[1]);
  return a;
}

function splitStatements(body) {
  // body is the inside of one (...); group, already normalized, statements end with ;
  return body.split(';').map((s) => s.trim()).filter(Boolean);
}

function findGroups(norm) {
  // [out:json][timeout:N];( stmts );out ...;( stmts );out ...;
  const m = /^\[out:json\]\[timeout:(\d+)\](?:;|$)/.exec(norm);
  if (!m) return { error: 'query must start with [out:json][timeout:N]' };
  const timeout = +m[1];
  if (timeout < MIN_TIMEOUT_S || timeout > MAX_TIMEOUT_S) {
    return { error: 'timeout must be between ' + MIN_TIMEOUT_S + ' and ' + MAX_TIMEOUT_S + ' s' };
  }
  let rest = norm.slice(m[0].length);
  if (rest.startsWith(';')) rest = rest.slice(1);
  const groups = [];
  const OUT_HEAD = /^(out (?:body geom qt|body geom|body qt|center|body));?/;
  const OUT_FIND = /(?:^|;)out (?:body geom qt|body geom|body qt|center|body)/;
  while (rest.length) {
    let inner, after;
    if (rest[0] === '(') {
      let depth = 0, i = 0;
      for (; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')') {
          depth--;
          if (depth === 0) { i++; break; }
        }
      }
      if (depth !== 0) return { error: 'unbalanced parentheses' };
      inner = rest.slice(1, i - 1);
      after = rest.slice(i);
      if (after[0] === ';') after = after.slice(1);
    } else {
      // Stage-Gen: a bare statement (or several) followed by an out clause, not wrapped in (...)
      const found = OUT_FIND.exec(rest);
      if (!found) return { error: 'expected a ( ... ) statement group or a bare statement before out' };
      inner = rest.slice(0, found.index).replace(/^;|;$/g, '');
      after = rest.slice(found.index);
      if (after[0] === ';') after = after.slice(1);
    }
    const outMatch = OUT_HEAD.exec(after);
    if (!outMatch) return { error: 'each group must end with a supported out clause' };
    groups.push({ statements: splitStatements(inner), out: outMatch[1] });
    rest = after.slice(outMatch[0].length);
    if (rest[0] === ';') rest = rest.slice(1);
  }
  if (!groups.length) return { error: 'no statement groups' };
  return { timeout, groups };
}

const FORBIDDEN = /area\s*\(|is_in|>>|<<|\bconvert\b|\bmake\b|\[date:|\[diff:|\[adiff:|\bid:|\brel\[|\brelation\b|\bnwr\[|\bnw\[|\bwr\[|\[user:|\[uid:|\[newer:|\[changed:|\baround:|\bpivot\b|out meta|out skel|out tags|\{\{|>>|<</i;

function validateQuery(q) {
  if (q == null || typeof q !== 'string') return { ok: false, error: 'query must be a string', status: 400 };
  if (q.length > MAX_QUERY_CHARS) return { ok: false, error: 'query is too long', status: 413 };
  if (FORBIDDEN.test(q)) return { ok: false, error: 'query uses a disallowed Overpass feature', status: 400 };

  const norm = normalizeQuery(q);
  if (!norm) return { ok: false, error: 'empty query', status: 400 };

  const parsed = findGroups(norm);
  if (parsed.error) return { ok: false, error: parsed.error, status: 400 };

  for (const g of parsed.groups) {
    if (!g.statements.length) return { ok: false, error: 'empty statement group', status: 400 };
    for (const st of g.statements) {
      if (!STMT.test(st)) return { ok: false, error: 'unsupported statement: ' + st.slice(0, 120), status: 400 };
    }
    if (!OUT.test(g.out)) return { ok: false, error: 'unsupported out clause', status: 400 };
  }

  const boxes = parseBboxes(norm);
  if (!boxes.length) return { ok: false, error: 'query has no bounding boxes', status: 400 };
  if (boxes.length > MAX_BOXES) return { ok: false, error: 'too many bounding boxes (max ' + MAX_BOXES + ')', status: 413 };
  for (const b of boxes) {
    if (!boxSpanOk(b)) {
      return { ok: false, error: 'a bounding box is invalid or larger than ' + MAX_BOX_DEG + ' degrees', status: 413 };
    }
  }
  const area = totalDeg2(boxes);
  if (area > MAX_TOTAL_DEG2) {
    return { ok: false, error: 'query area is too large', status: 413 };
  }

  return { ok: true, normalized: norm, boxes, timeout: parsed.timeout, groups: parsed.groups, area };
}

/**
 * Filter a bundled extract (Overpass-like {elements}) down to the elements one of
 * our allowed queries would have returned. Used by the browser / planner too,
 * but this copy lives with the Worker tests; roadbook-gen.js has a matching helper.
 */
function parseFilters(stmt) {
  const type = stmt.startsWith('node') ? 'node' : 'way';
  const filters = [];
  const re = /\[(\![A-Za-z0-9:_]+|[A-Za-z0-9:_]+(?:=[A-Za-z0-9:_-]+|~"[^"]+")?)\]/g;
  let m;
  while ((m = re.exec(stmt))) {
    const raw = m[1];
    if (raw[0] === '!') filters.push({ kind: 'missing', key: raw.slice(1) });
    else if (raw.includes('~"')) {
      const i = raw.indexOf('~"');
      filters.push({ kind: 're', key: raw.slice(0, i), re: raw.slice(i + 2, -1) });
    } else if (raw.includes('=')) {
      const i = raw.indexOf('=');
      filters.push({ kind: 'eq', key: raw.slice(0, i), val: raw.slice(i + 1) });
    } else filters.push({ kind: 'has', key: raw });
  }
  return { type, filters };
}

function tagsMatch(tags, filters) {
  tags = tags || {};
  for (const f of filters) {
    const v = tags[f.key];
    if (f.kind === 'missing') { if (v != null && v !== '') return false; }
    else if (f.kind === 'has') { if (v == null || v === '') return false; }
    else if (f.kind === 'eq') { if (String(v) !== f.val) return false; }
    else if (f.kind === 're') {
      let rx;
      try { rx = new RegExp(f.re); } catch (e) { return false; }
      if (v == null || !rx.test(String(v))) return false;
    }
  }
  return true;
}

function inBox(lat, lon, b) {
  return lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
}

function elementInBoxes(el, boxes) {
  if (el.lat != null && el.lon != null) return boxes.some((b) => inBox(+el.lat, +el.lon, b));
  const g = el.geometry;
  if (Array.isArray(g) && g.length) {
    return g.some((p) => p && inBox(+p.lat, +p.lon, boxes[0]) ) || boxes.some((b) => g.some((p) => p && inBox(+p.lat, +p.lon, b)));
  }
  if (el.center && el.center.lat != null) return boxes.some((b) => inBox(+el.center.lat, +el.center.lon, b));
  return false;
}

function filterExtract(extract, validation) {
  const elementsIn = (extract && extract.elements) || [];
  const want = [];
  for (const g of validation.groups) {
    const sels = g.statements.map(parseFilters);
    const wantCenter = g.out === 'out center';
    for (const el of elementsIn) {
      if (!sels.some((s) => el.type === s.type && tagsMatch(el.tags, s.filters))) continue;
      if (!elementInBoxes(el, validation.boxes)) continue;
      if (wantCenter && el.type === 'way' && !el.center) {
        const gpts = (el.geometry || []).filter(Boolean);
        let la = 0, lo = 0, n = gpts.length;
        if (n) {
          for (const p of gpts) { la += +p.lat; lo += +p.lon; }
          want.push({ type: el.type, id: el.id, tags: el.tags, center: { lat: la / n, lon: lo / n } });
          continue;
        }
      }
      want.push(el);
    }
  }
  // de-dupe by type+id, first wins
  const seen = new Set(), elements = [];
  for (const el of want) {
    const k = el.type + '/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    elements.push(el);
  }
  return { version: 0.6, generator: 'rallyraid-bundled-extract', osm3s: extract && extract.osm3s, elements };
}

export {
  MAX_TIMEOUT_S, MIN_TIMEOUT_S, MAX_BOX_DEG, MAX_BOXES, MAX_TOTAL_DEG2, MAX_QUERY_CHARS,
  normalizeQuery, parseBboxes, validateQuery, parseFilters, tagsMatch, filterExtract, elementInBoxes
};
