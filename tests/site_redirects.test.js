// The mod is hosted on GitHub Releases (17 Nov 2026): /mod and the old zip URLs redirect there; no page links the old paths.
// node --test tests/site_redirects.test.js
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path')
const SB = path.join(__dirname, '..', 'stage-builder')
const REL = 'https://github.com/wyans-r/rally.raid-earth/releases/latest'
test('_redirects', () => {
  const lines = fs.readFileSync(path.join(SB, '_redirects'), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/))
  const m = Object.fromEntries(lines.map(([a, b, c]) => [a, [b, c]]))
  for (const p of ['/mod', '/mod.html']) assert.deepEqual(m[p], [REL, '302'])
  for (const p of ['/download/rallyraid_earth.zip', '/download/rallyraid_mod.zip']) assert.deepEqual(m[p], [REL + '/download/rallyraid_earth.zip', '302'])
})
test('deployed pages do not link /mod or /download/', () => {
  for (const f of ['index.html', 'credits.html', 'roadbook.html']) {
    const h = fs.readFileSync(path.join(SB, f), 'utf8')
    assert.doesNotMatch(h, /href="\/mod"|href="\/download\//, f)
  }
  assert.match(fs.readFileSync(path.join(SB, 'index.html'), 'utf8'), /releases\/latest/)
  assert.match(fs.readFileSync(path.join(SB, 'credits.html'), 'utf8'), /github\.com\/wyans-r\/rally\.raid-earth/)
})
test('Examples: the rally event entry exists but its flag is off', () => {
  const h = fs.readFileSync(path.join(SB, 'index.html'), 'utf8')
  assert.match(h, /var EXAMPLE_FLAGS = \{ rallyEvents: false \}/)
  const ex = JSON.parse(fs.readFileSync(path.join(SB, 'examples', 'index.json'), 'utf8'))
  const r = ex.rallies.find(x => x.id === 'atlantic-to-atlas-2027')
  assert.ok(r && r.flag === 'rallyEvents' && r.inspiration === 'Inspired by the 2027 Dakar route. Unofficial, not affiliated.')
  assert.ok(ex.stages.every(s => s.locale), 'every example has a locale')
})

// 17 Nov 2026: the site moved to rrearth.wyans.net; stagebuilder.wyans.net is the redirect Worker in deploy/redirect-worker
test('redirect Worker: same path and query on rrearth, GitHub for the mod, a migration page for page loads', async () => {
  const W = await import(path.join(__dirname, '..', 'deploy', 'redirect-worker', 'src', 'index.js'))
  const H = (p, h) => W.handle(new Request('https://stagebuilder.wyans.net' + p, { headers: h || {} }))
  let r = H('/roadbook.html?s=1&v=2')
  assert.equal(r.status, 301); assert.equal(r.headers.get('location'), 'https://rrearth.wyans.net/roadbook.html?s=1&v=2')
  r = H('/stagegen.js', { Accept: 'text/html' }); assert.equal(r.status, 301)
  r = H('/download/rallyraid_earth.zip', { Accept: 'text/html' }); assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://github.com/wyans-r/rally.raid-earth/releases/latest/download/rallyraid_earth.zip')
  r = H('/mod', { Accept: 'text/html' }); assert.equal(r.headers.get('location'), 'https://github.com/wyans-r/rally.raid-earth/releases/latest')
  r = H('/?a=1&b=2', { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' })
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store')
  const html = await r.text()
  assert.ok(html.includes('href="https://rrearth.wyans.net/?a=1&amp;b=2"') && html.includes('url=https://rrearth.wyans.net/?a=1&amp;b=2'))
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'stage-builder', 'migrate.html')))
})
