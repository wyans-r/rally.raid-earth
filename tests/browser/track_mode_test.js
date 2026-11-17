// Stage builder: leg mode "tracks & paths" (track-router.js) in Chrome, with Overpass answered from a saved
// Merzouga answer (tests/fixtures/tracks) so it runs offline and deterministic. Also: the GPX option, old files
// with "track" legs, failure message, export / import. Screenshot screens/trackfix_test.png
//   node track_mode_test.js
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = process.env.ROOT || '/workspace/rallyraid/stage-builder', PORT = +(process.env.PORT || 8779)
const FIX = fs.readFileSync(path.join(__dirname, '../fixtures/tracks/merzouga_31.09_-4.01_31.12_-3.94.json'), 'utf8')
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' }
const srv = http.createServer((q, r) => { const u = decodeURIComponent((q.url || '/').split('?')[0]); const f = path.normalize(path.join(ROOT, u === '/' ? '/index.html' : u))
  if (!f.startsWith(ROOT)) { r.writeHead(403); r.end(); return }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d) }) }).listen(PORT)
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 })
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  page.on('dialog', d => d.accept())
  let overpassMode = 'fixture', asked = 0
  await page.setRequestInterception(true)
  page.on('request', q => {
    const u = q.url()
    if (/\/interpreter/.test(u)) {
      asked++
      if (overpassMode === 'down') return q.respond({ status: 504, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/html', body: 'Gateway Timeout' })
      return q.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: FIX })
    }
    if (/tile\.openstreetmap|opentopomap|arcgisonline|unpkg|nominatim/.test(u) || u.startsWith('http://127.0.0.1')) return q.continue()
    return q.continue()
  })
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2' })
  const B = () => page.evaluate(() => window.RallyRaidBuilder.state().points.map(p => p.leg ? { mode: p.leg.mode, via: p.leg.via, n: (p.leg.points || []).length, pending: !!p.leg.pending, cover: p.leg.cover, failed: !!p.leg.failed, noTracks: !!p.leg.noTracks } : null))
  const settle = () => page.waitForFunction(() => window.RallyRaidBuilder.state().points.every(p => !p.leg || !p.leg.pending), { timeout: 60000 })
  const statusText = () => page.evaluate(() => document.getElementById('status').innerText)

  // 1. the choices, in plain words
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#legmode option')).map(o => o.value + '=' + o.textContent))
  ok(opts.join('|') === 'road=roads (car routing)|track=tracks & paths (OpenStreetMap)|gpx=my loaded GPX track|direct=straight line (off-piste)', 'New leg follows: ' + opts.join(' | '))

  // 2. click points with "tracks & paths": DSS and WPV on a Merzouga grade5 track
  await page.click('[data-tab="file"]'); await page.click('#f-new'); await page.click('[data-tab="plot"]')
  await page.select('#legmode', 'track')
  await page.evaluate(() => { document.getElementById('snap').checked = false; window.map.setView([31.1029, -3.9775], 14, { animate: false }) })
  await new Promise(r => setTimeout(r, 300))
  const px = await page.evaluate(pts => pts.map(p => { const q = window.map.latLngToContainerPoint(p); return [q.x, q.y] }), [[31.102324, -3.960413], [31.103507, -3.994588]])
  const box = await (await page.$('#map')).boundingBox()
  for (const [x, y] of px) { await page.mouse.click(box.x + x, box.y + y); await new Promise(r => setTimeout(r, 150)) }
  await settle()
  let L = await B()
  ok(L.length === 2 && L[1].mode === 'track' && !L[1].via, 'clicked leg stored as mode "track"')
  ok(L[1].n > 100 && L[1].cover && L[1].cover.onKm > 3 && L[1].cover.straightKm < 0.1, 'follows the track: ' + L[1].n + ' points, ' + JSON.stringify(L[1].cover))
  ok(/along tracks and paths/.test(await statusText()), 'status: ' + await statusText())
  ok(asked >= 1, 'asked Overpass (' + asked + ' request(s))')
  const ed = await page.evaluate(() => { document.querySelectorAll('#list .pt')[1].click(); return { val: document.getElementById('e-leg').value, opts: Array.from(document.querySelectorAll('#e-leg option')).map(o => o.textContent).join('|'), cover: (document.getElementById('e-cover') || {}).textContent } })
  ok(ed.val === 'track' && ed.opts === 'roads|tracks & paths|my GPX track|straight' && /100% on tracks and paths/.test(ed.cover || ''), 'editor: ' + JSON.stringify(ed))

  // 3. a leg that leaves the mapped area: routed part + flagged straight gap (dotted red)
  await page.select('#legmode', 'track')
  await page.evaluate(() => { window.map.setView([31.1035, -4.005], 13, { animate: false }) })
  const p3 = await page.evaluate(() => { const q = window.map.latLngToContainerPoint([31.1100, -4.0300]); return [q.x, q.y] })
  await page.evaluate(() => window.RallyRaidBuilder.state().points.length)
  await page.mouse.click(box.x + p3[0], box.y + p3[1]); await new Promise(r => setTimeout(r, 150))
  await settle()
  L = await B()
  ok(L[2].cover && L[2].cover.straightKm > 0.5 && L[2].cover.gaps.length >= 1, 'gap flagged: ' + JSON.stringify(L[2].cover))
  ok(/drawn straight where no mapped track connects/.test(await statusText()) || /no tracks or paths connect/.test(await statusText()), 'status: ' + await statusText())
  const red = await page.evaluate(() => Array.from(document.querySelectorAll('path.leaflet-interactive, path')).filter(p => p.getAttribute('stroke') === '#ff3b3b' && p.getAttribute('stroke-dasharray') === '2 7').length)
  ok(red >= 1, 'red dotted gap lines on the map: ' + red)
  await page.evaluate(() => window.map.fitBounds(window.RallyRaidBuilder.state().points.map(p => [p.lat, p.lon]), { padding: [80, 80] }))
  await new Promise(r => setTimeout(r, 1500))
  await page.screenshot({ path: path.join(__dirname, 'screens/trackfix_test.png') })

  // 4. export: modes stay road / track / direct; cover rides along; import keeps it
  const ex = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  ok(ex.route.legs.every(l => ['road', 'track', 'direct'].includes(l.mode)) && ex.route.legs[0].cover && !ex.route.legs[0].via, 'export legs: ' + ex.route.legs.map(l => l.mode + (l.cover ? '(cover)' : '')).join(','))
  ok(/OSM tracks/.test(ex.dataSource), 'dataSource: ' + ex.dataSource)
  await page.evaluate(j => window.RallyRaidBuilder.importStage(j), ex)
  const ex2 = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  ok(JSON.stringify(ex.route) === JSON.stringify(ex2.route), 'export / import round trip keeps the route and cover')

  // 5. Overpass down: drawn straight, plain words, listed as a problem
  overpassMode = 'down'
  await page.evaluate(() => { const p = window.RallyRaidBuilder.state().points; document.querySelectorAll('#list .pt')[1].click() })
  await page.evaluate(() => { const s = document.getElementById('e-leg'); s.value = 'direct'; s.dispatchEvent(new Event('change', { bubbles: true })) })
  // move the WPM to an area not loaded yet (the tile cache would answer otherwise)
  await page.evaluate(() => { const p = window.RallyRaidBuilder.state().points[1]; p.lat = 31.2; p.leg = { mode: 'track' } })
  await page.evaluate(() => { const s = document.getElementById('e-leg'); s.value = 'track'; s.dispatchEvent(new Event('change', { bubbles: true })) })
  const t5 = Date.now(); await settle(); console.log('     (gave up after ' + (Date.now() - t5) + ' ms)')
  L = await B()
  const st5 = await statusText()
  ok(L[1].failed && L[1].n === 2, 'Overpass down: leg straight + failed')
  ok(/could not get tracks from OpenStreetMap \(the map servers/.test(st5) && /again in a minute/.test(st5), 'status: ' + st5)
  ok(/could not be routed/.test(await page.evaluate(() => document.getElementById('problems').innerText)), 'listed in the problems')
  overpassMode = 'fixture'

  // 6. an older stage file with "track" legs (Hoanib example): loads with its saved lines, exports unchanged
  const nam = JSON.parse(fs.readFileSync(ROOT + '/examples/nam-ss3-sesfontein-hoanib-amspoort.json', 'utf8'))
  const asked0 = asked
  await page.evaluate(j => window.RallyRaidBuilder.importStage(j), nam)
  const exN = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  ok(JSON.stringify(exN.route.legs.map(l => [l.mode, l.points.length])) === JSON.stringify(nam.route.legs.map(l => [l.mode, l.points.length])), 'old "track" legs keep their saved lines: ' + exN.route.legs.map(l => l.mode + ':' + l.points.length).join(','))
  ok(exN.route.legs.every(l => !('via' in l) && !('cover' in l)) && exN.dataSource === nam.dataSource, 'nothing new added to an old file on export')
  const hashes = await page.evaluate(async (a, b) => { await new Promise(r => { if (window.RoadbookGen) return r(); const s = document.createElement('script'); s.src = 'roadbook-gen.js'; s.onload = r; document.head.appendChild(s) }); return [await window.RoadbookGen.stageHash(a), await window.RoadbookGen.stageHash(b)] }, nam, exN)
  ok(hashes[0] === hashes[1], 'stage hash unchanged (its roadbook still matches)')
  ok(asked === asked0, 'loading it asked nothing from Overpass')

  // 7. GPX: "my loaded GPX track" follows the reference track; stored as track + via gpx
  await page.click('[data-tab="file"]')
  const inp = await page.$('#f-import'); await inp.uploadFile('/tmp/t.gpx'); await new Promise(r => setTimeout(r, 800))
  L = await B()
  ok(L.slice(1).every(l => l.mode === 'track' && l.via === 'gpx' && l.n > 2), 'GPX legs: ' + JSON.stringify(L.slice(1).map(l => [l.mode, l.via, l.n])))
  ok(await page.evaluate(() => document.getElementById('legmode').value) === 'gpx', 'New leg follows switches to "my loaded GPX track"')
  const exG = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  ok(exG.route.legs.every(l => l.mode === 'track' && l.via === 'gpx'), 'GPX legs export as mode track + via gpx')
  await page.evaluate(j => window.RallyRaidBuilder.importStage(j), exG)
  ok((await B()).slice(1).every(l => l.via === 'gpx'), 'and import back as GPX legs')
  await page.click('[data-tab="plot"]')
  const edG = await page.evaluate(() => { document.querySelectorAll('#list .pt')[1].click(); return document.getElementById('e-leg').value })
  ok(edG === 'gpx', 'editor shows "my GPX track" for them')

  ok(!errors.length, 'no page errors ' + JSON.stringify(errors))
  console.log(fails ? fails + ' FAILED' : 'all passed')
  await browser.close(); srv.close(); process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
