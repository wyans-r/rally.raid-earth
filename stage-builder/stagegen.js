/* Stage-Gen panel for the stage builder (index.html): "Auto stage" next to the map search.
 * Place a DSS and an ASS, give a length and a terrain mix, get 3 route options, pick one: it becomes a normal stage in
 * the builder (then the Roadbook button makes its roadbook). Blind mode makes one sealed stage the organizer never sees.
 *
 * All the logic is in stagegen-core.js (shared with the in-game planner later); roadbook-gen.js and stagegen-core.js
 * are loaded on first use, so the builder page loads exactly as before. Uses from index.html: the globals `map`, `L`,
 * window.RallyRaidBuilder (state, applyStage, openRoadbook), window.RallyRaidShare (optional), #mapwrap, .mapbar.
 * Network answers are cached in the roadbook editor's IndexedDB cache (same keys), so both pages share them.
 */
(function () {
  'use strict'
  var VERSION = '1.2.0'
  var $ = function (s, r) { return (r || document).querySelector(s) }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  var mapwrap = $('#mapwrap'), bar = $('.mapbar')
  if (!mapwrap || !bar || typeof L === 'undefined' || !window.map) return
  var lmap = window.map
  var MOBILE_QUERY = '(max-width: 900px), (max-height: 500px) and (pointer: coarse)'   // as mobile.js / mobile.css
  var isMobile = function () { return window.matchMedia && window.matchMedia(MOBILE_QUERY).matches }

  // ------------------------------------------------------------------ libraries on first use
  var libs = null
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('could not load ' + src)) }; document.head.appendChild(s) }) }
  function loadLibs() {
    if (!libs) libs = (window.RoadbookGen ? Promise.resolve() : loadScript('roadbook-gen.js'))
      .then(function () { return window.StageGen ? null : loadScript('stagegen-core.js') })
      .then(function () { if (!window.StageGen) throw new Error('Stage-Gen did not load'); return window.StageGen })
    libs.catch(function () { libs = null })
    return libs
  }

  // ------------------------------------------------------------------ network with the roadbook editor's cache
  var IDB = (function () {
    var dbp = null
    function db() {
      return dbp || (dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('no IndexedDB'))
        var r = indexedDB.open('rallyraid-roadbook', 1)
        r.onupgradeneeded = function () { r.result.createObjectStore('cache'); r.result.createObjectStore('docs') }
        r.onsuccess = function () { res(r.result) }; r.onerror = function () { rej(r.error) }
      }))
    }
    function op(mode, f) { return db().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction('cache', mode), q = f(t.objectStore('cache')); t.oncomplete = function () { res(q && q.result) }; t.onerror = function () { rej(t.error) } }) }) }
    return { get: function (k) { return op('readonly', function (o) { return o.get(k) }).catch(function () { return undefined }) },
      put: function (k, v) { return op('readwrite', function (o) { return o.put(v, k) }).catch(function () {}) } }
  })()
  function sha(s) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (b) { return Array.from(new Uint8Array(b), function (x) { return x.toString(16).padStart(2, '0') }).join('') }) }
  var netStats = { cacheHits: 0, fetched: 0, overpass: 0 }
  // a Stage-Gen map tile asks the server for at most 60 s ([timeout:60]); wait a little longer than that. Retries per tile
  // are in stagegen-core.js (loadOsm), so one slow answer never fails the whole generate.
  var OVERPASS_WAIT_MS = 75000
  // one options object for every Stage-Gen query, so the mirror helper remembers which mirror is fast / resting
  var OV_OPTS = { overpassTimeoutMs: OVERPASS_WAIT_MS, overpassStaggerMs: 8000, overpassRounds: 1 }
  // turn browser / network errors into words ("Fetch is aborted" is Safari's text for a request we gave up waiting for)
  function plainError(e) {
    var m = (e && e.message) || String(e)
    if (e && e.code === 'osm-unavailable') return m
    if ((e && e.name === 'AbortError') || /abort|^mirror |no answer in|stalled/i.test(m)) return 'The map servers did not answer in time. They are often overloaded; please try again in a few minutes (what has loaded is kept, so the next try is faster).'
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'Could not reach the map servers (no connection?). Please try again.'
    if (/^HTTP 5\d\d/.test(m)) return 'The map servers are overloaded right now (' + m + '). Please try again in a few minutes.'
    return m
  }
  function makeIo(onProgress, log) {
    return {
      sha256: sha,
      log: log || function () {},
      progress: onProgress,
      fetchBytes: function (url) {
        return IDB.get('dem:' + url).then(function (hit) {
          if (hit !== undefined) { netStats.cacheHits++; return hit && hit.byteLength ? hit : null }
          return fetch(url).then(function (r) {
            netStats.fetched++
            if (r.status === 404) { IDB.put('dem:' + url, new ArrayBuffer(0)); return null }
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.arrayBuffer().then(function (ab) { IDB.put('dem:' + url, ab); return ab })
          })
        })
      },
      // Overpass through the roadbook generator's own helper (public mirrors raced / failed over), cached like the editor
      overpass: function (q) {
        return sha(q).then(function (h) {
          var key = 'osm:' + h
          return IDB.get(key).then(function (hit) {
            if (hit) { netStats.cacheHits++; return hit }
            netStats.overpass++
            return window.RoadbookGen.askOverpass(q, OV_OPTS, log).then(function (j) { IDB.put(key, j); return j })
          })
        })
      },
      // for RoadbookGen.generate (sealed pack roadbook): same cache, mirrors still raced
      fetchOverpass: function (ep, q, opts) {
        return sha(q).then(function (h) {
          var key = 'osm:' + h
          return IDB.get(key).then(function (hit) {
            if (hit) return hit
            return window.RoadbookGen.defaultOverpass(ep, q, opts).then(function (j) { if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error(j.remark.slice(0, 80)); IDB.put(key, j); return j })
          })
        })
      }
    }
  }

  // ------------------------------------------------------------------ state
  var PRESETS = { mixed: { label: 'Mixed', off: 40 }, dunes: { label: 'Dunes', off: 70 }, piste: { label: 'Piste', off: 15 } }   // = stagegen-core.js PRESETS
  var COLORS = ['#ff4fa3', '#00d5ff', '#b5ff3b']
  var S = { open: false, placing: null, dss: null, ass: null, lengthKm: 60, preset: 'mixed', off: 40, region: '', regionTouched: false, seed: '', blind: false,
    busy: false, res: null, sel: -1, used: null, sealed: null, timings: null }
  function newSeed() { var b = new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b, function (x) { return x.toString(16).padStart(2, '0') }).join('') }
  S.seed = newSeed()
  var gSG = L.layerGroup().addTo(lmap), gOpt = L.layerGroup().addTo(lmap)
  var mDss = null, mAss = null
  // the sealed (blind) stage lives only in this closure: never drawn, never put in the builder, never logged
  var sealedStage = null, sealedOut = null

  // ------------------------------------------------------------------ DOM
  var openBtn = document.createElement('button')
  openBtn.className = 'b'; openBtn.id = 'sg-open'; openBtn.type = 'button'
  openBtn.title = 'Stage-Gen: place a start and a finish, give a length, and get 3 route options made from tracks and open terrain'
  openBtn.innerHTML = '<span class="sg-bolt">&#9889;</span><span class="sg-word"> Auto stage</span><span class="sg-short"> Auto</span>'
  bar.appendChild(openBtn)

  var panel = document.createElement('div')
  panel.id = 'sg-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Auto stage (Stage-Gen)')
  panel.innerHTML =
    '<div class="sg-head"><b>Auto stage</b><span class="sg-sub">Stage-Gen</span><button type="button" class="b sg-x" data-sg="close" aria-label="Close">&times;</button></div>' +
    '<div class="sg-body">' +
    '<div class="sg-step"><div class="sg-lab">1 &middot; Start and finish</div>' +
    '<div class="sg-pts"><button type="button" class="b sg-place" data-sg="place-dss"><span class="sg-dot dss">DSS</span> <span id="sg-dss-t">Place on map</span></button>' +
    '<button type="button" class="b sg-place" data-sg="place-ass"><span class="sg-dot ass">ASS</span> <span id="sg-ass-t">Place on map</span></button></div>' +
    '<div class="sg-row2"><button type="button" class="b sg-link" data-sg="from-builder" title="Use the DSS and ASS of the stage in the builder">Use the builder&rsquo;s DSS / ASS</button><span id="sg-straight" class="sg-dim"></span></div></div>' +
    '<div class="sg-step"><div class="sg-lab">2 &middot; Length</div>' +
    '<div class="sg-len"><input id="sg-len" type="number" min="5" max="200" step="1" inputmode="decimal"> <span>km</span><span class="sg-dim">&plusmn;10%</span></div></div>' +
    '<div class="sg-step"><div class="sg-lab">3 &middot; Terrain</div>' +
    '<div class="sg-presets" role="radiogroup">' + Object.keys(PRESETS).map(function (k) { return '<button type="button" class="b" role="radio" data-preset="' + k + '">' + PRESETS[k].label + '</button>' }).join('') + '</div>' +
    '<div class="sg-slider"><span>Piste</span><input id="sg-off" type="range" min="0" max="100" step="5" aria-label="Off-piste share"><span>Off-piste</span></div>' +
    '<div id="sg-split" class="sg-dim"></div>' +
    '<div class="sg-dim sg-rules">Pistes: unpaved tracks only, no highways, no asphalt, no towns. Off-piste: open ground round trees, buildings, water, fences and steep slopes; sand and dunes preferred.</div></div>' +
    '<div class="sg-step"><div class="sg-lab">4 &middot; Name and seed</div>' +
    '<input id="sg-region" placeholder="Region (e.g. Erg Chebbi, Morocco)">' +
    '<div class="sg-seedrow"><label for="sg-seed">Seed</label><input id="sg-seed" spellcheck="false" autocomplete="off"><button type="button" class="b" data-sg="reseed" title="New random seed">&#8635;</button></div>' +
    '<label class="sg-check"><input type="checkbox" id="sg-blind"><span><b>Blind mode</b>: I am a participant in the event for this stage</span></label>' +
    '<div class="sg-dim" id="sg-blindhint">Tick this if you&rsquo;ll race this stage yourself. The route is hidden from you and sealed until the event closes.</div>' +
    '<div id="sg-blindnote" class="sg-note" hidden>One sealed stage is made from a secret seed. You see only its length and region. You get a sealed pack to hand out, a public receipt, and a seed file to keep private and publish after the event so anyone can check you did not pick or change the route. <a href="#" data-sg="blind-help">How it works and its limits</a></div></div>' +
    '<button type="button" class="b p sg-go" data-sg="generate">Generate 3 options</button>' +
    '<div id="sg-prog" class="sg-prog" hidden><div class="sg-bar"><i></i></div><div class="sg-msg"></div></div>' +
    '<div id="sg-err" class="err" hidden></div>' +
    '<div id="sg-opts"></div>' +
    '<div id="sg-blindout"></div>' +
    '<details class="sg-verify"><summary>Verify a blind stage</summary>' +
    '<div class="sg-dim">After the event, check that the published seed file really makes the stage that was handed out. Give it the public receipt and the published seed file (and, if you like, the stage file you drove).</div>' +
    '<label>Receipt (.receipt.json)<input type="file" id="sg-v-receipt" accept=".json,application/json"></label>' +
    '<label>Seed file (.seed.json)<input type="file" id="sg-v-seed" accept=".json,application/json"></label>' +
    '<label>Stage file (optional)<input type="file" id="sg-v-stage" accept=".json,application/json"></label>' +
    '<button type="button" class="b" data-sg="verify">Verify</button><div id="sg-v-out"></div></details>' +
    '</div>'
  mapwrap.appendChild(panel)
  var placeBar = document.createElement('div')
  placeBar.id = 'sg-placebar'; placeBar.innerHTML = '<span id="sg-place-msg"></span><button type="button" class="b" data-sg="cancel-place">Cancel</button>'
  mapwrap.appendChild(placeBar)
  var helpBox = document.createElement('div')
  helpBox.id = 'sg-help'; helpBox.hidden = true
  helpBox.innerHTML = '<div class="sg-helpin"><button type="button" class="b sg-x" data-sg="help-close" aria-label="Close">&times;</button>' +
    '<h3>Blind mode: how it works</h3><ol>' +
    '<li>You place the start (DSS), the finish (ASS) and the length, and choose the terrain. That is all you decide.</li>' +
    '<li>The browser picks a random secret <b>seed</b> and makes one route from it. The same seed and the same inputs always make exactly the same route.</li>' +
    '<li>You see only the region and the length. The route is never drawn, never loaded into the builder and never shown as text.</li>' +
    '<li>You download a <b>sealed pack</b> (the stage file, plus its roadbook if the map servers answer) and hand it to the drivers, or copy a <b>sealed share link</b> and send it on.</li>' +
    '<li>You publish the <b>receipt</b> now. It holds a fingerprint (commitment) of the seed and the exact stage, but not the route.</li>' +
    '<li>You keep the <b>seed file</b> private. After the event closes you publish it. Anyone can then load the receipt and the seed file under <i>Verify a blind stage</i>: the site regenerates the stage and checks it is exactly the one in the receipt.</li></ol>' +
    '<h3>Honest limits</h3><ul>' +
    '<li>It keeps an honest organizer from seeing the route by accident. It cannot stop a dishonest one: the sealed pack, the share link and the seed file are on your own computer and you could open them.</li>' +
    '<li>You could also make many blind stages and keep the one you like (the receipt cannot show how many tries there were). Publishing the receipt early and making only one helps others trust it.</li>' +
    '<li>The check needs the same Stage-Gen version (it is written in the receipt) and the same terrain tiles. The map data is saved inside the seed file, so later OpenStreetMap edits do not matter. A change to the public terrain tiles would make the check fail even for an honest stage.</li>' +
    '<li>Drivers who open the stage file in the builder see the whole route. That is fine for a game rally, where the GPS file carries it anyway.</li></ul></div>'
  document.body.appendChild(helpBox)

  // ------------------------------------------------------------------ rendering
  function fmtLL(p) { return p ? p[0].toFixed(4) + ', ' + p[1].toFixed(4) : 'Place on map' }
  function haversine(a, b) { var R = 6371008.8, r = Math.PI / 180, dp = (b[0] - a[0]) * r, dl = (b[1] - a[1]) * r, h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dl / 2) * Math.sin(dl / 2); return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))) }
  function pin(type) { return L.divIcon({ className: '', html: '<div class="wpicon sg-pin" style="background:' + (type === 'DSS' ? '#00e676' : '#ff5252') + '">' + type + ' &middot; auto</div>', iconSize: null, iconAnchor: [14, 10] }) }
  function renderPins() {
    // once a route is in the builder, its own DSS / ASS pins take over
    if (S.used && !S.placing) { gSG.clearLayers(); mDss = mAss = null; return }
    ;[['dss', 'DSS'], ['ass', 'ASS']].forEach(function (x) {
      var k = x[0], p = S[k], m = k === 'dss' ? mDss : mAss
      if (!p) { if (m) { gSG.removeLayer(m); if (k === 'dss') mDss = null; else mAss = null } return }
      if (!m) {
        m = L.marker(p, { icon: pin(x[1]), draggable: true, title: x[1] + ' for Stage-Gen (drag to move)' }).addTo(gSG)
        m.on('dragend', function () { var ll = m.getLatLng().wrap(); S[k] = [ll.lat, ll.lng]; changed(); render() })
        if (k === 'dss') mDss = m; else mAss = m
      } else m.setLatLng(p)
    })
  }
  function render() {
    $('#sg-dss-t').textContent = fmtLL(S.dss); $('#sg-ass-t').textContent = fmtLL(S.ass)
    var lenEl = $('#sg-len'); if (document.activeElement !== lenEl) lenEl.value = S.lengthKm
    $('#sg-off').value = S.off
    panel.querySelectorAll('[data-preset]').forEach(function (b) { var on = b.dataset.preset === S.preset; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false') })
    $('#sg-split').textContent = 'About ' + (100 - S.off) + '% piste / ' + S.off + '% off-piste' + (PRESETS[S.preset].off !== S.off ? ' (custom)' : '')
    var reg = $('#sg-region'); if (document.activeElement !== reg) reg.value = S.region
    var sd = $('#sg-seed'); sd.value = S.blind ? '' : S.seed; sd.disabled = S.blind; sd.placeholder = S.blind ? 'secret (in the seed file)' : ''
    $('#sg-blind').checked = S.blind; $('#sg-blindnote').hidden = !S.blind
    var go = panel.querySelector('[data-sg="generate"]'); go.textContent = S.busy ? 'Working…' : S.blind ? 'Make the sealed stage' : 'Generate 3 options'; go.disabled = S.busy
    panel.querySelectorAll('input, .sg-presets button, .sg-place, [data-sg="from-builder"], [data-sg="reseed"]').forEach(function (el) { if (!el.closest('.sg-verify')) el.disabled = S.busy || (el.id === 'sg-seed' && S.blind) })
    $('#sg-straight').textContent = S.dss && S.ass ? 'Straight line ' + (haversine(S.dss, S.ass) / 1000).toFixed(1) + ' km' : ''
    panel.classList.toggle('sg-placing', !!S.placing)
    renderPins()
  }
  function changed() { if (S.res || S.sealed) { S.res = null; S.sel = -1; S.sealed = null; sealedStage = null; sealedOut = null; gOpt.clearLayers(); $('#sg-opts').innerHTML = ''; $('#sg-blindout').innerHTML = '' } }
  function setErr(msg) { var e = $('#sg-err'); e.hidden = !msg; e.textContent = msg || '' }
  function progress(frac, msg) {
    var p = $('#sg-prog'); p.hidden = frac == null
    if (frac == null) return
    p.querySelector('i').style.width = Math.round(Math.max(0.03, Math.min(1, frac)) * 100) + '%'
    if (msg) p.querySelector('.sg-msg').textContent = msg
  }
  var PHASES = { osm: [0, 0.25, 'Reading OpenStreetMap'], terrain: [0.25, 0.4, 'Terrain heights'], landcover: [0.4, 0.55, 'Land cover'], route: [0.55, 0.97, 'Finding routes'], detail: [0.1, 0.95, 'Planning the off-piste legs in detail'] }
  function ioProgress(phase, d, t, msg) {
    var ph = PHASES[phase]; if (!ph) return
    progress(ph[0] + (ph[1] - ph[0]) * (t ? d / t : 0), (msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : ph[2]) + '…')
  }
  function openPanel(on) {
    S.open = on; panel.classList.toggle('on', on); openBtn.classList.toggle('on', on); openBtn.setAttribute('aria-expanded', on ? 'true' : 'false')
    if (!on) setPlacing(null)
    if (on) { prefillFromBuilder(true); render(); loadLibs().catch(function () {}) }
  }
  function setPlacing(which) {
    S.placing = which
    if (which) S.used = null
    placeBar.classList.toggle('on', !!which)
    $('#sg-place-msg').textContent = which ? (isMobile() ? 'Tap' : 'Click') + ' the map to place the ' + (which === 'dss' ? 'DSS (start)' : 'ASS (finish)') : ''
    mapwrap.classList.toggle('sg-crosshair', !!which)
    render()
  }
  function builderEnds() {
    var st = window.RallyRaidBuilder && window.RallyRaidBuilder.state(); if (!st || !st.points) return null
    var d = st.points.filter(function (p) { return p.type === 'DSS' })[0], a = st.points.filter(function (p) { return p.type === 'ASS' }).slice(-1)[0]
    return d && a ? { dss: [d.lat, d.lon], ass: [a.lat, a.lon], region: st.meta && st.meta.region } : null
  }
  function prefillFromBuilder(onlyIfEmpty) {
    if (onlyIfEmpty && (S.dss || S.ass)) return false
    var e = builderEnds(); if (!e) return false
    changed(); S.dss = e.dss; S.ass = e.ass
    if (!S.regionTouched && e.region) S.region = e.region
    var straight = haversine(S.dss, S.ass) / 1000
    if (S.lengthKm < straight * 1.15) S.lengthKm = Math.ceil(straight * 1.6 / 5) * 5
    return true
  }
  // region name from the nearest place (Nominatim, as the builder's search); only if the field is empty
  function guessRegion(p) {
    if (S.regionTouched || S.region) return
    fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=8&accept-language=en&lat=' + p[0] + '&lon=' + p[1]).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || S.regionTouched || S.region) return
      var a = j.address || {}, parts = [a.county || a.state_district || a.region || a.state, a.country].filter(Boolean)
      if (parts.length) { S.region = parts.join(', '); render() }
    }).catch(function () {})
  }

  // ------------------------------------------------------------------ options on the map and as cards
  function drawOptions() {
    gOpt.clearLayers()
    var res = S.res; if (!res) return
    var all = []
    res.options.forEach(function (op, i) {
      var sel = S.sel === i, faded = S.sel >= 0 && !sel
      op.lines.forEach(function (s) {
        var pts = s.line
        all = all.concat(pts)
        if (sel) L.polyline(pts, { color: '#000', weight: 9, opacity: 0.45, interactive: false }).addTo(gOpt)
        var pl = L.polyline(pts, { color: COLORS[i % 3], weight: sel ? 6 : 4, opacity: faded ? 0.35 : 0.95, dashArray: s.kind === 'off' ? '9 7' : null, className: 'sg-line sg-line-' + op.id })
        pl.on('click', function (e) { L.DomEvent.stopPropagation(e); selectOption(i) })
        pl.bindTooltip('Option ' + op.id + ' · ' + op.stats.lengthKm.toFixed(1) + ' km · ' + (s.kind === 'off' ? 'off-piste' : 'piste'), { sticky: true })
        pl.addTo(gOpt)
      })
    })
    return all
  }
  function fitAll(pts) {
    if (!pts || !pts.length) return
    var ph = S.open ? panel.getBoundingClientRect().height : 0
    var pad = isMobile() ? { paddingTopLeft: [16, 64], paddingBottomRight: [16, Math.round(ph + 12)] } : { paddingTopLeft: [400, 60], paddingBottomRight: [60, 40] }
    lmap.fitBounds(L.latLngBounds(pts), Object.assign(pad, { maxZoom: 14 }))
  }
  function renderOptions() {
    var box = $('#sg-opts'), res = S.res
    if (!res) { box.innerHTML = ''; return }
    var tol = res.o.tolerance, want = res.inputs.lengthKm
    var html = warnHtml(res.warnings) + '<div class="sg-lab">Pick a route</div>'
    res.options.forEach(function (op, i) {
      var st = op.stats, dl = (st.lengthKm - want) / want * 100
      html += '<div class="sg-card' + (S.sel === i ? ' on' : '') + '" data-opt="' + i + '" tabindex="0">' +
        '<div class="sg-ch"><span class="sg-sw" style="background:' + COLORS[i % 3] + '"></span><b>Option ' + op.id + '</b><span class="sg-km">' + st.lengthKm.toFixed(1) + ' km</span>' +
        '<span class="sg-dl ' + (Math.abs(dl) <= tol * 100 ? 'ok' : 'warn') + '">' + (dl >= 0 ? '+' : '') + dl.toFixed(0) + '%</span></div>' +
        '<div class="sg-splitbar"><i style="width:' + Math.round((1 - st.offShare) * 100) + '%"></i></div>' +
        '<div class="sg-cs">' + Math.round((1 - st.offShare) * 100) + '% piste (' + st.pisteKm.toFixed(1) + ' km) &middot; ' + Math.round(st.offShare * 100) + '% off-piste (' + st.offKm.toFixed(1) + ' km)</div>' +
        (Math.abs(st.offShare - res.inputs.offShare) > 0.1 ? '<div class="sg-cs warn">' + (st.offShare > res.inputs.offShare ? 'More off-piste than asked: there are few usable unpaved tracks here.' : 'Less off-piste than asked: open ground is scarce here (towns, fields, steep or wet ground).') + '</div>' : '') +
        '<div class="sg-cs sg-dim">' + esc(op.summary) + (st.roadCrossings ? ' &middot; ' + st.roadCrossings + ' road crossing' + (st.roadCrossings > 1 ? 's' : '') : '') + '</div>' +
        '<div class="sg-cb"><button type="button" class="b p" data-use="' + i + '">Use this route</button></div></div>'
    })
    html += '<div class="sg-dim sg-legend"><span class="sg-l1"></span> piste &nbsp; <span class="sg-l2"></span> off-piste &middot; ' + esc(timingText()) + '</div>'
    box.innerHTML = html
  }
  function timingText() {
    var t = S.timings; if (!t) return ''
    return 'map data ' + (t.dataMs / 1000).toFixed(1) + ' s, routes ' + (t.routeMs / 1000).toFixed(1) + ' s'
  }
  function selectOption(i) { S.sel = i; drawOptions(); renderOptions(); var c = panel.querySelector('.sg-card.on'); if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }) }

  // ------------------------------------------------------------------ generate
  function inputs() { return { dss: S.dss, ass: S.ass, lengthKm: S.lengthKm, preset: S.preset, offShare: S.off / 100, region: S.region } }
  function generate() {
    if (S.busy) return Promise.resolve(null)
    setErr('')
    var SG
    return loadLibs().then(function (sg) {
      SG = sg
      var errs = SG.checkInputs(SG.normInputs(inputs()))
      if (errs.length) throw new Error(errs.join(' '))
      changed(); S.used = null; S.busy = true; render(); progress(0.02, 'Starting…')
      var seed = S.blind ? newSeed() : (S.seed || (S.seed = newSeed()))
      return SG.generate(inputs(), seed, makeIo(ioProgress), Object.assign({ options: S.blind ? 1 : 3 }, API.coreOpts || {}))   // coreOpts: tests only
    }).then(function (res) {
      if (!res.options.length) throw new Error('No route found between these points. Try moving the DSS or ASS onto open ground, or a different length.')
      S.timings = res.timing
      if (S.blind) return seal(SG, res)
      S.res = res; S.sel = 0
      var drawn = drawOptions(); renderOptions(); fitAll(drawn)
      progress(null); S.busy = false; render()
      return res
    }).catch(function (e) {
      S.busy = false; progress(null); render(); setErr(plainError(e)); return null
    })
  }
  function useOption(i) {
    var res = S.res; if (!res || S.busy) return Promise.resolve(null)
    var B = window.RallyRaidBuilder
    var st0 = B && B.state()
    if (st0 && st0.points && st0.points.length && !confirm('Load option ' + res.options[i].id + ' into the builder? This replaces the stage currently in the builder. Export it first if you want to keep it.')) return Promise.resolve(null)
    S.busy = true; render(); setErr(''); progress(0.05, 'Planning the off-piste legs in detail…')
    var t0 = Date.now()
    return window.StageGen.buildStage(res, res.options[i].index, makeIo(ioProgress)).then(function (stage) {
      S.timings = Object.assign({}, S.timings, { stageMs: Date.now() - t0 })
      if (B.applyStage) B.applyStage(stage, stage.name); else B.importStage(stage)
      var dw = detailWarnings(stage)
      S.used = { id: stage.id, option: res.options[i].id, lengthKm: stage.lengthKm, waypoints: stage.waypoints.length, boxes: stage.roadbook.boxes.length }
      gOpt.clearLayers(); S.res = null; S.sel = -1
      $('#sg-opts').innerHTML = '<div class="sg-done"><b>Option ' + esc(S.used.option) + ' is now the stage in the builder</b> (' + stage.lengthKm.toFixed(1) + ' km, ' + stage.waypoints.length + ' GPS waypoints, ' + (stage.roadbook.boxes.length - stage.waypoints.length) + ' roadbook points).' +
        warnHtml(dw) + '<div class="sg-dim">Edit it like any stage: drag points, change types, re-route legs. Then make its roadbook.</div>' +
        '<div class="sg-cb"><button type="button" class="b p" data-sg="roadbook">Open the roadbook editor</button><button type="button" class="b" data-sg="again">Generate again</button></div></div>'
      progress(null); S.busy = false; render()
      return stage
    }).catch(function (e) { S.busy = false; progress(null); render(); setErr('Could not build the stage: ' + plainError(e)); return null })
  }

  // ------------------------------------------------------------------ blind mode: seal, hand out, verify
  function seal(SG, res) {
    progress(0.6, 'Sealing the stage (planning its off-piste legs without showing them)…')
    var io = makeIo(function (ph, d, t, m) { if (ph === 'detail') progress(0.6 + 0.35 * (t ? d / t : 0), 'Sealing the stage…') })
    var stage
    return SG.buildStage(res, res.options[0].index, io, { blind: true }).then(function (st) {
      stage = st
      return SG.seal(res, stage, io)
    }).then(function (out) {
      sealedStage = stage; sealedOut = out; rbPromise = null
      S.sealed = { warnings: (res.warnings || []).concat(detailWarnings(stage)), region: res.inputs.region || '', lengthKm: stage.lengthKm, want: res.inputs.lengthKm, preset: res.inputs.preset, commitment: out.commitment, stageId: stage.id, name: stage.name,
        lengthOk: Math.abs(stage.lengthKm - res.inputs.lengthKm) <= res.inputs.lengthKm * res.o.tolerance + 0.05, downloaded: {} }
      res = null   // the options (with their lines) are dropped here
      progress(null); S.busy = false; render(); renderBlind()
      return S.sealed
    })
  }
  function detailWarnings(stage) {
    var d = stage && stage.builder && stage.builder.stagegen && stage.builder.stagegen.detail
    return d && d.obstaclesFailed ? [{ code: 'obstacles', text: 'The detailed check for buildings, fences and trees near the route could not load (map servers slow), so parts of it follow the coarser map only. The roadbook generator checks again when it makes the roadbook.' }] : []   // no route details: this text also shows in blind mode
  }
  function warnHtml(ws) { return (ws || []).map(function (w) { return '<div class="sg-warn warn">&#9888; ' + esc(w.text) + '</div>' }).join('') }
  function renderBlind() {
    var b = S.sealed, box = $('#sg-blindout')
    if (!b) { box.innerHTML = ''; return }
    var dl = b.downloaded
    box.innerHTML = '<div class="sg-sealed"><div class="sg-lab">Sealed stage ready</div>' +
      '<div class="sg-big">' + esc(b.region || 'Unnamed region') + ' &middot; ' + b.lengthKm.toFixed(1) + ' km</div>' +
      '<div class="sg-dim">The route is hidden from you. Commitment <code title="' + esc(b.commitment) + '">' + esc(b.commitment.slice(7, 19)) + '…</code></div>' +
      warnHtml(b.warnings) +
      (b.lengthOk ? '' : '<div class="err">Its length is more than 10% off the ' + b.want + ' km you asked for. You may make a new one (this shows in neither file).</div>') +
      '<ol class="sg-handout">' +
      '<li><button type="button" class="b p" data-sg="pack">Download the sealed pack</button>' + (dl.pack ? ' <span class="ok">&#10003;</span>' : '') + '<div class="sg-dim">Zip with the stage file and its roadbook, for the drivers. Do not open it.</div></li>' +
      (window.RallyRaidShare ? '<li><button type="button" class="b" data-sg="link">Copy the sealed share link</button>' + (dl.link ? ' <span class="ok">&#10003;</span>' : '') + '<div class="sg-dim">The same stage as a link you can paste to the drivers without opening it.</div></li>' : '') +
      '<li><button type="button" class="b" data-sg="receipt">Download the receipt (public)</button>' + (dl.receipt ? ' <span class="ok">&#10003;</span>' : '') + '<div class="sg-dim">Publish this now, before the event.</div></li>' +
      '<li><button type="button" class="b" data-sg="seedfile">Download the seed file (keep private)</button>' + (dl.seed ? ' <span class="ok">&#10003;</span>' : '') + '<div class="sg-dim">Publish it only after the event, so everyone can verify.</div></li></ol>' +
      '<div class="sg-dim">Nothing is uploaded: the files exist only on this computer. <a href="#" data-sg="blind-help">Limits</a></div></div>'
  }
  function fileBase() { return (S.sealed && S.sealed.stageId) || 'stagegen' }
  function download(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 1000)
    lastDownloads.push({ name: name, bytes: blob.size })
  }
  var lastDownloads = []
  function jsonBlob(o) { return new Blob([JSON.stringify(o, null, 1)], { type: 'application/json' }) }
  // the roadbook of the sealed stage, made with the roadbook generator but never shown
  var rbPromise = null
  function sealedRoadbook() {
    if (!rbPromise) {
      var io = makeIo()
      rbPromise = window.RoadbookGen.generate(sealedStage, { density: window.StageGen.DEFAULTS.wp.density, osmOptional: true, overpassRace: true, overpassStatusCheck: true, fetchBytes: io.fetchBytes, fetchOverpass: io.fetchOverpass,
        onProgress: function (e) { var base = { terrain: 0, osm: 0.35, landmarks: 0.8, landcover: 0.9, assemble: 0.95, done: 1 }[e.phase] || 0, span = { terrain: 0.35, osm: 0.45, landmarks: 0.1, landcover: 0.05 }[e.phase] || 0; progress(base + span * (e.total ? e.done / e.total : 0), 'Making the sealed roadbook…') }
      }).catch(function (e) { rbPromise = null; return { failed: e.message || String(e) } })
    }
    return rbPromise
  }
  // a tiny store-only zip (no compression), enough for three small files
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
  function crc32(u) { var c = 0xFFFFFFFF; for (var i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  function zip(files) {
    var enc = new TextEncoder(), parts = [], central = [], off = 0, d = new Date()
    var dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data)
      var h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true)
      h.setUint16(10, dosT, true); h.setUint16(12, dosD, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true)
      var c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true)
      c.setUint16(12, dosT, true); c.setUint16(14, dosD, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true)
      parts.push(h.buffer, name, data); central.push(c.buffer, name); off += 30 + name.length + data.length
    })
    var csize = central.reduce(function (s, b) { return s + (b.byteLength) }, 0)
    var e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true)
    return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' })
  }
  function packReadme(rb, terrainOnly) {
    var b = S.sealed
    return ['Rally raid stage: ' + b.name, '', 'Region: ' + (b.region || '-'), 'Length: ' + b.lengthKm.toFixed(1) + ' km', '',
      'This stage was made by Stage-Gen in blind mode: the organizer set only the start, the finish, the length and the terrain,',
      'and did not see the route. The receipt published by the organizer has commitment',
      '  ' + b.commitment, 'and after the event the organizer publishes the seed file, so anyone can check this stage in the stage builder',
      '(Auto stage > Verify a blind stage).', '',
      'Files:', '  ' + fileBase() + '.stage.json     the stage: open it in the stage builder (Import) or use it in the game',
      rb ? '  ' + fileBase() + '.roadbook.json  its roadbook: open it in the roadbook editor (Import) to read, print or edit it'
        : '  (no roadbook: the map servers could not be reached when the pack was made; open the stage in the roadbook editor to make it)',
      terrainOnly ? '  (OpenStreetMap did not answer when the pack was made: the roadbook has terrain notes only; press "Regenerate, keep edits" in the roadbook editor to add junctions, villages and gates)' : '',
      '', 'Map data: OpenStreetMap contributors (ODbL). Terrain: Mapterhorn. Land cover: ESA WorldCover 2021 (CC BY 4.0).', ''].join('\r\n')
  }
  function downloadPack() {
    if (!sealedStage || S.busy) return Promise.resolve(null)
    S.busy = true; render(); progress(0.02, 'Making the sealed roadbook…')
    return sealedRoadbook().then(function (rb) {
      var ok = rb && !rb.failed, terrainOnly = ok && rb.partial === 'terrain-only'
      var files = [{ name: fileBase() + '.stage.json', data: JSON.stringify(sealedStage, null, 1) }]
      if (ok) files.push({ name: fileBase() + '.roadbook.json', data: JSON.stringify(rb, null, 1) })
      files.push({ name: 'README.txt', data: packReadme(ok, terrainOnly) })
      download(fileBase() + '.sealed.zip', zip(files))
      S.sealed.downloaded.pack = true; S.sealed.packHasRoadbook = ok; S.sealed.packRoadbookTerrainOnly = terrainOnly
      progress(null); S.busy = false; render(); renderBlind()
      if (terrainOnly) setErr('OpenStreetMap did not answer, so the roadbook in the pack has terrain notes only (no junctions, villages or gates). Try the pack again later, or the drivers can regenerate the roadbook from the stage.')
      if (!ok) setErr('The pack has the stage but no roadbook: the map servers did not answer (' + rb.failed + '). The drivers can make the roadbook from the stage.')
      return files.map(function (f) { return f.name })
    })
  }
  function copySealedLink() {
    var Share = window.RallyRaidShare; if (!Share || !sealedStage) return Promise.resolve(null)
    var info = Share.linkFor(Share.pageUrl('stage'), Share.packStage(sealedStage))
    return Share.shareOrCopy(info, { title: sealedStage.name, text: 'Rally raid stage: ' + sealedStage.name }).then(function (r) {
      if (r && !r.cancelled) { S.sealed.downloaded.link = true; renderBlind() }
      return { length: info.length, result: r }
    })
  }
  function readJsonFile(input) {
    var f = input.files && input.files[0]; if (!f) return Promise.resolve(null)
    return f.text().then(function (t) { try { return JSON.parse(t) } catch (e) { throw new Error(f.name + ' is not a JSON file.') } })
  }
  function verifyFiles(receipt, seedFile, stage) {
    var out = $('#sg-v-out'); out.innerHTML = '<div class="sg-dim">Regenerating the stage from the seed… (this needs the terrain tiles, so it can take a minute)</div>'
    var t0 = Date.now()
    return loadLibs().then(function (SG) {
      if (!receipt || !seedFile) throw new Error('Choose the receipt and the seed file.')
      return SG.verify(receipt, seedFile, makeIo()).then(function (r) {
        if (!stage) return r
        return SG.matchesReceipt(stage, receipt).then(function (m) { r.checks.push({ ok: m, what: 'The stage file you gave is exactly the sealed stage' }); r.ok = r.ok && m; return r })
      })
    }).then(function (r) {
      out.innerHTML = '<div class="sg-vres ' + (r.ok ? 'ok' : 'err') + '"><b>' + (r.ok ? 'Verified: the stage is exactly what the seed makes.' : 'Not verified.') + '</b><ul>' +
        r.checks.map(function (c) { return '<li class="' + (c.ok ? 'ok' : 'err') + '">' + (c.ok ? '&#10003; ' : '&#10007; ') + esc(c.what) + '</li>' }).join('') + '</ul>' +
        '<div class="sg-dim">' + ((Date.now() - t0) / 1000).toFixed(1) + ' s</div></div>'
      return { ok: r.ok, checks: r.checks }
    }).catch(function (e) { out.innerHTML = '<div class="err">' + esc(e.message || e) + '</div>'; return { ok: false, error: e.message } })
  }

  // ------------------------------------------------------------------ events
  openBtn.addEventListener('click', function () { openPanel(!S.open) })
  var down = null
  mapwrap.addEventListener('pointerdown', function (e) { down = S.placing ? [e.clientX, e.clientY] : null }, true)
  // while placing, a click / tap on the map sets the point and nothing else sees it (not the builder, not mobile.js)
  mapwrap.addEventListener('click', function (e) {
    if (!S.placing) return
    if (!e.target.closest('#map') || e.target.closest('.leaflet-control, .leaflet-popup')) return
    e.stopPropagation(); e.preventDefault()
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 8) return   // that was a drag of the map
    var ll = lmap.mouseEventToLatLng(e).wrap(), p = [+ll.lat.toFixed(6), +ll.lng.toFixed(6)], which = S.placing
    changed(); S[which] = p
    if (which === 'dss') guessRegion(p)
    if (which === 'dss' && !S.ass) { setPlacing('ass'); return }
    setPlacing(null)
    if (S.dss && S.ass) { var straight = haversine(S.dss, S.ass) / 1000; if (S.lengthKm < straight * 1.15) { S.lengthKm = Math.ceil(straight * 1.6 / 5) * 5; render() } }
  }, true)
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (!helpBox.hidden) helpBox.hidden = true; else if (S.placing) setPlacing(null) } })
  function onAction(e) {
    var t = e.target.closest('[data-sg], [data-preset], [data-use], [data-opt]'); if (!t) return
    if (t.dataset.preset) { if (S.busy) return; changed(); S.preset = t.dataset.preset; S.off = PRESETS[S.preset].off; render(); return }
    if (t.dataset.use) { e.stopPropagation(); useOption(+t.dataset.use); return }
    if (t.dataset.opt && !e.target.closest('button')) { selectOption(+t.dataset.opt); return }
    var a = t.dataset.sg; if (!a) return
    if (t.tagName === 'A') e.preventDefault()
    if (a === 'close') openPanel(false)
    else if (a === 'place-dss') setPlacing(S.placing === 'dss' ? null : 'dss')
    else if (a === 'place-ass') setPlacing(S.placing === 'ass' ? null : 'ass')
    else if (a === 'cancel-place') setPlacing(null)
    else if (a === 'from-builder') { if (!prefillFromBuilder(false)) setErr('The stage in the builder has no DSS and ASS yet.'); else { setErr(''); render(); fitAll([S.dss, S.ass]) } }
    else if (a === 'reseed') { changed(); S.seed = newSeed(); render() }
    else if (a === 'generate') generate()
    else if (a === 'roadbook') { if (window.RallyRaidBuilder) window.RallyRaidBuilder.openRoadbook() }
    else if (a === 'again') { $('#sg-opts').innerHTML = ''; S.used = null; generate() }
    else if (a === 'pack') downloadPack()
    else if (a === 'link') copySealedLink()
    else if (a === 'receipt') { download(fileBase() + '.receipt.json', jsonBlob(sealedOut.receipt)); S.sealed.downloaded.receipt = true; renderBlind() }
    else if (a === 'seedfile') { download(fileBase() + '.seed.json', jsonBlob(sealedOut.seedFile)); S.sealed.downloaded.seed = true; renderBlind() }
    else if (a === 'blind-help') helpBox.hidden = false
    else if (a === 'help-close') helpBox.hidden = true
    else if (a === 'verify') Promise.all([readJsonFile($('#sg-v-receipt')), readJsonFile($('#sg-v-seed')), readJsonFile($('#sg-v-stage'))]).then(function (f) { return verifyFiles(f[0], f[1], f[2]) }).catch(function (er) { $('#sg-v-out').innerHTML = '<div class="err">' + esc(er.message) + '</div>' })
  }
  panel.addEventListener('click', onAction); placeBar.addEventListener('click', onAction); helpBox.addEventListener('click', function (e) { if (e.target === helpBox) helpBox.hidden = true; else onAction(e) })
  panel.addEventListener('keydown', function (e) { var c = e.target.closest('[data-opt]'); if (c && (e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); selectOption(+c.dataset.opt) } })
  $('#sg-len').addEventListener('change', function () { var v = +this.value; if (v > 0) { changed(); S.lengthKm = Math.round(v * 10) / 10 } render() })
  $('#sg-off').addEventListener('input', function () { changed(); S.off = +this.value; render() })
  $('#sg-region').addEventListener('input', function () { changed(); S.region = this.value; S.regionTouched = true })
  $('#sg-seed').addEventListener('change', function () { changed(); S.seed = this.value.trim() || newSeed(); render() })
  $('#sg-blind').addEventListener('change', function () { changed(); S.blind = this.checked; render() })
  // on a phone the map (#mapwrap) is position:fixed, a stacking context under the builder's bottom sheet, so the panel
  // and the placing bar live in <body> there, and next to the map on a desktop
  function placeDom() {
    var host = isMobile() ? document.body : mapwrap
    if (panel.parentNode !== host) host.appendChild(panel)
    if (placeBar.parentNode !== host) host.appendChild(placeBar)
  }
  placeDom()
  if (window.matchMedia) { var mq = window.matchMedia(MOBILE_QUERY); if (mq.addEventListener) mq.addEventListener('change', placeDom); else if (mq.addListener) mq.addListener(placeDom) }
  // keep Leaflet from panning / zooming the map through the panel
  if (L.DomEvent) { L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel); L.DomEvent.disableClickPropagation(placeBar) }
  render()

  // ------------------------------------------------------------------ API (tests, and later the in-game planner bridge)
  var API = window.RallyRaidStageGen = {
    version: VERSION,
    open: function (on) { openPanel(on !== false) },
    set: function (o) { changed(); ['dss', 'ass', 'lengthKm', 'preset', 'region', 'seed', 'blind'].forEach(function (k) { if (o[k] !== undefined) S[k] = o[k] }); if (o.preset && o.off === undefined) S.off = PRESETS[o.preset].off; if (o.off !== undefined) S.off = o.off; if (o.region !== undefined) S.regionTouched = true; render() },
    generate: generate,
    select: selectOption,
    use: useOption,
    downloadPack: downloadPack, copySealedLink: copySealedLink,
    verify: verifyFiles,
    // what the page knows; in blind mode only the region, length and commitment (never the route)
    state: function () {
      var r = S.res
      return { open: S.open, placing: S.placing, dss: S.dss, ass: S.ass, lengthKm: S.lengthKm, preset: S.preset, off: S.off, region: S.region, blind: S.blind, busy: S.busy, seed: S.blind ? null : S.seed,
        timings: S.timings, used: S.used, net: Object.assign({}, netStats), downloads: lastDownloads.slice(),
        sealed: S.sealed ? JSON.parse(JSON.stringify(S.sealed)) : null,
        options: r ? r.options.map(function (op) { return { id: op.id, shape: op.shape, stats: op.stats, summary: op.summary, overlap: op.overlap, lines: op.lines } }) : null,
        region: r ? r.region : undefined, dataHash: r ? r.dataHash : undefined }
    }
  }
})()
