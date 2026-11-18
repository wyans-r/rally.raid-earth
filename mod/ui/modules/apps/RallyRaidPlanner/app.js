// rally.raid Earth Planner: plan a stage and its roadbook inside the game (docs/INGAME_PLANNER.md).
// The documents live here, in the same code the website uses (planner-core.js = the builder's import / export,
// roadbook-gen.js = the website's generator byte for byte, roadbook-render.js = the website's drawing), so a file
// goes stagebuilder.wyans.net -> game -> website unchanged. The game side is rallyRaid/planner.lua:
//   app -> Lua: rallyRaid_core.plannerCall(name, argsJson, text) (pose, mark, rec, list, readOpen / readChunk,
//               writeBegin / writeChunk / writeCommit, load, reloadRoadbook, open) and rallyRaid_core.cmd('planner...')
//   Lua -> app: guihooks 'RallyRaidPlanner' (state: open, pose, recording, the game's stage) and 'RallyRaidPlannerKey'
//               (the rallyRaid_plannerWaypoint / plannerBox actions, if the player bound a key: waypoint / box here).
//               No planner key by default (Wyans 2026-11-17): the bar (or PLANNER in the GPS app) opens / closes, REC
//               records, ADD HERE / + BOX HERE add at the car; 'RallyRaidKeys' has any key the player bound to show.
// RECCE panel (18 Nov: moved here from the Roadbook app, which is a reader now). Its own isolated scope, compiled into
// the Planner app; Lua -> panel: the 'recce' part of 'RallyRaidRoadbook' (rallyRaid_core.roadbookState, every update);
// panel -> Lua: rallyRaid_core.cmd('recce' | 'recce<Sub>', arg) as before. Symbols: roadbook-render.js (Roadbook app folder).
window.RallyRaidPanels = window.RallyRaidPanels || {}
window.RallyRaidPanels.recce = (function () {
  var APP = 'planner'
  var RENDER = '/ui/modules/apps/RallyRaidRoadbook/roadbook-render.js'
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'" }
  function luaVal(v) {
    if (v === null || v === undefined) return 'nil'
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'nil'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'string') return "'" + v.replace(/[^\x20-\x7e]/g, '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
    return '{' + Object.keys(v).filter(function (k) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) }).map(function (k) { return k + '=' + luaVal(v[k]) }).join(', ') + '}'
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function arr(x) { return Array.isArray(x) ? x : (x && typeof x === 'object') ? Object.keys(x).sort(function (a, b) { return a - b }).map(function (k) { return x[k] }) : [] }
  function renderer(cb) {
    if (window.RoadbookRender) return cb(window.RoadbookRender)
    var w = window.__rrbWait = window.__rrbWait || []
    w.push(cb)
    if (w.length > 1) return
    var s = document.createElement('script')
    s.src = RENDER
    s.onload = function () { var l = window.__rrbWait; window.__rrbWait = null; l.forEach(function (f) { f(window.RoadbookRender) }) }
    document.head.appendChild(s)
  }
  return {
    template: '<div class="rpl-recce">' +
      '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidPlanner/recce.css">' +
      '<div class="rrc rrc-off" ng-if="!r.recce">' +
        '<div class="rrc-top"><b>RECCE</b><span class="rrc-dim">&nbsp;fix the loaded roadbook while you drive it</span><span class="rrc-sp"></span>' +
          '<button class="rrb-btn on" ng-click="cmd(\'recce\')" ng-disabled="!r.stageId" title="{{ kt(\'rallyRaid_recce\', \'Recce mode on: record the line, mark and fix boxes as you drive\') }}">RECCE ON</button></div>' +
        '<div class="rrc-dim" ng-if="r.stageId">Stage in the game: <b>{{ r.stageName || r.stageId }}</b> &middot; {{ r.boxCount || 0 }} boxes{{ r.roadbookFile ? \'\' : \' (no roadbook file: MERGE needs one)\' }}</div>' +
        '<div class="rrc-dim" ng-if="!r.stageId">No stage loaded in the game. Load one with STAGES in the GPS app, then RECCE ON. Recce works on the stage the game has loaded.</div>' +
      '</div>' +
      '<div class="rrc" ng-if="r.recce">' +
        '<div class="rrc-top"><span class="rrc-dot" ng-class="{air: r.recce.airborne}"></span><b>RECCE</b> {{ r.recce.km.toFixed(2) }} km &middot; {{ r.recce.changes }} <span class="rrc-dim">({{ r.recce.auto }} auto)</span>' +
          '<span class="rrc-sp"></span><button class="rrb-btn" ng-click="cmd(\'recce\')" title="{{ kt(\'rallyRaid_recce\', \'Recce off (writes the report)\') }}">OFF</button><button class="rrb-btn" ng-click="cmd(\'recceUndo\')" title="{{ kt(\'rallyRaid_recceUndo\', \'Take the last change back\') }}">UNDO</button>' +
          '<button class="rrb-btn" ng-click="merge()" title="First shows what a merge would do; then CONFIRM MERGE writes the changes into the roadbook file (a backup is kept)">MERGE</button>' +
          '<label class="rrc-ck" title="When merging, re-measure the box km from the driven line"><input type="checkbox" ng-model="ui.rescale"> km</label></div>' +
        '<div class="rrc-last" ng-if="r.recce.last">DETECTED: {{ r.recce.last.notes }}</div>' +
        '<div class="rrc-pv" ng-if="r.recce.preview && !r.recce.pending"><span>MERGE PREVIEW: <b>{{ r.recce.preview.applied }}</b> of {{ r.recce.preview.changes }} apply, ' +
          '<b ng-class="{warn: r.recce.preview.conflicts}">{{ r.recce.preview.conflicts }}</b> conflicts <span class="rrc-dim">{{ r.recce.preview.why.join(\'; \') }}</span></span>' +
          '<span><button class="rrb-btn on" ng-click="mergeConfirm()">CONFIRM MERGE</button><button class="rrb-btn" ng-click="cmd(\'reccePreviewCancel\')">CANCEL</button></span></div>' +
        // the box the buttons act on: the selected one (step with < >, or AT TRIP), else the nearest
        '<div class="rrc-near" ng-if="r.recce.target && !r.recce.pending"><span>{{ r.recce.target.how === \'selected\' ? \'SEL\' : \'NEAR\' }} <b>{{ r.recce.target.n }}</b> {{ r.recce.target.km.toFixed(2) }} km' +
          '<span ng-if="r.recce.target.d !== undefined && r.recce.target.d !== null"> &middot; {{ r.recce.target.d }} m</span> <span class="rrc-dim">{{ (r.recce.target.notes || \'\').substr(0, 12) }}</span></span>' +
          '<span><button class="rrb-btn" ng-class="{on: r.recce.target.verified}" ng-click="cmd(\'recceConfirm\')" title="{{ kt(\'rallyRaid_recceConfirm\', \'Confirm this box\') }}">&#10003;</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceMove\')" title="{{ kt(\'rallyRaid_recceMove\', \'Move it here\') }}">HERE</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceRetag\')" title="{{ kt(\'rallyRaid_recceRetag\', \'Retag\') }}">TAG</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceDelete\')" title="{{ kt(\'rallyRaid_recceDelete\', \'Delete this box\') }}">&#10005;</button></span></div>' +
        '<div class="rrc-near rrc-sel" ng-if="!r.recce.pending"><span>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceSel\', \'prev\')" title="select the box before">&#9664;</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceSel\', \'next\')" title="select the box after">&#9654;</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceSel\', \'trip\')" title="select the box the trip meter is in">AT TRIP</button>' +
          '<button class="rrb-btn" ng-show="r.recce.target.how === \'selected\'" ng-click="cmd(\'recceSel\', \'nearest\')" title="back to the nearest box">NEAREST</button></span>' +
          '<span ng-if="r.recce.target"><button class="rrb-btn" ng-click="cmd(\'recceKm\', \'trip\')" title="this box is at the trip meter reading now: set its km (the partials after it follow)">KM = TRIP</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceKm\', \'-10\')" title="10 m earlier">-10</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceKm\', \'+10\')" title="10 m later">+10</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceCap\')" title="the CAP out of this box := the car heading now">CAP HERE</button></span></div>' +
        '<div class="rrc-near" ng-if="!r.recce.pending"><button class="rrb-btn rrc-add" ng-click="cmd(\'recceDrop\')" title="{{ kt(\'rallyRaid_recceDrop\', \'A new box at the car\') }}">+ BOX HERE</button>' +
          '<span><button class="rrb-btn" ng-class="{on: ui.list}" ng-click="ui.list = !ui.list" title="every recce change not merged yet; UNDO takes any one back">CHANGES {{ r.recce.changes }}</button>' +
          '<button class="rrb-btn" ng-click="cmd(\'recceReport\')" title="save a report of the changes (text + JSON) in the BeamNG user folder">REPORT</button></span></div>' +
        '<div class="rrc-report rrc-dim" ng-if="r.recce.report && !r.recce.pending">REPORT: {{ r.recce.report.txt || r.recce.report.json }}</div>' +
        '<div class="rrc-list" ng-if="ui.list && !r.recce.pending">' +
          '<div class="rrc-dim" ng-hide="r.recce.list.length">No changes yet.</div>' +
          '<div class="rrc-li" ng-repeat="c in r.recce.list track by c.i" ng-class="{old: c.earlier, gone: c.gone}">' +
            '<span class="rrc-k">{{ c.kind }}</span><span class="rrc-n">{{ c.n ? (\'#\' + c.n) : \'-\' }}</span><span class="rrc-km">{{ c.km !== undefined && c.km !== null ? c.km.toFixed(2) : \'\' }}</span>' +
            '<span class="rrc-t">{{ c.text }}{{ c.earlier ? \' (earlier)\' : \'\' }}</span>' +
            '<button class="rrb-btn" ng-click="cmd(\'recceUndoAt\', c.i)" title="take this change back">UNDO</button></div></div>' +
        '<div class="rrc-pick" ng-if="r.recce.pending">' +
          '<div class="rrc-dim">{{ r.recce.pending.mode === \'add\' ? \'NEW BOX HERE\' : \'RETAG BOX\' }}: symbols, danger, notes</div>' +
          '<div class="rrc-row rrc-tabs"><button class="rrb-btn" ng-repeat="g in groups" ng-class="{on: ui.grp === g}" ng-click="setGrp(g)">{{ g === \'quick\' ? \'QUICK\' : g.toUpperCase() }}</button>' +
            '<input class="rrc-find" ng-model="ui.find" ng-change="findSym()" placeholder="find symbol"></div>' +
          '<div class="rrc-syms"></div>' +
          '<div class="rrc-row"><span>DANGER</span><button class="rrb-btn" ng-repeat="d in [0,1,2,3]" ng-class="{on: r.recce.pending.danger === d}" ng-click="pick({danger: d})">{{ d ? \'!!!\'.substr(0, d) : \'0\' }}</button></div>' +
          '<div class="rrc-row rrc-presets"><button class="rrb-btn" ng-repeat="p in r.recce.presets" ng-class="{on: hasNote(p)}" ng-click="pick({preset: p})">{{ p }}</button></div>' +
          '<div class="rrc-row"><input class="rrc-notes" ng-model="ui.notes" ng-blur="pick({notes: ui.notes})" placeholder="notes (optional)" maxlength="120">' +
          '<button class="rrb-btn on" ng-click="save()">SAVE</button><button class="rrb-btn" ng-click="cmd(\'recceCancel\')">CANCEL</button></div></div>' +
      '</div>' +
    '</div>',
    link: function (scope, element) {
      scope.r = {}
      scope.groups = ['quick']
      var R = null
      renderer(function (r) { R = r; scope.$evalAsync(function () { scope.groups = ['quick'].concat(R.GROUPS ? Object.keys(R.GROUPS) : []) }); setTimeout(drawPick, 0) })
      scope.cmd = function (name, arg) {
        lua('if rallyRaid_core then rallyRaid_core.cmd(' + q(name) + ', ' + (arg !== undefined ? luaVal(arg) : 'nil') + ', ' + q(APP) + ') else log(\'E\', \'rallyRaid\', ' +
          q('[rally.raid Earth] UI ' + APP + ': ' + name + ' pressed, but rallyRaid_core is NOT loaded') + ') end')
      }
      scope.keys = {}
      scope.kt = function (action, text) { var k = scope.keys[action]; return k ? text + ' (' + k + ')' : text }
      scope.$on('RallyRaidKeys', function (event, data) { scope.$evalAsync(function () { scope.keys = (data && data.keys) || {} }) })
      // recce: quick-pick and merge
      scope.ui = { rescale: false, notes: '', grp: 'quick', find: '' }
      scope.pick = function (p) { scope.cmd('reccePick', p) }
      scope.save = function () { if (scope.ui.notes) scope.pick({ notes: scope.ui.notes }); scope.cmd('recceSave'); scope.ui.notes = '' }
      // MERGE: first a preview (what would apply, conflicts), then CONFIRM MERGE writes the roadbook file
      scope.merge = function () { if (scope.r.recce && scope.r.recce.preview) scope.mergeConfirm(); else scope.cmd('reccePreview') }
      scope.mergeConfirm = function () { scope.cmd('recceMerge', scope.ui.rescale ? 'rescale' : '') }
      scope.hasNote = function (p) {
        var n = (scope.r.recce && scope.r.recce.pending && scope.r.recce.pending.notes) || ''
        return n.split(',').map(function (x) { return x.trim() }).indexOf(p) >= 0
      }
      // quick-pick tabs: QUICK (the recce's list) + the legend's groups; "find" searches the whole library by name
      scope.groups = ['quick'].concat(R && R.GROUPS ? Object.keys(R.GROUPS) : [])
      scope.setGrp = function (g) { scope.ui.grp = g; scope.ui.find = ''; drawPick() }
      scope.findSym = function () { drawPick() }
      function symList() {
        var f = (scope.ui.find || '').toLowerCase()
        if (f && R && R.GROUPS) {
          var all = []
          Object.keys(R.GROUPS).forEach(function (g) { R.GROUPS[g].forEach(function (c) { if (all.indexOf(c) < 0 && (c.indexOf(f) >= 0 || R.symbolName(c).toLowerCase().indexOf(f) >= 0)) all.push(c) }) })
          return all
        }
        if (scope.ui.grp && scope.ui.grp !== 'quick' && R && R.GROUPS && R.GROUPS[scope.ui.grp]) return R.GROUPS[scope.ui.grp]
        return arr(scope.r.recce.quick)
      }
      var symSig = ''
      function drawPick() {
        var host = element[0].querySelector('.rrc-syms')
        var P = scope.r.recce && scope.r.recce.pending
        if (!host || !P) { symSig = ''; return }
        var q = symList(), on = arr(P.symbols)
        var sig = JSON.stringify([q, on, !!R])
        if (sig === symSig && host.childNodes.length) return
        symSig = sig
        host.innerHTML = q.map(function (c) { return '<span class="rrc-sym' + (on.indexOf(c) >= 0 ? ' on' : '') + '" data-c="' + esc(c) + '" title="' + esc(R && R.symbolName ? R.symbolName(c) : c) + '">' + (R ? R.symbolSVG(c, 26) : esc(c)) + '</span>' }).join('')
      }
      element[0].addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('.rrc-sym'); if (t) scope.pick({ symbol: t.getAttribute('data-c') }) })
      var lastOn = null
      scope.$on('RallyRaidRoadbook', function (event, data) {
        scope.$evalAsync(function () {
          if (!data) return
          var wasPending = scope.r.recce && scope.r.recce.pending
          scope.r = { recce: data.recce, stageId: data.stageId, stageName: data.stage || data.stageName, boxCount: data.boxCount, roadbookFile: data.roadbookFile }
          var on = !!data.recce
          if (on !== lastOn) { lastOn = on; scope.$emit('rrRecceState', on) }
          var P = data.recce && data.recce.pending
          if (P && (!wasPending || (P.notes || '') !== (wasPending.notes || ''))) scope.ui.notes = P.notes || ''   // a preset changed the notes
          setTimeout(drawPick, 0)
        })
      })
    }
  }
})()
angular.module('beamng.apps')
.directive('rallyRaidPlanner', ['$compile', function ($compile) {
  var W = 440, H = 640
  var BASE = '/ui/modules/apps/RallyRaidPlanner/', RBASE = '/ui/modules/apps/RallyRaidRoadbook/'
  var STAGE_DIR = '/rallyraid/stages/', RB_DIR = '/rallyraid/roadbooks/', DRAFT_DIR = '/rallyraid/planner/drafts/', DRIVE_DIR = '/rallyraid/planner/drive/'
  var CHUNK = 30000
  var APP = 'planner'
  function lua(code) { if (window.bngApi) bngApi.engineLua(code) }
  // a Lua string literal (quotes, backslashes and line breaks escaped)
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'" }
  // a line in the game's console (~), "[rally.raid Earth] UI <app>: ..." (says so when rallyRaid_core is not loaded)
  function rlog(msg) {
    try { console.log('[rally.raid Earth] ' + APP + ': ' + msg) } catch (e) {}
    lua('if rallyRaid_core and rallyRaid_core.uiLog then rallyRaid_core.uiLog(' + q(APP) + ', ' + q(msg) + ') else log(\'E\', \'rallyRaid\', ' +
      q('[rally.raid Earth] UI ' + APP + ': ' + msg + ' -- rallyRaid_core is NOT loaded (mod off, or a Lua error when it loaded: see above)') + ') end')
  }
  // a command for rallyRaid_core.cmd (logged in Lua with this app's name)
  function cmdCode(name, arg) {
    return 'if rallyRaid_core then rallyRaid_core.cmd(' + q(name) + ', ' + (arg !== undefined ? q(arg) : 'nil') + ', ' + q(APP) + ') else log(\'E\', \'rallyRaid\', ' +
      q('[rally.raid Earth] UI ' + APP + ': ' + name + ' pressed, but rallyRaid_core is NOT loaded') + ') end'
  }
  // hello: the app is on screen (again every 3 s: Lua may have been reloaded, or loaded after this app)
  function hello(on) { lua('if rallyRaid_core and rallyRaid_core.appHello then rallyRaid_core.appHello(' + q(APP) + ', ' + (on ? 'true' : 'false') + ') end') }
  // the recce quick-pick (rallyRaid/recce.lua M.QUICK)
  var QUICK = ['jump', 'crest', 'bump', 'compression', 'dip', 'ditch', 'step_down', 'hole', 'ruts', 'undulations', 'twisty',
    'soft_sand', 'dunes', 'rocks', 'danger', 'keep_left', 'keep_right', 'narrow', 'water', 'climb', 'descent', 'sideslope_l',
    'sideslope_r', 'junction', 'trees', 'vegetation', 'fence', 'gate', 'cliff', 'over_crest']
  var MODE_SHORT = { road: 'ROAD', track: 'DRIVEN', direct: 'STRAIGHT' }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function arr(x) { return Array.isArray(x) ? x : (x && typeof x === 'object') ? Object.keys(x).sort(function (a, b) { return a - b }).map(function (k) { return x[k] }) : [] }
  function pad3(c) { if (c == null || !isFinite(c)) return '---'; var s = String(Math.round(c) % 360); while (s.length < 3) s = '0' + s; return s }
  // the shared libraries, loaded once for every instance
  function libs(cb) {
    if (window.PlannerCore && window.RoadbookGen && window.RoadbookRender) return cb()
    var w = window.__rplWait = window.__rplWait || []
    w.push(cb)
    if (w.length > 1) return
    var list = []
    if (!window.RoadbookRender) list.push(RBASE + 'roadbook-render.js')
    if (!window.RoadbookGen) list.push(BASE + 'roadbook-gen.js')
    if (!window.PlannerCore) list.push(BASE + 'planner-core.js')
    ;(function next () {
      if (!list.length) { var l = window.__rplWait; window.__rplWait = null; l.forEach(function (f) { f() }); return }
      var s = document.createElement('script'); s.src = list.shift(); s.onload = next
      s.onerror = function () { console.error('rally.raid Earth Planner: could not load ' + s.src); next() }
      document.head.appendChild(s)
    })()
  }
  // a Lua long string that holds `s` unchanged (the leading newline is the one Lua drops)
  function longStr(s) { var eq = ''; while (s.indexOf(']' + eq) >= 0 && eq.length < 12) eq += '='; if (s.indexOf(']' + eq) >= 0) eq += '='; return '[' + eq + '[\n' + s + ']' + eq + ']' }
  function asciiOnly(s) { return s.replace(/[\u007f-\uffff]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4) }) }
  function callLua(name, args, text) {
    return new Promise(function (resolve, reject) {
      if (!window.bngApi) return reject(new Error('not in the game'))
      var code = 'rallyRaid_core and rallyRaid_core.plannerCall(\'' + name + '\', ' + longStr(asciiOnly(JSON.stringify(args || {}))) + (text != null ? ', ' + longStr(text) : '') + ')'
      var done = false
      var t = setTimeout(function () { if (!done) { done = true; reject(new Error('the game did not answer (' + name + ')')) } }, 15000)
      bngApi.engineLua(code, function (r) { if (done) return; done = true; clearTimeout(t); resolve(r) })
    })
  }
  function cmd(name, arg) { lua(cmdCode(name, arg)) }
  async function readText(path) {
    var o = await callLua('readOpen', { path: path })
    if (!o || !o.ok) return null
    var parts = []
    for (var i = 1; i <= o.chunks; i++) parts.push(await callLua('readChunk', { token: o.token, i: i }))
    return parts.join('')
  }
  async function writeText(path, text) {
    var b = await callLua('writeBegin', { path: path })
    if (!b || !b.ok) throw new Error((b && b.why) || 'cannot write ' + path)
    for (var i = 0; i < text.length; i += CHUNK) await callLua('writeChunk', { token: b.token }, text.slice(i, i + CHUNK))
    var c = await callLua('writeCommit', { token: b.token })
    if (!c || !c.ok) throw new Error((c && c.why) || 'cannot write ' + path)
    return c
  }

  var T = [
    '<div class="bngApp rpl-host">',
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidPlanner/app.css">',
    '<div class="rpl" ng-style="{transform: \'scale(\' + k + \')\'}">',
    // the bar (always there): click (or PLANNER in the GPS app) opens / closes
    '<div class="rpl-bar" ng-click="toggle()" title="{{ kt(\'rallyRaid_plannerMenu\', \'Open / close the planner\') }}">',
      '<button class="rpl-btn rpl-open" ng-click="toggle(); $event.stopPropagation()">{{ g.open ? \'CLOSE\' : \'PLANNER\' }}</button><span class="nm">{{ barName() }}{{ v.dirty ? \' *\' : \'\' }}</span>',
      '<span title="Recording the driven line"><span class="rpl-dot" ng-class="{on: g.rec.on}"></span> {{ g.rec.on ? (g.rec.km.toFixed(2) + \' km\') : \'\' }}</span>',
      '<span class="k" ng-show="keys.rallyRaid_plannerMenu">{{ keys.rallyRaid_plannerMenu }}</span>',
      '<button class="rpl-btn rpl-rbtn" ng-class="{on: rc.on}" ng-click="toggleRecce(); $event.stopPropagation()" title="the recce controls: fix the loaded roadbook while you drive it">{{ rc.on ? \'&#9679; RECCE\' : \'RECCE\' }}</button></div>',
    // RECCE (moved here from the Roadbook app): mounted in link()
    '<div class="rpl-recce-host" ng-show="rc.show"></div>',
    // closed: what OPEN gives (never just an empty bar)
    '<div class="rpl-hint" ng-show="!g.open">{{ g.game && g.game.stageName ? (\'The game has \' + g.game.stageName + \' loaded: PLANNER, then EDIT LOADED STAGE to change it.\') : \'PLANNER opens the planner: start a NEW STAGE HERE at the car, or open a stage file.\' }}</div>',
    '<div class="rpl-panel" ng-show="g.open">',
    // no planner stage yet: the ways in (the game's loaded stage, a new one at the car, a file)
    '<div class="rpl-start" ng-show="!v.hasStage">',
      '<div class="rpl-dim">No stage open in the planner.</div>',
      '<div class="rpl-row"><button class="rpl-btn go" ng-show="g.game && g.game.path" ng-click="openLoaded()" ng-disabled="busy">EDIT LOADED STAGE: {{ g.game.stageName }}</button>',
        '<button class="rpl-btn go" ng-click="newHere()" ng-disabled="busy" title="a new stage, its start (DSS) at the car">NEW STAGE HERE</button>',
        '<button class="rpl-btn" ng-click="tab(\'files\')">OPEN A FILE</button></div></div>',
      '<div class="rpl-row sp"><span class="rpl-gps" ng-class="{bad: !g.pose.ok}">{{ gpsText() }}</span>',
        '<button class="rpl-btn rec" ng-class="{on: g.rec.on}" ng-click="rec()" title="Record the driven line: the leg to the next point you add follows where you drove{{ keyText(\'rallyRaid_plannerRec\') }}">&#9679; REC</button></div>',
      '<div class="rpl-tabs"><button class="rpl-btn" ng-class="{on: ui.tab === \'route\'}" ng-click="tab(\'route\')">ROUTE</button>',
        '<button class="rpl-btn" ng-class="{on: ui.tab === \'roadbook\'}" ng-click="tab(\'roadbook\')">ROADBOOK</button>',
        '<button class="rpl-btn" ng-class="{on: ui.tab === \'files\'}" ng-click="tab(\'files\')">FILES</button>',
        '<button class="rpl-btn" ng-click="undo()" ng-disabled="!v.canUndo" title="Undo the last change">UNDO</button></div>',
      '<div class="rpl-map" ng-show="ui.tab !== \'files\'"><div class="rpl-svg"></div><div class="rpl-mapbtns">',
        '<button class="rpl-btn" ng-class="{on: ui.follow}" ng-click="follow()" title="Follow the car">CAR</button>',
        '<button class="rpl-btn" ng-click="zoom(1)">+</button><button class="rpl-btn" ng-click="zoom(-1)">&minus;</button>',
        '<button class="rpl-btn" ng-click="fit()" title="The whole stage">FIT</button></div></div>',
      '<div class="rpl-ask" ng-if="ui.ask"><span>{{ ui.ask.text }}</span><button class="rpl-btn go" ng-click="answer(true)">{{ ui.ask.yes || \'YES\' }}</button><button class="rpl-btn" ng-click="answer(false)">NO</button></div>',
      // ---------------------------------------------------------------- ROUTE
      '<div class="rpl-row" ng-show="ui.tab === \'route\'">',
        '<select ng-model="ui.addType" ng-options="t for t in types" title="Type of the next point"></select>',
        '<button class="rpl-btn go" ng-click="addHere()" ng-disabled="busy" title="A new point at the car, at the end of the stage{{ keyText(\'rallyRaid_plannerWaypoint\') }}">ADD HERE</button>',
        '<button class="rpl-btn" ng-click="insertHere()" ng-disabled="busy || !v.pts.length" title="A new point on the route where the car is (splits that leg)">INSERT HERE</button>',
        '<button class="rpl-btn" ng-click="startHere()" ng-disabled="!v.hasStage" title="Where TP TO DSS puts the car">START HERE</button></div>',
      '<div class="rpl-list" ng-show="ui.tab === \'route\'">',
        '<div class="rpl-item" ng-repeat="p in v.pts track by p.i" ng-class="{sel: ui.sel === p.i}" ng-click="selPt(p.i)">',
          '<span class="l">{{ p.label }}</span><span class="km">{{ p.km }}</span><span class="md">{{ p.mode }}</span><span class="nm">{{ p.name }}</span><span class="fl" ng-if="p.flag">{{ p.flag }}</span></div>',
        '<div class="rpl-dim" ng-hide="v.pts.length" style="padding:6px">No points yet. Drive to the start, press <b>REC</b> if you want the route to follow your line, then <b>ADD HERE</b> (a DSS). Drive on and add waypoints; finish with an ASS. Or open a stage on the FILES tab.</div></div>',
      '<div class="rpl-edit" ng-if="ui.tab === \'route\' && ui.sel !== null && v.pt">',
        '<div class="rpl-row"><b>{{ v.pt.label }}</b><select ng-model="ui.pt.type" ng-change="setType()" ng-options="t for t in types"></select>',
          '<input class="w" ng-model="ui.pt.name" ng-blur="setName()" placeholder="name (optional)" maxlength="60">',
          '<input ng-if="ui.pt.type === \'DZ\'" ng-model="ui.pt.limit" ng-blur="setLimit()" style="width:48px" title="speed limit km/h"><span ng-if="ui.pt.type === \'DZ\'">km/h</span></div>',
        '<div class="rpl-row"><span class="rpl-dim">leg here:</span><select ng-model="ui.pt.mode" ng-change="setMode()" ng-disabled="ui.sel === 0" ng-options="m.k as m.t for m in modes"></select>',
          '<button class="rpl-btn" ng-click="moveHere()" title="Move this point to the car">MOVE HERE</button>',
          '<button class="rpl-btn" ng-click="shift(-1)" title="Earlier">&#9650;</button><button class="rpl-btn" ng-click="shift(1)" title="Later">&#9660;</button>',
          '<button class="rpl-btn warn" ng-click="delPt()">DELETE</button></div></div>',
      '<div class="rpl-probs" ng-show="ui.tab === \'route\' && v.probs.length"><div ng-repeat="x in v.probs" class="{{ x[0] }}">{{ x[0] === \'err\' ? \'\u2717\' : \'!\' }} {{ x[1] }}</div></div>',
      // ---------------------------------------------------------------- ROADBOOK
      '<div class="rpl-row" ng-show="ui.tab === \'roadbook\'">',
        '<button class="rpl-btn go" ng-click="generate(false)" ng-disabled="busy || !v.hasStage" title="Make a new roadbook for this stage">{{ v.hasRb ? \'NEW\' : \'GENERATE\' }}</button>',
        '<button class="rpl-btn" ng-click="generate(true)" ng-disabled="busy || !v.hasRb" title="Regenerate: your edited boxes are kept">REGEN, KEEP EDITS</button>',
        '<span class="rpl-dim">density</span><select ng-model="ui.density" ng-options="d for d in [2,3,4,6,8,10]"></select>',
        '<span class="rpl-dim">{{ netText() }}</span></div>',
      '<div class="rpl-prog" ng-show="ui.tab === \'roadbook\' && ui.prog !== null"><i ng-style="{width: (ui.prog * 100) + \'%\'}"></i></div>',
      '<div class="rpl-dim" ng-show="ui.tab === \'roadbook\' && v.rbInfo">{{ v.rbInfo }}</div>',
      '<div class="rpl-row" ng-show="ui.tab === \'roadbook\' && v.hasRb">',
        '<button class="rpl-btn" ng-click="boxStep(-1)">&#9650;</button><button class="rpl-btn" ng-click="boxStep(1)">&#9660;</button>',
        '<button class="rpl-btn" ng-click="nearestBox()" title="The box nearest the car">NEAREST</button>',
        '<button class="rpl-btn go" ng-click="boxHere()" ng-disabled="busy" title="A new box at the car{{ keyText(\'rallyRaid_plannerBox\') }}">+ BOX HERE</button>',
        '<button class="rpl-btn" ng-click="boxMove()" ng-disabled="!v.box" title="Move the box to the car">MOVE HERE</button>',
        '<button class="rpl-btn warn" ng-click="boxDel()" ng-disabled="!v.box || v.box.waypoint">DELETE</button></div>',
      '<div class="rpl-boxview" ng-show="ui.tab === \'roadbook\' && v.box"></div>',
      '<div class="rpl-edit" ng-if="ui.tab === \'roadbook\' && v.box">',
        '<div class="rpl-row"><input class="w" ng-model="ui.box.notes" ng-keyup="$event.keyCode === 13 && setNotes()" ng-blur="setNotes()" placeholder="notes, e.g. KEEP LEFT, CROSS WADI" maxlength="140">',
          '<button class="rpl-btn" ng-repeat="d in [0,1,2,3]" ng-class="{on: v.box.danger === d}" ng-click="setDanger(d)">{{ d ? \'!!!\'.substr(0, d) : \'0\' }}</button></div>',
        '<div class="rpl-row"><span class="rpl-dim">tulip exit {{ v.box.angle }}&deg;</span><button class="rpl-btn" ng-click="turn(-45)">&#8630;45</button><button class="rpl-btn" ng-click="turn(-15)">&#8630;15</button>',
          '<button class="rpl-btn" ng-click="turn(15)">15&#8631;</button><button class="rpl-btn" ng-click="turn(45)">45&#8631;</button><button class="rpl-btn" ng-click="turnStraight()">STRAIGHT</button></div>',
        '<div class="rpl-grps"><button class="rpl-btn" ng-repeat="gr in groups" ng-class="{on: ui.grp === gr}" ng-click="setGrp(gr)">{{ gr === \'quick\' ? \'QUICK\' : gr.toUpperCase() }}</button>',
          '<input ng-model="ui.find" ng-change="drawSyms()" placeholder="find symbol" style="width:90px"></div>',
        '<div class="rpl-syms"></div></div>',
      '<div class="rpl-dim" ng-show="ui.tab === \'roadbook\' && v.hasStage && !v.hasRb" style="padding:4px">No roadbook yet: press <b>GENERATE</b>. With internet the website\'s full generator runs (terrain, OpenStreetMap junctions, landmarks); without it the roadbook is made from the route (waypoints, bends) and the heights you recorded driving it.</div>',
      // ---------------------------------------------------------------- FILES
      '<div class="rpl-row" ng-show="ui.tab === \'files\'"><input class="w" ng-model="ui.newName" placeholder="new stage name"><button class="rpl-btn go" ng-click="newStage()" ng-disabled="!ui.newName">NEW STAGE</button>',
        '<button class="rpl-btn" ng-click="listFiles()" title="refresh">&#8635;</button></div>',
      '<div class="rpl-row" ng-show="ui.tab === \'files\'"><button class="rpl-btn go" ng-click="save()" ng-disabled="busy || !v.hasStage">SAVE</button>',
        '<button class="rpl-btn go" ng-click="saveLoad()" ng-disabled="busy || !v.hasStage" title="Save, then load it into the rally computer">SAVE + LOAD IN GAME</button>',
        '<label><input type="checkbox" ng-model="ui.teleport"> TP to start</label></div>',
      '<div class="rpl-dim" ng-show="ui.tab === \'files\'">Files go to <b>{{ files.userPath || \'<BeamNG user folder>/\' }}rallyraid/</b> (stages/, roadbooks/). Open them on stagebuilder.wyans.net (Import / Open roadbook); files saved from the website go in the same folders.</div>',
      '<div class="rpl-list" ng-show="ui.tab === \'files\'">',
        '<div class="rpl-item rpl-file" ng-repeat="f in files.stages track by f.path" ng-class="{sel: ui.file === f.path}" ng-click="ui.file = f.path" ng-dblclick="open(f)">',
          '<span class="nm">{{ f.name }}<br><small>{{ f.ok ? (f.km.toFixed(1) + \' km \u00b7 \' + (f.roadbook ? \'roadbook\' : \'no roadbook\')) : f.error }}</small></span>',
          '<button class="rpl-btn" ng-click="open(f); $event.stopPropagation()" ng-disabled="!f.ok || busy">OPEN</button></div>',
        '<div class="rpl-item rpl-file" ng-repeat="f in files.drafts track by f.path"><span class="nm">DRAFT {{ f.file }}<br><small>unsaved work kept by the planner</small></span>',
          '<button class="rpl-btn" ng-click="openDraft(f)" ng-disabled="busy">RESTORE</button></div></div>',
      '<div class="rpl-msg" ng-class="ui.kind">{{ ui.msg }}</div>',
      '<details class="rr-credits"><summary>Credits</summary><p>Map data © OpenStreetMap contributors (ODbL). Land cover: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). Elevation: Mapterhorn (open DEMs, including Copernicus GLO-30) and Mapzen/Tilezen Terrarium tiles. Routing: OSRM. Map queries: public Overpass mirrors including NextGIS. Place names: Nominatim. Built for BeamNG.Earth. Not an official BeamNG or FIM/FIA product. Full credits: https://stagebuilder.wyans.net and the project README.</p></details>',
    '</div></div></div>'
  ].join('')

  return {
    template: T,
    replace: true,
    scope: {},
    link: function (scope, element) {
      'use strict'
      var PC = null, RB = null, R = null
      var D = { stage: null, rb: null, drive: [], dirty: false, undo: [], fits: 'none', net: null }
      scope.k = 1
      scope.busy = false
      scope.g = { open: false, pose: { ok: false, why: 'starting' }, rec: { on: false, km: 0 }, game: {} }
      scope.ui = { tab: 'route', sel: null, box: { notes: '' }, pt: {}, addType: 'DSS', msg: 'ADD HERE puts a waypoint at the car, + BOX HERE a roadbook box.', kind: '',
        ask: null, grp: 'quick', find: '', newName: '', teleport: true, density: 4, follow: true, zoom: 0, prog: null, file: null, boxId: null }
      scope.v = { pts: [], probs: [], hasStage: false, hasRb: false, name: '', dirty: false, canUndo: false, box: null, pt: null, rbInfo: '' }
      scope.files = { stages: [], drafts: [], userPath: '' }
      scope.types = ['DSS', 'WPV', 'WPE', 'WPM', 'WPN', 'WPS', 'WPC', 'WPP', 'DZ', 'FZ', 'ASS', 'NOTE']
      scope.modes = [{ k: 'track', t: 'driven line' }, { k: 'road', t: 'on roads (internet)' }, { k: 'direct', t: 'straight (off-piste)' }]
      scope.groups = ['quick']
      function apply(fn) { scope.$evalAsync(fn || function () {}) }
      function say(text, kind) { apply(function () { scope.ui.msg = text; scope.ui.kind = kind || '' }) }
      function ask(text, yes) { return new Promise(function (res) { apply(function () { scope.ui.ask = { text: text, yes: yes, res: res } }) }) }
      scope.answer = function (y) { var a = scope.ui.ask; scope.ui.ask = null; if (a) a.res(!!y) }
      async function job(fn) {
        if (scope.busy) return
        apply(function () { scope.busy = true })
        try { await fn() } catch (e) { console.error(e); say('Failed: ' + (e && e.message || e), 'err') }
        apply(function () { scope.busy = false; scope.ui.prog = null })
      }

      // ---------------------------------------------------------------- document state -> view
      function snapshot() { D.undo.push(JSON.stringify({ stage: D.stage, rb: D.rb, drive: D.drive.length })); if (D.undo.length > 40) D.undo.shift() }
      scope.undo = function () {
        if (!D.undo.length) return
        var u = JSON.parse(D.undo.pop()); D.stage = u.stage; D.rb = u.rb; D.drive.length = Math.min(D.drive.length, u.drive)
        if (scope.ui.sel !== null && (!D.stage || scope.ui.sel >= D.stage.points.length)) scope.ui.sel = null
        changed(); say('Undone.')
      }
      function changed(noDirty) { if (!noDirty) D.dirty = true; refresh(); if (!noDirty) autosave() }
      function boxById(id) { return D.rb && id ? D.rb.boxes.find(function (b) { return b.id === id && !b.deleted }) : null }
      function refresh() {
        var v = scope.v
        v.hasStage = !!D.stage; v.hasRb = !!D.rb; v.dirty = D.dirty; v.canUndo = D.undo.length > 0
        v.name = D.stage ? (D.stage.meta.name || D.stage.meta.id) : ''
        if (D.stage && PC) {
          v.probs = PC.problems(D.stage)
          v.pts = D.stage.points.map(function (p, i) {
            var l = p.leg || {}
            return { i: i, label: PC.labelOf(p), km: (p._km || 0).toFixed(2), mode: i ? (MODE_SHORT[l.mode] || 'STRAIGHT') : '', name: p.name || '', flag: l.straightened ? 'MOVED' : l.failed ? 'NO ROUTE' : '' }
          })
          var s = scope.ui.sel !== null ? D.stage.points[scope.ui.sel] : null
          v.pt = s ? { label: PC.labelOf(s) } : null
          if (s) scope.ui.pt = { type: s.type, name: s.name || '', limit: s.speedLimit || '', mode: s.leg ? s.leg.mode : 'direct' }
        } else { v.pts = []; v.probs = []; v.pt = null }
        if (D.rb) {
          var live = PC.liveBoxes(D.rb)
          var b = boxById(scope.ui.boxId) || null
          if (!b && live.length) { b = live[0]; scope.ui.boxId = b.id }
          v.box = b ? { id: b.id, n: b.n, km: b.km, danger: b.danger || 0, waypoint: b.waypoint, angle: b.tulip && b.tulip.exit ? b.tulip.exit.angle : 0 } : null
          if (b) scope.ui.box.notes = b.notes || ''
          v.rbInfo = live.length + ' boxes' + (D.rb.partial ? ' \u00b7 ' + ({ 'terrain-only': 'terrain only (no OpenStreetMap)', 'driven-heights': 'made offline: route + driven heights', 'route-only': 'made offline: route only' }[D.rb.partial] || D.rb.partial) : '') +
            (D.fits === 'stale' ? ' \u00b7 THE ROUTE CHANGED: press REGEN, KEEP EDITS' : D.fits === 'other' ? ' \u00b7 belongs to another stage' : '')
        } else { v.box = null; v.rbInfo = '' }
        drawMap(); drawBox(); scope.drawSyms(); setTimeout(function () { drawBox(); scope.drawSyms() }, 0)
        checkFit()
      }
      var fitTok = 0
      function checkFit() {
        if (!D.rb || !D.stage || !PC) { D.fits = 'none'; return }
        var tok = ++fitTok
        PC.roadbookFits(RB, D.rb, PC.exportStage(D.stage)).then(function (f) { if (tok !== fitTok || f === D.fits) return; D.fits = f; apply(refresh) }).catch(function () {})
      }
      var draftT = null
      function autosave() {
        clearTimeout(draftT)
        draftT = setTimeout(function () {
          if (!D.stage || !D.dirty || scope.busy) return
          var id = D.stage.meta.id || 'stage'
          writeText(DRAFT_DIR + id + '.draft.json', PC.asciiJSON(PC.draft(D.stage, D.rb, D.drive), 0)).catch(function (e) { console.warn('draft not saved', e) })
        }, 4000)
      }

      // ---------------------------------------------------------------- the map (no tiles: works offline)
      var mapEl = element[0].querySelector('.rpl-svg'), MW = 426, MH = 166, view = null
      function project(lat0) { var kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540; return function (lat, lon) { return [lon * kx, -lat * ky] } }
      function drawMap() {
        if (!mapEl || !PC) return
        var pose = scope.g.pose && scope.g.pose.ok ? scope.g.pose : null
        var pts = D.stage ? D.stage.points : []
        var lat0 = pts.length ? pts[0].lat : pose ? pose.lat : 0
        var P = project(lat0), xs = [], ys = []
        var add = function (lat, lon) { var q = P(lat, lon); xs.push(q[0]); ys.push(q[1]) }
        pts.forEach(function (p) { add(p.lat, p.lon) })
        var legs = D.stage ? D.stage.points.slice(1).map(function (p, i) { return { pts: PC.legPts(D.stage, i + 1), mode: p.leg ? p.leg.mode : 'direct' } }) : []
        legs.forEach(function (l) { l.pts.forEach(function (q, j) { if (j % 4 === 0) add(q[0], q[1]) }) })
        var cx, cy, scale
        if (scope.ui.follow && pose) { var c = P(pose.lat, pose.lon); cx = c[0]; cy = c[1]; scale = MW / (2000 * Math.pow(2, -scope.ui.zoom)) }
        else if (xs.length) {
          var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys)
          cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; scale = Math.min((MW - 30) / Math.max(200, x1 - x0), (MH - 30) / Math.max(200, y1 - y0)) * Math.pow(2, scope.ui.zoom)
        } else { mapEl.innerHTML = '<svg width="' + MW + '" height="' + MH + '"><text x="10" y="20" fill="#8a8f8a" font-size="11">' + (pose ? 'The car is here; add a point to start.' : esc(scope.g.pose.why || 'no position')) + '</text></svg>'; view = null; return }
        var S = function (lat, lon) { var q = P(lat, lon); return [(q[0] - cx) * scale + MW / 2, (q[1] - cy) * scale + MH / 2] }
        view = { S: S }
        var h = '<svg width="' + MW + '" height="' + MH + '" xmlns="http://www.w3.org/2000/svg">'
        var COL = { road: '#1e88e5', track: '#c792ea', direct: '#ff9f43' }
        legs.forEach(function (l) {
          h += '<polyline fill="none" stroke="' + (COL[l.mode] || '#ff9f43') + '" stroke-width="3" stroke-opacity="0.9"' + (l.mode === 'direct' ? ' stroke-dasharray="6 4"' : '') + ' points="' +
            l.pts.map(function (q) { var s = S(q[0], q[1]); return s[0].toFixed(1) + ',' + s[1].toFixed(1) }).join(' ') + '"/>'
        })
        if (scope.ui.tab === 'roadbook' && D.rb) PC.liveBoxes(D.rb).forEach(function (b) {
          if (b.lat == null) return
          var s = S(b.lat, b.lon), on = b.id === scope.ui.boxId
          h += '<rect x="' + (s[0] - (on ? 5 : 3)).toFixed(1) + '" y="' + (s[1] - (on ? 5 : 3)).toFixed(1) + '" width="' + (on ? 10 : 6) + '" height="' + (on ? 10 : 6) + '" fill="' + (on ? '#ffd400' : b.danger >= 2 ? '#ff5c5c' : '#fff') + '" stroke="#111"/>'
        })
        pts.forEach(function (p, i) {
          var s = S(p.lat, p.lon), on = scope.ui.tab === 'route' && scope.ui.sel === i
          var col = p.type === 'DSS' || p.type === 'ASS' ? '#2ecc71' : p.type === 'DZ' ? '#ff3b3b' : p.type === 'FZ' ? '#ff9a9a' : p.type === 'NOTE' ? '#8a9096' : '#ffd400'
          h += '<circle cx="' + s[0].toFixed(1) + '" cy="' + s[1].toFixed(1) + '" r="' + (on ? 7 : 5) + '" fill="' + col + '" stroke="' + (on ? '#fff' : '#111') + '" stroke-width="2"/>'
          if (scope.ui.tab === 'route') h += '<text x="' + (s[0] + 8).toFixed(1) + '" y="' + (s[1] - 6).toFixed(1) + '" fill="#fff" font-size="10" stroke="#000" stroke-width="0.4">' + esc(PC.labelOf(p)) + '</text>'
        })
        if (pose) {
          var c2 = S(pose.lat, pose.lon), hd = (pose.heading || 0)
          h += '<g transform="translate(' + c2[0].toFixed(1) + ',' + c2[1].toFixed(1) + ') rotate(' + hd + ')"><path d="M0 -10 L6 7 L0 3 L-6 7 Z" fill="' + (pose.camera ? '#9ad0ff' : '#fff') + '" stroke="#e03a2f" stroke-width="2"/></g>'
        }
        h += '<text x="5" y="' + (MH - 5) + '" fill="#8a8f8a" font-size="10">' + (scope.ui.follow && pose ? (2 * Math.pow(2, -scope.ui.zoom)).toFixed(1) + ' km across' : '') + '</text></svg>'
        mapEl.innerHTML = h
      }
      mapEl.addEventListener('click', function (e) {
        if (!view || !D.stage) return
        var r = mapEl.getBoundingClientRect(), k = scope.k || 1
        var x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k, best = null, bd = 14
        var cands = scope.ui.tab === 'roadbook' && D.rb ? PC.liveBoxes(D.rb).filter(function (b) { return b.lat != null }).map(function (b) { return { id: b.id, lat: b.lat, lon: b.lon } }) : D.stage.points.map(function (p, i) { return { i: i, lat: p.lat, lon: p.lon } })
        cands.forEach(function (c) { var s = view.S(c.lat, c.lon), d = Math.hypot(s[0] - x, s[1] - y); if (d < bd) { bd = d; best = c } })
        if (!best) return
        apply(function () { if (best.id) scope.ui.boxId = best.id; else scope.ui.sel = best.i; refresh() })
      })
      scope.follow = function () { scope.ui.follow = !scope.ui.follow; scope.ui.zoom = 0; drawMap() }
      scope.zoom = function (d) { scope.ui.zoom = Math.max(-4, Math.min(6, scope.ui.zoom + d)); drawMap() }
      scope.fit = function () { scope.ui.follow = false; scope.ui.zoom = 0; drawMap() }

      // ---------------------------------------------------------------- the roadbook box on screen and the symbol picker
      function drawBox() {
        var host = element[0].querySelector('.rpl-boxview'); if (!host) return
        var b = boxById(scope.ui.boxId)
        if (!b || !R) { host.innerHTML = ''; return }
        host.className = 'rpl-boxview' + (b.danger >= 2 ? ' d' + b.danger : '')
        host.innerHTML = '<div class="c1"><span class="no">' + esc(b.n) + '</span><div class="km">' + (+b.km).toFixed(2) + '</div><div class="pt">' + (b.partial != null ? (+b.partial).toFixed(2) : '') + '</div></div>' +
          '<div class="c2">' + R.tulipSVG(b.tulip && typeof b.tulip === 'object' ? b.tulip : null, 78) + '</div>' +
          '<div class="c3"><div>' + (b.symbols || []).slice(0, 6).map(function (c) { return R.symbolSVG(c, 20) }).join('') + '</div><div class="n">' + esc(R.noteCase ? R.noteCase(b.notes) : String(b.notes || '').toUpperCase()) +
          (b.danger ? ' <span style="color:#d00">' + '!!!'.substr(0, b.danger) + '</span>' : '') + '</div><div class="pt" style="font-size:11px;color:#555">CAP ' + pad3(b.capOut != null ? b.capOut : b.cap) + (b.label && b.label !== 'NOTE' ? ' \u00b7 ' + esc(b.label) : '') + '</div></div>'
      }
      scope.setGrp = function (gr) { scope.ui.grp = gr; scope.ui.find = ''; scope.drawSyms() }
      scope.drawSyms = function () {
        var host = element[0].querySelector('.rpl-syms'); if (!host || !R) return
        var b = boxById(scope.ui.boxId); if (!b) { host.innerHTML = ''; return }
        var f = (scope.ui.find || '').toLowerCase(), list
        if (f) { list = []; Object.keys(R.GROUPS).forEach(function (g) { R.GROUPS[g].forEach(function (c) { if (list.indexOf(c) < 0 && (c.indexOf(f) >= 0 || R.symbolName(c).toLowerCase().indexOf(f) >= 0)) list.push(c) }) }) }
        else list = scope.ui.grp !== 'quick' && R.GROUPS[scope.ui.grp] ? R.GROUPS[scope.ui.grp] : QUICK
        var on = b.symbols || []
        host.innerHTML = list.map(function (c) { return '<span class="rpl-sym' + (on.indexOf(c) >= 0 ? ' on' : '') + '" data-c="' + esc(c) + '" title="' + esc(R.symbolName(c)) + '">' + R.symbolSVG(c, 24) + '</span>' }).join('')
      }
      element[0].addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('.rpl-sym'); if (!t) return
        var b = boxById(scope.ui.boxId); if (!b) return
        snapshot(); PC.updateBox(RB, D.rb, b.id, { symbols: PC.toggleSymbol(b, t.getAttribute('data-c')) }); apply(function () { changed() })
      })

      // ---------------------------------------------------------------- position / recording
      scope.gpsText = function () {
        var p = scope.g.pose
        if (!p || !p.ok) return 'NO POSITION: ' + ((p && p.why) || '...')
        return (p.camera ? 'CAMERA ' : 'CAR ') + p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) + (p.alt != null ? ' \u00b7 ' + Math.round(p.alt) + ' m' : '') + (p.heading != null ? ' \u00b7 CAP ' + pad3(p.heading) : '')
      }
      scope.netText = function () { return D.net === null ? '' : D.net ? 'internet: yes' : 'internet: no (offline roadbook)' }
      scope.rec = function () { callLua('rec', { on: !scope.g.rec.on }).then(function (r) { apply(function () { scope.g.rec.on = r && r.on }) }).catch(function (e) { say(e.message, 'err') }) }
      // the bar / its button: opens or closes at once here, and tells Lua (which keeps it across the UI being reloaded)
      scope.toggle = function () {
        var open = !scope.g.open
        scope.g.open = open
        rlog('bar ' + (open ? 'OPEN' : 'CLOSE') + ' pressed' + (scope.g.game && scope.g.game.stageName ? ' (game stage: ' + scope.g.game.stageName + ')' : ''))
        cmd(open ? 'plannerOpen' : 'plannerClose')
        if (open) refresh()
      }
      scope.barName = function () {
        if (scope.v.name) return scope.v.name
        var gm = scope.g.game || {}
        return gm.stageName ? 'game: ' + gm.stageName + ' (not open here)' : 'no stage open'
      }
      // the stage the GPS loaded, opened here (the same file list the GPS uses: rallyraid/stages)
      scope.openLoaded = function () {
        var gm = scope.g.game || {}
        if (!gm.path) return say('No stage is loaded in the game.', 'err')
        rlog('EDIT LOADED STAGE ' + gm.path)
        callLua('list').then(function (r) {
          var f = arr(r && r.stages).find(function (x) { return x.path === gm.path || String(x.path).replace(/\\/g, '/').toLowerCase() === String(gm.path).replace(/\\/g, '/').toLowerCase() })
          return scope.open(f || { ok: true, path: gm.path, roadbook: null })
        }).catch(function (e) { say('Could not open the loaded stage: ' + (e && e.message || e), 'err') })
      }
      scope.newHere = function () { rlog('NEW STAGE HERE'); scope.ui.addType = 'DSS'; scope.ui.tab = 'route'; scope.addHere() }
      scope.tab = function (t) { scope.ui.tab = t; if (t === 'files') scope.listFiles(); if (t === 'roadbook' && D.net === null) checkNet(); refresh() }
      function checkNet() { return PC.probeOnline(window.fetch && window.fetch.bind(window)).then(function (on) { D.net = on; apply(); return on }) }
      function ensureStage() {
        if (D.stage) return
        var d = new Date(), nm = 'In-game stage ' + d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2)
        D.stage = PC.newStage(nm); D.rb = null; D.drive = []; D.undo = []
      }
      function keepDrive(piece) { arr(piece).forEach(function (q) { q = arr(q); if (q.length >= 3 && isFinite(q[2])) D.drive.push([q[0], q[1], q[2]]) }) }

      // ---------------------------------------------------------------- ROUTE actions
      scope.addHere = function () {
        return job(async function () {
          var m = await callLua('mark')
          if (!m || !m.ok) return say('No position: ' + ((m && m.why) || 'is BeamNG.Earth running?'), 'err')
          ensureStage(); snapshot()
          var piece = arr(m.piece).map(arr)
          var r = PC.addPoint(D.stage, m, { type: scope.ui.addType, piece: piece })
          keepDrive(piece)
          scope.ui.sel = r.index
          if (r.point.type === 'DSS') scope.ui.addType = 'WPV'
          changed()
          say(PC.labelOf(r.point) + ' added' + (m.camera ? ' at the camera' : '') + (r.point.leg ? ' (leg: ' + (r.point.leg.mode === 'track' ? 'your driven line, ' + r.point._legKm.toFixed(2) + ' km' : 'straight') + ')' : '') + (r.said.length ? '; ' + r.said.join('; ') : '') + '.', 'ok')
        })
      }
      scope.insertHere = function () {
        return job(async function () {
          var p = await callLua('pose')
          if (!p || !p.ok) return say('No position.', 'err')
          snapshot()
          var r = PC.insertPoint(D.stage, p, { type: scope.ui.addType })
          if (r.error) { D.undo.pop(); return say(r.error, 'warn') }
          scope.ui.sel = r.index; changed(); say(PC.labelOf(r.point) + ' inserted (' + r.offM + ' m from the line).', 'ok')
        })
      }
      scope.moveHere = function () {
        return job(async function () {
          var p = await callLua('pose'); if (!p || !p.ok) return say('No position.', 'err')
          snapshot(); var r = PC.movePoint(D.stage, scope.ui.sel, p); changed()
          say('Moved ' + r.movedM + ' m' + (r.straightened ? '; its legs are straight now (re-route them as ROAD or re-drive)' : '') + '.', r.straightened ? 'warn' : 'ok')
        })
      }
      scope.startHere = function () {
        return job(async function () {
          var p = await callLua('pose'); if (!p || !p.ok) return say('No position.', 'err')
          snapshot(); D.stage.meta.start = { lat: p.lat, lon: p.lon }; changed(); say('TP TO DSS will put the car here.', 'ok')
        })
      }
      scope.selPt = function (i) { scope.ui.sel = scope.ui.sel === i ? null : i; refresh() }
      scope.delPt = function () { snapshot(); PC.deletePoint(D.stage, scope.ui.sel); scope.ui.sel = null; changed() }
      scope.shift = function (d) { snapshot(); if (PC.shiftPoint(D.stage, scope.ui.sel, d)) { scope.ui.sel += d; changed(); say('Order changed: the legs either side are straight now.', 'warn') } else D.undo.pop() }
      scope.setType = function () { snapshot(); PC.setType(D.stage, scope.ui.sel, scope.ui.pt.type); changed() }
      scope.setName = function () { var p = D.stage && D.stage.points[scope.ui.sel]; if (p && p.name !== scope.ui.pt.name) { snapshot(); p.name = scope.ui.pt.name; changed() } }
      scope.setLimit = function () { var p = D.stage && D.stage.points[scope.ui.sel]; var n = +scope.ui.pt.limit; if (p && n > 0 && n !== p.speedLimit) { snapshot(); p.speedLimit = n; changed() } }
      scope.setMode = function () {
        var i = scope.ui.sel, m = scope.ui.pt.mode
        snapshot()
        var r = PC.setLegMode(D.stage, i, m)
        if (r === 'no-line') { D.undo.pop(); refresh(); return say('This leg has no driven line: drive it with REC on and add the point again, or use ROAD / STRAIGHT.', 'warn') }
        if (r === 'needs-route') {
          return job(async function () {
            say('Routing on roads (OSRM, needs internet)...')
            var res = await PC.routeRoadLeg(D.stage, i, function (url) { return fetch(url).then(function (x) { return x.json() }) })
            changed(); say(res.ok ? 'Routed on roads: ' + res.km.toFixed(2) + ' km.' : 'Could not route on roads (' + res.error + '): the leg is straight. Route it on the website later.', res.ok ? 'ok' : 'warn')
          })
        }
        changed()
      }

      // ---------------------------------------------------------------- ROADBOOK actions
      scope.generate = function (keep) {
        return job(async function () {
          if (!D.stage) return
          var errs = PC.problems(D.stage).filter(function (x) { return x[0] === 'err' })
          if (errs.length) return say('Fix the route first: ' + errs[0][1], 'err')
          var online = await checkNet()
          if (!keep && D.rb && D.rb.boxes.some(function (b) { return b.pinned || b.source === 'editor' })) {
            if (!(await ask('NEW replaces the roadbook and your edits (REGEN, KEEP EDITS keeps them). Go on?', 'REPLACE'))) return
          }
          if (keep && !online && D.rb && !D.rb.partial) {
            if (!(await ask('No internet: regenerating offline replaces the untouched boxes with simpler ones (your edits stay). Go on?', 'REGENERATE'))) return
          }
          say(online ? 'Generating with the map data (terrain, OpenStreetMap)... the game may stutter for a few seconds.' : 'Generating offline (route + the heights you drove)...')
          var stage = PC.exportStage(D.stage)
          var res = await PC.generateRoadbook(RB, stage, { online: online, drive: D.drive, old: keep ? D.rb : null, density: +scope.ui.density,
            onProgress: function (e) { var base = { terrain: 0, osm: 0.35, landmarks: 0.8, landcover: 0.9, assemble: 0.95, done: 1 }[e.phase] || 0; apply(function () { scope.ui.prog = Math.min(1, base + (e.total ? 0.3 * e.done / e.total : 0)) }) } })
          snapshot(); D.rb = res.rb; D.fits = 'ok'; scope.ui.boxId = null
          changed()
          var n = PC.liveBoxes(D.rb).length
          say((keep ? 'Regenerated, your edits kept: ' : 'Roadbook made: ') + n + ' boxes. ' + ({ full: 'Full map data.', 'terrain-only': 'Terrain only: OpenStreetMap did not answer (no junctions yet).', 'driven-heights': 'Offline: from the route and the heights you drove' + (res.why ? ' (' + res.why + ')' : '') + '. Regenerate on the website for junctions and landmarks.', 'route-only': 'Offline, route only (no heights recorded): waypoints and bends. Regenerate on the website for the rest.' }[res.mode] || ''), res.mode === 'full' ? 'ok' : 'warn')
        })
      }
      function live() { return D.rb ? PC.liveBoxes(D.rb) : [] }
      scope.boxStep = function (d) { var l = live(), i = l.findIndex(function (b) { return b.id === scope.ui.boxId }); var b = l[Math.max(0, Math.min(l.length - 1, i + d))]; if (b) { scope.ui.boxId = b.id; refresh() } }
      scope.nearestBox = function () {
        var p = scope.g.pose; if (!p || !p.ok) return say('No position.', 'err')
        var best = null, bd = Infinity; live().forEach(function (b) { if (b.lat == null) return; var d = PC.dist([p.lat, p.lon], [b.lat, b.lon]); if (d < bd) { bd = d; best = b } })
        if (best) { scope.ui.boxId = best.id; refresh(); say('Box ' + best.n + ' is ' + Math.round(bd) + ' m away.') }
      }
      scope.boxHere = function () {
        return job(async function () {
          if (!D.rb) return say('Generate a roadbook first (ROADBOOK tab).', 'warn')
          var p = await callLua('pose'); if (!p || !p.ok) return say('No position.', 'err')
          snapshot(); var r = PC.addBoxHere(RB, D.rb, PC.exportStage(D.stage), p)
          if (r.error) { D.undo.pop(); return say(r.error, 'warn') }
          scope.ui.boxId = r.id; scope.ui.tab = 'roadbook'; changed()
          var b = boxById(r.id); say('Box ' + b.n + ' added at ' + (+b.km).toFixed(2) + ' km: pick symbols, danger and notes.', 'ok')
        })
      }
      scope.boxMove = function () {
        return job(async function () {
          var p = await callLua('pose'); if (!p || !p.ok) return say('No position.', 'err')
          snapshot(); var r = PC.moveBoxHere(RB, D.rb, PC.exportStage(D.stage), scope.ui.boxId, p)
          if (r.error) { D.undo.pop(); return say(r.error, 'warn') }
          changed(); say('Box moved to ' + (+boxById(scope.ui.boxId).km).toFixed(2) + ' km.', 'ok')
        })
      }
      scope.boxDel = function () { var b = boxById(scope.ui.boxId); if (!b) return; snapshot(); var r = PC.deleteBox(RB, D.rb, b.id); if (r.error) { D.undo.pop(); return say(r.error, 'warn') } scope.ui.boxId = null; changed() }
      scope.setNotes = function () { var b = boxById(scope.ui.boxId); if (!b || (b.notes || '') === scope.ui.box.notes) return; snapshot(); PC.updateBox(RB, D.rb, b.id, { notes: String(scope.ui.box.notes || '').toUpperCase() }); changed() }
      scope.setDanger = function (d) { var b = boxById(scope.ui.boxId); if (!b) return; snapshot(); PC.updateBox(RB, D.rb, b.id, { danger: d }); changed() }
      scope.turn = function (deg) { var b = boxById(scope.ui.boxId); if (!b) return; snapshot(); PC.updateBox(RB, D.rb, b.id, { tulip: PC.turnedTulip(b, deg) }); changed() }
      scope.turnStraight = function () { var b = boxById(scope.ui.boxId); if (!b) return; var a = b.tulip && b.tulip.exit ? +b.tulip.exit.angle || 0 : 0; snapshot(); PC.updateBox(RB, D.rb, b.id, { tulip: PC.turnedTulip(b, -a) }); changed() }

      // ---------------------------------------------------------------- FILES
      scope.listFiles = function () {
        callLua('list').then(function (r) { apply(function () { scope.files.stages = arr(r && r.stages); scope.files.drafts = arr(r && r.drafts); scope.files.userPath = r && r.userPath ? String(r.userPath).replace(/\\/g, '/') : '' }) }).catch(function (e) { say(e.message, 'err') })
      }
      async function confirmDrop() { return !D.dirty || await ask('Your changes to ' + scope.v.name + ' are not saved (a draft is kept). Open anyway?', 'OPEN') }
      scope.newStage = function () {
        return job(async function () {
          if (!(await confirmDrop())) return
          D.stage = PC.newStage(scope.ui.newName); D.rb = null; D.drive = []; D.undo = []; D.dirty = false
          scope.ui.sel = null; scope.ui.boxId = null; scope.ui.addType = 'DSS'; scope.ui.newName = ''; scope.ui.tab = 'route'
          changed(true); say('New stage "' + D.stage.meta.name + '" (' + D.stage.meta.id + '). Drive to the start and press ADD HERE.', 'ok')
        })
      }
      scope.open = function (f) {
        return job(async function () {
          if (!f || !f.ok || !(await confirmDrop())) return
          var t = await readText(f.path); if (!t) return say('Could not read ' + f.path, 'err')
          var st = PC.importStage(JSON.parse(t)), rb = null, drive = []
          if (f.roadbook) { var rt = await readText(f.roadbook); if (rt) { var j = JSON.parse(rt); if (j.format === 'rallyraid-roadbook' && (!j.stage || j.stage.id === st.meta.id)) rb = j } }
          var dt = await readText(DRIVE_DIR + st.meta.id + '.drive.json'); if (dt) { var dj = JSON.parse(dt); drive = arr(dj.points).map(arr) }
          D.stage = st; D.rb = rb; D.drive = drive; D.undo = []; D.dirty = false; D.fits = 'none'
          scope.ui.sel = null; scope.ui.boxId = null; scope.ui.addType = PC.nextType(st); scope.ui.tab = 'route'; scope.ui.follow = false; scope.ui.zoom = 0
          if (rb && rb.settings && rb.settings.density) scope.ui.density = rb.settings.density
          changed(true); say('Opened ' + st.meta.name + (rb ? ' with its roadbook (' + PC.liveBoxes(rb).length + ' boxes)' : ' (no roadbook yet)') + '.', 'ok')
        })
      }
      scope.openDraft = function (f) {
        return job(async function () {
          if (!(await confirmDrop())) return
          var t = await readText(f.path); if (!t) return say('Could not read the draft.', 'err')
          var d = PC.readDraft(JSON.parse(t))
          D.stage = d.stage; D.rb = d.rb; D.drive = d.drive; D.undo = []; D.dirty = true
          scope.ui.sel = null; scope.ui.boxId = null; scope.ui.tab = 'route'; scope.ui.follow = false
          changed(true); say('Draft restored: SAVE to keep it.', 'warn')
        })
      }
      async function saveAll() {
        var errs = PC.problems(D.stage).filter(function (x) { return x[0] === 'err' })
        var stage = PC.exportStage(D.stage), id = stage.id
        var c = await writeText(STAGE_DIR + id + '.json', PC.asciiJSON(stage))
        var out = ['stage ' + STAGE_DIR + id + '.json' + (c.backup ? ' (old one kept in planner/backup)' : '')]
        if (D.rb) {
          D.rb.modified = new Date().toISOString()
          await writeText(RB_DIR + id + '.roadbook.json', PC.asciiJSON(D.rb)); out.push('roadbook')
        }
        if (D.drive.length) await writeText(DRIVE_DIR + id + '.drive.json', PC.asciiJSON({ format: 'rallyraid-planner-drive', schemaVersion: 1, stage: id, points: D.drive }, 0))
        D.dirty = false
        // the game has this stage loaded: show the new roadbook at once
        if (scope.g.game && scope.g.game.stageId === id && D.rb) await callLua('reloadRoadbook')
        apply(function () { changed(true) })
        return { id: id, errs: errs, said: 'Saved ' + out.join(' + ') + '.' }
      }
      scope.save = function () { return job(async function () { var r = await saveAll(); say(r.said + (r.errs.length ? ' The game will refuse it until: ' + r.errs[0][1] : ''), r.errs.length ? 'warn' : 'ok') }) }
      scope.saveLoad = function () {
        return job(async function () {
          var errs = PC.problems(D.stage).filter(function (x) { return x[0] === 'err' })
          if (errs.length) return say('Not loadable yet: ' + errs[0][1], 'err')
          var r = await saveAll()
          var path = STAGE_DIR + r.id + '.json'
          var l = await callLua('load', { path: path, teleport: !!scope.ui.teleport })
          if (l && !l.ok && l.why === 'running') {
            if (!(await ask(l.message + ' Load anyway?', 'LOAD'))) return say(r.said + ' Not loaded.', 'warn')
            l = await callLua('load', { path: path, teleport: !!scope.ui.teleport, force: true })
          }
          if (!l || !l.ok) return say(r.said + ' The game refused it: ' + ((l && (l.message || l.why)) || '?'), 'err')
          say(r.said + ' Loaded in the rally computer' + (l.teleported ? ', car at the start' : '') + '. Drive to the DSS.', 'ok')
        })
      }

      // ---------------------------------------------------------------- the game
      function onState(data) {
        if (!data) return
        scope.$evalAsync(function () {
          var was = scope.g.open, before = (scope.g.game || {}).stageId
          scope.g = data; scope.g.pose = data.pose || { ok: false }; scope.g.rec = data.rec || { on: false, km: 0 }; scope.g.game = data.game || {}
          if (scope.g.game.stageId !== before) rlog('game stage: ' + (scope.g.game.stageName || 'none'))
          if (data.open && !was) refresh(); else drawMap()
        })
      }
      scope.$on('RallyRaidPlanner', function (event, data) { onState(data) })
      // a stage loaded (or unloaded) in the GPS: the state again, so the bar and EDIT LOADED STAGE follow at once
      var lastStageId
      scope.$on('RallyRaidUpdate', function (event, data) {
        var id = data && data.stageId
        if (id !== lastStageId) { lastStageId = id; callLua('state').then(onState).catch(function () {}) }
      })
      // the player's keys (only actions that have one; none of the planner's by default)
      scope.keys = {}
      scope.kt = function (action, text) { var k = scope.keys[action]; return k ? text + ' (' + k + ')' : text }
      scope.keyText = function (action) { var k = scope.keys[action]; return k ? ' (' + k + ')' : '' }
      // the RECCE panel: its own isolated scope, compiled into .rpl-recce-host; shown with RECCE, and while recce is on
      scope.rc = { show: false, on: false }
      ;(function mountRecce() {
        var def = window.RallyRaidPanels && window.RallyRaidPanels.recce, host = element[0].querySelector('.rpl-recce-host')
        if (!def || !host) return
        var cs = scope.$new(true)
        var el = angular.element(def.template)
        host.appendChild(el[0])
        def.link(cs, el)
        $compile(el)(cs)
      })()
      scope.$on('rrRecceState', function (event, on) { scope.rc.on = on; if (on) scope.rc.show = true })
      scope.toggleRecce = function () { scope.rc.show = !scope.rc.show; rlog('RECCE panel ' + (scope.rc.show ? 'shown' : 'hidden')) }
      scope.$on('RallyRaidKeys', function (event, data) { scope.$evalAsync(function () { scope.keys = (data && data.keys) || {} }) })
      cmd('keys')
      scope.$on('RallyRaidPlannerKey', function (event, data) {
        if (!data || !PC) return
        if (data.key === 'waypoint') { scope.$evalAsync(function () { scope.ui.tab = 'route' }); scope.addHere() }
        else if (data.key === 'box') { scope.$evalAsync(function () { scope.ui.tab = 'roadbook' }); scope.boxHere() }
      })
      function fit() {
        var el = element[0], w = el.clientWidth || W, h = el.clientHeight || H
        var k = Math.min(w / W, h / H)
        if (isFinite(k) && k > 0 && Math.abs(k - scope.k) > 0.001) scope.$evalAsync(function () { scope.k = k })
      }
      var timer = setInterval(fit, 500)
      fit()
      libs(function () {
        PC = window.PlannerCore; RB = window.RoadbookGen; R = window.RoadbookRender
        if (PC) window.__rplCrypto = PC.installCryptoShim(window)
        apply(function () { scope.groups = ['quick'].concat(R && R.GROUPS ? Object.keys(R.GROUPS) : []); refresh() })
      })
      rlog('app init (Planner)')
      hello(true)
      var helloTimer = setInterval(function () { hello(true) }, 3000)
      cmd('plannerAppHere')
      callLua('state').then(onState).catch(function (e) { rlog('state request failed: ' + (e && e.message || e)) })
      scope.$on('$destroy', function () { clearInterval(timer); clearInterval(helloTimer); clearTimeout(draftT); hello(false) })
      scope._D = D   // for the preview tests
    }
  }
}])
