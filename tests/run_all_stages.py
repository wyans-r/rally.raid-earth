"""Runs tests/sim_test.lua in LuaJIT (the Lua BeamNG uses), via the `lupa` package:
   python3 -m venv .venv && .venv/bin/pip install lupa && .venv/bin/python tests/run_tests.py"""
import glob, json, os, sys
from lupa import luajit21 as L

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOD = os.path.join(ROOT, 'mod')
lua = L.LuaRuntime(unpack_returned_tuples=True)

def to_lua(o):
    if isinstance(o, dict):
        return lua.table_from({k: to_lua(v) for k, v in o.items() if v is not None})
    if isinstance(o, list):
        return lua.table_from([to_lua(v) for v in o])
    return o

def read_json(p):
    path = os.path.join(MOD, p.lstrip('/'))
    with open(path) as f:
        return to_lua(json.load(f))

def list_files(d):
    return lua.table_from(['/' + os.path.relpath(p, MOD) for p in sorted(glob.glob(os.path.join(MOD, d.strip('/'), '*.json')))])

g = lua.globals()
g.MOD_ROOT = MOD
g.READ_JSON = read_json
g.LIST_FILES = list_files
src = open(os.path.join(ROOT, 'tests', 'all_stages_test.lua')).read()
fails = lua.execute(src)
sys.exit(1 if fails else 0)
