#!/usr/bin/env node
// rally.raid Earth batch Stage-Gen runner (B10): generates every special stage of an event spec, headless.
//
//   node tools/rally-batch.js rallies/specs/<id>.spec.json [--out DIR] [--only SS4,SS5] [--no-roadbook] [--redo SS4]
//                                                         [--redo-partial] [--retries 3] [--dry]
//
// - Same code as the website: stage-builder/stagegen-core.js + stage-chain.js (stages over ~185 km are a chain of
//   parts of <= segMaxKm) + roadbook-gen.js (the roadbook, Overpass through its public mirrors helper, NextGIS first).
// - Resumable: every finished part is saved (DIR/parts/<stage>/part-<k>.json) and every finished stage
//   (DIR/stages/<stage>.json); a re-run skips them. --redo drops a stage's parts and starts it again.
//   --redo-partial regenerates parts whose OpenStreetMap tiles did not all load (loaded tiles come from the local cache).
// - Retries a stage (from its last saved part) on mirror / network errors, with a growing pause.
// - Logs: DIR/logs/<stage>.log per stage, DIR/run.log for the run, DIR/report.json at the end.
// Run it in the background:  nohup node tools/rally-batch.js <spec> > /tmp/rally-batch.out 2>&1 &
'use strict';
const fs = require('fs'), path = require('path');
const N = require('./lib/node-io.js'), L = require('./lib/rally-lib.js');
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; }, has = k => argv.includes(k);
const specPath = argv.find(a => a.endsWith('.json'));
if (!specPath) { console.error('usage: node tools/rally-batch.js <spec.json> [--out DIR] [--only SS4] [--no-roadbook] [--redo SS4] [--redo-partial]'); process.exit(2); }
const spec = L.loadJson(specPath);
const OUT = arg('--out', path.join(__dirname, '..', 'rallies', 'build', spec.id));
const only = (arg('--only', '') || '').split(',').filter(Boolean).map(s => s.toUpperCase());
const redo = (arg('--redo', '') || '').split(',').filter(Boolean).map(s => s.toUpperCase());
const RETRIES = +arg('--retries', 3);
for (const d of ['parts', 'stages', 'logs']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const runLog = fs.createWriteStream(path.join(OUT, 'run.log'), { flags: 'a' });
const ts = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Detroit' }) + ' ET';
const say = m => { const line = ts() + '  ' + m; console.log(line); runLog.write(line + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const created = '2026-11-17T00:00:00Z';
const RB_TIMEOUT_MIN = +(process.env.RR_RB_TIMEOUT_MIN || 12);
const AVOID = spec.generation && spec.generation.avoid ? L.loadJson(path.join(__dirname, '..', spec.generation.avoid)).polygons.map(p => p.polygon) : null;
const inPoly = (ll, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][0] > ll[0]) !== (P[j][0] > ll[0]) && ll[1] < (P[j][1] - P[i][1]) * (ll[0] - P[i][0]) / (P[j][0] - P[i][0]) + P[i][1]) c = !c; return c; };
function avoidHits(st) { if (!AVOID) return 0; let n = 0; for (const l of st.route.legs) for (const p of l.points) if (AVOID.some(P => inPoly(p, P))) n++; return n; }

async function stageOne(day) {
  const id = L.stageIdFor(spec, day), final = path.join(OUT, 'stages', id + '.json'), pdir = path.join(OUT, 'parts', id);
  const logf = fs.createWriteStream(path.join(OUT, 'logs', id + '.log'), { flags: 'a' });
  const slog = m => logf.write(ts() + '  ' + m + '\n');
  if (redo.includes(day.code.toUpperCase())) { fs.rmSync(pdir, { recursive: true, force: true }); fs.rmSync(final, { force: true }); fs.rmSync(path.join(OUT, 'stages', id + '.roadbook.json'), { force: true }); }
  fs.mkdirSync(pdir, { recursive: true });
  const inp = L.stageInputs(spec, day), copt = L.chainOpts(spec);
  const lay = N.SC.layout(inp, copt);
  slog('layout: ' + lay.segKm.length + ' part(s) ' + lay.segKm.join(' + ') + ' km, ratio ' + lay.ratio + (lay.loop ? ', loop' : '') + (lay.warnings.length ? ', warnings: ' + lay.warnings.join('; ') : ''));
  const rec = { code: day.code, id, targetKm: day.ssKm, parts: lay.segKm.length, layoutWarnings: lay.warnings };
  if (has('--dry')) { rec.layout = lay; return rec; }
  if (fs.existsSync(final) && !has('--redo-partial')) {
    const st = L.loadJson(final); rec.km = st.lengthKm; rec.resumed = true; slog('already done: ' + st.lengthKm + ' km');
  } else {
    const t0 = Date.now(); let res = null, lastErr = null;
    for (let a = 1; a <= RETRIES && !res; a++) {
      try {
        N.setLog(m => slog('  ' + m));
        res = await N.SC.generateChained(inp, spec.generation.seed + ':' + day.code, N.io(m => slog('  ' + m)), {
          chain: copt, created, segmentOpts: AVOID ? { avoid: AVOID } : undefined, meta: { id, name: day.title, region: inp.region, created,
            description: day.title + '. ' + spec.disclaimer + ' Stage line made by rally.raid Earth Stage-Gen on OpenStreetMap data (target ' + day.ssKm + ' km).' }
        }, {
          log: m => { slog(m); say('  ' + day.code + ' ' + m); },
          loadSegment: async (k) => {
            const f = path.join(pdir, 'part-' + (k + 1) + '.json');
            if (!fs.existsSync(f)) return null;
            const j = L.loadJson(f);
            if (has('--redo-partial') && j.info && j.info.warnings && j.info.warnings.some(w => /did not load/.test(w))) { slog('part ' + (k + 1) + ' had missing map tiles: regenerating'); return null; }
            return j.stage;
          },
          saveSegment: async (k, st, info) => { fs.writeFileSync(path.join(pdir, 'part-' + (k + 1) + '.json'), JSON.stringify({ info: { k: info.k, inputs: info.inputs, warnings: info.warnings, ms: info.ms, region: info.region }, stage: st })); slog('part ' + (k + 1) + ' done: ' + st.lengthKm + ' km in ' + Math.round(info.ms / 1000) + ' s' + (info.warnings.length ? ' (' + info.warnings.join(' ') + ')' : '')); }
        });
      } catch (e) {
        lastErr = e; slog('try ' + a + ' failed: ' + (e.stack || e.message)); say('  ' + day.code + ' try ' + a + ' failed: ' + e.message);
        if (a < RETRIES) await sleep(30000 * a);
      }
    }
    if (!res) { rec.error = lastErr && lastErr.message; return rec; }
    const probs = L.checkStage(res.stage);
    const hits = avoidHits(res.stage); if (hits) probs.push(hits + ' route points inside a no-go area');
    if (AVOID) res.stage.builder.stagegen.avoid = spec.generation.avoid;
    rec.checks = probs; rec.warnings = res.warnings; rec.km = res.stage.lengthKm; rec.genMs = Date.now() - t0;
    fs.writeFileSync(final, JSON.stringify(res.stage, null, 1));
    slog('stage done: ' + res.stage.lengthKm + ' km, ' + res.stage.waypoints.length + ' waypoints, ' + res.stage.roadbook.boxes.length + ' boxes; checks: ' + (probs.length ? probs.join('; ') : 'OK'));
  }
  // roadbook (the editor's generator, on the whole merged stage)
  const rbf = path.join(OUT, 'stages', id + '.roadbook.json');
  if (!has('--no-roadbook') && !fs.existsSync(rbf)) {
    const st = L.loadJson(final), t0 = Date.now();
    for (let a = 1; a <= 2; a++) {
      try {
        // watchdog: a stuck request (seen once on SS8: no answer, no error) must not stall the whole run
        let wd; const rb = await Promise.race([new Promise((_, rej) => { wd = setTimeout(() => rej(new Error('roadbook watchdog: no result in ' + RB_TIMEOUT_MIN + ' min')), RB_TIMEOUT_MIN * 60000); }), N.RB.generate(st, { density: N.SG.DEFAULTS.wp.density, osmOptional: true, fetchBytes: N.fetchBytes, decodeImage: N.decodeImage, fetchOverpass: N.fetchOverpass,
          overpassRace: true, overpassRounds: 2, overpassTimeoutMs: 90000, overpassStaggerMs: 15000, log: m => slog('  rb ' + m) })]).finally(() => clearTimeout(wd));
        fs.writeFileSync(rbf, JSON.stringify(rb, null, 1));
        rec.roadbook = { boxes: rb.boxes.length, partial: rb.partial || null, ms: Date.now() - t0 };
        slog('roadbook: ' + rb.boxes.length + ' boxes' + (rb.partial ? ' (partial: ' + rb.partial + ')' : '') + ' in ' + Math.round((Date.now() - t0) / 1000) + ' s');
        break;
      } catch (e) { slog('roadbook try ' + a + ' failed: ' + (e.stack || e.message)); rec.roadbookError = e.message; if (a < 2) await sleep(30000); }
    }
  } else if (fs.existsSync(rbf)) { const rb = L.loadJson(rbf); rec.roadbook = { boxes: rb.boxes.length, partial: rb.partial || null, resumed: true }; }
  logf.end();
  return rec;
}

(async () => {
  const t0 = Date.now(); say('== batch ' + spec.id + ' -> ' + OUT + (only.length ? ' only ' + only.join(',') : ''));
  const report = { spec: spec.id, started: ts(), stages: [] };
  for (const day of L.stageDays(spec)) {
    if (only.length && !only.includes(day.code.toUpperCase())) continue;
    say(day.code + ' ' + day.title + ' (' + day.ssKm + ' km)');
    const s0 = Date.now(), rec = await stageOne(day);
    rec.wallMs = Date.now() - s0; report.stages.push(rec);
    say(day.code + ' -> ' + (rec.error ? 'FAILED: ' + rec.error : (rec.km != null ? rec.km.toFixed(1) + ' km' : 'layout ' + rec.parts + ' parts') + (rec.roadbook ? ', roadbook ' + rec.roadbook.boxes + ' boxes' : '')) + ' (' + Math.round(rec.wallMs / 1000) + ' s)');
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(Object.assign(report, { net: N.stats }), null, 1));
  }
  report.finished = ts(); report.totalMs = Date.now() - t0; report.net = N.stats;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  say('== done in ' + Math.round((Date.now() - t0) / 60000) + ' min; overpass ' + N.stats.osmMiss + ' fetched / ' + N.stats.osmHit + ' cached / ' + N.stats.osmFail + ' failed');
  runLog.end();
})().catch(e => { say('FATAL ' + (e.stack || e)); process.exit(1); });
