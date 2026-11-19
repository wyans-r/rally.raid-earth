// rally.raid Earth GPS: the HUD app for lua/ge/extensions/rallyRaid/core.lua (rallyRaid_core).
// Lua -> app: guihooks 'RallyRaidUpdate' (about 10 a second) with the computer and stage state.
// App -> Lua: bngApi.engineLua('rallyRaid_core.cmd(...)'): messages are the only link between the two.
// REPAIR and RALLY panels: see window.RallyRaidPanels below.
// MENU (Wyans 2026-11-17: "rely on hud buttons"): the actions that lost their default key are buttons here, calling the
// same Lua as the old keys did: REPAIR -> the REPAIR panel ('repairOpen'), RALLY -> the RALLY panel, RECOVER CAR -> 'recoverKey' (first press asks, the second
// within 15 s confirms; CANCEL -> 'recoverCancel'), crash RESUME / GO -> 'gameResumeKey' (first press shows the save,
// the second resumes; GO while the clock is held), PLANNER -> 'plannerOpen' (the Planner app, which also has the recce controls). It listens to 'RallyRaidRecover' and
// 'RallyRaidGameResume' for those states and to 'RallyRaidKeys' for any key the player bound (shown on the buttons).
// The GPS app is the rally computer, with the REPAIR panel (ex Repair app) and the RALLY panel (ex Rally app,
// EXPERIMENTAL) built in (Wyans 2026-11-18: three HUD apps: GPS with repairs, Planner with recce, Roadbook). Each panel
// is the former app's template and code, compiled into the GPS app on its own isolated scope (no extra directive to
// register), so its Lua messages and commands are unchanged: 'RallyRaidRepair' / 'RallyRaidRally' in, repair* / rally* out.
window.RallyRaidPanels = window.RallyRaidPanels || {}
window.RallyRaidPanels.repair = (function () {
  var APP = 'gps'
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
    '<div class="rrr-host rrr-embedded">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidGPS/repair.css">' +
    '<div class="rrr">' +
      // the always-visible bar
      '<div class="rrr-bar" ng-click="toggle()">' +
        '<button class="rrr-btn rrr-open" ng-click="toggle(); $event.stopPropagation()">{{ st.open ? \'CLOSE\' : modeText() }}</button>' +
        '<span ng-show="st.mode === \'stage\'">SPARES {{ st.spares.max - st.spares.used }}/{{ st.spares.max }}</span>' +
        '<span ng-show="st.mode === \'bivouac\' && st.bivouac" ng-class="{\'rrr-pen\': st.bivouac.overMin > 0}">LEFT {{ hm(st.bivouac.leftMin) }}</span>' +
        '<span ng-class="{\'rrr-pen\': st.resumes.max && st.resumes.rally >= st.resumes.max}" title="car recoveries and resets used in the rally (no limit; each one is a time penalty)">RESETS {{ st.resumes.rally || 0 }}<span ng-show="st.resumes.max">/{{ st.resumes.max }}</span><span ng-show="st.resumes.penaltyS"> +{{ st.resumes.penaltyS / 60 | number:0 }} MIN</span></span>' +
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
          '<div class="rrr-rline" ng-show="rs.ask.max">Recoveries / resets: {{ rs.ask.used }} of {{ rs.ask.max }} used, <b>{{ rs.ask.leftAfter }} left</b> after this. This stage: {{ rs.ask.stageUsed }} of {{ rs.ask.stageMax }}.</div>' +
          '<div class="rrr-rline" ng-show="!rs.ask.max">Recoveries / resets so far: {{ rs.ask.used || 0 }} in the rally (+{{ (rs.ask.penaltySoFarS || 0) / 60 | number:0 }} min), {{ rs.ask.stageUsed || 0 }} on this stage. No limit: each one costs its penalty.</div>' +
          '<div class="rrr-rline">Back on the route {{ round(rs.ask.target.backM) }} m behind where you got stuck, at km {{ rs.ask.target.km.toFixed(2) }}, facing along the route.</div>' +
          '<div class="rrr-rline">{{ damageText() }}</div>' +
          '<div class="rrr-rline dim">The clock stops while the car is moved. A second one on this stage retires it. Confirm here, or press RECOVER in the GPS MENU{{ keyText(\'rallyRaid_recoverCar\', \' / \') }} again.</div>' +
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
        '<details class="rr-credits"><summary>Credits</summary><p>Map data © OpenStreetMap contributors (ODbL). Land cover: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). Elevation: Mapterhorn (open DEMs, including Copernicus GLO-30) and Mapzen/Tilezen Terrarium tiles. Routing: OSRM. Map queries: public Overpass mirrors including NextGIS. Place names: Nominatim. Built for BeamNG.Earth. Not an official BeamNG or FIM/FIA product. Full credits: https://rrearth.wyans.net and the project README.</p></details>' +
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
      // the GPS app's REPAIR panel (its own close button)
      scope.$on('rrRepairClose', function () { if (scope.st.open) { scope.st.open = false; scope.cmd('repairClose') } })
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
      rlog('repair panel ready (in the GPS app)')
      scope.cmd('repairAppHere')
    }
  }
})()
window.RallyRaidPanels.rally = (function () {
  var APP = 'gps'
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
  function hms(s) { var neg = s < 0; s = Math.abs(Math.round(s || 0)); return (neg ? '-' : '') + Math.floor(s / 3600) + ':' + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2) }
  function hm(min) { min = Math.max(0, Math.round(min || 0)); return Math.floor(min / 60) + ':' + ('0' + min % 60).slice(-2) }
  function arr(x) { return Array.isArray(x) ? x : (x ? Object.keys(x).sort(function (a, b) { return a - b }).map(function (k) { return x[k] }) : []) }
  return {
    template:
    '<div class="rrl-host rrl-embedded">' +
    '<link type="text/css" rel="stylesheet" href="/ui/modules/apps/RallyRaidGPS/rally.css">' +
    '<div class="rrl">' +
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
              '<div class="cl" ng-show="st.bivouac && st.bivouac.open">BIVOUAC: {{ hm(st.bivouac.leftMin) }} of {{ hm(st.bivouac.budgetMin) }} left (MENU &gt; REPAIR)</div>' +
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
      scope.cmd = function (name, arg) { scope.askRestart = false; lua(cmdCode(name, arg)) }
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
      rlog('rally panel ready (in the GPS app, EXPERIMENTAL)')
      scope.cmd('rallyAppHere')
    }
  }
})()
angular.module('beamng.apps')
.directive('rallyRaidGps', ['$compile', function ($compile) {
  var W = 380, H = 340
  function pad3(x) { var s = Math.abs(x).toFixed(2); while (s.length < 6) s = '0' + s; return (x < -0.004 ? '-' : '') + s }
  function deg(x) { if (x === null || x === undefined || !isFinite(x)) return '---'; var d = Math.round(x) % 360; return ('00' + d).slice(-3) }
  function clock(s) {
    if (!isFinite(s) || s === null) return '-:--:--'
    s = Math.max(0, Math.floor(s))
    return Math.floor(s / 3600) + ':' + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2)
  }
  function dist(m) { if (!isFinite(m)) return ''; return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m' }
  var APP = 'gps'
  function lua(cmd) { if (window.bngApi) bngApi.engineLua(cmd) }
  // a Lua string literal (quotes, backslashes and line breaks escaped)
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'" }
  // a line in the game's console (~), "[rally.raid Earth] UI gps: ...": app init, local buttons, errors. If the mod's Lua
  // (rallyRaid_core) is not loaded, the line says so (the cause is then a Lua error higher up in the console)
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
      // rally mode: the liaison being driven (the RALLY panel has the rest)
      '<div class="rrg-row rrg-sub rrg-liaison" ng-show="rlz && !ov">LIAISON {{ rlz.target }}: {{ rlz.distKm }} km &middot; CAP {{ rlz.bearing }}&deg; &middot; <span ng-class="{\'rrg-pen\': rlz.leftS < 0}">LEFT {{ clk(rlz.leftS) }}</span>' +
        '<button class="rrg-btn small" ng-click="openPanel(\'rally\')">RALLY</button></div>' +
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
        '<button class="rrg-btn" ng-click="openStages()">STAGES</button>' +
        '<button class="rrg-btn rrg-menubtn" ng-class="{go: gr.offer || gr.hold, warn: rsArmed()}" ng-click="openMenu()" title="repair, recover car, crash resume, rally, planner">{{ menuText() }}</button></span></div>' +
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
      // MENU: the buttons for the actions without a default key
      '<div class="rrg-overlay rrg-menu" ng-show="menu">' +
        '<div class="rrg-row" style="justify-content:space-between"><span class="rrg-label">RALLY MENU</span>' +
          '<button class="rrg-btn small" ng-click="menu = false">&#10005;</button></div>' +
        // crash resume (only when a save is offered, or the clock is held after a resume)
        '<div class="rrg-mrow hot" ng-show="gr.offer && !gr.busy"><div class="rrg-mtext"><b>SAVED STAGE</b> {{ gr.offer.text }}' +
            '<span ng-show="gr.offer.policy.refused" class="rrg-pen"><br>{{ gr.offer.policy.reason }}</span></div>' +
          '<button class="rrg-btn go" ng-class="{warn: gr.offer.policy.refused}" ng-click="cmd(\'gameResumeKey\')" title="{{ kt(\'rallyRaid_gameResume\', \'press twice: show the save, then resume it\') }}">{{ resumeText() }}</button></div>' +
        '<div class="rrg-mrow hot" ng-show="gr.hold && !gr.busy"><div class="rrg-mtext"><b>CLOCK HELD</b> at the saved time until you drive off.</div>' +
          '<button class="rrg-btn go" ng-click="cmd(\'gameResumeKey\')" title="{{ kt(\'rallyRaid_gameResume\', \'start the clock now\') }}">GO</button></div>' +
        '<div class="rrg-mrow" ng-show="gr.busy"><div class="rrg-mtext">Putting the car back where it was saved...</div></div>' +
        // recover car
        '<div class="rrg-mrow"><div class="rrg-mtext">{{ rsText() }}</div>' +
          '<button class="rrg-btn small" ng-show="rsArmed()" ng-click="cmd(\'recoverCancel\')">CANCEL</button>' +
          '<button class="rrg-btn warn" ng-click="cmd(\'recoverKey\')" ng-disabled="s.phase !== \'running\' || rs.enabled === false || rs.busy" title="{{ kt(\'rallyRaid_recoverCar\', \'press twice: see the penalty, then confirm\') }}">{{ rsArmed() ? \'CONFIRM\' : \'RECOVER\' }}</button></div>' +
        // crash saves on disk with no stage offering one: LOAD that stage (its RESUME offer follows)
        '<div class="rrg-mrow hot" ng-repeat="p in gr.pending track by $index" ng-show="!gr.offer && !gr.busy"><div class="rrg-mtext"><b>CRASH SAVE</b> {{ p.stageName || p.stageId }}: {{ p.elapsed }} driven, saved {{ p.ago }} ago' +
            '<span ng-show="p.loaded" class="rrg-pen"><br>loaded, but the save does not match this stage file (see the console, ~)</span></div>' +
          '<button class="rrg-btn go" ng-click="loadSaved(p)" ng-disabled="!p.stagePath || p.loaded" title="load this stage: RESUME is offered next">LOAD</button></div>' +
        '<div class="rrg-mrow"><div class="rrg-mtext">Repairs, spares, bivouac time <small>{{ rpLine() }}</small></div>' +
          '<button class="rrg-btn" ng-click="openPanel(\'repair\')" title="{{ kt(\'rallyRaid_repairMenu\', \'open the repair panel\') }}">REPAIR</button></div>' +
        '<div class="rrg-mrow" ng-show="rlAvail"><div class="rrg-mtext">Rally mode <small class="rrg-pen">EXPERIMENTAL</small> <small>{{ rlName }}</small></div>' +
          '<button class="rrg-btn" ng-click="openPanel(\'rally\')" title="multi-day rallies: liaisons, bivouacs, cumulative time">RALLY</button></div>' +
        '<div class="rrg-mrow"><div class="rrg-mtext">Stage &amp; roadbook planner <small ng-hide="appOn(\'planner\')">(Planner app not on screen)</small></div>' +
          '<button class="rrg-btn" ng-click="openApp(\'planner\')" title="{{ kt(\'rallyRaid_plannerMenu\', \'open the planner in the Planner app\') }}">PLANNER</button></div>' +
        '<div class="rrg-mrow hot" ng-show="note"><div class="rrg-mtext">{{ note }}</div>' +
          '<button class="rrg-btn small" ng-click="note = \'\'">OK</button></div>' +
        '<div class="rrg-mrow"><div class="rrg-mtext">App layout (adds the apps)</div><span>' +
          '<button class="rrg-btn small" ng-click="layout(\'Rally\')" title="GPS and Roadbook">RALLY LAYOUT</button>' +
          '<button class="rrg-btn small" ng-click="layout(\'Planner\')" title="GPS, Roadbook and Planner (with recce)">PLANNER LAYOUT</button>' +
          '<button class="rrg-btn small" ng-click="layout(\'Back\')" title="the layout you had before">MY LAYOUT</button></span></div>' +
        '<div class="rrg-msg" style="margin-top:auto" ng-show="keys.rallyRaid_tripPlus || keys.rallyRaid_boxSync">Driving keys: trip {{ keys.rallyRaid_tripPlus || \'-\' }} / {{ keys.rallyRaid_tripMinus || \'-\' }}, W {{ keys.rallyRaid_wPlus || \'-\' }} / {{ keys.rallyRaid_wMinus || \'-\' }}, box {{ keys.rallyRaid_boxPrev || \'-\' }} / {{ keys.rallyRaid_boxNext || \'-\' }}, sync {{ keys.rallyRaid_boxSync || \'-\' }}</div>' +
      '</div>' +
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
        '<details class="rr-credits"><summary>Credits</summary><p>Map data © OpenStreetMap contributors (ODbL). Land cover: © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). Elevation: Mapterhorn (open DEMs, including Copernicus GLO-30) and Mapzen/Tilezen Terrarium tiles. Routing: OSRM. Map queries: public Overpass mirrors including NextGIS. Place names: Nominatim. Built for BeamNG.Earth. Not an official BeamNG or FIM/FIA product. Full credits: https://rrearth.wyans.net and the project README.</p></details></div>' +
      // REPAIR panel (the former Repair app) and RALLY panel (the former Rally app): mounted in link()
      '<div class="rrg-overlay rrg-panel" ng-show="ov === \'repair\' || rpOpen">' +
        '<div class="rrg-row rrg-phead"><span class="rrg-label">REPAIR</span><button class="rrg-btn small" ng-click="closePanel(\'repair\')">&#10005;</button></div>' +
        '<div class="rrg-phost rrg-phost-repair"></div></div>' +
      '<div class="rrg-overlay rrg-panel" ng-show="ov === \'rally\'">' +
        '<div class="rrg-row rrg-phead"><span class="rrg-label">RALLY <small class="rrg-pen">EXPERIMENTAL</small></span><button class="rrg-btn small" ng-click="closePanel(\'rally\')">&#10005;</button></div>' +
        '<div class="rrg-phost rrg-phost-rally"></div></div>' +
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
      scope.cmd = function (name, arg) { lua(cmdCode(name, arg)) }
      // which rally.raid Earth apps are on screen (Lua hears each app's hello: s.apps); unknown (older Lua) = assume yes
      scope.appOn = function (name) { var a = scope.s && scope.s.apps; return !a || a[name] !== false }
      var TITLES = { planner: 'rally.raid Earth Planner' }
      scope.note = ''
      // REPAIR / PLANNER: open that app's menu; BeamNG has no call to add an app to the screen, so without the app the
      // menu says how (ESC > UI Apps > Add app, or one of the mod's layouts) and the menu opens once the app is there
      scope.openApp = function (name) {
        var on = scope.appOn(name)
        rlog('MENU ' + name.toUpperCase() + ' pressed (' + TITLES[name] + ' app ' + (on ? 'on screen' : 'NOT on screen') + ')')
        scope.cmd(name + 'Open')
        if (on) { scope.menu = false; scope.note = '' }
        else scope.note = 'The ' + TITLES[name] + ' app is not on your screen. Add it with ESC > UI Apps > Add app > ' + TITLES[name] +
          ', or press PLANNER LAYOUT below. Its menu is already open for when it shows.'
      }
      scope.layout = function (which) { rlog('MENU layout ' + which); scope.cmd('apps' + which); scope.note = '' }
      scope.loadSaved = function (p) { rlog('MENU crash save LOAD ' + p.stagePath); scope.cmd('load', p.stagePath) }
      // MENU state: recover car (RallyRaidRecover), crash resume (RallyRaidGameResume), the player's keys (RallyRaidKeys)
      var CONFIRM_MS = 15000            // repairConfig confirmS: a second press within this confirms
      scope.menu = false; scope.rs = {}; scope.gr = {}; scope.keys = {}
      var rsAskAt = 0, grArmAt = 0
      scope.openMenu = function () { scope.menu = !scope.menu; rlog('MENU ' + (scope.menu ? 'opened' : 'closed')); if (scope.menu) { scope.picker = false; scope.note = ''; scope.cmd('recoverState'); scope.cmd('gameResumeState') } }
      scope.kt = function (action, text) { var k = scope.keys[action]; return k ? text + ' (' + k + ')' : text }
      scope.rsArmed = function () { var a = scope.rs.ask; return !!(a && a.allowed && !scope.rs.busy && Date.now() - rsAskAt < CONFIRM_MS) }
      scope.rsText = function () {
        var r = scope.rs, a = r.ask
        if (r.enabled === false) return 'Recover car: switched off for this event'
        if (r.busy) return 'Recover car: moving the car...'
        if (a && !a.allowed && Date.now() - rsAskAt < CONFIRM_MS) return 'No recovery: ' + (a.reason || '')
        if (scope.rsArmed()) return 'RECOVER CAR? +' + Math.round((a.penaltyS || 0) / 60) + ' min, ' + (a.max ? a.leftAfter + ' of ' + a.max + ' left after it' : 'recovery ' + ((a.used || 0) + 1) + ' (no limit)') + ', back ' + Math.round((a.target && a.target.backM) || 0) + ' m on the route'
        return s_running() ? 'Stuck or rolled? Recover car (+15 / 30 min)' : 'Recover car (in a running stage)'
      }
      function s_running() { return scope.s.phase === 'running' }
      scope.resumeText = function () {
        var o = scope.gr.offer
        if (o && o.policy && o.policy.refused) return o.policy.retire ? (scope.gr.keyArmed && Date.now() - grArmAt < CONFIRM_MS ? 'CONFIRM RETIRE' : 'RETIRE') : 'NO RESUME'
        return scope.gr.keyArmed && Date.now() - grArmAt < CONFIRM_MS ? 'CONFIRM RESUME' : 'RESUME'
      }
      scope.menuText = function () { return scope.gr.offer ? 'RESUME?' : (scope.gr.hold ? 'GO?' : 'MENU') }
      scope.$on('RallyRaidRecover', function (event, data) { scope.$evalAsync(function () {
        var d = data || {}
        if (d.ask && !scope.rs.ask) rsAskAt = Date.now()
        scope.rs = d
      }) })
      scope.$on('RallyRaidGameResume', function (event, data) { scope.$evalAsync(function () {
        var d = data || {}
        if (d.keyArmed && !scope.gr.keyArmed) grArmAt = Date.now()
        d.pending = Array.isArray(d.pending) ? d.pending : (d.pending ? Object.values(d.pending) : [])
        if (d.offer && !scope.gr.offer) rlog('crash save offered: ' + (d.offer.text || ''))
        scope.gr = d
        if ((d.offer || d.hold) && !scope.gr_seen) { scope.gr_seen = true; scope.menu = true }   // a save to resume: show it
        if (!d.offer && !d.hold) scope.gr_seen = false
      }) })
      scope.$on('RallyRaidKeys', function (event, data) { scope.$evalAsync(function () { scope.keys = (data && data.keys) || {} }) })
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
      // the REPAIR and RALLY panels: each on its own isolated scope (a child of this one), compiled into its host
      scope.ov = ''
      var panelScopes = {}
      function mount(name) {
        var def = window.RallyRaidPanels[name], host = element[0].querySelector('.rrg-phost-' + name)
        if (!def || !host) return
        var cs = scope.$new(true)
        var el = angular.element(def.template)
        host.appendChild(el[0])
        def.link(cs, el)
        $compile(el)(cs)
        panelScopes[name] = cs
      }
      scope.openPanel = function (name) {
        rlog('MENU ' + name.toUpperCase() + ' pressed')
        scope.menu = false; scope.picker = false; scope.note = ''
        scope.ov = name
        if (name === 'repair') scope.cmd('repairOpen')
        if (name === 'rally') scope.cmd('rallyList')
      }
      scope.closePanel = function (name) {
        rlog(name.toUpperCase() + ' panel closed')
        if (name === 'repair' && panelScopes.repair) panelScopes.repair.$broadcast('rrRepairClose')
        if (name === 'repair' && scope.rpOpen) { scope.rpOpen = false; scope.cmd('repairClose') }
        scope.ov = ''
      }
      scope.rp = {}; scope.rpOpen = false
      scope.rpLine = function () {
        var r = scope.rp, t = []
        if (r.mode === 'stage' && r.spares) t.push('spares ' + (r.spares.max - r.spares.used) + '/' + r.spares.max)
        if (r.mode === 'bivouac' && r.bivouac) t.push('bivouac ' + Math.floor((r.bivouac.leftMin || 0) / 60) + ':' + ('0' + Math.round(r.bivouac.leftMin || 0) % 60).slice(-2) + ' left')
        if (r.resumes) t.push('resets ' + (r.resumes.rally || 0) + (r.resumes.max ? '/' + r.resumes.max : '') + (r.resumes.penaltyS ? ' +' + Math.round(r.resumes.penaltyS / 60) + ' min' : ''))
        return t.length ? '(' + t.join(', ') + ')' : ''
      }
      scope.$on('RallyRaidRepair', function (event, data) { if (data) scope.$evalAsync(function () {
        if (data.open && !scope.rpOpen) { scope.menu = false; scope.picker = false }   // opened from Lua (a bound key): show it
        if (!data.open && scope.rpOpen && scope.ov === 'repair') scope.ov = ''        // CLOSE / REPAIR done in the panel: back to the GPS
        scope.rp = data; scope.rpOpen = !!data.open
      }) })
      scope.rlAvail = false; scope.rlz = null; scope.rlName = ''
      scope.$on('RallyRaidRally', function (event, data) { if (data) scope.$evalAsync(function () {
        scope.rlAvail = data.available !== false
        scope.rlz = data.liaison || null
        scope.rlName = data.rally ? data.rally.name : ''
      }) })
      mount('repair'); mount('rally')
      // hello: the app is on screen (again every 3 s: Lua may have been reloaded, or loaded after this app)
      function hello(on) { lua('if rallyRaid_core and rallyRaid_core.appHello then rallyRaid_core.appHello(' + q(APP) + ', ' + (on ? 'true' : 'false') + ') end') }
      rlog('app init (GPS ' + (window.angular && angular.version ? 'angular ' + angular.version.full : '') + ')')
      hello(true)
      var helloTimer = setInterval(function () { hello(true) }, 3000)
      scope.cmd('hello')
      scope.$on('$destroy', function () { clearInterval(fitTimer); clearInterval(helloTimer); hello(false); lua('if rallyRaid_core then rallyRaid_core.tripHold(0) end') })
    }
  }
}]);
