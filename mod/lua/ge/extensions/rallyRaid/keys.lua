-- rally.raid Earth: which key (if any) the player has on each rally.raid Earth action, as text for the HUD apps and
-- messages ("Ctrl+Shift+PgUp"). Only the driving keys have defaults (settings/inputmaps/keyboard_rallyRaid.json);
-- every other action is unbound by default and has a button in an app, but a player can still bind it in
-- Options > Controls, and then the apps show that key too.
--
-- Where the keys come from: BeamNG's input bindings (core_input_bindings.bindings: one entry per device, each with
-- contents.bindings = { {control = 'ctrl shift up', action = 'rallyRaid_tripPlus'}, ... }). That table is read
-- defensively; if it is missing or has none of our actions, the shipped defaults below are used instead.
local M = {}

-- the shipped defaults: must match settings/inputmaps/keyboard_rallyRaid.json (tests/keys_test checks this)
M.DEFAULTS = {
  rallyRaid_tripPlus = 'ctrl shift up', rallyRaid_tripMinus = 'ctrl shift down',
  rallyRaid_wPlus = 'ctrl shift right', rallyRaid_wMinus = 'ctrl shift left',
  rallyRaid_partialReset = 'ctrl shift p', rallyRaid_start = 'ctrl shift home',
  rallyRaid_boxPrev = 'ctrl shift pageup', rallyRaid_boxNext = 'ctrl shift pagedown', rallyRaid_boxSync = 'ctrl shift end',
}

local NAMES = { pageup = 'PgUp', pagedown = 'PgDn', delete = 'Del', backspace = 'Backspace', lbracket = '[', rbracket = ']',
  ctrl = 'Ctrl', lctrl = 'Ctrl', rctrl = 'Ctrl', shift = 'Shift', lshift = 'Shift', rshift = 'Shift', alt = 'Alt', lalt = 'Alt', ralt = 'Alt' }

-- 'ctrl shift pageup' -> 'Ctrl+Shift+PgUp'
function M.label(control)
  if type(control) ~= 'string' or control == '' then return nil end
  local out = {}
  for w in control:gmatch('%S+') do
    local lw = w:lower()
    out[#out + 1] = NAMES[lw] or (#lw == 1 and lw:upper()) or (lw:sub(1, 1):upper() .. lw:sub(2))
  end
  return table.concat(out, '+')
end

local cache, cacheAt = nil, nil
M.now = function () return os.clock() end

-- action -> control from the game's live bindings (keyboard devices first), or nil if that table can't be read
function M.fromGame()
  local b = rawget(_G, 'core_input_bindings')
  local devs = type(b) == 'table' and b.bindings
  if type(devs) ~= 'table' then return nil end
  local found, any = {}, false
  local function scan(keyboardOnly)
    for _, dev in pairs(devs) do
      local name = type(dev) == 'table' and tostring(dev.devname or dev.device or '') or ''
      local isKb = name:find('^keyboard') ~= nil
      if (keyboardOnly and isKb) or (not keyboardOnly and not isKb) then
        local list = type(dev) == 'table' and type(dev.contents) == 'table' and dev.contents.bindings
        if type(list) == 'table' then
          for _, e in pairs(list) do
            if type(e) == 'table' and type(e.action) == 'string' and e.action:sub(1, 10) == 'rallyRaid_' and type(e.control) == 'string' then
              any = true
              if not found[e.action] then found[e.action] = (isKb and '' or (name .. ': ')) .. e.control end
            end
          end
        end
      end
    end
  end
  scan(true); scan(false)
  if not any then return nil end   -- table not in the shape we expect (or no inputmap loaded): use the defaults
  return found
end

-- { action = 'Ctrl+Shift+Up', ... } for every action that has a key; cached for 2 s
function M.all(force)
  local t = M.now()
  if cache and not force and cacheAt and t - cacheAt < 2 then return cache end
  local ok, live = pcall(M.fromGame)
  local src = (ok and live) or M.DEFAULTS
  local out = {}
  for action, control in pairs(src) do
    local dev, ctl = control:match('^(.-): (.+)$')
    out[action] = dev and (dev .. ' ' .. (M.label(ctl) or ctl)) or M.label(control)
  end
  cache, cacheAt = out, t
  M.source = (ok and live) and 'game' or 'defaults'
  return out
end

-- the key on an action as text, or nil when it has none
function M.get(action) return M.all()[action] end
-- ' (Ctrl+Shift+End)' or '' : for the end of a message
function M.hint(action, fmt)
  local k = M.get(action)
  if not k then return '' end
  return string.format(fmt or ' (%s)', k)
end
function M.invalidate() cache, cacheAt = nil, nil end

return M
