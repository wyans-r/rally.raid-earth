/* mobile.js - phone helpers for the Rally Raid Stage Builder site (index.html, roadbook.html).
 * Loaded last on each page. It never changes how the page works on desktop: every control it adds
 * is hidden by mobile.css above 900 px, and every behaviour below checks isMobile() first.
 * It only reads the pages' existing public bits (window.map, window.curType, window.tipHtml, window.GUIDE,
 * element ids), so the roadbook scripts (roadbook-*.js) are untouched.
 *
 * Stage builder: the side panel becomes a bottom sheet (portrait) or a left drawer (landscape) with three
 *   sizes (peek / half / full); a floating "Add points" switch so panning and looking at the map can't
 *   drop points by accident; tapping a pin opens its editor; long-press (or tapping a type button) shows
 *   the help tips that are hover-only on desktop.
 * Roadbook: a Boxes / Map / Box bar shows one view at a time; editing tools go behind "More". */
(function () {
  'use strict'
  var MOBILE_QUERY = '(max-width: 900px), (max-height: 500px) and (pointer: coarse)'   // keep in sync with mobile.css
  var mq = window.matchMedia(MOBILE_QUERY)
  function isMobile() { return mq.matches }
  function $(s) { return document.querySelector(s) }
  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e }
  function kickMap() { requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')) }) }   // Leaflet re-measures on resize

  // ------------------------------------------------------------------ tap / long-press tips (all pages)
  var tip = el('div', { id: 'rr-tip', role: 'tooltip' }); document.body.appendChild(tip)   // (pointer-events: none in mobile.css)
  var tipTimer = null
  function tipContent(t) {
    if (t.dataset.tip && window.GUIDE && window.GUIDE[t.dataset.tip] && typeof window.tipHtml === 'function') return window.tipHtml(t.dataset.tip)
    var s = t.getAttribute('title') || t.getAttribute('data-rr-title') || t.getAttribute('aria-label')
    if (!s) return ''
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML
  }
  function showTip(t, ms) {
    var h = tipContent(t); if (!h) return
    tip.innerHTML = h; tip.style.display = 'block'
    var r = t.getBoundingClientRect(), w = tip.offsetWidth, hh = tip.offsetHeight
    var x = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), innerWidth - w - 6)
    var y = r.top - hh - 8; if (y < 6) y = r.bottom + 8
    tip.style.left = x + 'px'; tip.style.top = Math.min(y, innerHeight - hh - 6) + 'px'
    clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, ms || 4500)
  }
  function hideTip() { tip.style.display = 'none'; clearTimeout(tipTimer) }
  // the browser drops title="" tooltips on touch: keep a copy so long-press can show it
  var press = null
  document.addEventListener('pointerdown', function (e) {
    if (e.target !== tip) hideTip()
    if (e.pointerType !== 'touch' || !isMobile()) return
    var t = e.target.closest && e.target.closest('[data-tip], [title], [data-rr-title]')
    if (!t) return
    var x0 = e.clientX, y0 = e.clientY
    press = { t: t, x: x0, y: y0, timer: setTimeout(function () { press.fired = true; showTip(t, 6000) }, 480) }
  }, true)
  document.addEventListener('pointermove', function (e) { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null } }, true)
  document.addEventListener('pointerup', function () { if (press) clearTimeout(press.timer); press = null }, true)
  document.addEventListener('pointercancel', function () { if (press) clearTimeout(press.timer); press = null }, true)
  document.addEventListener('contextmenu', function (e) { if (isMobile() && tip.style.display === 'block') e.preventDefault() }, true)

  // ================================================================== STAGE BUILDER (index.html)
  var side = $('#side'), mapwrap = $('#mapwrap')
  if (side && mapwrap && $('#app')) {
    var body = document.body
    var hasExample = /[?&]example=/.test(location.search)
    body.dataset.sheet = 'peek'
    function setSheet(s) { body.dataset.sheet = s; measure(); kickMap() }
    var mapBottom = -1
    function measure() {
      // how much of the screen the sheet covers. Portrait: the map ends where the collapsed ("peek") sheet
      // starts, so "fit the stage" and pins are never hidden behind it; a bigger sheet slides over the map.
      var land = window.matchMedia('(orientation: landscape)').matches, root = document.documentElement.style
      var h = isMobile() && !land ? Math.round(side.getBoundingClientRect().height) : 0
      if (body.dataset.sheet === 'peek' || !h) {
        if (h !== mapBottom) { mapBottom = h; root.setProperty('--rr-map-bottom', h + 'px'); if (window.map && window.map.invalidateSize) window.map.invalidateSize() }
      }
      root.setProperty('--rr-sheet-h', h + 'px')
      root.setProperty('--rr-sheet-over', Math.max(0, h - Math.max(0, mapBottom)) + 'px')
    }
    if (window.ResizeObserver) new ResizeObserver(measure).observe(side)
    window.addEventListener('resize', measure)
    if (mq.addEventListener) mq.addEventListener('change', function () { measure(); kickMap() })

    // grab handle at the top of the sheet: tap = next size, swipe up / down = bigger / smaller
    var handle = el('button', { id: 'rr-sheet-handle', class: 'rr-m-only', type: 'button', 'aria-label': 'Resize the panel', 'data-rr-title': 'Tap or swipe to resize the panel' }, '<span></span>')
    side.insertBefore(handle, side.firstChild)
    var ORDER = ['peek', 'half', 'full'], sy = null
    function step(d) { var i = ORDER.indexOf(body.dataset.sheet); setSheet(ORDER[Math.max(0, Math.min(2, i + d))]) }
    handle.addEventListener('pointerdown', function (e) { sy = e.clientY })
    handle.addEventListener('pointerup', function (e) {
      if (sy == null) return
      var dy = e.clientY - sy; sy = null
      if (window.matchMedia('(orientation: landscape)').matches) { setSheet('peek'); return }   // landscape: the handle is "Hide panel"
      if (dy < -30) step(+1); else if (dy > 30) step(-1)
      else setSheet(body.dataset.sheet === 'full' ? 'peek' : ORDER[ORDER.indexOf(body.dataset.sheet) + 1])
    })
    // a swipe down on the header of a sheet also shrinks it
    var hdr = side.querySelector('header'), hy = null
    if (hdr) {
      hdr.addEventListener('touchstart', function (e) { hy = e.touches[0].clientY }, { passive: true })
      hdr.addEventListener('touchend', function (e) { if (hy == null) return; var dy = e.changedTouches[0].clientY - hy; hy = null; if (Math.abs(dy) > 40) step(dy > 0 ? -1 : +1) }, { passive: true })
    }
    // landscape: a button to bring the drawer back
    var pbtn = el('button', { id: 'rr-panelbtn', class: 'rr-m-only', type: 'button' }, '&#9776; Panel')
    pbtn.addEventListener('click', function () { setSheet('half') })
    document.body.appendChild(pbtn)

    // opening a tab, Examples or the guide from the peek state makes room for it
    side.addEventListener('click', function (e) {
      if (!isMobile() || !e.isTrusted) return   // only real taps (index.html also "clicks" tabs from code, e.g. after loading an example)
      if (e.target.closest('.tabs button') && body.dataset.sheet === 'peek') setSheet('half')
      if (e.target.closest('#ex-open, #ex-hint-go')) setSheet('full')
      // picking an example: shrink the sheet so the stage is visible on the map
      if (e.target.closest('.ex-card')) setTimeout(function () { setSheet('peek') }, 250)
      // tapping a row in the point list: bring its editor (below the list) into view
      var row = e.target.closest('#list .pt')
      if (row && !e.target.closest('button')) setTimeout(function () { var ed = $('#editor'); if (ed && ed.firstChild) ed.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, 60)
    })

    // ---- "Add points" switch: on a phone a tap on the map only adds a point when this is on
    var addbar = el('div', { id: 'rr-addbar', class: 'rr-m-only' },
      '<button type="button" id="rr-type" data-rr-title="Point type for the next tap. Tap to change it.">DSS</button>' +
      '<button type="button" id="rr-add" aria-pressed="false">&#43; Add points</button>')
    document.body.appendChild(addbar)
    var addBtn = $('#rr-add'), typeBtn = $('#rr-type')
    var adding = false
    function setAdding(on) {
      adding = on; addBtn.classList.toggle('on', on); typeBtn.classList.toggle('on', on)
      addBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
      addBtn.innerHTML = on ? 'Adding &middot; tap map' : '&#43; Add points'
      syncType()
    }
    function syncType() {
      var t = window.curType || 'DSS'
      if (typeBtn.textContent !== t) typeBtn.textContent = t
      var c = window.TYPES && window.TYPES[t] ? window.TYPES[t].color : '#ffd400'
      typeBtn.style.background = c; typeBtn.style.borderColor = c
    }
    addBtn.addEventListener('click', function () { setAdding(!adding); if (adding && body.dataset.sheet === 'full') setSheet('peek') })
    typeBtn.addEventListener('click', function () {
      var p = document.querySelector('.tabs button[data-tab="plot"]'); if (p) p.click()
      setSheet('half'); var tb = $('#typebtns'); if (tb) tb.scrollIntoView({ block: 'start' })
    })
    setInterval(syncType, 500)
    // start in "add" mode for an empty new stage, in "look" mode when a stage (or an example) is already there
    setTimeout(function () {
      var stg = window.RallyRaidBuilder && window.RallyRaidBuilder.state()
      setAdding(!hasExample && !(stg && stg.points && stg.points.length))
    }, 0)

    // capture taps on the map before Leaflet sees them
    mapwrap.addEventListener('click', function (e) {
      if (!isMobile()) return
      var onPin = e.target.closest('.leaflet-marker-icon')
      if (onPin) {
        // a tap on a pin selects it (index.html does that); open the panel on its editor
        setTimeout(function () {
          var p = document.querySelector('.tabs button[data-tab="plot"]'); if (p && !p.classList.contains('on')) p.click()
          if (body.dataset.sheet === 'peek') setSheet('half')
          var ed = $('#editor'); if (ed && ed.firstChild) ed.scrollIntoView({ block: 'start' })
        }, 60)
        return
      }
      if (adding) return
      if (!e.target.closest('#map') || e.target.closest('.leaflet-control, .leaflet-popup')) return
      e.stopPropagation()   // look-only mode: the tap pans / closes things but adds nothing
      if (typeof window.status === 'function') try { window.status('Look mode: turn on "+ Add points" (bottom right) to place points.') } catch (er) {}
    }, true)

    // tapping a type button: select it (as on desktop) and show what that type means
    document.addEventListener('click', function (e) {
      if (!isMobile()) return
      var b = e.target.closest('#typebtns button[data-tip]')
      if (b) setTimeout(function () { showTip(b, 3500) }, 0)
    })
    // a stray mouse-emulated hover tip from index.html is not useful on touch
    document.addEventListener('touchend', function () { var t = $('#tip'); if (t) t.style.display = 'none' }, { passive: true })

    measure()
  }

  // ================================================================== ROADBOOK (roadbook.html)
  var rbe = $('#rbe'), main = $('#main')
  if (rbe && main) {
    var b2 = document.body
    var bar = el('nav', { id: 'rr-rbviews', class: 'rr-m-only', 'aria-label': 'Roadbook view' },
      '<button type="button" data-v="list" class="on">Boxes</button><button type="button" data-v="map">Map</button><button type="button" data-v="detail">Box details</button>')
    main.parentNode.insertBefore(bar, main)
    function setView(v) {
      b2.dataset.rbview = v
      bar.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.v === v) })
      if (v === 'map') kickMap()
    }
    bar.addEventListener('click', function (e) { var x = e.target.closest('button[data-v]'); if (x) setView(x.dataset.v) })
    // nothing loaded yet: show the map view, which holds the "open a stage / example" box
    var empty = $('#empty'), auto = false
    function checkEmpty() {
      if (!empty) return
      if (!empty.hidden && b2.dataset.rbview !== 'map') { auto = true; setView('map') }
      else if (empty.hidden && auto) { auto = false; setView('list') }
    }
    setView('list'); checkEmpty()
    if (empty) new MutationObserver(checkEmpty).observe(empty, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    // tapping a box in the list (or the printed strip) opens its details; "Boxes" goes back
    var lst = $('#list')
    if (lst) lst.addEventListener('click', function (e) { if (isMobile() && e.target.closest('.row, tr') && !e.target.closest('input, select, button, a')) setTimeout(function () { setView('detail'); var r = $('#right'); if (r) r.scrollTop = 0 }, 60) })
    // tapping a box on the map opens its details
    var mw = $('#mapwrap')
    if (mw) mw.addEventListener('click', function (e) { if (isMobile() && e.target.closest('.leaflet-marker-icon .bx, .leaflet-marker-icon')) setTimeout(function () { if ($('#p-km') || $('#panel h3')) setView('detail') }, 80) })
    // "More" reveals the editing tools (generate, density, recce, undo / redo)
    var top = $('#top'), ttl = top && top.querySelector('.ttl')
    if (top && ttl) {
      var more = el('button', { id: 'rr-more', class: 'b rr-m-only', type: 'button', 'aria-expanded': 'false' }, 'More &#9662;')
      ttl.after(more)
      more.addEventListener('click', function () { var on = b2.classList.toggle('rr-rb-more'); more.setAttribute('aria-expanded', on ? 'true' : 'false'); more.innerHTML = on ? 'Less &#9652;' : 'More &#9662;' })
    }
    if (mq.addEventListener) mq.addEventListener('change', kickMap)
  }

  // ================================================================== MAP LAYER PICKER (index.html and roadbook.html)
  // On a phone, Leaflet leaves the radio list open after you pick a layer (until you tap the map),
  // and a leftover hover can open it again the moment we close it. Collapse it on the choice and
  // ignore expand-on-hover for a short moment afterwards.
  var layerLockUntil = 0, layerWasOpen = false
  function layerBox(n) { return n && n.closest ? n.closest('.leaflet-control-layers') : null }
  function closeLayerBox(box) {
    if (!box) return
    layerLockUntil = Date.now() + 500
    setTimeout(function () { box.classList.remove('leaflet-control-layers-expanded') }, 0)
  }
  document.addEventListener('pointerdown', function (e) {
    if (!isMobile()) return
    var box = layerBox(e.target)
    layerWasOpen = !!(box && box.classList.contains('leaflet-control-layers-expanded'))
  }, true)
  document.addEventListener('change', function (e) {
    if (!isMobile()) return
    var t = e.target
    if (!t || !t.matches || !t.matches('.leaflet-control-layers input, .leaflet-control-layers-selector')) return
    closeLayerBox(layerBox(t))
  }, true)
  document.addEventListener('click', function (e) {
    if (!isMobile()) return
    var label = e.target.closest && e.target.closest('.leaflet-control-layers label')
    // a leftover click from the tap that opened the list can land on a label once it expands;
    // only close if the list was already open when the finger went down
    if (label && layerWasOpen) { closeLayerBox(layerBox(label)); return }
    if (Date.now() < layerLockUntil) {
      var link = e.target.closest && e.target.closest('.leaflet-control-layers-toggle')
      if (link) { e.stopImmediatePropagation(); e.preventDefault() }
    }
  }, true)
  document.addEventListener('mouseenter', function (e) {
    if (!isMobile() || Date.now() >= layerLockUntil) return
    if (layerBox(e.target)) e.stopImmediatePropagation()
  }, true)
})()
