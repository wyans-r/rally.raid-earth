// The HUD buttons that replace the keys taken out on 2026-11-17 (Wyans: "take the hotkeys out for everything except the
// most important to do while driving ... and rely on hud buttons"). Outside the game, in the apps' preview pages:
//  * GPS app MENU: REPAIR -> repairMenu, PLANNER -> plannerMenu, RECOVER -> recoverKey (a second press, CONFIRM, sends
//    recoverKey again = the old key's confirm; CANCEL -> recoverCancel; off outside a running stage), crash RESUME ->
//    gameResumeKey (shows the save, CONFIRM RESUME resumes), GO while the clock is held -> gameResumeKey; the menu opens
//    on its own when a save is offered
//  * no app shows a hardcoded Ctrl+Shift key; the keys come from 'RallyRaidKeys' (the player's bindings), so a kept key
//    shows on its button and a key the player bound to an unbound action shows up too; each app asks for them (cmd 'keys')
//  * the Roadbook recce panel buttons send the recce commands
// Screenshot screens/gps_menu.png. Prints PASS / FAIL lines; exit code 1 on a failure.
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
const KEPT = { rallyRaid_tripPlus: 'Ctrl+Shift+Up', rallyRaid_tripMinus: 'Ctrl+Shift+Down', rallyRaid_wPlus: 'Ctrl+Shift+Right', rallyRaid_wMinus: 'Ctrl+Shift+Left',
  rallyRaid_partialReset: 'Ctrl+Shift+P', rallyRaid_start: 'Ctrl+Shift+Home', rallyRaid_boxPrev: 'Ctrl+Shift+PgUp', rallyRaid_boxNext: 'Ctrl+Shift+PgDn', rallyRaid_boxSync: 'Ctrl+Shift+End' }
;(async () => {
  const port = srv.address().port
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const errors = []
  async function open(file) {
    const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 940 })
    page.on('pageerror', e => errors.push(file + ': ' + e.message))
    await page.goto('http://127.0.0.1:' + port + '/tests/' + file, { waitUntil: 'networkidle0' })
    await sleep(800)
    return page
  }
  // send a guihook to one app: sel = the slot, name = the hook
  const send = (page, sel, name, data) => page.evaluate((sel, name, data) => {
    const el = document.querySelector(sel + ' > *'); const s = angular.element(el).isolateScope(); s.$apply(() => s.$broadcast(name, data))
  }, sel, name, data)
  const calls = page => page.evaluate(() => calls.slice())
  const reset = page => page.evaluate(() => { calls.length = 0 })
  const click = async (page, sel) => { await page.click(sel); await sleep(80) }
  const btnBy = (page, scope, text) => page.evaluateHandle((scope, text) => [...document.querySelectorAll(scope + ' button')].find(b => b.textContent.trim() === text && b.offsetParent !== null) || null, scope, text)
  const clickText = async (page, scope, text) => { const h = await btnBy(page, scope, text); const el = h.asElement(); if (!el) return false; await el.click(); await sleep(80); return true }

  // ---------------------------------------------------------------- GPS
  const g = await open('app_preview.html')
  check((await calls(g)).some(c => c.includes("cmd('hello'")), 'GPS says hello at start (Lua then pushes the recover / crash-resume state)')
  const html = await g.$eval('#a', e => e.innerHTML)
  check(!/Ctrl\+Shift/.test(html), 'GPS: no hardcoded key before RallyRaidKeys')
  check(await g.$eval('#a .rrg-menubtn', e => e.textContent.trim()) === 'MENU', 'GPS footer has MENU')
  await reset(g)
  await click(g, '#a .rrg-menubtn')
  check(await g.$eval('#a .rrg-menu', e => getComputedStyle(e).display !== 'none'), 'MENU opens the rally menu')
  check(await clickText(g, '#a .rrg-menu', 'REPAIR'), 'REPAIR button there')
  check((await calls(g)).some(c => c.includes("cmd('repairOpen'")), 'REPAIR sends repairOpen: ' + JSON.stringify(await calls(g)))
  await click(g, '#a .rrg-menubtn'); await reset(g)
  check(await clickText(g, '#a .rrg-menu', 'PLANNER'), 'PLANNER button there')
  check((await calls(g)).some(c => c.includes("cmd('plannerOpen'")), 'PLANNER sends plannerOpen')
  // recover car, two steps (a: running stage)
  await click(g, '#a .rrg-menubtn'); await reset(g)
  check(await clickText(g, '#a .rrg-menu', 'RECOVER'), 'RECOVER button (running stage)')
  check((await calls(g)).filter(c => c.includes("cmd('recoverKey'")).length === 1, 'RECOVER sends recoverKey (the ask)')
  await send(g, '#a', 'RallyRaidRecover', { enabled: true, inStage: true, ask: { allowed: true, penaltyS: 900, leftAfter: 2, max: 3, target: { backM: 30, km: 8.21 } } })
  const mt = await g.$eval('#a .rrg-menu', e => e.innerText)
  check(/RECOVER CAR\? \+15 min, 2 of 3 left after it, back 30 m on the route/.test(mt), 'the ask shows penalty, left, where: ' + mt.split('\n').find(l => /RECOVER CAR\?/.test(l)))
  check(await g.$eval('#a .rrg-menubtn', e => e.classList.contains('warn')), 'MENU button turns red while a recovery is asked')
  await reset(g)
  check(await clickText(g, '#a .rrg-menu', 'CONFIRM'), 'CONFIRM shown')
  check((await calls(g)).some(c => c.includes("cmd('recoverKey'")), 'CONFIRM sends recoverKey again (the second press confirms in Lua)')
  await reset(g)
  check(await clickText(g, '#a .rrg-menu', 'CANCEL'), 'CANCEL shown')
  check((await calls(g)).some(c => c.includes("cmd('recoverCancel'")), 'CANCEL sends recoverCancel')
  await send(g, '#a', 'RallyRaidRecover', { enabled: true, inStage: true, ask: { allowed: false, reason: 'within 1000 m of the ASS' } })
  await sleep(50)
  check(/No recovery: within 1000 m of the ASS/.test(await g.$eval('#a .rrg-menu', e => e.innerText)), 'a refusal shows its reason')
  await send(g, '#a', 'RallyRaidRecover', { enabled: true, busy: { phase: 'move' } })
  check(await g.evaluate(() => [...document.querySelectorAll('#a .rrg-menu button')].find(b => /RECOVER|CONFIRM/.test(b.textContent)).disabled), 'RECOVER off while a recovery runs')
  // d: armed (not running) -> RECOVER disabled
  await click(g, '#d .rrg-menubtn')
  check(await g.evaluate(() => [...document.querySelectorAll('#d .rrg-menu button')].find(b => b.textContent.trim() === 'RECOVER').disabled), 'RECOVER disabled outside a running stage')
  check(/in a running stage/.test(await g.$eval('#d .rrg-menu', e => e.innerText)), 'and says so')
  await send(g, '#c', 'RallyRaidRecover', { enabled: false })
  await click(g, '#c .rrg-menubtn')
  check(/switched off for this event/.test(await g.$eval('#c .rrg-menu', e => e.innerText)), 'RECOVER switched off for an event: says so')
  // crash resume (b): the offer opens the menu by itself
  await send(g, '#b', 'RallyRaidGameResume', { enabled: true, offer: { text: 'Resume from last save (0:12:34 elapsed, saved 3 min ago)', policy: {} } })
  await sleep(50)
  check(await g.$eval('#b .rrg-menu', e => getComputedStyle(e).display !== 'none'), 'a crash save offered: the menu opens by itself')
  check(await g.$eval('#b .rrg-menubtn', e => e.textContent.trim()) === 'RESUME?', 'MENU reads RESUME?')
  check(/SAVED STAGE Resume from last save \(0:12:34 elapsed, saved 3 min ago\)/.test(await g.$eval('#b .rrg-menu', e => e.innerText)), 'the save is shown')
  await reset(g)
  check(await clickText(g, '#b .rrg-menu', 'RESUME'), 'RESUME button')
  check((await calls(g)).some(c => c.includes("cmd('gameResumeKey'")), 'RESUME sends gameResumeKey (first press)')
  await send(g, '#b', 'RallyRaidGameResume', { enabled: true, keyArmed: true, offer: { text: 'Resume from last save (0:12:34 elapsed, saved 3 min ago)', policy: {} } })
  await reset(g)
  check(await clickText(g, '#b .rrg-menu', 'CONFIRM RESUME'), 'then CONFIRM RESUME')
  check((await calls(g)).some(c => c.includes("cmd('gameResumeKey'")), 'CONFIRM RESUME sends gameResumeKey (second press resumes)')
  await send(g, '#b', 'RallyRaidGameResume', { enabled: true, offer: { text: 'Resume from last save', policy: { refused: true, retire: true, reason: 'over the resume limit' } } })
  check(/over the resume limit/.test(await g.$eval('#b .rrg-menu', e => e.innerText)) && !!(await (await btnBy(g, '#b .rrg-menu', 'RETIRE')).asElement()), 'a refused save: reason + RETIRE')
  await send(g, '#b', 'RallyRaidGameResume', { enabled: true, hold: true })
  await reset(g)
  check(await clickText(g, '#b .rrg-menu', 'GO'), 'clock held: GO button')
  check((await calls(g)).some(c => c.includes("cmd('gameResumeKey'")), 'GO sends gameResumeKey')
  await send(g, '#b', 'RallyRaidGameResume', { enabled: true })
  check(!(await (await btnBy(g, '#b .rrg-menu', 'GO')).asElement()) && !(await (await btnBy(g, '#b .rrg-menu', 'RESUME')).asElement()), 'no save, no hold: no RESUME / GO')
  // keys: a player-bound key shows on its button
  await send(g, '#b', 'RallyRaidKeys', { keys: Object.assign({ rallyRaid_recoverCar: 'Alt+G' }, KEPT) })
  const t = await g.evaluate(() => [...document.querySelectorAll('#b .rrg-menu button')].map(b => b.title).join(' | '))
  check(/press twice: see the penalty, then confirm \(Alt\+G\)/.test(t), 'a key bound to recover car shows on RECOVER: ' + t)
  check(/open the planner in the Planner app( \||$)/.test(t), 'PLANNER (no key): no key in its title')
  check(/sync Ctrl\+Shift\+End/.test(await g.$eval('#b .rrg-menu', e => e.innerText)), 'the menu lists the driving keys')
  fs.mkdirSync(path.join(__dirname, 'screens'), { recursive: true })
  await g.screenshot({ path: ROOT + '/tests/browser/screens/gps_menu.png', clip: { x: 0, y: 0, width: 1180, height: 360 } })

  // ---------------------------------------------------------------- Roadbook
  const r = await open('roadbook_app_preview.html')
  check((await calls(r)).some(c => c.includes("cmd('keys'")), 'Roadbook asks for the keys')
  const rbHtml = () => r.$eval('#rb', e => e.innerHTML)
  check(!/Ctrl\+Shift/.test(await rbHtml()), 'Roadbook: no key shown before RallyRaidKeys')
  await send(r, '#rb', 'RallyRaidKeys', { keys: KEPT })
  const titles = await r.evaluate(() => [...document.querySelectorAll('#rb .rrb-foot button')].map(b => b.title))
  check(titles.some(x => x === 'box up (Ctrl+Shift+PgUp)') && titles.some(x => x === 'box down (Ctrl+Shift+PgDn)') && titles.some(x => /trip to its km \(Ctrl\+Shift\+End\)$/.test(x)), 'kept keys on ▲ ▼ SYNC: ' + titles.join(' | '))
  check(titles.some(x => /^Recce mode on \/ off: record/.test(x)), 'RECCE: no key (unbound)')
  await send(r, '#rb', 'RallyRaidKeys', { keys: { rallyRaid_boxSync: 'F5', rallyRaid_recce: 'Alt+R' } })
  const t2 = await r.evaluate(() => [...document.querySelectorAll('#rb .rrb-foot button')].map(b => b.title))
  check(t2.some(x => /\(F5\)$/.test(x)) && t2.some(x => /\(Alt\+R\)/.test(x)) && t2.some(x => x === 'box up'), 'the player\'s own keys: F5 on SYNC, Alt+R on RECCE, none on ▲: ' + t2.join(' | '))
  // recce panel buttons (a roadbook state with recce on and a box near)
  await send(r, '#rb', 'RallyRaidRoadbook', { phase: 'running', stageId: 'x', trip: 1.2, boxCount: 3, view: [], recce: { km: 1.2, changes: 2, auto: 1, nearest: { n: 3, d: 12, notes: 'x', verified: false }, target: { n: 3, d: 12, km: 1.2, how: 'nearest', notes: 'x', verified: false } } })
  await sleep(100)
  const want = { UNDO: 'recceUndo', HERE: 'recceMove', TAG: 'recceRetag', '\u2713': 'recceConfirm', '\u2715': 'recceDelete', '+ BOX HERE': 'recceDrop', RECCE: 'recce', 'AT TRIP': 'recceSel', '\u25B6': 'recceSel', '\u25C0': 'recceSel', 'KM = TRIP': 'recceKm', '+10': 'recceKm', '-10': 'recceKm', 'CAP HERE': 'recceCap', REPORT: 'recceReport', MERGE: 'reccePreview' }
  for (const [label, c] of Object.entries(want)) {
    await reset(r)
    const ok = await clickText(r, '#rb', label)
    check(ok && (await calls(r)).some(x => x.includes("cmd('" + c + "',")), 'Roadbook ' + label + ' sends ' + c)
  }

  // ---------------------------------------------------------------- Repair
  const p = await open('resume_app_preview.html')
  check((await calls(p)).some(c => c.includes("cmd('keys'")), 'Repair asks for the keys')
  check(!/Ctrl\+Shift/.test(await p.$eval('body', e => e.innerText)), 'Repair: no hardcoded key on screen')
  check(!(await p.$eval('#f .rrr-bar .k', e => e.offsetParent !== null)), 'Repair bar: no key label when repair has no key')
  await send(p, '#f', 'RallyRaidKeys', { keys: { rallyRaid_repairMenu: 'Alt+F' } })
  check(await p.$eval('#f .rrr-bar .k', e => e.offsetParent !== null && e.textContent === 'Alt+F'), 'Repair bar shows a key the player bound (Alt+F)')
  check(/Confirm here, or press RECOVER in the GPS app again/.test(await p.$eval('#a .rrr-rec', e => e.innerText)), 'recover confirm points to the GPS button')

  // ---------------------------------------------------------------- Planner
  const n = await open('planner_app_preview.html')
  check((await n.evaluate(() => calls.slice())).some(c => c.includes("cmd('keys'")), 'Planner asks for the keys')
  check(!/Ctrl\+Shift/.test(await n.$eval('#a', e => e.innerHTML)), 'Planner: no hardcoded key')
  check(!(await n.$eval('#a .rpl-bar .k', e => e.offsetParent !== null)), 'Planner bar: no key label by default')
  await send(n, '#a', 'RallyRaidKeys', { keys: { rallyRaid_plannerMenu: 'Alt+J' } })
  check(await n.$eval('#a .rpl-bar .k', e => e.offsetParent !== null && e.textContent === 'Alt+J'), 'Planner bar shows a key the player bound')

  check(errors.length === 0, 'no page errors: ' + JSON.stringify(errors))
  await browser.close(); srv.close()
  console.log(fails ? fails + ' FAILED' : 'all passed')
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
