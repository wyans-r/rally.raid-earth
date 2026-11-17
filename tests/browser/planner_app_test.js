// The in-game Rally Raid Planner app outside the game (tests/planner_app_preview.html, a mock of rallyRaid/planner.lua):
// open with the bar, a new stage, drive it with REC on (DSS, a waypoint by the Ctrl+Shift+W key event, the ASS),
// select / edit / insert points, an offline roadbook (map servers blocked) from the route + driven heights, boxes at the
// car (notes, danger, symbols, tulip), SAVE + LOAD IN GAME, the draft, undo; then both directions with the website:
// the planner's files open in the real stage builder and roadbook editor (stage-builder/), and a website-made stage +
// roadbook opened and saved by the planner come back unchanged. Also a page without crypto.subtle (the app's SHA-256).
// Screenshot planner_app.png. NODE_PATH=/workspace/rr-tools/node_modules node tests/browser/planner_app_test.js
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path'), crypto = require('crypto')
const H = require('./rb_harness.js')
const ROOT = '/workspace/rallyraid'
const PC = require(ROOT + '/mod/ui/modules/apps/RallyRaidPlanner/planner-core.js')
const RB = require(ROOT + '/stage-builder/roadbook-gen.js')
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0])
  const f = u.startsWith('/ui/') ? path.join(ROOT, 'mod', u) : path.join(ROOT, u)
  if (!f.startsWith(ROOT)) { r.writeHead(403); return r.end() }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end() } else { r.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.json') ? 'application/json' : 'text/html' }); r.end(d) } })
}).listen(0, '127.0.0.1')
let fails = 0
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const drive = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/planner/ingame-test-stage.drive.json')).points
const MOAB = 'moab-sand-flats-ss1'
async function newPage(browser, query) {
  const page = await browser.newPage(); await page.setViewport({ width: 820, height: 680 })
  const errors = [], blocked = []
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.setRequestInterception(true)
  // no map servers: the planner must notice it is offline and still make a roadbook
  page.on('request', q => { if (/mapterhorn|overpass|osrm|arcgis|esa-worldcover|openstreetmap|elevation-tiles/.test(q.url())) { blocked.push(q.url()); return q.abort('internetdisconnected') } q.continue() })
  await page.goto('http://127.0.0.1:' + srv.address().port + '/tests/planner_app_preview.html' + (query || ''), { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.PlannerCore && window.RoadbookGen && window.RoadbookRender, { timeout: 20000 })
  await sleep(300)
  return { page, errors, blocked }
}
const D = page => page.evaluate(() => { const D = angular.element(document.querySelector('#a .rpl-host')).isolateScope()._D; return JSON.parse(JSON.stringify({ stage: D.stage && PlannerCore.exportStage(D.stage), rb: D.rb, drive: D.drive.length, dirty: D.dirty })) })
const ui = page => page.evaluate(() => { const s = angular.element(document.querySelector('#a .rpl-host')).isolateScope(); return JSON.parse(JSON.stringify({ ui: Object.assign({}, s.ui, { ask: s.ui.ask ? s.ui.ask.text : null }), v: s.v, busy: s.busy })) })
async function idle(page) { await page.waitForFunction(() => !angular.element(document.querySelector('#a .rpl-host')).isolateScope().busy, { timeout: 30000 }); await sleep(150) }
async function click(page, sel, text) {
  const ok = await page.evaluate((sel, text) => { const el = Array.from(document.querySelectorAll(sel)).find(e => e.offsetParent !== null && (!text || e.textContent.trim() === text)); if (!el) return false; el.click(); return true }, sel, text)
  if (!ok) throw new Error('no visible ' + sel + ' ' + (text || ''))
  await sleep(120)
}
const msg = page => page.$eval('#a .rpl-msg', e => e.textContent)

;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  let { page, errors, blocked } = await newPage(browser)
  // seed the "user folder" with a website-made stage + roadbook (the shipped Moab example)
  const moabSt = fs.readFileSync(ROOT + '/mod/rallyraid/stages/' + MOAB + '.json', 'utf8'), moabRb = fs.readFileSync(ROOT + '/mod/rallyraid/roadbooks/' + MOAB + '.roadbook.json', 'utf8')
  await page.evaluate((a, b, id) => { files['/rallyraid/stages/' + id + '.json'] = a; files['/rallyraid/roadbooks/' + id + '.roadbook.json'] = b }, moabSt, moabRb, MOAB)
  const calls0 = await page.evaluate(() => calls.slice())
  check(calls0.filter(c => c.includes("cmd('plannerAppHere')")).length === 2, 'each app tells Lua it is on the HUD')
  check(await page.$eval('#a .rpl-panel', e => getComputedStyle(e).display === 'none'), 'closed: only the bar')
  check(/PLANNER/.test(await page.$eval('#a .rpl-bar', e => e.textContent)) && !/Ctrl\+Shift/.test(await page.$eval('#a .rpl-bar', e => e.textContent)), 'bar: name, no default key')
  await click(page, '#a .rpl-bar')
  await sleep(200)
  check(await page.$eval('#a .rpl-panel', e => getComputedStyle(e).display !== 'none'), 'bar click -> plannerMenu -> open')
  check(/CAR 38\.56760, -109\.53139 \u00b7 1350 m \u00b7 CAP 040/.test(await page.$eval('#a .rpl-gps', e => e.textContent)), 'position line: ' + await page.$eval('#a .rpl-gps', e => e.textContent))

  // a new stage, driven ------------------------------------------------------------------------------------------
  await click(page, '#a .rpl-tabs .rpl-btn', 'FILES')
  await page.type('#a input[ng-model="ui.newName"]', 'Planner Browser Test')
  await click(page, '#a .rpl-btn', 'NEW STAGE'); await idle(page)
  check(/New stage "Planner Browser Test" \(planner-browser-test\)/.test(await msg(page)), 'new stage: ' + await msg(page))
  await click(page, '#a .rpl-tabs .rpl-btn', 'ROUTE')
  await page.evaluate(q => { car.lat = q[0]; car.lon = q[1]; car.alt = q[2] }, drive[0])
  await click(page, '#a .rpl-btn.rec'); await sleep(100)
  check(await page.evaluate(() => rec.on), 'REC on')
  await click(page, '#a .rpl-btn', 'ADD HERE'); await idle(page)
  check(/DSS added/.test(await msg(page)), 'ADD HERE: ' + await msg(page))
  for (let i = 1; i <= 120; i++) await page.evaluate(q => driveTo(q[0], q[1], q[2]), drive[i])
  await page.evaluate(() => key('waypoint')); await idle(page)
  check(/WPV 1 added \(leg: your driven line, 1\.2\d km\)/.test(await msg(page)), 'Ctrl+Shift+W event adds WPV 1 on the driven line: ' + await msg(page))
  for (let i = 121; i <= 270; i++) await page.evaluate(q => driveTo(q[0], q[1], q[2]), drive[i])
  await page.select('#a select[ng-model="ui.addType"]', 'string:WPM')
  await click(page, '#a .rpl-btn', 'ADD HERE'); await idle(page)
  for (let i = 271; i < drive.length; i++) await page.evaluate(q => driveTo(q[0], q[1], q[2]), drive[i])
  await page.select('#a select[ng-model="ui.addType"]', 'string:ASS')
  await click(page, '#a .rpl-btn', 'ADD HERE'); await idle(page)
  let d = await D(page)
  check(JSON.stringify(d.stage.waypoints.map(w => w.type)) === '["DSS","WPV","WPM","ASS"]', 'types: ' + d.stage.waypoints.map(w => w.type))
  check(d.stage.route.legs.every(l => l.mode === 'track') && Math.abs(d.stage.lengthKm - 3.5) < 0.05, 'driven legs, 3.5 km: ' + d.stage.lengthKm)
  check(d.drive > 340, 'heights kept for the offline roadbook: ' + d.drive)
  const rows = await page.$$eval('#a .rpl-list .rpl-item:not(.rpl-file)', e => e.map(x => x.textContent.replace(/\s+/g, ' ').trim()))
  check(rows.length === 4 && /^DSS\s*0\.00/.test(rows[0]) && /^ASS\s*3\.5\d\s*DRIVEN/.test(rows[3]), 'route list: ' + rows.join(' | '))
  check(await page.$$eval('#a .rpl-probs div', e => e.length) === 0, 'no problems')
  check(await page.$$eval('#a .rpl-svg polyline', e => e.length) === 3 && await page.$$eval('#a .rpl-svg circle', e => e.length) === 4, 'map: 3 legs, 4 points, the car')
  // select a row (the selection lives on the parent scope's ui object, not the ng-repeat row's scope)
  await page.evaluate(() => document.querySelectorAll('#a .rpl-list .rpl-item:not(.rpl-file)')[1].click()); await sleep(150)
  check((await page.$$eval('#a .rpl-list .rpl-item.sel:not(.rpl-file)', e => e.length)) === 1 && (await ui(page)).ui.sel === 1, 'row 2 selected (one row)')
  await page.evaluate(() => document.querySelectorAll('#a .rpl-list .rpl-item:not(.rpl-file)')[2].click()); await sleep(150)
  check((await page.$$eval('#a .rpl-list .rpl-item.sel:not(.rpl-file)', e => e.length)) === 1 && (await ui(page)).ui.sel === 2, 'another row: still one selected')
  await page.evaluate(() => { const i = document.querySelector('#a input[ng-model="ui.pt.name"]'); i.value = 'Old well'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('blur')) }); await sleep(150)
  check((await D(page)).stage.waypoints[2].name === 'Old well', 'name edited on the selected point')
  // insert a point on leg 2 where the car is (drive back onto the hill)
  await page.evaluate(q => { car.lat = q[0]; car.lon = q[1] }, drive[200])
  await page.select('#a select[ng-model="ui.addType"]', 'string:WPE')
  await click(page, '#a .rpl-btn', 'INSERT HERE'); await idle(page)
  d = await D(page)
  check(JSON.stringify(d.stage.waypoints.map(w => w.type)) === '["DSS","WPV","WPE","WPM","ASS"]' && /WPE 2 inserted/.test(await msg(page)), 'INSERT HERE: ' + await msg(page))
  check(d.stage.route.legs.every(l => l.mode === 'track'), 'the split legs keep the driven line')
  await click(page, '#a .rpl-btn', 'UNDO'); await sleep(150)
  check((await D(page)).stage.waypoints.length === 4, 'UNDO takes the insert back')

  // roadbook, offline ----------------------------------------------------------------------------------------------
  await page.evaluate(q => { car.lat = q[0]; car.lon = q[1] }, drive[160])
  await click(page, '#a .rpl-tabs .rpl-btn', 'ROADBOOK'); await sleep(300)
  await page.select('#a select[ng-model="ui.density"]', 'number:10')
  await click(page, '#a .rpl-btn', 'GENERATE'); await idle(page)
  check(/internet: no/.test(await page.$eval('#a .rpl-panel', e => e.textContent)), 'no internet noticed')
  check(/Roadbook made: \d+ boxes\. Offline: from the route and the heights you drove/.test(await msg(page)), 'offline roadbook: ' + await msg(page))
  d = await D(page)
  check(d.rb && d.rb.partial === 'driven-heights' && d.rb.boxes.some(b => (b.features || []).some(f => /climb|descent|crest/.test(f.kind))), 'the hill is in the roadbook (from the driven heights)')
  check(d.rb.stage.hash === await RB.stageHash(d.stage), 'roadbook stage hash = the stage\'s (node crypto)')
  check(await page.$eval('#a .rpl-boxview', e => e.offsetParent !== null && !!e.querySelector('svg')), 'the box shows with its tulip')
  const nBefore = d.rb.boxes.filter(b => !b.deleted).length
  await page.evaluate(() => key('box')); await idle(page)
  check(/Box \d+ added at 1\.6\d km/.test(await msg(page)), 'Ctrl+Shift+B event: a box at the car: ' + await msg(page))
  await page.evaluate(() => { const i = document.querySelector('#a input[ng-model="ui.box.notes"]'); i.value = 'gate, close it'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('blur')) }); await sleep(150)
  await click(page, '#a .rpl-edit .rpl-btn', '!!'); await sleep(100)
  await click(page, '#a .rpl-grps .rpl-btn', 'QUICK')
  await page.evaluate(() => document.querySelector('#a .rpl-sym[data-c="gate"]').click()); await sleep(150)
  await click(page, '#a .rpl-edit .rpl-btn', '45\u21b7'); await sleep(100)
  d = await D(page)
  let nb = d.rb.boxes.filter(b => b.notes === 'GATE, CLOSE IT')
  check(nb.length === 1 && nb[0].danger === 2 && nb[0].symbols.includes('gate') && nb[0].pinned && nb[0].source === 'editor', 'box edited: notes (upper case), !!, gate symbol, pinned editor box')
  check(nb[0].history.length >= 5 && nb[0].history.every(h => h.note === 'in-game planner'), 'every edit in the box history')
  check(d.rb.boxes.filter(b => !b.deleted).length === nBefore + 1, 'one more box')
  check(await page.$eval('#a .rpl-sym[data-c="gate"]', e => e.classList.contains('on')), 'symbol picker shows gate on')
  await page.screenshot({ path: ROOT + '/planner_app.png', clip: { x: 0, y: 0, width: 460, height: 660 } })

  // save + load in game ---------------------------------------------------------------------------------------------
  await click(page, '#a .rpl-tabs .rpl-btn', 'FILES'); await sleep(200)
  await click(page, '#a .rpl-btn', 'SAVE + LOAD IN GAME'); await idle(page)
  check(/Saved stage \/rallyraid\/stages\/planner-browser-test\.json \+ roadbook\. Loaded in the rally computer, car at the start/.test(await msg(page)), 'save + load: ' + await msg(page))
  const saved = await page.evaluate(() => ({ st: files['/rallyraid/stages/planner-browser-test.json'], rb: files['/rallyraid/roadbooks/planner-browser-test.roadbook.json'], dr: files['/rallyraid/planner/drive/planner-browser-test.drive.json'], loads: loads.slice() }))
  check(saved.st && saved.rb && saved.dr && saved.loads.length === 1 && saved.loads[0].teleport === true, 'stage, roadbook and drive written; load + teleport asked')
  check(/^\{\n "format": "rallyraid-stage"/.test(saved.st), 'the stage file is pretty JSON like the builder\'s')
  // a running stage: asked first
  await page.evaluate(() => { P.game.phase = 'running' })
  await click(page, '#a .rpl-btn', 'SAVE + LOAD IN GAME'); await sleep(600)
  check(/A stage is running/.test((await ui(page)).ui.ask || ''), 'running stage: asks before replacing it')
  await click(page, '#a .rpl-ask .rpl-btn', 'LOAD'); await idle(page)
  check((await page.evaluate(() => loads.filter(l => l.force).length)) === 1, 'LOAD: forced')
  check((await page.evaluate(() => loads.filter(l => l.reload).length)) >= 1, 'the game\'s loaded stage got its roadbook reloaded')
  // draft autosave after an edit
  await click(page, '#a .rpl-tabs .rpl-btn', 'ROUTE')
  await page.evaluate(() => document.querySelectorAll('#a .rpl-list .rpl-item:not(.rpl-file)')[1].click()); await sleep(100)
  await page.evaluate(q => { car.lat = q[0] + 0.0002; car.lon = q[1] }, drive[120])
  await click(page, '#a .rpl-btn', 'MOVE HERE'); await idle(page)
  check(/Moved 2\d m/.test(await msg(page)), 'MOVE HERE: ' + await msg(page))
  check(/\*$/.test(await page.$eval('#a .rpl-bar .nm', e => e.textContent)), 'unsaved mark on the bar')
  await sleep(4600)
  const draft = await page.evaluate(() => files['/rallyraid/planner/drafts/planner-browser-test.draft.json'])
  check(draft && JSON.parse(draft).format === 'rallyraid-planner-draft', 'draft written 4 s after the change')

  // the website reads what the planner wrote --------------------------------------------------------------------------
  const tmp = '/tmp/planner-browser-test'; fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(tmp + '/planner-browser-test.json', saved.st); fs.writeFileSync(tmp + '/planner-browser-test.roadbook.json', saved.rb)
  const site = await H.serve()
  const W = await H.launch({ offline: true })
  W.page.on('dialog', x => x.accept())
  await W.page.goto(site.url + '/index.html', { waitUntil: 'networkidle2' })
  await (await W.page.$('#f-import')).uploadFile(tmp + '/planner-browser-test.json'); await sleep(1500)
  const b = await W.page.evaluate(() => { const o = exportStage(); return { types: o.waypoints.map(w => w.type), km: o.lengthKm, modes: o.route.legs.map(l => l.mode), pts: o.route.legs.map(l => l.points.length), name: o.name } })
  const sj = JSON.parse(saved.st)
  check(JSON.stringify(b.types) === JSON.stringify(sj.waypoints.map(w => w.type)) && Math.abs(b.km - sj.lengthKm) < 0.001 && JSON.stringify(b.modes) === JSON.stringify(sj.route.legs.map(l => l.mode)) && JSON.stringify(b.pts) === JSON.stringify(sj.route.legs.map(l => l.points.length)),
    'the website builder imports the planner\'s stage unchanged: ' + JSON.stringify(b).slice(0, 120))
  await W.page.goto(site.url + '/roadbook.html', { waitUntil: 'networkidle2' })
  await (await W.page.$('#in-stage')).uploadFile(tmp + '/planner-browser-test.json')
  await H.waitFor(W.page, () => window.RoadbookEditor && RoadbookEditor.E.stage, null, 15000)
  await (await W.page.$('#in-rb')).uploadFile(tmp + '/planner-browser-test.roadbook.json')
  await H.waitFor(W.page, () => RoadbookEditor.E.rb, null, 15000); await sleep(500)
  const e = await W.page.evaluate(() => ({ n: RoadbookEditor.E.rb.boxes.filter(b => !b.deleted).length, hashOk: RoadbookEditor.E.rb.stage.hash === RoadbookEditor.E.stageHash, rows: document.querySelectorAll('#list .row').length, gate: RoadbookEditor.E.rb.boxes.some(b => b.notes === 'GATE, CLOSE IT') }))
  const srb = JSON.parse(saved.rb)
  check(e.n === srb.boxes.filter(x => !x.deleted).length && e.rows === e.n && e.gate, 'the website roadbook editor opens the planner\'s roadbook (' + e.n + ' boxes, the edited box there)')
  check(e.hashOk, 'the editor sees it belongs to this stage (same stage hash, no "stage changed" warning)')
  check(W.stats.errors.length === 0, 'website: no errors: ' + JSON.stringify(W.stats.errors).slice(0, 200))
  await W.browser.close(); site.close()

  // the planner reads what the website wrote and saves it back unchanged -----------------------------------------------
  await click(page, '#a .rpl-tabs .rpl-btn', 'FILES'); await sleep(400)
  await page.evaluate(id => { const it = Array.from(document.querySelectorAll('#a .rpl-file')).find(x => x.textContent.includes('Moab')); it.querySelector('.rpl-btn').click() }, MOAB); await sleep(400)
  if ((await ui(page)).ui.ask) await click(page, '#a .rpl-ask .rpl-btn', 'OPEN')
  await idle(page)
  check(/Opened SS1 Moab Sand Flats \(sample\) with its roadbook \(\d+ boxes\)/.test(await msg(page)), 'opened a website stage + roadbook: ' + await msg(page))
  await click(page, '#a .rpl-tabs .rpl-btn', 'FILES'); await sleep(200)
  const nCalls = await page.evaluate(() => calls.length)
  await click(page, '#a .rpl-btn', 'SAVE'); await idle(page)
  const chunks = await page.evaluate(n => calls.slice(n).filter(c => /plannerCall\('writeChunk'/.test(c)).length, nCalls)
  check(chunks >= 3 && moabRb.length > CHUNK_MIN, 'a big file goes to the game in pieces (' + chunks + ' pieces for ' + moabRb.length + ' + ' + moabSt.length + ' chars)')
  const back = await page.evaluate(id => ({ st: files['/rallyraid/stages/' + id + '.json'], rb: files['/rallyraid/roadbooks/' + id + '.roadbook.json'] }), MOAB)
  const o1 = JSON.parse(moabSt), o2 = JSON.parse(back.st), r1 = JSON.parse(moabRb), r2 = JSON.parse(back.rb)
  ;['generator', 'modified'].forEach(k => { delete o1[k]; delete o2[k] }); delete r1.modified; delete r2.modified
  check(JSON.stringify(o1) === JSON.stringify(o2), 'website stage -> planner -> saved: the same stage')
  check(JSON.stringify(r1) === JSON.stringify(r2), 'website roadbook -> planner -> saved: the same roadbook')
  check(errors.length === 0, 'planner: no console errors: ' + JSON.stringify(errors).slice(0, 300))
  check(blocked.some(u => /mapterhorn/.test(u)), 'it did try the map servers (blocked here)')
  await page.close()

  // a page without crypto.subtle: the app's own SHA-256 gives the same stage hash ----------------------------------------
  ;({ page, errors } = await newPage(browser, '?nosubtle=1'))
  check(await page.evaluate(() => window.__rplCrypto) === 'shim', 'no crypto.subtle: the shim is installed')
  const st = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/planner/ingame-test-stage.json'))
  const h = await page.evaluate(s => RoadbookGen.stageHash(s), st)
  check(h === await RB.stageHash(st), 'stage hash with the shim = node\'s: ' + h.slice(0, 20))
  check(errors.length === 0, 'no console errors (shim page)')
  console.log(fails ? fails + ' FAILED' : 'ALL PASS')
  await browser.close(); srv.close()
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
const CHUNK_MIN = 30000
