// The in-game Rally Raid Repair app rendered outside the game (tests/repair_app_preview.html): the closed bar, the
// stage menu (select / unselect rows, spare-wheel limit, REPAIR sends the ids), the bivouac menu (over-budget
// warning, engine change penalty), "no repairs here". Screenshot repair_app.png. Prints PASS / FAIL lines.
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')
const srv = http.createServer((q, r) => {
  let u = q.url.split('?')[0]
  let f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); r.end(d) } })
}).listen(8771)
let fails = 0
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1120, height: 780 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.goto('http://127.0.0.1:8771/tests/repair_app_preview.html', { waitUntil: 'networkidle0' })
  await sleep(1000)
  const calls0 = await page.evaluate(() => calls.slice())
  check(calls0.filter(c => c.includes("appHello('repair', true)")).length === 4, 'each app tells Lua it is on the HUD')
  // a: closed bar
  check(await page.$eval('#a .rrr-panel', e => getComputedStyle(e).display === 'none'), 'closed: no panel')
  const barA = await page.$eval('#a .rrr-bar', e => e.textContent)
  check(/REPAIR/.test(barA) && /SPARES 2\/2/.test(barA) && /RESETS 1\/3/.test(barA) && !/Ctrl\+Shift/.test(barA), 'bar: mode, spares, resets, no default key: ' + barA)
  await page.evaluate(() => { calls.length = 0 })
  await page.click('#a .rrr-bar')
  check((await page.evaluate(() => calls)).some(c => c.includes("cmd('repairOpen'")), 'clicking the bar toggles the menu')
  // d: stage menu, one spare left
  const rows = await page.$$('#d .rrr-opt')
  check(rows.length === 9, '9 stage options (4 wheels, 4 suspension, radiator): ' + rows.length)
  check(await page.$eval('#d .rrr-opt', e => /FLAT/.test(e.textContent) && /2 min/.test(e.textContent)), 'FL wheel row: flat, 2 min')
  check(await page.$eval('#d .rrr-btn.go', b => b.disabled), 'REPAIR disabled with nothing picked')
  await page.click('#d .rrr-opt:nth-child(1)')   // first row container's .rrr-opt
  const sel = await page.$$eval('#d .rrr-opt.sel', e => e.length)
  check(sel === 1, 'one row selected (selection kept on the parent scope, not the ng-repeat row): ' + sel)
  // pick FL wheel + FR wheel (only 1 spare) -> warning, disabled
  const optEls = await page.$$('#d .rrr-opt')
  await optEls[1].click()
  await sleep(100)
  check(/only 1 spare/.test(await page.$eval('#d .rrr-warn', e => e.textContent)), 'two wheels with one spare: warning')
  check(await page.$eval('#d .rrr-btn.go', b => b.disabled), 'REPAIR disabled over the spare limit')
  await optEls[1].click()        // unpick FR
  await optEls[8].click()        // radiator
  await sleep(100)
  check(/\+14 min stage time/.test(await page.$eval('#d .rrr-total', e => e.textContent)), 'total: +14 min stage time')
  await page.screenshot({ path: ROOT + '/repair_app.png' })
  await page.evaluate(() => { calls.length = 0 })
  await page.click('#d .rrr-btn.go')
  const c2 = await page.evaluate(() => calls.slice())
  check(c2.length === 1 && c2[0].startsWith("if rallyRaid_core then rallyRaid_core.cmd('repairConfirm', 'wheel:FL,radiator', 'repair')"), 'REPAIR sends the ids: ' + c2[0])
  check((await page.$$eval('#d .rrr-opt.sel', e => e.length)) === 0, 'selection cleared after REPAIR')
  // disabled rows (no spares) cannot be picked
  await page.evaluate(() => send('d', Object.assign({}, STATES.d, { options: stageOpts(0), spares: { used: 2, max: 2 } })))
  await sleep(200)
  await (await page.$$('#d .rrr-opt'))[0].click()
  check((await page.$$eval('#d .rrr-opt.sel', e => e.length)) === 0, 'no spare left: wheel row cannot be picked')
  check(/No spare wheel left on this stage/.test(await page.$eval('#d .rrr-panel', e => e.innerText)), 'says why (once)')
  // b: bivouac
  const headB = await page.$eval('#b .rrr-head', e => e.textContent)
  check(/BIVOUAC: used 2:30 of 3:00/.test(headB), 'bivouac header: ' + headB)
  check(/LEFT 0:30/.test(await page.$eval('#b .rrr-bar', e => e.textContent)), 'bar shows bivouac time left')
  check(/headGasketDamaged/.test(await page.$eval('#b .rrr-list', e => e.textContent)), 'engine damage shown on the engine row')
  check(/frame 30, suspension FL 14, radiator 10/.test(await page.$eval('#b .rrr-sub', e => e.textContent)), 'whole-car items listed')
  const bRows = await page.$$('#b .rrr-opt')
  await bRows[0].click(); await bRows[1].click(); await sleep(100)
  const warnB = await page.$eval('#b .rrr-warn', e => e.textContent)
  check(/over budget by 124 min: RETIRED/.test(warnB), 'whole + engine from 150 used: 124 over, retire warning: ' + warnB)
  check(/154 min bivouac, \+2:00 penalty/.test(await page.$eval('#b .rrr-total', e => e.textContent)), 'bivouac total with the engine penalty')
  await bRows[1].click(); await sleep(100)
  check(/over budget by 34 min: \+34 min penalty/.test(await page.$eval('#b .rrr-warn', e => e.textContent)), 'whole only: 34 min over, penalty warning')
  // c: none
  check(/No repairs here/.test(await page.$eval('#c .rrr-panel', e => e.textContent)) && (await page.$$('#c .rrr-opt')).length === 0, 'no repairs here: message, no rows')
  await page.screenshot({ path: ROOT + '/repair_app.png' })
  check(errors.length === 0, 'no console errors: ' + JSON.stringify(errors))
  console.log(fails ? fails + ' FAILED' : 'ALL PASS')
  await browser.close(); srv.close()
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
