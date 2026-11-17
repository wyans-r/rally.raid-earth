// Shared Overpass cache: query allow-list, area cap, Cache API, bundled extracts, askOverpass layers.
// No live network: mirrors and fetch are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateQuery, normalizeQuery, parseBboxes, filterExtract } from '../deploy/stagebuilder/src/overpass-validate.js';
import { handleOverpass, RATE_LIMIT, CACHE_TTL_S, cacheRequestFor, sha256Hex } from '../deploy/stagebuilder/src/overpass-proxy.js';

const require = createRequire(import.meta.url);
const RB = require('../stage-builder/roadbook-gen.js');
const TR = require('../stage-builder/track-router.js');

function memCache() {
  const m = new Map();
  return {
    async match(req) {
      const hit = m.get(typeof req === 'string' ? req : req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req, resp) {
      m.set(typeof req === 'string' ? req : req.url, resp);
    },
    size: () => m.size,
    urls: () => [...m.keys()]
  };
}

function sampleBoxes() {
  return RB.routeBoxes(RB.resampleRoute({
    waypoints: [
      { type: 'DSS', lat: 31.10, lon: -4.00, km: 0 },
      { type: 'ASS', lat: 31.12, lon: -3.98, km: 3 }
    ]
  }, 50), 2000, 50).slice(0, 3);
}

test('our six query shapes are accepted', () => {
  const boxes = sampleBoxes();
  const qs = [
    RB.overpassQuery(boxes, RB.DEFAULTS),
    RB.obstacleQuery(boxes),
    RB.landmarkQuery(boxes),
    RB.landformQuery(boxes),
    TR.overpassQuery([31.10, -4.00, 31.14, -3.95], 40),
    // stage-gen osmQuery (0.5° tile, timeout 60)
    '[out:json][timeout:60];(' +
      'way[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|road|track|service)$"](31.0000,-4.0000,31.5000,-3.5000);' +
      'way[natural~"^(water|wetland|sand|dune|cliff|beach)$"](31.0000,-4.0000,31.5000,-3.5000);' +
      'way[landuse~"^(military|quarry)$"](31.0000,-4.0000,31.5000,-3.5000);' +
      'way[barrier~"^(fence|wall)$"](31.0000,-4.0000,31.5000,-3.5000);way[aeroway=aerodrome](31.0000,-4.0000,31.5000,-3.5000);' +
      ');out body geom qt;' +
      'node[place~"^(city|town|village|hamlet)$"](31.0000,-4.0000,31.5000,-3.5000);out body qt;'
  ];
  for (const q of qs) {
    const r = validateQuery(q);
    assert.equal(r.ok, true, (r.error || 'ok') + ' :: ' + q.slice(0, 160));
    assert.ok(r.boxes.length >= 1);
  }
});

test('rejects disallowed or oversized queries', () => {
  const bad = [
    'node[place=city];out;',
    '[out:json][timeout:20];(rel[route=hiking](31, -4, 32, -3););out body;',
    '[out:json][timeout:20];(nwr[amenity=fuel](31,-4,32,-3););out body;',
    '[out:json][timeout:20];(way[highway](31.0,-4.0,32.2,-3.0););out body geom;', // 1.2° lat
    '[out:json][timeout:20];(way[highway](0,0,0.5,6););out body geom;',           // 6° lon
    '[out:json][timeout:20];(way[highway](-10,0,10,0.1););out body geom;',         // 20° lat
    '[out:xml][timeout:20];(way[highway](31,-4,31.1,-3.9););out body;',
    '[out:json][timeout:20];(way[highway](31,-4,31.1,-3.9););out meta;',
    '[out:json][timeout:20];(node[name~"x"](around:5000,31,-4););out body;'
  ];
  for (const q of bad) {
    const r = validateQuery(q);
    assert.equal(r.ok, false, 'should reject: ' + q);
  }
});

test('normalizeQuery collapses timeout so cache keys stay stable', () => {
  const a = normalizeQuery('[out:json][timeout:20];(way[highway](31.10,-4.00,31.12,-3.98););out body geom;');
  const b = normalizeQuery('[out:json][timeout:61]; ( way[highway]( 31.10, -4.00, 31.12, -3.98 ); ) ; out body geom ;');
  assert.equal(a, b);
});

test('filterExtract returns only matching elements in the query boxes', () => {
  const q = '[out:json][timeout:20];(way[highway](31.10,-4.00,31.12,-3.98);node[place~"^(city|town|village|hamlet)$"](31.10,-4.00,31.12,-3.98););out body geom;';
  const v = validateQuery(q);
  assert.equal(v.ok, true);
  const extract = {
    elements: [
      { type: 'way', id: 1, tags: { highway: 'track' }, geometry: [{ lat: 31.11, lon: -3.99 }, { lat: 31.111, lon: -3.991 }] },
      { type: 'way', id: 2, tags: { waterway: 'wadi' }, geometry: [{ lat: 31.11, lon: -3.99 }] },
      { type: 'way', id: 3, tags: { highway: 'path' }, geometry: [{ lat: 40, lon: 10 }] },
      { type: 'node', id: 4, tags: { place: 'village', name: 'Merzouga' }, lat: 31.105, lon: -3.995 },
      { type: 'node', id: 5, tags: { place: 'city' }, lat: 0, lon: 0 }
    ]
  };
  const out = filterExtract(extract, v);
  const ids = out.elements.map((e) => e.id).sort();
  assert.deepEqual(ids, [1, 4]);
});

function envWith(cache, fetchMirror) {
  const mirrors = fetchMirror
    ? { fetchMirror, mirrors: ['https://overpass.nextgis.com/api/interpreter', 'https://overpass-api.de/api/interpreter'] }
    : {};
  return {
    OVERPASS_CACHE: cache,
    log: () => {},
    // handleOverpass uses fetchFromMirrors internally; we patch via a custom fetch on global in some tests
    ...mirrors
  };
}

// handleOverpass calls fetchFromMirrors which calls fetchMirror. To inject, we wrap handle
// by stubbing global fetch for upstream, and using mem cache.

test('proxy returns health JSON on GET with no query', async () => {
  const res = await handleOverpass(new Request('https://stagebuilder.wyans.net/api/overpass', { method: 'GET' }), { OVERPASS_CACHE: memCache() }, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.cache, 'workers-cache');
  assert.equal(j.ttlS, CACHE_TTL_S);
});

test('proxy rejects a hostile query with 400 and does not call a mirror', async () => {
  let called = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { called++; return new Response('no', { status: 500 }); };
  try {
    const res = await handleOverpass(new Request('https://stagebuilder.wyans.net/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent('[out:json][timeout:20];(rel[route=hiking](31,-4,32,-3););out body;')
    }), { OVERPASS_CACHE: memCache() }, {});
    assert.equal(res.status, 400);
    assert.equal(called, 0);
  } finally { globalThis.fetch = prev; }
});

const GOOD_Q = '[out:json][timeout:20];(way[highway](31.10000,-4.00000,31.12000,-3.98000););out body geom;';
const GOOD_BODY = JSON.stringify({ elements: [{ type: 'way', id: 99, tags: { highway: 'track' }, geometry: [] }] });

test('proxy caches a mirror answer and serves the second request from cache', async () => {
  let calls = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // rate-limit cache uses Cache API, not fetch; only mirror POSTs hit fetch
    calls++;
    assert.match(String(url), /nextgis|overpass-api|private\.coffee|mail\.ru/);
    assert.equal(opts.method, 'POST');
    assert.match(opts.body, /^data=/);
    return new Response(GOOD_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const cache = memCache();
    const ctx = { waitUntil: (p) => p };
    const req = () => new Request('https://stagebuilder.wyans.net/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.10' },
      body: 'data=' + encodeURIComponent(GOOD_Q)
    });
    const a = await handleOverpass(req(), { OVERPASS_CACHE: cache }, ctx);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('X-Rallyraid-Cache'), 'miss');
    const ja = await a.json();
    assert.equal(ja.elements[0].id, 99);

    const b = await handleOverpass(req(), { OVERPASS_CACHE: cache }, ctx);
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('X-Rallyraid-Cache'), 'hit');
    const jb = await b.json();
    assert.equal(jb.elements[0].id, 99);
    assert.equal(calls, 1, 'second request must not hit a mirror');
  } finally { globalThis.fetch = prev; }
});

test('proxy tries the next mirror when NextGIS fails', async () => {
  const seen = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (/nextgis/.test(url)) return new Response('busy', { status: 504 });
    return new Response(GOOD_BODY, { status: 200 });
  };
  try {
    const res = await handleOverpass(new Request('https://stagebuilder.wyans.net/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '203.0.113.11' },
      body: GOOD_Q
    }), { OVERPASS_CACHE: memCache() }, { waitUntil: (p) => p });
    assert.equal(res.status, 200);
    assert.ok(seen.some((u) => /nextgis/.test(u)));
    assert.ok(seen.some((u) => /overpass-api\.de/.test(u)));
    assert.equal(res.headers.get('X-Rallyraid-Upstream'), 'https://overpass-api.de/api/interpreter');
  } finally { globalThis.fetch = prev; }
});

test('per-IP rate limit returns 429 after the window is exceeded', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(GOOD_BODY, { status: 200 });
  try {
    const cache = memCache();
    const ctx = { waitUntil: (p) => p };
    let last;
    for (let i = 0; i < RATE_LIMIT.max + 2; i++) {
      last = await handleOverpass(new Request('https://stagebuilder.wyans.net/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '203.0.113.50' },
        body: GOOD_Q
      }), { OVERPASS_CACHE: cache }, ctx);
    }
    assert.equal(last.status, 429);
  } finally { globalThis.fetch = prev; }
});

test('askOverpass uses bundled extract first when the flag is on', async () => {
  RB.resetBundledMemo();
  const extract = {
    format: 'rallyraid-overpass-extract',
    bbox: [31.0, -4.1, 31.3, -3.8],
    elements: [
      { type: 'way', id: 7, tags: { highway: 'track' }, geometry: [{ lat: 31.11, lon: -3.99 }, { lat: 31.111, lon: -3.991 }] }
    ]
  };
  const index = {
    format: 'rallyraid-overpass-extracts',
    schemaVersion: 1,
    regions: [{ id: 'merzouga', bbox: extract.bbox, file: 'merzouga.json.gz' }]
  };
  const prev = globalThis.fetch;
  let proxyOrMirror = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('index.json')) return new Response(JSON.stringify(index), { status: 200 });
    if (u.includes('merzouga.json.gz')) {
      const zlib = require('node:zlib');
      const buf = zlib.gzipSync(Buffer.from(JSON.stringify(extract)));
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
    }
    proxyOrMirror++;
    return new Response('should not be called', { status: 500 });
  };
  try {
    const q = RB.overpassQuery([[31.10, -4.00, 31.12, -3.98]], RB.DEFAULTS);
    const r = await RB.askOverpass(q, { overpassCache: true, overpassDedup: false, overpassExtractsPath: '/overpass-extracts/index.json', overpassExtractsUrl: '/overpass-extracts/index.json' });
    assert.equal(r.generator, 'rallyraid-bundled-extract');
    assert.equal(r.elements.length, 1);
    assert.equal(r.elements[0].id, 7);
    assert.equal(proxyOrMirror, 0);
  } finally { globalThis.fetch = prev; }
});

test('askOverpass tries the relative proxy, then the absolute URL, then public mirrors', async () => {
  RB.resetBundledMemo();
  const prev = globalThis.fetch;
  const seen = [];
  const body = JSON.stringify({ elements: [{ type: 'way', id: 42, tags: { highway: 'path' }, geometry: [] }] });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('overpass-extracts')) return new Response('no', { status: 404 });
    if (u === '/api/overpass') return new Response('nope', { status: 502 });
    if (u === 'https://stagebuilder.wyans.net/api/overpass') {
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('mirror should not run', { status: 500 });
  };
  try {
    const q = '[out:json][timeout:20];(way[highway](31.10,-4.00,31.12,-3.98););out body geom;';
    const r = await RB.askOverpass(q, { overpassCache: true, overpassDedup: false, overpassRecent: false });
    assert.equal(r.elements[0].id, 42);
    assert.ok(seen.includes('/api/overpass'), seen.join(','));
    assert.ok(seen.includes('https://stagebuilder.wyans.net/api/overpass'), seen.join(','));
  } finally { globalThis.fetch = prev; }
});

test('askOverpass with fetchOverpass (tests) does not call the proxy unless the flag is forced on', async () => {
  let fetches = 0, custom = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; return new Response('no', { status: 500 }); };
  try {
    const q = '[out:json][timeout:20];(way[highway](31.10,-4.00,31.12,-3.98););out body geom;';
    const r = await RB.askOverpass(q, {
      fetchOverpass: async () => { custom++; return { elements: [{ type: 'way', id: 1, tags: { highway: 'track' } }] }; },
      overpassRace: false
    });
    assert.equal(r.elements[0].id, 1);
    assert.equal(custom, 1);
    assert.equal(fetches, 0);
    assert.equal(RB.useOverpassCache({ fetchOverpass: () => {} }), false);
    assert.equal(RB.useOverpassCache({ fetchOverpass: () => {}, overpassCache: true }), true);
    assert.equal(RB.useOverpassCache({}), true);
    assert.equal(RB.useOverpassCache({ overpassCache: false }), false);
  } finally { globalThis.fetch = prev; }
});

test('in-game, a failing relative /api path falls back to the absolute proxy or to mirrors', async () => {
  RB.resetBundledMemo();
  const prev = globalThis.fetch;
  const seen = [];
  const body = JSON.stringify({ elements: [{ type: 'way', id: 8, tags: { highway: 'track' }, geometry: [] }] });
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('/')) return Promise.reject(new Error('Failed to fetch')); // no origin in the game
    if (u === 'https://stagebuilder.wyans.net/api/overpass') return new Response('down', { status: 502 });
    if (/overpass-extracts/.test(u)) return Promise.reject(new Error('Failed to fetch'));
    if (/nextgis|overpass-api|private\.coffee|mail\.ru/.test(u)) return new Response(body, { status: 200 });
    return new Response('no', { status: 404 });
  };
  try {
    const q = '[out:json][timeout:20];(way[highway](31.10,-4.00,31.12,-3.98););out body geom;';
    const r = await RB.askOverpass(q, { overpassCache: true, overpassDedup: false, overpassRace: false, overpassRounds: 1, overpassStatusCheck: false });
    assert.equal(r.elements[0].id, 8);
    assert.ok(seen.includes('/api/overpass') || seen.includes('https://stagebuilder.wyans.net/api/overpass'));
    assert.ok(seen.some((u) => /nextgis|overpass-api/.test(u)));
  } finally { globalThis.fetch = prev; }
});

test('sha256Hex is stable', async () => {
  const a = await sha256Hex('abc');
  assert.equal(a, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const hashed = await sha256Hex('q');
  const k = await cacheRequestFor('https://stagebuilder.wyans.net', 'q');
  assert.equal(k.url, 'https://stagebuilder.wyans.net/api/overpass/cache/' + hashed);
});
