/* Rally Raid track router: the stage builder's "Leg to here = tracks & paths" mode.
 *
 * Routes a leg along small OpenStreetMap ways that OSRM's driving profile ignores: highway=track (any tracktype),
 * unclassified / road, unpaved service / residential / tertiary, paths and bridleways (less: BeamNG.Earth does not
 * build them, so in the game a path is bare ground), and (lowest preference) unpaved footway / cycleway.
 * 1.1.0 (18 Nov 2026): village streets, residential, tertiary and secondary roads of any surface are in the graph too,
 * at a higher cost, only to CONNECT tracks: before, a track network that met the world through an untagged village
 * street or a paved tertiary road was an island, so the router drew a straight "gap" or skipped the tracks, while
 * 'road' mode (OSRM, which never uses highway=track) went another way: the two modes disagreed. Primary and bigger
 * roads stay out (that is the 'road' mode).
 *
 *   1. data   : one Overpass query per tile (fixed 0.2 degree world grid, only the tiles the leg's corridor touches;
 *               short legs ask one bbox rounded out to 0.02 degree;
 *               a box inside one already loaded is answered from it), through RoadbookGen.askOverpass, so the site's
 *               mirrors (official first, staggered backups, sticky) apply. Answers are cached in memory and IndexedDB.
 *   2. graph  : OSM nodes shared by two ways are junctions; every way segment is an edge, cost = length x preference.
 *   3. search : A* from the leg's start to its end. The ends join the network with a short hop (<= 300 m, onto the
 *               nearest point of a way). Where no way connects (the network stops, or the leg leaves the mapped area),
 *               the route may jump straight from the start, from a dead end, or to the finish, at a higher cost; those
 *               straight parts are returned as "gaps" so the builder can flag them. No usable way at all = straight leg.
 *
 * Pure logic + an injected overpass(query) function: runs in the browser (window.TrackRouter) and in node (require).
 * Stored stage files are unchanged: the builder still writes leg mode "track" (docs/STAGE_FORMAT.md).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrackRouter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = '1.6.0';

  var DEFAULTS = {
    marginF: 0.25,        // bbox margin around the leg: 25 % of its length ...
    marginMinM: 1000,     // ... but at least 1 km
    smallDeg: 0.2,        // a bbox up to this size (both sides) is one query; bigger ones are split into tiles
    tileDeg: 0.2,         // tile size on a fixed world grid (cache friendly)
    maxTiles: 36,
    maxLegKm: 120,        // longer legs: add waypoints (the query would be too big)
    linkM: 300,           // longest hop from a leg end onto a way (drawn straight)
    linkCost: 1.3,        // cost per metre of such a hop
    gapCost: 2.0,         // cost per metre of a straight gap where no way connects (route ~2x longer on tracks still wins)
    // 1.2.0: past gapLongM, each metre of a straight gap costs gapCostLong. In the mountains a track or path with
    // switchbacks is 1.5-2x the straight distance, so at a flat 2.0 the router cut straight across the ridge instead
    // (a 3.8 km path above Ourika, High Atlas, lost to a 2.5 km straight line). Hops up to 300 m cost the same as before.
    gapLongM: 300,        // = linkM: hops up to 300 m cost what they did
    gapCostLong: 3.0,
    jumpM: 2500,          // a gap jump from a dead end (or the leg start) may reach this far
    sideJumpM: 0,         // 1.1.2 (off by default: costly in towns): a gap jump from the middle of a way onto another piece
    // 1.3.0 (Wyans 19 Nov 2026): small roads beat off-piste unless they back-track or re-route. After the search, every
    // stretch on small roads must stay within roadDetourMax x its straight length and never head away from the leg end by
    // more than backtrackM; a stretch that fails is taken out and the leg searched again (up to roadRetries times).
    // 1.4.0: 3x (was 1.5x): mountain roads that zigzag up a slope (switchbacks) are 2-3x their straight length while
    // closing in all the way (Ourika: an unclassified road 3.15 km for 1.3 km); at 1.5x they were thrown out for off-piste
    // 1.6.0 (Wyans 19 Nov 2026): 2x again, but measured with detourLen() (50 m steps, switchback stacks count as the
    // straight line through them), so a road zigzagging up a slope is no longer a detour by length
    roadDetourMax: 2.0,
    backtrackM: 250,
    detourStepM: 50,      // 1.6.0: detourLen() measures the line at 50 m steps
    hairpinDeg: 120,      // 1.6.0: a turn of more than this within hairpinWinM is a hairpin
    hairpinWinM: 150,
    hairpinLegM: 600,     // 1.6.0: hairpins at most this far apart (alternating) are one stack of switchbacks
    roadRetries: 4,
    // 1.4.0 (Wyans 19 Nov 2026, Ourika): a straight jump from the leg start onto a network the start is already on (a way
    // within linkM), or from such a network to the leg end, costs samePieceGapF x as much. Before, the start could jump to
    // any node within jumpM, so it cut 522 m straight across the switchbacks of the trail it was standing on (793 m of path).
    // Jumps between different pieces (the dead-end rule) are unchanged.
    samePieceGapF: 2.0,
    joinCrossings: true,  // 1.4.0: two ways that cross without a shared node (and no bridge / tunnel / layer) are joined there
    overpassTimeoutS: 40
  };

  // ------------------------------------------------------------------ which ways, and how much we like them
  var UNPAVED = /^(unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|sand|mud|rock|rocks|pebblestone|grass|grass_paver|salt|stone|shells|clay|woodchips|dirt;sand|sand;gravel|gravel;sand|soil)$/;
  var PAVED = /^(asphalt|paved|concrete|concrete:plates|concrete:lanes|paving_stones|sett|chipseal|metal|cobblestone|unhewn_cobblestone|bricks|wood)$/;
  var UNPAVED_Q = 'unpaved|gravel|fine_gravel|compacted|dirt|earth|ground|sand|mud|rock|pebblestone|grass|salt|stone|clay';

  /** cost factor per metre for a way's tags (1 = an ordinary track), or null = not used by this mode */
  function wayCost(t, profile) {
    if (profile === 'piste' || profile === 'traces') return tierCost(t, profile);
    if (!t || !t.highway || t.area === 'yes') return null;
    var hw = t.highway, sf = t.surface || '', unp = UNPAVED.test(sf), pav = PAVED.test(sf);
    var f = null;
    if (hw === 'track') f = /^grade[45]$/.test(t.tracktype || '') ? 1.08 : 1.0;
    // paths / bridleways: not built in the game (bare ground there), so a real track is preferred clearly
    else if (hw === 'path') f = pav ? null : 1.6;
    else if (hw === 'bridleway') f = pav ? null : 1.65;
    // 1.3.0 small roads (any surface): dearer than a track, clearly cheaper than off-piste (gap 2.0, 3.0 past 300 m)
    else if (hw === 'unclassified' || hw === 'road') f = unp ? 1.0 : pav ? 1.45 : 1.15;
    else if (hw === 'service') f = /^(driveway|parking_aisle|drive-through|emergency_access)$/.test(t.service || '') ? null : unp ? 1.1 : 1.5;
    else if (hw === 'residential' || hw === 'living_street') f = unp ? 1.15 : 1.45;
    else if (hw === 'tertiary' || hw === 'tertiary_link') f = unp ? 1.15 : 1.55;
    // highways: only when nothing else connects (dearer per metre than a long off-piste stretch); motorways never
    else if (hw === 'secondary' || hw === 'secondary_link') f = unp ? 1.3 : 3.2;
    else if (/^(primary|primary_link|trunk|trunk_link)$/.test(hw)) f = unp ? 1.5 : 3.6;
    else if (hw === 'footway' || hw === 'cycleway') f = unp ? 3.0 : null;
    if (f == null) return null;
    if (t.access === 'private' || t.access === 'no' || t.motor_vehicle === 'no' || t.vehicle === 'no') f *= 1.3;
    return f;
  }
  // ------------------------------------------------------------------ 1.5.0: routing tiers (Wyans 19 Nov 2026)
  // "Primary Piste (Roads), Piste (Tracks), Traces (off-road trails and two-track), and off-piste". Primary Piste is OSRM
  // road routing and off-piste the builder's straight / planned line (neither is here); Piste and Traces are profiles of
  // this router. tierOf() says which tier a way belongs to, for the builder's Auto choice.
  var MAJOR = /^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link)$/;
  function tierOf(t) {
    if (!t || !t.highway || t.area === 'yes') return null;
    var hw = t.highway, sf = t.surface || '', unp = UNPAVED.test(sf), pav = PAVED.test(sf);
    if (/^(motorway|motorway_link|construction|proposed|steps|platform|corridor|elevator|raceway|bus_stop)$/.test(hw)) return null;
    if (/^(path|bridleway|footway|cycleway)$/.test(hw)) return pav ? null : 'traces';
    if (t.informal === 'yes') return 'traces';
    if (hw === 'track') return /^grade[45]$/.test(t.tracktype || '') ? 'traces' : 'piste';
    if (MAJOR.test(hw) || hw === 'residential' || hw === 'living_street') return unp ? 'piste' : 'primary';
    if (hw === 'unclassified' || hw === 'road') return unp ? 'piste' : 'primary';
    if (hw === 'service') return /^(driveway|parking_aisle|drive-through|emergency_access)$/.test(t.service || '') ? null : unp ? 'piste' : 'primary';
    return null;
  }
  /** cost per metre in the Piste / Traces profiles: the tier's own ways at ~1, the other small ways only to link them */
  function tierCost(t, profile) {
    var base = wayCost(t); if (base == null) return null;
    var tr = tierOf(t), hw = t.highway;
    if (profile === 'piste') {
      if (tr === 'traces') return hw === 'track' ? 1.25 : 2.6;   // trails only to bridge (a short gap costs 2.0, a long one 3.0)
      return base;
    }
    // traces
    if (tr === 'traces') return t.access === 'private' || t.access === 'no' ? 1.3 : 1.0;
    if (hw === 'track') return 1.25;
    if (wayClass(t) === 'highway') return base;
    return Math.min(2.4, base * 1.15);
  }
  /** 1.3.0: way class for the route summary: track | path | road (small roads) | highway (primary / secondary / trunk) */
  function wayClass(t) {
    var hw = (t && t.highway) || '';
    if (hw === 'track') return 'track';
    if (/^(path|bridleway|footway|cycleway)$/.test(hw)) return 'path';
    if (/^(primary|primary_link|trunk|trunk_link|secondary|secondary_link)$/.test(hw)) return 'highway';
    return 'road';
  }
  /** short name of a way class, for the status line */
  function wayKind(t) { var c = wayClass(t); return c === 'road' ? 'minor road' : c; }

  function overpassQuery(b, timeoutS) {
    var B = '(' + b.map(function (x) { return (+x).toFixed(4) }).join(',') + ')';
    return '[out:json][timeout:' + (timeoutS || DEFAULTS.overpassTimeoutS) + '];(' +
      'way[highway~"^(track|path|bridleway|unclassified|road|residential|living_street|tertiary|tertiary_link)$"]' + B + ';' +
      // 1.3.0: small roads of any surface (they now beat off-piste). Highways (primary / secondary / trunk) too, priced as a
      // last resort; motorways never. Service roads and foot / cycle ways only when unpaved or untagged (towns: size).
      'way[highway~"^(primary|primary_link|trunk|trunk_link|secondary|secondary_link)$"]' + B + ';' +
      'way[highway~"^(service|footway|cycleway)$"][surface~"^(' + UNPAVED_Q + ')$"]' + B + ';' +
      'way[highway=service][!service]' + B + ';' +
      ');out body geom qt;';
  }

  // ------------------------------------------------------------------ geometry
  var R = 6371008.8, rad = function (d) { return d * Math.PI / 180 };
  function dist(a, b) {
    var p1 = rad(a[0]), p2 = rad(b[0]), dp = p2 - p1, dl = rad(b[1] - a[1]);
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function projector(lat0) {
    var kx = Math.cos(rad(lat0)) * R * Math.PI / 180, ky = R * Math.PI / 180;
    return { xy: function (p) { return [p[1] * kx, p[0] * ky] }, ll: function (q) { return [q[1] / ky, q[0] / kx] } };
  }
  var r6 = function (x) { return Math.round(x * 1e6) / 1e6 };

  /* 1.6.0 (Wyans 19 Nov 2026): the length a detour test compares with the straight line, not the full polyline.
   * 1. the line is measured at 50 m steps along it (detourStepM), so wiggles shorter than that count as straight;
   * 2. a hairpin is a turn of more than 120 deg (hairpinDeg) within 150 m (hairpinWinM) of the line; two or more
   *    hairpins in a row that alternate left / right, each within 600 m (hairpinLegM) of the last, are a stack of
   *    switchbacks, and the stack counts as the straight line from its first hairpin to its last.
   * A mountain track zigzagging up a slope therefore counts as about the ground it gains, not its full length; a loop or
   * an out-and-back (turns the same way, or legs over 600 m) still counts in full. xy in metres -> { m, pts } */
  function resampleXY(P, step) {
    var out = [P[0]], carry = 0;
    for (var i = 1; i < P.length; i++) {
      var a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), at = step - carry;
      while (at <= L) { out.push([a[0] + (b[0] - a[0]) * at / L, a[1] + (b[1] - a[1]) * at / L]); at += step; }
      carry = L - (at - step);
    }
    var z = P[P.length - 1], y = out[out.length - 1]; if (z[0] !== y[0] || z[1] !== y[1]) out.push(z);
    return out;
  }
  function detourLenXY(P, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    if (!P || P.length < 2) return { m: 0, pts: (P || []).slice() };
    var Q = resampleXY(P, o.detourStepM), n = Q.length, h = [];
    for (var k = 0; k + 1 < n; k++) h.push(Math.atan2(Q[k + 1][1] - Q[k][1], Q[k + 1][0] - Q[k][0]));
    var dturn = function (k) { var d = (h[k + 1] - h[k]) * 180 / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360; return d };
    // hairpins: windows of up to hairpinWinM / step turns whose net turn is past hairpinDeg -> [{ s, e, sign }] (Q indexes)
    var W = Math.max(1, Math.round(o.hairpinWinM / o.detourStepM)), ev = [];
    for (k = 0; k + 1 < h.length; k++) {
      var net = 0;
      for (var w = 0; w < W && k + w + 1 < h.length; w++) {
        net += dturn(k + w);
        if (Math.abs(net) > o.hairpinDeg) {
          var e = { s: k, e: k + w + 2, sign: Math.sign(net) }, last = ev[ev.length - 1];
          if (last && e.s <= last.e && last.sign === e.sign) last.e = Math.max(last.e, e.e); else ev.push(e);
          break;
        }
      }
    }
    // stacks: consecutive hairpins alternating, each within hairpinLegM of the last
    var cut = [];
    for (var a = 0; a < ev.length; a++) {
      var b = a;
      while (b + 1 < ev.length && ev[b + 1].sign === -ev[b].sign && (ev[b + 1].s - ev[b].e) * o.detourStepM <= o.hairpinLegM) b++;
      if (b > a) { cut.push([ev[a].s, Math.min(n - 1, ev[b].e)]); a = b; }
    }
    var out = [], c = 0;
    for (k = 0; k < n; k++) {
      if (c < cut.length && k === cut[c][0]) { out.push(Q[k]); k = cut[c][1]; out.push(Q[k]); c++; continue; }
      out.push(Q[k]);
    }
    var m = 0; for (k = 1; k < out.length; k++) m += Math.hypot(out[k][0] - out[k - 1][0], out[k][1] - out[k - 1][1]);
    return { m: m, pts: out, stacks: cut.length };
  }
  /** detourLenXY() for [lat, lon] points -> metres */
  function detourLen(pts, o) {
    if (!pts || pts.length < 2) return 0;
    var P = projector(pts[0][0]);
    return detourLenXY(pts.map(P.xy), o).m;
  }
  function wrapLon(x) { x = +x; return x >= -180 && x <= 180 ? x : ((x + 180) % 360 + 360) % 360 - 180; }

  // ------------------------------------------------------------------ the area to ask for
  function legBbox(a, b, o) {
    o = o || DEFAULTS;
    var L = dist(a, b), m = Math.max(o.marginMinM, o.marginF * L);
    var mLat = m / 111195, mLon = m / (111195 * Math.max(0.05, Math.cos(rad((a[0] + b[0]) / 2))));
    return [Math.min(a[0], b[0]) - mLat, Math.min(a[1], b[1]) - mLon, Math.max(a[0], b[0]) + mLat, Math.max(a[1], b[1]) + mLon];
  }
  /** the boxes to query: one (rounded out to 0.01 deg) for a small bbox, else fixed-grid tiles near the leg's corridor */
  function queryBoxes(a, b, o) {
    o = o || DEFAULTS;
    var bb = legBbox(a, b, o);
    if (bb[2] - bb[0] <= o.smallDeg && bb[3] - bb[1] <= o.smallDeg) {
      var f = function (x, up) { return +((up ? Math.ceil(x * 50) : Math.floor(x * 50)) / 50).toFixed(2) };  // 0.02 degree steps
      return [[f(bb[0]), f(bb[1]), f(bb[2], true), f(bb[3], true)]];
    }
    var d = o.tileDeg, out = [], L = dist(a, b), m = Math.max(o.marginMinM, o.marginF * L);
    var P = projector((a[0] + b[0]) / 2), A = P.xy(a), B = P.xy(b);
    for (var s = Math.floor(bb[0] / d) * d; s < bb[2]; s += d)
      for (var w = Math.floor(bb[1] / d) * d; w < bb[3]; w += d) {
        var t = [+s.toFixed(4), +w.toFixed(4), +(s + d).toFixed(4), +(w + d).toFixed(4)];
        // keep the tile if any part of it is within the margin of the leg line
        var c = P.xy([(t[0] + t[2]) / 2, (t[1] + t[3]) / 2]), half = dist([t[0], t[1]], [t[2], t[3]]) / 2;
        if (segDist(c, A, B).d <= m + half) out.push(t);
      }
    return out;
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    var x = a[0] + t * dx, y = a[1] + t * dy;
    return { d: Math.hypot(p[0] - x, p[1] - y), t: t, x: x, y: y };
  }

  // ------------------------------------------------------------------ graph
  /* elements: Overpass ways with nodes + geometry (any number of answers merged; duplicates skipped) */
  function buildGraph(answers, lat0, skip, joinX, profile) {
    var P = projector(lat0), idx = new Map(), ll = [], xy = [], adj = [], seen = new Set(), nWays = 0, kinds = {};
    function node(id, g) {
      var k = idx.get(id);
      if (k === undefined) { k = ll.length; idx.set(id, k); ll.push([g.lat, g.lon]); xy.push(P.xy([g.lat, g.lon])); adj.push([]); }
      return k;
    }
    var segs = []; // [u, v, factor, wayIdx]
    var ways = [];
    answers.forEach(function (ans) {
      ((ans && ans.elements) || []).forEach(function (e) {
        if (e.type !== 'way' || !e.geometry || !e.nodes || seen.has(e.id)) return;
        seen.add(e.id);
        var f = wayCost(e.tags, profile);
        if (f == null || (skip && skip.has(e.id))) return;
        var wi = ways.length; ways.push({ id: e.id, tags: e.tags, f: f }); nWays++;
        var kd = wayKind(e.tags); kinds[kd] = (kinds[kd] || 0) + 1;
        var prev = -1;
        for (var i = 0; i < e.nodes.length; i++) {
          var g = e.geometry[i]; if (!g) { prev = -1; continue; }  // clipped at the bbox edge
          var k = node(e.nodes[i], g);
          if (prev >= 0 && prev !== k) {
            var len = Math.hypot(xy[k][0] - xy[prev][0], xy[k][1] - xy[prev][1]);
            adj[prev].push([k, len * f, len, wi]); adj[k].push([prev, len * f, len, wi]);
            segs.push([prev, k, f, wi]);
          }
          prev = k;
        }
      });
    });
    // spatial index of segments (250 m cells)
    var CELL = 250, grid = new Map(), sgrid = new Map();
    var key = function (cx, cy) { return cx + ',' + cy };
    var indexSeg = function (si) {
      var s = segs[si], a = xy[s[0]], b = xy[s[1]];
      var x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL), y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) { x1 = x0; y1 = y0; } // absurd segment: index at one end only
      for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) { var kk = key(cx, cy); (sgrid.get(kk) || sgrid.set(kk, []).get(kk)).push(si); }
    };
    for (var si0 = 0; si0 < segs.length; si0++) indexSeg(si0);
    var G = { P: P, ll: ll, xy: xy, adj: adj, segs: segs, ways: ways, grid: grid, sgrid: sgrid, CELL: CELL, key: key, nWays: nWays, kinds: kinds, healed: 0 };
    // heal: OSM often has a way that ends a few metres from another without sharing a node (an unconnected
    // junction). Join every dead end to the nearest point of other ways within healM.
    var nOrig = ll.length, healM = 40;
    for (var k0 = 0; k0 < nOrig; k0++) {
      if (adj[k0].length !== 1) continue;
      var own = adj[k0][0][3];
      snapsNear(G, xy[k0], healM, 3).forEach(function (sn) {
        var sg = segs[sn.si]; if (sg[3] === own) return;
        var f = sg[2], tgt;
        if (sn.t < 0.02 || sn.t > 0.98) tgt = sn.t < 0.5 ? sg[0] : sg[1];
        else { // split the segment with a new node
          tgt = ll.length; xy.push([sn.x, sn.y]); ll.push(P.ll([sn.x, sn.y])); adj.push([]);
          var pu = xy[sg[0]], pv = xy[sg[1]], lu = Math.hypot(sn.x - pu[0], sn.y - pu[1]), lv = Math.hypot(sn.x - pv[0], sn.y - pv[1]);
          adj[tgt].push([sg[0], lu * f, lu, sg[3]], [sg[1], lv * f, lv, sg[3]]); adj[sg[0]].push([tgt, lu * f, lu, sg[3]]); adj[sg[1]].push([tgt, lv * f, lv, sg[3]]);
          segs.push([sg[0], tgt, f, sg[3]], [tgt, sg[1], f, sg[3]]); indexSeg(segs.length - 2); indexSeg(segs.length - 1);
        }
        if (tgt === k0) return;
        var d = Math.hypot(xy[tgt][0] - xy[k0][0], xy[tgt][1] - xy[k0][1]), c = d * Math.max(f, ways[own].f) * 1.2;
        adj[k0].push([tgt, c, d, own]); adj[tgt].push([k0, c, d, own]); segs.push([k0, tgt, ways[own].f, own]); indexSeg(segs.length - 1);
        G.healed++;
      });
    }
    // 1.4.0: ways that cross without a shared node (common in OSM for paths) are joined at the crossing, unless one is a
    // bridge / tunnel or they are on different layers
    if (joinX) {
      var lvl = function (t) { t = t || {}; return (t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') ? 'x' : (t.layer || '0'); };
      var nSeg = segs.length, xs = [], done = new Set();
      sgrid.forEach(function (l, kk) {
        var cxy = kk.split(','), gx = +cxy[0], gy = +cxy[1];
        for (var i = 0; i < l.length; i++) {
          var si = l[i]; if (si >= nSeg) continue;
          var s1 = segs[si], p1 = xy[s1[0]], p2 = xy[s1[1]];
          var ax0 = Math.min(p1[0], p2[0]), ax1 = Math.max(p1[0], p2[0]), ay0 = Math.min(p1[1], p2[1]), ay1 = Math.max(p1[1], p2[1]);
          for (var j = i + 1; j < l.length; j++) {
            var sj = l[j]; if (sj >= nSeg) continue;
            var s2 = segs[sj]; if (s1[3] === s2[3]) continue;
            var p3 = xy[s2[0]], p4 = xy[s2[1]];
            if (Math.max(p3[0], p4[0]) < ax0 || Math.min(p3[0], p4[0]) > ax1 || Math.max(p3[1], p4[1]) < ay0 || Math.min(p3[1], p4[1]) > ay1) continue;
            if (s1[0] === s2[0] || s1[0] === s2[1] || s1[1] === s2[0] || s1[1] === s2[1]) continue;
            var dd = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]); if (!dd) continue;
            var tt = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / dd, uu = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / dd;
            if (!(tt > 0 && tt < 1 && uu > 0 && uu < 1)) continue;
            var cx_ = p1[0] + tt * (p2[0] - p1[0]), cy_ = p1[1] + tt * (p2[1] - p1[1]);
            if (Math.floor(cx_ / CELL) !== gx || Math.floor(cy_ / CELL) !== gy) continue;   // each crossing once: in its own cell
            var w1 = ways[s1[3]].tags, w2 = ways[s2[3]].tags; if (lvl(w1) === 'x' || lvl(w2) === 'x' || lvl(w1) !== lvl(w2)) continue;
            var xk = Math.round(cx_) + ',' + Math.round(cy_);
            if (done.has(xk)) continue; done.add(xk);   // the same crossing seen through a duplicate / healed segment
            xs.push([si, sj, cx_, cy_]);
          }
        }
      });
      xs.forEach(function (x) {
        var k = ll.length; xy.push([x[2], x[3]]); ll.push(P.ll([x[2], x[3]])); adj.push([]);
        [segs[x[0]], segs[x[1]]].forEach(function (sg) {
          [sg[0], sg[1]].forEach(function (e) {
            var d = Math.hypot(xy[e][0] - x[2], xy[e][1] - x[3]);
            adj[k].push([e, d * sg[2], d, sg[3]]); adj[e].push([k, d * sg[2], d, sg[3]]);
            segs.push([e, k, sg[2], sg[3]]); indexSeg(segs.length - 1);
          });
        });
      });
      G.joined = xs.length;
    }
    // components (union-find)
    var par = new Int32Array(ll.length); for (var i = 0; i < par.length; i++) par[i] = i;
    var find = function (x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    // 1.3.0: highways don't join pieces, so a jump between two track networks that only meet via a highway stays possible
    var hiW = ways.map(function (w) { return wayClass(w.tags) === 'highway'; });
    segs.forEach(function (s) { if (hiW[s[3]]) return; var a = find(s[0]), b = find(s[1]); if (a !== b) par[a] = b; });
    var comp = new Int32Array(ll.length); for (var j = 0; j < ll.length; j++) comp[j] = find(j);
    G.comp = comp;
    xy.forEach(function (p, k) { var kk = key(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)); (grid.get(kk) || grid.set(kk, []).get(kk)).push(k); });
    // portals (1.1.2): one node per 250 m cell per network piece, the targets of side jumps from the middle of a way
    var portal = new Map();
    grid.forEach(function (l, kk) { var seenC = new Set(), out = []; l.forEach(function (k) { if (!seenC.has(comp[k])) { seenC.add(comp[k]); out.push(k); } }); portal.set(kk, out); });
    G.portal = portal;
    return G;
  }
  function nodesNear(G, p, r) {
    var out = [], c = G.CELL, x0 = Math.floor((p[0] - r) / c), x1 = Math.floor((p[0] + r) / c), y0 = Math.floor((p[1] - r) / c), y1 = Math.floor((p[1] + r) / c);
    for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) {
      var l = G.grid.get(G.key(cx, cy)); if (!l) continue;
      for (var i = 0; i < l.length; i++) { var q = G.xy[l[i]], d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d <= r) out.push([l[i], d]); }
    }
    return out;
  }
  function portalsNear(G, p, r) {
    var out = [], c = G.CELL, x0 = Math.floor((p[0] - r) / c), x1 = Math.floor((p[0] + r) / c), y0 = Math.floor((p[1] - r) / c), y1 = Math.floor((p[1] + r) / c);
    for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) {
      var l = G.portal.get(G.key(cx, cy)); if (!l) continue;
      for (var i = 0; i < l.length; i++) { var q = G.xy[l[i]], d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d <= r) out.push([l[i], d]); }
    }
    return out;
  }
  /** 1.4.0: like snapsNear, but a way that passes p more than once (the two legs of a hairpin) gives one snap per pass,
   *  as long as the farther pass is not much farther than the nearest (<= 2x + 30 m): a click between the legs of a
   *  switchback can join either leg, a click on one leg never hops across to the other */
  function snapsBranches(G, p, r, max) {
    var c = G.CELL, cand = new Map(), seen = new Set();
    for (var cx = Math.floor((p[0] - r) / c); cx <= Math.floor((p[0] + r) / c); cx++)
      for (var cy = Math.floor((p[1] - r) / c); cy <= Math.floor((p[1] + r) / c); cy++) {
        var l = G.sgrid.get(G.key(cx, cy)); if (!l) continue;
        for (var i = 0; i < l.length; i++) {
          var si = l[i]; if (seen.has(si)) continue; seen.add(si);
          var s = G.segs[si], h = segDist(p, G.xy[s[0]], G.xy[s[1]]);
          if (h.d > r) continue;
          (cand.get(s[3]) || cand.set(s[3], []).get(s[3])).push({ si: si, d: h.d, t: h.t, x: h.x, y: h.y });
        }
      }
    var out = [];
    cand.forEach(function (l) {
      l.sort(function (a, b) { return a.si - b.si });
      var runs = [], cur = null;
      l.forEach(function (x) { if (cur && x.si === cur.last + 1) { cur.last = x.si; if (x.d < cur.best.d) cur.best = x; } else { cur = { last: x.si, best: x }; runs.push(cur); } });
      var best = runs.map(function (r0) { return r0.best }).sort(function (a, b) { return a.d - b.d }), acc = [];
      best.forEach(function (x) {
        if (acc.length && x.d > 2 * acc[0].d + 30) return;
        if (acc.some(function (y) { return Math.hypot(x.x - y.x, x.y - y.y) < 25 })) return;
        if (acc.length < 3) acc.push(x);
      });
      out.push.apply(out, acc);
    });
    return out.sort(function (a, b) { return a.d - b.d }).slice(0, max || 8);
  }
  /** nearest points on ways within r of p: at most one per way, the closest `max` ways */
  function snapsNear(G, p, r, max) {
    var c = G.CELL, best = new Map(), seen = new Set();
    for (var cx = Math.floor((p[0] - r) / c); cx <= Math.floor((p[0] + r) / c); cx++)
      for (var cy = Math.floor((p[1] - r) / c); cy <= Math.floor((p[1] + r) / c); cy++) {
        var l = G.sgrid.get(G.key(cx, cy)); if (!l) continue;
        for (var i = 0; i < l.length; i++) {
          var si = l[i]; if (seen.has(si)) continue; seen.add(si);
          var s = G.segs[si], h = segDist(p, G.xy[s[0]], G.xy[s[1]]);
          if (h.d > r) continue;
          var cur = best.get(s[3]); if (!cur || h.d < cur.d) best.set(s[3], { si: si, d: h.d, t: h.t, x: h.x, y: h.y });
        }
      }
    return Array.from(best.values()).sort(function (a, b) { return a.d - b.d }).slice(0, max || 6);
  }

  // ------------------------------------------------------------------ search
  function Heap() { this.a = []; }
  Heap.prototype.push = function (k, v) { var a = this.a; a.push([k, v]); var i = a.length - 1; while (i) { var p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; } };
  Heap.prototype.pop = function () { var a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; var i = 0; for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; var t = a[m]; a[m] = a[i]; a[i] = t; i = m; } } return top; };

  /**
   * A* from a to b ([lat, lon]) over graph G. Returns { points, parts:[{kind:'way'|'link'|'gap', points, m}], wayM, linkM, gapM }.
   * Virtual nodes: S (start), T (end), and one per snap point. Edge kinds: way (OSM), link (end hop <= linkM),
   * gap (straight jump: start -> any node, dead end -> another component's node, any node -> T, S -> T).
   */
  function findPath(G, a, b, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    var N = G.ll.length, S = N, T = N + 1, extra = [], extraXY = [], extraLL = [], extraSeg = [];
    var A = G.P.xy(a), B = G.P.xy(b);
    var nodeXY = function (k) { return k < N ? G.xy[k] : k === S ? A : k === T ? B : extraXY[k - N - 2]; };
    var nodeLL = function (k) { return k < N ? G.ll[k] : k === S ? a : k === T ? b : extraLL[k - N - 2]; };
    var extraAdj = new Map(); // node -> [[to, cost, len, kind]]
    var addE = function (u, v, cost, len, kind, wi) { (extraAdj.get(u) || extraAdj.set(u, []).get(u)).push([v, cost, len, kind, wi]); };
    // snap points: split the segment with a virtual node, joined both ways to its segment ends
    function snapNode(sn) {
      var s = G.segs[sn.si], k = N + 2 + extraXY.length, f = s[2];
      extraXY.push([sn.x, sn.y]); extraLL.push(G.P.ll([sn.x, sn.y])); extraSeg.push(sn.si);
      var pu = G.xy[s[0]], pv = G.xy[s[1]];
      var lu = Math.hypot(sn.x - pu[0], sn.y - pu[1]), lv = Math.hypot(sn.x - pv[0], sn.y - pv[1]);
      addE(k, s[0], lu * f, lu, 'way', s[3]); addE(s[0], k, lu * f, lu, 'way', s[3]); addE(k, s[1], lv * f, lv, 'way', s[3]); addE(s[1], k, lv * f, lv, 'way', s[3]);
      return k;
    }
    var gapC = function (d) { return d * o.gapCost + Math.max(0, d - (o.gapLongM || Infinity)) * ((o.gapCostLong || o.gapCost) - o.gapCost); };
    var L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    var spf = o.samePieceGapF || 1;
    // 1.4.0: a leg end joins the nearest way; a farther point of the same network piece (the other leg of a hairpin, a
    // parallel track of the same network) costs samePieceGapF x: hopping across a switchback is not cheaper than driving it
    // (and any way much farther than the nearest is reached like an off-piste hop: a click on a hairpin road must not
    // hop 270 m onto another track that skips the hairpin)
    var linkC = function (sns) {
      var d0 = sns.length ? sns[0].d : 0;
      return function (sn) { return sn.d > 2 * d0 + 30 ? gapC(sn.d) * spf : sn.d * o.linkCost; };
    };
    var sA = snapsBranches(G, A, o.linkM, 8), fA = linkC(sA);
    sA.forEach(function (sn) { addE(S, snapNode(sn), fA(sn), sn.d, 'link'); });
    var nStartSnaps = extraSeg.length;
    var sB = snapsBranches(G, B, o.linkM, 8), fB = linkC(sB);
    var endSnaps = sB.map(function (sn) { return [snapNode(sn), sn.d, fB(sn)]; });
    // snap nodes next to the end can reach T with a link (added on expansion); the end snap nodes are joined to
    // the segments, and the segment ends must know about them too (done in snapNode)
    var toT = new Map(), toTf = new Map(); endSnaps.forEach(function (e) { toT.set(e[0], e[1]); toTf.set(e[0], e[2]); });
    // 1.4.0: the network pieces the leg start / end already stand on (a way within linkM)
    var startC = new Set(), endC = new Set();
    extraSeg.forEach(function (si, i) { (i < nStartSnaps ? startC : endC).add(G.comp[G.segs[si][0]]); });
    var compOf = function (k) { return k < N ? G.comp[k] : k === S || k === T ? -1 : G.comp[G.segs[extraSeg[k - N - 2]][0]]; };
    // straight from start to end: dearer when both ends stand on the same network piece (1.4.0)
    var both = false; startC.forEach(function (c) { if (endC.has(c)) both = true; });
    addE(S, T, gapC(L) * (both ? spf : 1), L, 'gap');
    // the start may jump straight onto any node within jumpM (dearer onto the piece it already stands on)
    portalsNear(G, A, o.jumpM).forEach(function (n) { if (n[1] > o.linkM * 0.5) addE(S, n[0], gapC(n[1]) * (startC.has(G.comp[n[0]]) ? spf : 1), n[1], 'gap'); });
    // 1.3.0: a node counts as a dead end when at most one non-highway way meets it, so a track that ends on a highway
    // may still jump off-piste to the next track (the highway is a last resort, not the only way on)
    var hiW = G.ways.map(function (w) { return wayClass(w.tags) === 'highway'; });
    var deg = function (k) { if (k >= N) return 2; var n = 0, l = G.adj[k]; for (var i = 0; i < l.length; i++) if (!hiW[l[i][3]]) n++; return n; };
    var g = new Map(), from = new Map(), closed = new Set(), H = new Heap();
    var h = function (k) { var p = nodeXY(k); return Math.hypot(B[0] - p[0], B[1] - p[1]) * Math.min(1, o.linkCost); };
    g.set(S, 0); H.push(h(S), S);
    var expanded = 0;
    while (H.a.length) {
      var top = H.pop(), u = top[1];
      if (closed.has(u)) continue;
      closed.add(u); expanded++;
      if (u === T) break;
      var gu = g.get(u), pu = nodeXY(u);
      var relax = function (v, cost, len, kind, wi) {
        var nv = gu + cost; if (closed.has(v)) return;
        if (!(g.has(v)) || nv < g.get(v)) { g.set(v, nv); from.set(v, [u, kind, len, wi]); H.push(nv + h(v), v); }
      };
      if (u < N) G.adj[u].forEach(function (e) { relax(e[0], e[1], e[2], 'way', e[3]); });
      var ex = extraAdj.get(u); if (ex) ex.forEach(function (e) { relax(e[0], e[1], e[2], e[3], e[4]); });
      if (u !== S) {
        var dT = Math.hypot(B[0] - pu[0], B[1] - pu[1]);
        if (toT.has(u)) relax(T, toTf.get(u), toT.get(u), 'link');
        else relax(T, (dT <= o.linkM ? dT * o.gapCost : gapC(dT)) * (endC.has(compOf(u)) ? spf : 1), dT, dT <= o.linkM ? 'link' : 'gap');
        // a dead end may jump to another piece of the network
        if (u < N && deg(u) <= 1) portalsNear(G, pu, o.jumpM).forEach(function (n) {
          if (G.comp[n[0]] !== G.comp[u]) relax(n[0], gapC(n[1]), n[1], 'gap');
        });
        // 1.1.2: ... and so may any point of a way, onto a nearby other piece (a track that passes 1 km from another,
        // or from the leg start, with no junction between them: before, only dead ends could jump, so such tracks were ignored)
        else if (u < N && o.sideJumpM > 0) portalsNear(G, pu, o.sideJumpM).forEach(function (n) {
          if (G.comp[n[0]] !== G.comp[u]) relax(n[0], gapC(n[1]), n[1], 'gap');
        });
      }
    }
    // walk back
    var seq = [], k = T;
    if (!from.has(T)) return null;
    while (k !== S) { var f = from.get(k); seq.push({ to: k, from: f[0], kind: f[1], len: f[2], wi: f[3] }); k = f[0]; }
    seq.reverse();
    var parts = [], wayM = 0, linkM = 0, gapM = 0, byClass = { track: 0, path: 0, road: 0, highway: 0 }, runs = [], run = null;
    seq.forEach(function (s) {
      var kind = s.kind;
      // 1.3.0: metres per way class, and the stretches on small roads / highways (checked for back-tracking by route())
      var wc = kind === 'way' && s.wi != null && G.ways[s.wi] ? wayClass(G.ways[s.wi].tags) : null;
      if (wc) byClass[wc] += s.len;
      if (wc === 'road' || wc === 'highway') {
        if (!run) { run = { pts: [nodeXY(s.from)], m: 0, ways: new Set() }; runs.push(run); }
        run.pts.push(nodeXY(s.to)); run.m += s.len; run.ways.add(G.ways[s.wi].id);
      } else run = null;
      if (kind === 'gap' && s.len <= o.linkM && (s.from === S || s.to === T)) kind = 'link';
      if (kind === 'way') wayM += s.len; else if (kind === 'link') linkM += s.len; else gapM += s.len;
      var last = parts[parts.length - 1];
      if (last && last.kind === kind) { last.points.push(nodeLL(s.to)); last.m += s.len; }
      else parts.push({ kind: kind, points: [nodeLL(s.from), nodeLL(s.to)], m: s.len });
    });
    var points = [a];
    parts.forEach(function (p) { for (var i = 1; i < p.points.length; i++) points.push(p.points[i]); });
    points[points.length - 1] = b;
    points = dedupe(points.map(function (p) { return [r6(p[0]), r6(p[1])] }));
    // where the straight gaps are, as [from, to] indexes into points (stored with the leg, so they survive a reload)
    var gapIdx = [], at = 0, same = function (p, q) { return Math.abs(p[0] - q[0]) < 2e-6 && Math.abs(p[1] - q[1]) < 2e-6 };
    parts.forEach(function (pt) {
      var p0 = pt.points[0], p1 = pt.points[pt.points.length - 1], i0 = -1, i1 = -1, i;
      for (i = at; i < points.length; i++) if (same(points[i], p0)) { i0 = i; break; }
      if (i0 < 0) return;
      for (i = Math.max(i0 + 1, at); i < points.length; i++) if (same(points[i], p1)) { i1 = i; break; }
      if (i1 < 0 && pt.points.length > 1 && same(p1, b)) i1 = points.length - 1;
      if (i1 < 0) return;
      if (pt.kind === 'gap') gapIdx.push([i0, i1]);
      at = i1;
    });
    return { points: points, parts: parts, gapIdx: gapIdx, wayM: wayM, linkM: linkM, gapM: gapM, expanded: expanded, byClass: byClass, roadRuns: runs, Bxy: B };
  }
  function dedupe(pts) { return pts.filter(function (p, i) { return !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1] }); }

  /** 1.3.0: stretches on roads that re-route (longer than roadDetourMax x straight) or back-track (head away from the
   *  leg end by more than backtrackM). Short stretches (< 200 m) are always fine. */
  function badRoadRuns(res, o) {
    var B = res.Bxy;
    return (res.roadRuns || []).filter(function (r) {
      if (r.m < 200) return false;
      var p0 = r.pts[0], p1 = r.pts[r.pts.length - 1];
      var straight = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      // 1.4.0: back-track = at some point the road gets farther from the leg end than it already was, by more than
      // backtrackM, or a tenth of the stretch (before: farther than where the stretch started, which missed a loop that comes back)
      // 1.6.0: both tests on the detourLen() line (50 m steps, switchback stacks straightened)
      var D = detourLenXY(r.pts, o);
      var best = Infinity, regress = 0;
      D.pts.forEach(function (p) { var d = Math.hypot(B[0] - p[0], B[1] - p[1]); best = Math.min(best, d); regress = Math.max(regress, d - best); });
      if (regress > Math.max(o.backtrackM, 0.1 * D.m)) return true;   // a long winding road may dip away a little more
      return D.m > o.roadDetourMax * Math.max(straight, 1);
    });
  }

  /** classify() on answers already loaded (exported for tests) */
  function classifyLine(answers, a, b, o) {
    o = Object.assign({ nearM: 60, maxDeg: 40 }, o || {});
    var P = projector((a[0] + b[0]) / 2), A = P.xy(a), B = P.xy(b), L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    var out = { primary: 0, piste: 0, traces: 0, any: 0, n: 0, m: Math.round(L) };
    if (L < 1) return out;
    var ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, cosMax = Math.cos(o.maxDeg * Math.PI / 180);
    // segments near the line, per tier (a 250 m grid along the corridor)
    var CELL = 250, grid = new Map(), seen = new Set();
    answers.forEach(function (ans) {
      ((ans && ans.elements) || []).forEach(function (e) {
        if (e.type !== 'way' || !e.geometry || seen.has(e.id)) return; seen.add(e.id);
        var tr = tierOf(e.tags); if (!tr) return;
        var prev = null;
        e.geometry.forEach(function (g) {
          if (!g) { prev = null; return; }
          var q = P.xy([g.lat, g.lon]);
          if (prev) {
            // keep only segments near the leg line
            var mx = (prev[0] + q[0]) / 2, my = (prev[1] + q[1]) / 2, t = (mx - A[0]) * ux + (my - A[1]) * uy, side = Math.abs((mx - A[0]) * uy - (my - A[1]) * ux);
            var sl = Math.hypot(q[0] - prev[0], q[1] - prev[1]);
            if (t > -o.nearM - sl && t < L + o.nearM + sl && side < o.nearM + sl) {
              var sg = [prev, q, tr];
              var x0 = Math.floor(Math.min(prev[0], q[0]) / CELL), x1 = Math.floor(Math.max(prev[0], q[0]) / CELL), y0 = Math.floor(Math.min(prev[1], q[1]) / CELL), y1 = Math.floor(Math.max(prev[1], q[1]) / CELL);
              if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 400) for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) { var kk = cx + ',' + cy; (grid.get(kk) || grid.set(kk, []).get(kk)).push(sg); }
            }
          }
          prev = q;
        });
      });
    });
    var n = Math.max(2, Math.round(L / 20)), cnt = { primary: 0, piste: 0, traces: 0, any: 0 };
    for (var i = 0; i <= n; i++) {
      var p = [A[0] + (B[0] - A[0]) * i / n, A[1] + (B[1] - A[1]) * i / n], hit = {};
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var l = grid.get((Math.floor(p[0] / CELL) + dx) + ',' + (Math.floor(p[1] / CELL) + dy)); if (!l) continue;
        l.forEach(function (sg) {
          if (hit[sg[2]]) return;
          var h = segDist(p, sg[0], sg[1]); if (h.d > o.nearM) return;
          var sx = sg[1][0] - sg[0][0], sy = sg[1][1] - sg[0][1], sl = Math.hypot(sx, sy) || 1;
          if (Math.abs((sx * ux + sy * uy) / sl) < cosMax) return;   // crosses the line rather than following it
          hit[sg[2]] = true;
        });
      }
      ['primary', 'piste', 'traces'].forEach(function (k) { if (hit[k]) cnt[k]++; });
      if (hit.primary || hit.piste || hit.traces) cnt.any++;
    }
    ['primary', 'piste', 'traces', 'any'].forEach(function (k) { out[k] = +(cnt[k] / (n + 1)).toFixed(3); });
    out.n = n + 1;
    return out;
  }
  /** 1.5.0 Auto: the tier to try first from classifyLine()'s shares, then the order to fall back in */
  function autoOrder(cov, o) {
    o = Object.assign({ autoMin: 0.5 }, o || {});
    var tiers = ['primary', 'piste', 'traces'].sort(function (x, y) { return cov[y] - cov[x] });
    var first = cov[tiers[0]] >= o.autoMin || (cov.any >= o.autoMin && cov[tiers[0]] > 0) ? tiers[0] : 'offpiste';
    // nothing runs along the line itself: still try roads, Piste, then Traces, but builders accept those only when the
    // route stays on mapped ways (>= 80 %) and is short (detourLen <= 2x the straight line); "~" marks that stricter test
    if (first === 'offpiste') return ['primary~', 'piste~', 'traces~', 'offpiste'];   // 1.6.0: the short test is 2x detourLen()
    // fall back down the tiers (Primary Piste -> Piste -> Traces), skipping tiers the line does not touch at all; off-piste last
    var down = { primary: ['piste', 'traces'], piste: ['traces'], traces: ['piste'] }[first].filter(function (t) { return cov[t] > 0.05 });
    return [first].concat(down, ['offpiste']);
  }
  // ------------------------------------------------------------------ the router (data + cache + search)
  function createRouter(io) {
    io = io || {};
    var mem = new Map(), inflight = new Map(), routes = new Map(), queue = Promise.resolve();
    // one Overpass request at a time (fair use); the same box asked twice shares one request
    var loaded = []; // [box, answer] already in memory, for "inside a loaded box" hits
    var inside = function (b, c) { return b[0] >= c[0] && b[1] >= c[1] && b[2] <= c[2] && b[3] <= c[3] };
    function tile(box, o) {
      var key = 'tr4:' + box.join(',');   // tr4 = 1.3.0 query (small roads any surface + highways); tr1-tr3 answers differ
      if (mem.has(key)) return Promise.resolve(mem.get(key));
      for (var i = 0; i < loaded.length; i++) if (inside(box, loaded[i][0])) return Promise.resolve(loaded[i][1]);
      if (inflight.has(key)) return inflight.get(key);
      var p = Promise.resolve(io.cacheGet ? io.cacheGet(key).catch(function () { return null }) : null).then(function (hit) {
        if (hit) { mem.set(key, hit); loaded.push([box, hit]); return hit; }
        // one retry of the whole helper call: its cool-downs then send it to another mirror (a cold first query to a
        // busy server is the usual failure; the second one mostly comes back in a second)
        var ask = function () { return io.overpass(overpassQuery(box, o.overpassTimeoutS), box); };
        var run = queue.then(ask).catch(function (e) { if (/^offline/.test(e && e.message) || o.retries === 0) throw e; return ask(); });
        queue = run.catch(function () {});
        return run.then(function (j) {
          var slim = { elements: (j.elements || []).filter(function (e) { return e.type === 'way' }).map(function (e) { return { type: 'way', id: e.id, tags: e.tags, nodes: e.nodes, geometry: e.geometry } }) };
          // an empty answer is kept for this session only (it may be a mirror that has no data here)
          mem.set(key, slim); loaded.push([box, slim]); if (io.cachePut && slim.elements.length) try { io.cachePut(key, slim) } catch (e) {}
          return slim;
        });
      });
      inflight.set(key, p);
      return p.finally(function () { inflight.delete(key) });
    }
    /**
     * route(a, b, opts) -> Promise<{ points, parts, wayM, linkM, gapM, totalM, onShare, status:'ok'|'partial'|'none', ms, tiles, ways }>
     * Throws only when the map data cannot be loaded (Overpass down) or the leg is too long.
     */
    function route(a, b, opts) {
      var o = Object.assign({}, DEFAULTS, opts || {});
      a = [a[0], wrapLon(a[1])]; b = [b[0], wrapLon(b[1])];   // 1.1.2: Overpass rejects lon outside -180..180
      var rk = [a[0], a[1], b[0], b[1]].map(function (x) { return (+x).toFixed(6) }).join(',') + ':' + (o.profile || 'mixed');
      if (routes.has(rk)) return Promise.resolve(Object.assign({}, routes.get(rk), { cached: true, ms: 0 }));
      var L = dist(a, b);
      if (L / 1000 > o.maxLegKm) return Promise.reject(new Error('leg longer than ' + o.maxLegKm + ' km: add waypoints'));
      var boxes = queryBoxes(a, b, o);
      if (boxes.length > o.maxTiles) return Promise.reject(new Error('leg too long for track routing: add waypoints'));
      var t0 = Date.now(), done = 0;
      return Promise.all(boxes.map(function (bx) { return tile(bx, o).then(function (r) { done++; if (o.onProgress) o.onProgress(done, boxes.length); return r; }) })).then(function (answers) {
        var t1 = Date.now();
        var skip = new Set(), G, res, dropped = 0;
        for (var tries = 0; ; tries++) {
          G = buildGraph(answers, (a[0] + b[0]) / 2, skip, o.joinCrossings, o.profile);
          res = findPath(G, a, b, o);
          var bad = res ? badRoadRuns(res, o) : [];
          if (!bad.length || tries >= o.roadRetries) break;
          bad.forEach(function (r) { r.ways.forEach(function (id) { skip.add(id) }); dropped += r.ways.size; });
        }
        res = res || { points: [a, b], parts: [{ kind: 'gap', points: [a, b], m: L }], gapIdx: [[0, 1]], wayM: 0, linkM: 0, gapM: L, byClass: { track: 0, path: 0, road: 0, highway: 0 } };
        res.roadWaysDropped = dropped; delete res.roadRuns; delete res.Bxy;
        var totalM = res.wayM + res.linkM + res.gapM;
        res.totalM = totalM;
        res.onShare = totalM ? res.wayM / totalM : 0;
        res.status = res.wayM < 1 ? 'none' : res.gapM > 0 ? 'partial' : 'ok';
        if (res.status === 'none') { res.points = [a, b]; res.parts = [{ kind: 'gap', points: [a, b], m: L }]; res.gapIdx = [[0, 1]]; res.gapM = L; res.linkM = 0; res.totalM = L; }
        res.gaps = res.parts.filter(function (p) { return p.kind === 'gap' }).map(function (p) { return p.points });
        res.ways = G.nWays; res.kinds = G.kinds; res.tiles = boxes.length; res.fetchMs = t1 - t0; res.searchMs = Date.now() - t1; res.ms = Date.now() - t0;
        routes.set(rk, res);
        return res;
      });
    }
    /**
     * 1.5.0 Auto: how much of the straight line a -> b runs along each tier. Samples every ~20 m; a sample counts for a
     * tier when a way of that tier is within nearM (60 m) and runs roughly the same way (within 40 deg). Returns
     * { primary, piste, traces, any: share 0..1 of the samples, n, m }. Uses the same map tiles as route().
     */
    function classify(a, b, opts) {
      var o = Object.assign({ nearM: 60, maxDeg: 40 }, DEFAULTS, opts || {});
      a = [a[0], wrapLon(a[1])]; b = [b[0], wrapLon(b[1])];
      var L = dist(a, b);
      if (L / 1000 > o.maxLegKm) return Promise.reject(new Error('leg longer than ' + o.maxLegKm + ' km: add waypoints'));
      var boxes = queryBoxes(a, b, o);
      if (boxes.length > o.maxTiles) return Promise.reject(new Error('leg too long for track routing: add waypoints'));
      return Promise.all(boxes.map(function (bx) { return tile(bx, o) })).then(function (answers) {
        return classifyLine(answers, a, b, o);
      });
    }
    return { route: route, classify: classify, clear: function () { mem.clear(); routes.clear(); loaded.length = 0; } };
  }

  /**
   * An io.overpass for createRouter that goes through RoadbookGen.askOverpass (the site's mirrors), sharing one
   * options object so the "sticky" mirror and the cool-downs carry over from leg to leg. A regional mirror (one that
   * only holds, say, North America) stays sticky only while the boxes are inside its region: otherwise a leg in
   * Morocco after one in Utah would ask the North America copy and get an empty answer.
   */
  function viaRoadbookGen(RB, o, log) {
    o = o || {};
    var regions = (RB.DEFAULTS && RB.DEFAULTS.overpassRegional) || [];
    return function (q, box) {
      var st = o._overpassSticky;
      if (st && box) {
        var r = regions.filter(function (x) { return x.ep === st })[0];
        if (r && !(box[0] >= r.s && box[2] <= r.n && box[1] >= r.w && box[3] <= r.e)) o._overpassSticky = null;
      }
      return RB.askOverpass(q, o, log);
    };
  }

  return { VERSION: VERSION, viaRoadbookGen: viaRoadbookGen, DEFAULTS: DEFAULTS, wayCost: wayCost, tierOf: tierOf, classifyLine: classifyLine, autoOrder: autoOrder, detourLen: detourLen, detourLenXY: detourLenXY, overpassQuery: overpassQuery, legBbox: legBbox, queryBoxes: queryBoxes,
    buildGraph: buildGraph, findPath: findPath, wayClass: wayClass, badRoadRuns: badRoadRuns, createRouter: createRouter, dist: dist, wrapLon: wrapLon };
});
