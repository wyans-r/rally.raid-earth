// the in-game Rally Raid Event app outside the game (tests/event_app_preview.html), screenshot test/shots/ingame_event_app.png
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid'
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]
  const f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); r.end(d) } })
}).listen(8767)
;(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage(); await p.setViewport({ width: 1180, height: 290 })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://127.0.0.1:8767/tests/event_app_preview.html', { waitUntil: 'networkidle0' })
  await p.waitForFunction('window.READY === true')
  await new Promise(r => setTimeout(r, 300))
  const txt = await p.evaluate(() => document.body.innerText)
  const ok = txt.includes('LOAD') && txt.includes('OFFICIAL RUN') && txt.includes('uploaded (pass)') && txt.includes('RETRY UPLOAD') && !errs.length
  await p.screenshot({ path: path.join(__dirname, 'shots', 'ingame_event_app.png') })
  console.log(ok ? 'event app preview ok' : 'FAIL ' + JSON.stringify(errs) + txt.slice(0, 300))
  await b.close(); srv.close(); process.exit(ok ? 0 : 1)
})()
