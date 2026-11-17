// RECOVER CAR (the one reset allowed in a stage) and the GAME-CRASH RESUME in the in-game Rally Raid Repair app, rendered
// outside the game (tests/resume_app_preview.html). Recover car: the confirm (penalty, recoveries left, where the car
// goes, which damage), CONFIRM / CANCEL commands, a refusal with its reason and RETIRE STAGE (asks "sure?"), the running
// recovery (CLOCK STOPPED), the outcome, the RECOVER CAR button in the stage menu (and switched off). Game-crash resume:
// the offer ("Resume from last save (h:mm:ss elapsed, saved X ago)"), RESUME / DISCARD (asks first), fallback and
// penalty lines, the clock held with GO, REVIEW in the bar, the stage-retired case, the "saved to disk" line.
// Screenshot resume_app.png. Prints PASS / FAIL lines.
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid'
const srv = http.createServer((q, r) => {
  let u = q.url.split('?')[0]
  let f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); r.end(d) } })
}).listen(8772)
let fails = 0
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shown = (page, sel) => page.$eval(sel, e => getComputedStyle(e).display !== 'none' && e.offsetParent !== null).catch(() => false)
;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1490, height: 940 })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.goto('http://127.0.0.1:8772/tests/resume_app_preview.html', { waitUntil: 'networkidle0' })
  await sleep(1000)
  const txt = id => page.$eval('#' + id + ' .rrr-rec', e => e.innerText)
  const gtxt = id => page.$eval('#' + id + ' .rrr-game', e => e.innerText)
  // a: the confirm
  const a = await txt('a')
  check(/RECOVER CAR\?/.test(a), 'a: title RECOVER CAR?')
  check(/Penalty \+15 min/.test(a), 'a: penalty +15 min shown: ' + a.split('\n')[1])
  check(/Recoveries \/ resets: 0 of 3 used, 2 left after this/.test(a) && /This stage: 0 of 1/.test(a), 'a: recoveries used and left, this stage')
  check(/30 m behind where you got stuck, at km 8\.21, facing along the route/.test(a), 'a: where the car goes')
  check(/as it was 0:27 ago/.test(a) && /not a free repair/.test(a), 'a: which damage comes back')
  check(/clock stops/.test(a), 'a: says the clock stops')
  check(await shown(page, '#a .rrr-rec .rrr-btn.rgo'), 'a: CONFIRM RECOVERY button')
  check(!(await shown(page, '#a .rrr-rec .rrr-btn.bad')), 'a: no RETIRE button when allowed')
  await page.evaluate(() => { calls.length = 0 })
  await page.click('#a .rrr-rec .rrr-btn.rgo')
  await page.click('#a .rrr-rec .rrr-rfoot .rrr-btn:last-child')
  const ca = await page.evaluate(() => calls.slice())
  check(ca.some(c => c.includes("cmd('recoverConfirm')")) && ca.some(c => c.includes("cmd('recoverCancel')")), 'a: CONFIRM and CANCEL send recoverConfirm / recoverCancel: ' + JSON.stringify(ca))
  check(/RESETS 0\/3/.test(await page.$eval('#a .rrr-bar', e => e.textContent)), 'a: bar still shows the rally count')
  // b: refused, retire offered
  const b = await txt('b')
  check(/NO CAR RECOVERY/.test(b) && /second recovery \/ reset on this stage/.test(b), 'b: refused with the reason')
  check(!(await shown(page, '#b .rrr-rec .rrr-btn.rgo')), 'b: no CONFIRM')
  check(await page.$eval('#b .rrr-rec .rrr-btn.bad', e => e.textContent) === 'RETIRE STAGE', 'b: RETIRE STAGE offered')
  await page.evaluate(() => { calls.length = 0 })
  await page.click('#b .rrr-rec .rrr-btn.bad')
  check((await page.evaluate(() => calls)).some(c => c.includes("cmd('recoverRetire')")), 'b: RETIRE sends resumeRetire')
  // c: sure?
  const c = await txt('c')
  check(/within 1000 m of the ASS/.test(c) && /Really retire this stage/.test(c), 'c: the 1 km rule, asks "really retire?"')
  check(await page.$eval('#c .rrr-rec .rrr-btn.bad', e => e.textContent) === 'YES, RETIRE', 'c: YES, RETIRE')
  // d: running
  const d = await txt('d')
  check(/RECOVER CAR: MOVING THE CAR/.test(d) && /clock is stopped/.test(d), 'd: running, clock stopped')
  check(!(await shown(page, '#d .rrr-rec .rrr-rfoot')), 'd: no buttons while it runs')
  check(/CLOCK STOPPED/.test(await page.$eval('#d .rrr-bar', e => e.innerText)), 'd: bar shows CLOCK STOPPED')
  check(!/CLOCK STOPPED/.test(await page.$eval('#a .rrr-bar', e => e.innerText)), 'a: bar does not')
  // e: outcome
  const e = await txt('e')
  check(/Car recovery 2 of 3: \+30 min, back on the route at km 8\.21/.test(e), 'e: the outcome')
  check(await page.$eval('#e .rrr-rec .rrr-rfoot .rrr-btn:last-child', x => x.textContent) === 'OK', 'e: OK closes it')
  // f: nothing to show; the stage menu has the RECOVER CAR button
  check(!(await shown(page, '#f .rrr-rec')) && !(await shown(page, '#f .rrr-game')), 'f: no recovery / resume box')
  check(await shown(page, '#f .rrr-panel'), 'f: the repair menu is shown')
  await page.evaluate(() => { calls.length = 0 })
  const btn = await page.$$eval('#f .rrr-panel .rrr-btn.bad', x => x.map(b => b.textContent))
  check(btn.includes('RECOVER CAR'), 'f: RECOVER CAR button in the stage menu')
  await page.click('#f .rrr-panel .rrr-btn.bad')
  check((await page.evaluate(() => calls)).some(c => c.includes("cmd('recoverAsk')")), 'f: it sends recoverAsk')
  // f: the "saved to disk" line under it
  check(/saved to disk 12 s ago/.test(await page.$eval('#f .rrr-save', e => e.innerText)), 'f: saved to disk 12 s ago (game-crash save)')
  check(/stuck or rolled\? back on the route, \+15 \/ 30 min/.test(await page.$eval('#f .rrr-rrow', e => e.innerText)), 'f: says what RECOVER CAR costs')
  // l: RECOVER CAR switched off
  check(await page.$eval('#l .rrr-rrow .rrr-btn', e => e.disabled) && /switched off/.test(await page.$eval('#l .rrr-rrow', e => e.innerText)), 'l: switched off: button disabled, says so')
  // g: the game-crash offer
  const g = await gtxt('g')
  check(/SAVED STAGE FOUND \(GAME CRASH\)/.test(g), 'g: title')
  check(/Resume from last save \(1:15:21 elapsed, saved 12 min ago\)/.test(g), 'g: the offer line')
  check(/6 waypoint\(s\) passed, 1 missed, penalties \+0:18, spares used 1, recoveries 1/.test(g) && /saved damage/.test(g), 'g: what was saved')
  check(/About 0:00:22 of driving after the save was lost/.test(g), 'g: the stage time lost (heartbeat)')
  check(/No time penalty\. The resume is flagged for organizer review/.test(g), 'g: no penalty, flagged for review')
  check(!(await shown(page, '#g .rrr-rec')) && !(await shown(page, '#g .rrr-panel')), 'g: the offer is the only box')
  await page.evaluate(() => { calls.length = 0 })
  const gb = await page.$$eval('#g .rrr-game .rrr-btn', x => x.filter(b => b.offsetParent).map(b => b.textContent))
  check(gb.join(',') === 'RESUME,DISCARD', 'g: RESUME and DISCARD: ' + gb.join(','))
  const clickText = (slot, text) => page.evaluate((slot, text) => {
    const b = [...document.querySelectorAll('#' + slot + ' .rrr-game .rrr-btn')].find(x => x.offsetParent && x.textContent === text)
    if (b) b.click()
    return !!b
  }, slot, text)
  await clickText('g', 'RESUME')
  check((await page.evaluate(() => calls)).some(c => c.includes("cmd('gameResumeResume')")), 'g: RESUME sends gameResumeResume')
  await clickText('g', 'DISCARD')
  check((await page.evaluate(() => calls)).some(c => c.includes("cmd('gameResumeDiscard')")), 'g: DISCARD sends gameResumeDiscard')
  const hG = await page.$eval('#g .rrr', e => { const r = e.querySelector('.rrr-game').getBoundingClientRect(), o = e.getBoundingClientRect(); return r.bottom - o.top })
  check(hG <= 300, 'g: the offer fits in the app (' + Math.round(hG) + ' px of 300)')
  // h: discard asks first; the older save; official rules +15 min
  const h = await gtxt('h')
  check(/Really discard\?/.test(h) && /restart is logged/.test(h), 'h: DISCARD asks first')
  check(/newest save was damaged/.test(h), 'h: says the older save is used')
  check(!/of driving after the save/.test(h), 'h: no heartbeat line without a heartbeat')
  const hH = await page.$eval('#h .rrr', e => { const r = e.querySelector('.rrr-game').getBoundingClientRect(), o = e.getBoundingClientRect(); return r.bottom - o.top })
  check(hH <= 300, 'h: the discard question fits in the app (' + Math.round(hH) + ' px of 300)')
  check(/Penalty \+15 min/.test(await page.evaluate(() => { const sc = angular.element(document.querySelector('#h .rrr-host')).isolateScope(); return sc.policyText() })), 'h: official rules: +15 min')
  const hb = await page.$$eval('#h .rrr-game .rrr-btn', x => x.filter(b => b.offsetParent).map(b => b.textContent))
  check(hb.join(',') === 'YES, DISCARD,CANCEL', 'h: YES, DISCARD and CANCEL: ' + hb.join(','))
  // i: resumed, clock held, flagged
  const i = await gtxt('i')
  check(/RESUMED: FLAGGED FOR REVIEW/.test(i) && /Clock held at the saved time/.test(i) && /drive off, or press GO/.test(i), 'i: clock held until the car moves')
  check(/Flagged for review: 12 min between save and resume, about 0:00:22 of stage time lost/.test(i), 'i: the flag with the gap')
  const ib = await page.$eval('#i .rrr-bar', e => e.innerText)
  check(/HELD/.test(ib) && /REVIEW/.test(ib) && !/Ctrl\+Shift\+F/.test(ib), 'i: bar shows HELD and REVIEW')
  await page.evaluate(() => { calls.length = 0 })
  await clickText('i', 'GO')
  check((await page.evaluate(() => calls)).some(c => c.includes("cmd('gameResumeGo')")), 'i: GO sends gameResumeGo')
  // j: resuming
  const j = await gtxt('j')
  check(/RESUMING THE SAVED STAGE/.test(j) && /clock is stopped/.test(j) && !(await shown(page, '#j .rrr-game .rrr-rfoot')), 'j: running, no buttons')
  check(/CLOCK STOPPED/.test(await page.$eval('#j .rrr-bar', e => e.innerText)), 'j: bar shows CLOCK STOPPED')
  // k: over an official limit
  const k = await gtxt('k')
  check(/SAVED STAGE: NO RESUME/.test(k) && /more than 1 resume\(s\) on this stage: the stage is retired/.test(k), 'k: over the limit: the stage is retired')
  const kb = await page.$$eval('#k .rrr-game .rrr-btn', x => x.filter(b => b.offsetParent).map(b => b.textContent))
  check(kb.join(',') === 'RETIRE STAGE,DISCARD', 'k: RETIRE STAGE and DISCARD: ' + kb.join(','))
  // the confirm fits in the app's 360 x 300 box
  const hA = await page.$eval('#a .rrr', e => { const r = e.querySelector('.rrr-rec').getBoundingClientRect(), o = e.getBoundingClientRect(); return r.bottom - o.top })
  check(hA <= 300, 'a: the confirm fits in the app (' + Math.round(hA) + ' px of 300)')
  await page.screenshot({ path: ROOT + '/resume_app.png' })
  check(errors.length === 0, 'no console errors: ' + JSON.stringify(errors))
  console.log(fails ? fails + ' FAILED' : 'ALL PASS')
  await browser.close(); srv.close()
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
