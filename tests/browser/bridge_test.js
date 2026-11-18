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
const PORT = 18802
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

  await open()
  check(await page.evaluate(() => angular.version.full) === '1.5.8', 'AngularJS 1.5.8, as in the game')
  let logs = await allLogs()
  for (const a of ['gps', 'roadbook', 'repair', 'planner', 'rally'])
    check(logs.some(l => l.includes('[rally.raid Earth] UI ' + a + ': app init')), a + ' app: init logged in the console')
  check(await lua("return rallyRaid_core.appOn('repair') and rallyRaid_core.appOn('planner') and rallyRaid_core.appOn('gps')") === true, 'Lua knows the apps are on screen (hello)')

  // ---- C: the Repair app is not blank, and the GPS MENU buttons work
  const rep = await text('#repair')
  check(/REPAIR/.test(rep) && /No repairs now|repair/i.test(rep) && rep.length > 40, 'Repair app (closed) shows its button and a hint: ' + rep.slice(0, 120))
  await menuOpen()
  check(await visible('#gps .rrg-menu') || /REPAIR/.test(await text('#gps')), 'GPS MENU opens')
  await click('#gps', 'REPAIR')
  check(await visible('#repair .rrr-panel'), 'GPS MENU > REPAIR opens the Repair app panel')
  logs = await allLogs()
  check(logs.some(l => /\[rally\.raid Earth\] cmd repairOpen .*\(gps\)/.test(l)), 'the press is logged: cmd repairOpen (gps)')
  check(logs.some(l => /repair menu opened/.test(l)), 'Lua logs "repair menu opened"')
  check(/No repairs|not in a stage|stage/i.test(await text('#repair .rrr-panel')), 'the Repair panel says why there is nothing to repair: ' + (await text('#repair .rrr-panel')).slice(0, 100))
  await click('#repair', 'CLOSE')
  check(!(await visible('#repair .rrr-panel')), 'the Repair app CLOSE button closes it')
  await click('#repair', 'REPAIR')
  check(await visible('#repair .rrr-panel'), 'the Repair app own button opens it')
  await click('#repair', 'CLOSE')

  await menuOpen()
  await click('#gps', 'PLANNER')
  check(await visible('#planner .rpl-panel'), 'GPS MENU > PLANNER opens the Planner app panel')
  await menuOpen()
  await click('#gps', 'RALLY LAYOUT')
  let gs = await lua('return GS_CALLS')
  check(gs.length === 1 && gs[0][1] === 'rallyRaidEarth', 'RALLY LAYOUT asks the game for the rallyRaidEarth layout: ' + JSON.stringify(gs))
  await click('#gps', 'PLANNER LAYOUT'); await click('#gps', 'MY LAYOUT')
  gs = await lua('return GS_CALLS')
  check(gs.length === 3 && gs[1][1] === 'rallyRaidEarthPlanner' && gs[2][1] === 'freeroam', 'PLANNER LAYOUT, then MY LAYOUT goes back to freeroam: ' + JSON.stringify(gs.map(g => g[1])))
  // an app that is NOT on screen: the GPS says so instead of doing nothing
  // (the Repair app's heartbeat is muted here, as if the app was never added)
  await page.evaluate(() => { const f = bngApi.engineLua; window.unmute = () => { bngApi.engineLua = f }; bngApi.engineLua = (c, cb) => { if (!/appHello\('repair'/.test(c)) f(c, cb) } })
  await lua("rallyRaid_core.appHello('repair', false)"); await sleep(500)
  await menuOpen(); await click('#gps', 'REPAIR')
  const gtx = await text('#gps')
  check(/Repair app is not on your screen/.test(gtx) && /RALLY LAYOUT/.test(gtx), 'REPAIR with no Repair app on screen: a hint in the GPS: ' + (gtx.match(/The Repair app[^.]*\./) || [''])[0])
  await click('#gps', 'OK'); await page.evaluate(() => { const b = [...document.querySelectorAll('#gps button')].find(x => x.innerText.trim() === '✕' && x.offsetWidth); if (b) b.click() })
  await page.evaluate(() => unmute())
  await sleep(3500)   // the heartbeat brings it back
  check(await lua("return rallyRaid_core.appOn('repair')") === true, 'the 3 s heartbeat re-registers the Repair app')

  // ---- D: the Planner with no stage loaded
  await page.evaluate(() => { const b = [...document.querySelectorAll('#planner button')].find(x => x.innerText.trim() === 'CLOSE'); if (b) b.click() }); await sleep(300)
  check(/PLANNER/.test(await text('#planner .rpl-bar')), 'Planner bar: ' + await text('#planner .rpl-bar'))
  await click('#planner', 'PLANNER')
  check(await visible('#planner .rpl-start'), 'Planner with no stage: a start panel (not just "no stage loaded")')
  await click('#planner', 'NEW STAGE HERE')
  await sleep(600)
  const pp = await text('#planner .rpl-panel')
  check(/DSS/.test(pp), 'NEW STAGE HERE starts a stage with a DSS at the car: ' + pp.slice(0, 140))
  check(!(await visible('#planner .rpl-start')), 'after NEW STAGE HERE the editor shows (start panel gone)')
  // EDIT LOADED STAGE: load a stage in the GPS, then the Planner offers it
  await post('/ctl', { op: 'restart' }); await open()
  const stages = await lua('return rallyRaid_core.listStages()')
  const st = stages.find(s => s.ok !== false && /moab/i.test(s.path || s.file)) || stages[0]
  await lua("rallyRaid_core.cmd('load', '" + st.path + "', 'test')"); await tick(3)
  await sleep(500)
  check(/game:/.test(await text('#planner .rpl-bar')) || new RegExp((st.name || '').slice(0, 10)).test(await text('#planner')), 'Planner bar shows the stage loaded in the game: ' + await text('#planner .rpl-bar'))
  await click('#planner', 'PLANNER')
  await click('#planner', 'EDIT LOADED STAGE')
  await sleep(1200)
  check(!(await visible('#planner .rpl-start')) && /km|WP|DSS/.test(await text('#planner .rpl-panel')), 'EDIT LOADED STAGE opens the GPS stage in the planner: ' + (await text('#planner .rpl-panel')).slice(0, 120))
  await click('#planner', 'CLOSE')

  // ---- F: crash save, game kill, RESUME
  const dss = await lua('local S = rallyRaid_core.getState() return S.dss or (S.wps and S.wps[1]) or S.next')
  await click('#gps', 'STAGES'); await sleep(500)
  await click('#gps', 'TP TO DSS'); await tick(5); await sleep(400)
  let snap = await lua('return rallyRaid_core.getState()')
  check(['armed', 'countdown'].includes(snap.phase), 'TP TO DSS: phase ' + snap.phase)
  await page.evaluate(() => { const b = [...document.querySelectorAll('#gps button')].find(x => x.innerText.trim() === '✕' && x.offsetWidth); if (b) b.click() }); await sleep(300)
  if (snap.phase === 'armed') await click('#gps', 'START')
  await tick(80)                      // countdown
  await post('/ctl', { op: 'car', speed: 15 })
  await tick(400)                     // 40 s of stage
  await post('/ctl', { op: 'car', lat: snap.lat || 0, speed: 0 })
  await tick(50)
  snap = await lua('return rallyRaid_core.getState()')
  check(snap.phase === 'running', 'stage running after the countdown: ' + snap.phase)
  let files = (await post('/ctl', { op: 'files' })).value
  check(files.some(f => f.startsWith('/settings/rallyraid/resume/') && f.endsWith('.json')), 'a crash save is on disk: ' + files.filter(f => /resume/.test(f)).join(', '))
  logs = await allLogs()
  await sleep(400); logs = await allLogs()
  check(logs.some(l => /\[rally\.raid Earth\] crash save \d+ written/.test(l)), 'the save write is logged: ' + (logs.filter(l => /crash save/i.test(l)).slice(-2).join(' / ')))

  async function killAndResume(label, dropLedger) {
    await page.goto('about:blank')                            // (so the old page does not take the new Lua's first log lines)
    await post('/ctl', { op: 'restart' })                     // force close: no onExit, a fresh Lua state
    if (dropLedger) await post('/ctl', { op: 'rm', path: '/rallyraid/rally/current.json' })
    if (dropLedger) await post('/ctl', { op: 'restart' })
    await open()
    let lg = await allLogs()
    check(lg.some(l => /crash saves on disk.*: [1-9]/.test(l)), label + ': the startup scan finds the save: ' + lg.find(l => /crash saves on disk/.test(l)))
    await menuOpen()
    check(/CRASH SAVE|crash save/i.test(await text('#gps')), label + ': the GPS MENU lists the crash save: ' + (await text('#gps')).match(/crash save[^]{0,80}/i))
    await click('#gps', 'LOAD')
    await tick(5); await sleep(700)
    const gt = await text('#gps')
    check(/RESUME/.test(gt), label + ': RESUME is offered after loading the stage: ' + (gt.match(/[^ ]* ?RESUME[^]{0,60}/) || [''])[0])
    lg = await allLogs()
    check(lg.some(l => /\[rally\.raid Earth\].*OFFERED/.test(l)), label + ': the save find is logged (OFFERED)')
    if (!dropLedger) check(lg.some(l => /rally ledger: rally \d/.test(l)) && !lg.some(l => /saved under rally/.test(l)), label + ': same rally id after the relaunch (the ledger was written), the save is found directly')
    else check(lg.some(l => /saved under rally/.test(l)), label + ': found by stage under the old rally id')
    // RESUME: the first press shows the save, the second starts the resume (the car then restores its damage:
    // that vehicle round trip is covered by tests/resume_test.lua, there is no car here)
    await lua("rallyRaid_core.cmd('gameResumeKey', nil, 'test')"); await tick(2)
    await lua("rallyRaid_core.cmd('gameResumeKey', nil, 'test')"); await tick(2); await sleep(400)
    const gr = await lua("return rallyRaid_core.gameResumeState()")
    check(!!gr.busy || !!gr.hold, label + ': the second press starts the resume: ' + JSON.stringify({ busy: gr.busy, hold: gr.hold, msg: gr.msg }))
  }
  await killAndResume('kill', false)
  await killAndResume('kill + lost rally ledger', true)

  check(errors.length === 0, 'no page or Lua errors: ' + errors.slice(0, 5).join(' | '))
  const lg = (await allLogs()).filter(l => /rally\.raid Earth/.test(l))
  const perTick = lg.filter(l => /onUpdate|tick/.test(l)).length
  check(perTick === 0, 'no per-frame log lines')
  console.log('--- sample of the console lines (as in the game ~ console):'); lg.slice(-14).forEach(l => console.log('   ' + l))
  await page.screenshot({ path: path.join(REPO, 'tests', 'browser', 'bridge_test.png') })
  await browser.close(); srv.kill()
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
