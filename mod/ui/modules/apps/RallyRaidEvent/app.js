// Rally Raid Event: official runs of an async event (lua/ge/extensions/rallyRaid/official.lua through rallyRaid_core).
// Lua -> app: guihooks 'RallyRaidOfficial' ({ active, event, stage, entrant, checks, last, msg, packs }).
// App -> Lua: rallyRaid_core.cmd('officialList' | 'officialLoad', path | 'officialRetry' | 'officialOff').
// The game's UI cannot reach the internet: the upload is made by the game's Lua (plain HTTP), never by this app.
angular.module('beamng.apps')
.directive('rallyRaidEvent', [function () {
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" }
  return {
    template:
    '<div class="bngApp" style="width:100%;height:100%">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidEvent/app.css">' +
    '<div class="rre">' +
      '<div class="rre-soon">COMING SOON. Async Events is not public yet. This app does nothing until the online side is set up.</div>' +
      '<div class="rre-title"><span>RALLY RAID EVENT</span><span ng-class="st.active ? \'rre-ok\' : \'rre-off\'">{{ st.active ? \'OFFICIAL RUN\' : \'not official\' }}</span></div>' +
      '<div ng-if="st.active">' +
        '<div class="rre-line"><b>{{ st.event }}</b> \u00b7 {{ st.stage }}</div>' +
        '<div class="rre-line rre-dim">Entrant: {{ st.entrant || \'?\' }}. No route on the map: roadbook and GPS only. Official rules on.</div>' +
        '<div class="rre-line" ng-class="st.checks.ok ? \'rre-ok\' : \'rre-bad\'">{{ st.checks.ok ? \'\u2713 files match the published hashes, mod version OK\' : \'\u2717 \' + (st.checks.errors || []).join(\'; \') }}</div>' +
        '<div class="rre-line rre-warn" ng-repeat="w in st.checks.warnings track by $index">! {{ w }}</div>' +
        '<div class="rre-line" ng-if="st.last">Result: <b ng-class="{\'rre-ok\': st.last.status === \'uploaded\', \'rre-warn\': st.last.status !== \'uploaded\'}">{{ statusText() }}</b></div>' +
        '<div class="rre-line rre-dim" ng-if="st.last && st.last.file">File: {{ st.last.file }} ({{ kb(st.last.bytes) }} KB)</div>' +
        '<div class="rre-line" style="margin-top:6px"><button class="rre-btn go" ng-if="st.last && st.last.status !== \'uploaded\' && st.last.file" ng-click="cmd(\'officialRetry\')">RETRY UPLOAD</button> ' +
        '<button class="rre-btn" ng-click="cmd(\'officialOff\')">LEAVE OFFICIAL MODE</button></div>' +
      '</div>' +
      '<div ng-if="!st.active">' +
        '<div class="rre-line rre-dim">Download your event pack on the event page and put it in &lt;BeamNG user folder&gt;/rallyraid/events/.</div>' +
        '<div class="rre-pack" ng-repeat="p in st.packs track by p.path"><div><div class="n">{{ p.event }} \u00b7 {{ p.stage }}</div>' +
        '<div class="rre-dim">{{ p.entrant }} \u00b7 {{ p.class }} \u00b7 open {{ p.opensAt }} \u2192 {{ p.closesAt }} (UTC)</div></div>' +
        '<button class="rre-btn go" ng-click="load(p.path)">LOAD</button></div>' +
        '<div class="rre-line rre-dim" ng-if="!(st.packs && st.packs.length)">No event packs found.</div>' +
        '<button class="rre-btn" ng-click="cmd(\'officialList\')">REFRESH</button>' +
      '</div>' +
      '<div class="rre-line rre-warn" ng-if="st.msg">{{ st.msg }}</div>' +
    '</div></div>',
    replace: true,
    restrict: 'EA',
    scope: {},
    link: function (scope) {
      scope.st = { packs: [] }
      scope.cmd = function (c) { lua('if rallyRaid_core then rallyRaid_core.cmd(' + q(c) + ') end') }
      scope.load = function (p) { lua('if rallyRaid_core then rallyRaid_core.cmd(\'officialLoad\', ' + q(p) + ') end') }
      scope.kb = function (b) { return Math.round((b || 0) / 1024) }
      scope.statusText = function () {
        var l = scope.st.last || {}
        if (l.status === 'uploaded') return 'uploaded' + (l.server && l.server.status ? ' (' + l.server.status + ')' : '')
        if (l.status === 'uploading') return 'uploading...'
        return 'saved, not uploaded' + (l.error ? ': ' + l.error : '') + '. Upload the file on the event page.'
      }
      scope.$on('RallyRaidOfficial', function (e, d) { scope.$evalAsync(function () { scope.st = d || {}; if (!scope.st.packs) scope.st.packs = [] }) })
      scope.cmd('officialHere')
    }
  }
}])
