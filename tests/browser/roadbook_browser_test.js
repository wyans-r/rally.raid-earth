// The roadbook generator in real Chrome: Mapterhorn tiles fetched + decoded client-side (no key, CORS), heights match
// the node (sharp) decode, and a full generate() on a sample stage with the OSM step skipped.
const puppeteer = require('/workspace/rr-tools/node_modules/puppeteer-core');
const RB = require('/workspace/rallyraid/stage-builder/roadbook-gen.js'), io = require('/workspace/rallyraid/roadbook/tools/node-io.js');
const stage = require('/workspace/rallyraid/sample-stages/nam-ss2-terrace-bay-mowe-bay-dunes.json');
(async () => {
  const pts = [[-19.80, 13.00], [-19.55, 12.92], [-19.99, 13.034]];
  const dem = RB.createDem({ fetchBytes: io.fetchBytes, decodeImage: io.decodeImage }); await dem.load(pts);
  const nodeH = pts.map(p => dem.h(p[0], p[1]));
  // land cover (ESA WorldCover via Planetary Computer): same classes in node and in the browser (CORS)
  const lcPts = [[-19.80, 13.00], [-19.99, 13.034], [24.62, 37.92], [-19.25, 13.40]];
  const lc = RB.createLandCover({ fetchBytes: io.fetchBytes, decodeImage: io.decodeImage }); await lc.load(lcPts);
  const nodeLc = lcPts.map(p => lc.at(p[0], p[1]));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://rrearth.wyans.net/', { waitUntil: 'domcontentloaded' }).catch(() => page.setContent('<html></html>'));
  await page.addScriptTag({ path: '/workspace/rallyraid/stage-builder/roadbook-gen.js' });
  const res = await page.evaluate(async (pts, stage, lcPts) => {
    const lc = RoadbookGen.createLandCover(); await lc.load(lcPts); const lcv = lcPts.map(p => lc.at(p[0], p[1]));
    const dem = RoadbookGen.createDem(); await dem.load(pts);
    const h = pts.map(p => dem.h(p[0], p[1]));
    const rb = await RoadbookGen.generate(stage, { useOsm: false });
    return { h, used: dem.used, boxes: rb.boxes.length, stats: rb.stats, src: rb.sources.elevation.name, lcv, lcFail: lc.failures, landcover: rb.sources.landcover };
  }, pts, stage, lcPts);
  await browser.close();
  console.log('node   ', nodeH.map(x => x.toFixed(2)).join(' '));
  console.log('browser', res.h.map(x => x.toFixed(2)).join(' '), JSON.stringify(res.used));
  console.log('browser generate:', res.boxes, 'boxes', JSON.stringify(res.stats.per10km), res.src);
  console.log('land cover node   ', nodeLc.join(' '), '\nland cover browser', res.lcv.join(' '), 'failures', res.lcFail, JSON.stringify(res.landcover));
  const ok = res.h.every((x, i) => Math.abs(x - nodeH[i]) < 0.05) && res.boxes > 20 && res.lcv.join() === nodeLc.join() && nodeLc.some(Boolean) && res.landcover && res.landcover.tiles > 0;
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
