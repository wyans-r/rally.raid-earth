#!/usr/bin/env node
// rally.raid Earth rally compiler (B10): event spec + generated stages -> a validated rally file (docs/RALLY_FORMAT.md)
// and the stage / roadbook files next to it, for the website and for the mod.
//
//   node tools/rally-compile.js rallies/specs/<id>.spec.json [--stages DIR] [--site DIR] [--mod DIR] [--allow-missing]
//
// --stages : generated stages (default rallies/build/<id>/stages, written by tools/rally-batch.js)
// --site   : website folder for rallies (default stage-builder/rallies)  -> <id>.rally.json + <id>/stages/*
// --mod    : mod folder for rallies (default mod/rallyraid/rallies)       -> the same layout (the game reads it there)
// Exit code 1 when the rally file or a stage file fails a check.
'use strict';
const fs = require('fs'), path = require('path');
const L = require('./lib/rally-lib.js');
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; }, has = k => argv.includes(k);
const ROOT = path.join(__dirname, '..');
const specPath = argv.find(a => a.endsWith('.json'));
if (!specPath) { console.error('usage: node tools/rally-compile.js <spec.json> [--stages DIR] [--site DIR] [--mod DIR]'); process.exit(2); }
const spec = L.loadJson(specPath);
const STAGES = arg('--stages', path.join(ROOT, 'rallies', 'build', spec.id, 'stages'));
const outs = [arg('--site', path.join(ROOT, 'stage-builder', 'rallies')), arg('--mod', path.join(ROOT, 'mod', 'rallyraid', 'rallies'))].filter(x => x !== 'none');
const res = L.compile(spec, STAGES, { allowMissing: has('--allow-missing'), created: arg('--created', new Date().toISOString().slice(0, 19) + 'Z') });
const stageProblems = [];
for (const s of res.stages) { const st = L.loadJson(s.file); const e = L.checkStage(st); if (e.length) stageProblems.push(s.id + ': ' + e.join('; ')); if (L.BANNED.test(st.name) || L.BANNED.test(st.id)) stageProblems.push(s.id + ': name / id uses a mark'); }
for (const out of outs) {
  const dir = path.join(out, spec.id, 'stages');
  fs.rmSync(path.join(out, spec.id), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const s of res.stages) {
    fs.copyFileSync(s.file, path.join(dir, s.id + '.json'));
    if (s.roadbook) fs.copyFileSync(s.roadbook, path.join(dir, s.id + '.roadbook.json'));
  }
  fs.writeFileSync(path.join(out, spec.id + '.rally.json'), JSON.stringify(res.rally, null, 1));
}
const r = res.rally;
console.log(r.name + ' (' + r.id + '): ' + r.totals.days + ' days, ' + r.totals.stages + ' stages, SS ' + r.totals.ssKm + ' km generated / ' + r.totals.ssTargetKm + ' km target, liaisons ' + r.totals.liaisonKm + ' km');
console.log('day | date       | type     | code | from -> to | target SS | generated | liaison out/in km | allowance out/in min | landmarks');
for (const d of r.days) console.log([d.n, d.date, d.type.padEnd(8), (d.code || '').padEnd(4), d.from + ' -> ' + d.to, d.stage ? d.stage.targetKm : '-', d.stage && d.stage.km ? d.stage.km.toFixed(1) + (d.stage.deviation != null ? ' (' + (d.stage.deviation * 100).toFixed(1) + '%)' : '') : '-',
  (d.liaisonOut ? d.liaisonOut.km : 0) + '/' + (d.liaisonIn ? d.liaisonIn.km : 0), (d.liaisonOut ? d.liaisonOut.allowanceMin : 0) + '/' + (d.liaisonIn ? d.liaisonIn.allowanceMin : 0), d.stage ? (d.stage.landmarks || []).join(',') : ''].join(' | '));
if (res.warnings.length) console.log('WARNINGS:\n  ' + res.warnings.join('\n  '));
const bad = res.problems.concat(stageProblems);
if (bad.length) { console.log('PROBLEMS:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('OK: rally file valid' + (outs.length ? '; written to ' + outs.join(', ') : ''));
