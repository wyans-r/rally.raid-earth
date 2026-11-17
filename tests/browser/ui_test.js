const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid/stage-builder'
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' }
const srv = http.createServer((q, r) => {
  const url = decodeURIComponent((q.url || '/').split('?')[0])
  const rel = url === '/' ? '/index.html' : url
  const f = path.normalize(path.join(ROOT, rel))
  if (!f.startsWith(ROOT)) { r.writeHead(403); r.end(); return }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    r.end(d)
  })
}).listen(8767)
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 })
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', d => d.accept())
  await page.goto('http://127.0.0.1:8767/', { waitUntil: 'networkidle2' })
  await page.click('[data-tab="file"]'); await page.click('#f-new'); await page.click('[data-tab="plot"]')
  await page.select('#legmode', 'direct')
  await page.evaluate(() => { document.getElementById('snap').checked = false })
  const box = await (await page.$('#map')).boundingBox()
  for (const [dx, dy] of [[300, 300], [450, 350], [600, 300]]) { await page.mouse.click(box.x + dx, box.y + dy); await new Promise(r => setTimeout(r, 200)) }
  let st = await page.evaluate(() => window.RallyRaidBuilder.state().points.map(p => p.type))
  console.log('after 3 clicks:', st.join(','))
  // set the last to ASS via the editor
  await page.select('#e-type', 'ASS')
  let probs = await page.evaluate(() => document.getElementById('problems').innerText)
  console.log('problems:', JSON.stringify(probs), JSON.stringify(errors), await page.evaluate(() => document.getElementById('list').children.length + ' ' + document.getElementById('editor').innerHTML.slice(0,200)))
  // delete the middle one, then roundtrip export/import
  await page.evaluate(() => document.querySelectorAll('#list .pt')[1].querySelector('[data-a=del]').click())
  const ex = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  console.log('export waypoints:', ex.waypoints.map(w => w.type + w.n + '@' + w.km).join(' '), 'boxes', ex.roadbook.boxes.length)
  await page.evaluate(j => window.RallyRaidBuilder.importStage(j), ex)
  const ex2 = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  console.log('roundtrip same waypoints:', JSON.stringify(ex.waypoints) === JSON.stringify(ex2.waypoints))
  // GPX import
  await page.click('[data-tab="file"]')
  const inp = await page.$('#f-import'); await inp.uploadFile('/tmp/t.gpx'); await new Promise(r => setTimeout(r, 800))
  st = await page.evaluate(() => window.RallyRaidBuilder.state().points.map(p => p.type + ':' + (p.leg ? p.leg.mode + p.leg.points.length : '-')))
  console.log('gpx import:', st.join(','), await page.evaluate(() => document.getElementById('status').innerText))
  // rules edit propagates
  await page.click('[data-tab="rules"]')
  await page.evaluate(() => { const i = document.querySelector('tr[data-t=WPS] input[data-k=validate]'); i.value = 50; i.dispatchEvent(new Event('change', { bubbles: true })) })
  const r = await page.evaluate(() => window.RallyRaidBuilder.exportStage().rules)
  console.log('rules WPS validate:', r.waypoints.WPS.validate, 'preset', r.preset)
  // import the sample stage file
  const inp2 = await page.$('#f-import'); await inp2.uploadFile('/workspace/rallyraid/mod/rallyraid/stages/moab-sand-flats-ss1.json'); await new Promise(r => setTimeout(r, 800))
  const s3 = await page.evaluate(() => window.RallyRaidBuilder.exportStage())
  console.log('sample re-import:', s3.waypoints.length, 'wps', s3.roadbook.boxes.length, 'boxes', s3.lengthKm, 'km')
  console.log('errors:', JSON.stringify(errors))
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
