/* B19 helpers for the Rally Raid Stage Builder: Route-type labels, auto name /
 * description from real Nominatim places + length / surface / land cover, and
 * forest-stretch warnings (ESA WorldCover, same classes Stage-Gen uses).
 * Loaded by index.html. Also runnable from Node for unit tests.
 */
(function (root) {
  'use strict'

  function isNoteType(t) { return t === 'NOTE' || t === 'ROUTE' }
  // stored value in stage files stays NOTE (hashes / exports stay compatible)
  function storedType(t) {
    var u = String(t || '').toUpperCase()
    return u === 'ROUTE' ? 'NOTE' : u
  }
  function uiTypeLabel(t) { return isNoteType(t) ? 'ROUTE' : String(t || '') }
  function uiPointLabel(p) {
    if (!p) return ''
    if (isNoteType(p.type)) return 'ROUTE'
    return p.type + (p.type === 'DSS' || p.type === 'ASS' ? '' : (p._n != null ? ' ' + p._n : ''))
  }

  // ------------------------------------------------------------------ name + description (pure; only uses names the caller supplied)
  var PLACE_KEYS = ['hamlet', 'village', 'town', 'city', 'municipality', 'isolated_dwelling', 'locality', 'suburb', 'neighbourhood', 'city_district', 'croft']
  var FEATURE_KEYS = ['natural', 'sand', 'desert', 'peak', 'valley', 'ridge', 'cape', 'island', 'archipelago', 'peninsula']

  function firstOf(obj, keys) {
    if (!obj) return ''
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]]
      if (v && String(v).trim()) return String(v).trim()
    }
    return ''
  }

  /** Pull a place name and a region line out of a Nominatim reverse (or search) result. Nothing is invented. */
  function placeFromNominatim(j) {
    if (!j) return null
    var a = j.address || {}
    var name = firstOf(a, PLACE_KEYS) || (j.name && !/^\d/.test(j.name) ? String(j.name).trim() : '')
    var feature = firstOf(a, FEATURE_KEYS)
    var regionParts = [a.county, a.state, a.country].filter(function (x) { return x && String(x).trim() })
    // drop the place itself if it was also listed as county
    regionParts = regionParts.filter(function (x) { return x !== name && x !== feature })
    return {
      name: name || '',
      feature: feature && feature !== name ? feature : '',
      region: regionParts.join(', '),
      display: j.display_name || ''
    }
  }

  function uniqueNames(list) {
    var out = [], seen = {}
    ;(list || []).forEach(function (s) {
      var t = String(s || '').trim()
      if (!t) return
      var k = t.toLowerCase()
      if (seen[k]) return
      seen[k] = true
      out.push(t)
    })
    return out
  }

  function distinctiveOf(place) {
    if (!place) return ''
    return place.name || place.feature || ''
  }

  /**
   * opts: { region, start, mid, end, lengthKm }
   * start/mid/end are placeFromNominatim results (or null).
   * Returns { name, description } — name may be '' if no real place or region is known.
   */
  function composeName(opts) {
    opts = opts || {}
    var start = distinctiveOf(opts.start)
    var end = distinctiveOf(opts.end)
    var mid = distinctiveOf(opts.mid)
    var region = String(opts.region || '').trim()
    if (!region) {
      var r = (opts.start && opts.start.region) || (opts.end && opts.end.region) || (opts.mid && opts.mid.region) || ''
      region = r
    }
    var name = ''
    if (start && end && start.toLowerCase() !== end.toLowerCase()) name = start + ' to ' + end
    else if (start) name = start
    else if (end) name = end
    else if (mid) name = mid
    else if (region) {
      // use the most local part of the region (before the first comma) — still a real name
      name = region.split(',')[0].trim()
    }
    return name
  }

  function coverWords(mix) {
    // mix: { trees, bush, grass, crop, bare, built, water, wet, snow, moss, unknown } counts
    var labels = { trees: 'forest', bush: 'scrub', grass: 'grass', crop: 'fields', bare: 'bare ground', built: 'built-up land', water: 'water', wet: 'marsh', snow: 'snow', moss: 'moss' }
    var total = 0, parts = []
    Object.keys(mix || {}).forEach(function (k) { if (k !== 'unknown') total += mix[k] || 0 })
    if (!total) return ''
    Object.keys(labels).forEach(function (k) {
      var n = mix[k] || 0
      if (n / total >= 0.08) parts.push({ k: k, pct: Math.round(n / total * 100), label: labels[k] })
    })
    parts.sort(function (a, b) { return b.pct - a.pct })
    parts = parts.slice(0, 4)
    if (!parts.length) return ''
    if (parts.length === 1) return 'mostly ' + parts[0].label
    var last = parts.pop()
    return parts.map(function (p) { return p.pct + '% ' + p.label }).join(', ') + ' and ' + last.pct + '% ' + last.label
  }

  function surfaceWords(legs) {
    // legs: [{ mode, km, via, failed, cover }]
    var km = { road: 0, track: 0, gpx: 0, direct: 0 }
    ;(legs || []).forEach(function (l) {
      var m = l && l.mode, k = +l.km || 0
      if (m === 'gpx' || (m === 'track' && l.via === 'gpx')) km.gpx += k
      else if (m === 'track') km.track += k
      else if (m === 'road' && !l.failed) km.road += k
      else km.direct += k
    })
    var parts = []
    if (km.track >= 0.05) parts.push(fmtKm(km.track) + ' of tracks and paths')
    if (km.gpx >= 0.05) parts.push(fmtKm(km.gpx) + ' along a loaded GPX track')
    if (km.road >= 0.05) parts.push(fmtKm(km.road) + ' of roads')
    if (km.direct >= 0.05) parts.push(fmtKm(km.direct) + ' off-piste (straight or open terrain)')
    if (!parts.length) return ''
    if (parts.length === 1) return 'The route is ' + parts[0] + '.'
    var last = parts.pop()
    return 'The route is ' + parts.join(', ') + ' and ' + last + '.'
  }

  function fmtKm(n) {
    if (n == null || !isFinite(n)) return ''
    var x = Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1)
    return x + ' km'
  }

  function composeDescription(opts) {
    opts = opts || {}
    var bits = []
    var length = opts.lengthKm != null && isFinite(opts.lengthKm) ? fmtKm(opts.lengthKm) : ''
    var region = String(opts.region || '').trim()
    if (!region) region = (opts.start && opts.start.region) || (opts.end && opts.end.region) || ''
    var start = distinctiveOf(opts.start)
    var end = distinctiveOf(opts.end)
    var head = length ? (length + ' stage') : 'Stage'
    if (region) head += ' in ' + region
    head += '.'
    bits.push(head)
    if (start && end && start.toLowerCase() !== end.toLowerCase()) bits.push('It starts near ' + start + ' and finishes near ' + end + '.')
    else if (start) bits.push('It is near ' + start + '.')
    else if (end) bits.push('It finishes near ' + end + '.')
    var surf = surfaceWords(opts.legs)
    if (surf) bits.push(surf)
    var cover = coverWords(opts.coverMix)
    if (cover) bits.push('Land cover along the line is ' + cover + '.')
    return bits.join(' ')
  }

  function composeMeta(opts) {
    return { name: composeName(opts), description: composeDescription(opts) }
  }

  // ------------------------------------------------------------------ forest problems (pure; cover values supplied by the caller)
  // A sample: { lat, lon, km, legIndex, onMapped, cover }  cover is an LC_GROUP value ('trees', 'bare', ...)
  // A side probe: { stretchId, side: 'left'|'right', cover }
  var FOREST_GROUPS = { trees: true }
  var MIN_FOREST_M = 200   // shorter tree patches are not "heavy vegetation"

  function isForestCover(g) { return g === 'trees' }

  /**
   * Find heavy forest stretches that are not on a mapped road/track, and say whether
   * open ground appears to the left or right (side samples already taken by the caller).
   * samples must be in km order along the route. sideSamples: [{ i, side, cover }]
   *   i = sample index at which the side probe was taken.
   * waypoints: [{ i (sample index or closest), label, onMapped, cover }]
   */
  function findForestProblems(samples, sideSamples, waypoints, opts) {
    opts = opts || {}
    var minM = opts.minForestM != null ? opts.minForestM : MIN_FOREST_M
    var out = []
    var N = (samples || []).length
    if (!N) return out

    // same consecutive leg? (do not join a stretch across a waypoint — warnings must name current neighbours)
    function sameLeg(a, b) {
      if (!a || !b) return false
      if (a.legIndex != null && b.legIndex != null && a.legIndex !== 0 && b.legIndex !== 0) return a.legIndex === b.legIndex
      if (a.fromLabel && b.fromLabel && a.toLabel && b.toLabel) return a.fromLabel === b.fromLabel && a.toLabel === b.toLabel
      return true
    }
    // contiguous off-mapped forest runs, split at each waypoint / leg change
    var runs = []
    for (var i = 0; i < N;) {
      if (!isForestCover(samples[i].cover) || samples[i].onMapped) { i++; continue }
      var j = i
      while (j + 1 < N && isForestCover(samples[j + 1].cover) && !samples[j + 1].onMapped && sameLeg(samples[j], samples[j + 1])) j++
      runs.push({ a: i, b: j })
      i = j + 1
    }
    // merge runs separated by a tiny gap (< 80 m) so a one-pixel hole doesn't split a forest,
    // but never across a waypoint (that would name two points that are not direct neighbours)
    for (var r = 1; r < runs.length; r++) {
      var gapKm = (samples[runs[r].a].km - samples[runs[r - 1].b].km)
      if (gapKm >= 0 && gapKm * 1000 < 80 && sameLeg(samples[runs[r - 1].b], samples[runs[r].a])) { runs[r - 1].b = runs[r].b; runs.splice(r, 1); r-- }
    }

    function sidesAt(a, b) {
      var left = false, right = false
      ;(sideSamples || []).forEach(function (s) {
        if (s.i < a || s.i > b) return
        if (s.cover && !isForestCover(s.cover) && s.cover !== 'water' && s.cover !== 'wet') {
          if (s.side === 'left') left = true
          if (s.side === 'right') right = true
        }
      })
      return { left: left, right: right }
    }

    function fromLabel(run) {
      var s = samples[run.a]
      return (s && s.fromLabel) || (s && s.label) || 'the previous point'
    }
    function toLabel(run) {
      var s = samples[run.b]
      return (s && s.toLabel) || (s && s.label) || 'the next point'
    }

    runs.forEach(function (run) {
      var a = samples[run.a], b = samples[run.b]
      var lenM = Math.max(0, (b.km - a.km) * 1000)
      // include one sample step if only one point
      if (lenM < 1 && run.a === run.b) lenM = (opts.stepM || 50)
      if (lenM < minM) return
      var side = sidesAt(run.a, run.b)
      var kmTxt = lenM >= 950 ? ((lenM / 1000).toFixed(1) + ' km') : (Math.round(lenM) + ' m')
      var where = 'The line from ' + fromLabel(run) + ' to ' + toLabel(run) + ' goes through about ' + kmTxt + ' of forest, with no mapped track or road along this line'
      var around
      if (side.left && side.right) around = 'There looks to be open ground to the left and the right, if you want to bend the line around the trees.'
      else if (side.left) around = 'There looks to be open ground to the left, if you want to bend the line around the trees.'
      else if (side.right) around = 'There looks to be open ground to the right, if you want to bend the line around the trees.'
      else around = 'The ground to either side is also trees, so there does not appear to be a way through or around.'
      out.push({
        kind: 'leg', level: (side.left || side.right) ? 'warn' : 'warn',
        blocked: !(side.left || side.right),
        text: where + '. ' + around,
        fromKm: a.km, toKm: b.km, a: run.a, b: run.b,
        points: samples.slice(run.a, run.b + 1).map(function (s) { return [s.lat, s.lon] })
      })
    })

    // waypoints sitting in forest, not on a mapped way, and not already inside a warned stretch
    ;(waypoints || []).forEach(function (w) {
      if (!w || !isForestCover(w.cover) || w.onMapped) return
      var inside = out.some(function (p) {
        if (w.km != null && p.fromKm != null && w.km >= p.fromKm - 0.05 && w.km <= p.toKm + 0.05) return true
        // already covered by a warned stretch that starts or ends at this point
        var labs = (p.text || '')
        return w.label && labs.indexOf(w.label) !== -1
      })
      if (inside) return
      out.push({
        kind: 'waypoint', level: 'warn', blocked: true,
        text: (w.label || 'A waypoint') + ' sits in forest, with no mapped track or road at this point.',
        fromKm: w.km, toKm: w.km,
        points: w.lat != null ? [[w.lat, w.lon]] : []
      })
    })
    return out
  }

  /**
   * Tag each vertex of a leg polyline as on a mapped way or not.
   * leg: { mode, via, failed, points, cover: { gaps: [[fromIdx, toIdx], ...] } }
   * Returns boolean per vertex (same length as points).
   */
  function mappedMask(leg) {
    if (!leg || !leg.points || !leg.points.length) return []
    var n = leg.points.length, out = new Array(n), i
    var mode = leg.mode
    var on
    if (mode === 'gpx' || leg.via === 'gpx') on = true
    else if (mode === 'road' && !leg.failed) on = true
    else if (mode === 'track' && !leg.failed && !(leg.cover && !leg.cover.onKm && !leg.via)) on = true
    else on = false
    for (i = 0; i < n; i++) out[i] = on
    // track-mode gaps (straight, no mapped way) and failed / empty-cover legs
    if (mode === 'track' && leg.cover && leg.cover.gaps) {
      leg.cover.gaps.forEach(function (g) {
        var a = Math.max(0, g[0]), b = Math.min(n - 1, g[1])
        for (i = a; i <= b; i++) out[i] = false
      })
    }
    if (mode === 'direct' || leg.failed || (mode === 'track' && !leg.via && leg.cover && !leg.cover.onKm)) {
      for (i = 0; i < n; i++) out[i] = false
    }
    return out
  }

  function resampleLine(pts, stepM) {
    stepM = stepM || 50
    if (!pts || pts.length < 2) return (pts || []).map(function (p, i) { return { lat: p[0], lon: p[1], d: 0, i0: i } })
    function d(a, b) {
      var R = 6371008.8, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180
      var dp = p2 - p1, dl = (b[1] - a[1]) * Math.PI / 180
      var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2)
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
    }
    var out = [{ lat: pts[0][0], lon: pts[0][1], d: 0, i0: 0 }], acc = 0, next = stepM
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], seg = d(a, b)
      if (seg < 0.01) continue
      while (acc + seg >= next) {
        var t = (next - acc) / seg
        out.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, d: next, i0: i - 1 })
        next += stepM
      }
      acc += seg
    }
    var last = pts[pts.length - 1]
    var tail = out[out.length - 1]
    if (!tail || d([tail.lat, tail.lon], last) > stepM / 4) out.push({ lat: last[0], lon: last[1], d: acc, i0: pts.length - 1 })
    return out
  }

  function offsetPoint(lat, lon, bearingDeg, distM) {
    var br = bearingDeg * Math.PI / 180, dR = distM / 6371008.8
    var p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180
    var p2 = Math.asin(Math.sin(p1) * Math.cos(dR) + Math.cos(p1) * Math.sin(dR) * Math.cos(br))
    var l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(dR) * Math.cos(p1), Math.cos(dR) - Math.sin(p1) * Math.sin(p2))
    return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180]
  }

  function bearing(a, b) {
    var p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180
    var y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
  }

  root.RallyRaidPolish = {
    isNoteType: isNoteType,
    storedType: storedType,
    uiTypeLabel: uiTypeLabel,
    uiPointLabel: uiPointLabel,
    placeFromNominatim: placeFromNominatim,
    composeName: composeName,
    composeDescription: composeDescription,
    composeMeta: composeMeta,
    coverWords: coverWords,
    surfaceWords: surfaceWords,
    findForestProblems: findForestProblems,
    isForestCover: isForestCover,
    mappedMask: mappedMask,
    resampleLine: resampleLine,
    offsetPoint: offsetPoint,
    bearing: bearing,
    MIN_FOREST_M: MIN_FOREST_M,
    FOREST_GROUPS: FOREST_GROUPS
  }
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this)
