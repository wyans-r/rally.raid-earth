// TEST ONLY (18 Nov, three HUD apps): the former Repair / Rally apps and the Roadbook RECCE panel are panels inside the
// GPS / Planner apps now (window.RallyRaidPanels.*, defined in their app.js). This shim shows one panel on its own, as a
// directive, so the panel previews and tests can keep looking at it the way they did. Not in the mod zip.
(function () {
  var P = window.RallyRaidPanels || {}
  var m = angular.module('beamng.apps')
  function panel(name) { return function () { var d = P[name]; return { restrict: 'E', template: d.template, replace: true, scope: {}, link: d.link } } }
  if (P.repair) m.directive('rallyRaidRepair', [panel('repair')])
  if (P.rally) m.directive('rallyRaidRally', [panel('rally')])
  if (P.recce) m.directive('rallyRaidRecce', [panel('recce')])
})()
