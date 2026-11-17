// rally.raid Earth Rally (EXPERIMENTAL, B10): the rally mode app for lua/ge/extensions/rallyRaid/rally.lua.
// Lua -> app: guihook 'RallyRaidRally' ({ loaded, list, rally: {name, disclaimer, days}, progress, liaison, bivouac, msg }).
// App -> Lua: rallyRaid_core.cmd('rallyAppHere' | 'rallyList' | 'rallyLoad', path | 'rallyDrive' | 'rallyTeleport' |
// 'rallyCheckIn' | 'rallyLoadStage' | 'rallyTpDss' | 'rallyNextDay' | 'rallyRestart' | 'rallyClose').
// Buttons only: rally mode has no default keys (only 9 default keys are allowed).
angular.module('beamng.apps')
.directive('rallyRaidRally', [function () {
  var W = 380, H = 440
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" }
  function hms(s) { var neg = s < 0; s = Math.abs(Math.round(s || 0)); return (neg ? '-' : '') + Math.floor(s / 3600) + ':' + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2) }
  function hm(min) { min = Math.max(0, Math.round(min || 0)); return Math.floor(min / 60) + ':' + ('0' + min % 60).slice(-2) }
  function arr(x) { return Array.isArray(x) ? x : (x ? Object.keys(x).sort(function (a, b) { return a - b }).map(function (k) { return x[k] }) : []) }
  return {
    template:
    '<div class="bngApp rrl-host">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidRally/app.css">' +
    '<div class="rrl" ng-style="{transform: \'scale(\' + k + \')\'}">' +
      '<div class="rrl-bar" ng-click="open = !open">' +
        '<span class="t">RALLY</span><span class="n">{{ st.rally ? st.rally.name : \'no rally loaded\' }}</span>' +
        '<span class="x" title="not tested in game yet">EXPERIMENTAL</span>' +
        '<span class="tot" ng-show="st.progress">{{ hms(st.progress.totalS) }}</span></div>' +
      '<div class="rrl-panel" ng-show="open">' +
        '<div class="rrl-exp">EXPERIMENTAL – not yet tested in game</div>' +
        // no rally: the list
        '<div ng-show="!st.loaded">' +
          '<div class="rrl-h">Rallies in /rallyraid/rallies/</div>' +
          '<div class="rrl-list"><div class="rrl-pick" ng-repeat="r in list" ng-click="cmd(\'rallyLoad\', r.path)">' +
            '<div class="nm">{{ r.name }} <span class="dim">({{ r.days }} days, {{ r.startDate }})</span></div>' +
            '<div class="disc">{{ r.disclaimer }}</div></div>' +
            '<div class="dim" ng-show="!list.length">No rally files found.</div></div>' +
          '<button class="rrl-btn" ng-click="cmd(\'rallyList\')">REFRESH</button>' +
        '</div>' +
        // a rally
        '<div ng-show="st.loaded" class="rrl-main">' +
          '<div class="disc">{{ st.rally.disclaimer }}</div>' +
          '<div class="rrl-sum"><span>STAGES {{ hms(st.progress.stageS) }}</span><span class="pen">PEN {{ hms(st.progress.penaltyS + st.progress.liaisonPenaltyS) }}</span><span class="tot">TOTAL {{ hms(st.progress.totalS) }}</span></div>' +
          '<div class="rrl-days">' +
            '<div class="rrl-day" ng-repeat="d in days" ng-class="{cur: d.n === st.progress.day, done: d.progress.done}">' +
              '<span class="dt">{{ d.date.slice(5) }}</span><span class="cd">{{ d.code }}</span>' +
              '<span class="ti">{{ d.title }}<b ng-show="d.refuge" class="m"> M</b></span>' +
              '<span class="km">{{ d.ssKm ? (d.ssKm | number:0) + \' km\' : (d.type === \'rest\' ? \'rest\' : \'\') }}</span>' +
              '<span class="tm">{{ d.progress.stage ? hms(d.progress.stage.totalTime) : \'\' }}</span></div>' +
          '</div>' +
          '<div class="rrl-card" ng-show="cur">' +
            '<div class="ct">DAY {{ cur.n }} · {{ cur.date }} · {{ cur.title }}</div>' +
            '<div class="cl dim">{{ cur.from }} &rarr; {{ cur.to }}<span ng-show="cur.marathon"> · MARATHON (no assistance at the refuge)</span></div>' +
            // choose a liaison
            '<div ng-show="ph === \'start\' || ph === \'liaisonInChoice\'">' +
              '<div class="cl">LIAISON {{ ph === \'start\' ? \'OUT\' : \'IN\' }}: {{ lz.km }} km · allowance {{ hm(lz.allowanceMin) }}<span ng-show="lz.ferry"> · sea crossing</span></div>' +
              '<div class="cl dim">Drive it: time left over goes to tonight\'s bivouac. Teleport: the whole allowance counts as used.</div>' +
              '<div class="row"><button class="rrl-btn go" ng-disabled="lz.drive === false" ng-click="cmd(\'rallyDrive\')">DRIVE</button>' +
              '<button class="rrl-btn" ng-click="cmd(\'rallyTeleport\')">TELEPORT</button></div>' +
            '</div>' +
            // driving a liaison
            '<div ng-show="st.liaison">' +
              '<div class="cl big">{{ st.liaison.target }}: {{ st.liaison.distKm }} km · CAP {{ st.liaison.bearing }}°</div>' +
              '<div class="cl" ng-class="{pen: st.liaison.leftS < 0}">ELAPSED {{ hms(st.liaison.elapsedS) }} · LEFT {{ hms(st.liaison.leftS) }}</div>' +
              '<div class="row"><button class="rrl-btn" ng-click="cmd(\'rallyCheckIn\')">CHECK IN</button></div>' +
            '</div>' +
            '<div ng-show="ph === \'stage\'">' +
              '<div class="cl">Stage {{ cur.code }} ({{ cur.ssKm | number:0 }} km) is loaded: start it at the DSS with the GPS app.</div>' +
              '<div class="row"><button class="rrl-btn" ng-click="cmd(\'rallyLoadStage\')">LOAD STAGE</button><button class="rrl-btn" ng-click="cmd(\'rallyTpDss\')">TP TO DSS</button></div>' +
            '</div>' +
            '<div ng-show="ph === \'bivouac\' || ph === \'rest\'">' +
              '<div class="cl" ng-show="st.bivouac && st.bivouac.open">BIVOUAC: {{ hm(st.bivouac.leftMin) }} of {{ hm(st.bivouac.budgetMin) }} left (REPAIR in the Repair app)</div>' +
              '<div class="cl" ng-show="ph === \'rest\'">Rest day: extra service time added to the bivouac.</div>' +
              '<div class="row"><button class="rrl-btn go" ng-click="cmd(\'rallyNextDay\')">NEXT DAY</button></div>' +
            '</div>' +
            '<div ng-show="ph === \'finished\'" class="cl big">FINISHED: {{ hms(st.progress.totalS) }}</div>' +
          '</div>' +
          '<div class="rrl-msg" ng-show="st.msg">{{ st.msg }}</div>' +
          '<div class="row foot"><button class="rrl-btn bad" ng-click="restart()">{{ askRestart ? \'REALLY RESTART?\' : \'RESTART\' }}</button>' +
          '<button class="rrl-btn" ng-click="cmd(\'rallyClose\')">CLOSE</button></div>' +
        '</div>' +
      '</div>' +
    '</div></div>',
    replace: true,
    restrict: 'EA',
    scope: {},
    link: function (scope, element) {
      scope.k = 1; scope.open = true; scope.st = { loaded: false }; scope.list = []; scope.days = []
      scope.hms = hms; scope.hm = hm
      scope.cmd = function (name, arg) { scope.askRestart = false; lua('if rallyRaid_core then rallyRaid_core.cmd(' + q(name) + (arg !== undefined ? ', ' + q(arg) : '') + ') end') }
      scope.restart = function () { if (scope.askRestart) { scope.cmd('rallyRestart') } else scope.askRestart = true }
      scope.$on('RallyRaidRally', function (event, data) {
        scope.$evalAsync(function () {
          data = data || {}
          scope.st = data
          if (data.list) scope.list = arr(data.list)
          scope.days = data.rally ? arr(data.rally.days) : []
          var p = data.progress || {}
          scope.ph = p.phase
          scope.cur = scope.days[(p.day || 1) - 1]
          scope.lz = scope.cur ? ((p.phase === 'liaisonInChoice' ? scope.cur.liaisonIn : scope.cur.liaisonOut) || {}) : {}
        })
      })
      function fit () {
        var el = element[0]; if (!el) return
        var k = Math.min(el.clientWidth / W, el.clientHeight / H)
        if (isFinite(k) && k > 0 && Math.abs(k - scope.k) > 0.005) scope.$evalAsync(function () { scope.k = k })
      }
      var fitTimer = setInterval(fit, 500); fit()
      scope.cmd('rallyAppHere')
      scope.$on('$destroy', function () { clearInterval(fitTimer) })
    }
  }
}]);
