// Shared by the roadbook editor tests: a local web server for stage-builder/ and a Chrome whose elevation-tile and
// Overpass requests are answered from the node disk cache (roadbook/cache), so tests run without the flaky public
// servers. Overpass questions not in the cache get a 504 (like an outage), so the editor's fallback is exercised.
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path'), crypto = require('crypto');
const ROOT = '/workspace/rallyraid', SITE = path.join(ROOT, 'stage-builder'), CACHE = path.join(ROOT, 'roadbook', 'cache');
const cpath = (kind, key) => { const h = crypto.createHash('sha1').update(key).digest('hex'); return path.join(CACHE, kind, h.slice(0, 2), h); };
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
// serve() listens on a free port (port 0) unless one is given; the URL is srv.url
function serve(port) {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      let u = decodeURIComponent(q.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
      const f = path.join(SITE, path.normalize(u));
      if (!f.startsWith(SITE)) { r.writeHead(403); return r.end(); }
      fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(d); } });
    }).listen(port || 0, '127.0.0.1', () => { srv.url = 'http://127.0.0.1:' + srv.address().port; res(srv); });
  });
}
async function launch(opts) {
  opts = opts || {};
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1600,1000'] });
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width || 1600, height: opts.height || 1000 });
  const stats = { demHit: 0, demMiss: 0, osmHit: 0, osmMiss: 0, errors: [] };
  page.on('pageerror', e => stats.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) stats.errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (/tiles\.mapterhorn\.com|elevation-tiles-prod/.test(url)) {
      const p = cpath('dem', url);
      if (fs.existsSync(p)) { stats.demHit++; const b = fs.readFileSync(p); return b.length ? req.respond({ status: 200, contentType: url.endsWith('.webp') ? 'image/webp' : 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: b }) : req.respond({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }); }
      stats.demMiss++; return opts.offline ? req.respond({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }) : req.continue();
    }
    if (/\/api\/interpreter/.test(url) && req.method() === 'POST') {
      const q = decodeURIComponent((req.postData() || '').replace(/^data=/, '').replace(/\+/g, ' '));
      const p = cpath('osm', q);
      if (fs.existsSync(p)) { stats.osmHit++; return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(p) }); }
      stats.osmMiss++; return req.respond({ status: 504, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'cache miss (test)' });
    }
    if (opts.noStarters && /\/examples\/[^/]+\.roadbook\.json/.test(url)) return req.respond({ status: 404, body: '' });  // as if no ready-made roadbook shipped
    if (opts.noImagery && /arcgisonline|tile\.openstreetmap|opentopomap/.test(url)) return req.respond({ status: 404, body: '' });
    return req.continue();
  });
  return { browser, page, stats };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(page, fn, arg, timeout) {
  const t0 = Date.now();
  for (;;) { if (await page.evaluate(fn, arg)) return; if (Date.now() - t0 > (timeout || 120000)) throw new Error('timeout waiting for ' + fn.toString().slice(0, 80)); await sleep(250); }
}
module.exports = { serve, launch, sleep, waitFor, ROOT, SITE };
