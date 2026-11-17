// The move stagebuilder.wyans.net -> rrearth.wyans.net (17 Nov 2026): saved work on the old origin is copied once.
// The old host is the redirect Worker (deploy/redirect-worker/src/index.js); the new host serves stage-builder/migrate.html.
//   node tests/browser/migrate_test.js          both hosts simulated in the browser (Worker code + local files)
//   node tests/browser/migrate_test.js --live   real hosts (only the blank /__seed page on the old host is faked,
//                                               to put sample data there)
const path = require('path'), fs = require('fs')
let puppeteer; try { puppeteer = require('puppeteer-core') } catch (e) { puppeteer = require('/workspace/rallyraid-stagegen/node_modules/puppeteer-core') }
const ROOT = path.join(__dirname, '..', '..'), LIVE = process.argv.includes('--live')
const OLD = 'https://stagebuilder.wyans.net', NEW = 'https://rrearth.wyans.net'
const types = { '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.html': 'text/html', '.png': 'image/png' }
let fails = 0
const norm = u => u.replace(/\.html(?=[?#]|$)/, '')   // Cloudflare serves /x.html as /x (307, query and hash kept)
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++ }

;(async () => {
  const W = await import(path.join(ROOT, 'deploy/redirect-worker/src/index.js'))
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  async function newPage(ctx) {
    const p = await ctx.newPage()
    const chain = []
    await p.setRequestInterception(true)
    p.on('request', async q => {
      const u = new URL(q.url())
      if (q.isNavigationRequest() && q.frame() === p.mainFrame()) chain.push(q.url())
      if (u.origin === OLD && u.pathname === '/__seed') return q.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' })
      if (LIVE) return q.continue()
      if (u.origin === OLD) {
        const r = W.handle(new Request(q.url(), { method: q.method(), headers: q.headers() }))
        const h = {}; r.headers.forEach((v, k) => { h[k] = v })
        return q.respond({ status: r.status, headers: h, body: Buffer.from(await r.arrayBuffer()) })
      }
      if (u.origin === NEW) {
        let f = path.join(ROOT, 'stage-builder', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname))
        if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html'
        if (!fs.existsSync(f)) return q.respond({ status: 404, body: '' })
        return q.respond({ status: 200, contentType: types[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) })
      }
      return q.abort()   // no map tiles etc. needed
    })
    return { p, chain }
  }
  const store = (p, ls, docs) => p.evaluate((ls, docs) => new Promise(res => {
    for (const k in ls) localStorage.setItem(k, ls[k])
    const r = indexedDB.open('rallyraid-roadbook', 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('docs') }
    r.onsuccess = () => { const t = r.result.transaction('docs', 'readwrite'); for (const k in docs) t.objectStore('docs').put(docs[k], k); t.oncomplete = () => { r.result.close(); res() } }
  }), ls, docs)
  const read = p => p.evaluate(() => new Promise(res => {
    const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k) }
    const r = indexedDB.open('rallyraid-roadbook', 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('docs') }
    r.onsuccess = () => { const docs = {}, c = r.result.transaction('docs').objectStore('docs').openCursor(); c.onsuccess = () => { if (c.result) { docs[c.result.key] = c.result.value; c.result.continue() } else { r.result.close(); res({ ls, docs }) } } }
  }))
  const settle = async (p, want) => { for (let i = 0; i < 60; i++) { if (p.url().startsWith(want)) break; await new Promise(r => setTimeout(r, 250)) } await new Promise(r => setTimeout(r, 500)); return p.url() }

  // 1) data on the old origin -> copied, newer data on the new origin kept, then on to the same path, query and hash
  {
    const ctx = await browser.createBrowserContext(), { p, chain } = await newPage(ctx)
    const big = 'x'.repeat(200000)
    await p.goto(OLD + '/__seed'); await store(p, {
      'rallyraid-builder': JSON.stringify({ format: 'rallyraid-stage', id: 'old-stage', big }),
      'rallyraid-stagegen-seed': '1234', 'rallyraid-examples-open': '{"Morocco":true}', 'not-ours': 'leave me'
    }, { 'rb:old-stage': { rb: { id: 'old-rb' }, stage: { id: 'old-stage' }, saved: '2026-11-10T10:00:00.000Z' },
         'rb:both': { rb: { id: 'older' }, stage: { id: 'both' }, saved: '2026-11-01T10:00:00.000Z' } })
    await p.goto(NEW + '/credits.html'); await store(p, { 'rallyraid-stagegen-seed': '9999' }, { 'rb:both': { rb: { id: 'newer' }, stage: { id: 'both' }, saved: '2026-11-15T10:00:00.000Z' } })
    chain.length = 0
    const target = '/credits.html?from=old&x=1%202#section-1'
    await p.goto(OLD + target)
    const url = await settle(p, NEW + '/credits.html')
    check(norm(url) === norm(NEW + target), 'landed on the same path, query and hash: ' + url)
    check(chain.some(u => u.startsWith(NEW + '/migrate')), 'went through rrearth migrate.html')
    const got = await read(p)
    check(got.ls['rallyraid-builder'] && JSON.parse(got.ls['rallyraid-builder']).id === 'old-stage' && JSON.parse(got.ls['rallyraid-builder']).big.length === 200000, 'rallyraid-builder copied (200 kB stage intact)')
    check(got.ls['rallyraid-examples-open'] === '{"Morocco":true}', 'rallyraid-examples-open copied')
    check(got.ls['rallyraid-stagegen-seed'] === '9999', 'existing key on rrearth not overwritten')
    check(!('not-ours' in got.ls), 'non-site key not copied')
    check(got.docs['rb:old-stage'] && got.docs['rb:old-stage'].rb.id === 'old-rb', 'roadbook autosave (IndexedDB) copied')
    check(got.docs['rb:both'] && got.docs['rb:both'].rb.id === 'newer', 'newer roadbook autosave on rrearth kept')
    const mark = JSON.parse(got.ls['rallyraid-migrated-from-stagebuilder'] || 'null')
    check(mark && mark.keys === 2 && mark.roadbooks === 1 && mark.keptNewer === 2, 'migration note on rrearth: ' + JSON.stringify(mark))
    // 2) second visit: the old origin is flagged, so straight through
    await p.goto(OLD + '/__seed'); const flag = await p.evaluate(() => localStorage.getItem('rallyraid-moved-to-rrearth'))
    check(!!flag, 'old origin flagged as migrated (' + flag + ')')
    chain.length = 0
    await p.goto(OLD + '/?x=2#y'); const u2 = await settle(p, NEW + '/')
    check(u2 === NEW + '/?x=2#y' && !chain.some(u => u.includes('migrate.html')), 'second visit goes straight to rrearth: ' + u2)
    await ctx.close()
  }
  // 3) no data: straight to the target; a share link keeps its query and hash
  {
    const ctx = await browser.createBrowserContext(), { p, chain } = await newPage(ctx)
    const share = '/roadbook.html?s=1&v=2#rb=N4IgdghgtgpiBcIBGBXAJgUwM4BcBeAN'
    await p.goto(OLD + share); const u = await settle(p, NEW + '/roadbook.html')
    check(norm(u) === norm(NEW + share) && !chain.some(x => x.includes('migrate.html')), 'no data: share link opens on rrearth unchanged: ' + u)
    await ctx.close()
  }
  // 4) a forged migrate link from elsewhere writes nothing
  {
    const ctx = await browser.createBrowserContext(), { p } = await newPage(ctx)
    const blob = 'j' + Buffer.from(JSON.stringify({ v: 1, ls: { 'rallyraid-builder': 'evil' }, docs: {} })).toString('base64url')
    await p.goto(NEW + '/migrate.html#to=%2Fcredits.html&d=' + blob); await settle(p, NEW + '/credits.html')
    const got = await read(p)
    check(!got.ls['rallyraid-builder'] && norm(p.url()) === NEW + '/credits', 'forged migrate link (no old-host referrer) writes nothing, still redirects')
    await p.goto(NEW + '/migrate.html#to=https%3A%2F%2Fevil.example%2F'); await new Promise(r => setTimeout(r, 1000))
    check(p.url().startsWith(NEW + '/'), 'migrate.html never redirects off-site: ' + p.url())
    await ctx.close()
  }
  await browser.close()
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
