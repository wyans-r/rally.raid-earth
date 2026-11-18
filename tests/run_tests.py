"""Runs tests/sim_test.lua, tests/recce_test.lua, tests/repair_test.lua, tests/planner_test.lua and tests/resume_test.lua in LuaJIT (the Lua BeamNG uses), via the `lupa` package:
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

def from_lua(o):
    if L.lua_type(o) == 'table':
        keys = list(o.keys())
        if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [from_lua(o[k]) for k in sorted(keys)]
        if not keys:
            return []
        return {str(k): from_lua(o[k]) for k in keys}
    return o

def write_json(rel, o):
    # test fixtures written by the Lua tests (tests/fixtures/...), read by the node / browser tests
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(from_lua(o), f, indent=1)

def list_files(d):
    return lua.table_from(['/' + os.path.relpath(p, MOD) for p in sorted(glob.glob(os.path.join(MOD, d.strip('/'), '*.json')))])

def read_text(rel):
    # a file under the project (tests/fixtures/...) as text, or nil
    path = os.path.join(ROOT, rel.lstrip('/'))
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return f.read()

def decode_json(text):
    return to_lua(json.loads(text))

def encode_json(o):
    # BeamNG's jsonEncode stand-in (the game-crash save files)
    return json.dumps(from_lua(o))

import tempfile, shutil, atexit
TMP_DIR = tempfile.mkdtemp(prefix='rallyraid_test_')
atexit.register(shutil.rmtree, TMP_DIR, True)

import hashlib
def sha256_hex(s):
    # Python's SHA-256 of a Lua string (bytes): the reference the Lua sha256.lua is checked against
    return hashlib.sha256(s if isinstance(s, bytes) else s.encode('utf-8')).hexdigest()

def mkdir(p):
    os.makedirs(p, exist_ok=True)

# each test file in a fresh Lua state: sim_test.lua (the rally computer and stages), recce_test.lua (recce mode),
# repair_test.lua (repairs, bivouac, resets), planner_test.lua (the in-game planner's game side), resume_test.lua (recover
# car, and the game-crash resume: saves on disk in a temp folder, a kill, a fresh start, corrupt-save fallback)
total = 0
for name in (sys.argv[1:] or ['sim_test.lua', 'recce_test.lua', 'repair_test.lua', 'planner_test.lua', 'resume_test.lua', 'official_test.lua', 'keys_test.lua', 'rally_test.lua', 'ingame1117_test.lua']):
    lua = L.LuaRuntime(unpack_returned_tuples=True)
    g = lua.globals()
    g.MOD_ROOT = MOD
    g.READ_JSON = read_json
    g.LIST_FILES = list_files
    g.WRITE_JSON = write_json
    g.READ_TEXT = read_text
    g.DECODE_JSON = decode_json
    g.JSON_ENCODE = encode_json
    g.TMP_DIR = TMP_DIR
    g.MKDIR = mkdir
    g.SHA256 = sha256_hex
    print('== ' + name)
    total += lua.execute(open(os.path.join(ROOT, 'tests', name)).read()) or 0
sys.exit(1 if total else 0)
