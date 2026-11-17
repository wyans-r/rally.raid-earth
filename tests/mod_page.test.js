// The /mod page key lists must match the bindings shipped: the live page (stage-builder/mod.html) the 16 Nov zip it
// links to (16 keys), the pending page (stage-builder/pending/mod.public-zip.html) this build's 9 driving keys, plus the
// buttons that replaced the other keys (Wyans 2026-11-17).
// node --test tests/mod_page.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = path.join(__dirname, '..')
const MOD_HTML = path.join(ROOT, 'stage-builder/mod.html')
const README = path.join(ROOT, 'README.md')
const ACTIONS = path.join(ROOT, 'mod/lua/ge/extensions/core/input/actions/rallyRaid.json')
const INPUTMAP = path.join(ROOT, 'mod/settings/inputmaps/keyboard_rallyRaid.json')
const PENDING_HTML = path.join(ROOT, 'stage-builder/pending/mod.public-zip.html')
// the keyboard file inside the 16 Nov zip (/download/rallyraid_mod.zip, sha 1c750311...), frozen here
const LIVE_ZIP_BINDINGS = [['ctrl shift up', 'rallyRaid_tripPlus'], ['ctrl shift down', 'rallyRaid_tripMinus'], ['ctrl shift right', 'rallyRaid_wPlus'],
  ['ctrl shift left', 'rallyRaid_wMinus'], ['ctrl shift p', 'rallyRaid_partialReset'], ['ctrl shift home', 'rallyRaid_start'], ['ctrl shift pageup', 'rallyRaid_boxPrev'],
  ['ctrl shift pagedown', 'rallyRaid_boxNext'], ['ctrl shift end', 'rallyRaid_boxSync'], ['ctrl shift r', 'rallyRaid_recce'], ['ctrl shift n', 'rallyRaid_recceDrop'],
  ['ctrl shift c', 'rallyRaid_recceConfirm'], ['ctrl shift m', 'rallyRaid_recceMove'], ['ctrl shift t', 'rallyRaid_recceRetag'], ['ctrl shift delete', 'rallyRaid_recceDelete'],
  ['ctrl shift z', 'rallyRaid_recceUndo']].map(([control, action]) => ({ control, action }))
const KEPT = ['rallyRaid_tripPlus', 'rallyRaid_tripMinus', 'rallyRaid_wPlus', 'rallyRaid_wMinus', 'rallyRaid_partialReset', 'rallyRaid_start', 'rallyRaid_boxPrev', 'rallyRaid_boxNext', 'rallyRaid_boxSync']

const KEY_LABEL = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  p: 'P', home: 'Home', pageup: 'PageUp', pagedown: 'PageDown', end: 'End',
  r: 'R', n: 'N', c: 'C', m: 'M', t: 'T', delete: 'Delete', z: 'Z',
  f: 'F', g: 'G', h: 'H', j: 'J', w: 'W', b: 'B', k: 'K'
}

// Plain-word phrases the /mod page must use for each action (checked as substrings).
const ACTION_PHRASES = {
  rallyRaid_tripPlus: ['trip +', 'hold to repeat'],
  rallyRaid_tripMinus: ['trip', 'hold to repeat'],
  rallyRaid_wPlus: ['W+', 'skip waypoint'],
  rallyRaid_wMinus: ['W', 'missed waypoint'],
  rallyRaid_partialReset: ['partial'],
  rallyRaid_start: ['countdown'],
  rallyRaid_boxPrev: ['roadbook box up'],
  rallyRaid_boxNext: ['roadbook box down'],
  rallyRaid_boxSync: ['sync the trip'],
  rallyRaid_recce: ['recce mode on / off'],
  rallyRaid_recceDrop: ['drop a box here', 'press again'],
  rallyRaid_recceConfirm: ['confirm the nearest box'],
  rallyRaid_recceMove: ['move the nearest box here'],
  rallyRaid_recceRetag: ['retag the nearest box'],
  rallyRaid_recceDelete: ['delete the nearest box'],
  rallyRaid_recceUndo: ['recce: undo'],
  rallyRaid_repairMenu: ['repair menu'],
  rallyRaid_recoverCar: ['recover car', 'press again to confirm'],
  rallyRaid_gameResume: ['resume after a game crash', 'press twice'],
  rallyRaid_plannerMenu: ['planner: open / close'],
  rallyRaid_plannerWaypoint: ['planner: waypoint here'],
  rallyRaid_plannerBox: ['planner: roadbook box here'],
  rallyRaid_plannerRec: ['record the driven line']
}

function loadBindings (list) {
  const actions = JSON.parse(fs.readFileSync(ACTIONS, 'utf8'))
  const map = list ? { bindings: list } : JSON.parse(fs.readFileSync(INPUTMAP, 'utf8'))
  return map.bindings.map((b) => {
    const parts = b.control.split(/\s+/)
    assert.ok(parts[0] === 'ctrl' && parts[1] === 'shift', b.control)
    const key = parts.slice(2).join(' ')
    const label = KEY_LABEL[key]
    assert.ok(label, 'unmapped control in test helper: ' + b.control)
    return { action: b.action, control: b.control, keyLabel: 'Ctrl+Shift+' + label, title: (actions[b.action] || {}).title, desc: (actions[b.action] || {}).desc }
  })
}

function parseKeyTable (html) {
  const block = html.match(/<h2>Keys<\/h2>[\s\S]*?<\/table>/)
  assert.ok(block, 'Keys table missing')
  const rows = []
  const re = /<tr><td><code>([^<]+)<\/code><\/td><td>([\s\S]*?)<\/td><\/tr>/g
  let m
  while ((m = re.exec(block[0]))) {
    const action = m[2].replace(/&minus;/g, '−').replace(/&ldquo;|&rdquo;/g, '"').replace(/<[^>]+>/g, '')
    rows.push({ key: m[1].trim(), action: action.trim() })
  }
  return rows
}

test('this build ships only the 9 driving keys', () => {
  const map = JSON.parse(fs.readFileSync(INPUTMAP, 'utf8'))
  assert.deepEqual(map.bindings.map((b) => b.action).sort(), KEPT.slice().sort())
})

test('the frozen 16 Nov key list matches the zip in the download folder (when it is here)', (t) => {
  const zip = path.join(ROOT, 'stage-builder/download/rallyraid_mod.zip')
  if (!fs.existsSync(zip)) { t.skip('stage-builder/download is not in this checkout (git-ignored)'); return }
  let txt
  try { txt = require('child_process').execFileSync('unzip', ['-p', zip, '*keyboard_rallyRaid.json'], { encoding: 'utf8' }) } catch (e) { t.skip('unzip not available'); return }
  assert.deepEqual(JSON.parse(txt).bindings, LIVE_ZIP_BINDINGS)
})

for (const [name, file, list] of [['live /mod page (16 Nov zip)', MOD_HTML, LIVE_ZIP_BINDINGS], ['pending /mod page (this build)', PENDING_HTML, null]]) {
test(name + ': every bound key is listed with the right action', () => {
  const html = fs.readFileSync(file, 'utf8')
  const rows = parseKeyTable(html)
  const bindings = loadBindings(list)
  assert.equal(rows.length, bindings.length, 'row count should equal bound keys (got ' + rows.map((r) => r.key).join(', ') + ')')
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.action]))
  for (const b of bindings) {
    const action = byKey[b.keyLabel]
    assert.ok(action, 'missing key on /mod page: ' + b.keyLabel + ' (' + b.action + ')')
    for (const phrase of ACTION_PHRASES[b.action]) {
      assert.ok(action.toLowerCase().includes(phrase.toLowerCase()), b.keyLabel + ' should mention "' + phrase + '" (got: ' + action + ')')
    }
  }
})
}

test('live /mod page: the recce keys are marked "this download only", no next-build keys', () => {
  const html = fs.readFileSync(MOD_HTML, 'utf8')
  for (const k of ['R', 'N', 'C', 'M', 'T', 'Delete', 'Z']) {
    assert.match(html, new RegExp('Ctrl\\+Shift\\+' + k + '</code></td><td>[^<]*<i class="nb">\\(this download only\\)</i>'))
  }
  for (const k of ['F', 'G', 'H', 'J', 'W', 'B', 'K']) assert.doesNotMatch(html, new RegExp('Ctrl\\+Shift\\+' + k + '<'))
  assert.match(html, /The next build keeps only the driving keys/)
})

test('pending /mod page: each unbound action names its button', () => {
  const html = fs.readFileSync(PENDING_HTML, 'utf8')
  const block = html.match(/<h3>Buttons \(no default key\)<\/h3>[\s\S]*?<\/table>/)
  assert.ok(block, 'Buttons table missing')
  const txt = block[0].replace(/<[^>]+>/g, '')
  for (const w of ['REPAIR', 'RECOVER', 'CONFIRM', 'RESUME', 'CONFIRM RESUME', 'GO', 'PLANNER', 'ADD HERE', '+ BOX HERE', 'REC', 'RECCE', 'HERE', 'TAG', 'UNDO', 'MENU']) {
    assert.ok(txt.includes(w), 'Buttons table should name ' + w)
  }
  for (const a of ['repair menu', 'recover car', 'resume after a game crash', 'planner: open / close', 'recce mode on / off', 'undo']) assert.ok(txt.toLowerCase().includes(a), a)
  assert.doesNotMatch(html, /Ctrl\+Shift\+(R|N|C|M|T|Delete|Z|F|G|H|J|W|B|K)</)
})

test('/mod page does not call Left/Right trip step size, and names the 10m button', () => {
  const html = fs.readFileSync(MOD_HTML, 'utf8')
  const rows = parseKeyTable(html)
  const left = rows.find((r) => r.key === 'Ctrl+Shift+Left')
  const right = rows.find((r) => r.key === 'Ctrl+Shift+Right')
  assert.ok(left && /W/.test(left.action) && /missed/i.test(left.action), left)
  assert.ok(right && /W\+/.test(right.action) && /skip/i.test(right.action), right)
  assert.doesNotMatch(left.action + ' ' + right.action, /trip step size/i)
  assert.match(html, /10m/)
  assert.match(html, /10 \/ 100 \/ 1000 m/)
})

test('/mod page download link stays on the 16 Nov zip until the public zip is OKd', () => {
  const html = fs.readFileSync(MOD_HTML, 'utf8')
  assert.match(html, /href="\/download\/rallyraid_mod\.zip"/)
  assert.match(html, /Download rallyraid_mod\.zip/)
  assert.doesNotMatch(html, /wyans_rallyraid\.zip/)
})

test('pending public-zip /mod page is ready with the wyans_rallyraid.zip link', () => {
  const html = fs.readFileSync(path.join(ROOT, 'stage-builder/pending/mod.public-zip.html'), 'utf8')
  assert.match(html, /href="\/download\/wyans_rallyraid\.zip"/)
  assert.match(html, /Download wyans_rallyraid\.zip/)
  assert.doesNotMatch(html, /rallyraid_mod\.zip/)
})

test('README lists every bound key, and a button for each unbound action', () => {
  const md = fs.readFileSync(README, 'utf8')
  const bindings = loadBindings()
  for (const b of bindings) {
    assert.ok(md.includes(b.keyLabel), 'README missing ' + b.keyLabel)
  }
  assert.doesNotMatch(md, /Ctrl\+Shift\+(R|N|C|M|T|Delete|Z|F|G|H|J|W|B|K)\b/)
  assert.match(md, /Recover car \(two steps.*MENU\*\* > \*\*RECOVER\*\*, then \*\*CONFIRM\*\*/)
  assert.match(md, /Resume after a game crash \(two steps.*\*\*RESUME\*\*, then \*\*CONFIRM RESUME\*\*/)
  assert.match(md, /Planner: open \/ close \| GPS app \*\*MENU\*\* > \*\*PLANNER\*\*/)
  assert.match(md, /Repair menu \| GPS app \*\*MENU\*\* > \*\*REPAIR\*\*/)
  assert.match(md, /Trip step size \(10 \/ 100 \/ 1000 m\) is the \*\*10m\*\* button on the GPS app/)
  assert.match(md, /Trip reset \| not bound by default/)
})

test('live download folder still has the existing zip and was not overwritten', (t) => {
  const download = path.join(ROOT, 'stage-builder/download')
  if (!fs.existsSync(download)) { t.skip('stage-builder/download is not in this checkout (git-ignored)'); return }
  const names = fs.readdirSync(download)
  assert.ok(names.includes('rallyraid_mod.zip'), 'existing download zip should still be rallyraid_mod.zip: ' + names.join(','))
  assert.ok(!names.includes('wyans_rallyraid.zip'), 'do not publish wyans_rallyraid.zip into the download folder yet')
})

test('/mod page serves and shows every key of the 16 Nov zip (headless)', async (t) => {
  let puppeteer
  try {
    puppeteer = require('puppeteer-core')
  } catch (e) {
    t.skip('puppeteer-core not installed')
    return
  }
  const chrome = '/usr/bin/google-chrome'
  if (!fs.existsSync(chrome)) {
    t.skip('google-chrome not available')
    return
  }
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' }
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0])
    const rel = u === '/mod' || u === '/mod.html' ? '/mod.html' : u
    const f = path.normalize(path.join(ROOT, 'stage-builder', rel))
    if (!f.startsWith(path.join(ROOT, 'stage-builder'))) { res.writeHead(403); return res.end() }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end('missing') }
      res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain' })
      res.end(data)
    })
  })
  await new Promise((res) => srv.listen(0, res))
  const port = srv.address().port
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto('http://127.0.0.1:' + port + '/mod', { waitUntil: 'domcontentloaded', timeout: 15000 })
    const got = await page.$$eval('h2, table tr', (els) => {
      const keysH2 = els.find((e) => e.tagName === 'H2' && e.textContent === 'Keys')
      const table = keysH2 && keysH2.nextElementSibling && keysH2.nextElementSibling.tagName === 'TABLE'
        ? keysH2.nextElementSibling
        : keysH2.parentElement.querySelector('table')
      // the intro <p> sits between h2 and table
      let t = keysH2 ? keysH2.nextElementSibling : null
      while (t && t.tagName !== 'TABLE') t = t.nextElementSibling
      const rows = t ? [...t.querySelectorAll('tr')].map((r) => ({ key: r.cells[0].innerText.trim(), action: r.cells[1].innerText.trim() })) : []
      const dl = document.querySelector('a.dl')
      return { title: document.title, rows, href: dl && dl.getAttribute('href'), text: dl && dl.textContent, stepNote: document.body.innerText.includes('10m') }
    })
    assert.equal(errors.length, 0, errors.join('\n'))
    const bindings = loadBindings(LIVE_ZIP_BINDINGS)
    assert.equal(got.rows.length, bindings.length)
    const byKey = Object.fromEntries(got.rows.map((r) => [r.key, r.action]))
    for (const b of bindings) {
      assert.ok(byKey[b.keyLabel], 'rendered page missing ' + b.keyLabel)
    }
    assert.equal(got.href, '/download/rallyraid_mod.zip')
    assert.match(got.text, /rallyraid_mod\.zip/)
    assert.equal(got.stepNote, true)
    assert.match(byKey['Ctrl+Shift+Left'], /W/)
    assert.doesNotMatch(byKey['Ctrl+Shift+Left'], /trip step size/i)
  } finally {
    await browser.close()
    srv.close()
  }
})
