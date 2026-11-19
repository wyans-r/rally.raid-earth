/* Rally viewer helpers (parse a rallyraid-rally v1 file, build map geometry).
 * Used by rally.html and tests/rally/viewer.test.js. Works in the browser and in Node. */
(function (root) {
  'use strict';

  var FORMAT = 'rallyraid-rally';
  var SCHEMA = 1;
  var COLORS = ['#ffd400', '#ff4fa3', '#00d5ff', '#b5ff3b', '#ff9f1a', '#c08cff', '#7cffb2', '#ff6b6b', '#8ec8ff', '#e6ff4a', '#ffb86b', '#6be0ff', '#f0a0ff'];
  var LIAISON_COLOR = '#9aa8b8';
  var TRANSFER_COLOR = '#5ee0c8';
  var SAFE_RALLY = /^(rallies)\/[A-Za-z0-9._/-]+\.json$/;
  var SAFE_STAGE = /^(rallies)\/[A-Za-z0-9._/-]+\.json$/;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function ll(p) { return Array.isArray(p) ? [+p[0], +p[1]] : [+p.lat, +p.lon]; }
  function isLL(p) { var a = ll(p); return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Math.abs(a[0]) <= 90 && Math.abs(a[1]) <= 180; }

  function distM(a, b) {
    a = ll(a); b = ll(b);
    var R = 6371000, dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function distKm(a, b) { return distM(a, b) / 1000; }

  function dest(a, bearingDeg, metres) {
    a = ll(a);
    var br = rad(bearingDeg), lat1 = rad(a[0]), lon1 = rad(a[1]), ang = metres / 6371000;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(br));
    var lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2));
    return [deg(lat2), ((deg(lon2) + 540) % 360) - 180];
  }
  function bearing(a, b) {
    a = ll(a); b = ll(b);
    var y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    var x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  /** even points along the great circle, about every stepKm (min 2). */
  function greatCircle(a, b, stepKm) {
    a = ll(a); b = ll(b);
    var L = distKm(a, b), step = stepKm || 25;
    var n = Math.max(1, Math.round(L / step));
    var out = [a];
    var br = bearing(a, b);
    for (var i = 1; i < n; i++) out.push(dest(a, br, (i / n) * L * 1000));
    out.push(b);
    return out;
  }

  function bivouacIndex(rally) {
    var map = Object.create(null);
    (rally.bivouacs || []).forEach(function (b) { if (b && b.id) map[b.id] = b; });
    return map;
  }

  function dayTypeLabel(d) {
    if (!d) return '';
    if (d.type === 'rest') return 'Rest day';
    if (d.type === 'transfer') return (d.liaisonOut && d.liaisonOut.ferry) ? 'Transfer (teleport)' : 'Transfer';
    if (d.type === 'marathon' || d.marathon) return 'Marathon';
    if (d.code === 'P' || (d.stage && /^prologue/i.test(d.stage.name || d.title || ''))) return 'Prologue';
    return 'Special stage';
  }

  function liaisonKm(d) {
    var lo = d.liaisonOut && d.liaisonOut.km, li = d.liaisonIn && d.liaisonIn.km;
    var n = (lo || 0) + (li || 0);
    return n ? +n : 0;
  }

  function ssKm(d) {
    if (!d.stage) return 0;
    var k = d.stage.km != null ? d.stage.km : d.stage.targetKm;
    return k ? +k : 0;
  }

  function safePath(p, kind) {
    if (!p || typeof p !== 'string') return null;
    p = p.replace(/^\/+/, '').replace(/\\/g, '/');
    if (p.indexOf('..') !== -1) return null;
    var re = kind === 'stage' ? SAFE_STAGE : SAFE_RALLY;
    return re.test(p) ? p : null;
  }

  function parse(obj) {
    var errors = [], warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, rally: null, errors: ['This is not a rally file.'], warnings: warnings };
    if (obj.format !== FORMAT) errors.push('Expected format "' + FORMAT + '".');
    if (obj.schemaVersion !== SCHEMA) errors.push('Unsupported rally format version (' + obj.schemaVersion + ').');
    if (!obj.id || !/^[a-z0-9-]+$/.test(obj.id)) errors.push('The rally needs a simple id (lowercase letters, numbers, dashes).');
    if (!obj.name) errors.push('The rally needs a name.');
    if (!Array.isArray(obj.bivouacs) || !obj.bivouacs.length) errors.push('The rally needs at least one bivouac.');
    if (!Array.isArray(obj.days) || !obj.days.length) errors.push('The rally needs a list of days.');
    if (errors.length) return { ok: false, rally: obj, errors: errors, warnings: warnings };

    var biv = bivouacIndex(obj);
    obj.bivouacs.forEach(function (b, i) {
      if (!b.id) errors.push('Bivouac ' + (i + 1) + ' has no id.');
      else if (!isLL(b)) errors.push('Bivouac "' + b.id + '" is missing a position.');
    });
    var prevTo = null;
    obj.days.forEach(function (d, i) {
      var label = d.code || d.title || ('day ' + (i + 1));
      if (!d.from || !biv[d.from]) errors.push(label + ': unknown start bivouac "' + d.from + '".');
      if (!d.to || !biv[d.to]) errors.push(label + ': unknown end bivouac "' + d.to + '".');
      if (prevTo && d.from && d.from !== prevTo) warnings.push(label + ': starts at ' + d.from + ', but the previous day ended at ' + prevTo + '.');
      if (d.to) prevTo = d.to;
      if ((d.type === 'stage' || d.type === 'marathon') && !d.stage) errors.push(label + ': a stage day is missing its stage.');
      if (d.stage) {
        if (!d.stage.dss || !isLL(d.stage.dss)) warnings.push(label + ': stage has no DSS position.');
        if (!d.stage.ass || !isLL(d.stage.ass)) warnings.push(label + ': stage has no ASS position.');
        if (!(d.stage.preview && d.stage.preview.length >= 2)) warnings.push(label + ': no preview line; the map will use a straight line from DSS to ASS.');
      }
      if (d.type === 'rest' && (liaisonKm(d) || ssKm(d))) warnings.push(label + ': a rest day has distances.');
    });
    if (errors.length) return { ok: false, rally: obj, errors: errors, warnings: warnings };
    return { ok: true, rally: obj, errors: errors, warnings: warnings };
  }

  function portVia(fromB, toB, rally) {
    var ports = (rally.bivouacs || []).filter(function (b) { return b.kind === 'port' && b.id !== fromB.id && b.id !== toB.id && isLL(b); });
    if (!ports.length) return null;
    // pick the port that sits closest to the great-circle, and not far off to the side
    var best = null, bestScore = Infinity;
    ports.forEach(function (p) {
      var via = distKm(fromB, p) + distKm(p, toB);
      var direct = distKm(fromB, toB) || 1;
      var extra = via - direct;
      if (extra < bestScore) { bestScore = extra; best = p; }
    });
    return best;
  }

  function stageLine(d) {
    var s = d.stage;
    if (!s) return null;
    if (s.preview && s.preview.length >= 2) return s.preview.map(ll);
    if (s.dss && s.ass && isLL(s.dss) && isLL(s.ass)) return [ll(s.dss), ll(s.ass)];
    return null;
  }

  function geometry(rally) {
    var parsed = arguments[1] && arguments[1].ok != null ? arguments[1] : parse(rally);
    if (!parsed.ok) return { ok: false, errors: parsed.errors, days: [], bivouacs: [], landmarks: [], bounds: null };
    rally = parsed.rally;
    var biv = bivouacIndex(rally);
    var days = [];
    var bounds = [];
    var colorI = 0;
    rally.days.forEach(function (d) {
      var fromB = biv[d.from], toB = biv[d.to];
      var item = {
        n: d.n, date: d.date, code: d.code, type: d.type, title: d.title, note: d.note || null,
        marathon: !!(d.marathon || d.type === 'marathon'),
        rest: d.type === 'rest',
        transfer: d.type === 'transfer',
        ferry: !!(d.liaisonOut && d.liaisonOut.ferry),
        teleport: !!(d.liaisonOut && d.liaisonOut.drive === false),
        from: fromB, to: toB,
        typeLabel: dayTypeLabel(d),
        ssKm: ssKm(d), liaisonKm: liaisonKm(d), totalKm: d.totalKm != null ? +d.totalKm : (ssKm(d) + liaisonKm(d)),
        color: COLORS[colorI % COLORS.length],
        stage: d.stage || null,
        stageLine: null,
        liaisonOut: null,
        liaisonIn: null,
        transferLine: null,
        transferVia: null,
        transferLabel: null
      };
      if (d.stage) {
        item.stageLine = stageLine(d);
        if (item.stageLine) bounds.push.apply(bounds, item.stageLine);
        colorI++;
        if (fromB && d.stage.dss && isLL(d.stage.dss)) {
          item.liaisonOut = { line: greatCircle(fromB, d.stage.dss, 20), km: d.liaisonOut && d.liaisonOut.km, kind: 'out' };
          bounds.push(ll(fromB), ll(d.stage.dss));
        }
        if (toB && d.stage.ass && isLL(d.stage.ass)) {
          item.liaisonIn = { line: greatCircle(d.stage.ass, toB, 20), km: d.liaisonIn && d.liaisonIn.km, kind: 'in' };
          bounds.push(ll(d.stage.ass), ll(toB));
        }
      } else if (d.type === 'transfer' && fromB && toB) {
        var via = (d.liaisonOut && d.liaisonOut.ferry) ? portVia(fromB, toB, rally) : null;
        var line;
        if (via) {
          line = greatCircle(fromB, via, 20).concat(greatCircle(via, toB, 20).slice(1));
          item.transferVia = via;
        } else {
          line = greatCircle(fromB, toB, 20);
        }
        item.transferLine = line;
        item.transferLabel = item.teleport || item.ferry ? 'Transfer (teleport)' : 'Transfer';
        bounds.push.apply(bounds, line);
      }
      if (fromB) bounds.push(ll(fromB));
      if (toB) bounds.push(ll(toB));
      days.push(item);
    });
    var box = null;
    if (bounds.length) {
      var s = 90, n = -90, w = 180, e = -180;
      bounds.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); });
      box = [[s, w], [n, e]];
    }
    return {
      ok: true, errors: parsed.errors, warnings: parsed.warnings,
      days: days,
      bivouacs: rally.bivouacs || [],
      landmarks: rally.landmarks || [],
      totals: rally.totals || { days: rally.days.length, stages: days.filter(function (x) { return x.stage; }).length, ssKm: days.reduce(function (a, x) { return a + x.ssKm; }, 0), liaisonKm: days.reduce(function (a, x) { return a + x.liaisonKm; }, 0) },
      bounds: box,
      colors: { stage: COLORS, liaison: LIAISON_COLOR, transfer: TRANSFER_COLOR }
    };
  }

  function dayBounds(item) {
    var pts = [];
    if (item.stageLine) pts = pts.concat(item.stageLine);
    if (item.liaisonOut) pts = pts.concat(item.liaisonOut.line);
    if (item.liaisonIn) pts = pts.concat(item.liaisonIn.line);
    if (item.transferLine) pts = pts.concat(item.transferLine);
    if (item.rest && item.from) pts.push(ll(item.from));
    if (!pts.length && item.from) pts.push(ll(item.from));
    if (!pts.length) return null;
    var s = 90, n = -90, w = 180, e = -180;
    pts.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); });
    return [[s, w], [n, e]];
  }

  function stageOpenHref(day, opts) {
    opts = opts || {};
    var file = day.stage && day.stage.file;
    var p = file ? safePath((opts.rallyDir ? opts.rallyDir + '/' : '') + file, 'stage') : null;
    // compiled files use "atlantic-to-atlas-2027/stages/...." relative to the rally file's folder (rallies/)
    if (!p && file && file.indexOf('..') === -1) {
      var cand = 'rallies/' + file.replace(/^\/+/, '');
      p = safePath(cand, 'stage');
    }
    if (p) return (opts.builder || '/') + (opts.builder && opts.builder.indexOf('?') >= 0 ? '&' : '?') + 'stage=' + encodeURIComponent(p);
    return null;
  }

  function lightweightStage(day) {
    var s = day && day.stage;
    if (!s) return null;
    var line = stageLine(day);
    if (!line || line.length < 2) return null;
    var km = s.km || s.targetKm || +(distKm(line[0], line[line.length - 1]).toFixed(3));
    return {
      format: 'rallyraid-stage', schemaVersion: 1, id: s.id || day.code || 'stage',
      name: s.name || day.title || 'Stage',
      waypoints: [
        { id: 'dss', n: 0, type: 'DSS', lat: line[0][0], lon: line[0][1], km: 0 },
        { id: 'ass', n: 1, type: 'ASS', lat: line[line.length - 1][0], lon: line[line.length - 1][1], km: km }
      ],
      route: { legs: [{ from: 'dss', to: 'ass', mode: 'direct', km: km, points: line }] },
      lengthKm: km
    };
  }

  function totalsOf(g) {
    var T = g.totals || {};
    return {
      days: T.days != null ? T.days : g.days.length,
      stages: T.stages != null ? T.stages : g.days.filter(function (d) { return d.stage; }).length,
      ssKm: T.ssKm != null ? T.ssKm : g.days.reduce(function (a, d) { return a + d.ssKm; }, 0),
      ssTargetKm: T.ssTargetKm,
      liaisonKm: T.liaisonKm != null ? T.liaisonKm : g.days.reduce(function (a, d) { return a + d.liaisonKm; }, 0),
      publishedTotalKm: T.publishedTotalKm
    };
  }

  var api = {
    FORMAT: FORMAT, SCHEMA: SCHEMA, COLORS: COLORS,
    LIAISON_COLOR: LIAISON_COLOR, TRANSFER_COLOR: TRANSFER_COLOR,
    esc: esc, distM: distM, distKm: distKm, greatCircle: greatCircle, dest: dest, bearing: bearing,
    parse: parse, geometry: geometry, bivouacIndex: bivouacIndex, dayTypeLabel: dayTypeLabel,
    liaisonKm: liaisonKm, ssKm: ssKm, dayBounds: dayBounds, safePath: safePath,
    stageOpenHref: stageOpenHref, lightweightStage: lightweightStage, totalsOf: totalsOf, portVia: portVia
  };
  root.RallyView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
