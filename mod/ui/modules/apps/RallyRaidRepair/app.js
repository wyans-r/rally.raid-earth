// rally.raid Earth Repair: the repair menu for lua/ge/extensions/rallyRaid/repair.lua (through rallyRaid_core).
// Lua -> app: guihooks 'RallyRaidRepair' with the menu state (mode, options, spares, resumes, bivouac clock).
// App -> Lua: rallyRaid_core.cmd('repairMenu' | 'repairClose' | 'repairConfirm', 'id,id' | 'repairAppHere').
// The bar (or REPAIR in the GPS app) opens / closes the menu. The rally.raid Earth actions here have no default key
// (Wyans 2026-11-17); a key the player binds in Options > Controls is shown from the guihook 'RallyRaidKeys'.
// RECOVER CAR (rallyRaid/resume.lua, the one reset allowed in a stage): Lua -> app guihooks 'RallyRaidRecover'
// ({ ask, askRetire, busy, msg, ... }); app -> Lua rallyRaid_core.cmd('recoverAsk' | 'recoverConfirm' | 'recoverCancel' |
// 'recoverRetire'). RECOVER in the GPS app (cmd 'recoverKey', also the rallyRaid_recoverCar action) asks, a second press confirms.
// GAME-CRASH RESUME (rallyRaid/gameResume.lua, the stage saved to disk): Lua -> app guihooks 'RallyRaidGameResume'
// ({ offer, busy, hold, askDiscard, msg, flagged, saves, lastSaveAgeS }); app -> Lua rallyRaid_core.cmd('gameResumeResume' |
// 'gameResumeDiscard' | 'gameResumeDiscardCancel' | 'gameResumeGo' | 'gameResumeDismiss'). RESUME in the GPS app (cmd
// 'gameResumeKey', also the rallyRaid_gameResume action): shows the save, a second press resumes; GO while the clock is held.
angular.module('beamng.apps')
.directive('rallyRaidRepair', [function () {
  var W = 360, H = 300
  var APP = 'repair'
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
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
  function hm(min) { min = Math.max(0, Math.round(min || 0)); return Math.floor(min / 60) + ':' + ('0' + min % 60).slice(-2) }
  function hms(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 3600) + ':' + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2) }
  function ago(s) {
    s = Math.max(0, Math.floor(s || 0))
    if (s < 90) return s + ' s'
    if (s < 5400) return Math.round(s / 60) + ' min'
    if (s < 172800) return (s / 3600).toFixed(1) + ' h'
    return Math.floor(s / 86400) + ' days'
  }
  return {
    template:
    '<div class="bngApp rrr-host">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidRepair/app.css">' +
    '<div class="rrr" ng-style="{transform: \'scale(\' + k + \')\'}">' +
      // the always-visible bar
      '<div class="rrr-bar" ng-click="toggle()">' +
        '<button class="rrr-btn rrr-open" ng-click="toggle(); $event.stopPropagation()">{{ st.open ? \'CLOSE\' : modeText() }}</button>' +
        '<span ng-show="st.mode === \'stage\'">SPARES {{ st.spares.max - st.spares.used }}/{{ st.spares.max }}</span>' +
        '<span ng-show="st.mode === \'bivouac\' && st.bivouac" ng-class="{\'rrr-pen\': st.bivouac.overMin > 0}">LEFT {{ hm(st.bivouac.leftMin) }}</span>' +
        '<span ng-class="{\'rrr-pen\': st.resumes.rally >= st.resumes.max}" title="car recoveries and resets used in the rally">RESETS {{ st.resumes.rally || 0 }}/{{ st.resumes.max || 3 }}</span>' +
        '<span class="rrr-pen" ng-show="rs.busy || gr.busy">CLOCK STOPPED</span>' +
        '<span class="rrr-held" ng-show="gr.hold && !gr.busy" title="the stage clock is held at the saved time until you drive off">HELD</span>' +
        '<span class="rrr-review" ng-show="gr.flagged" title="resumed after a game crash: flagged for organizer review">REVIEW</span>' +
        '<span class="k" ng-show="keys.rallyRaid_repairMenu && !rs.busy && !gr.busy && !gr.hold && !gr.flagged">{{ keys.rallyRaid_repairMenu }}</span></div>' +
      // closed: what the menu would offer now (the app is never just an empty bar)
      '<div class="rrr-hint" ng-show="!st.open && !rsShown() && !grShown()">{{ hintText() }}</div>' +
      // game-crash resume: the saved stage offered, the resume running, the clock held, the outcome
      '<div class="rrr-resume rrr-game" ng-show="grShown()">' +
        '<div class="rrr-rtitle" ng-class="{bad: gr.offer && gr.offer.policy && gr.offer.policy.refused}">{{ grTitle() }}</div>' +
        '<div ng-show="gr.offer && !gr.busy">' +
          '<div class="rrr-rline big">{{ gr.offer.text }}</div>' +
          '<div class="rrr-rline" ng-show="!gr.askDiscard">{{ savedText() }}</div>' +
          '<div class="rrr-rline dim" ng-show="gr.offer.stageTimeLostS > 0">About {{ hms(gr.offer.stageTimeLostS) }} of driving after the save was lost in the crash.</div>' +
          '<div class="rrr-rline dim" ng-show="gr.offer.used > 1">The newest save was damaged: this is the one before it.</div>' +
          '<div class="rrr-rline" ng-show="!gr.offer.policy.refused && !gr.askDiscard">{{ policyText() }}</div>' +
          '<div class="rrr-rline rrr-rwarn" ng-show="gr.offer.policy.refused">{{ gr.offer.policy.reason }}: {{ gr.offer.policy.retire ? \'the stage is retired with the saved state.\' : \'no resume.\' }}</div>' +
          '<div class="rrr-rline rrr-rwarn" ng-show="gr.askDiscard">Really discard? The save is deleted and you start the stage again (the restart is logged).</div>' +
        '</div>' +
        '<div ng-show="gr.busy" class="rrr-rline">Putting the car back where it was saved, with its damage. The stage clock is stopped.</div>' +
        '<div ng-show="gr.hold && !gr.busy">' +
          '<div class="rrr-rline big">Clock held at the saved time.</div>' +
          '<div class="rrr-rline">It starts when you drive off, or press GO{{ keyText(\'rallyRaid_gameResume\') }}.</div>' +
        '</div>' +
        '<div class="rrr-rline" ng-show="gr.msg && !gr.offer && !gr.busy && !gr.hold">{{ gr.msg }}</div>' +
        '<div class="rrr-rline rrr-flag" ng-show="gr.flagged && (gr.hold || gr.msg) && !gr.offer">{{ flagText() }}</div>' +
        '<div class="rrr-foot rrr-rfoot" ng-show="!gr.busy"><span>' +
          '<button class="rrr-btn rgo" ng-show="gr.offer && !gr.askDiscard && !gr.offer.policy.refused" ng-click="cmd(\'gameResumeResume\')">RESUME</button> ' +
          '<button class="rrr-btn bad" ng-show="gr.offer && !gr.askDiscard && gr.offer.policy.refused && gr.offer.policy.retire" ng-click="cmd(\'gameResumeResume\')">RETIRE STAGE</button> ' +
          '<button class="rrr-btn bad" ng-show="gr.offer" ng-click="cmd(\'gameResumeDiscard\')">{{ gr.askDiscard ? \'YES, DISCARD\' : \'DISCARD\' }}</button> ' +
          '<button class="rrr-btn" ng-show="gr.offer && gr.askDiscard" ng-click="cmd(\'gameResumeDiscardCancel\')">CANCEL</button>' +
          '<button class="rrr-btn rgo" ng-show="gr.hold && !gr.offer" ng-click="cmd(\'gameResumeGo\')">GO</button>' +
          '<button class="rrr-btn" ng-show="gr.msg && !gr.offer && !gr.hold" ng-click="cmd(\'gameResumeDismiss\')">OK</button></span></div>' +
      '</div>' +
      // RECOVER CAR: the confirm (penalty, recoveries left), the refusal with its reason, the running recovery, the outcome
      '<div class="rrr-resume rrr-rec" ng-show="rsShown() && !grShown()">' +
        '<div class="rrr-rtitle" ng-class="{bad: rs.ask && !rs.ask.allowed}">{{ rsTitle() }}</div>' +
        '<div ng-show="rs.busy" class="rrr-rline">Putting the car back on the route. The stage clock is stopped.</div>' +
        '<div ng-show="rs.ask && rs.ask.allowed && !rs.busy">' +
          '<div class="rrr-rline big">Penalty <b class="rrr-pen">+{{ round(rs.ask.penaltyS / 60) }} min</b></div>' +
          '<div class="rrr-rline">Recoveries / resets: {{ rs.ask.used }} of {{ rs.ask.max }} used, <b>{{ rs.ask.leftAfter }} left</b> after this. This stage: {{ rs.ask.stageUsed }} of {{ rs.ask.stageMax }}.</div>' +
          '<div class="rrr-rline">Back on the route {{ round(rs.ask.target.backM) }} m behind where you got stuck, at km {{ rs.ask.target.km.toFixed(2) }}, facing along the route.</div>' +
          '<div class="rrr-rline">{{ damageText() }}</div>' +
          '<div class="rrr-rline dim">The clock stops while the car is moved. A second one on this stage retires it. Confirm here, or press RECOVER in the GPS app{{ keyText(\'rallyRaid_recoverCar\', \' / \') }} again.</div>' +
        '</div>' +
        '<div ng-show="rs.ask && !rs.ask.allowed && !rs.busy">' +
          '<div class="rrr-rline rrr-rwarn">{{ rs.ask.reason }}</div>' +
          '<div class="rrr-rline" ng-show="rs.ask.retireInstead && !rs.askRetire">You can retire this stage. It is logged in the results.</div>' +
          '<div class="rrr-rline rrr-rwarn" ng-show="rs.askRetire">Really retire this stage? The stage ends here.</div>' +
        '</div>' +
        '<div class="rrr-rline" ng-show="rs.msg && !rs.ask && !rs.busy">{{ rs.msg }}</div>' +
        '<div class="rrr-foot rrr-rfoot" ng-show="!rs.busy"><span>' +
          '<button class="rrr-btn rgo" ng-show="rs.ask && rs.ask.allowed" ng-click="resumeConfirm()">CONFIRM RECOVERY</button> ' +
          '<button class="rrr-btn bad" ng-show="rs.ask && !rs.ask.allowed && rs.ask.retireInstead" ng-click="resumeRetire()">{{ rs.askRetire ? \'YES, RETIRE\' : \'RETIRE STAGE\' }}</button> ' +
          '<button class="rrr-btn" ng-click="resumeCancel()">{{ rs.ask ? \'CANCEL\' : \'OK\' }}</button></span></div>' +
      '</div>' +
      // the menu
      '<div class="rrr-panel" ng-show="st.open && !rsShown() && !grShown()">' +
        '<div class="rrr-head"><span>{{ headText() }}</span><span ng-show="st.mode === \'stage\' && st.repairTimeS">repairs so far +{{ hm(st.repairTimeS / 60) }}</span></div>' +
        '<div class="rrr-msg" ng-show="st.msg">{{ st.msg }}</div>' +
        '<div class="rrr-msg" ng-show="st.busy">REPAIRING: {{ st.busy }}...</div>' +
        '<div class="rrr-msg" ng-show="st.mode === \'stage\' && st.spares.used >= st.spares.max">No spare wheel left on this stage.</div>' +
        '<div class="rrr-msg" ng-show="st.mode !== \'none\' && !st.stopped && !st.busy">Stop the car to repair.</div>' +
        '<div class="rrr-list">' +
          // rows live in ng-repeat child scopes: the selection is kept on an object owned by this scope (sel.ids)
          '<div ng-repeat="o in st.options track by o.id">' +
            '<div class="rrr-opt" ng-class="{sel: sel.ids[o.id], off: !o.enabled}" ng-click="pick(o)" title="{{ o.why || \'\' }}">' +
              '<span class="box"></span><span class="lbl">{{ o.label }}' +
                '<span class="rrr-dmg" ng-show="o.damage > 0" ng-class="{bad: o.damage > 0.3}"><i ng-style="{width: pct(o.damage)}"></i></span>' +
                '<span class="rrr-flat" ng-show="o.flat">FLAT</span></span>' +
              '<span class="min">{{ o.minutes }} min<span ng-show="o.penaltyS" class="rrr-pen"> +{{ hm(o.penaltyS / 60) }} pen</span></span></div>' +
            '<div class="rrr-sub" ng-show="o.kind === \'whole\' && o.items.length > 1">{{ itemsText(o) }}</div>' +
            '<div class="rrr-sub rrr-pen" ng-show="o.kind === \'engine\' && o.engineFlags.length">engine damage: {{ o.engineFlags.join(\', \') }}</div>' +
            '<div class="rrr-sub" ng-show="!o.enabled && o.why && !o.spare">{{ o.why }}</div>' +
          '</div>' +
        '</div>' +
        '<div class="rrr-rrow" ng-show="st.mode === \'stage\'"><button class="rrr-btn bad" ng-click="resumeAsk()" title="{{ kt(\'rallyRaid_recoverCar\', \'Ask for a car recovery (then confirm)\') }}" ng-disabled="rs.enabled === false">RECOVER CAR</button>' +
          '<span class="dim">{{ rs.enabled === false ? \'switched off for this event\' : \'stuck or rolled? back on the route, +15 / 30 min\' }}</span></div>' +
        '<div class="rrr-save dim" ng-show="st.mode === \'stage\' && gr.saves">saved to disk {{ gr.lastSaveAgeS !== undefined ? ago(gr.lastSaveAgeS) + \' ago\' : \'\' }} (game crash: load the stage again after a relaunch and press RESUME)<span class="rrr-pen" ng-show="gr.saveFails"> - {{ gr.saveFails }} save(s) failed</span></div>' +
        '<div class="rrr-warn" ng-show="warnText()">{{ warnText() }}</div>' +
        '<div class="rrr-foot"><span class="rrr-total">{{ totalText() }}</span><span>' +
          '<button class="rrr-btn go" ng-click="confirm()" ng-disabled="!canConfirm()">REPAIR</button> ' +
          '<button class="rrr-btn" ng-click="close()">CLOSE</button></span></div>' +
        '<details class="rr-credits"><summary>Credits</summary><p>Map data © OpenStreetMap contributors (ODbL). Land cover: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). Elevation: Mapterhorn (open DEMs, including Copernicus GLO-30) and Mapzen/Tilezen Terrarium tiles. Routing: OSRM. Map queries: public Overpass mirrors including NextGIS. Place names: Nominatim. Built for BeamNG.Earth. Not an official BeamNG or FIM/FIA product. Full credits: https://stagebuilder.wyans.net and the project README.</p></details>' +
      '</div>' +
    '</div></div>',
    replace: true,
    scope: {},
    link: function (scope, element) {
      'use strict'
      scope.st = { open: false, mode: 'none', options: [], resumes: {}, spares: {} }
      scope.k = 1
      scope.hm = hm
      scope.sel = { ids: {} }
      scope.pct = function (d) { return Math.round(Math.min(1, d || 0) * 100) + '%' }
      scope.modeText = function () { return { stage: 'REPAIR', bivouac: 'BIVOUAC', none: 'REPAIR' }[scope.st.mode] || 'REPAIR' }
      scope.headText = function () {
        if (scope.st.mode === 'stage') return 'MID-STAGE: time is added to the stage'
        if (scope.st.mode === 'bivouac' && scope.st.bivouac) return 'BIVOUAC: used ' + hm(scope.st.bivouac.usedMin) + ' of ' + hm(scope.st.bivouac.budgetMin)
        return scope.st.retired ? 'RETIRED from the rally' : 'NO REPAIRS HERE'
      }
      scope.itemsText = function (o) {
        return (o.items || []).filter(function (i) { return i.what !== 'service' }).slice(0, 4)
          .map(function (i) { return i.what + ' ' + Math.round(i.minutes) }).join(', ')
      }
      function chosen() { return (scope.st.options || []).filter(function (o) { return o.enabled && scope.sel.ids[o.id] }) }
      scope.chosen = chosen
      scope.total = function () { return chosen().reduce(function (a, o) { return a + (o.minutes || 0) }, 0) }
      scope.totalText = function () {
        var c = chosen()
        if (!c.length) return 'pick repairs'
        var pen = c.reduce(function (a, o) { return a + (o.penaltyS || 0) }, 0)
        if (scope.st.mode === 'stage') return '+' + scope.total() + ' min stage time'
        return scope.total() + ' min bivouac' + (pen ? ', +' + hm(pen / 60) + ' penalty' : '')
      }
      scope.warnText = function () {
        var c = chosen()
        if (scope.st.mode === 'stage') {
          var w = c.filter(function (o) { return o.spare }).length
          var left = (scope.st.spares.max || 0) - (scope.st.spares.used || 0)
          if (w > left) return 'only ' + left + ' spare wheel(s) left'
        }
        if (scope.st.mode === 'bivouac' && scope.st.bivouac && c.length) {
          var over = scope.st.bivouac.usedMin + scope.total() - scope.st.bivouac.budgetMin
          if (over > scope.st.bivouac.retireOverMin) return 'over budget by ' + over + ' min: RETIRED when you leave'
          if (over > 0) return 'over budget by ' + over + ' min: +' + over + ' min penalty'
        }
        return ''
      }
      scope.canConfirm = function () { return chosen().length > 0 && !scope.st.busy && scope.st.stopped && !scope.warnText().match(/spare/) }
      scope.pick = function (o) {
        if (!o.enabled) return
        scope.sel.ids[o.id] = !scope.sel.ids[o.id]
      }
      scope.cmd = function (name, arg) { lua(cmdCode(name, arg)) }
      // the bar / its button: opens or closes at once here, and tells Lua (which sends the options back)
      scope.toggle = function () {
        var open = !scope.st.open
        scope.st.open = open
        rlog('bar ' + (open ? 'OPEN' : 'CLOSE') + ' pressed (mode ' + scope.st.mode + ')')
        scope.cmd(open ? 'repairOpen' : 'repairClose')
      }
      scope.hintText = function () {
        var m = scope.st.mode
        if (m === 'stage') return 'Stage running: stop the car, then ' + modeBtn() + ' for wheels, suspension and radiator (time is added to the stage). RECOVER CAR is in the menu too.'
        if (m === 'bivouac') return 'Bivouac open: ' + modeBtn() + ' for the whole-car repair and the engine change (from the bivouac time).'
        if (scope.st.retired) return 'Retired from the rally: no repairs.'
        return 'No repairs now. They open in a running stage (car stopped) and at the bivouac after a stage. ' + modeBtn() + ' shows the menu.'
      }
      function modeBtn() { return scope.modeText() }
      // the player's keys (only actions that have one): kt -> 'text (key)'; keyText -> ' (key)' or ''
      scope.keys = {}
      scope.kt = function (action, text) { var k = scope.keys[action]; return k ? text + ' (' + k + ')' : text }
      scope.keyText = function (action, sep) { var k = scope.keys[action]; return k ? (sep || ' (') + k + (sep ? '' : ')') : '' }
      scope.$on('RallyRaidKeys', function (event, data) { scope.$evalAsync(function () { scope.keys = (data && data.keys) || {} }) })
      scope.cmd('keys')
      scope.close = function () { scope.cmd('repairClose') }
      scope.confirm = function () {
        if (!scope.canConfirm()) return
        scope.cmd('repairConfirm', chosen().map(function (o) { return o.id }).join(','))
        scope.sel.ids = {}
      }
      // RECOVER CAR
      scope.rs = {}
      scope.round = function (x) { return Math.round(x || 0) }
      scope.rsShown = function () { var r = scope.rs; return !!(r.ask || r.busy || r.msg) }
      scope.rsTitle = function () {
        var r = scope.rs
        if (r.busy) return 'RECOVER CAR: MOVING THE CAR...'
        if (r.ask) return r.ask.allowed ? 'RECOVER CAR?' : 'NO CAR RECOVERY'
        return 'RECOVER CAR'
      }
      scope.damageText = function () {
        var sn = scope.rs.ask && scope.rs.ask.snapshot
        if (!sn) return 'Damage: kept as it is now (no saved state yet).'
        var a = Math.round(sn.ageS || 0)
        return 'Damage: as it was ' + Math.floor(a / 60) + ':' + ('0' + a % 60).slice(-2) + ' ago (saved every 30 s), not a free repair.'
      }
      scope.resumeAsk = function () { scope.cmd('recoverAsk') }
      scope.resumeConfirm = function () { scope.cmd('recoverConfirm') }
      scope.resumeCancel = function () { scope.cmd('recoverCancel') }
      scope.resumeRetire = function () { scope.cmd('recoverRetire') }
      scope.$on('RallyRaidRecover', function (event, data) {
        scope.$evalAsync(function () { scope.rs = data || {} })
      })
      // GAME-CRASH RESUME
      scope.gr = {}
      scope.hms = hms
      scope.ago = ago
      scope.grShown = function () { var g = scope.gr; return !!(g.offer || g.busy || g.hold || g.msg) }
      scope.grTitle = function () {
        var g = scope.gr
        if (g.busy) return 'RESUMING THE SAVED STAGE...'
        if (g.offer) return g.offer.policy && g.offer.policy.refused ? 'SAVED STAGE: NO RESUME' : 'SAVED STAGE FOUND (GAME CRASH)'
        if (g.hold) return 'RESUMED: FLAGGED FOR REVIEW'
        return 'SAVED STAGE'
      }
      scope.savedText = function () {
        var o = scope.gr.offer, s = o && o.summary
        if (!s) return ''
        var t = 'Saved: ' + (s.validated || 0) + ' waypoint(s) passed'
        if (s.missed) t += ', ' + s.missed + ' missed'
        t += ', penalties +' + hm((s.penaltyTotal || 0) / 60) + ', spares used ' + (s.sparesUsed || 0) + ', recoveries ' + (s.recoveries || 0) + '.'
        t += o.hasDamage ? ' The car comes back with its saved damage.' : ' No damage was saved: the car comes back new.'
        return t
      }
      scope.policyText = function () {
        var p = scope.gr.offer && scope.gr.offer.policy
        if (!p) return ''
        var pen = p.penaltyS > 0 ? 'Penalty +' + Math.round(p.penaltyS / 60) + ' min.' : 'No time penalty.'
        return pen + ' The resume is flagged for organizer review (when it was saved, the gap, saved vs resumed state).'
      }
      scope.flagText = function () {
        var f = scope.gr.flagged
        if (!f) return ''
        var t = 'Flagged for review: ' + ago(f.wallGapS) + ' between save and resume'
        if (f.stageTimeLostS > 0) t += ', about ' + hms(f.stageTimeLostS) + ' of stage time lost'
        return t + (f.count > 1 ? ' (' + f.count + ' resumes on this stage).' : '.')
      }
      scope.$on('RallyRaidGameResume', function (event, data) {
        scope.$evalAsync(function () {
          data = data || {}
          if (data.offer) { data.offer.policy = data.offer.policy || {}; data.offer.summary = data.offer.summary || {} }
          scope.gr = data
        })
      })
      scope.$on('RallyRaidRepair', function (event, data) {
        scope.$evalAsync(function () {
          if (!data) return
          if (data.mode !== scope.st.mode || !data.open) scope.sel.ids = {}
          data.options = Array.isArray(data.options) ? data.options : (data.options ? Object.values(data.options) : [])
          data.options.forEach(function (o) {
            o.items = Array.isArray(o.items) ? o.items : (o.items ? Object.values(o.items) : [])
            o.engineFlags = Array.isArray(o.engineFlags) ? o.engineFlags : (o.engineFlags ? Object.values(o.engineFlags) : [])
          })
          data.resumes = data.resumes || {}; data.spares = data.spares || {}
          scope.st = data
        })
      })
      function fit () {
        var el = element[0]
        if (!el) return
        var k = Math.min(el.clientWidth / W, el.clientHeight / H)
        if (isFinite(k) && k > 0 && Math.abs(k - scope.k) > 0.005) scope.$evalAsync(function () { scope.k = k })
      }
      var fitTimer = setInterval(fit, 500)
      fit()
      rlog('app init (Repair)')
      hello(true)
      var helloTimer = setInterval(function () { hello(true) }, 3000)
      scope.cmd('repairAppHere')
      scope.$on('$destroy', function () { clearInterval(fitTimer); clearInterval(helloTimer); hello(false) })
    }
  }
}]);
