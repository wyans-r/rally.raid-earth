// stagebuilder.wyans.net -> https://rrearth.wyans.net (moved 17 Nov 2026).
//
// Every path is redirected to the same path + query on the new host; browsers keep the #hash
// themselves. Plain page navigations get a tiny HTML page instead of a 301, because saved work
// (localStorage + the roadbook editor's IndexedDB autosaves) is per-origin: the page copies the
// site's data to rrearth.wyans.net/migrate.html in the URL fragment (never sent to any server),
// once, then continues to the same path, query and hash there. With nothing to copy it just goes on.
// The old /mod and /download/*.zip links go straight to GitHub Releases.

const NEW = 'https://rrearth.wyans.net';
const REL = 'https://github.com/wyans-r/rally.raid-earth/releases/latest';
const GITHUB = {
  '/mod': REL, '/mod/': REL, '/mod.html': REL,
  '/download/rallyraid_earth.zip': REL + '/download/rallyraid_earth.zip',
  '/download/rallyraid_mod.zip': REL + '/download/rallyraid_earth.zip'
};

function redirect(to, status) {
  return new Response(null, { status, headers: { Location: to, 'Cache-Control': 'public, max-age=3600' } });
}

function isPageNavigation(req, url) {
  if (req.method !== 'GET') return false;
  if (/\.(js|css|json|png|jpe?g|gif|svg|webp|ico|zip|pdf|gpx|kml|txt|xml|map|woff2?)$/i.test(url.pathname)) return false;
  if (url.pathname.startsWith('/download/') || url.pathname.startsWith('/examples/')) return false;
  const dest = req.headers.get('Sec-Fetch-Dest');
  if (dest && dest !== 'document') return false;
  const accept = req.headers.get('Accept') || '';
  if (!accept.includes('text/html')) return false;
  if (/bot|crawl|spider|slurp|facebookexternalhit|discord|preview/i.test(req.headers.get('User-Agent') || '')) return false;
  return true;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function handle(req) {
  const url = new URL(req.url);
  if (GITHUB[url.pathname]) return redirect(GITHUB[url.pathname], 302);
  const target = NEW + url.pathname + url.search;
  if (!isPageNavigation(req, url)) return redirect(target, 301);
  return new Response(PAGE.split('__TARGET__').join(escapeAttr(target)), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'origin',
      'X-Robots-Tag': 'noindex',
      'Link': '<' + target + '>; rel="canonical"'
    }
  });
}

export default { fetch: req => handle(req) };

// The page. Keep it small and dependency-free. Keys: every localStorage key that starts with "rallyraid"
// (rallyraid-builder, rallyraid-roadbook-stage, rallyraid-stagegen-seed, ...), plus the roadbook editor's
// autosaved roadbooks (IndexedDB "rallyraid-roadbook", store "docs"). Caches (IndexedDB "cache" store,
// "rallyraid-tracks") are not copied; they refill themselves.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>rally.raid Earth has moved to rrearth.wyans.net</title>
<noscript><meta http-equiv="refresh" content="0;url=__TARGET__"></noscript>
<style>body{font:15px system-ui,sans-serif;background:#16181d;color:#e8e6e1;display:grid;place-items:center;min-height:90vh;margin:0}a{color:#f2a33a}</style>
</head><body><p id="m">rally.raid Earth has moved to <a id="a" href="__TARGET__">rrearth.wyans.net</a>…</p>
<script>
(function () {
  var NEW = 'https://rrearth.wyans.net', FLAG = 'rallyraid-moved-to-rrearth', MAX = 1500000;
  var target = document.getElementById('a').getAttribute('href') + location.hash;
  document.getElementById('a').href = target;
  var done = false;
  function go(u) { if (done) return; done = true; location.replace(u) }
  setTimeout(function () { go(target) }, 8000); // never strand anyone here
  var ls = {}, n = 0;
  try {
    if (localStorage.getItem(FLAG)) return go(target);
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('rallyraid') === 0 && k !== FLAG) { ls[k] = localStorage.getItem(k); n++ }
    }
  } catch (e) { return go(target) }
  readDocs(function (docs) {
    var keys = Object.keys(docs);
    if (!n && !keys.length) { try { localStorage.setItem(FLAG, 'nothing ' + new Date().toISOString()) } catch (e) {} return go(target) }
    // newest roadbooks first, so if the lot is too big for one URL the oldest are the ones left behind
    keys.sort(function (a, b) { return ((docs[b] && docs[b].saved) || 0) > ((docs[a] && docs[a].saved) || 0) ? 1 : -1 });
    (function attempt(keep) {
      var d = {}; keys.slice(0, keep).forEach(function (k) { d[k] = docs[k] });
      pack({ v: 1, from: location.origin, at: new Date().toISOString(), ls: ls, docs: d, left: keys.length - keep }, function (blob) {
        if (blob.length > MAX && keep > 0) return attempt(keep - 1);
        if (blob.length > MAX) return go(target);
        try { localStorage.setItem(FLAG, new Date().toISOString()) } catch (e) {}
        go(NEW + '/migrate#to=' + encodeURIComponent(target.slice(NEW.length) || '/') + '&d=' + blob);
      });
    })(keys.length);
  });
  function readDocs(cb) {
    var out = {}, t = setTimeout(function () { cb(out); cb = function () {} }, 3000);
    function fin() { clearTimeout(t); cb(out); cb = function () {} }
    try {
      if (!window.indexedDB) return fin();
      var r = indexedDB.open('rallyraid-roadbook', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('cache'); r.result.createObjectStore('docs') };
      r.onerror = fin;
      r.onsuccess = function () {
        try {
          var s = r.result.transaction('docs').objectStore('docs'), c = s.openCursor();
          c.onsuccess = function () { var cur = c.result; if (cur) { if (typeof cur.key === 'string' && cur.key.indexOf('rb:') === 0) out[cur.key] = cur.value; cur.continue() } else fin() };
          c.onerror = fin;
        } catch (e) { fin() }
      };
    } catch (e) { fin() }
  }
  function b64(bytes) { var s = '', C = 0x8000; for (var i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') }
  function pack(obj, cb) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (window.CompressionStream) {
      new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
        .then(function (b) { cb('z' + b64(new Uint8Array(b))) }, function () { cb('j' + b64(bytes)) });
    } else cb('j' + b64(bytes));
  }
})();
</script></body></html>`;
