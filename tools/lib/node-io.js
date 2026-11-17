// Node io for Stage-Gen / the roadbook generator outside the browser (batch tools, tests).
// Disk cache for terrain / land-cover tiles and Overpass answers: <cache>/dem/<sha1(url)>, <cache>/osm/<sha1(query)>.
// This is a LOCAL cache of the batch tool on this machine only (it makes a stopped run resumable and spares the public
// servers on a re-run). It is NOT the website's shared Overpass cache (that one stays parked on branch overpass-cache).
// RR_OFFLINE=1: never touch the network. RR_CACHE: cache folder (default tools/.cache).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let sharp; try { sharp = require('sharp'); } catch (e) { sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp')); }
const SITE = process.env.RR_SITE || path.join(__dirname, '..', '..', 'stage-builder');
const RB = require(path.join(SITE, 'roadbook-gen.js'));
const SG = require(path.join(SITE, 'stagegen-core.js'))(RB);
const SC = require(path.join(SITE, 'stage-chain.js'))(SG, RB);
const CACHE = process.env.RR_CACHE || path.join(__dirname, '..', '.cache');
const UA = 'rallyraid-earth-batch/1.0 (+https://rrearth.wyans.net)';
const cpath = (kind, key) => { const h = crypto.createHash('sha1').update(key).digest('hex'); return path.join(CACHE, kind, h.slice(0, 2), h); };
const stats = { demHit: 0, demMiss: 0, osmHit: 0, osmMiss: 0, osmMs: 0, demMs: 0, osmFail: 0 };
let logSink = m => console.error('   ' + m);
async function fetchBytes(url) {
  const p = cpath('dem', url);
  if (fs.existsSync(p)) { stats.demHit++; const b = fs.readFileSync(p); return b.length ? b.buffer.slice(b.byteOffset, b.byteOffset + b.length) : null; }
  if (process.env.RR_OFFLINE) { stats.demMiss++; throw new Error('offline: ' + url); }
  stats.demMiss++; const t0 = Date.now();
  let r; for (let a = 0; a < 4; a++) { try { r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) }); if (r.status < 500) break; } catch (e) { if (a === 3) throw e; } await new Promise(z => setTimeout(z, 1500 * (a + 1))); }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  stats.demMs += Date.now() - t0;
  if (r.status === 404) { fs.writeFileSync(p, Buffer.alloc(0)); return null; }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  const ab = await r.arrayBuffer(); fs.writeFileSync(p, Buffer.from(ab)); return ab;
}
async function decodeImage(buf) {
  const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}
// Overpass through the roadbook generator's own mirrors helper (NextGIS first, racing, failover); answers cached on disk
const ovOpts = { overpassTimeoutMs: 120000, overpassStaggerMs: 20000, overpassRounds: 2 };
async function overpass(q) {
  const p = cpath('osm', q);
  if (fs.existsSync(p)) { stats.osmHit++; return JSON.parse(fs.readFileSync(p, 'utf8')); }
  if (process.env.RR_OFFLINE) { stats.osmMiss++; throw new Error('offline overpass'); }
  stats.osmMiss++; const t0 = Date.now();
  try {
    const j = await RB.askOverpass(q, ovOpts, m => logSink(m));
    stats.osmMs += Date.now() - t0;
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j)); return j;
  } catch (e) { stats.osmFail++; stats.osmMs += Date.now() - t0; throw e; }
}
// for RoadbookGen.generate (it takes fetchOverpass(ep, q)): same cache
async function fetchOverpass(ep, q, opts) {
  const p = cpath('osm', q);
  if (fs.existsSync(p)) { stats.osmHit++; return JSON.parse(fs.readFileSync(p, 'utf8')); }
  if (process.env.RR_OFFLINE) throw new Error('offline overpass');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 150000);
  if (opts && opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
  try {
    const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error(j.remark.slice(0, 80));
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j)); return j;
  } finally { clearTimeout(t); }
}
const sha256 = async text => crypto.createHash('sha256').update(text).digest('hex');
function io(log) { return { overpass, fetchBytes, decodeImage, sha256, log: log || (() => {}), progress: null }; }
module.exports = { RB, SG, SC, io, fetchBytes, decodeImage, overpass, fetchOverpass, stats, CACHE, SITE, cpath, setLog: f => { logSink = f; } };
