/* Rally Raid roadbook PDF export (client-side, jsPDF): the real roadbook strip layout, 3 columns per box
 *   1. total km (big), partial km (from the previous box), box number
 *   2. tulip
 *   3. symbols, notes, CAP, danger (!, !!, !!!)
 * Formats: 'a5' (148 x 210 mm pages, 6 boxes a page, for a binder or an A5 roadbook holder) and 'roll' (148 mm wide
 * strips as long as a roadbook reader roll, cut into pieces of at most ~4.5 m because PDF pages have a size limit).
 * Boxes read top to bottom, box 1 first. Tulips and symbols are the SVGs of roadbook-render.js, drawn into PNGs.
 * window.RoadbookPDF.build(rb, { format, jsPDF, onProgress, cover }) -> Promise<jsPDF document>. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoadbookPDF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const JSPDF_URL = 'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js';
  const PAGE_W = 148, M = 6, HEAD = 11, FOOT = 6, BOX_H = 30, C1 = 34, C2 = 36;
  const ROLL_MAX = 4500; // mm per PDF page (PDF pages are limited to ~5 m)
  // jsPDF's built-in fonts are Latin-1 only
  const latin1 = s => String(s == null ? '' : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...').replace(/\u2192/g, '->').replace(/[^\x00-\xFF]/g, '?');
  const pad3 = c => (c == null || !isFinite(c)) ? '---' : String(Math.round(c) % 360).padStart(3, '0');

  function loadJsPDF() {
    if (typeof window === 'undefined') return Promise.reject(new Error('no browser'));
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = JSPDF_URL; s.crossOrigin = 'anonymous';
      s.onload = () => window.jspdf && window.jspdf.jsPDF ? res(window.jspdf.jsPDF) : rej(new Error('jsPDF did not load'));
      s.onerror = () => rej(new Error('could not load jsPDF from ' + JSPDF_URL));
      document.head.appendChild(s);
    });
  }
  const pngCache = new Map();
  function svgToPng(svg, px) {
    const key = px + '|' + svg;
    if (pngCache.has(key)) return pngCache.get(key);
    const p = new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = px; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, px, px); g.drawImage(img, 0, 0, px, px); res(c.toDataURL('image/png')); };
      img.onerror = () => rej(new Error('svg render failed'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    pngCache.set(key, p);
    return p;
  }

  async function build(rb, opts) {
    opts = opts || {};
    const R = opts.render || (typeof RoadbookRender !== 'undefined' ? RoadbookRender : null);
    if (!R) throw new Error('roadbook-render.js is needed');
    const JsPDF = opts.jsPDF || await loadJsPDF();
    const format = opts.format === 'roll' ? 'roll' : 'a5';
    const boxes = rb.boxes.filter(b => !b.deleted);
    const title = latin1(rb.stage && (rb.stage.name || rb.stage.id) || rb.name || 'Roadbook');
    const edited = boxes.some(b => b.source === 'editor' || (b.sources || []).includes('editor') || b.verified);
    const status = boxes.some(b => /^recce/.test(b.source)) ? 'RECCE' : edited ? 'EDITED' : 'AUTO DRAFT, NOT RECCE\'D';
    // pages: a list of [from, to) box ranges
    const perPage = format === 'a5' ? Math.floor((210 - 2 * M - HEAD - FOOT) / BOX_H) : Math.floor((ROLL_MAX - 2 * M - HEAD - FOOT) / BOX_H);
    const pages = []; for (let i = 0; i < boxes.length; i += perPage) pages.push([i, Math.min(boxes.length, i + perPage)]);
    const pageH = n => format === 'a5' ? 210 : 2 * M + HEAD + FOOT + n * BOX_H;
    const cover = opts.cover !== false;
    const firstH = cover ? (format === 'a5' ? 210 : 210) : pageH(pages[0] ? pages[0][1] - pages[0][0] : 1);
    const doc = new JsPDF({ unit: 'mm', format: [PAGE_W, firstH], orientation: 'portrait', compress: true });
    doc.setProperties({ title: 'Roadbook: ' + title, subject: 'Rally raid roadbook', creator: 'Rally Raid stage builder (roadbook editor)' });
    const total = pages.length + (cover ? 1 : 0);
    let pageNo = 0;
    const head = (from, to) => {
      doc.setFillColor(17, 17, 17); doc.rect(M, M, PAGE_W - 2 * M, HEAD - 2, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text(doc.splitTextToSize(title, 84)[0], M + 2, M + 5.8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      const kmA = boxes[from] ? boxes[from].km.toFixed(2) : '', kmB = boxes[to - 1] ? boxes[to - 1].km.toFixed(2) : '';
      doc.text('boxes ' + (from + 1) + '-' + to + '  km ' + kmA + '-' + kmB + '   p ' + pageNo + '/' + total, PAGE_W - M - 2, M + 5.8, { align: 'right' });
      doc.setTextColor(0, 0, 0);
    };
    const foot = (h) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(90, 90, 90);
      const t = latin1((rb.generator || '') + ' | rev ' + (rb.revision || 1) + ' | ' + status + ' | ' + ((rb.sources && rb.sources.attribution) || 'OpenStreetMap contributors'));
      doc.text(doc.splitTextToSize(t, PAGE_W - 2 * M)[0], M, h - M + 1);
      doc.setTextColor(0, 0, 0);
    };
    // cover page
    if (cover) {
      pageNo++;
      doc.setFillColor(17, 17, 17); doc.rect(0, 0, PAGE_W, 46, 'F');
      doc.setTextColor(255, 212, 0); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('ROADBOOK', M + 2, 14);
      doc.setTextColor(255, 255, 255); doc.setFontSize(15); doc.text(doc.splitTextToSize(title, PAGE_W - 2 * M - 4).slice(0, 2), M + 2, 24);
      doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      const st = rb.stats || {}, p10 = st.per10km || {};
      const lines = [
        ['Stage', latin1(rb.stage && rb.stage.id)],
        ['Length', (boxes.length ? boxes[boxes.length - 1].km.toFixed(2) : '-') + ' km'],
        ['Boxes', String(boxes.length)],
        ['Density', (p10.offPiste != null ? 'off-piste ' + p10.offPiste + ' / 10 km   ' : '') + (p10.onPiste != null ? 'on-piste ' + p10.onPiste + ' / 10 km' : '')],
        ['Waypoints', boxes.filter(b => b.waypoint).map(b => b.label).join(' ')],
        ['Status', status],
        ['Revision', String(rb.revision || 1) + (rb.modified ? '  (' + String(rb.modified).slice(0, 10) + ')' : '')],
      ];
      let y = 58;
      for (const [k, v] of lines) { doc.setFont('helvetica', 'bold'); doc.text(k, M + 2, y); doc.setFont('helvetica', 'normal'); const t = doc.splitTextToSize(latin1(v || '-'), PAGE_W - 2 * M - 30); doc.text(t, M + 30, y); y += 6 * Math.max(1, t.length); }
      y += 4; doc.setFont('helvetica', 'bold'); doc.text('Reading the boxes', M + 2, y); y += 5; doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      const help = ['Column 1: total distance from the start (km), partial distance from the previous box, box number.',
        'Column 2: tulip. You arrive at the dot, leave by the arrow. Double line tarmac, thick gravel road, thin track, dashed two-track, dotted off-piste.',
        'Column 3: symbols, notes, CAP (compass heading to follow on leaving the box), danger ! / !! / !!!.',
        'Set the trip to the box distance at every box you identify (in game: Ctrl+Shift+Up / Down, or the roadbook app SYNC).'];
      for (const h of help) { const t = doc.splitTextToSize(h, PAGE_W - 2 * M - 4); doc.text(t, M + 2, y); y += 4.2 * t.length + 1.5; }
      // line style samples
      y += 3; const trs = ['tarmac', 'gravel', 'track', 'twotrack', 'offpiste', 'sand'];
      for (let i = 0; i < trs.length; i++) {
        const svg = R.tulipSVG({ entry: { track: trs[i] }, exit: { angle: 0, track: trs[i] }, branches: [] }, 120);
        const png = await svgToPng(svg, 160);
        const x = M + 2 + i * 22; doc.addImage(png, 'PNG', x, y, 18, 18); doc.setFontSize(7); doc.text(trs[i], x + 9, y + 21, { align: 'center' });
      }
      foot(210);
    }
    let done = 0;
    for (const [from, to] of pages) {
      const h = pageH(to - from);
      if (pageNo > 0) doc.addPage([PAGE_W, h], 'portrait');
      pageNo++;
      head(from, to);
      let y = M + HEAD;
      for (let i = from; i < to; i++) {
        const b = boxes[i];
        await drawBox(doc, R, b, M, y);
        y += BOX_H;
        done++; if (opts.onProgress) opts.onProgress(done, boxes.length);
      }
      foot(h);
    }
    return doc;
  }

  async function drawBox(doc, R, b, x, y) {
    const W = PAGE_W - 2 * M, C3 = W - C1 - C2;
    // backgrounds
    if (b.danger >= 3) { doc.setFillColor(255, 233, 230); doc.rect(x, y, W, BOX_H, 'F'); }
    if (b.waypoint) { doc.setFillColor(238, 238, 238); doc.rect(x, y, C1, BOX_H, 'F'); }
    if (b.offPiste) { doc.setFillColor(251, 248, 239); doc.rect(x + C1, y, C2, BOX_H, 'F'); }
    doc.setDrawColor(17, 17, 17); doc.setLineWidth(0.5);
    doc.rect(x, y, W, BOX_H); doc.line(x + C1, y, x + C1, y + BOX_H); doc.line(x + C1 + C2, y, x + C1 + C2, y + BOX_H);
    // column 1
    doc.setFillColor(17, 17, 17); const nTxt = String(b.n); const nw = 3 + nTxt.length * 2; doc.roundedRect(x + 1.5, y + 1.5, nw, 4.6, 0.8, 0.8, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(nTxt, x + 1.5 + nw / 2, y + 4.9, { align: 'center' });
    doc.setTextColor(0, 0, 0); doc.setFontSize(20); doc.text(b.km.toFixed(2), x + C1 - 2, y + 15, { align: 'right' });
    // FIM: a red line under the km = danger 2 or more; a red frame round the notes = danger 3 (the whole box)
    if (b.danger >= 2) { const kw = doc.getTextWidth(b.km.toFixed(2)); doc.setDrawColor(210, 0, 0); doc.setLineWidth(0.9); doc.line(x + C1 - 2 - kw, y + 16.6, x + C1 - 2, y + 16.6); doc.setDrawColor(17, 17, 17); doc.setLineWidth(0.5); }
    if (b.danger >= 3) { doc.setDrawColor(210, 0, 0); doc.setLineWidth(0.9); doc.rect(x + C1 + C2 + 0.8, y + 0.8, C3 - 1.6, BOX_H - 1.6); doc.setDrawColor(17, 17, 17); doc.setLineWidth(0.5); }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(60, 60, 60); doc.text((b.partial || 0).toFixed(2), x + C1 - 2, y + 22, { align: 'right' });
    if (b.waypoint) { doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0, 0, 0); doc.text(latin1(b.label || ''), x + 2, y + BOX_H - 2.5); }
    doc.setTextColor(0, 0, 0);
    // column 2: tulip
    const tul = await svgToPng(R.tulipSVG(b.tulip && typeof b.tulip === 'object' ? b.tulip : null, 120), 240);
    doc.addImage(tul, 'PNG', x + C1 + 3, y + 0.5, 29, 29);
    // column 3
    const x3 = x + C1 + C2 + 1.5;
    let sx = x3; const syms = (b.symbols || []).slice(0, 7);
    for (const s of syms) { const png = await svgToPng(R.symbolSVG(s, 34), 96); doc.addImage(png, 'PNG', sx, y + 1.2, 7, 7); sx += 7.6; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    const notes = doc.splitTextToSize(latin1(R.noteCase ? R.noteCase(b.notes) : String(b.notes || '').toUpperCase()), C3 - 4).slice(0, 4);
    doc.text(notes, x3, y + (syms.length ? 12 : 5.5));
    if (b.danger) { doc.setTextColor(210, 0, 0); doc.setFontSize(14); doc.text('!'.repeat(b.danger), x + W - 2, y + 6, { align: 'right' }); doc.setTextColor(0, 0, 0); }
    doc.setFontSize(11); doc.text('CAP ' + pad3(b.capOut != null ? b.capOut : b.cap), x + W - 2, y + BOX_H - 2.5, { align: 'right' });
  }
  return { build, loadJsPDF, svgToPng, latin1, JSPDF_URL, layout: { PAGE_W, M, HEAD, FOOT, BOX_H, C1, C2 } };
});
