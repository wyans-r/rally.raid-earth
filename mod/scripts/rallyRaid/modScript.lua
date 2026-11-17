-- Rally Raid for BeamNG.Earth: run by the game's mod manager when the mod is mounted.
-- 'manual' keeps the extension loaded across level changes; the mod manager loads every 'manual' extension right after
-- the modScripts (the same pattern BeamNG.Earth's own modScript uses).
setExtensionUnloadMode('rallyRaid_core', 'manual')
