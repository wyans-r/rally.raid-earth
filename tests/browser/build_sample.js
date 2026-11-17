// Drives the stage builder in headless Chrome: builds the sample stage (routing through OSRM like a user would),
// exports it, checks the console for errors and takes a screenshot.
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid/stage-builder'
const srv = http.createServer((q, r) => { const f = path.join(ROOT, q.url === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(d) } }) }).listen(8765)
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1500,900'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1500, height: 900 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle2', timeout: 60000 })
  const P = (id, type, lat, lon, extra) => Object.assign({ id, type, lat, lon }, extra || {})
  const all = [
    P('dss', 'DSS', 38.567602, -109.531389, { name: 'Moab, Sand Flats Rd' }),
    P('dz1', 'DZ', 38.571603, -109.526596, { speedLimit: 40, name: 'Campground area' }),
    P('fz1', 'FZ', 38.57599, -109.519504),
    P('wpv1', 'WPV', 38.582179, -109.495724),
    P('wpm1', 'WPM', 38.576781, -109.467193),
    P('note1', 'NOTE', 38.578954, -109.437233),
    P('wps1', 'WPS', 38.579944, -109.411996, { name: 'Porcupine Rim entrance' }),
    P('wpc1', 'WPC', 38.584094, -109.393772),
    P('wpe1', 'WPE', 38.588746, -109.378335),
    P('ass', 'ASS', 38.60435, -109.391766),
  ]
  const wps = all.filter(w => w.type !== 'NOTE')
  const notes = { dz1: 'DZ 40 km/h', fz1: 'FZ end of speed zone', wpv1: 'KEEP LEFT, gravel, caution ruts', wpm1: 'Slickrock on right', note1: 'Fork: KEEP RIGHT on main track', wps1: '!!! TR onto Porcupine Rim 4x4 Trail, rocky steps', wpc1: 'Ledges, low gear', wpe1: 'Summit, view on left', ass: 'Flying finish' }
  const stage = {
    format: 'rallyraid-stage', schemaVersion: 1, id: 'moab-sand-flats-ss1', name: 'SS1 Moab Sand Flats (sample)', region: 'Moab, Utah, USA',
    author: 'Rally Raid sample', description: 'A short sample stage on Sand Flats Road and the Porcupine Rim 4x4 trail east of Moab. Speed zone (40 km/h) through the town edge.',
    waypoints: wps,
    roadbook: { boxes: all.map((w, i) => ({ n: i + 1, id: w.id, waypoint: w.type === 'NOTE' ? null : w.id, lat: w.lat, lon: w.lon, notes: notes[w.id] || '', danger: w.id === 'wps1' ? 3 : (w.id === 'wpc1' ? 2 : 0) })) },
    route: { legs: all.slice(1).map((w, i) => ({ from: all[i].id, to: w.id, mode: 'road', points: [[all[i].lat, all[i].lon], [w.lat, w.lon]] })) }
  }
  await page.evaluate(s => { localStorage.clear(); window.RallyRaidBuilder.importStage(s) }, stage)
  await page.click('[data-tab="file"]')
  await page.click('#f-recompute')
  await page.waitForFunction(() => /re-routed/.test(document.getElementById('status').textContent), { timeout: 90000 })
  const out = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  fs.writeFileSync('/workspace/rallyraid/mod/rallyraid/stages/moab-sand-flats-ss1.json', JSON.stringify(out, null, 1))
  console.log('exported', out.lengthKm, 'km', out.waypoints.map(w => w.type + ' ' + w.n + ' @' + w.km).join(' | '))
  console.log('legs', out.route.legs.map(l => l.mode + ':' + l.points.length + 'pts/' + l.km).join(' '))
  await page.click('[data-tab="plot"]')
  await page.evaluate(() => { document.querySelectorAll('#list .pt')[4].click() })
  await new Promise(r => setTimeout(r, 4000))
  await page.screenshot({ path: '/workspace/rallyraid/builder.png' })
  const probs = await page.evaluate(() => document.getElementById('problems').innerText)
  console.log('problems:', JSON.stringify(probs))
  console.log('console errors:', JSON.stringify(errors))
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
