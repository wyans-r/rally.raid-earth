const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid/stage-builder'
const MIME = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const srv = http.createServer((q, r) => {
  const url = decodeURIComponent((q.url || '/').split('?')[0])
  const rel = url === '/' ? '/index.html' : url
  const f = path.normalize(path.join(ROOT, rel))
  if (!f.startsWith(ROOT)) { r.writeHead(403); r.end(); return }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end('not found'); return }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    r.end(d)
  })
}).listen(8769)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (msg) => { console.error('FAIL', msg); process.exitCode = 1 }

;(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/index.json'), 'utf8'))
  const expectedIds = manifest.stages.map(s => s.id)
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto('http://127.0.0.1:8769/', { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.querySelectorAll('#ex-list .ex-card').length > 0, { timeout: 10000 })

  const hintOn = await page.evaluate(() => document.getElementById('ex-hint').classList.contains('on'))
  console.log('first-visit hint visible:', hintOn)
  if (!hintOn) fail('expected first-visit hint')

  await page.click('#ex-open')
  await sleep(300)
  const guideOn = await page.evaluate(() => document.getElementById('pane-guide').classList.contains('on'))
  const fileOn = await page.evaluate(() => document.getElementById('pane-file').classList.contains('on'))
  const hintOff = await page.evaluate(() => !document.getElementById('ex-hint').classList.contains('on'))
  console.log('Examples button opens Guide tab:', guideOn, 'File tab off:', !fileOn, 'hint dismissed:', hintOff)
  if (!guideOn || fileOn) fail('Examples button did not open Guide tab')

  const listed = await page.evaluate(() => Array.from(document.querySelectorAll('#ex-list .ex-card')).map(c => ({
    id: c.getAttribute('data-ex'),
    name: (c.querySelector('h3') || {}).innerText,
    meta: (c.querySelector('.meta') || {}).innerText,
    hasThumb: !!(c.querySelector('img') && c.querySelector('img').getAttribute('src')),
    hasDesc: !!(c.querySelector('p') && c.querySelector('p').innerText.trim())
  })))
  console.log('cards:', listed.length, 'ids:', listed.map(c => c.id).join(','))
  if (listed.length !== expectedIds.length) fail('card count ' + listed.length + ' != ' + expectedIds.length)
  const missing = expectedIds.filter(id => !listed.some(c => c.id === id))
  if (missing.length) fail('missing cards ' + missing.join(','))
  const noThumb = listed.filter(c => !c.hasThumb)
  const noDesc = listed.filter(c => !c.hasDesc || !c.meta)
  if (noThumb.length) fail('missing thumbnails ' + noThumb.map(c => c.id).join(','))
  if (noDesc.length) fail('missing description/meta ' + noDesc.map(c => c.id).join(','))
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('.ex-gh')).map(g => g.innerText))
  console.log('groups:', groups.join(' | '))

  await page.screenshot({ path: '/tmp/builder_examples_local.png' })

  // load each example via API (skip confirm), check render + export round-trip
  let ok = 0
  for (const s of manifest.stages) {
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', s.file), 'utf8'))
    const result = await page.evaluate(async (id) => {
      const loaded = await window.RallyRaidBuilder.loadExample(id, true)
      const a = window.RallyRaidBuilder.exportStage()
      window.RallyRaidBuilder.importStage(a)
      const b = window.RallyRaidBuilder.exportStage()
      const st = window.RallyRaidBuilder.state()
      return {
        loaded,
        listN: document.querySelectorAll('#list .pt').length,
        icons: document.querySelectorAll('.wpicon').length,
        points: st.points.length,
        name: st.meta.name,
        id: st.meta.id,
        region: st.meta.region,
        wp: a.waypoints.length,
        boxes: (a.roadbook && a.roadbook.boxes || []).length,
        km: a.lengthKm,
        same: JSON.stringify(a.waypoints) === JSON.stringify(b.waypoints) && JSON.stringify(a.roadbook) === JSON.stringify(b.roadbook),
        aWaypoints: a.waypoints,
        problems: document.getElementById('problems').innerText.trim()
      }
    }, s.id)

    // If first evaluate actually ran with a ReferenceError inside, puppeteer would throw.
    const wpMatch = JSON.stringify(result.aWaypoints) === JSON.stringify(src.waypoints)
    const boxMatch = result.boxes === ((src.roadbook && src.roadbook.boxes) || []).length
    const renderOk = result.listN === result.points && result.icons >= src.waypoints.length && result.points >= src.waypoints.length
    const metaOk = result.id === src.id && result.name === src.name
    if (result.loaded && result.same && wpMatch && boxMatch && renderOk && metaOk && !result.problems) {
      ok++
      console.log('OK', s.id, result.wp + ' wp', result.boxes + ' boxes', result.km + ' km', 'icons', result.icons)
    } else {
      fail('roundtrip/render ' + s.id + ' ' + JSON.stringify({
        loaded: result.loaded, same: result.same, wpMatch, boxMatch, renderOk, metaOk,
        problems: result.problems, listN: result.listN, points: result.points, icons: result.icons,
        id: result.id, name: result.name, wp: result.wp, boxes: result.boxes
      }))
    }
  }
  console.log('roundtrip+render ok', ok, '/', manifest.stages.length)

  // screenshot of a Namibia example loaded
  await page.evaluate(id => window.RallyRaidBuilder.loadExample(id, true), 'nam-ss2-terrace-bay-mowe-bay-dunes')
  await sleep(2500)
  await page.screenshot({ path: '/tmp/builder_example_loaded_local.png' })
  const nam = await page.evaluate(() => ({
    id: window.RallyRaidBuilder.state().meta.id,
    n: window.RallyRaidBuilder.state().points.length,
    plot: document.getElementById('pane-plot').classList.contains('on')
  }))
  console.log('loaded Namibia screenshot state:', nam)
  if (nam.id !== 'nam-ss2-terrace-bay-mowe-bay-dunes' || !nam.plot) fail('Namibia load/tab')

  // confirm-if-dirty: clicking another card should prompt; dismiss keeps current
  page.once('dialog', async d => { console.log('confirm text:', d.message()); await d.dismiss() })
  await page.click('#ex-open')
  await sleep(200)
  await page.click('.ex-card[data-ex="moab-sand-flats-ss1"]')
  await sleep(500)
  const stillNam = await page.evaluate(() => window.RallyRaidBuilder.state().meta.id)
  console.log('dismiss confirm keeps stage:', stillNam)
  if (stillNam !== 'nam-ss2-terrace-bay-mowe-bay-dunes') fail('dismiss should keep Namibia stage')

  page.once('dialog', async d => { await d.accept() })
  await page.click('.ex-card[data-ex="moab-sand-flats-ss1"]')
  await page.waitForFunction(() => (window.RallyRaidBuilder.state().meta || {}).id === 'moab-sand-flats-ss1', { timeout: 8000 })
  console.log('accept confirm loads Moab')

  // deep-link ?example= on a fresh page (no prior work in a new browser context)
  const ctx = await browser.createBrowserContext()
  const p2 = await ctx.newPage()
  p2.on('pageerror', e => errors.push('p2 ' + e.message))
  p2.on('console', m => { if (m.type() === 'error') errors.push('p2 ' + m.text()) })
  await p2.setViewport({ width: 1200, height: 800 })
  await p2.goto('http://127.0.0.1:8769/?example=nam-ss1-springbokwasser-terrace-bay', { waitUntil: 'networkidle2' })
  await p2.waitForFunction(() => (window.RallyRaidBuilder.state().meta || {}).id === 'nam-ss1-springbokwasser-terrace-bay', { timeout: 10000 })
  const deep = await p2.evaluate(() => ({
    id: window.RallyRaidBuilder.state().meta.id,
    points: window.RallyRaidBuilder.state().points.length,
    plot: document.getElementById('pane-plot').classList.contains('on')
  }))
  console.log('deep link:', deep)
  if (deep.id !== 'nam-ss1-springbokwasser-terrace-bay' || deep.points < 10 || !deep.plot) fail('deep link failed')
  await ctx.close()

  if (errors.length) {
    console.log('errors:', JSON.stringify(errors))
    // Leaflet/tile noise is ok; fail on script errors
    const real = errors.filter(e => !/favicon|leaflet|tile|css/i.test(e))
    if (real.length) fail('page errors ' + JSON.stringify(real))
  } else {
    console.log('errors: []')
  }
  if (process.exitCode) console.log('TEST FAILED')
  else console.log('TEST PASSED')
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
