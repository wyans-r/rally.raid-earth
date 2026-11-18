"""The UI <-> Lua bridge harness (tests/browser/bridge_test.js): serves the mod's UI apps to Chrome with Angular 1.5.8 and
runs every bngApi.engineLua call in LuaJIT (lupa) against the real mod Lua (tests/bridge/env.lua fakes the game around it).
  .venv/bin/python tests/bridge/bridge_server.py PORT     (the node test starts it)
POST /lua {code, ret}  run code (ret: as an expression, its value comes back)     -> {value, error}
GET  /events           guihooks messages since the last call, and new log lines    -> {events: [[name, data]], logs, notes}
POST /tick {n, dt}     core.onUpdate n times
POST /ctl {op, ...}    car {lat, lon, speed}; restart (a game kill: fresh Lua, same user folder); rm {path}; eval {code}"""
import json, os, sys, glob, shutil, tempfile, threading, fnmatch
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from lupa import luajit21 as L

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MOD = os.path.join(ROOT, 'mod')
TMP = tempfile.mkdtemp(prefix='rr_bridge_')
lock = threading.Lock()
state = {}

def to_lua(lua, o):
    if isinstance(o, dict):
        return lua.table_from({k: to_lua(lua, v) for k, v in o.items() if v is not None})
    if isinstance(o, list):
        return lua.table_from([to_lua(lua, v) for v in o])
    return o

def from_lua(o, depth=0):
    if L.lua_type(o) == 'table':
        keys = list(o.keys())
        if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [from_lua(o[k], depth + 1) for k in sorted(keys)]
        if not keys:
            return {}
        return {str(k): from_lua(o[k], depth + 1) for k in keys if L.lua_type(o[k]) != 'function'}
    if L.lua_type(o) == 'function':
        return None
    if isinstance(o, float) and (o != o or o in (float('inf'), float('-inf'))):
        return None
    if isinstance(o, bytes):
        return o.decode('utf-8', 'replace')
    return o

def start():
    lua = L.LuaRuntime(unpack_returned_tuples=True)
    g = lua.globals()
    g.MOD_ROOT = MOD
    g.TMP_DIR = TMP
    def read_mod_text(p):
        f = os.path.join(MOD, p.lstrip('/'))
        if os.path.isfile(f):
            with open(f, encoding='utf-8') as h: return h.read()
        return None
    g.READ_MOD_TEXT = read_mod_text
    g.MKDIR = lambda p: os.makedirs(p, exist_ok=True)
    g.JSON_ENCODE = lambda o: json.dumps(from_lua(o))
    g.DECODE_JSON = lambda t: to_lua(lua, json.loads(t))
    def list_any(d, pattern):
        out = set()
        for base in (MOD, TMP):
            for f in glob.glob(os.path.join(base, d.strip('/'), '**', '*'), recursive=True):
                if os.path.isfile(f) and fnmatch.fnmatch(os.path.basename(f), pattern):
                    out.add('/' + os.path.relpath(f, base).replace(os.sep, '/'))
        return lua.table_from(sorted(out))
    g.LIST_ANY = list_any
    lua.execute(open(os.path.join(ROOT, 'tests', 'bridge', 'env.lua')).read())
    state['lua'] = lua
    state['logSeen'] = 0
    state['noteSeen'] = 0

def drain():
    lua = state['lua']; g = lua.globals()
    ev = [[e[1], from_lua(e[2])] for e in (g.EVENTS[i] for i in range(1, len(g.EVENTS) + 1))]
    lua.execute('EVENTS = {}')
    logs = [g.LOGS[i] for i in range(state['logSeen'] + 1, len(g.LOGS) + 1)]; state['logSeen'] = len(g.LOGS)
    notes = [g.NOTES[i] for i in range(state['noteSeen'] + 1, len(g.NOTES) + 1)]; state['noteSeen'] = len(g.NOTES)
    return ev, logs, notes

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = self.path.split('?')[0]
        if u == '/events':
            with lock:
                ev, logs, notes = drain()
            return self.send(200, json.dumps({'events': ev, 'logs': logs, 'notes': notes}))
        if u.startswith('/ui/'):
            f = os.path.join(MOD, u.lstrip('/'))
            if os.path.isfile(f):
                ct = 'text/css' if f.endswith('.css') else 'application/javascript' if f.endswith('.js') else 'application/octet-stream'
                return self.send(200, open(f, 'rb').read(), ct)
        if u == '/page.html':
            return self.send(200, open(os.path.join(ROOT, 'tests', 'bridge', 'page.html'), 'rb').read(), 'text/html')
        self.send(404, '{}')
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        req = json.loads(self.rfile.read(n) or b'{}')
        u = self.path
        with lock:
            lua = state['lua']
            out = {}
            try:
                if u == '/lua':
                    code = req['code']
                    if req.get('ret'):
                        out['value'] = from_lua(lua.execute('return ' + code))
                    else:
                        lua.execute(code)
                elif u == '/tick':
                    f = lua.eval('function(n, dt) for i = 1, n do rallyRaid_core.onUpdate(dt, dt) end end')
                    f(int(req.get('n', 1)), float(req.get('dt', 0.1)))
                elif u == '/ctl':
                    op = req.get('op')
                    if op == 'car':
                        for k in ('lat', 'lon', 'speed', 'heading'):
                            if k in req: lua.globals().CAR[k] = req[k]
                    elif op == 'restart':
                        start()
                    elif op == 'rm':
                        p = os.path.join(TMP, req['path'].lstrip('/'))
                        if os.path.exists(p): os.remove(p)
                    elif op == 'eval':
                        out['value'] = from_lua(lua.execute(req['code']))
                    elif op == 'files':
                        out['value'] = sorted('/' + os.path.relpath(f, TMP) for f in glob.glob(os.path.join(TMP, '**', '*'), recursive=True) if os.path.isfile(f))
            except Exception as e:
                out['error'] = str(e)
        return self.send(200, json.dumps(out))

if __name__ == '__main__':
    start()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18800
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    print('bridge ready on', port, 'user folder', TMP, flush=True)
    try: srv.serve_forever()
    finally: shutil.rmtree(TMP, True)
