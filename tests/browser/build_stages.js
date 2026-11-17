// Feeds each generated stage outline through the stage builder (import -> the builder's own export: km, CAP, numbering,
// roadbook boxes, rules), saves it, re-imports the saved file through the File tab like a user, checks for problems,
// and screenshots it fitted to the route.
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid/stage-builder', IN = '/tmp/rr_stage_inputs', OUT = '/workspace/rallyraid/sample-stages'
const LAYER = { osm: 'OpenStreetMap', topo: 'OpenTopoMap', sat: 'Satellite (Esri)' }
const srv = http.createServer((q, r) => fs.readFile(path.join(ROOT, 'index.html'), (e, d) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(d) })).listen(8768)
const only = process.argv.slice(2)
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1600, height: 1000 })
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', d => d.accept())
  await page.goto('http://127.0.0.1:8768/', { waitUntil: 'networkidle2' })
  await page.evaluate(() => localStorage.clear())
  const summary = []
  for (const f of fs.readdirSync(IN).filter(f => f.endsWith('.json')).sort()) {
    const id = f.replace(/\.json$/, '')
    if (only.length && !only.includes(id)) continue
    const input = JSON.parse(fs.readFileSync(path.join(IN, f)))
    const layer = input._layer; delete input._layer
    errors.length = 0
    await page.evaluate(j => window.RallyRaidBuilder.importStage(j), input)
    const ex = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
    const file = path.join(OUT, id + '.json')
    fs.writeFileSync(file, JSON.stringify(ex, null, 1))
    // re-import the saved file through the File tab, as a user would
    await page.click('[data-tab="file"]')
    const inp = await page.$('#f-import'); await inp.uploadFile(file)
    await page.waitForFunction(n => document.getElementById('status').textContent.includes(n), { timeout: 10000 }, id + '.json')
    await page.click('[data-tab="plot"]')
    const probs = await page.evaluate(() => document.getElementById('problems').innerText.trim())
    const ex2 = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
    const same = JSON.stringify(ex.waypoints) === JSON.stringify(ex2.waypoints) && JSON.stringify(ex.roadbook.boxes) === JSON.stringify(ex2.roadbook.boxes)
    // base layer
    await page.evaluate(name => { for (const l of document.querySelectorAll('.leaflet-control-layers-base label')) if (l.textContent.trim().startsWith(name)) l.querySelector('input').click() }, LAYER[layer] || LAYER.osm)
    // zoom in one step when the whole route still fits (fitBounds leaves a wide margin)
    const fits = () => page.evaluate(() => {
      const m = document.getElementById('map').getBoundingClientRect()
      return [...document.querySelectorAll('.wpicon')].every(e => { const r = e.getBoundingClientRect(); return r.left > m.left + 50 && r.right < m.right - 60 && r.top > m.top + 50 && r.bottom < m.bottom - 30 })
    })
    await page.click('.leaflet-control-zoom-in'); await new Promise(r => setTimeout(r, 1600))
    if (!(await fits())) { await page.click('.leaflet-control-zoom-out'); await new Promise(r => setTimeout(r, 1600)) }
    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 45000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 800))
    await page.screenshot({ path: path.join(OUT, 'screens', id + '.png') })
    // detail view: zoom in on the speed zone (or the WPS) so the reveal / validation circles and the editor show
    const di = await page.evaluate(() => { const pts = window.RallyRaidBuilder.state().points; for (const t of ['DZ', 'WPS', 'WPM']) { const i = pts.findIndex(p => p.type === t); if (i >= 0) return i } return 1 })
    await page.evaluate(i => document.querySelectorAll('#list .pt')[i].click(), di)
    await new Promise(r => setTimeout(r, 1200))
    for (let z = 0; z < 3; z++) { await page.click('.leaflet-control-zoom-in'); await new Promise(r => setTimeout(r, 700)) }
    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 45000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 800))
    await page.screenshot({ path: path.join(OUT, 'screens', id + '_detail.png') })
    const counts = {}; ex.waypoints.forEach(w => counts[w.type] = (counts[w.type] || 0) + 1)
    const legs = ex.route.legs.reduce((a, l) => { a[l.mode] = (a[l.mode] || 0) + l.km; return a }, {})
    const s = { id, name: ex.name, km: ex.lengthKm, waypoints: ex.waypoints.length, boxes: ex.roadbook.boxes.length, counts, legs, problems: probs, roundtrip: same, errors: [...errors] }
    summary.push(s)
    console.log(JSON.stringify(s))
  }
  fs.writeFileSync('/tmp/rr_stage_summary.json', JSON.stringify(summary, null, 1))
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
