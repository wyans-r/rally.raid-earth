-- Recce for fixing an existing roadbook while driving it (17 Nov batch), game side, through rallyRaid_core.cmd as the
-- Roadbook app sends it: select any box, km from the trip meter (+ / - 10 m), CAP from the car, note presets, the
-- changes list with undo of any one, the merge preview, the report file. tests/browser/bridge_test.js clicks the same.
local fails, passes = 0, 0
local function check(cond, msg) if cond then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. msg) end end
local function has(list, pat) for _, l in ipairs(list) do if tostring(l):find(pat) then return true end end return false end

READ_MOD_TEXT = function(p) return READ_TEXT('mod' .. p) end
LIST_ANY = function(dir, pattern)
  local out, lst = {}, LIST_FILES(dir)
  for i = 1, #lst do out[#out + 1] = lst[i] end
  local rx = '^' .. pattern:gsub('%.', '%%.'):gsub('%*', '.*') .. '$'
  local res = {}
  for _, f in ipairs(out) do if f:match('[^/]*$'):match(rx) then res[#res + 1] = f end end
  return res
end
for k in pairs(package.loaded) do if k:find('^rallyRaid/') then package.loaded[k] = nil end end
os.execute('rm -rf "' .. TMP_DIR .. '/rallyraid/recce" "' .. TMP_DIR .. '/rallyraid/roadbooks"')
dofile(MOD_ROOT .. '/../tests/bridge/env.lua')
local core = rallyRaid_core
local recce = require('rallyRaid/recce')
local function tick(n) for i = 1, (n or 3) do core.onUpdate(0.1, 0.1) end end
local function rs() return core.roadbookState().recce end
local function readTmp(p) local f = io.open(TMP_DIR .. p, 'rb'); if not f then return nil end local t = f:read('*a'); f:close(); return t end

core.cmd('load', '/rallyraid/stages/moab-sand-flats-ss1.json', 'test')
local S = core._debug()
check(S and #S.stage.roadbook.boxes > 5, 'stage + roadbook loaded: ' .. tostring(S and #S.stage.roadbook.boxes))
local boxes = S.stage.roadbook.boxes
local rbPath = S.stage.roadbook.source and S.stage.roadbook.source.path
local rbBefore = rbPath and readTmp(rbPath)
check(rbPath and rbBefore == nil, 'the roadbook file is the mod one (nothing in the user folder yet)')
-- the car at box 3
CAR.lat, CAR.lon, CAR.heading = boxes[3].lat, boxes[3].lon, 90
core.cmd('recce', nil, 'roadbook'); tick(5)
check(recce.active(), 'recce on')
local st = rs()
check(st.target and st.target.how == 'nearest' and st.target.n == 3, 'target: the nearest box (3) when nothing is selected: ' .. tostring(st.target and st.target.n))
check(st.presets and #st.presets >= 10, 'note presets in the state')

-- 2) select any box
core.cmd('recceSel', 'next', 'roadbook'); tick(1)
check(rs().target.how == 'selected' and rs().target.n == 4, '> selects the box after (4)')
check(core.roadbookState().viewIndex == 4, 'the roadbook display scrolls to the selected box')
core.cmd('recceSel', 'prev', 'roadbook'); core.cmd('recceSel', 'prev', 'roadbook'); tick(1)
check(rs().target.n == 2, '< < selects box 2 (far from the car is fine)')
core.cmd('tripSet', tostring(boxes[5].km + 0.05), 'gps'); tick(2)
core.cmd('recceSel', 'trip', 'roadbook'); tick(1)
check(rs().target.n == 5, 'AT TRIP selects the box the trip meter is in (5): ' .. tostring(rs().target.n))
check(has(LOGS, '%[rally%.raid Earth%] recce: box 5 selected %(trip'), 'selection logged')
core.cmd('recceSel', 'nearest', 'roadbook'); tick(1)
check(rs().target.how == 'nearest', 'NEAREST: back to the nearest box')

-- 3) km from the trip meter, nudges, the partials after it
core.cmd('recceSel', 'trip', 'roadbook')
local b5 = recce.target()
local id5, old5 = b5.id, b5.km
local tripKm = boxes[5].km + 0.05
core.cmd('recceKm', 'trip', 'roadbook'); tick(1)
check(math.abs(b5.km - tripKm) < 0.0015, string.format('KM = TRIP: box 5 %.3f -> %.3f', old5, b5.km))
local nx
for i, b in ipairs(boxes) do if b.id == id5 then nx = boxes[i + 1] end end
check(nx and math.abs(nx.partial - (nx.km - b5.km)) < 0.011, 'the partial of the next box follows')
core.cmd('recceKm', '+10', 'roadbook'); core.cmd('recceKm', '+10', 'roadbook'); core.cmd('recceKm', '-10', 'roadbook')
local ch = recce.get().doc.changes
check(#ch == 1 and ch[1].op == 'move' and ch[1].kmOnly and math.abs(ch[1].km - (tripKm + 0.01)) < 0.0015 and math.abs(ch[1].oldKm - old5) < 0.0015,
  'km edits of one box are one change (old km kept): ' .. #ch)
check(has(LOGS, 'recce: box %d+ km'), 'km edit logged')

-- CAP from the car
CAR.heading = 123.4; tick(2)
core.cmd('recceCap', nil, 'roadbook')
ch = recce.get().doc.changes
check(#ch == 2 and ch[2].op == 'update' and ch[2].fields.cap == 123 and ch[2].fields.capOut == 123 and b5.cap == 123, 'CAP HERE: CAP 123 on the selected box')

-- 4) note presets
core.cmd('recceDrop', nil, 'roadbook')
core.cmd('reccePick', { preset = 'ROUGH' }); core.cmd('reccePick', { preset = 'KEEP LEFT' }); core.cmd('reccePick', { preset = 'ROUGH' })
core.cmd('reccePick', { preset = 'track fades' })
check(rs().pending.notes == 'KEEP LEFT, TRACK FADES', 'presets toggle in the notes: ' .. tostring(rs().pending.notes))
core.cmd('reccePick', { danger = 2 })
core.cmd('recceSave', nil, 'roadbook')
ch = recce.get().doc.changes
local addId = ch[3] and ch[3].id
check(ch[3] and ch[3].op == 'add' and ch[3].box.notes == 'KEEP LEFT, TRACK FADES' and ch[3].box.danger == 2, 'the new box keeps the preset notes and danger')
-- a retag of the new box
core.cmd('recceRetag', addId, 'roadbook'); core.cmd('reccePick', { preset = 'SOFT SAND' }); core.cmd('recceSave', nil, 'roadbook')

-- 1) the changes list, undo any one
local list = rs().list
check(#list == 4 and list[1].i == 4 and list[1].kind == 'TAG' and list[4].kind == 'KM', 'list: newest first, kinds TAG ADD CAP KM: ' .. (function() local k = {} for _, x in ipairs(list) do k[#k + 1] = x.kind end return table.concat(k, ' ') end)())
check(list[4].text:find('KM') and list[2].text == 'KEEP LEFT, TRACK FADES' and list[3].text:find('CAP 123'), 'list texts: ' .. list[4].text .. ' | ' .. list[3].text)
core.cmd('recceUndoAt', 2, 'roadbook'); tick(1)      -- the CAP change
ch = recce.get().doc.changes
local b5now
for _, b in ipairs(S.stage.roadbook.boxes) do if b.id == id5 then b5now = b end end
check(#ch == 3 and b5now and b5now.cap ~= 123 and math.abs(b5now.km - (tripKm + 0.01)) < 0.0015, 'UNDO on the CAP row: CAP back, the km edit kept')
check(has(LOGS, 'recce undo: change 2 %(update'), 'undo logged')
core.cmd('recceUndoAt', 2, 'roadbook'); tick(1)      -- the added box: its retag goes with it
ch = recce.get().doc.changes
local still = false
for _, b in ipairs(S.stage.roadbook.boxes) do if b.id == addId then still = true end end
check(#ch == 1 and not still, 'UNDO on the ADD row: the box and its later retag are gone (' .. #ch .. ' left)')
check(has(NOTES, 'and 1 later change'), 'the notice says the retag went too')

-- merge preview: nothing is written
core.cmd('recceSel', 'next', 'roadbook'); core.cmd('recceConfirm', nil, 'roadbook')
core.cmd('reccePreview', nil, 'roadbook'); tick(1)
local pv = rs().preview
check(pv and pv.applied == 2 and pv.conflicts == 0 and pv.changes == 2, 'preview: 2 of 2 apply, 0 conflicts')
check(readTmp(rbPath) == nil, 'preview writes nothing')
check(has(LOGS, 'recce merge preview: 2 of 2 changes apply, 0 conflicts'), 'preview logged')
core.cmd('recceSel', 'prev', 'roadbook'); core.cmd('recceKm', '+10', 'roadbook')
check(rs().preview == nil, 'any new change clears the preview')
core.cmd('reccePreview', nil, 'roadbook'); core.cmd('reccePreviewCancel', nil, 'roadbook')
check(rs().preview == nil, 'CANCEL clears the preview')

-- 5) the report
NOTES = {}
core.cmd('recceReport', nil, 'roadbook'); tick(1)
local pj, pt = recce.reportPaths('moab-sand-flats-ss1')
local txt, js = readTmp(pt), readTmp(pj)
check(txt and txt:find('recce report') and txt:find('Changes not merged yet: 3') and txt:find('KM ') and txt:find('OK '), 'report .txt written: ' .. tostring(txt and txt:sub(1, 80)))
local rep = js and DECODE_JSON(js)
check(rep and rep.format == 'rallyraid-recce-report' and rep.changes == 3 and #rep.list == 3 and rep.counts.KM == 2, 'report .json written (3 changes, 2 KM)')
check(has(LOGS, 'recce report written: ' .. pt:gsub('%-', '%%-'):gsub('%.', '%%.')), 'report path logged')
check(has(NOTES, 'recce report saved: ' .. pt:gsub('%-', '%%-'):gsub('%.', '%%.')), 'report path shown to the player')
check(rs().report and rs().report.txt == pt, 'the Roadbook app gets the report path')

-- merge, then the list is empty; recce off writes the final report
core.cmd('recceMerge', '', 'roadbook'); tick(1)
check(readTmp(rbPath) ~= nil and #recce.get().doc.changes == 0 and #rs().list == 0, 'merge writes the roadbook (user folder) and empties the list')
check(has(LOGS, 'recce merged: rev'), 'merge logged')
local merged = DECODE_JSON(readTmp(rbPath))
local mb
for _, b in ipairs(merged.boxes) do if b.id == id5 then mb = b end end
check(mb and math.abs(mb.km - (tripKm + 0.02)) < 0.0015 and mb.verified, 'the merged roadbook has the new km for box 5 (trip + 10 m, + 10 m after the preview)')
os.remove(TMP_DIR .. pt)
NOTES = {}
core.cmd('recce', nil, 'roadbook')
check(not recce.active() and readTmp(pt) ~= nil and has(NOTES, 'Report: '), 'recce off writes the report and says where')

-- a recce resumed later: its old changes are marked "earlier"
core.cmd('load', '/rallyraid/stages/moab-sand-flats-ss1.json', 'test'); S = core._debug()
CAR.lat, CAR.lon = S.stage.roadbook.boxes[3].lat, S.stage.roadbook.boxes[3].lon
core.cmd('recce', nil, 'roadbook'); tick(3)
core.cmd('recceConfirm', nil, 'roadbook')
core.cmd('recce', nil, 'roadbook')
core.cmd('recce', nil, 'roadbook'); tick(2)
core.cmd('recceDelete', nil, 'roadbook')
list = rs().list
check(#list == 2 and list[2].earlier and not list[1].earlier, 'changes from an earlier recce of this stage are marked earlier')
core.cmd('recceSel', 'next', 'roadbook'); core.cmd('recceKm', '-10', 'roadbook')
check(#recce.get().doc.changes == 3, 'a km edit after a delete of another box is its own change')
core.cmd('recce', nil, 'roadbook')

print(string.format('recce1117_test: %d passed, %d failed', passes, fails))
return fails
