// Browser test of /events/ (headless Chrome, puppeteer-core) against the local Worker after e2e.test.mjs ran:
// login with an email code in the page, enter the event, upload a result file through the file picker, leaderboard,
// admin review of a flagged result (trace + decision), organizer tools on a draft, admin requests. Desktop 1280x900 and
// phone 390x844 screenshots in test/shots/. Fails on any page error.
const puppeteer = require('puppeteer-core'), fs = require('fs'), path = require('path')
const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const OUT = path.join(__dirname, 'shots'); fs.mkdirSync(OUT, { recursive: true })
const ST = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/e2e_state.json'), 'utf8'))
const pkg0 = JSON.parse(fs.readFileSync('/workspace/rallyraid/tests/fixtures/events/moab_official_package.json', 'utf8'))
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
let fails = 0
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const errors = []
  async function newPage(phone) {
    const ctx = await browser.createBrowserContext()
    const p = await ctx.newPage()
    if (phone) { await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1') }
    else await p.setViewport({ width: 1280, height: 900 })
    p.on('pageerror', e => errors.push('pageerror: ' + e.message))
    p.on('console', m => { if (m.type() === 'error' && !/40[0-9]/.test(m.text())) errors.push(m.text()) })
    p.on('dialog', d => d.accept())
    return p
  }
  async function shot(p, name, full = true) { await sleep(250); await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full }) }
  async function login(p, email) {
    await p.goto(BASE + '/events/#/login', { waitUntil: 'networkidle0' })
    await p.type('#em', email); await p.click('#send')
    await p.waitForSelector('#codeRow:not([style*="none"])')
    const code = await p.evaluate(async e => { const r = await fetch('/api/dev/outbox'); const d = await r.json(); return /code is (\d{6})/.exec(d.mails.find(m => m.to_addr === e).body)[1] }, email)
    await p.type('#code', code); await p.click('#verify')
    await p.waitForFunction(() => location.hash === '#/' && document.querySelector('#who a[href="#/me"]'))
  }

  // ---- phone: a new driver logs in, enters, uploads a file, sees the leaderboard
  const ph = await newPage(true)
  await ph.goto(BASE + '/events/#/', { waitUntil: 'networkidle0' })
  await ph.waitForSelector('.cards .card')
  ok(await ph.$eval('.cards', el => el.textContent.includes('Moab Winter Rally')), 'phone: event listed')
  await shot(ph, 'phone_list')
  await ph.goto(BASE + '/events/#/login', { waitUntil: 'networkidle0' }); await shot(ph, 'phone_login', false)
  const email = `phone_${Date.now()}@example.com`
  await login(ph, email)
  await ph.goto(BASE + '/events/#/e/' + ST.ev.slug, { waitUntil: 'networkidle0' })
  await ph.waitForSelector('#enter')
  await ph.select('#cls', 'T3 Light prototype'); await ph.type('#veh', 'Ibishu Pigeon')
  await ph.click('#enter')
  await ph.waitForSelector('#drop')
  ok(await ph.$('button.pack') != null, 'phone: pack download button after entering')
  const entryId = await ph.evaluate(async id => (await (await fetch('/api/events/' + id)).json()).event.myEntry.id, ST.ev.id)
  const p = JSON.parse(JSON.stringify(pkg0))
  p.event = { id: ST.ev.id }; p.entry = { id: entryId }; p.stage.index = 1
  const start = Date.now() - 30 * 60e3; p.result.startedAt = iso(start); p.result.finishedAt = iso(start + p.result.stageTime * 1000)
  p.trace.epoch0 = Math.floor(start / 1000); for (const q of p.trace.pts) q[1] = Math.round(q[0])
  for (const w of p.result.waypoints) if (w.time) w.time = +w.time
  const f = path.join(__dirname, 'out', 'phone_ss1.rrresult.json'); fs.writeFileSync(f, JSON.stringify(p))
  const input = await ph.$('#file'); await input.uploadFile(f)
  await ph.waitForFunction(() => document.querySelector('#toast').textContent.includes('Result'), { timeout: 10000 })
  const toastTxt = await ph.$eval('#toast', el => el.textContent)
  ok(/accepted/.test(toastTxt), 'phone: file upload accepted: ' + toastTxt)
  await ph.waitForFunction(() => document.querySelector('.badge.b-pass'))
  await shot(ph, 'phone_event_entrant')
  const overflow = await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ok(overflow <= 1, 'phone: no sideways scrolling of the page (' + overflow + ' px)')

  // ---- desktop: the admin (organizer tools on every event)
  const dk = await newPage(false)
  await login(dk, 'wyans@example.com')
  await dk.goto(BASE + '/events/#/e/' + ST.ev.slug, { waitUntil: 'networkidle0' })
  await dk.waitForSelector('.lb')
  ok(await dk.$eval('.lb', el => el.textContent.includes('Hors classement') && el.textContent.includes('Alice')), 'desktop: leaderboard with the HC column')
  ok(await dk.$eval('main', el => el.textContent.includes('known stage')), 'desktop: known stage label')
  await shot(dk, 'desktop_event')
  await dk.goto(BASE + '/events/#/e/' + ST.ev.slug + '/review', { waitUntil: 'networkidle0' })
  await dk.waitForSelector('table'); await shot(dk, 'desktop_review')
  await dk.goto(BASE + '/events/#/r/' + ST.results.carl, { waitUntil: 'networkidle0' })
  await dk.waitForSelector('svg.trace')
  ok(await dk.$$eval('.check.no', l => l.length) >= 2, 'desktop: failed checks listed')
  await shot(dk, 'desktop_result_trace')
  // a draft: organizer tools
  await dk.goto(BASE + '/events/#/new', { waitUntil: 'networkidle0' })
  await dk.type('#f_name', 'Erg Chebbi Winter Raid (draft)')
  await dk.evaluate(() => { const d = new Date(Date.now() + 864e5); const f = x => { x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16) }
    document.getElementById('f_open').value = f(new Date(d)); document.getElementById('f_close').value = f(new Date(+d + 7 * 864e5)); document.getElementById('f_rb').value = f(new Date(d)) })
  await shot(dk, 'desktop_new_event')
  await dk.click('#create')
  await dk.waitForSelector('#s_put')
  await (await dk.$('#s_file')).uploadFile('/workspace/rallyraid/mod/rallyraid/stages/mar-merzouga-erg-chebbi.json')
  await (await dk.$('#s_rb')).uploadFile('/workspace/rallyraid/mod/rallyraid/roadbooks/mar-merzouga-erg-chebbi.roadbook.json')
  await dk.type('#s_name', 'SS1 Erg Chebbi')
  await dk.click('#s_put')
  await dk.waitForFunction(() => document.querySelector('.hash'))
  await shot(dk, 'desktop_draft_organizer')
  ok(await dk.$('#lock') != null, 'desktop: draft has the lock button')
  // admin page with a pending request
  const rq = await newPage(false)
  await login(rq, `wannabe_${Date.now()}@example.com`)
  await rq.goto(BASE + '/events/#/me', { waitUntil: 'networkidle0' })
  await rq.type('#why', 'I would like to run a Baja 500-style weekend raid.'); await rq.click('#ask')
  await rq.waitForFunction(() => document.body.textContent.includes('waiting for the admin'))
  await dk.goto(BASE + '/events/#/admin', { waitUntil: 'networkidle0' })
  await dk.waitForSelector('button.dec')
  await shot(dk, 'desktop_admin')
  // phone: review detail
  const ph2 = await newPage(true)
  await login(ph2, 'wyans@example.com')
  await ph2.goto(BASE + '/events/#/r/' + ST.results.dune, { waitUntil: 'networkidle0' })
  await ph2.waitForSelector('svg.trace'); await shot(ph2, 'phone_result_review')
  await ph2.goto(BASE + '/events/#/e/' + ST.ev.slug, { waitUntil: 'networkidle0' }); await ph2.waitForSelector('.lb'); await shot(ph2, 'phone_event_leaderboard')

  ok(errors.length === 0, 'no page errors ' + (errors.length ? JSON.stringify(errors.slice(0, 5)) : ''))
  await browser.close()
  console.log(fails ? fails + ' FAILED' : 'all ok')
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
