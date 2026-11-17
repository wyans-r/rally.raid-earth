const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid'
const srv = http.createServer((q, r) => {
  let u = q.url.split('?')[0]
  let f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); r.end(d) } })
}).listen(8766)
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 880 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.goto('http://127.0.0.1:8766/tests/app_preview.html', { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 1500))
  await page.screenshot({ path: ROOT + '/gps_app.png' })
  // open the stage picker on the big one and click the sample + LOAD to check the command string
  await page.evaluate(() => { const e1 = angular.element(document.querySelector('#d .rrg-host')); const s = e1.isolateScope(); s.$apply(() => s.openStages()) })
  await new Promise(r => setTimeout(r, 300))
  await page.screenshot({ path: ROOT + '/gps_app_picker.png', clip: { x: 0, y: 350, width: 600, height: 530 } })
  await page.evaluate(() => { const e1 = angular.element(document.querySelector('#d .rrg-host')); const s = e1.isolateScope(); s.$apply(() => { s.choose(s.stages[0]); s.load() }); const e2 = angular.element(document.querySelector('#a .rrg-host')); const t = e2.isolateScope(); t.$apply(() => { t.cmd('tripPlus'); t.hold(1); t.step() }) })
  const calls = await page.evaluate(() => calls)
  console.log('lua calls:', JSON.stringify(calls, null, 0))
  console.log('errors:', JSON.stringify(errors))
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
