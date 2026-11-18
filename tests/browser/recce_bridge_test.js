// Recce for fixing an existing roadbook on the real Lua, in the Planner app's RECCE panel (18 Nov: moved there from the
// Roadbook app, which is a reader now): no stage loaded (RECCE ON greyed, a note), then on the loaded stage: select any box,
// KM = TRIP / +-10, CAP HERE, note presets, the CHANGES list with UNDO per row, MERGE preview, REPORT, OFF; the edits show
// live in the Roadbook app, and the Roadbook has no recce buttons.
// Same harness as bridge_test.js. Below, that file's header:
// The 17 Nov in-game failures, end to end: every app in Chrome with AngularJS 1.5.8 (the game's version), and every
// bngApi.engineLua call running the REAL mod Lua in LuaJIT (tests/bridge/bridge_server.py, env.lua fakes the game).
// So the Lua strings the buttons send, the commands they reach and the guihooks that come back are what is tested.
//   C  GPS MENU > REPAIR / PLANNER open those apps; the Repair app is not blank; layout buttons ask for our layouts
//   D  the Planner with no stage: NEW STAGE HERE, EDIT LOADED STAGE; the GPS PLANNER button opens it
//   F  a crash save is written while driving, found after a game kill (fresh Lua), shown in the GPS MENU, RESUME offered
//      on load and resumes the clock; also when the rally ledger was lost (a new rally id after the relaunch)
//   logs: "[rally.raid Earth]" lines for app init, button presses, save write / find
// Run: NODE_PATH=<dir with puppeteer-core> node tests/browser/bridge_test.js   (needs .venv with lupa, Chrome, unpkg)
const puppeteer = require('puppeteer-core'), path = require('path'), { spawn } = require('child_process'), http = require('http')
const REPO = path.resolve(__dirname, '..', '..')
const PORT = 18803
const PY = process.env.PYTHON || path.join(REPO, '.venv', 'bin', 'python')
let fails = 0
const T0 = Date.now()
const check = (c, m) => { console.log(((Date.now() - T0) / 1000).toFixed(1) + ' ' + (c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
function post(u, body) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(body || {})
    const q = http.request({ host: '127.0.0.1', port: PORT, path: u, method: 'POST', headers: { 'Content-Length': Buffer.byteLength(d) } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
    }); q.on('error', rej); q.end(d)
  })
}
const lua = async code => { const r = await post('/ctl', { op: 'eval', code }); if (r.error) throw new Error(r.error); return r.value }
const tick = (n, dt) => post('/tick', { n, dt: dt || 0.1 })
;(async () => {
  const srv = spawn(PY, [path.join(REPO, 'tests', 'bridge', 'bridge_server.py'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(r => srv.stdout.on('data', d => { if (/bridge ready/.test(String(d))) r() }))
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1600, height: 1000 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  const allLogs = () => page.evaluate(() => LOGS.slice())
  const visible = sel => page.evaluate(s => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).display !== 'none' }, sel)
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : '' }, sel)
  // click a visible, enabled button in the slot by its text (an Angular ng-click, as a mouse click would)
  const click = async (slot, label) => {
    const ok = await page.evaluate((s, l) => {
      const b = [...document.querySelectorAll(s + ' button')].find(x => (x.innerText.trim() === l || x.innerText.trim().startsWith(l + ':')) && (x.offsetWidth || x.offsetHeight) && !x.disabled)
      if (b) b.click(); return !!b
    }, slot, label)
    if (!ok) check(false, 'no visible button "' + label + '" in ' + slot)
    await sleep(400)
    return ok
  }
  const menuOpen = async () => {
    const m = await page.evaluate(() => { const e = angular.element(document.querySelector('#gps').firstElementChild); return (e.isolateScope() || e.scope()).menu })
    if (!m) await click('#gps', 'MENU')
  }
  const open = async () => { await page.goto('http://127.0.0.1:' + PORT + '/page.html', { waitUntil: 'load' }); await sleep(1500) }


  const clickT = async (slot, label) => { const ok = await click(slot, label); await tick(2); await sleep(350); return ok }
  const rows = () => page.evaluate(() => document.querySelectorAll('#planner .rrc-li').length)
  await open()
  // 1) no stage loaded: the RECCE panel says so, RECCE ON is greyed; the Roadbook has no recce buttons
  check(!(await visible('#planner .rrc')), 'Planner: the RECCE panel is hidden at start')
  await clickT('#planner', 'RECCE')
  check(await visible('#planner .rrc-off'), 'Planner bar RECCE shows the RECCE panel')
  check(/No stage loaded/.test(await text('#planner .rrc-off')), 'no stage: the panel says to load one first: ' + (await text('#planner .rrc-off')).slice(0, 120))
  check(await page.evaluate(() => [...document.querySelectorAll('#planner .rrc-off button')].some(b => b.innerText.trim() === 'RECCE ON' && b.disabled)), 'no stage: RECCE ON is greyed')
  check(await page.evaluate(() => ![...document.querySelectorAll('#rb button')].some(b => /RECCE/.test(b.innerText)) && !document.querySelector('#rb .rrc')), 'the Roadbook app has no RECCE button or panel (reader only)')
  await lua("rallyRaid_core.cmd('load', '/rallyraid/stages/moab-sand-flats-ss1.json', 'test')")
  const boxes = await lua('local S = rallyRaid_core._debug() return S.stage.roadbook.boxes')
  await post('/ctl', { op: 'car', lat: boxes[2].lat, lon: boxes[2].lon, speed: 0, heading: 200 })
  await tick(3); await sleep(400)
  check(/moab|SS1/i.test(await text('#planner .rrc-off')) && /\d+ boxes/.test(await text('#planner .rrc-off')), 'with the stage loaded the panel names it: ' + (await text('#planner .rrc-off')).slice(0, 120))
  await clickT('#planner', 'RECCE ON')
  check(await visible('#planner .rrc') && !(await visible('#planner .rrc-off')), 'RECCE ON: the recce controls show (on the loaded stage)')
  check(/RECCE/.test(await text('#rb .rrb-head')) || await visible('#rb .rrb-rc'), 'the Roadbook head shows RECCE while it is on')
  check(/\u25CF RECCE/.test(await text('#planner .rpl-bar')), 'the Planner bar RECCE button shows recce is on: ' + await text('#planner .rpl-bar'))
  let t = await text('#planner .rrc')
  check(/NEAR 3/.test(t), 'the panel acts on the nearest box (3) at first: ' + t.slice(0, 90))
  check(/KM = TRIP/.test(t) && /CAP HERE/.test(t) && /CHANGES 0/.test(t) && /REPORT/.test(t), 'new buttons: < > AT TRIP, KM = TRIP, -10 +10, CAP HERE, CHANGES, REPORT')
  // 2) select any box
  await clickT('#planner', '\u25B6')
  check(/SEL 4/.test(await text('#planner .rrc')), '> selects box 4: ' + (await text('#planner .rrc')).match(/(SEL|NEAR) \d+/))
  await clickT('#planner', '\u25C0'); await clickT('#planner', '\u25C0')
  check(/SEL 2/.test(await text('#planner .rrc')), '< < selects box 2')
  await lua("rallyRaid_core.cmd('tripSet', '" + (boxes[4].km + 0.05) + "', 'gps')"); await tick(2)
  await clickT('#planner', 'AT TRIP')
  check(/SEL 5/.test(await text('#planner .rrc')), 'AT TRIP selects the box at the trip meter (5)')
  // 3) km from the trip meter
  await clickT('#planner', 'KM = TRIP')
  const km5 = await lua("local b = require('rallyRaid/recce').target() return b.km")
  check(Math.abs(km5 - (boxes[4].km + 0.05)) < 0.002, 'KM = TRIP sets box 5 to the trip reading: ' + km5)
  await clickT('#planner', '+10')
  check(Math.abs((await lua("return require('rallyRaid/recce').target().km")) - km5 - 0.01) < 0.002, '+10 nudges it 10 m')
  check(/SEL 5 [\d.]+ km/.test(await text('#planner .rrc')) && new RegExp((km5 + 0.01).toFixed(2)).test(await text('#planner .rrc')), 'the panel shows the new km')
  await clickT('#planner', 'CAP HERE')
  check(await lua("return require('rallyRaid/recce').target().cap") === 200, 'CAP HERE: CAP 200 from the car heading')
  // 4) note presets
  await clickT('#planner', '+ BOX HERE')
  check(await visible('#planner .rrc-presets'), 'the quick-pick has the note presets')
  await clickT('#planner', 'ROUGH'); await clickT('#planner', 'JUNCTION NOT VISIBLE')
  check(await page.$eval('#planner .rrc-notes', e => e.value) === 'ROUGH, JUNCTION NOT VISIBLE', 'presets fill the notes: ' + await page.$eval('#planner .rrc-notes', e => e.value))
  await clickT('#planner', 'ROUGH')
  check(await page.$eval('#planner .rrc-notes', e => e.value) === 'JUNCTION NOT VISIBLE', 'a second press takes a preset out')
  const rbBefore = await text('#rb')
  await clickT('#planner', 'SAVE')
  await tick(3); await sleep(500)
  check(/JUNCTION NOT VISIBLE/.test(await text('#rb')) && !/JUNCTION NOT VISIBLE/.test(rbBefore), 'the new box shows live in the Roadbook app')
  // 1) the changes list
  await clickT('#planner', 'CHANGES 3')
  check(await rows() === 3, 'CHANGES 3 lists 3 rows (KM, CAP, ADD)')
  t = await text('#planner .rrc-list')
  check(/ADD.*JUNCTION NOT VISIBLE/.test(t) && /CAP.*CAP 200/.test(t) && /KM/.test(t), 'rows: ' + t.slice(0, 160))
  // UNDO on the CAP row
  await page.evaluate(() => { const r = [...document.querySelectorAll('#planner .rrc-li')].find(x => /CAP 200/.test(x.innerText)); r.querySelector('button').click() })
  await tick(2); await sleep(400)
  check(await rows() === 2 && !/CAP 200/.test(await text('#planner .rrc-list')), 'UNDO on one row takes only that change back')
  // 5) merge preview
  await clickT('#planner', 'MERGE')
  t = await text('#planner .rrc')
  check(/MERGE PREVIEW: 2 of 2 apply, 0 conflicts/.test(t), 'MERGE first shows a preview: ' + (t.match(/MERGE PREVIEW[^]{0,40}/) || [''])[0])
  check((await post('/ctl', { op: 'files' })).value.every(f => !/roadbooks/.test(f)), 'the preview writes nothing')
  await clickT('#planner', 'CANCEL')
  check(!/MERGE PREVIEW/.test(await text('#planner .rrc')), 'CANCEL closes the preview')
  // the report
  await clickT('#planner', 'REPORT')
  t = await text('#planner .rrc')
  check(/REPORT: \/rallyraid\/recce\/moab-sand-flats-ss1\.report\.txt/.test(t), 'REPORT shows the file path: ' + (t.match(/REPORT: \S+/) || [''])[0])
  const files = (await post('/ctl', { op: 'files' })).value
  check(files.includes('/rallyraid/recce/moab-sand-flats-ss1.report.txt') && files.includes('/rallyraid/recce/moab-sand-flats-ss1.report.json'), 'report .txt and .json in the user folder')
  // CONFIRM MERGE
  await clickT('#planner', 'MERGE'); await clickT('#planner', 'CONFIRM MERGE')
  check((await post('/ctl', { op: 'files' })).value.some(f => /roadbooks\/.*\.roadbook\.json$/.test(f)) && /CHANGES 0/.test(await text('#planner .rrc')), 'CONFIRM MERGE writes the roadbook, the list is empty')
  // recce OFF from the panel
  await clickT('#planner', 'OFF')
  check(await visible('#planner .rrc-off') && await lua("return require('rallyRaid/recce').active()") === false, 'OFF turns recce off; the panel shows RECCE ON again')
  const lg = (await allLogs()).filter(l => /rally\.raid Earth/.test(l))
  for (const re of [/cmd recceSel "next" \(planner\)/, /recce: box 5 selected/, /cmd recceKm "trip" \(planner\)/, /recce: box 5 km/, /recce: box 5 CAP 200/,
    /recce undo: change 2/, /recce merge preview: 2 of 2/, /recce report written: \/rallyraid\/recce\/moab-sand-flats-ss1\.report\.txt/, /recce merged: rev/])
    check(lg.some(l => re.test(l)), 'console: ' + re.source)
  check(errors.length === 0, 'no page or Lua errors: ' + errors.slice(0, 5).join(' | '))
  await page.screenshot({ path: path.join(REPO, 'tests', 'browser', 'recce_bridge_test.png') })
  await browser.close(); srv.kill()
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
