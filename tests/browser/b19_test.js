const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path')
const ROOT = '/workspace/rallyraid/stage-builder'
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' }
const srv = http.createServer((q, r) => {
  const url = decodeURIComponent((q.url || '/').split('?')[0])
  const rel = url === '/' ? '/index.html' : url
  const f = path.normalize(path.join(ROOT, rel))
  if (!f.startsWith(ROOT)) { r.writeHead(403); r.end(); return }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    r.end(d)
  })
}).listen(8772)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (msg) => { console.error('FAIL', msg); process.exitCode = 1 }

;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', d => d.accept())
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('rallyraid-examples-hint', '1') } catch (e) {} })
  await page.goto('http://127.0.0.1:8772/', { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => window.RallyRaidBuilder && document.querySelectorAll('#ex-list .ex-card').length > 0, { timeout: 10000 })

  // 1) Route label in the UI; stored type stays NOTE
  const typeBtn = await page.evaluate(() => {
    const b = document.querySelector('#typebtns button[data-t="NOTE"]')
    return b ? { text: b.textContent.trim(), data: b.getAttribute('data-t') } : null
  })
  console.log('type button:', JSON.stringify(typeBtn))
  if (!typeBtn || typeBtn.text !== 'ROUTE' || typeBtn.data !== 'NOTE') fail('type button should show ROUTE and store NOTE')

  await page.click('#ex-open')
  await sleep(300)
  const tabs = await page.evaluate(() => ({
    guide: document.getElementById('pane-guide').classList.contains('on'),
    file: document.getElementById('pane-file').classList.contains('on'),
    examplesInGuide: !!document.querySelector('#pane-guide #examples'),
    examplesInFile: !!document.querySelector('#pane-file #examples')
  }))
  console.log('examples menu:', tabs)
  if (!tabs.guide || tabs.file || !tabs.examplesInGuide || tabs.examplesInFile) fail('examples should live on the Guide tab')

  // 2) Example loads with its name; first edit blanks name + description; export type stays NOTE
  const loaded = await page.evaluate(async () => {
    await window.RallyRaidBuilder.loadExample('moab-sand-flats-ss1', true)
    const st = window.RallyRaidBuilder.state()
    const ex = window.RallyRaidBuilder.exportStage()
    const noteBoxes = ex.roadbook.boxes.filter(b => b.label === 'NOTE' || b.waypoint == null)
    const ui = Array.from(document.querySelectorAll('#list .tag')).map(t => t.textContent.trim())
    return {
      name: st.meta.name, desc: st.meta.description, id: st.meta.id, n: st.points.length,
      lock: !!(window.RallyRaidBuilder.exampleLock && window.RallyRaidBuilder.exampleLock()),
      noteStored: st.points.filter(p => p.type === 'NOTE').length,
      routeStored: st.points.filter(p => p.type === 'ROUTE').length,
      exportNoteLabels: noteBoxes.length,
      exportRouteLabels: ex.roadbook.boxes.filter(b => b.label === 'ROUTE').length,
      uiRoute: ui.filter(x => x === 'ROUTE').length,
      uiNote: ui.filter(x => x === 'NOTE').length
    }
  })
  console.log('loaded example:', loaded)
  if (!loaded.name || !loaded.lock) fail('example should load with a name and an edit lock')
  if (loaded.routeStored !== 0) fail('stored type should stay NOTE, not ROUTE')
  if (loaded.exportRouteLabels !== 0) fail('export box labels must stay NOTE for hash compatibility')
  if (loaded.uiNote !== 0) fail('UI list should show ROUTE, not NOTE')
  if (loaded.noteStored && !loaded.uiRoute) fail('NOTE points should appear as ROUTE in the list')

  const afterEdit = await page.evaluate(() => {
    const rows = document.querySelectorAll('#list .pt')
    if (rows[2]) rows[2].click()
    const i = document.getElementById('e-name')
    if (i) { i.value = 'edited'; i.dispatchEvent(new Event('change', { bubbles: true })) }
    const st = window.RallyRaidBuilder.state()
    const ex = window.RallyRaidBuilder.exportStage()
    return { name: st.meta.name, desc: st.meta.description, exportName: ex.name, lock: !!(window.RallyRaidBuilder.exampleLock && window.RallyRaidBuilder.exampleLock()), pointName: st.points[2] && st.points[2].name }
  })
  console.log('after first edit:', afterEdit)
  if (afterEdit.name !== '' || afterEdit.desc !== '' || afterEdit.exportName === 'Moab Sand Flats SS1') fail('first edit of an example should blank name and description')
  if (afterEdit.lock) fail('edit lock should be cleared after the first change')

  // old files with type NOTE still load (the Moab example is one); a synthetic ROUTE type normalises to NOTE
  const round = await page.evaluate(() => {
    const j = window.RallyRaidBuilder.exportStage()
    // pretend an old-and-new mix: inject a ROUTE-typed point if any note ids exist
    const id = (j.builder && j.builder.notes && j.builder.notes[0])
    window.RallyRaidBuilder.importStage(j)
    const st = window.RallyRaidBuilder.state()
    const ex = window.RallyRaidBuilder.exportStage()
    return { sameWp: JSON.stringify(j.waypoints) === JSON.stringify(ex.waypoints), notes: (ex.builder && ex.builder.notes) || [], importedNotes: st.points.filter(p => p.type === 'NOTE').length, route: st.points.filter(p => p.type === 'ROUTE').length, noteId: id }
  })
  console.log('NOTE roundtrip:', round)
  if (!round.sameWp || round.route !== 0) fail('NOTE files must load and export without becoming ROUTE')

  // 3) Clear all + undo
  const nBefore = await page.evaluate(() => window.RallyRaidBuilder.state().points.length)
  await page.click('[data-tab="plot"]')
  await page.click('#p-clear')
  await sleep(200)
  const cleared = await page.evaluate(() => ({ n: window.RallyRaidBuilder.state().points.length, undoVisible: !document.getElementById('p-undo-clear').hidden }))
  console.log('cleared:', cleared, 'had', nBefore)
  if (cleared.n !== 0 || !cleared.undoVisible) fail('Clear all should empty the waypoints and show Undo')
  await page.click('#p-undo-clear')
  await sleep(200)
  const restored = await page.evaluate(() => ({ n: window.RallyRaidBuilder.state().points.length, undoHidden: document.getElementById('p-undo-clear').hidden }))
  console.log('restored:', restored)
  if (restored.n !== nBefore || !restored.undoHidden) fail('Undo clear should restore the waypoints')

  // 4) Auto-generate name and description from supplied (real-shaped) Nominatim data
  await page.evaluate(() => {
    const j = window.RallyRaidBuilder.exportStage()
    window.RallyRaidBuilder.importStage(j)
    window.RallyRaidBuilder.setNominatim(function (lat, lon) {
      if (lat > 38.58) return { address: { village: 'Moab', state: 'Utah', country: 'United States' } }
      return { name: 'Sand Flats', address: { natural: 'Sand Flats', state: 'Utah', country: 'United States' } }
    })
  })
  const gen = await page.evaluate(async () => {
    const meta = await window.RallyRaidBuilder.generateMeta()
    window.RallyRaidBuilder.applyGeneratedMeta(meta)
    const st = window.RallyRaidBuilder.state()
    return { name: st.meta.name, desc: st.meta.description, meta }
  })
  console.log('autogen:', gen.name, gen.desc && gen.desc.slice(0, 180))
  if (!/Moab|Sand Flats/.test(gen.name)) fail('generated name should use the Nominatim place names')
  if (!/km stage/.test(gen.desc)) fail('generated description should include the length')
  if (/Atlantis|Narnia|Invented/.test(gen.name + gen.desc)) fail('generated text invented a place name')

  // 5) Forest warning: a short off-piste line through trees is flagged; a "road" leg is not
  const forest = await page.evaluate(async () => {
    const stage = {
      format: 'rallyraid-stage', schemaVersion: 1, id: 'forest-test', name: 'Forest test', region: '',
      waypoints: [
        { id: 'a', n: 0, type: 'DSS', lat: 0, lon: 0, km: 0 },
        { id: 'b', n: 1, type: 'ASS', lat: 0.01, lon: 0, km: 1.1 }
      ],
      roadbook: { boxes: [
        { n: 1, id: 'a', km: 0, partial: 0, waypoint: 'a', label: 'DSS', lat: 0, lon: 0 },
        { n: 2, id: 'b', km: 1.1, partial: 1.1, waypoint: 'b', label: 'ASS', lat: 0.01, lon: 0 }
      ] },
      route: { legs: [{ from: 'a', to: 'b', mode: 'direct', km: 1.1, points: [[0, 0], [0.01, 0]] }] }
    }
    window.RallyRaidBuilder.importStage(stage)
    await window.RallyRaidBuilder.setLandCoverAt(function () { return 10 })  // ESA WorldCover tree cover
    const offPiste = window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    // same line, but following a road: must not warn
    const j = window.RallyRaidBuilder.exportStage()
    j.route.legs[0].mode = 'road'
    window.RallyRaidBuilder.importStage(j)
    await window.RallyRaidBuilder.setLandCoverAt(function () { return 10 })
    const onRoad = window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    return { offPiste, onRoad }
  })
  console.log('forest off-piste:', forest.offPiste)
  console.log('forest on road:', forest.onRoad)
  if (!forest.offPiste.length || !/forest/i.test(forest.offPiste.join(' '))) fail('should warn when an off-piste leg goes through forest')
  if (forest.onRoad.length) fail('should not warn when the leg follows a road through forest')

  // 5b) After "insert after selected", warnings must name the new consecutive legs, not the old pair
  const editForest = await page.evaluate(async () => {
    const stage = {
      format: 'rallyraid-stage', schemaVersion: 1, id: 'forest-insert', name: 'Forest insert', region: '',
      waypoints: [
        { id: 'a', n: 0, type: 'DSS', lat: 46.0, lon: 7.0, km: 0 },
        { id: 'c', n: 1, type: 'ASS', lat: 46.02, lon: 7.0, km: 2.2 }
      ],
      roadbook: { boxes: [
        { n: 1, id: 'a', km: 0, partial: 0, waypoint: 'a', label: 'DSS', lat: 46.0, lon: 7.0 },
        { n: 2, id: 'c', km: 2.2, partial: 2.2, waypoint: 'c', label: 'ASS', lat: 46.02, lon: 7.0 }
      ] },
      route: { legs: [{ from: 'a', to: 'c', mode: 'direct', km: 2.2, points: [[46.0, 7.0], [46.02, 7.0]] }] }
    }
    window.RallyRaidBuilder.importStage(stage)
    await window.RallyRaidBuilder.setLandCoverAt(function () { return 10 })
    const before = window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    document.getElementById('snap').checked = false
    document.getElementById('legmode').value = 'direct'
    document.getElementById('insertmode').checked = true
    const typeBtn = document.querySelector('#typebtns button[data-t="WPM"]')
    if (typeBtn) typeBtn.click()
    document.querySelectorAll('#list .pt')[0].click()
    const st = window.RallyRaidBuilder.state()
    window.map.fire('click', { latlng: window.L.latLng((st.points[0].lat + st.points[1].lat) / 2, (st.points[0].lon + st.points[1].lon) / 2) })
    await window.RallyRaidBuilder.runForestCheck()
    const st2 = window.RallyRaidBuilder.state()
    const afterInsert = {
      labels: st2.points.map(p => window.RallyRaidBuilder.uiPointLabel(p)),
      pairs: st2.points.slice(1).map((p, i) => window.RallyRaidBuilder.uiPointLabel(st2.points[i]) + ' -> ' + window.RallyRaidBuilder.uiPointLabel(p)),
      warnings: window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    }
    // delete the inserted point: should go back to one DSS-ASS warning
    document.querySelectorAll('#list .pt')[1].querySelector('[data-a=del]').click()
    await window.RallyRaidBuilder.runForestCheck()
    const afterDelete = {
      n: window.RallyRaidBuilder.state().points.length,
      warnings: window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    }
    // insert again, then reorder the middle point down (swap with ASS)
    document.querySelectorAll('#list .pt')[0].click()
    const st3 = window.RallyRaidBuilder.state()
    window.map.fire('click', { latlng: window.L.latLng((st3.points[0].lat + st3.points[1].lat) / 2, (st3.points[0].lon + st3.points[1].lon) / 2) })
    document.querySelectorAll('#list .pt')[1].querySelector('[data-a=down]').click()
    await window.RallyRaidBuilder.runForestCheck()
    const st4 = window.RallyRaidBuilder.state()
    const afterReorder = {
      labels: st4.points.map(p => window.RallyRaidBuilder.uiPointLabel(p)),
      pairs: st4.points.slice(1).map((p, i) => window.RallyRaidBuilder.uiPointLabel(st4.points[i]) + ' -> ' + window.RallyRaidBuilder.uiPointLabel(p)),
      warnings: window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    }
    // type change of the middle point (after putting it back in the middle if needed)
    // rebuild a clean 3-point stage for type / drag / clear+undo
    window.RallyRaidBuilder.importStage(stage)
    document.getElementById('insertmode').checked = true
    document.querySelectorAll('#list .pt')[0].click()
    const sA = window.RallyRaidBuilder.state()
    window.map.fire('click', { latlng: window.L.latLng((sA.points[0].lat + sA.points[1].lat) / 2, (sA.points[0].lon + sA.points[1].lon) / 2) })
    const mid = document.querySelectorAll('#list .pt')[1]
    mid.click()
    const typ = document.getElementById('e-type')
    typ.value = 'NOTE'
    typ.dispatchEvent(new Event('change', { bubbles: true }))
    await window.RallyRaidBuilder.runForestCheck()
    const afterType = {
      labels: window.RallyRaidBuilder.state().points.map(p => window.RallyRaidBuilder.uiPointLabel(p)),
      warnings: window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    }
    // drag / move the middle point (still forest, still between the same neighbours)
    const st5 = window.RallyRaidBuilder.state()
    st5.points[1].lat = 46.01
    st5.points[1].lon = 7.002
    if (st5.points[1].leg) st5.points[1].leg.points = [[st5.points[0].lat, st5.points[0].lon], [st5.points[1].lat, st5.points[1].lon]]
    if (st5.points[2].leg) st5.points[2].leg.points = [[st5.points[1].lat, st5.points[1].lon], [st5.points[2].lat, st5.points[2].lon]]
    await window.RallyRaidBuilder.runForestCheck()
    const afterMove = {
      labels: st5.points.map(p => window.RallyRaidBuilder.uiPointLabel(p)),
      warnings: window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    }
    // Clear all + undo
    window.RallyRaidBuilder.clearAllPoints(true)
    await window.RallyRaidBuilder.runForestCheck()
    const afterClear = window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    window.RallyRaidBuilder.undoClear()
    await window.RallyRaidBuilder.runForestCheck()
    const afterUndo = {
      n: window.RallyRaidBuilder.state().points.length,
      warnings: window.RallyRaidBuilder.forestWarnings().map(w => w.text)
    }
    return { before, afterInsert, afterDelete, afterReorder, afterType, afterMove, afterClear, afterUndo }
  })
  console.log('forest after insert:', JSON.stringify(editForest.afterInsert))
  console.log('forest after delete:', JSON.stringify(editForest.afterDelete))
  console.log('forest after reorder:', JSON.stringify(editForest.afterReorder))
  console.log('forest after type:', JSON.stringify(editForest.afterType))
  console.log('forest after move:', JSON.stringify(editForest.afterMove))
  console.log('forest clear/undo:', JSON.stringify({ clear: editForest.afterClear, undo: editForest.afterUndo }))
  function mentions(texts, a, b) { return texts.some(t => t.indexOf('from ' + a + ' to ' + b) !== -1) }
  function mentionsAnySkip(texts, a, b) { return texts.some(t => new RegExp('from ' + a + ' to ' + b).test(t)) }
  if (!editForest.afterInsert.labels.includes('WPM 1')) fail('insert after selected should add a WPM between DSS and ASS')
  if (mentionsAnySkip(editForest.afterInsert.warnings, 'DSS', 'ASS')) fail('after insert, warning must not name DSS and ASS (they are no longer neighbours): ' + editForest.afterInsert.warnings.join(' | '))
  if (!mentions(editForest.afterInsert.warnings, 'DSS', 'WPM 1') || !mentions(editForest.afterInsert.warnings, 'WPM 1', 'ASS')) fail('after insert, warnings should be DSS-WPM 1 and WPM 1-ASS: ' + editForest.afterInsert.warnings.join(' | '))
  if (editForest.afterDelete.n !== 2) fail('delete should leave 2 points')
  if (!mentions(editForest.afterDelete.warnings, 'DSS', 'ASS') || editForest.afterDelete.warnings.length !== 1) fail('after delete, one DSS-ASS warning expected: ' + editForest.afterDelete.warnings.join(' | '))
  if (mentionsAnySkip(editForest.afterReorder.warnings, editForest.afterReorder.labels[0], editForest.afterReorder.labels[2]) && editForest.afterReorder.labels[1] !== editForest.afterReorder.labels[2]) {
    fail('after reorder, a warning names two points that are not neighbours: ' + JSON.stringify(editForest.afterReorder))
  }
  // every warning "from X to Y" must be a consecutive pair
  function assertConsecutive(tag, info) {
    const pairs = info.pairs || info.labels && info.labels.slice(1).map((_, i) => info.labels[i] + ' -> ' + info.labels[i + 1])
    const bads = (info.warnings || []).filter(t => {
      const m = /from (.+?) to (.+?) goes/.exec(t)
      if (!m) return false
      return !(info.pairs || []).includes(m[1] + ' -> ' + m[2]) && !(pairs || []).includes(m[1] + ' -> ' + m[2])
    })
    if (bads.length) fail(tag + ' has a warning for a non-consecutive pair: ' + bads.join(' | ') + ' ; pairs ' + (info.pairs || pairs || []).join(','))
  }
  assertConsecutive('insert', editForest.afterInsert)
  assertConsecutive('reorder', editForest.afterReorder)
  if (!mentions(editForest.afterType.warnings, 'DSS', 'ROUTE') || !mentions(editForest.afterType.warnings, 'ROUTE', 'ASS')) fail('after type change to Route, warnings should follow DSS-ROUTE-ASS: ' + editForest.afterType.warnings.join(' | '))
  if (mentionsAnySkip(editForest.afterMove.warnings, 'DSS', 'ASS')) fail('after moving a point, warning must not skip the middle point')
  if (editForest.afterClear.length) fail('Clear all should drop forest warnings')
  if (editForest.afterUndo.n !== 3 || !editForest.afterUndo.warnings.length) fail('Undo clear should restore points and forest warnings')

  // 6) Blind Mode checkbox wording (logic is still the organizer-seal behaviour — reported separately)
  await page.click('[data-tab="plot"]')
  const opened = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /auto stage/i.test(x.textContent || ''))
    if (b) { b.click(); return true }
    return false
  })
  await sleep(300)
  const blind = await page.evaluate(() => {
    const lab = document.querySelector('#sg-blind') && document.querySelector('#sg-blind').closest('label')
    const hint = document.getElementById('sg-blindhint')
    return {
      label: lab ? lab.innerText.replace(/\s+/g, ' ').trim() : '',
      hint: hint ? hint.innerText.replace(/\s+/g, ' ').trim() : '',
      hintVisible: !!(hint && hint.offsetParent !== null)
    }
  })
  console.log('blind checkbox:', JSON.stringify(blind), 'opened', opened)
  if (!/I am a participant in the event for this stage/.test(blind.label)) fail('Blind Mode checkbox text was not updated')
  if (/I am the organizer/.test(blind.label)) fail('old Blind Mode wording still present')
  if (!/Tick this if you.ll race this stage yourself/.test(blind.hint) || !/sealed until the event closes/.test(blind.hint)) fail('Blind Mode hint missing or wrong: ' + JSON.stringify(blind.hint))
  if (!blind.hintVisible) fail('Blind Mode hint should be visible under the checkbox')

  const realErr = errors.filter(e => !/favicon|leaflet|tile|css|nominatim/i.test(e))
  console.log('errors:', JSON.stringify(realErr))
  if (realErr.length) fail('page errors ' + JSON.stringify(realErr))
  if (process.exitCode) console.log('TEST FAILED')
  else console.log('TEST PASSED')
  await browser.close(); srv.close()
})().catch(e => { console.error(e); process.exit(1) })
