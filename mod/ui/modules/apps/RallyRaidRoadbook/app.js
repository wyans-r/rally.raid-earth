// rally.raid Earth Roadbook: the in-game roadbook reader for rallyRaid_core (lua/ge/extensions/rallyRaid/core.lua).
// Lua -> app: guihooks 'RallyRaidRoadbook' (about 10 a second): trip, the box the trip is in, and `view`, the boxes on
// screen (the current one and the next three, or where the driver scrolled to with box up / down).
// App -> Lua: rallyRaid_core.cmd('boxPrev' | 'boxNext' | 'boxSync' | 'reloadRoadbook' | 'keys').
// A reader only (18 Nov): the recce controls moved to the Planner app; recce edits still show here live (the boxes come
// from the same Lua list) and the head says RECCE while it is on.
// Keys: only box up / down / sync have default keys; the button titles show the player's actual key from the
// guihook 'RallyRaidKeys' (rallyRaid/keys.lua), so a key the player bound in Options > Controls shows up too.
// Drawing (tulips, symbols) is roadbook-render.js, the same file the stage builder's editor and PDF use.
angular.module('beamng.apps')
.directive('rallyRaidRoadbook', [function () {
  var W = 380, H = 520
  var BASE = '/ui/modules/apps/RallyRaidRoadbook/'
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
  var APP = 'roadbook'
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
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function pad3(c) { if (c == null || !isFinite(c)) return '---'; var s = String(Math.round(c) % 360); while (s.length < 3) s = '0' + s; return s }
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : '-' }
  // load the shared renderer once for every instance of the app
  function renderer(cb) {
    if (window.RoadbookRender) return cb(window.RoadbookRender)
    var w = window.__rrbWait = window.__rrbWait || []
    w.push(cb)
    if (w.length > 1) return
    var s = document.createElement('script')
    s.src = BASE + 'roadbook-render.js'
    s.onload = function () { var l = window.__rrbWait; window.__rrbWait = null; l.forEach(function (f) { f(window.RoadbookRender) }) }
    document.head.appendChild(s)
  }
  function boxHTML(R, b) {
    var dng = b.danger ? new Array(b.danger + 1).join('!') : ''
    var sym = (Array.isArray(b.symbols) ? b.symbols : []).slice(0, 6).map(function (c) { return R ? R.symbolSVG(c, 24) : '' }).join('')
    return '<div class="rrb-box' + (b.current ? ' cur' : '') + (b.danger >= 2 ? ' d' + b.danger : '') + (b.recce ? ' rc' : '') + (b.recce === 'recce-auto' && !b.verified ? ' chk' : '') + '">' +
      '<div class="rrb-c1"><span class="rrb-no">' + esc(b.n) + '</span><div class="rrb-km">' + num(b.km, 2) + '</div><div class="rrb-part">' + num(b.partial, 2) + '</div></div>' +
      '<div class="rrb-c2' + (b.offPiste ? ' off' : '') + '">' + (R ? R.tulipSVG(b.tulip && typeof b.tulip === 'object' ? b.tulip : null, 96) : '') + '</div>' +
      '<div class="rrb-c3"><div class="rrb-sym">' + sym + '</div><div class="rrb-note">' + esc(R && R.noteCase ? R.noteCase(b.notes) : String(b.notes == null ? '' : b.notes).toUpperCase()) + '</div>' +
      (dng ? '<span class="rrb-dng">' + dng + '</span>' : '') + '<span class="rrb-cap">CAP ' + pad3(b.cap) + '</span></div></div>'
  }
  // arrays from Lua may arrive as objects keyed 1..n
  // a JS value as a Lua literal (strings: printable ASCII only)
  function luaVal(v) {
    if (v === null || v === undefined) return 'nil'
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'nil'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'string') return "'" + v.replace(/[^\x20-\x7e]/g, '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
    return '{' + Object.keys(v).filter(function (k) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) }).map(function (k) { return k + '=' + luaVal(v[k]) }).join(', ') + '}'
  }
  function arr(x) { return Array.isArray(x) ? x : (x && typeof x === 'object') ? Object.keys(x).sort(function (a, b) { return a - b }).map(function (k) { return x[k] }) : [] }
  function norm(b) { if (b) { b.symbols = arr(b.symbols); if (b.tulip && b.tulip.branches) b.tulip.branches = arr(b.tulip.branches); if (b.tulip && b.tulip.pre) { b.tulip.pre = arr(b.tulip.pre); b.tulip.pre.forEach(function (n) { n.branches = arr(n.branches) }) } } return b }

  return {
    template:
    '<div class="bngApp rrb-host">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidRoadbook/app.css">' +
    '<div class="rrb" ng-style="{transform: \'scale(\' + k + \')\'}">' +
      '<div class="rrb-head"><span>BOX <b>{{ r.box || \'-\' }}</b> / {{ r.boxCount || 0 }}<span ng-show="r.manual" style="color:#ffd400"> &middot; SCROLLED</span>' +
          '<span ng-show="r.recce" class="rrb-rc" title="recce is on (its controls are in the Planner app)"> &middot; RECCE</span></span>' +
        '<span class="rrb-trip">{{ trip() }}</span></div>' +
      '<div class="rrb-next"><span>NEXT {{ r.nextBox || \'-\' }}</span><span class="rrb-bar"><i ng-style="{width: bar() + \'%\'}"></i></span><span>{{ toNext() }}</span></div>' +
      '<div class="rrb-list"></div>' +
      // stage / roadbook picker: a roadbook belongs to a stage, so choosing one loads that stage and its roadbook
      '<div class="rrb-overlay" ng-show="picker">' +
        '<div class="rrb-head"><span>CHOOSE A ROADBOOK</span><button class="rrb-btn" ng-click="openStages()" title="refresh">&#8635;</button></div>' +
        '<div class="rrb-plist"><div class="rrb-pitem" ng-repeat="st in stages" ng-class="{sel: st.path === sp.path, bad: !st.ok}" ng-click="choose(st)" ng-dblclick="choose(st); loadSel()">' +
          '{{ st.name }}<br><small ng-show="st.ok">{{ st.km.toFixed(1) }} km &middot; {{ st.roadbook ? \'roadbook \' + st.roadbook.replace(\'/rallyraid/roadbooks/\', \'\') : \'no roadbook file (waypoint boxes only)\' }}</small>' +
          '<small ng-hide="st.ok">{{ st.error }}</small></div>' +
          '<div class="rrb-empty" ng-hide="stages.length">No stages found.<br>Put stage .json files in<br>BeamNG user folder / current / rallyraid / stages</div></div>' +
        '<div class="rrb-foot" style="justify-content:flex-end"><button class="rrb-btn on" ng-click="loadSel()" ng-disabled="!sp.path">LOAD</button>' +
          '<button class="rrb-btn" ng-click="picker = false">&#10005;</button></div></div>' +
      '<div class="rrb-foot"><span>' +
        '<button class="rrb-btn" ng-click="cmd(\'boxPrev\')" title="{{ kt(\'rallyRaid_boxPrev\', \'box up\') }}">&#9650;</button> ' +
        '<button class="rrb-btn" ng-click="cmd(\'boxNext\')" title="{{ kt(\'rallyRaid_boxNext\', \'box down\') }}">&#9660;</button> ' +
        '<button class="rrb-btn" ng-class="{on: r.manual}" ng-click="cmd(\'boxSync\')" title="{{ kt(\'rallyRaid_boxSync\', \'I am at this box: set the trip to its km\') }}">SYNC</button></span>' +
        '<span class="rrb-src" title="{{ r.roadbookFile }}">{{ r.roadbookFile ? r.roadbookFile.replace(\'/rallyraid/roadbooks/\', \'\') : \'stage boxes only\' }}</span>' +
        '<button class="rrb-btn" ng-click="cmd(\'reloadRoadbook\')" title="re-read the roadbook file">&#8635;</button>' +
        '<button class="rrb-btn" ng-click="openStages()" title="choose a stage and its roadbook">BOOK</button></div>' +
      '<details class="rr-credits"><summary>Credits</summary><p>Map data © OpenStreetMap contributors (ODbL). Land cover: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). Elevation: Mapterhorn (open DEMs, including Copernicus GLO-30) and Mapzen/Tilezen Terrarium tiles. Routing: OSRM. Map queries: public Overpass mirrors including NextGIS. Place names: Nominatim. Built for BeamNG.Earth. Not an official BeamNG or FIM/FIA product. Full credits: https://stagebuilder.wyans.net and the project README.</p></details>' +
    '</div></div>',
    replace: true,
    scope: {},
    link: function (scope, element) {
      'use strict'
      scope.r = { boxCount: 0 }
      scope.k = 1
      var R = null, lastSig = ''
      var list = element[0].querySelector('.rrb-list')
      function draw() {
        var v = arr(scope.r.view).map(norm)
        var sig = (v.length ? '' : (scope.r.phase || '') + '|' + (scope.r.stageId || '') + '|') + JSON.stringify(v)
        if (sig === lastSig) return
        lastSig = sig
        if (!v.length) { list.innerHTML = '<div class="rrb-empty">' + (scope.r.phase === 'idle' || !scope.r.stageId ? 'No stage loaded.<br>Press <b>BOOK</b> below to choose a roadbook,<br>or load a stage in the rally.raid Earth GPS app.' : 'This stage has no roadbook boxes.<br>Make a roadbook in the stage builder and save it as<br><b>rallyraid/roadbooks/' + esc(scope.r.stageId) + '.roadbook.json</b>') + '</div>'; return }
        list.innerHTML = v.map(function (b) { return boxHTML(R, b) }).join('')
      }
      renderer(function (r) { R = r; lastSig = ''; draw() })
      scope.trip = function () { var t = scope.r.trip; return (typeof t === 'number' && isFinite(t)) ? t.toFixed(2) : '0.00' }
      scope.toNext = function () { var d = scope.r.toNextBox; return (typeof d === 'number' && isFinite(d)) ? (d < 1 ? Math.max(0, Math.round(d * 1000)) + ' m' : d.toFixed(2) + ' km') : '' }
      scope.bar = function () {
        var v = arr(scope.r.view), cur = null, nxt = null
        for (var i = 0; i < v.length; i++) { if (v[i].current) { cur = v[i]; nxt = v[i + 1] } }
        if (!cur || !nxt || !(nxt.km > cur.km)) return 0
        return Math.max(0, Math.min(100, (scope.r.trip - cur.km) / (nxt.km - cur.km) * 100))
      }
      scope.cmd = function (name, arg) { lua('if rallyRaid_core then rallyRaid_core.cmd(' + q(name) + ', ' + (arg !== undefined ? luaVal(arg) : 'nil') + ', ' + q(APP) + ') else log(\'E\', \'rallyRaid\', ' + q('[rally.raid Earth] UI roadbook: ' + name + ' pressed, but rallyRaid_core is NOT loaded') + ') end') }
      // the player's keys (only actions that have one): 'text (its key)' or just 'text'
      scope.keys = {}
      scope.kt = function (action, text) { var k = scope.keys[action]; return k ? text + ' (' + k + ')' : text }
      scope.$on('RallyRaidKeys', function (event, data) { scope.$evalAsync(function () { scope.keys = (data && data.keys) || {} }) })
      scope.cmd('keys')
      // stage / roadbook picker (the choice lives on an object: list rows have their own child scopes)
      scope.picker = false; scope.stages = []; scope.sp = { path: null }
      scope.openStages = function () {
        scope.picker = true
        if (!window.bngApi) return
        bngApi.engineLua('rallyRaid_core and rallyRaid_core.listStages() or {}', function (list) {
          scope.$evalAsync(function () { scope.stages = arr(list) })
        })
      }
      scope.choose = function (st) { if (st && st.ok) scope.sp.path = st.path }
      scope.loadSel = function () { if (!scope.sp.path) return; scope.cmd('load', scope.sp.path); scope.picker = false }
      scope.$on('RallyRaidRoadbook', function (event, data) {
        scope.$evalAsync(function () {
          if (!data) return
          scope.r = data; draw()
        })
      })
      function fit () {
        var el = element[0]
        var w = el.clientWidth || W, h = el.clientHeight || H
        var k = Math.min(w / W, h / H)
        if (isFinite(k) && k > 0 && Math.abs(k - scope.k) > 0.001) scope.$evalAsync(function () { scope.k = k })
      }
      var timer = setInterval(fit, 500)
      fit()
      lua('if rallyRaid_core then rallyRaid_core.requestState() end')
      rlog('app init (Roadbook)')
      hello(true)
      var helloTimer = setInterval(function () { hello(true) }, 3000)
      scope.$on('$destroy', function () { clearInterval(timer); clearInterval(helloTimer); hello(false) })
    }
  }
}])
