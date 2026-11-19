// Short share links: HTTP tests against a running stagebuilder Worker (wrangler dev or a preview URL).
//   BASE=http://127.0.0.1:8799 [STAGE=path/to/stage.json] [RATE=1] node tests/shortlinks/api_test.js
// RATE=1 also runs the per-IP rate-limit test last (it uses up this IP's 20 uploads for 10 minutes).
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const S = require('../../stage-builder/share.js');
const BASE = (process.env.BASE || 'http://127.0.0.1:8799').replace(/\/$/, '');
const STAGE = process.env.STAGE || path.join(__dirname, '../../stage-builder/examples/mar-merzouga-erg-chebbi.json');
const stage = JSON.parse(fs.readFileSync(STAGE, 'utf8'));
const results = [];
async function t(name, fn) { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ': ' + e.message]); } }
const post = (body, headers = {}) => fetch(BASE + '/api/share', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
let id, frag = S.packStage(stage);

(async () => {
  await t('stage round trip: POST 201, GET returns the same payload, unpacks to the same stage', async () => {
    const r = await post(JSON.stringify({ v: 1, kind: 'stage', data: frag.slice(3) }));
    assert.equal(r.status, 201, 'status ' + r.status + ' ' + await r.clone().text());
    const j = await r.json();
    assert.match(j.id, /^[A-Za-z0-9]{22}$/); assert.equal(j.url, BASE + '/s/' + j.id); id = j.id;
    const g = await fetch(BASE + '/api/share/' + id); assert.equal(g.status, 200);
    assert.match(g.headers.get('cache-control') || '', /immutable/);
    const rec = await g.json(); assert.equal(rec.kind, 'stage'); assert.equal(rec.data, frag.slice(3));
    const back = S.unpack({ kind: rec.kind, version: 1, data: rec.data });
    assert.deepEqual(back.stage, stage);
    console.log('  long link ' + (BASE.length + 4 + frag.length) + ' chars -> short ' + j.url.length + ' chars: ' + j.url);
  });
  await t('roadbook round trip', async () => {
    const ex = path.join(__dirname, '../../stage-builder/examples');
    const rb = JSON.parse(fs.readFileSync(path.join(ex, 'mar-merzouga-erg-chebbi.roadbook.json'), 'utf8'));
    const st = JSON.parse(fs.readFileSync(path.join(ex, 'mar-merzouga-erg-chebbi.json'), 'utf8'));
    const f = S.packRoadbook(rb, st);
    const r = await post(JSON.stringify({ v: 1, kind: 'roadbook', data: f.slice(3) })); assert.equal(r.status, 201);
    const j = await r.json();
    const page = await fetch(j.url); assert.equal(page.status, 200);
    const html = await page.text(); assert.match(html, /<base href="\/">/); assert.match(html, /data-page="roadbook"/); assert.match(html, /roadbook-editor\.js/);
    const rec = await (await fetch(BASE + '/api/share/' + j.id)).json();
    assert.deepEqual(S.unpack({ kind: 'roadbook', version: 1, data: rec.data }).roadbook, rb);
  });
  await t('GET /s/<id> serves the builder page with the short-link marker', async () => {
    const r = await fetch(BASE + '/s/' + id); assert.equal(r.status, 200);
    const h = await r.text(); assert.match(h, /<base href="\/">/); assert.match(h, new RegExp('name="rr-short" content="' + id + '" data-page="stage" data-found="true"'));
    assert.match(h, /Stage Builder/);
  });
  await t('unknown and malformed ids: 404 (page and API)', async () => {
    assert.equal((await fetch(BASE + '/api/share/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
    assert.equal((await fetch(BASE + '/api/share/short')).status, 404);
    assert.equal((await fetch(BASE + '/api/share/..%2F..%2Fetc')).status, 404);
    const p = await fetch(BASE + '/s/AAAAAAAAAAAAAAAAAAAAAA'); assert.equal(p.status, 404); assert.match(await p.text(), /data-found="false"/);
  });
  await t('no listing: GET /api/share is 405, /api/anything else 404', async () => {
    assert.equal((await fetch(BASE + '/api/share')).status, 405);
    assert.equal((await fetch(BASE + '/api/share/')).status, 405);
    assert.equal((await fetch(BASE + '/api/list')).status, 404);
  });
  await t('size cap: 300 KB body -> 413', async () => {
    const big = JSON.stringify({ v: 1, kind: 'stage', data: 'A'.repeat(300 * 1024) });
    const r = await post(big); assert.equal(r.status, 413);
  });
  await t('validation: wrong content type 415, bad JSON 400, extra keys 400, not a stage 400, damaged payload 400, other site 403', async () => {
    assert.equal((await post(JSON.stringify({ v: 1, kind: 'stage', data: frag.slice(3) }), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post(JSON.stringify({ v: 1, kind: 'stage', data: frag.slice(3), x: 1 }))).status, 400);
    const notStage = S.encodePayload({ format: 'something-else' });
    assert.equal((await post(JSON.stringify({ v: 1, kind: 'stage', data: notStage }))).status, 400);
    assert.equal((await post(JSON.stringify({ v: 1, kind: 'stage', data: 'AAAAAAAAAAAAAAAA' }))).status, 400);
    assert.equal((await post(JSON.stringify({ v: 1, kind: 'stage', data: frag.slice(3) }), { origin: 'https://evil.example' })).status, 403);
  });
  await t('ordinary pages still come from the assets', async () => {
    const r = await fetch(BASE + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /share\.js/);
    assert.equal((await fetch(BASE + '/share.js')).status, 200);
    const m = await fetch(BASE + '/mod', { redirect: 'manual' }); assert.equal(m.status, 302);
  });
  if (process.env.RATE === '1') {
    await t('rate limit: at most 20 uploads per IP per 10 min, then 429 with Retry-After', async () => {
      let ok = 0, limited = null;
      for (let i = 0; i < 25 && !limited; i++) {
        const r = await post(JSON.stringify({ v: 1, kind: 'stage', data: frag.slice(3) }));
        if (r.status === 201) ok++; else if (r.status === 429) limited = r; else throw new Error('unexpected ' + r.status);
      }
      assert.ok(limited, 'no 429 after 25 uploads'); assert.ok(ok <= 20, ok + ' uploads accepted');
      assert.ok(+limited.headers.get('retry-after') > 0);
      console.log('  accepted ' + ok + ' more uploads in this window, then 429 (retry-after ' + limited.headers.get('retry-after') + ' s)');
    });
  }
  for (const [s, n] of results) console.log(s + '  ' + n);
  console.log(results.filter(r => r[0] === 'PASS').length + '/' + results.length + ' passed; example short link: ' + BASE + '/s/' + id);
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})();
