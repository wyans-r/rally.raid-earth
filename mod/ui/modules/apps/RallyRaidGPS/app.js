// rally.raid Earth GPS: the HUD app for lua/ge/extensions/rallyRaid/core.lua (rallyRaid_core).
// Lua -> app: guihooks 'RallyRaidUpdate' (about 10 a second) with the computer and stage state.
// App -> Lua: bngApi.engineLua('rallyRaid_core.cmd(...)'): messages are the only link between the two.
angular.module('beamng.apps')
.directive('rallyRaidGps', [function () {
  var W = 380, H = 340
  function pad3(x) { var s = Math.abs(x).toFixed(2); while (s.length < 6) s = '0' + s; return (x < -0.004 ? '-' : '') + s }
  function deg(x) { if (x === null || x === undefined || !isFinite(x)) return '---'; var d = Math.round(x) % 360; return ('00' + d).slice(-3) }
  function clock(s) {
    if (!isFinite(s) || s === null) return '-:--:--'
    s = Math.max(0, Math.floor(s))
    return Math.floor(s / 3600) + ':' + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2)
  }
  function dist(m) { if (!isFinite(m)) return ''; return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m' }
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" }

  return {
    template:
    '<div class="bngApp rrg-host">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidGPS/app.css">' +
    '<div class="rrg" ng-style="{transform: \'scale(\' + k + \')\'}">' +
      // header: stage, phase, clock
      '<div class="rrg-row rrg-head"><span class="rrg-row"><span class="rrg-phase {{ s.phase }}">{{ phaseText() }}</span>' +
        '<span class="rrg-stage">{{ s.stage || \'NO STAGE\' }}</span></span><span class="rrg-clock">{{ clockText() }}</span></div>' +
      '<div class="rrg-row rrg-sub"><span ng-show="s.count">WP {{ s.validated || 0 }}/{{ s.count }}<span ng-show="s.missed" class="rrg-pen"> &#10007;{{ s.missed }}</span></span>' +
        '<span ng-hide="s.count">{{ s.ok ? \'GPS OK\' : (s.why || \'NO GPS\') }}</span>' +
        '<span ng-show="rb.recce" class="rrg-pen" title="recce mode: the line and changes are being recorded">&#9679; RECCE</span>' +
        '<span ng-show="rb.boxCount" title="roadbook box (next box in)">BOX {{ rb.box || \'-\' }}<span ng-show="rb.toNextBox !== undefined && rb.toNextBox !== null"> &rsaquo; {{ rb.toNextBox.toFixed(2) }}</span></span>' +
        '<span class="rrg-pen" ng-show="s.penalty">PEN +{{ clk(s.penalty) }}</span></div>' +
      // speed zone banner
      '<div class="rrg-zone {{ zoneClass() || \'none\' }}">{{ zoneText() }}</div>' +
      // CAP + waypoint
      '<div class="rrg-main">' +
        '<div class="rrg-cap"><div class="rrg-label">CAP</div><div class="rrg-capval">{{ d(s.cap) }}&deg;</div>' +
          '<div class="rrg-spd">{{ spd() }} km/h</div></div>' +
        '<div class="rrg-wp" ng-show="s.wp">' +
          '<span class="rrg-inside" ng-show="s.wp.inside">IN</span>' +
          '<div class="rrg-wpname" ng-class="{hidden: !s.wp.revealed}">{{ s.wp.type }} {{ s.wp.n }}</div>' +
          '<div ng-show="s.wp.revealed">' +
            '<svg class="rrg-arrow" viewBox="-50 -50 100 100" ng-style="{transform: \'rotate(\' + (s.wp.rel || 0) + \'deg)\'}">' +
              '<polygon points="0,-46 30,20 0,6 -30,20" fill="#ffd400" stroke="#000" stroke-width="3"/></svg>' +
            '<div class="rrg-dtw">{{ dt(s.wp.dtw) }}</div><div class="rrg-ctw">CTW {{ d(s.wp.ctw) }}&deg;</div></div>' +
          '<div class="rrg-masked" ng-hide="s.wp.revealed">&mdash; &mdash; &mdash;</div>' +
        '</div>' +
        '<div class="rrg-wp" ng-hide="s.wp"><div class="rrg-masked">{{ s.phase === \'finished\' ? \'FINISH\' : \'NO WP\' }}</div></div>' +
      '</div>' +
      // odometer
      '<div class="rrg-row rrg-odo"><span class="rrg-label" style="width:34px">TRIP</span>' +
        '<span class="rrg-trip" ng-class="{down: s.countDown}">{{ p3(s.trip || 0) }}</span>' +
        '<button class="rrg-btn" ng-mousedown="hold(-1)" ng-mouseup="hold(0)" ng-mouseleave="hold(0)">&minus;</button>' +
        '<button class="rrg-btn" ng-mousedown="hold(1)" ng-mouseup="hold(0)" ng-mouseleave="hold(0)">+</button>' +
        '<button class="rrg-btn" ng-click="cmd(\'tripReset\')">0</button></div>' +
      '<div class="rrg-row rrg-odo2"><span>PART <b>{{ (s.partial || 0).toFixed(2) }}</b>' +
        '<button class="rrg-btn small" ng-click="cmd(\'partialReset\')">0</button></span>' +
        '<span>TOT <b>{{ (s.total || 0).toFixed(1) }}</b></span>' +
        '<span><button class="rrg-btn small" ng-click="cmd(\'countDown\')" title="count down">{{ s.countDown ? \'▼\' : \'▲\' }}</button>' +
        '<button class="rrg-btn small" ng-click="step()" title="trip step">{{ s.tripStep || 10 }}m</button></span></div>' +
      // footer
      '<div class="rrg-row rrg-foot"><span>' +
        '<button class="rrg-btn" ng-click="cmd(\'wMinus\')" ng-disabled="s.phase !== \'running\'">W&minus;</button>' +
        '<button class="rrg-btn" ng-click="cmd(\'wPlus\')" ng-disabled="s.phase !== \'running\'">W+</button></span>' +
        '<span><button class="rrg-btn go" ng-show="s.phase === \'armed\'" ng-click="cmd(\'start\')">START</button>' +
        '<button class="rrg-btn warn" ng-show="s.phase === \'running\' || s.phase === \'countdown\'" ng-click="abort()">ABORT</button>' +
        '<button class="rrg-btn" ng-click="openStages()">STAGES</button></span></div>' +
      // countdown overlay
      '<div class="rrg-overlay" ng-show="s.phase === \'countdown\'"><div class="rrg-big">{{ cd() }}</div><div class="rrg-msg">stay in the DSS circle</div></div>' +
      // results overlay
      '<div class="rrg-overlay" ng-show="s.phase === \'finished\' && s.result && !hideResult">' +
        '<div class="rrg-label">{{ s.result.retired ? \'STAGE RETIRED: \' + s.result.retired : \'STAGE RESULT\' }}</div><div class="rrg-res">{{ s.stage }}<br>' +
        'Stage time <b>{{ clk(s.result.stageTime) }}</b><br>Penalties <b>+{{ clk(s.result.penaltyTime) }}</b>' +
        ' ({{ s.result.missed }} WP missed, {{ s.impulses || 0 }} speed impulses)<br>Total <b>{{ clk(s.result.totalTime) }}</b></div>' +
        '<div class="rrg-msg">{{ s.result.file ? (\'saved: \' + s.result.file) : \'\' }}</div>' +
        '<div class="rrg-row" style="justify-content:flex-end;margin-top:auto"><button class="rrg-btn" ng-click="cmd(\'abort\')">AGAIN</button>' +
        '<button class="rrg-btn" ng-click="hideResult = true">CLOSE</button><button class="rrg-btn" ng-click="openStages()">STAGES</button></div></div>' +
      // stage picker
      '<div class="rrg-overlay" ng-show="picker">' +
        '<div class="rrg-row" style="justify-content:space-between"><span class="rrg-label">STAGES (rallyraid/stages)</span>' +
        '<button class="rrg-btn small" ng-click="openStages()">&#8635;</button></div>' +
        '<div class="rrg-list"><div class="rrg-item" ng-repeat="st in stages" ng-class="{sel: st.path === pick.path, bad: !st.ok}" ng-click="choose(st)" ng-dblclick="choose(st); load()">' +
          '{{ st.name }} <small ng-show="st.ok">{{ st.km.toFixed(1) }} km, {{ st.waypoints }} WP</small>' +
          '<small ng-hide="st.ok"><br>{{ st.error }}</small></div>' +
          '<div class="rrg-msg" ng-hide="stages.length" style="margin-top:20px">No stage files found.<br>Put .json stages in<br>BeamNG user folder / current / rallyraid / stages</div></div>' +
        '<div class="rrg-row" style="justify-content:flex-end">' +
          '<button class="rrg-btn" ng-click="cmd(\'unload\'); picker = false">UNLOAD</button>' +
          '<button class="rrg-btn" ng-click="cmd(\'teleport\')" ng-disabled="!s.count">TP TO DSS</button>' +
          '<button class="rrg-btn go" ng-click="load()" ng-disabled="!pick.path">LOAD</button>' +
          '<button class="rrg-btn" ng-click="picker = false">&#10005;</button></div>' +
        '<details class="rr-credits"><summary>Credits</summary><p>Map data © OpenStreetMap contributors (ODbL). Land cover: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). Elevation: Mapterhorn (open DEMs, including Copernicus GLO-30) and Mapzen/Tilezen Terrarium tiles. Routing: OSRM. Map queries: public Overpass mirrors including NextGIS. Place names: Nominatim. Built for BeamNG.Earth. Not an official BeamNG or FIM/FIA product. Full credits: https://stagebuilder.wyans.net and the project README.</p></details></div>' +
    '</div></div>',
    replace: true,
    scope: {},
    link: function (scope, element) {
      'use strict'
      scope.s = { phase: 'idle' }
      scope.k = 1
      scope.picker = false
      scope.stages = []
      scope.sel = null
      scope.p3 = pad3; scope.d = deg; scope.dt = dist; scope.clk = clock
      scope.spd = function () { return isFinite(scope.s.speed) ? Math.round(scope.s.speed) : '--' }
      scope.cd = function () { return Math.max(0, Math.ceil(scope.s.countdown || 0)) }
      scope.phaseText = function () {
        return { idle: 'IDLE', armed: 'TO DSS', countdown: 'START', running: 'STAGE', finished: 'FINISH' }[scope.s.phase] || scope.s.phase
      }
      scope.clockText = function () {
        if (scope.s.phase === 'running' || scope.s.phase === 'finished') return clock(scope.s.clock)
        return '0:00:00'
      }
      scope.zoneClass = function () {
        var z = scope.s.zone
        if (z) { if (z.tolerance) return 'tol'; if (z.over) return 'alert'; return 'live' }
        if (scope.s.wp && scope.s.wp.type === 'DZ' && scope.s.wp.zoneAhead) return 'ahead'
        return ''
      }
      scope.zoneText = function () {
        var z = scope.s.zone
        if (z) {
          var imp = z.impulses ? '  IMP ' + z.impulses : ''
          if (z.tolerance) return 'ZONE ' + z.limit + ' km/h  (tolerance)' + imp
          return (z.over ? '\u25B2 ' : '') + 'ZONE ' + z.limit + ' km/h' + imp
        }
        if (scope.s.wp && scope.s.wp.zoneAhead) return 'SPEED ZONE AHEAD  ' + scope.s.wp.speedLimit + ' km/h'
        if (scope.s.lastPenalty && scope.s.phase === 'running') return 'last penalty: ' + scope.s.lastPenalty
        if (scope.s.phase === 'armed') return scope.s.atStart ? (scope.s.startMode === 'countdown' ? 'in the DSS circle: press START' : 'in the DSS circle: START, or just drive off') : 'drive to the DSS'
        if (scope.s.phase === 'idle') return 'STAGES to load a stage'
        return ''
      }
      scope.cmd = function (name, arg) {
        lua('if rallyRaid_core then rallyRaid_core.cmd(' + q(name) + (arg !== undefined ? ', ' + q(arg) : '') + ') end')
      }
      scope.hold = function (dir) { lua('if rallyRaid_core then rallyRaid_core.tripHold(' + dir + ') end') }
      var steps = [10, 100, 1000]
      scope.step = function () {
        var i = steps.indexOf(scope.s.tripStep || 10)
        scope.cmd('tripStep', String(steps[(i + 1) % steps.length]))
      }
      scope.abort = function () { scope.cmd('abort') }
      scope.openStages = function () {
        scope.picker = true
        scope.hideResult = true
        if (!window.bngApi) return
        bngApi.engineLua('rallyRaid_core and rallyRaid_core.listStages() or {}', function (list) {
          scope.$evalAsync(function () { scope.stages = Array.isArray(list) ? list : (list ? Object.values(list) : []) })
        })
      }
      // the list rows live in ng-repeat child scopes, so the choice is kept on an object owned by this scope
      // (a bare "sel = st.path" in a row would only set it on that row's own scope and LOAD would never enable)
      scope.pick = { path: null }
      scope.choose = function (st) { if (st && st.ok) scope.pick.path = st.path }
      scope.load = function () {
        if (!scope.pick.path) return
        scope.cmd('load', scope.pick.path)
        scope.picker = false
        scope.hideResult = false
      }
      scope.rb = {}
      scope.$on('RallyRaidRoadbook', function (event, data) { if (data) scope.$evalAsync(function () { scope.rb = { box: data.box, boxCount: data.boxCount, toNextBox: data.toNextBox, recce: !!data.recce } }) })
      scope.$on('RallyRaidUpdate', function (event, data) {
        scope.$evalAsync(function () {
          if (!data) return
          if (data.phase !== 'finished') scope.hideResult = false
          scope.s = data
        })
      })
      // scale the fixed-size screen to whatever size the player gives the app in the UI apps editor
      function fit () {
        var el = element[0]
        if (!el) return
        var k = Math.min(el.clientWidth / W, el.clientHeight / H)
        if (isFinite(k) && k > 0 && Math.abs(k - scope.k) > 0.005) scope.$evalAsync(function () { scope.k = k })
      }
      var fitTimer = setInterval(fit, 500)
      fit()
      lua('if rallyRaid_core then rallyRaid_core.requestState() end')
      scope.$on('$destroy', function () { clearInterval(fitTimer); lua('if rallyRaid_core then rallyRaid_core.tripHold(0) end') })
    }
  }
}]);
