// Screenshot of the in-game HUD apps outside the game (AngularJS stand-in): the Rally Raid Roadbook reader fed with
// a real roadbook the way core.lua's roadbookState() builds it (current box + next 3; scrolled; no roadbook), and the
// GPS app's new BOX line. Writes /workspace/rallyraid/roadbook_app.png. Also checks the button -> Lua command strings.
// NODE_PATH=/workspace/rr-tools/node_modules node tests/browser/preview_roadbook_app.js [roadbook.json]
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid'
const rbFile = process.argv[2] || ROOT + '/roadbook/preview/nam-ss2-terrace-bay-mowe-bay-dunes.edited.roadbook.json'
const rb = JSON.parse(fs.readFileSync(rbFile))
const boxes = rb.boxes.filter(b => !b.deleted).sort((a, b) => a.km - b.km).map((b, i, a) => Object.assign({}, b, { n: i + 1, partial: i ? +(b.km - a[i - 1].km).toFixed(2) : 0 }))
const view = (top, cur) => boxes.slice(top - 1, top + 3).map((b, k) => ({ n: b.n, km: b.km, partial: b.partial, cap: b.capOut != null ? b.capOut : b.cap, label: b.label, waypoint: b.waypoint, notes: b.notes, danger: b.danger, symbols: b.symbols, tulip: b.tulip, offPiste: b.offPiste, current: top + k === cur || undefined }))
const cur = Math.min(boxes.length - 4, 17), trip = boxes[cur - 1].km + 0.31
const state = (top, manual) => ({ schema: 1, stageId: rb.stage.id, phase: 'running', trip, box: cur, boxIndex: cur, nextBox: cur + 1, toNextBox: boxes[cur].km - trip, boxCount: boxes.length, viewIndex: top, manual, view: view(top, cur), roadbookFile: '/rallyraid/roadbooks/' + rb.stage.id + '.roadbook.json' })
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0], f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); r.end(d) } })
})
;(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 790, height: 890 })
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('http://127.0.0.1:' + port + '/tests/roadbook_app_preview.html', { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 500))
  const gps = { ok: true, phase: 'running', stage: rb.stage.name, clock: 2754, count: 8, validated: 2, cap: boxes[cur - 1].capOut, speed: 74, trip, partial: 0.31, total: 61.2, tripStep: 10, wp: { index: 4, n: 3, type: 'WPC', revealed: false } }
  // the quick-pick list, as the game sends it (recce.lua M.QUICK)
  const QUICK = fs.readFileSync(ROOT + '/mod/lua/ge/extensions/rallyRaid/recce.lua', 'utf8').match(/M\.QUICK = \{([^}]*)\}/)[1].match(/'[^']+'/g).map(x => x.slice(1, -1))
  const rcState = Object.assign(state(cur, false), { recce: { on: true, km: 12.43, points: 1180, changes: 9, auto: 6, manual: 3, applied: 0, quick: QUICK,
    nearest: { id: boxes[cur - 1].id, n: cur, d: 34, notes: boxes[cur - 1].notes, verified: false }, last: { kind: 'jump', notes: 'JUMP, 0.9 S AIR, 14 M LONG', danger: 2 } } })
  // a box dropped in recce shows with a purple edge; one the car detected has a purple number until confirmed
  rcState.view[1] = Object.assign({}, rcState.view[1], { recce: 'recce-auto', verified: false, notes: 'JUMP, 0.9 S AIR, 14 M LONG', symbols: ['jump'], danger: 2 })
  const pickState = Object.assign(state(cur + 3, true), { recce: { on: true, km: 12.45, points: 1182, changes: 9, auto: 6, manual: 3, applied: 0, quick: QUICK,
    pending: { mode: 'add', symbols: ['rocks', 'danger'], danger: 2, notes: '' } } })
  await page.evaluate((S) => feed(S), {
    gps: [['RallyRaidUpdate', gps], ['RallyRaidRoadbook', state(cur, false)]],
    rb: [['RallyRaidRoadbook', rcState]],
    rb2: [['RallyRaidRoadbook', pickState]],
    rb3: [['RallyRaidRoadbook', { schema: 1, stageId: 'moab-sand-flats-ss1', phase: 'armed', trip: 0, boxCount: 0, view: [] }]]
  })
  await new Promise(r => setTimeout(r, 1200))
  const got = await page.evaluate(() => ({ rows: document.querySelectorAll('#rb .rrb-box').length, cur: document.querySelectorAll('#rb .rrb-box.cur').length, tulips: document.querySelectorAll('#rb .rrb-c2 svg').length, scrolled: /SCROLLED/.test(document.querySelector('#rb2 .rrb-head').textContent), empty: /roadbooks/.test(document.querySelector('#rb3 .rrb-empty').textContent), gpsBox: /BOX \d+/.test(document.querySelector('#gps .rrg-sub').textContent) }))
  const rc = await page.evaluate(() => ({ panel: !!document.querySelector('#rb .rrc'), near: /NEAR/.test(document.querySelector('#rb .rrc').textContent), last: /DETECTED: JUMP/.test(document.querySelector('#rb .rrc').textContent),
    rcBox: document.querySelectorAll('#rb .rrb-box.rc').length, syms: document.querySelectorAll('#rb2 .rrc-sym').length, symOn: document.querySelectorAll('#rb2 .rrc-sym.on').length, dangerOn: document.querySelector('#rb2 .rrc-row:not(.rrc-tabs) .rrb-btn.on') && document.querySelector('#rb2 .rrc-row:not(.rrc-tabs) .rrb-btn.on').textContent }))
  // quick-pick tabs (the legend's groups) and search
  const tabs = await page.evaluate(async () => {
    const p = angular.element(document.querySelector('#rb2 .rrb-host')).isolateScope(), n = () => document.querySelectorAll('#rb2 .rrc-sym').length
    const o = { tabs: document.querySelectorAll('#rb2 .rrc-tabs .rrb-btn').length }
    p.$apply(() => p.setGrp('landmarks')); o.landmarks = n()
    p.$apply(() => { p.ui.find = 'palm'; p.findSym() }); o.palm = n() === 1 && !!document.querySelector('#rb2 .rrc-sym[data-c="palm_tree"]')
    p.$apply(() => p.setGrp('quick')); o.back = n()
    return o
  })
  console.log('tabs', JSON.stringify(tabs))
  await page.screenshot({ path: ROOT + '/roadbook_app.png' })
  await page.evaluate(() => {
    const s = angular.element(document.querySelector('#rb .rrb-host')).isolateScope(); s.cmd('boxPrev'); s.cmd('boxNext'); s.cmd('boxSync'); s.cmd('reloadRoadbook')
    const p = angular.element(document.querySelector('#rb2 .rrb-host')).isolateScope()
    document.querySelector('#rb2 .rrc-sym[data-c="jump"]').click()
    p.$apply(() => { p.ui.notes = "it's \\ big \u00e9"; p.save() })
    s.$apply(() => { s.ui.rescale = true; s.merge() })
  })
  const rcCmds = await page.evaluate(() => calls.filter(c => /recce/.test(c)))
  console.log(JSON.stringify(rc), rcCmds)
  const rcOk = rc.panel && rc.near && rc.last && rc.rcBox === 1 && rc.syms === QUICK.length && QUICK.length >= 25 && rc.symOn === 2 && tabs.tabs === 9 && tabs.landmarks === 17 && tabs.palm && tabs.back === QUICK.length && rc.dangerOn === '!!' &&
    rcCmds.includes("if rallyRaid_core then rallyRaid_core.cmd('reccePick', {symbol='jump'}) end") &&
    rcCmds.includes("if rallyRaid_core then rallyRaid_core.cmd('reccePick', {notes='it\\'s \\\\ big '}) end") &&
    rcCmds.includes("if rallyRaid_core then rallyRaid_core.cmd('recceSave') end") &&
    rcCmds.includes("if rallyRaid_core then rallyRaid_core.cmd('recceMerge', 'rescale') end")
  const cmds = await page.evaluate(() => calls.filter(c => /box|reload/i.test(c)))
  const ok = rcOk && got.rows === 4 && got.cur === 1 && got.tulips === 4 && got.scrolled && got.empty && got.gpsBox && cmds.length === 4 && errors.length === 0
  console.log(JSON.stringify(got), cmds, errors)
  console.log(ok ? 'PASS' : 'FAIL')
  await browser.close(); srv.close(); process.exit(ok ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
