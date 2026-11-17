"""The event pack the local Worker served (test/out/alice-ss1.rrevent.json, written by e2e.test.mjs) checked by the mod's
own Lua (official.check in LuaJIT): the game accepts the server's hashes, and refuses a pack whose roadbook was edited.
   /workspace/.luavenv/bin/python test/pack_in_lua.py"""
import json, sys
from lupa import luajit21 as L
lua = L.LuaRuntime(unpack_returned_tuples=True)
lua.execute("package.path='/workspace/rallyraid/mod/lua/ge/extensions/?.lua;'..package.path")
off = lua.eval("require('rallyRaid/official')")
pack = json.load(open('/workspace/rallyraid-events/test/out/alice-ss1.rrevent.json'))
def to_lua(o):
    if isinstance(o, dict): return lua.table_from({k: to_lua(v) for k, v in o.items()})
    if isinstance(o, list): return lua.table_from([to_lua(v) for v in o])
    return o
now = lua.eval("os.time()")
c = off.check(to_lua(pack), '0.2.0', now)
ok1 = c.ok
print('server pack accepted by the game:', ok1, [c.errors[i] for i in range(1, len(c.errors) + 1)])
pack['files']['roadbook']['text'] = pack['files']['roadbook']['text'].replace('"km"', '"km" ', 1)
c2 = off.check(to_lua(pack), '0.2.0', now)
print('edited roadbook refused:', not c2.ok, c2.errors[1])
c3 = off.check(to_lua(json.load(open('/workspace/rallyraid-events/test/out/alice-ss1.rrevent.json'))), '0.1.0', now)
print('mod 0.1.0 refused:', not c3.ok, c3.errors[1])
sys.exit(0 if ok1 and not c2.ok and not c3.ok else 1)
