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
}).listen(8768)
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1600, height: 1000 })
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', d => d.accept())
  await page.goto('http://127.0.0.1:8768/', { waitUntil: 'networkidle2' })
  await page.click('[data-tab="file"]')
  const inp = await page.$('#f-import'); await inp.uploadFile('/workspace/rallyraid/sample-stages/nam-ss1-springbokwasser-terrace-bay.json'); await sleep(2500)
  // roundtrip check on all samples
  const files = fs.readdirSync('/workspace/rallyraid/sample-stages').filter(f => f.endsWith('.json'))
  let ok = 0
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync('/workspace/rallyraid/sample-stages/' + f))
    const res = await page.evaluate(j => { window.RallyRaidBuilder.importStage(j); const a = window.RallyRaidBuilder.exportStage(); window.RallyRaidBuilder.importStage(a); const b = window.RallyRaidBuilder.exportStage(); return { same: JSON.stringify(a.waypoints) === JSON.stringify(b.waypoints) && JSON.stringify(a.roadbook) === JSON.stringify(b.roadbook), wp: JSON.stringify(a.waypoints) === JSON.stringify(j.waypoints), probs: document.getElementById('problems').innerText.trim() } }, j)
    if (res.same && res.wp && !res.probs) ok++; else console.log('RT issue', f, JSON.stringify(res))
  }
  console.log('roundtrip ok', ok, '/', files.length)
  await inp.uploadFile('/workspace/rallyraid/sample-stages/nam-ss1-springbokwasser-terrace-bay.json'); await sleep(3000)
  // rules edit should reflect in guide
  await page.click('[data-tab="rules"]')
  await page.evaluate(() => { const i = document.querySelector('tr[data-t=WPM] input[data-k=radius]'); i.value = 700; i.dispatchEvent(new Event('change', { bubbles: true })) })
  await page.click('[data-tab="guide"]')
  console.log('ERR so far', JSON.stringify(errors), await page.evaluate(() => JSON.stringify(Object.keys(st.rules.waypoints)) + typeof st.rules.waypoints.DSS), await page.evaluate(() => document.getElementById('guide').innerHTML.length + ' ' + document.getElementById('pane-guide').className))
  console.log('guide WPM reflects 700:', await page.evaluate(() => document.getElementById('g-WPM').innerText.includes('within 700 m')))
  await page.evaluate(() => { const i = document.querySelector('tr[data-t=WPM] input[data-k=radius]'); i.value = 800; i.dispatchEvent(new Event('change', { bubbles: true })) })
  await page.click('[data-tab="guide"]')
  console.log('cards:', await page.evaluate(() => document.querySelectorAll('.g-card[id]').length))
  await page.screenshot({ path: '/workspace/rallyraid/builder_guide.png' })
  // tooltip on type button in plot tab
  await page.click('[data-tab="plot"]'); await sleep(300)
  const btn = await page.$('#typebtns button[data-t="WPS"]'); const bb = await btn.boundingBox()
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(400)
  console.log('tip:', await page.evaluate(() => getComputedStyle(document.getElementById('tip')).display + ' | ' + document.getElementById('tip').innerText.replace(/\n/g, ' / ')))
  await page.screenshot({ path: '/workspace/rallyraid/builder_tooltip.png' })
  // list tag tooltip and editor link
  const tag = await page.$('#list .pt:nth-child(3) .tag'); const tb = await tag.boundingBox()
  await page.mouse.move(tb.x + 5, tb.y + 5); await sleep(300)
  console.log('list tip:', await page.evaluate(() => document.getElementById('tip').innerText.split('\n')[0]))
  await page.mouse.move(900, 500); await sleep(300)
  // marker hover
  const mk = await page.$('.wpicon[data-tip="WPS"]'); if (mk) { const mb = await mk.boundingBox(); await page.mouse.move(mb.x + 5, mb.y + 5); await sleep(300); console.log('marker tip:', await page.evaluate(() => document.getElementById('tip').innerText.split('\n')[0])) }
  await page.evaluate(() => document.querySelectorAll('#list .pt')[2].click()); await sleep(200)
  await page.evaluate(() => document.querySelector('#editor .tsum a').click()); await sleep(300)
  console.log('editor link opens guide:', await page.evaluate(() => document.getElementById('pane-guide').classList.contains('on') + ' ' + (document.querySelector('.g-card.hl') || {}).id))
  console.log('errors:', JSON.stringify(errors))
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
