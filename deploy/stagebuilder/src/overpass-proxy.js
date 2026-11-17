/**
 * /api/overpass: validate, rate-limit, Cache API, then NextGIS and the other mirrors.
 * No KV / R2 / D1. Designed so the Worker barely parses the Overpass body (Free plan: 10 ms CPU).
 */
import { validateQuery, normalizeQuery } from './overpass-validate.js';

export const MIRRORS = [
  'https://overpass.nextgis.com/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

export const CACHE_TTL_S = 12 * 60 * 60; // 12 hours
export const RATE_LIMIT = { windowS: 60, max: 40 }; // 40 req / minute / IP (a stage build can burst ~15–25)
export const FIRST_BYTE_MS = 10000;
export const MIRROR_TIMEOUT_MS = 22000;
export const USER_AGENT = 'RallyRaidStageBuilder/1.0 (https://stagebuilder.wyans.net; shared cache)';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400'
};

export function corsHeaders(extra) {
  return { ...CORS, ...(extra || {}) };
}

export function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) })
  });
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || '0.0.0.0';
}

/** POST body (data=QL or raw QL) or GET ?data= */
export async function readQuery(request) {
  const url = new URL(request.url);
  if (request.method === 'GET') return url.searchParams.get('data') || url.searchParams.get('q') || '';
  const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
  const text = await request.text();
  if (!text) return url.searchParams.get('data') || url.searchParams.get('q') || '';
  if (ctype.includes('application/json')) {
    try {
      const j = JSON.parse(text);
      if (typeof j === 'string') return j;
      if (j && typeof j.data === 'string') return j.data;
      if (j && typeof j.query === 'string') return j.query;
    } catch (e) { /* fall through */ }
  }
  if (ctype.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(text);
    return p.get('data') || p.get('q') || text;
  }
  if (text.startsWith('data=') || text.startsWith('q=')) {
    const p = new URLSearchParams(text);
    return p.get('data') || p.get('q') || text;
  }
  return text;
}

export async function cacheRequestFor(origin, normalized) {
  // Canonical GET URL so Cache API keys only on the query text, not on POST bodies.
  // Hash the query: a 30-box roadbook string is too long to put in the URL itself.
  const h = await sha256Hex(normalized);
  return new Request(origin + '/api/overpass/cache/' + h, { method: 'GET' });
}

export async function rateLimit(cache, ip, now) {
  now = now || Date.now();
  const bucket = Math.floor(now / (RATE_LIMIT.windowS * 1000));
  const keyUrl = 'https://stagebuilder.wyans.net/internal/rate/' + encodeURIComponent(ip) + '/' + bucket;
  const req = new Request(keyUrl, { method: 'GET' });
  let count = 0;
  try {
    const hit = await cache.match(req);
    if (hit) count = parseInt(await hit.text(), 10) || 0;
  } catch (e) { /* fail open if Cache API is unavailable */ }
  count += 1;
  try {
    await cache.put(req, new Response(String(count), {
      headers: { 'Cache-Control': 'max-age=' + (RATE_LIMIT.windowS + 5), 'Content-Type': 'text/plain' }
    }));
  } catch (e) { /* ignore */ }
  return { count, limited: count > RATE_LIMIT.max, remaining: Math.max(0, RATE_LIMIT.max - count) };
}

function looksLikeJsonObject(text) {
  const s = String(text || '').trimStart();
  return s[0] === '{';
}

export async function fetchMirror(ep, query, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || MIRROR_TIMEOUT_MS;
  const firstMs = opts.firstByteMs || FIRST_BYTE_MS;
  const ctl = new AbortController();
  let why = null;
  const stop = (w) => { if (!why) why = w; try { ctl.abort(); } catch (e) {} };
  const tAll = setTimeout(() => stop('timeout'), timeoutMs);
  const tFirst = setTimeout(() => stop('no answer in ' + Math.round(firstMs / 1000) + ' s'), firstMs);
  try {
    const r = await fetch(ep, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
      signal: ctl.signal
    });
    clearTimeout(tFirst);
    const text = await r.text();
    if (!r.ok) {
      const cap = /at capacity|duplicate_query|queue is full/i.test(text);
      const err = new Error('HTTP ' + r.status + (cap ? ' (busy)' : ''));
      err.busy = cap;
      throw err;
    }
    if (/duplicate_query/.test(text)) {
      const err = new Error('duplicate query');
      err.busy = true;
      throw err;
    }
    if (!looksLikeJsonObject(text)) throw new Error('non-JSON response');
    // A remark with "error" means the query failed; don't cache it. Cheap prefix/search, no JSON.parse.
    if (/"remark"\s*:\s*"[^"]*error/i.test(text.slice(0, 2000))) throw new Error('Overpass remark error');
    return text;
  } finally {
    clearTimeout(tAll);
    clearTimeout(tFirst);
  }
}

export async function fetchFromMirrors(query, opts) {
  const list = (opts && opts.mirrors) || MIRRORS;
  const fetchOne = (opts && opts.fetchMirror) || fetchMirror;
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const ep = list[i];
    try {
      const text = await fetchOne(ep, query, opts);
      return { text, endpoint: ep };
    } catch (e) {
      lastErr = e;
      if (opts && opts.log) opts.log('mirror ' + ep + ': ' + (e && e.message));
    }
  }
  const err = new Error((lastErr && lastErr.message) || 'all Overpass mirrors failed');
  err.cause = lastErr;
  throw err;
}

export async function handleOverpass(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (!url.searchParams.get('data') && !url.searchParams.get('q')) {
      return jsonResponse({
        ok: true,
        service: 'rallyraid-overpass-cache',
        cache: 'workers-cache',
        ttlS: CACHE_TTL_S,
        mirrors: MIRRORS
      }, 200);
    }
  } else if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'use POST (or GET ?data=)' }, 405);
  }

  let query;
  try { query = await readQuery(request); }
  catch (e) { return jsonResponse({ ok: false, error: 'could not read query' }, 400); }

  const checked = validateQuery(query);
  if (!checked.ok) return jsonResponse({ ok: false, error: checked.error }, checked.status || 400);

  const origin = new URL(request.url).origin;
  const cacheKey = await cacheRequestFor(origin, checked.normalized);
  const cache = (env && env.OVERPASS_CACHE) || caches.default;

  const ip = clientIp(request);
  const rl = await rateLimit(cache, ip);
  if (rl.limited) {
    return jsonResponse({ ok: false, error: 'rate limit: too many Overpass requests from this address' }, 429, {
      'Retry-After': String(RATE_LIMIT.windowS)
    });
  }

  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
      h.set('X-Rallyraid-Cache', 'hit');
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  } catch (e) { /* miss */ }

  let upstream;
  try {
    upstream = await fetchFromMirrors(query, { log: env && env.log });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Overpass mirrors did not answer', detail: String(e && e.message || e) }, 502);
  }

  const headers = corsHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=' + CACHE_TTL_S,
    'X-Rallyraid-Cache': 'miss',
    'X-Rallyraid-Upstream': upstream.endpoint,
    'X-Overpass-Attribution': '© OpenStreetMap contributors (ODbL)'
  });
  const resp = new Response(upstream.text, { status: 200, headers });
  const stored = resp.clone();
  try {
    const p = cache.put(cacheKey, stored);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    else await p;
  } catch (e) { /* still return the body */ }
  return resp;
}

export { validateQuery, normalizeQuery };
