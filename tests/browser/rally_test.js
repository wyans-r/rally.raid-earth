// B10 rally mode, outside the game: (1) the rally.raid Earth Rally app (tests/rally_app_preview.html): list, day list,
// drive / teleport choice (a sea crossing cannot be driven), the running liaison, EXPERIMENTAL tag, disclaimer, the
// commands it sends; (2) the calendar page (stage-builder/calendar.html): rounds, the event view (day table, map
// lines, downloads, disclaimer), no console errors. Screenshots /tmp/rally_app.png, /tmp/calendar*.png.
// node tests/browser/rally_test.js   (puppeteer-core + /usr/bin/google-chrome; Leaflet / Angular from unpkg)
const path = require('path'), fs = require('fs'), http = require('http')
let puppeteer; try { puppeteer = require('puppeteer-core') } catch (e) { puppeteer = require('/workspace/rallyraid-stagegen/node_modules/puppeteer-core') }
const ROOT = path.join(__dirname, '..', '..')
const types = { '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.html': 'text/html', '.png': 'image/png' }
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0])
  const f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : u.startsWith('/tests/') ? path.join(ROOT, u) : path.join(ROOT, 'stage-builder', u === '/' ? 'index.html' : u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d) } })
}).listen(18772)
let fails = 0
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 800 })
  let errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  // 1) the app
  await page.goto('http://127.0.0.1:18772/tests/rally_app_preview.html', { waitUntil: 'networkidle0' })
  await sleep(800)
  check((await page.evaluate(() => calls.filter(c => c.includes("cmd('rallyAppHere')")).length)) === 3, 'each app tells Lua it is on the HUD')
  const barA = await page.$eval('#a .rrl-bar', e => e.textContent)
  check(/RALLY/.test(barA) && /EXPERIMENTAL/.test(barA) && !/Ctrl/.test(barA), 'bar: RALLY, EXPERIMENTAL, no key hint: ' + barA)
  check(/Atlantic to Atlas 2027/.test(await page.$eval('#a .rrl-list', e => e.textContent)), 'rally list shows the event')
  await page.evaluate(() => { calls.length = 0 }); await page.click('#a .rrl-pick')
  check((await page.evaluate(() => calls[0])) === "if rallyRaid_core then rallyRaid_core.cmd('rallyLoad', '/rallyraid/rallies/atlantic-to-atlas-2027.rally.json') end", 'clicking a rally loads it')
  check((await page.$eval('#b .disc', e => e.textContent)) === 'Inspired by the 2027 Dakar route. Unofficial, not affiliated.', 'disclaimer line shown')
  check((await page.$$('#b .rrl-day')).length === 4 && (await page.$eval('#b .rrl-day.cur', e => /SS1/.test(e.textContent))), 'day list with the current day marked')
  check(await page.$eval('#b .rrl-day.done', e => /0:20:34/.test(e.textContent)), 'a finished day shows its time')
  check(/TOTAL 0:21:34/.test(await page.$eval('#b .rrl-sum', e => e.textContent)), 'cumulative total with penalties')
  const card = await page.$eval('#b .rrl-card', e => e.innerText)
  check(/LIAISON OUT: 60 km · allowance 1:30/.test(card), 'liaison choice: km and allowance: ' + card.split('\n')[2])
  await page.evaluate(() => { calls.length = 0 })
  const btns = await page.$$('#b .rrl-card .rrl-btn')
  await btns[0].click(); await btns[1].click()
  const c1 = await page.evaluate(() => calls.slice())
  check(c1[0].includes("cmd('rallyDrive')") && c1[1].includes("cmd('rallyTeleport')"), 'DRIVE / TELEPORT send their commands')
  await page.evaluate(() => { var s = JSON.parse(JSON.stringify(STATES.b)); s.progress.day = 3; send('b', s) }); await sleep(200)
  check(await page.$eval('#b .rrl-card .rrl-btn.go', b => b.disabled) && /sea crossing/.test(await page.$eval('#b .rrl-card', e => e.innerText)), 'sea crossing: DRIVE disabled, teleport only')
  await page.evaluate(() => { var s = JSON.parse(JSON.stringify(STATES.b)); s.progress.day = 4; send('b', s) }); await sleep(200)
  check(/MARATHON/.test(await page.$eval('#b .rrl-card', e => e.innerText)), 'marathon day flagged')
  const cc = await page.$eval('#c .rrl-card', e => e.innerText)
  check(/12.4 km · CAP 312°/.test(cc) && /LEFT 1:05:00/.test(cc), 'driving liaison: distance, bearing, time left')
  await page.evaluate(() => { calls.length = 0 })
  const foot = await page.$$('#b .foot .rrl-btn'); await foot[0].click()
  check((await page.evaluate(() => calls.length)) === 0 && /REALLY/.test(await page.$eval('#b .foot .rrl-btn', e => e.textContent)), 'RESTART asks first')
  await foot[0].click()
  check((await page.evaluate(() => calls[0] || '')).includes("cmd('rallyRestart')"), 'second click restarts')
  await page.screenshot({ path: '/tmp/rally_app.png' })
  check(errors.length === 0, 'app: no console errors ' + errors.join(' | '))
  // 2) the calendar
  errors = []
  await page.goto('http://127.0.0.1:18772/calendar.html', { waitUntil: 'networkidle0' })
  await sleep(500)
  const rounds = await page.$$eval('.round', e => e.map(x => x.innerText))
  check(rounds.length === 5 && /Atlantic to Atlas 2027/.test(rounds[0]) && rounds.slice(1).every(r => /placeholder/.test(r)), '5 rounds, 4 placeholders')
  check(!/dakar/i.test(await page.$eval('h1', e => e.textContent)) && /Inspired by the 2027 Dakar route\. Unofficial, not affiliated\./.test(rounds[0]), 'title unmarked, disclaimer on the event')
  await page.screenshot({ path: '/tmp/calendar.png', fullPage: true })
  check(errors.length === 0, 'calendar: no console errors ' + errors.join(' | '))
  errors = []
  await page.click('.round .btn.go'); await page.waitForSelector('table', { timeout: 15000 }); await sleep(1500)
  const rows = await page.$$eval('tbody tr', e => e.map(x => x.innerText))
  check(rows.length === 15, '15 days in the table: ' + rows.length)
  check((await page.$eval('.disc', e => e.textContent)) === 'Inspired by the 2027 Dakar route. Unofficial, not affiliated.', 'event page: exact disclaimer line')
  check(rows.some(r => /marathon/.test(r)) && rows.some(r => /rest day/.test(r)) && rows.some(r => /sea crossing/.test(r)), 'marathon, rest day and sea crossing flagged')
  const lines = await page.$$eval('path.leaflet-interactive', e => e.length)
  check(lines >= 13 + 8, 'map: 13 stage lines + bivouacs (' + lines + ')')
  const links = await page.$$eval('a[download]', e => e.map(a => a.getAttribute('href')))
  check(links.length === 1 + 13 * 2, 'downloads: rally file + 13 stages + 13 roadbooks (' + links.length + ')')
  let bad = []
  for (const h of links) { const r = await page.evaluate(u => fetch(u, { method: 'HEAD' }).then(x => x.status), h); if (r !== 200) bad.push(h + ' ' + r) }
  check(bad.length === 0, 'every download link answers 200 ' + bad.join(', '))
  const tx = await page.$eval('body', e => e.innerText)
  check(!/Western Sahara/i.test(tx) && !/\bMorocco\b.*Smara|Smara.*\bMorocco\b/.test(tx), 'no country label on the Saharan stops')
  await page.screenshot({ path: '/tmp/calendar_event.png', fullPage: true })
  await page.setViewport({ width: 390, height: 844, isMobile: true }); await sleep(500)
  await page.screenshot({ path: '/tmp/calendar_event_mobile.png' })
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile: no sideways scroll')
  check(errors.length === 0, 'event page: no console errors ' + errors.join(' | '))
  await browser.close(); srv.close()
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
