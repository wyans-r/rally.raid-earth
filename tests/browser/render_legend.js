// Renders the roadbook symbol legend to roadbook/fim_symbol_legend.png (and checks every symbol is valid SVG in Chrome)
const path = require('path'), puppeteer = require('puppeteer-core');
const R = require('../../stage-builder/roadbook-render.js');
(async () => {
  const out = path.resolve(__dirname, '../../roadbook/fim_symbol_legend.png');
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] }), p = await b.newPage();
  await p.setViewport({ width: 1080, height: 800, deviceScaleFactor: 2 });
  await p.setContent(`<html><head><style>body{margin:0}${R.LEGEND_CSS}</style></head><body>${R.legendHTML()}</body></html>`);
  // every symbol (and alias) parses as a standalone SVG file and draws something
  const codes = [].concat(...Object.values(R.GROUPS), Object.keys(R.ALIAS));
  const svgs = codes.map(c => [c, R.symbolSVG(c, 34)]);
  const bad = await p.evaluate(list => {
    const out = [];
    for (const [c, svg] of list) {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror') || doc.documentElement.nodeName !== 'svg') { out.push(c + ': parse'); continue; }
      const host = document.createElement('div'); host.innerHTML = svg; document.body.appendChild(host);
      const bb = host.firstChild.getBBox(); if (!(bb.width > 2 && bb.height > 2)) out.push(c + ': empty'); host.remove();
    }
    return out;
  }, svgs);
  if (bad.length) console.log(bad.join('\n'));
  console.log('symbols checked:', codes.length);
  const el = await p.$('.rbl'); await el.screenshot({ path: out });
  await b.close();
  console.log(bad.length ? 'FAIL ' + bad.length : 'PASS legend', out);
  process.exit(bad.length ? 1 : 0);
})();
