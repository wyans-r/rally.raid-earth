#!/usr/bin/env node
// Builds rallies/data/avoid-morocco.json: no-go polygons for Stage-Gen (opts.avoid) in Morocco and the Saharan south.
//  1. the Algeria border from OpenStreetMap (admin_level=2 ways, Overpass answer saved at /tmp/border.json):
//     the Algerian side plus a strip of STRIP_KM on the Moroccan side;
//  2. the military berm and the Mauritania border: a conservative hand-drawn line (approximate, at least ~25 km west of
//     the berm). Stage lines must never come near either.
'use strict';
const fs = require('fs'), path = require('path');
const STRIP_KM = +(process.env.STRIP_KM || 15);
const d = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/border.json', 'utf8'));
const ways = d.elements.filter(e => e.tags.name && !/الصحراء/.test(e.tags.name)).map(e => e.geometry.map(g => [g.lat, g.lon]));
const key = p => p[0].toFixed(5) + ',' + p[1].toFixed(5);
// chain from the northmost end
let line = null; const used = new Set();
const start = ways.map((w, i) => [i, w[0][0] > w[w.length - 1][0] ? w[0] : w[w.length - 1]]).sort((a, b) => b[1][0] - a[1][0])[0];
{ const w = ways[start[0]]; line = (key(w[0]) === key(start[1]) ? w : w.slice().reverse()).slice(); used.add(start[0]); }
for (let g = 0; g < 200; g++) {
  const end = key(line[line.length - 1]); let found = false;
  for (let i = 0; i < ways.length; i++) { if (used.has(i)) continue; const w = ways[i];
    if (key(w[0]) === end) { line = line.concat(w.slice(1)); used.add(i); found = true; break; }
    if (key(w[w.length - 1]) === end) { line = line.concat(w.slice().reverse().slice(1)); used.add(i); found = true; break; } }
  if (!found) break;
}
const R = 6371008.8, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
const dist = (a, b) => { const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]); const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const brg = (a, b) => { const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]); return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360; };
const dest = (a, b, m) => { const dd = m / R, t = rad(b), p1 = rad(a[0]), l1 = rad(a[1]); const p2 = Math.asin(Math.sin(p1) * Math.cos(dd) + Math.cos(p1) * Math.sin(dd) * Math.cos(t)); return [+deg(p2).toFixed(5), +deg(l1 + Math.atan2(Math.sin(t) * Math.sin(dd) * Math.cos(p1), Math.cos(dd) - Math.sin(p1) * Math.sin(p2))).toFixed(5)]; };
// simplify: keep a point every >= 3 km
const simp = [line[0]]; for (const p of line) if (dist(simp[simp.length - 1], p) >= 3000) simp.push(p); simp.push(line[line.length - 1]);
console.error('border chain: ' + line.length + ' points, ' + Math.round(line.reduce((a, p, i) => a + (i ? dist(line[i - 1], p) : 0), 0) / 1000) + ' km, from ' + line[0] + ' to ' + line[line.length - 1] + '; simplified ' + simp.length);
const polys = [];
// Algerian side: the border line closed round the east / south
const last = simp[simp.length - 1];
polys.push({ name: 'Algeria (OSM border, Algerian side)', polygon: simp.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]).concat([[last[0] - 0.5, last[1]], [last[0] - 0.5, 1], [simp[0][0] + 0.3, 1], [simp[0][0] + 0.3, simp[0][1]]]) });
// the strip: one quad per border piece, offset to the Moroccan side (walking from north-east to south-west, Morocco is on the right)
for (let i = 1; i < simp.length; i++) {
  const a = simp[i - 1], b = simp[i], h = brg(a, b) + 90, m = STRIP_KM * 1000;
  polys.push({ name: 'Algeria border strip ' + STRIP_KM + ' km', polygon: [a, b, dest(b, h, m), dest(a, h, m)] });
  if (i > 1) { const hp = brg(simp[i - 2], a) + 90; polys.push({ name: 'Algeria border strip ' + STRIP_KM + ' km', polygon: [a, dest(a, hp, m), dest(a, (hp + h) / 2 + (Math.abs(hp - h) > 180 ? 180 : 0), m), dest(a, h, m)] }); }
}
// berm + Mauritania (hand-drawn, approximate, conservative; everything east of this line)
const berm = [[27.67, -8.67], [27.75, -9.35], [27.35, -9.75], [26.95, -10.75], [26.45, -11.35], [25.75, -11.95], [25.2, -12.75], [24.4, -13.35], [23.2, -14.05], [21.3, -16.9], [20.5, -16.9], [20.5, -8.0], [27.67, -8.0]];
polys.push({ name: 'Military berm and Mauritania border (hand-drawn, approximate, ~25 km margin)', polygon: berm });
const out = { format: 'rallyraid-avoid', version: 1, created: new Date().toISOString(), stripKm: STRIP_KM,
  sources: ['Algeria-Morocco border: OpenStreetMap contributors (ODbL), admin_level=2 ways, via Overpass', 'Berm / Mauritania line: hand-drawn, approximate, conservative (no reliable open data); keep stage lines well west of it'],
  polygons: polys };
fs.writeFileSync(path.join(__dirname, '..', 'rallies', 'data', 'avoid-morocco.json'), JSON.stringify(out));
console.error('wrote ' + polys.length + ' polygons');
