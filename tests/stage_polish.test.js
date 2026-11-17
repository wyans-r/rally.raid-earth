const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
require(path.join(__dirname, '../stage-builder/stage-polish.js'))
const P = global.RallyRaidPolish

test('NOTE stays the stored type; ROUTE is the display label', () => {
  assert.equal(P.isNoteType('NOTE'), true)
  assert.equal(P.isNoteType('ROUTE'), true)
  assert.equal(P.isNoteType('WPM'), false)
  assert.equal(P.storedType('ROUTE'), 'NOTE')
  assert.equal(P.storedType('note'), 'NOTE')
  assert.equal(P.storedType('WPM'), 'WPM')
  assert.equal(P.uiTypeLabel('NOTE'), 'ROUTE')
  assert.equal(P.uiTypeLabel('ROUTE'), 'ROUTE')
  assert.equal(P.uiTypeLabel('WPM'), 'WPM')
  assert.equal(P.uiPointLabel({ type: 'NOTE' }), 'ROUTE')
  assert.equal(P.uiPointLabel({ type: 'WPM', _n: 3 }), 'WPM 3')
})

test('name uses only real place names, start-to-end when they differ', () => {
  const start = P.placeFromNominatim({ address: { village: 'Merzouga', state: 'Drâa-Tafilalet', country: 'Morocco' } })
  const end = P.placeFromNominatim({ name: 'Erg Chebbi', address: { natural: 'Erg Chebbi', country: 'Morocco' } })
  assert.equal(start.name, 'Merzouga')
  assert.equal(end.name || end.feature, 'Erg Chebbi')
  assert.equal(P.composeName({ start, end }), 'Merzouga to Erg Chebbi')
  assert.equal(P.composeName({ start, end: start }), 'Merzouga')
  assert.equal(P.composeName({ region: 'Moab, Utah, USA' }), 'Moab')
  assert.equal(P.composeName({}), '')
  // never invent a name that was not supplied
  const meta = P.composeMeta({ start, end, lengthKm: 24.2, region: 'Erg Chebbi, Morocco', legs: [{ mode: 'direct', km: 24.2 }] })
  assert.equal(meta.name, 'Merzouga to Erg Chebbi')
  assert.match(meta.description, /24(?:\.2)? km stage in Erg Chebbi, Morocco/)
  assert.match(meta.description, /Merzouga/)
  assert.match(meta.description, /Erg Chebbi/)
  assert.doesNotMatch(meta.description, /Atlantis|Narnia|SS1(?!\S)/)
})

test('description mentions surface mix and land cover in plain words', () => {
  const d = P.composeDescription({
    lengthKm: 41,
    region: 'Namibia',
    start: { name: 'Sesfontein' },
    end: { name: 'Amspoort' },
    legs: [{ mode: 'track', km: 30 }, { mode: 'direct', km: 11 }],
    coverMix: { bare: 60, bush: 30, trees: 10 }
  })
  assert.match(d, /41 km stage in Namibia/)
  assert.match(d, /Sesfontein/)
  assert.match(d, /Amspoort/)
  assert.match(d, /30 km of tracks and paths/)
  assert.match(d, /11 km off-piste/)
  assert.match(d, /bare ground/)
  assert.match(d, /scrub/)
})

test('a direct line through heavy forest is warned; a road through forest is not', () => {
  // 10 samples, 50 m apart = 450 m. First 8 in trees off-piste, last 2 bare.
  const samples = []
  for (let i = 0; i < 10; i++) {
    samples.push({ lat: 0, lon: i * 0.0005, km: i * 0.05, cover: i < 8 ? 'trees' : 'bare', onMapped: false, fromLabel: 'WPV 1', toLabel: 'WPV 2' })
  }
  const warned = P.findForestProblems(samples, [], [], { stepM: 50 })
  assert.equal(warned.length, 1)
  assert.match(warned[0].text, /forest/)
  assert.match(warned[0].text, /WPV 1/)
  assert.match(warned[0].text, /no mapped track or road/)
  assert.equal(warned[0].blocked, true)

  const onRoad = samples.map(s => Object.assign({}, s, { onMapped: true }))
  assert.equal(P.findForestProblems(onRoad, [], []).length, 0)
})

test('open ground to one side is mentioned; short tree patches are ignored', () => {
  const samples = []
  for (let i = 0; i < 8; i++) {
    samples.push({ lat: 1, lon: i * 0.0005, km: i * 0.05, cover: 'trees', onMapped: false, fromLabel: 'DSS', toLabel: 'ASS' })
  }
  const sides = [
    { i: 3, side: 'left', cover: 'bare' },
    { i: 4, side: 'left', cover: 'bare' }
  ]
  const w = P.findForestProblems(samples, sides, [])
  assert.equal(w.length, 1)
  assert.equal(w[0].blocked, false)
  assert.match(w[0].text, /open ground to the left/)

  const short = samples.slice(0, 2) // 50 m
  assert.equal(P.findForestProblems(short, [], [], { stepM: 50 }).length, 0)
})

test('a waypoint in forest is warned only when it is not on a mapped way', () => {
  const samples = [{ lat: 0, lon: 0, km: 0, cover: 'bare', onMapped: true }]
  const wp = [{ label: 'WPV 3', km: 1.2, lat: 0.01, lon: 0.01, cover: 'trees', onMapped: false }]
  const w = P.findForestProblems(samples, [], wp)
  assert.equal(w.length, 1)
  assert.match(w[0].text, /WPV 3 sits in forest/)
  const onTrack = [{ label: 'WPV 3', km: 1.2, cover: 'trees', onMapped: true }]
  assert.equal(P.findForestProblems(samples, [], onTrack).length, 0)
})

test('mappedMask: roads and tracks count as mapped; direct and track gaps do not', () => {
  const pts = [[0, 0], [0, 0.01], [0, 0.02], [0, 0.03]]
  assert.deepEqual(P.mappedMask({ mode: 'road', points: pts }), [true, true, true, true])
  assert.deepEqual(P.mappedMask({ mode: 'direct', points: pts }), [false, false, false, false])
  assert.deepEqual(P.mappedMask({ mode: 'gpx', points: pts }), [true, true, true, true])
  const gaps = P.mappedMask({ mode: 'track', points: pts, cover: { onKm: 2, straightKm: 1, gaps: [[1, 2]] } })
  assert.deepEqual(gaps, [true, false, false, true])
  assert.deepEqual(P.mappedMask({ mode: 'road', failed: true, points: pts }), [false, false, false, false])
})

test('forest warnings stay on consecutive legs and do not name points with a waypoint between them', () => {
  // DSS --1.1 km forest-- WPM 1 --1.1 km forest-- ASS  (as after "insert after selected")
  const samples = []
  const pushLeg = (from, to, legIndex, km0) => {
    for (let i = 0; i <= 22; i++) {
      samples.push({
        lat: 46 + (km0 + i * 0.05) / 111, lon: 7, km: km0 + i * 0.05,
        cover: 'trees', onMapped: false, legIndex, fromLabel: from, toLabel: to, label: to
      })
    }
  }
  pushLeg('DSS', 'WPM 1', 1, 0)
  // shared vertex at the insert belongs to the first leg already; start the second leg just after
  pushLeg('WPM 1', 'ASS', 2, 1.1)
  const w = P.findForestProblems(samples, [], [], { stepM: 50 })
  const texts = w.map(x => x.text)
  assert.equal(w.length, 2, texts.join(' | '))
  assert.match(texts[0], /from DSS to WPM 1/)
  assert.match(texts[1], /from WPM 1 to ASS/)
  assert.ok(texts.every(t => !/from DSS to ASS/.test(t)), 'must not name DSS and ASS: they are not direct neighbours')
  // each stretch is about 1.1 km, not the whole 2.2 km
  assert.ok(texts.every(t => /1\.1 km/.test(t)), texts.join(' | '))
})
