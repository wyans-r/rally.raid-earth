/* Rally Raid roadbook editor (roadbook.html). Works on two files:
 *   the stage   (rallyraid-stage, from the builder: index.html hands it over in localStorage, or a file / example)
 *   the roadbook (rallyraid-roadbook, docs/ROADBOOK_FORMAT.md), made here by roadbook-gen.js and edited by hand.
 * Every hand edit goes through RoadbookGen.applyChanges(by: 'editor'), so boxes get provenance, revisions and history,
 * and are pinned: "Regenerate, keep edits" (mergeRegenerated) never overwrites them. Work is autosaved in the browser
 * (IndexedDB), map tiles and OpenStreetMap answers are cached there too. */
(function () {
  'use strict';
  const RB = window.RoadbookGen, R = window.RoadbookRender, PDF = window.RoadbookPDF;
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pad3 = c => (c == null || !isFinite(c)) ? '---' : String(((Math.round(c) % 360) + 360) % 360).padStart(3, '0');
  const now = () => new Date().toISOString();
  const localTime = iso => { const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const TRACKS = ['tarmac', 'gravel', 'track', 'twotrack', 'sand', 'path', 'offpiste', 'water', 'fence', 'railway'];
  const HANDOFF = 'rallyraid-roadbook-stage';

  // ------------------------------------------------------------------ browser storage: cache + autosave (IndexedDB)
  const IDB = (() => {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no IndexedDB'));
      const r = indexedDB.open('rallyraid-roadbook', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('docs'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const op = async (store, mode, f) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const q = f(t.objectStore(store)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
    return {
      get: (s, k) => op(s, 'readonly', o => o.get(k)).catch(() => undefined),
      put: (s, k, v) => op(s, 'readwrite', o => o.put(v, k)).catch(() => undefined),
      del: (s, k) => op(s, 'readwrite', o => o.delete(k)).catch(() => undefined)
    };
  })();
  async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join(''); }

  // ------------------------------------------------------------------ state
  const E = { recce: null, stage: null, stageHash: null, rb: null, S: null, sel: null, leg: null, view: 'list', undo: [], redo: [], gen: 0, busy: false, adding: false, stats: { demHits: 0, osmHits: 0 } };
  window.RoadbookEditor = { E };

  // ------------------------------------------------------------------ network with cache, cancel and backoff
  const cancelled = tok => tok !== E.gen;
  function makeFetchers(tok) {
    return {
      fetchBytes: async url => {
        if (cancelled(tok)) throw new Error('cancelled');
        const hit = await IDB.get('cache', 'dem:' + url);
        if (hit !== undefined) { E.stats.demHits++; return hit && hit.byteLength ? hit : null; }
        const r = await fetch(url);
        if (r.status === 404) { IDB.put('cache', 'dem:' + url, new ArrayBuffer(0)); return null; }
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        const ab = await r.arrayBuffer(); IDB.put('cache', 'dem:' + url, ab); return ab;
      },
      fetchOverpass: async (ep, q, opts) => {
        if (cancelled(tok)) throw new Error('cancelled');
        const key = 'osm:' + await sha(q);
        const hit = await IDB.get('cache', key);
        if (hit) { E.stats.osmHits++; return hit; }
        const ctl = new AbortController(), t = null;
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
        const poll = setInterval(() => { if (cancelled(tok)) ctl.abort(); }, 300);
        try {
          progressMsg('asking ' + ep.replace(/^https:\/\/([^/]+).*/, '$1') + '...');
          // the generator's fetch: gives up on a silent mirror after 10 s, but lets a big answer finish once data flows
          const j = await window.RoadbookGen.defaultOverpass(ep, q, Object.assign({ timeout: 120000 }, opts || {}, { signal: ctl.signal }));
          if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error(j.remark.slice(0, 80));
          IDB.put('cache', key, j); return j;
        } catch (e) { if (cancelled(tok)) throw new Error('cancelled'); progressMsg(ep.replace(/^https:\/\/([^/]+).*/, '$1') + ': ' + (e.name === 'AbortError' ? 'timed out' : e.message) + ', trying again'); throw e; }
        finally { clearTimeout(t); clearInterval(poll); }
      }
    };
  }

  // ------------------------------------------------------------------ progress / banners / status
  const PHASE = { terrain: 'Terrain (elevation tiles)', osm: 'OpenStreetMap', landmarks: 'Landmarks (OpenStreetMap)', landcover: 'Land cover (ESA WorldCover)', assemble: 'Building boxes', done: 'Done' };
  function progress(on, phase, frac, msg) {
    const p = $('#progress'); p.hidden = !on; if (!on) return;
    if (phase) p.querySelector('.phase').textContent = PHASE[phase] || phase;
    if (frac != null) p.querySelector('.bar i').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (msg != null) p.querySelector('.msg').textContent = msg;
  }
  const progressMsg = m => { const el = $('#progress .msg'); if (el) el.textContent = m; };
  function banner(id, kind, html, actions) {
    let el = document.getElementById('bn-' + id);
    if (!html) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'bn-' + id; $('#banners').appendChild(el); }
    el.className = 'banner ' + kind; el.innerHTML = '<span>' + html + '</span>';
    for (const [label, f, cls] of (actions || [])) { const b = document.createElement('button'); b.className = 'b ' + (cls || ''); b.textContent = label; b.onclick = f; el.appendChild(b); }
    const x = document.createElement('button'); x.className = 'b x'; x.textContent = '\u2715'; x.title = 'hide'; x.onclick = () => el.remove(); el.appendChild(x);
  }

  // ------------------------------------------------------------------ map
  const map = L.map('map', { zoomControl: true, preferCanvas: false, worldCopyJump: true }).setView([-20, 13], 6);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' });
  const osmL = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' });
  sat.addTo(map);
  L.control.layers({ Satellite: sat, OpenStreetMap: osmL, Topographic: topo }, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const gStage = L.layerGroup().addTo(map), gRoute = L.layerGroup().addTo(map), gRecce = L.layerGroup().addTo(map), gBoxes = L.layerGroup().addTo(map), gEdit = L.layerGroup().addTo(map);
  const markers = new Map();

  // ------------------------------------------------------------------ route samples (km <-> position on the roadbook's line)
  function routeStage() {
    if (!E.stage) return null;
    if (E.rb && E.rb.route && E.rb.route.legs && E.rb.route.legs.length) return { waypoints: E.stage.waypoints, route: { legs: E.rb.route.legs } };
    return E.stage;
  }
  function rebuildSamples() { const st = routeStage(); E.S = st ? RB.resampleRoute(st, 20) : null; }
  function nearestSample(lat, lon) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < E.S.length; i++) { const d = RB.geo.dist([E.S[i].lat, E.S[i].lon], [lat, lon]); if (d < bd) { bd = d; best = i; } }
    return { i: best, s: E.S[best], d: bd };
  }
  function sampleAtKm(km) {
    const S = E.S; let lo = 0, hi = S.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].km < km) lo = m + 1; else hi = m; }
    return S[lo];
  }

  // ------------------------------------------------------------------ edits (undo / redo, autosave)
  function snapshot() { E.undo.push(JSON.stringify(E.rb)); if (E.undo.length > 60) E.undo.shift(); E.redo = []; }
  function change(list, opts) {
    if (!E.rb) return;
    snapshot();
    const at = now();
    const res = RB.applyChanges(E.rb, list.map(c => Object.assign({ by: 'editor', at }, c)));
    E.rb.modified = at;
    if (opts && opts.after) opts.after();
    if (res.conflicts.length) toastConflicts(res.conflicts);
    refresh();
    return res;
  }
  function undo() { if (!E.undo.length) return; E.redo.push(JSON.stringify(E.rb)); E.rb = JSON.parse(E.undo.pop()); rebuildSamples(); refresh(true); }
  function redo() { if (!E.redo.length) return; E.undo.push(JSON.stringify(E.rb)); E.rb = JSON.parse(E.redo.pop()); rebuildSamples(); refresh(true); }
  let saveT = null;
  function autosave() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { if (E.rb && E.stage) IDB.put('docs', 'rb:' + E.stage.id, { rb: E.rb, stage: E.stage, saved: now() }); }, 400);
  }
  function toastConflicts(c) { banner('conf', 'warn', c.length + ' change(s) could not be applied: ' + esc(c.map(x => x.reason).join('; '))); }

  // ------------------------------------------------------------------ loading
  // longitudes folded into -180..180 (older files / share links could hold e.g. -371.3 after the map was panned a turn west)
  function wrapStageLons(s) {
    const bad = x => x < -180 || x > 180, wl = x => ((x + 180) % 360 + 360) % 360 - 180;
    const legs = (s.route && s.route.legs) || [], boxes = (s.roadbook && s.roadbook.boxes) || [];
    if (!(s.waypoints || []).some(w => bad(w.lon)) && !boxes.some(b => bad(b.lon)) && !legs.some(l => (l.points || []).some(q => bad(q[1])))) return s;
    s = JSON.parse(JSON.stringify(s));
    for (const w of (s.waypoints || []).concat((s.roadbook && s.roadbook.boxes) || [])) if (w.lon != null && bad(w.lon)) w.lon = +wl(w.lon).toFixed(6);
    for (const l of ((s.route && s.route.legs) || [])) for (const q of (l.points || [])) if (bad(q[1])) q[1] = +wl(q[1]).toFixed(6);
    return s;
  }
  async function loadStage(stage, how, starter, opts) {
    if (!stage || stage.format !== 'rallyraid-stage') throw new Error('not a rally raid stage file');
    const legacy = ((stage.roadbook && stage.roadbook.boxes) || []).filter(b => (b.notes && String(b.notes).trim()) || +b.danger > 0).length;
    banner('legacy', 'info', !legacy ? null : legacy + ' point(s) of this stage carry roadbook notes from an older stage file. Roadbook text now lives only in the roadbook: they move in as pinned boxes when you generate (or regenerate).');
    stage = wrapStageLons(stage);
    E.stage = stage; E.stageHash = await RB.stageHash(stage); E.rb = null; E.sel = null; E.leg = null; E.undo = []; E.redo = [];
    $('#stage-name').textContent = (stage.name || stage.id) + ' \u00b7 ' + (stage.lengthKm != null ? (+stage.lengthKm).toFixed(1) + ' km' : '') + (how ? ' \u00b7 ' + how : '');
    document.title = 'Roadbook: ' + (stage.name || stage.id);
    $('#empty').hidden = true;
    const saved = (opts && opts.ignoreSaved) ? null : await IDB.get('docs', 'rb:' + stage.id);
    // an example's ready-made roadbook also fits the same stage handed over from the builder (same route = same hash)
    if (!starter && !(saved && saved.rb)) {
      const ex = await fetch('examples/' + encodeURIComponent(stage.id) + '.roadbook.json').then(r => r.ok ? r.json() : null).catch(() => null);
      if (ex && ex.stage && ex.stage.hash === E.stageHash) starter = ex;
    }
    if (saved && saved.rb) {
      setRoadbook(saved.rb, { quiet: true });
      banner('restored', 'info', 'Restored your roadbook for this stage from this browser (saved ' + esc(localTime(saved.saved)) + ').', [['Start fresh', () => { if (confirm('Throw away the roadbook saved in this browser for this stage and generate a new one?')) { IDB.del('docs', 'rb:' + stage.id); generate(false); } }]]);
    } else if (starter && starter.format === 'rallyraid-roadbook') {
      setRoadbook(starter, { quiet: true });
      banner('restored', 'info', 'This is the example\'s ready-made roadbook. Edit it, or press <b>Regenerate, keep edits</b> to refresh it from the map data.');
    } else {
      rebuildSamples(); drawStage(); refresh(true); fitStage();
      banner('restored', 'info', 'Stage loaded. Press <b>Generate</b> to make the draft roadbook.', [['Generate', () => generate(false), 'p']]);
    }
  }
  function setRoadbook(rb, opts) {
    if (!rb || rb.format !== 'rallyraid-roadbook') throw new Error('not a roadbook file (format rallyraid-roadbook)');
    if ((rb.schemaVersion || 0) > 1) throw new Error('made by a newer editor (schema ' + rb.schemaVersion + ')');
    E.rb = rb; rb.editor = rb.editor || {};
    if (rb.settings && rb.settings.density) { $('#density').value = rb.settings.density; $('#density-v').textContent = rb.settings.density; }
    densityReadout(rb);
    rebuildSamples(); drawStage(); refresh(true);
    if (!(opts && opts.keepView)) fitStage();
    checkHash();
  }
  function checkHash() {
    if (!E.rb || !E.stage) return;
    if (E.rb.stage && E.rb.stage.id !== E.stage.id) banner('hash', 'err', 'This roadbook belongs to stage <b>' + esc(E.rb.stage.id) + '</b>, not ' + esc(E.stage.id) + '.');
    else if (E.rb.stage && E.rb.stage.hash && E.rb.stage.hash !== E.stageHash) banner('hash', 'warn', '<b>The stage has changed</b> since this roadbook was made (waypoints or route moved). Distances may be off. Regenerating re-measures your edited boxes on the new route and keeps them.', [['Regenerate, keep edits', () => generate(true), 'p']]);
    else banner('hash', null);
  }
  async function readFile(input) { const f = input.files[0]; input.value = ''; if (!f) return null; return JSON.parse(await f.text()); }

  // ------------------------------------------------------------------ generate / regenerate
  async function generate(merge) {
    if (!E.stage) return alert('Open a stage first.');
    if (E.busy) return;
    if (!merge && E.rb && E.rb.boxes.some(b => b.source === 'editor' || (b.sources || []).includes('editor') || b.pinned) && !confirm('Generate replaces the roadbook and your edits. (Use "Regenerate, keep edits" to keep them.) Go on?')) return;
    const tok = ++E.gen; E.busy = true; setBusy(true);
    const old = E.rb, ed = (old && old.editor) || {};
    const density = +$('#density').value;
    progress(true, 'terrain', 0, 'starting');
    let shownPartial = false;
    const opts = Object.assign({ density, osmOptional: true, lineOverrides: ed.lineOverrides || {}, legSeeds: ed.legSeeds || {},
      log: m => console.log('[roadbook]', m),
      onProgress: e => { if (cancelled(tok)) return; const base = { terrain: 0, osm: 0.35, landmarks: 0.8, landcover: 0.9, assemble: 0.95, done: 1 }[e.phase] || 0, span = { terrain: 0.35, osm: 0.45, landmarks: 0.1, landcover: 0.05 }[e.phase] || 0;
        progress(true, e.phase, base + span * (e.total ? e.done / e.total : 0), e.msg || (e.total > 1 ? e.done + ' / ' + e.total + (/osm|landmarks/.test(e.phase) ? ' map requests' : ' tiles') : null)); },
      onPartial: p => { if (cancelled(tok)) return; if (!old) { shownPartial = true; p.editor = { lineOverrides: opts.lineOverrides, legSeeds: opts.legSeeds }; setRoadbook(p, { keepView: false }); banner('partial', 'info', 'Terrain notes are in. Junctions, fords, gates and villages from OpenStreetMap are loading (the public map servers can be slow; answers are cached in this browser).'); } }
    }, makeFetchers(tok));
    try {
      const fresh = await RB.generate(E.stage, opts);
      if (cancelled(tok)) return;
      fresh.editor = { lineOverrides: opts.lineOverrides, legSeeds: opts.legSeeds };
      banner('partial', null); banner('restored', null);
      if (merge && old) {
        snapshot();
        const m = RB.mergeRegenerated(old, fresh, E.stage, { density });
        m.editor = fresh.editor; m.route = fresh.route; m.planner = fresh.planner;
        const orph = m.boxes.filter(b => b.orphan && !b.deleted).length;
        setRoadbook(m, { keepView: true });
        banner('merge', orph || (m.conflicts || []).length ? 'warn' : 'info', 'Regenerated: ' + m.boxes.filter(b => !b.deleted).length + ' boxes; your pinned / edited boxes were kept' + (orph ? '; <b>' + orph + ' kept box(es) are now more than 150 m off the route</b> (marked)' : '') + ((m.conflicts || []).length ? '; ' + m.conflicts.length + ' conflict(s), see the box panel' : '') + '.');
      } else {
        if (old && !shownPartial) snapshot();
        setRoadbook(fresh, { keepView: !!old || shownPartial });
      }
      if (fresh.stats && fresh.stats.migratedFromStage) { banner('legacy', 'info', 'Moved the roadbook notes of ' + fresh.stats.migratedFromStage + ' stage point(s) into the roadbook as pinned boxes (marked EDIT).'); }
      if (fresh.partial === 'terrain-only') banner('osmfail', 'warn', 'OpenStreetMap could not be reached, so this roadbook has terrain notes only (no junctions / fords / gates). Try <b>Regenerate, keep edits</b> later.', [['Retry now', () => generate(true)]]);
      else banner('osmfail', null);
    } catch (e) {
      if (!cancelled(tok) && e.message !== 'cancelled') { console.error(e); banner('err', 'err', 'Generating failed: ' + esc(e.message)); }
    } finally {
      if (!cancelled(tok) || E.gen === tok) { E.busy = false; setBusy(false); progress(false); }
    }
  }
  function setBusy(b) { ['#b-gen', '#b-regen'].forEach(s => $(s).disabled = b); }

  // ------------------------------------------------------------------ drawing: stage, route, boxes
  function fitStage() {
    const st = E.stage; if (!st) return;
    const pts = [].concat(...((st.route && st.route.legs) || []).map(l => l.points)); if (!pts.length) st.waypoints.forEach(w => pts.push([w.lat, w.lon]));
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  }
  function drawStage() {
    gStage.clearLayers();
    if (!E.stage || !$('#show-stage').checked) return;
    for (const l of ((E.stage.route && E.stage.route.legs) || [])) L.polyline(l.points, { color: '#ffffff', weight: 2, opacity: .55, dashArray: '4 6', interactive: false }).addTo(gStage);
    for (const w of E.stage.waypoints) L.circleMarker([w.lat, w.lon], { radius: 4, color: '#111', weight: 1, fillColor: '#ffd400', fillOpacity: 1, interactive: false }).bindTooltip(w.type + (w.n != null ? ' ' + w.n : ''), { permanent: false }).addTo(gStage);
  }
  function legKey(l) { return l.from + '>' + l.to; }
  function drawRoute() {
    gRoute.clearLayers(); gEdit.clearLayers();
    const legs = (E.rb && E.rb.route && E.rb.route.legs) || [];
    for (const l of legs) {
      const planned = l.mode === 'direct', sel = E.leg === legKey(l);
      const pl = L.polyline(l.points, { color: planned ? '#ff8a00' : '#36a3ff', weight: sel ? 6 : 4, opacity: .9 }).addTo(gRoute);
      if (planned) { pl.on('click', ev => { L.DomEvent.stop(ev); if (E.adding) return addBoxAt(ev.latlng); selectLeg(legKey(l), { noFit: true }); }); pl.bindTooltip('off-piste line ' + (l.edited ? '(edited by hand)' : '(planned)') + ': click to re-plan / edit', { sticky: true }); }
      else pl.on('click', ev => { if (E.adding) { L.DomEvent.stop(ev); addBoxAt(ev.latlng); } });
      if (planned && sel && $('#edit-line').checked) drawLineHandles(l);
    }
  }
  function boxIcon(b) {
    const cls = ['bx', b.waypoint ? 'wp' : '', b.danger ? 'd' + b.danger : '', b.pinned ? 'pin' : '', b.deleted ? 'del' : '', E.sel === b.id ? 'sel' : ''].join(' ');
    return L.divIcon({ className: '', html: '<div class="' + cls + '">' + (b.deleted ? '\u2715' : b.n) + '</div>', iconSize: [24, 24], iconAnchor: [12, 12] });
  }
  function drawBoxes() {
    gBoxes.clearLayers(); markers.clear();
    if (!E.rb) return;
    const showDel = $('#show-deleted').checked;
    for (const b of E.rb.boxes) {
      if (b.deleted && !showDel) continue;
      if (b.lat == null) continue;
      const m = L.marker([b.lat, b.lon], { icon: boxIcon(b), draggable: !b.deleted && !b.waypoint, zIndexOffset: E.sel === b.id ? 1000 : (b.waypoint ? 500 : 0), keyboard: false });
      m.on('click', () => select(b.id, { pan: false }));
      m.on('dragend', () => moveBoxTo(b.id, m.getLatLng()));
      m.bindTooltip((b.n || '') + ' \u00b7 ' + (+b.km).toFixed(2) + ' km \u00b7 ' + esc((b.notes || '').slice(0, 60)), { direction: 'top', offset: [0, -10] });
      m.addTo(gBoxes); markers.set(b.id, m);
    }
  }

  // ------------------------------------------------------------------ list + strip
  const tulCache = new Map();
  function tulipSmall(t) { const k = JSON.stringify(t || null); if (!tulCache.has(k)) tulCache.set(k, R.tulipSVG(t, 44)); return tulCache.get(k); }
  function visibleBoxes() {
    if (!E.rb) return [];
    const f = $('#filter').value.trim().toLowerCase(), showDel = $('#show-deleted').checked;
    return E.rb.boxes.filter(b => (showDel || !b.deleted) && (!f || (b.notes || '').toLowerCase().includes(f) || (b.symbols || []).some(s => s.includes(f)) || String(b.km).startsWith(f) || String(b.n) === f || (b.label || '').toLowerCase().includes(f)));
  }
  function recceBy(b) { return [b.source].concat(b.sources || []).find(x => /^recce/.test(x || '')); }
  function flags(b) {
    const ed = b.source === 'editor' || (b.sources || []).includes('editor');
    return (b.pinned ? '<span class="flag pin" title="pinned: kept when you regenerate">PIN</span>' : '') + (ed ? '<span class="flag ed" title="edited by hand">EDIT</span>' : '') +
 (recceBy(b) ? '<span class="flag rc" title="from the in-game recce (' + esc(recceBy(b)) + ')">RECCE</span>' : '') + (b.source === 'recce-auto' && !b.verified ? '<span class="flag chk" title="detected by the car, nobody checked it yet">CHECK</span>' : '') +
      (b.orphan ? '<span class="flag orph" title="more than 150 m off the route after a route change">OFF ROUTE</span>' : '') + '<span class="flag src">' + esc((b.source || '').replace('auto-', '')) + '</span>';
  }
  function renderList() {
    const el = $('#list'), boxes = visibleBoxes();
    el.classList.toggle('strip', E.view === 'strip');
    if (!E.rb) { el.innerHTML = '<p class="dim" style="padding:10px">No roadbook yet.</p>'; return; }
    if (E.view === 'strip') {
      el.innerHTML = '<style>' + R.CSS + '</style><div class="rb"><table>' + boxes.map(b => R.boxRow(Object.assign({}, b, { partial: b.partial || 0 })).replace('<tr class="', '<tr data-id="' + esc(b.id) + '" class="' + (E.sel === b.id ? 'sel ' : '') + (b.deleted ? 'del ' : ''))).join('') + '</table></div>';
    } else {
      el.innerHTML = boxes.map(b => '<div class="row' + (E.sel === b.id ? ' sel' : '') + (b.waypoint ? ' wp' : '') + (b.deleted ? ' del' : '') + '" data-id="' + esc(b.id) + '">' +
        '<span class="n">' + (b.deleted ? '\u2715' : b.n) + '</span><span class="km"><b>' + (+b.km).toFixed(2) + '</b><small>' + (b.partial != null ? (+b.partial).toFixed(2) : '') + '</small></span>' +
        '<span class="tul">' + tulipSmall(b.tulip) + '</span><span class="tx"><div class="nt" title="' + esc(b.notes) + '">' + esc(b.notes || '(no notes)') + '</div><div class="sy">' + (b.symbols || []).slice(0, 6).map(s => R.symbolSVG(s, 18)).join('') + '</div></span>' +
        '<span class="fl">' + (b.danger ? '<span class="dg">' + '!'.repeat(b.danger) + '</span>' : '') + '<span>CAP ' + pad3(b.capOut != null ? b.capOut : b.cap) + '</span><span>' + flags(b) + '</span></span></div>').join('');
    }
    const live = E.rb.boxes.filter(b => !b.deleted), st = E.rb.stats || {};
    $('#counts').textContent = live.length + ' boxes' + (st.per10km && st.per10km.offPiste != null ? ' \u00b7 off-piste ' + st.per10km.offPiste + '/10 km' : '') + ' \u00b7 ' + live.filter(b => b.pinned).length + ' pinned';
    const s = el.querySelector('.sel'); if (s && E.scrollList) { s.scrollIntoView({ block: 'nearest' }); E.scrollList = false; }
  }
  $('#list').addEventListener('click', e => { const r = e.target.closest('[data-id]'); if (r) select(r.dataset.id, { pan: true }); });

  // ------------------------------------------------------------------ selection
  function select(id, opts) {
    E.sel = id; E.leg = null; E.scrollList = true;
    const b = E.rb && E.rb.boxes.find(x => x.id === id);
    if (b && opts && opts.pan && b.lat != null) { if (map.getZoom() < 13) map.setView([b.lat, b.lon], 14); else map.panTo([b.lat, b.lon], { animate: true }); }
    refresh();
  }
  function selectLeg(key, opts) {
    E.leg = key; E.sel = null; refresh();
    const l = legOf(key); if (l && !(opts && opts.noFit)) map.fitBounds(L.latLngBounds(l.points), { padding: [40, 40], maxZoom: 15 });
  }
  function refresh(full) {
    densityReadout(E.rb);
    renderList(); drawBoxes(); drawRoute(); drawRecce(); renderPanel();
    $('#b-undo').disabled = !E.undo.length; $('#b-redo').disabled = !E.redo.length;
    ['#b-save', '#b-pdf', '#b-regen'].forEach(s => $(s).disabled = !E.rb || (s === '#b-regen' && E.busy));
    autosave();
  }

  // ------------------------------------------------------------------ recce import (a drive recorded in the game)
  // The game's recce mode writes <stage>.recce.json: the driven line and change records (confirm / move / retag /
  // delete / add, by the driver or detected by the car). Here they are reviewed one by one and applied with the same
  // rules as everywhere else (RoadbookGen.applyChanges); a change on a box you edited here since becomes a conflict.
  function loadRecce(doc) {
    if (!E.rb) { alert('Open (or generate) the roadbook of this stage first, then import its recce.'); return; }
    const r = RB.readRecce(doc, E.rb);
    if (r.errors.length) { alert('Cannot use this recce file: ' + r.errors.join('; ')); return; }
    const pv = RB.previewChanges(E.rb, r.changes);
    E.recce = { doc, driven: r.driven, warnings: r.warnings, open: true, sel: null, rescale: false,
      items: r.changes.map((c, i) => ({ c, st: pv[i].status, reason: pv[i].reason, on: pv[i].status === 'ok' })) };
    E.sel = null; E.leg = null;
    const pts = r.driven.points;
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p => [p[0], p[1]])), { padding: [40, 40], maxZoom: 15 });
    banner('recce', 'info', 'Recce imported: ' + r.changes.length + ' change(s), ' + (+(r.driven.km || (pts.length ? pts[pts.length - 1][2] : 0))).toFixed(2) + ' km driven' + (r.warnings.length ? '. ' + esc(r.warnings.join('. ')) : '') + '. Review them on the right.');
    refresh();
  }
  function recceWhere(c) {
    if (c.op === 'add' && c.box) return [c.box.lat, c.box.lon];
    if (c.op === 'move' && c.lat != null) return [c.lat, c.lon];
    const b = E.rb && E.rb.boxes.find(x => x.id === c.id); return b && b.lat != null ? [b.lat, b.lon] : null;
  }
  function drawRecce() {
    gRecce.clearLayers();
    const X = E.recce; if (!X) return;
    const pts = X.driven.points, brk = new Set(X.driven.breaks.map(n => n - 1));
    let seg = [];
    const flush = () => { if (seg.length > 1) L.polyline(seg, { color: '#d65cff', weight: 3, opacity: .9, className: 'recce-line' }).bindTooltip('recce: driven line').addTo(gRecce); seg = []; };
    pts.forEach((p, i) => { if (brk.has(i)) flush(); seg.push([p[0], p[1]]); }); flush();
    X.items.forEach((it, k) => {
      const ll = recceWhere(it.c); if (!ll || ll[0] == null) return;
      const letter = { add: '+', confirm: '\u2713', move: '\u2192', update: 'T', delete: '\u2715' }[it.c.op] || '?';
      const m = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="rcm ' + it.st + (X.sel === k ? ' sel' : '') + '">' + letter + '</div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 2000, keyboard: false });
      m.bindTooltip(esc(RB.describeChange(it.c, E.rb)), { direction: 'top', offset: [0, -8] });
      m.on('click', () => { X.sel = k; X.open = true; refresh(); });
      m.addTo(gRecce);
    });
  }
  function renderReccePanel(P) {
    const X = E.recce, n = X.items.filter(i => i.on).length;
    const count = st => X.items.filter(i => i.st === st).length;
    P.innerHTML = '<h3>Recce review <span style="margin-left:auto"><button class="b" id="rc-close" title="Hide the review (the track stays on the map)">Close</button></span></h3>' +
      '<p class="dim" style="margin:4px 0">' + esc((X.doc.stage && (X.doc.stage.name || X.doc.stage.id)) || '') + (X.doc.updated ? ' \u00b7 recorded ' + esc(localTime(X.doc.updated)) : '') + ' \u00b7 ' +
        count('ok') + ' new, ' + count('conflict') + ' conflict, ' + count('done') + ' already in</p>' +
      X.warnings.map(w => '<div class="conf">' + esc(w) + '</div>').join('') +
      '<div class="fr"><button class="b" id="rc-all">All</button><button class="b" id="rc-none">None</button><button class="b" id="rc-driver" title="Only what the driver did (not what the car detected)">Driver only</button></div>' +
      '<div class="rc-list">' + X.items.map((it, k) => '<div class="rc-item' + (X.sel === k ? ' sel' : '') + (it.st === 'done' ? ' done' : '') + '" data-k="' + k + '"><input type="checkbox" data-on="' + k + '"' + (it.on ? ' checked' : '') + (it.st === 'done' ? ' disabled' : '') + '>' +
        '<span><span class="op">' + esc(it.c.op) + '</span>' + esc(RB.describeChange(it.c, E.rb)) + '<span class="st ' + it.st + '">' + (it.st === 'ok' ? 'new' : it.st === 'done' ? 'already in this roadbook' : 'conflict: ' + esc(it.reason)) + (it.c.at ? ' \u00b7 ' + esc(localTime(it.c.at)) : '') + '</span></span></div>').join('') + '</div>' +
      '<label style="display:block;margin:6px 0"><input type="checkbox" id="rc-rescale"' + (X.rescale ? ' checked' : '') + '> Re-measure km from the driven line (distances as your trip meter read them)</label>' +
      '<div class="fr"><button class="b p" id="rc-apply"' + (n || X.rescale ? '' : ' disabled') + '>Apply ' + n + ' change(s)' + (X.rescale ? ' + km' : '') + '</button><button class="b" id="rc-drop" title="Remove the recce track and this list">Discard recce</button></div>' +
      (E.rb.conflicts && E.rb.conflicts.length ? '<div class="fr"><button class="b" id="rc-conf">Resolve ' + E.rb.conflicts.length + ' conflict(s)&hellip;</button></div>' : '') +
      '<p class="dim" style="font-size:11px">Changes on boxes you edited here since the recce become conflicts (pick one in the Conflicts list). Undo (Ctrl+Z) takes the whole import back.</p>';
    P.querySelector('#rc-close').onclick = () => { X.open = false; refresh(); };
    P.querySelector('#rc-drop').onclick = () => { E.recce = null; banner('recce', 'info', null); refresh(); };
    P.querySelector('#rc-all').onclick = () => { X.items.forEach(i => { if (i.st !== 'done') i.on = true; }); renderPanel(); };
    P.querySelector('#rc-none').onclick = () => { X.items.forEach(i => i.on = false); renderPanel(); };
    P.querySelector('#rc-driver').onclick = () => { X.items.forEach(i => i.on = i.st !== 'done' && i.c.by !== 'recce-auto'); renderPanel(); };
    P.querySelector('#rc-rescale').onchange = e => { X.rescale = e.target.checked; renderPanel(); };
    P.querySelectorAll('[data-on]').forEach(cb => cb.addEventListener('click', e => { e.stopPropagation(); X.items[+cb.dataset.on].on = cb.checked; renderPanel(); }));
    P.querySelectorAll('.rc-item').forEach(row => row.addEventListener('click', () => {
      const k = +row.dataset.k; X.sel = k; const ll = recceWhere(X.items[k].c);
      if (ll && ll[0] != null) { if (map.getZoom() < 14) map.setView(ll, 16); else map.panTo(ll); }
      drawRecce(); renderPanel();
    }));
    P.querySelector('#rc-apply').onclick = applyRecce;
    const rc = P.querySelector('#rc-conf'); if (rc) rc.onclick = () => { X.open = false; refresh(); };
    const s = P.querySelector('.rc-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function applyRecce() {
    const X = E.recce; if (!X) return;
    const list = X.items.filter(i => i.on).map(i => i.c);
    let matched = 0;
    const res = change(list, { after: () => {
      if (X.rescale) matched = RB.rescaleToDriven(E.rb, X.driven);
      else if (E.S) {
        // a box added in recce sits where the car was: its km is measured on this roadbook's route (the trip meter
        // may have been off during the recce)
        for (const c of list) if (c.op === 'add') { const b = E.rb.boxes.find(x => x.id === c.id); if (b && b.lat != null) { const s = nearestSample(b.lat, b.lon); if (s && s.d < 150) b.km = +s.s.km.toFixed(3); } }
      }
      RB.renumber(E.rb);
    } });
    const pv = RB.previewChanges(E.rb, X.items.map(i => i.c));
    X.items.forEach((it, k) => { it.st = pv[k].status; it.reason = pv[k].reason; it.on = false; });
    banner('recce', 'info', 'Recce applied: ' + (res ? res.applied : 0) + ' change(s)' + (res && res.conflicts.length ? ', ' + res.conflicts.length + ' conflict(s) to resolve (Conflicts list)' : '') + (X.rescale ? ', km re-measured on ' + matched + ' box(es) on the driven line' : '') + '. Save the roadbook and copy it to the game.');
    X.rescale = false;
    refresh();
  }
  $('#in-recce').addEventListener('change', async e => { try { const j = await readFile(e.target); if (j) loadRecce(j); } catch (err) { alert('Could not open the recce file: ' + err.message); } });
  window.RoadbookEditor.loadRecce = loadRecce;

  // ------------------------------------------------------------------ box operations
  function capAt(s) { return Math.round(((s.hdg % 360) + 360) % 360); }
  function moveBoxTo(id, ll) {
    const b = E.rb.boxes.find(x => x.id === id); if (!b || !E.S) return;
    const n = nearestSample(ll.lat, ll.lng);
    if (n.d > 300 && !confirm('That is ' + Math.round(n.d) + ' m from the route. Put the box on the nearest route point?')) return refresh();
    change([{ op: 'move', id, baseRev: b.rev, lat: +n.s.lat.toFixed(6), lon: +n.s.lon.toFixed(6), km: +n.s.km.toFixed(2) }], { after: () => { const x = E.rb.boxes.find(y => y.id === id); x.capOut = x.cap = capAt(n.s); } });
  }
  function moveBoxKm(id, km) {
    const s = sampleAtKm(km); const b = E.rb.boxes.find(x => x.id === id);
    change([{ op: 'move', id, baseRev: b.rev, lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6), km: +(+km).toFixed(2) }], { after: () => { const x = E.rb.boxes.find(y => y.id === id); x.capOut = x.cap = capAt(s); } });
  }
  function newBoxAt(s, extra) {
    const id = 'ed-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const prev = sampleAtKm(Math.max(0, s.km - 0.06));
    const box = Object.assign({ km: +s.km.toFixed(2), lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6), capIn: capAt(prev), capOut: capAt(s), cap: capAt(s), offPiste: s.mode === 'direct',
      label: 'NOTE', notes: '', symbols: [], danger: 0, tulip: { entry: { track: s.mode === 'direct' ? 'offpiste' : 'track' }, exit: { angle: Math.round(RB.geo.rel(capAt(prev), capAt(s))), track: s.mode === 'direct' ? 'offpiste' : 'track' }, branches: [] } }, extra || {});
    change([{ op: 'add', id, box }]);
    select(id, { pan: false });
    return id;
  }
  function addBoxAt(ll) {
    E.adding = false; $('#map').classList.remove('adding'); $('#b-addbox').classList.remove('on');
    const n = nearestSample(ll.lat, ll.lng);
    if (n.d > 300) return alert('Click on (or near) the route line to add a box.');
    newBoxAt(n.s);
  }
  function splitBox(id) {
    const live = E.rb.boxes.filter(b => !b.deleted), i = live.findIndex(b => b.id === id);
    const a = live[i], b = live[i + 1]; if (!a || !b) return alert('Split adds a box half way to the next box: this is the last box.');
    newBoxAt(sampleAtKm((a.km + b.km) / 2), { notes: 'CAP ' + pad3(a.capOut != null ? a.capOut : a.cap) });
  }
  const setFields = (b, fields) => change([{ op: 'update', id: b.id, baseRev: b.rev, fields }]);

  // ------------------------------------------------------------------ the right panel: box editor / leg / conflicts
  function thumbHTML(b) {
    // the satellite map round the box (Esri World Imagery tiles, zoom 16: the 340 x 190 px view is ~800 x 450 m at the
    // equator), with the roadbook line drawn over it and the box in the middle
    const Z = 16, W = 340, Hh = 190, n = Math.pow(2, Z);
    const px = (lat, lon) => { const x = (lon + 180) / 360 * n * 256, s = Math.sin(lat * Math.PI / 180); return [x, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256]; };
    const [cx, cy] = px(b.lat, b.lon), x0 = cx - W / 2, y0 = cy - Hh / 2;
    let tiles = '';
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + Hh) / 256); ty++)
      tiles += '<img src="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + Z + '/' + ty + '/' + ((tx % n) + n) % n + '" style="position:absolute;left:' + (tx * 256 - x0).toFixed(0) + 'px;top:' + (ty * 256 - y0).toFixed(0) + 'px;width:256px;height:256px">';
    let path = '';
    if (E.S) {
      const near = E.S.filter(s => Math.abs(s.lat - b.lat) < 0.01 && Math.abs(s.lon - b.lon) < 0.012);
      path = near.map((s, k) => { const [x, y] = px(s.lat, s.lon); return (k ? 'L' : 'M') + (x - x0).toFixed(1) + ' ' + (y - y0).toFixed(1); }).join(' ');
    }
    const cap = b.capOut != null ? b.capOut : b.cap, a = (cap || 0) * Math.PI / 180;
    return '<div class="thumb" style="width:' + W + 'px;height:' + Hh + 'px">' + tiles + '<svg viewBox="0 0 ' + W + ' ' + Hh + '"><path d="' + path + '" fill="none" stroke="#ff8a00" stroke-width="2.5" stroke-dasharray="7 4"/>' +
      '<circle cx="' + W / 2 + '" cy="' + Hh / 2 + '" r="11" fill="none" stroke="#ffd400" stroke-width="2.5"/>' +
      (cap != null ? '<line x1="' + W / 2 + '" y1="' + Hh / 2 + '" x2="' + (W / 2 + Math.sin(a) * 30).toFixed(1) + '" y2="' + (Hh / 2 - Math.cos(a) * 30).toFixed(1) + '" stroke="#ffd400" stroke-width="2.5"/>' : '') +
      '</svg><span class="attr">Esri World Imagery \u00b7 zoom 16</span></div>';
  }
  function renderPanel() {
    const P = $('#panel');
    if (E.recce && E.recce.open) return renderReccePanel(P);
    if (E.leg) return renderLegPanel(P);
    const b = E.rb && E.rb.boxes.find(x => x.id === E.sel);
    const conf = (E.rb && E.rb.conflicts) || [];
    let confHTML = '';
    if (conf.length) confHTML = '<div class="sec"><span class="t">Conflicts (' + conf.length + ')</span>' + conf.map((c, k) => '<div class="conf"><b>' + esc(c.change && c.change.op) + '</b> by ' + esc(c.change && c.change.by) + ' on box ' + esc(c.change && c.change.id) + ': ' + esc(c.reason) +
      '<div class="fr" style="margin-top:4px"><button class="b" data-cf="apply" data-k="' + k + '">Apply theirs</button><button class="b" data-cf="keep" data-k="' + k + '">Keep mine</button></div></div>').join('') + '</div>';
    if (!b) { P.innerHTML = '<p class="dim">Click a box in the list or on the map to edit it. Click the orange off-piste line to re-plan or edit it.</p>' + (E.rb ? '<p class="kbd">Keys: \u2191 / \u2193 previous / next box \u00b7 Del delete \u00b7 Ctrl+Z undo \u00b7 Ctrl+S save</p>' : '') + confHTML; bindConf(P); return; }
    const live = E.rb.boxes.filter(x => !x.deleted), idx = live.indexOf(b);
    const t = b.tulip && typeof b.tulip === 'object' ? b.tulip : { entry: { track: 'track' }, exit: { angle: 0, track: 'track' }, branches: [] };
    P.innerHTML =
      '<h3>' + (b.deleted ? 'Deleted box' : 'Box ' + b.n) + (b.waypoint ? ' <span class="flag pin">' + esc(b.label) + '</span>' : '') + '<span style="margin-left:auto" class="fr">' +
        '<button class="b" id="p-prev" title="previous box (\u2191)"' + (idx <= 0 ? ' disabled' : '') + '>\u25B2</button><button class="b" id="p-next" title="next box (\u2193)"' + (idx >= live.length - 1 ? ' disabled' : '') + '>\u25BC</button></span></h3>' +
      '<div class="dim">' + flags(b) + ' rev ' + (b.rev || 1) + (b.verified ? ' \u00b7 verified' : '') + '</div>' +
      (b.lat != null ? '<div class="sec">' + thumbHTML(b) + '</div>' : '') +
      '<div class="sec"><div class="fr"><label>km <input type="number" id="p-km" step="0.01" min="0" value="' + (+b.km).toFixed(2) + '"' + (b.waypoint ? ' disabled title="waypoint boxes sit on their waypoint"' : '') + '></label>' +
        '<span class="dim">partial ' + (b.partial != null ? (+b.partial).toFixed(2) : '-') + '</span>' +
        '<label>CAP <input type="number" id="p-cap" min="0" max="359" step="1" value="' + (b.capOut != null ? b.capOut : (b.cap != null ? b.cap : '')) + '"></label></div>' +
        '<label class="t">Notes</label><textarea id="notes" placeholder="e.g. KEEP LEFT ON TRACK, DUNES START">' + esc(b.notes || '') + '</textarea>' +
        '<div class="abbr" title="FIM roadbook abbreviations: click to insert">' + R.ABBR.map(([a, m]) => '<button data-ab="' + esc(a) + '" title="' + esc(m) + '">' + esc(a) + '</button>').join('') + '</div>' +
        '<div class="fr dng"><span class="dim">Danger</span>' + [0, 1, 2, 3].map(d => '<button class="b' + ((b.danger || 0) === d ? ' on' : '') + '" data-dng="' + d + '">' + (d ? '!'.repeat(d) : 'none') + '</button>').join('') + '</div></div>' +
      '<div class="sec"><span class="t">Symbols <span class="dim" style="text-transform:none">(click one to remove)</span></span><div class="chips">' + (b.symbols || []).map(s => '<span class="chip" data-rm="' + esc(s) + '" title="remove ' + esc(s) + '">' + R.symbolSVG(s, 30) + '</span>').join('') +
        '<button class="b" id="p-pal">+ symbol</button></div><div class="palette" id="pal" hidden></div></div>' +
      '<div class="sec"><span class="t">Tulip <span class="dim" style="text-transform:none">(drag the arrow or a side road; you arrive at the dot)</span></span><div class="tulipwrap"><svg id="tulip-ed" viewBox="0 0 120 120"></svg><div class="brs" id="brs"></div></div></div>' +
      '<div class="sec fr"><label class="b" title="pinned boxes are kept as they are when you regenerate"><input type="checkbox" id="p-pin"' + (b.pinned ? ' checked' : '') + '> Pinned</label>' +
        '<label class="b" title="checked on the ground / in a recce"><input type="checkbox" id="p-ver"' + (b.verified ? ' checked' : '') + '> Verified</label></div>' +
      '<div class="sec fr"><button class="b" id="p-split" title="add a box half way to the next one">Split</button><button class="b" id="p-add" title="click the route to add a box">+ Box on map</button>' +
        (b.deleted ? '<button class="b" id="p-restore">Restore</button>' : (b.waypoint ? '' : '<button class="b danger" id="p-del" title="Del">Delete</button>')) + '</div>' +
      '<div class="sec"><span class="t">History</span><div class="hist">' + ((b.history || []).slice().reverse().map(h => 'rev ' + h.rev + ' \u00b7 ' + esc(h.by) + ' \u00b7 ' + esc(h.change) + (h.at ? ' \u00b7 ' + esc(localTime(h.at)) : '')).join('<br>') || 'generated (' + esc(b.source) + ')') + '</div></div>' + confHTML;
    // wiring
    const on = (s, ev, f) => { const el = P.querySelector(s); if (el) el.addEventListener(ev, f); };
    on('#p-prev', 'click', () => select(live[idx - 1].id, { pan: true })); on('#p-next', 'click', () => select(live[idx + 1].id, { pan: true }));
    on('#p-km', 'change', e => { const v = +e.target.value; if (isFinite(v)) moveBoxKm(b.id, Math.max(0, Math.min(E.S[E.S.length - 1].km, v))); });
    on('#p-cap', 'change', e => { const v = ((Math.round(+e.target.value) % 360) + 360) % 360; if (isFinite(v)) setFields(b, { capOut: v, cap: v }); });
    on('#notes', 'change', e => { const v = R.noteCase(e.target.value.trim()); e.target.value = v; setFields(b, { notes: v }); });
    P.querySelectorAll('[data-ab]').forEach(x => x.addEventListener('mousedown', e => {
      e.preventDefault(); const ta = P.querySelector('#notes'); if (!ta) return;
      const a = x.dataset.ab, st = ta.selectionStart != null ? ta.selectionStart : ta.value.length, en = ta.selectionEnd != null ? ta.selectionEnd : st;
      const pre = ta.value.slice(0, st), ins = (pre && !/\s$/.test(pre) ? ' ' : '') + a + ' ';
      ta.value = pre + ins + ta.value.slice(en); ta.value = R.noteCase(ta.value); setFields(b, { notes: ta.value.trim() });
    }));
    P.querySelectorAll('[data-dng]').forEach(x => x.addEventListener('click', () => setFields(b, { danger: +x.dataset.dng })));
    P.querySelectorAll('[data-rm]').forEach(x => x.addEventListener('click', () => setFields(b, { symbols: (b.symbols || []).filter(s => s !== x.dataset.rm) })));
    on('#p-pal', 'click', () => { const pal = P.querySelector('#pal'); pal.hidden = !pal.hidden; if (!pal.hidden) renderPalette(pal, b); });
    on('#p-pin', 'change', e => { if (e.target.checked) setFields(b, {}); else { snapshot(); b.pinned = false; b.rev = (b.rev || 1) + 1; b.history = (b.history || []).concat([{ rev: b.rev, at: now(), by: 'editor', change: 'unpinned' }]); refresh(); } });
    on('#p-ver', 'change', e => { if (e.target.checked) change([{ op: 'confirm', id: b.id, baseRev: b.rev }]); else setFields(b, { verified: false }); });
    on('#p-split', 'click', () => splitBox(b.id)); on('#p-add', 'click', startAdding);
    on('#p-del', 'click', () => deleteBox(b)); on('#p-restore', 'click', () => setFields(b, { deleted: false }));
    tulipEditor(P.querySelector('#tulip-ed'), P.querySelector('#brs'), b, t);
    bindConf(P);
  }
  function bindConf(P) {
    P.querySelectorAll('[data-cf]').forEach(x => x.addEventListener('click', () => {
      const k = +x.dataset.k, c = E.rb.conflicts[k];
      snapshot(); E.rb.conflicts.splice(k, 1);
      if (x.dataset.cf === 'apply' && c && c.change) { const ch = Object.assign({}, c.change); delete ch.baseRev; RB.applyChanges(E.rb, [ch]); }
      refresh();
    }));
  }
  function deleteBox(b) { if (b.waypoint) return; const live = E.rb.boxes.filter(x => !x.deleted), i = live.indexOf(b); change([{ op: 'delete', id: b.id, baseRev: b.rev }]); const nx = live[i + 1] || live[i - 1]; if (nx) select(nx.id); }
  function renderPalette(pal, b) {
    const q = (E.palFilter || '').toLowerCase();
    pal.innerHTML = '<input class="pf" placeholder="search symbols (e.g. tree, gate, dune)" value="' + esc(E.palFilter || '') + '">' +
      Object.entries(R.GROUPS).map(([g, list]) => { list = list.filter(c => !q || c.includes(q) || R.symbolName(c).toLowerCase().includes(q)); return list.length ? '<div class="g">' + g + '</div>' + list.map(c => '<span class="ic' + ((b.symbols || []).includes(c) ? ' have' : '') + '" data-add="' + c + '" title="' + esc(R.symbolName(c)) + '">' + R.symbolSVG(c, 28) + '</span>').join('') : ''; }).join('');
    const pf = pal.querySelector('.pf'); pf.addEventListener('input', () => { E.palFilter = pf.value; renderPalette(pal, b); const n = pal.querySelector('.pf'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
    pal.querySelectorAll('[data-add]').forEach(x => x.addEventListener('click', () => { const c = x.dataset.add; if ((b.symbols || []).includes(c)) return; setFields(b, { symbols: (b.symbols || []).concat([c]) }); const p2 = $('#pal'); if (p2) { p2.hidden = false; renderPalette(p2, E.rb.boxes.find(y => y.id === b.id)); } }));
  }

  // ------------------------------------------------------------------ tulip editor (SVG with drag handles)
  function tulipEditor(svg, side, b, t0) {
    const t = JSON.parse(JSON.stringify(t0)); t.branches = t.branches || []; t.entry = t.entry || { track: 'track' }; t.exit = t.exit || { angle: 0, track: 'track' };
    const cx = 60, cy = 62, rad = d => d * Math.PI / 180;
    const pt = (a, L) => [cx + Math.sin(rad(a)) * L, cy - Math.cos(rad(a)) * L];
    function draw() {
      const inner = R.tulipSVG(t, 120).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
      let h = inner;
      if (t.pre && t.pre.length) { svg.innerHTML = h; return; }   // a junction complex: edited in the list beside it (the drawing follows)
      t.branches.forEach((br, k) => { const [x, y] = pt(br.angle, br.cross ? 50 : 40); h += '<circle class="h" data-h="b' + k + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6" fill="#36a3ff" fill-opacity=".85" stroke="#fff" stroke-width="1.5"/>'; });
      const [ex, ey] = pt(t.exit.angle || 0, 54); h += '<circle class="h" data-h="x" cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1) + '" r="7" fill="#ffd400" fill-opacity=".9" stroke="#111" stroke-width="1.5"/>';
      svg.innerHTML = h;
    }
    const opt = (sel) => TRACKS.map(x => '<option' + (x === sel ? ' selected' : '') + '>' + x + '</option>').join('');
    function sideHTML() {
      side.innerHTML = '<div class="br"><span style="width:44px">in</span><select data-f="entry">' + opt(t.entry.track) + '</select></div>' +
        '<div class="br"><span style="width:44px">out</span><select data-f="exit">' + opt(t.exit.track) + '</select><input type="number" data-f="exitA" value="' + Math.round(t.exit.angle || 0) + '" step="5" min="-180" max="180" title="exit angle, + = right"></div>' +
        t.branches.map((br, k) => '<div class="br"><span style="width:44px">side ' + (k + 1) + '</span><select data-b="' + k + '">' + opt(br.track) + '</select><input type="number" data-ba="' + k + '" value="' + Math.round(br.angle) + '" step="5" min="-180" max="180"><label title="crosses (a fence, a river...) rather than a side road"><input type="checkbox" data-bc="' + k + '"' + (br.cross ? ' checked' : '') + '>x</label><button class="b" data-bd="' + k + '" title="remove">\u2715</button></div>').join('') +
        (t.pre && t.pre.length ? '<div class="dim" style="margin-top:4px">earlier junctions in this box (m after the box, turn, way on):</div>' +
          t.pre.map((n, k) => '<div class="br"><span style="width:44px">j ' + (k + 1) + '</span><input type="number" data-pa="' + k + '" value="' + Math.round(n.at || 0) + '" step="10" min="0" title="metres after the box"><input type="number" data-pt="' + k + '" value="' + Math.round(n.angle || 0) + '" step="5" min="-180" max="180" title="turn, + = right"><select data-pk="' + k + '">' + opt(n.track) + '</select><button class="b" data-pd="' + k + '" title="remove this junction">\u2715</button></div>').join('') +
          '<div class="br"><span style="width:44px">last</span><input type="number" data-f="at" value="' + Math.round(t.at || 0) + '" step="10" min="0" title="metres after the box (the arrow)"></div>' : '') +
        '<div class="fr"><button class="b" id="br-add">+ side road</button><button class="b" id="br-pre" title="another junction before this one, in the same box">+ junction</button><button class="b" id="br-std" title="no side roads, straight on">reset</button></div>';
      side.querySelectorAll('select[data-f]').forEach(s => s.onchange = () => { t[s.dataset.f].track = s.value; commit(); });
      side.querySelector('[data-f=exitA]').onchange = e => { t.exit.angle = clampA(+e.target.value); commit(); };
      side.querySelectorAll('select[data-b]').forEach(s => s.onchange = () => { t.branches[+s.dataset.b].track = s.value; commit(); });
      side.querySelectorAll('[data-ba]').forEach(s => s.onchange = () => { t.branches[+s.dataset.ba].angle = clampA(+s.value); commit(); });
      side.querySelectorAll('[data-bc]').forEach(s => s.onchange = () => { const br = t.branches[+s.dataset.bc]; if (s.checked) br.cross = true; else delete br.cross; commit(); });
      side.querySelectorAll('[data-bd]').forEach(s => s.onclick = () => { t.branches.splice(+s.dataset.bd, 1); commit(); });
      side.querySelector('#br-add').onclick = () => { const used = t.branches.map(x => x.angle).concat([t.exit.angle || 0, 180]); let a = -90; for (const c of [-90, 90, -45, 45, -135, 135, 0]) if (!used.some(u => Math.abs(RB.geo.rel(u, c)) < 25)) { a = c; break; } t.branches.push({ angle: a, track: 'track' }); commit(); };
      side.querySelector('#br-std').onclick = () => { t.branches = []; t.exit.angle = 0; delete t.pre; delete t.at; commit(); };
      const dropPre = () => { if (t.pre && !t.pre.length) { delete t.pre; delete t.at; } };
      side.querySelectorAll('[data-pa]').forEach(x => x.onchange = () => { t.pre[+x.dataset.pa].at = Math.max(0, Math.round(+x.value)); commit(); });
      side.querySelectorAll('[data-pt]').forEach(x => x.onchange = () => { t.pre[+x.dataset.pt].angle = clampA(+x.value); commit(); });
      side.querySelectorAll('[data-pk]').forEach(x => x.onchange = () => { t.pre[+x.dataset.pk].track = x.value; commit(); });
      side.querySelectorAll('[data-pd]').forEach(x => x.onclick = () => { t.pre.splice(+x.dataset.pd, 1); dropPre(); commit(); });
      const atIn = side.querySelector('[data-f=at]'); if (atIn) atIn.onchange = () => { t.at = Math.max(0, Math.round(+atIn.value)); commit(); };
      side.querySelector('#br-pre').onclick = () => { t.pre = t.pre || []; const at0 = t.at || 0; t.pre.push({ at: at0, angle: 0, track: t.entry.track, branches: [{ angle: 90, track: 'track' }] }); t.at = at0 + 80; commit(); };
    }
    const clampA = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return Math.round(a / 5) * 5; };
    function commit() { setFields(b, { tulip: JSON.parse(JSON.stringify(t)) }); }
    let drag = null;
    svg.addEventListener('pointerdown', e => { const h = e.target.closest('[data-h]'); if (!h) return; drag = h.dataset.h; svg.setPointerCapture(e.pointerId); e.preventDefault(); });
    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 120 - cx, y = (e.clientY - r.top) / r.height * 120 - cy;
      const a = clampA(Math.atan2(x, -y) * 180 / Math.PI);
      if (drag === 'x') t.exit.angle = a; else t.branches[+drag.slice(1)].angle = a;
      draw();
    });
    svg.addEventListener('pointerup', () => { if (drag) { drag = null; commit(); } });
    draw(); sideHTML();
  }

  // ------------------------------------------------------------------ the off-piste line: re-plan per leg, drag vertices
  function legOf(key) { return ((E.rb && E.rb.route && E.rb.route.legs) || []).find(l => legKey(l) === key); }
  function renderLegPanel(P) {
    const l = legOf(E.leg); if (!l) { E.leg = null; return renderPanel(); }
    const ed = E.rb.editor || {}, ov = (ed.lineOverrides || {})[E.leg], seed = (ed.legSeeds || {})[E.leg] || 0;
    const st = ((E.rb.planner && E.rb.planner.legs) || []).find(x => x.from + '>' + x.to === E.leg) || {};
    const wp = id => { const w = E.stage.waypoints.find(x => x.id === id); return w ? w.type + (w.n != null ? ' ' + w.n : '') : id; };
    const inLeg = E.rb.boxes.filter(b => !b.deleted && b.km >= kmOfWp(l.from) - 1e-6 && b.km <= kmOfWp(l.to) + 1e-6).length;
    P.innerHTML = '<h3>Off-piste leg ' + esc(wp(l.from)) + ' \u2192 ' + esc(wp(l.to)) + '</h3>' +
      '<div class="dim">' + (+l.km).toFixed(2) + ' km \u00b7 ' + Math.max(0, l.points.length - 2) + ' bends \u00b7 ' + inLeg + ' boxes' + (ov ? ' \u00b7 <b style="color:#ffd88a">line drawn by hand</b>' : seed ? ' \u00b7 variation ' + seed : '') + (st.longestStraightM ? ' \u00b7 longest straight ' + (st.longestStraightM / 1000).toFixed(1) + ' km' : '') + '</div>' +
      '<div class="sec"><span class="t">Re-plan this leg</span><p class="dim">The planner finds a drivable line round steep dune faces, cliffs, buildings, water and fences, through saddles and low ground. A new variation gives another line of the same kind. Your edited boxes are kept (re-measured on the new line).</p>' +
        '<div class="fr"><button class="b p" id="l-seed">New variation</button><button class="b" id="l-reset"' + (ov || seed ? '' : ' disabled') + '>Back to the auto line</button></div></div>' +
      '<div class="sec"><span class="t">Draw it yourself</span><p class="dim">Tick <b>Edit line</b> (top of the map): drag the orange points, drag a white midpoint to add a bend, double-click a point to remove it. Then apply.</p>' +
        '<div class="fr"><label class="b"><input type="checkbox" id="l-edit"' + ($('#edit-line').checked ? ' checked' : '') + '> Edit line</label><button class="b p" id="l-apply"' + (E.lineDirty ? '' : ' disabled') + '>Apply line, update boxes</button></div></div>' +
      '<div class="sec"><button class="b" id="l-close">Close</button></div>';
    P.querySelector('#l-seed').onclick = () => { const ed2 = E.rb.editor = E.rb.editor || {}; ed2.legSeeds = Object.assign({}, ed2.legSeeds); ed2.legSeeds[E.leg] = seed + 1; if (ed2.lineOverrides) delete ed2.lineOverrides[E.leg]; generate(true); };
    P.querySelector('#l-reset').onclick = () => { const ed2 = E.rb.editor || {}; if (ed2.legSeeds) delete ed2.legSeeds[E.leg]; if (ed2.lineOverrides) delete ed2.lineOverrides[E.leg]; generate(true); };
    P.querySelector('#l-edit').onchange = e => { $('#edit-line').checked = e.target.checked; drawRoute(); };
    P.querySelector('#l-apply').onclick = () => { E.lineDirty = false; generate(true); };
    P.querySelector('#l-close').onclick = () => { E.leg = null; refresh(); };
  }
  function kmOfWp(id) { const b = E.rb.boxes.find(x => x.waypoint === id); if (b) return b.km; const w = E.stage.waypoints.find(x => x.id === id); return w ? w.km : 0; }
  function drawLineHandles(l) {
    const key = legKey(l), pts = l.points.map(p => [p[0], p[1]]);
    const store = () => { const ed = E.rb.editor = E.rb.editor || {}; ed.lineOverrides = Object.assign({}, ed.lineOverrides); ed.lineOverrides[key] = pts.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]); l.points = pts.map(p => p.slice()); l.edited = true; E.lineDirty = true; autosave(); };
    const line = L.polyline(pts, { color: '#ffd400', weight: 2, dashArray: '5 5', interactive: false }).addTo(gEdit);
    const vtx = L.divIcon({ className: '', html: '<div class="vtx"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
    const ghost = L.divIcon({ className: '', html: '<div class="vtx ghost"></div>', iconSize: [10, 10], iconAnchor: [5, 5] });
    pts.forEach((p, k) => {
      if (k === 0 || k === pts.length - 1) return; // the ends are the waypoints
      const m = L.marker(p, { icon: vtx, draggable: true, zIndexOffset: 2000 }).addTo(gEdit);
      m.on('drag', () => { const q = m.getLatLng(); pts[k] = [q.lat, q.lng]; line.setLatLngs(pts); });
      m.on('dragend', () => { store(); drawRoute(); renderPanel(); });
      m.on('dblclick', ev => { L.DomEvent.stop(ev); pts.splice(k, 1); store(); drawRoute(); renderPanel(); });
    });
    for (let k = 0; k + 1 < pts.length; k++) {
      const mid = [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2];
      const g = L.marker(mid, { icon: ghost, draggable: true, zIndexOffset: 1900, title: 'drag to add a bend' }).addTo(gEdit);
      g.on('dragend', () => { const q = g.getLatLng(); pts.splice(k + 1, 0, [q.lat, q.lng]); store(); drawRoute(); renderPanel(); });
    }
  }

  // ------------------------------------------------------------------ save / PDF / stage with the planned line
  function download(name, data, mime) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function roadbookFile() { const rb = JSON.parse(JSON.stringify(E.rb)); rb.modified = now(); return rb; }
  async function makePDF(format) {
    progress(true, 'PDF', 0, 'loading the PDF library');
    try {
      const doc = await PDF.build(E.rb, { format, render: R, onProgress: (d, t) => progress(true, 'PDF', d / t, 'box ' + d + ' / ' + t) });
      return doc;
    } finally { progress(false); }
  }
  window.RoadbookEditor = Object.assign(window.RoadbookEditor, {
    E, loadStage, setRoadbook, generate, select, change, undo, redo, makePDF, moveBoxTo, moveBoxKm, splitBox, newBoxAt, sampleAtKm, nearestSample, roadbookFile, IDB,
    selectLeg, refresh, shareCurrentRoadbook, openShareLink
  });

  // ------------------------------------------------------------------ UI wiring
  // the slider's readout: what the setting means, and what the current roadbook actually has
  function densityReadout(rb) {
    const d = +$('#density').value, kind = d <= 3 ? 'very sparse' : d <= 5 ? 'rally-like' : d <= 10 ? 'detailed' : 'dense';
    let t = kind + ', gaps up to ~' + Math.max(1, Math.round(40 / d)) + ' km';
    if (rb && rb.boxes && rb.settings && +rb.settings.density === d) {
      const live = rb.boxes.filter(b => !b.deleted).sort((a, b) => a.km - b.km), g = live.slice(1).map((b, i) => b.km - live[i].km).sort((a, b) => a - b);
      if (g.length) t += ' | now: ' + live.length + ' boxes, median gap ' + g[Math.floor(g.length / 2)].toFixed(1) + ' km, longest ' + g[g.length - 1].toFixed(1) + ' km';
    }
    $('#density-h').textContent = t;
  }
  E.densityReadout = densityReadout;
  $('#density').addEventListener('input', e => { $('#density-v').textContent = e.target.value; densityReadout(E.rb); });
  densityReadout(null);
  $('#b-gen').addEventListener('click', () => generate(false));
  $('#b-regen').addEventListener('click', () => generate(true));
  $('#b-cancel').addEventListener('click', () => { E.gen++; E.busy = false; setBusy(false); progress(false); banner('partial', null); });
  $('#b-undo').addEventListener('click', undo); $('#b-redo').addEventListener('click', redo);
  // symbol legend (FIM / Dakar)
  $('#b-legend').addEventListener('click', () => { $('#lg-body').innerHTML = '<style>' + R.LEGEND_CSS + '</style>' + R.legendHTML(); $('#legend').hidden = false; });
  $('#lg-close').addEventListener('click', () => { $('#legend').hidden = true; });
  $('#legend').addEventListener('click', e => { if (e.target.id === 'legend') $('#legend').hidden = true; });
  $('#lg-print').addEventListener('click', () => { const w = window.open('', '_blank'); if (!w) return; w.document.write('<!doctype html><title>Roadbook symbol legend</title><style>body{margin:0}@page{size:A4 landscape;margin:8mm}' + R.LEGEND_CSS + '.rbl{width:auto}</style>' + R.legendHTML()); w.document.close(); setTimeout(() => w.print(), 300); });
  $('#b-share').addEventListener('click', () => shareCurrentRoadbook());
  $('#b-save').addEventListener('click', () => { if (!E.rb) return; download(E.stage.id + '.roadbook.json', JSON.stringify(roadbookFile(), null, 1), 'application/json');
    banner('saved', 'info', 'Saved <b>' + esc(E.stage.id) + '.roadbook.json</b>. For the game, put it in <b>BeamNG user folder / current / rallyraid / roadbooks /</b>: the rally.raid Earth Roadbook app shows it when you load the stage.' +
      (E.rb.route && E.rb.route.legs.some(l => l.planned) ? ' The roadbook follows the planned off-piste line; you can also save the stage with that line:' : ''),
      E.rb.route && E.rb.route.legs.some(l => l.planned) ? [['Save stage with this line', () => { const st = RB.applyPlannedLine(E.stage, E.rb); download(E.stage.id + '.json', JSON.stringify(st, null, 1), 'application/json'); }]] : []); });
  $('#b-pdf').addEventListener('click', async () => { if (!E.rb) return; try { const f = $('#pdf-format').value; const doc = await makePDF(f); doc.save(E.stage.id + '_roadbook_' + f + '.pdf'); } catch (e) { banner('err', 'err', 'PDF failed: ' + esc(e.message)); } });
  async function onStageFile(input) { try { const j = await readFile(input); if (j) await loadStage(j, 'file'); } catch (e) { alert('Could not open the stage: ' + e.message); } }
  $('#in-stage').addEventListener('change', e => onStageFile(e.target)); $('#in-stage2').addEventListener('change', e => onStageFile(e.target));
  $('#in-rb').addEventListener('change', async e => {
    try {
      const j = await readFile(e.target); if (!j) return;
      if (!E.stage) { const ex = await fetchExample(j.stage && j.stage.id).catch(() => null); if (ex) await loadStage(ex, 'example'); else return alert('Open the stage this roadbook belongs to first (' + (j.stage && j.stage.id) + ').'); }
      if (E.rb) snapshot();
      setRoadbook(j);
    } catch (err) { alert('Could not open the roadbook: ' + err.message); }
  });
  $$('.tabs [data-view]').forEach(b => b.addEventListener('click', () => { E.view = b.dataset.view; $$('.tabs [data-view]').forEach(x => x.classList.toggle('on', x === b)); renderList(); }));
  $('#filter').addEventListener('input', renderList);
  $('#show-deleted').addEventListener('change', () => { renderList(); drawBoxes(); });
  $('#show-stage').addEventListener('change', drawStage);
  $('#edit-line').addEventListener('change', () => { if ($('#edit-line').checked && !E.leg) { const l = ((E.rb && E.rb.route && E.rb.route.legs) || []).find(x => x.mode === 'direct'); if (l) E.leg = legKey(l); renderPanel(); } drawRoute(); });
  function startAdding() { if (!E.rb) return; E.adding = !E.adding; $('#map').classList.toggle('adding', E.adding); $('#b-addbox').classList.toggle('on', E.adding); }
  $('#b-addbox').addEventListener('click', startAdding);
  map.on('click', ev => { if (E.adding) addBoxAt(ev.latlng.wrap()); });
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#b-save').click(); return; }
    if (typing || !E.rb) return;
    const live = visibleBoxes().filter(b => !b.deleted), i = live.findIndex(b => b.id === E.sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = live[Math.max(0, Math.min(live.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) select(n.id, { pan: true }); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && i >= 0) { e.preventDefault(); deleteBox(live[i]); }
    if (e.key === 'Escape') { $('#legend').hidden = true; E.adding = false; $('#map').classList.remove('adding'); $('#b-addbox').classList.remove('on'); }
  });
  window.addEventListener('beforeunload', () => { if (E.rb && E.stage) IDB.put('docs', 'rb:' + E.stage.id, { rb: E.rb, stage: E.stage, saved: now() }); });

  // ------------------------------------------------------------------ start: stage from the builder, ?example=, or pick one
  async function fetchExample(id) { if (!id) throw new Error('no id'); const r = await fetch('examples/' + encodeURIComponent(id) + '.json'); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  async function openShareLink() {
    const Share = window.RallyRaidShare;
    if (!Share) return false;
    const parsed = Share.parseHash(location.hash);
    if (!parsed) return false;
    if (Share.redirectIfNeeded(parsed)) return true;
    try {
      const data = Share.unpack(parsed);
      if (data.kind !== 'roadbook' || !data.roadbook) throw new Error('This share link is not a roadbook.');
      let stage = data.stage;
      if (!stage && data.roadbook.stage && data.roadbook.stage.id) {
        stage = await fetchExample(data.roadbook.stage.id).catch(() => null);
      }
      if (!stage) throw new Error('This roadbook link does not include its stage, and the stage could not be found here.');
      const saved = await IDB.get('docs', 'rb:' + stage.id);
      if (saved && saved.rb && !confirm('You have a roadbook for this stage saved in this browser (saved ' + localTime(saved.saved) + '). Open the shared roadbook and replace it? (Save the current one first if you want to keep it.)')) {
        await loadStage(stage, 'from this browser');
        return true;
      }
      await loadStage(stage, 'shared link', data.roadbook, { ignoreSaved: true });
      banner('restored', 'info', 'Opened a shared roadbook. The link carried the data; nothing was uploaded.');
      Share.clearHash();
      return true;
    } catch (e) {
      banner('err', 'err', esc(e.message));
      if (window.RallyRaidShare && RallyRaidShare.toast) RallyRaidShare.toast(e.message, 'err', 10000);
      return true; // handled (do not also load ?example=); keep the hash so it can be inspected
    }
  }
  async function shareCurrentRoadbook() {
    const Share = window.RallyRaidShare;
    if (!Share) return;
    if (!E.rb || !E.stage) return alert('Open or generate a roadbook first.');
    try {
      const info = Share.linkFor(Share.pageUrl('roadbook'), Share.packRoadbook(E.rb, E.stage));
      Share.shareOrCopy(info, { title: E.rb.name || E.stage.name || E.stage.id, text: 'Rally raid roadbook: ' + (E.rb.name || E.stage.name || E.stage.id) });
    } catch (e) { banner('err', 'err', 'Could not make a share link: ' + esc(e.message)); }
  }
  async function start() {
    refresh();
    fetch('examples/index.json').then(r => r.ok ? r.json() : null).then(j => {
      const sel = $('#ex-pick');
      for (const s of ((j && j.stages) || [])) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name || s.id; sel.appendChild(o); }
      sel.onchange = async () => { if (sel.value) { try { const starter = await fetch('examples/' + encodeURIComponent(sel.value) + '.roadbook.json').then(r => r.ok ? r.json() : null).catch(() => null); await loadStage(await fetchExample(sel.value), 'example', starter); } catch (e) { alert(e.message); } } };
    }).catch(() => {});
    if (await openShareLink()) return;
    const q = new URLSearchParams(location.search);
    try {
      if (q.get('from') === 'builder') {
        const t = localStorage.getItem(HANDOFF);
        if (t) { await loadStage(JSON.parse(t), 'from the builder'); $('#back').href = './'; return; }
      }
      if (q.get('example')) { const id = q.get('example'); const starter = await fetch('examples/' + encodeURIComponent(id) + '.roadbook.json').then(r => r.ok ? r.json() : null).catch(() => null); await loadStage(await fetchExample(id), 'example', starter); $('#back').href = './?example=' + encodeURIComponent(q.get('example')); return; }
    } catch (e) { banner('err', 'err', 'Could not open the stage: ' + esc(e.message)); }
  }
  start();
  window.addEventListener('hashchange', () => { openShareLink(); });
})();
