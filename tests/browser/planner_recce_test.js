// The Planner app's RECCE panel (18 Nov: moved there from the Roadbook app) outside the game
// (tests/recce_panel_preview.html): the off / no-stage state, the quick-pick (QUICK symbols, legend tabs, search, a symbol
// click, notes, SAVE) and the command strings it sends. Screenshot screens/planner_recce.png. Prints PASS / FAIL lines.
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')
const srv = http.createServer((q, r) => {
  let u = q.url.split('?')[0]
  let f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); r.end(d) } })
}).listen(0)
let fails = 0
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 920, height: 700 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.goto('http://127.0.0.1:' + srv.address().port + '/tests/recce_panel_preview.html', { waitUntil: 'networkidle0' })
  await sleep(500)
  const QUICK = fs.readFileSync(ROOT + '/mod/lua/ge/extensions/rallyRaid/recce.lua', 'utf8').match(/M\.QUICK = \{([^}]*)\}/)[1].match(/'[^']+'/g).map(x => x.slice(1, -1))
  // a: no stage, then a stage with recce off
  await page.evaluate(() => feed('a', { schema: 1, phase: 'idle', boxCount: 0, view: [] }))
  await sleep(100)
  check(/No stage loaded/.test(await page.$eval('#a', e => e.innerText)), 'no stage: "No stage loaded" note')
  check(await page.$$eval('#a button', bs => bs.some(b => b.textContent.trim() === 'RECCE ON' && b.disabled)), 'no stage: RECCE ON greyed')
  await page.evaluate(() => feed('a', { schema: 1, stageId: 'moab-sand-flats-ss1', stageName: 'SS1 Moab', phase: 'armed', boxCount: 19, view: [], roadbookFile: '/rallyraid/roadbooks/x.roadbook.json' }))
  await sleep(100)
  check(/SS1 Moab/.test(await page.$eval('#a', e => e.innerText)) && /19 boxes/.test(await page.$eval('#a', e => e.innerText)), 'stage loaded: the panel names it, 19 boxes')
  await page.evaluate(() => { calls.length = 0; [...document.querySelectorAll('#a button')].find(b => b.textContent.trim() === 'RECCE ON').click() })
  check((await page.evaluate(() => calls.slice())).some(c => c.startsWith("if rallyRaid_core then rallyRaid_core.cmd('recce', nil, 'planner')")), 'RECCE ON sends recce (planner)')
  // b: recce on, a box being added (the quick-pick)
  await page.evaluate((Q) => feed('b', { schema: 1, stageId: 'x', phase: 'running', trip: 12.4, boxCount: 19, view: [], recce: { on: true, km: 12.45, points: 1182, changes: 9, auto: 6, manual: 3, applied: 0, quick: Q,
    pending: { mode: 'add', symbols: ['rocks', 'danger'], danger: 2, notes: '' } } }), QUICK)
  await sleep(1200)   // roadbook-render.js loads from the Roadbook app folder
  check(await page.evaluate(() => !!window.RoadbookRender), 'the symbols renderer loads from the Roadbook app folder')
  const n = () => page.$$eval('#b .rrc-sym', e => e.length)
  check(await n() === QUICK.length && QUICK.length >= 25, 'quick-pick: ' + QUICK.length + ' QUICK symbols drawn: ' + await n())
  check(await page.$$eval('#b .rrc-sym.on', e => e.length) === 2, 'the 2 picked symbols are marked')
  check(await page.$$eval('#b .rrc-tabs .rrb-btn', e => e.length) === 9, 'a tab per legend group (+ QUICK): ' + await page.$$eval('#b .rrc-tabs .rrb-btn', e => e.length))
  const tabs = await page.evaluate(() => {
    const p = angular.element(document.querySelector('#b > *')).isolateScope(), c = () => document.querySelectorAll('#b .rrc-sym').length, o = {}
    p.$apply(() => p.setGrp('landmarks')); o.landmarks = c()
    p.$apply(() => { p.ui.find = 'palm'; p.findSym() }); o.palm = c() === 1 && !!document.querySelector('#b .rrc-sym[data-c="palm_tree"]')
    p.$apply(() => p.setGrp('quick')); o.back = c()
    return o
  })
  check(tabs.landmarks === 17 && tabs.palm && tabs.back === QUICK.length, 'tabs and search: ' + JSON.stringify(tabs))
  await page.evaluate(() => { calls.length = 0; document.querySelector('#b .rrc-sym[data-c="jump"]').click() })
  await page.evaluate(() => { const p = angular.element(document.querySelector('#b > *')).isolateScope(); p.$apply(() => { p.ui.notes = "it's \\ big \u00e9"; p.save() }) })
  const c = await page.evaluate(() => calls.slice())
  check(c.some(x => x.startsWith("if rallyRaid_core then rallyRaid_core.cmd('reccePick', {symbol='jump'}, 'planner')")), 'a symbol click sends reccePick {symbol=jump}: ' + c[0])
  check(c.some(x => x.startsWith("if rallyRaid_core then rallyRaid_core.cmd('reccePick', {notes='it\\'s \\\\ big '}, 'planner')")) && c.some(x => x.startsWith("if rallyRaid_core then rallyRaid_core.cmd('recceSave', nil, 'planner')")), 'SAVE sends the notes (escaped) then recceSave')
  check(errors.length === 0, 'no page errors: ' + errors.join(' | '))
  fs.mkdirSync(path.join(__dirname, 'screens'), { recursive: true })
  await page.screenshot({ path: path.join(__dirname, 'screens', 'planner_recce.png') })
  await browser.close(); srv.close()
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
