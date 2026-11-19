// rally.raid Earth stage builder Worker (rrearth.wyans.net): short share links.
// Everything except /api/* and /s/* is served straight from the static assets (wrangler.jsonc run_worker_first).
//
//   POST /api/share        body {"v":1,"kind":"stage"|"roadbook"|"rally","data":"<the #s1= / #r1= / #y1= payload>"}
//                          -> 201 {"id","url"}; stored in KV (binding SHARES) under a random 22-char base62 id (~131 bits)
//   GET  /api/share/<id>   -> the stored record (immutable, cacheable)
//   GET  /s/<id>           -> the builder (stage) or roadbook editor (roadbook) or rally viewer (rally)
//   GET  /r/<id>           -> the rally viewer (same record; used for kind=rally short links)
//
// Limits: 256 KB request body, 4 MB once inflated, JSON + format checks, uploads per IP: 10 per minute (rate-limit
// binding) and 20 per 10 min (KV counter); the IP is only used as a salted hash. No listing endpoint. Long #s1= / #r1= / #y1= links are handled entirely by the pages.
// A compiled rally file (preview lines, not full stage tracks) fits the 256 KB cap (Atlantic to Atlas 2027 is ~43 KB compressed). Full stages stay as bundled files and are not stored in the share.
const ID_RE = /^[A-Za-z0-9]{22}$/;
const MAX_BYTES = 256 * 1024;
const MAX_INFLATED = 4 * 1024 * 1024;
const RL_LIMIT = 20;
const RL_WINDOW_S = 600;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...extra }
  });
}
function err(status, error, extra) { return json({ error }, status, extra); }

function newId() {
  let s = '';
  while (s.length < 22) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    for (const b of buf) { if (b < 248 && s.length < 22) s += B62[b % 62]; } // 248 = 4*62: no modulo bias
  }
  return s;
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readCapped(req, max) {
  const len = +(req.headers.get('content-length') || 0);
  if (len > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch (e) {} return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function b64urlToBytes(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function inflateCapped(u8, max) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(u8).catch(() => {}); w.close().catch(() => {});
  const reader = ds.readable.getReader();
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch (e) {} throw new Error('too big'); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(out);
}

function payloadOk(kind, obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (kind === 'stage') return obj.format === 'rallyraid-stage';
  if (kind === 'rally') return obj.format === 'rallyraid-rally' && obj.schemaVersion === 1;
  return obj.format === 'rallyraid-roadbook' || !!(obj.roadbook && obj.roadbook.format === 'rallyraid-roadbook');
}

// Two layers: the Workers rate-limit binding SHARE_RL (10 per minute per IP, enforced at once in each Cloudflare
// location) and a KV counter for the 20-per-10-minutes window (KV reads can lag up to ~60 s, so this one is approximate).
async function rateLimited(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const ipKey = (await sha256hex('rrearth-shares:' + ip)).slice(0, 32);
  if (env.SHARE_RL) {
    const { success } = await env.SHARE_RL.limit({ key: ipKey });
    if (!success) return { limited: true, retry: 60 };
  }
  const win = Math.floor(Date.now() / 1000 / RL_WINDOW_S);
  const key = 'rl:' + ipKey + ':' + win;
  const n = +(await env.SHARES.get(key)) || 0;
  if (n >= RL_LIMIT) return { limited: true, retry: (win + 1) * RL_WINDOW_S - Math.floor(Date.now() / 1000) };
  await env.SHARES.put(key, String(n + 1), { expirationTtl: RL_WINDOW_S + 120 });
  return { limited: false };
}

async function create(req, env, url) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return err(403, 'Short links can only be made from this site.');
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return err(415, 'Send JSON (content-type: application/json).');
  const len = +(req.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return err(413, 'This file is too big for a short link (limit 256 KB). Use the long link or the exported file.');
  const body = await readCapped(req, MAX_BYTES);
  if (!body) return err(413, 'This file is too big for a short link (limit 256 KB). Use the long link or the exported file.');
  let msg;
  try { msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch (e) { return err(400, 'The request is not valid JSON.'); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(400, 'Expected a JSON object.');
  const keys = Object.keys(msg).sort().join(',');
  if (keys !== 'data,kind,v') return err(400, 'Expected exactly v, kind and data.');
  if (msg.v !== 1) return err(400, 'Unsupported version.');
  if (msg.kind !== 'stage' && msg.kind !== 'roadbook' && msg.kind !== 'rally') return err(400, 'kind must be stage, roadbook or rally.');
  if (typeof msg.data !== 'string' || !/^[A-Za-z0-9_-]{8,}$/.test(msg.data)) return err(400, 'data must be the base64url share payload.');
  const rl = await rateLimited(req, env);
  if (rl.limited) return err(429, 'Too many short links from your connection. Try again in a few minutes, or use the long link.', { 'retry-after': String(Math.max(1, rl.retry)) });
  let obj;
  try { obj = JSON.parse(await inflateCapped(b64urlToBytes(msg.data), MAX_INFLATED)); } catch (e) { return err(400, 'The share payload is damaged or too big once unpacked.'); }
  if (!payloadOk(msg.kind, obj)) return err(400, msg.kind === 'stage' ? 'This is not a rally.raid stage.' : msg.kind === 'rally' ? 'This is not a rally.raid rally.' : 'This is not a rally.raid roadbook.');
  const id = newId();
  const created = new Date().toISOString();
  await env.SHARES.put('s:' + id, JSON.stringify({ v: 1, kind: msg.kind, data: msg.data, created }), { metadata: { kind: msg.kind, created, bytes: body.byteLength } });
  const path = msg.kind === 'rally' ? '/r/' : '/s/';
  return json({ id, url: url.origin + path + id, kind: msg.kind }, 201);
}

async function read(id, env) {
  if (!ID_RE.test(id)) return err(404, 'No such share link.');
  const rec = await env.SHARES.get('s:' + id);
  if (!rec) return err(404, 'This short link was not found. It may be mistyped, or made on a different site.');
  return new Response(rec, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable' } });
}

async function page(id, req, env, url) {
  let kind = 'stage', found = false;
  if (ID_RE.test(id)) {
    const r = await env.SHARES.getWithMetadata('s:' + id);
    if (r.value) { found = true; kind = (r.metadata && r.metadata.kind) || JSON.parse(r.value).kind || 'stage'; }
  }
  const pagePath = kind === 'roadbook' ? '/roadbook' : kind === 'rally' ? '/rally.html' : '/';
  const asset = await env.ASSETS.fetch(new Request(new URL(pagePath, url), { headers: req.headers }));
  const tag = '<base href="/"><meta name="rr-short" content="' + (ID_RE.test(id) ? id : '') + '" data-page="' + kind + '" data-found="' + found + '">';
  const out = new HTMLRewriter().on('head', { element(e) { e.prepend(tag, { html: true }); } }).transform(asset);
  const h = new Headers(out.headers);
  h.set('cache-control', 'no-store'); h.delete('etag');
  return new Response(out.body, { status: found ? 200 : 404, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/api/share' || p === '/api/share/') {
        if (req.method !== 'POST') return err(405, 'Use POST.', { allow: 'POST' });
        return await create(req, env, url);
      }
      let m = /^\/api\/share\/([^/]+)$/.exec(p);
      if (m) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return err(405, 'Use GET.', { allow: 'GET' });
        return await read(m[1], env);
      }
      m = /^\/(s|r)\/([^/]*)\/?$/.exec(p);
      if (m && (req.method === 'GET' || req.method === 'HEAD')) return await page(m[2], req, env, url);
      if (p.startsWith('/api/')) return err(404, 'Not found.');
      return env.ASSETS.fetch(req);
    } catch (e) {
      return err(500, 'Short link service error. Use the long link.');
    }
  }
};
