// Changelog tab (19 Nov 2026): CHANGELOG.md -> safe DOM (stage-builder/changelog.js)
const test = require('node:test'), assert = require('assert'), fs = require('fs'), path = require('path');
const CL = require('../stage-builder/changelog.js');
const MD = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

// a minimal DOM: elements with children, text nodes, attributes set as properties
function fakeDoc() {
  const doc = {
    createElement: tag => ({ tag, children: [], ownerDocument: doc, appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }, get firstChild() { return this.children[0]; },
      set textContent(v) { this.children = [{ text: String(v) }]; } }),
    createTextNode: t => ({ text: t })
  };
  return doc;
}
const html = n => n.text != null ? n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '<' + n.tag + (n.href ? ' href="' + n.href + '"' : '') + (n.open ? ' open' : '') + '>' + n.children.map(html).join('') + '</' + n.tag + '>';

test('changelog: the real CHANGELOG.md parses into sections, Unreleased first, then newest first', () => {
  const d = CL.parse(MD);
  assert.strictEqual(d.title, 'Changelog');
  assert.ok(d.sections.length >= 6);
  assert.strictEqual(d.sections[0].title, '[Unreleased]');
  assert.ok(d.sections.some(s => /^\[0\.3\.0\] - 2026-11-19/.test(s.title)) && d.sections.some(s => /^\[0\.2\.0\] - 2026-11-17/.test(s.title)));
  const dates = d.sections.map(s => (s.title.match(/\d{4}-\d{2}-\d{2}/) || [])[0]).filter(Boolean);
  assert.deepStrictEqual(dates, dates.slice().sort().reverse(), 'dated sections newest first');
  // every section has a sub-heading or a list
  for (const s of d.sections) assert.ok(s.blocks.length, s.title);
});
test('changelog: inline bold / code / links; only http(s) links; HTML stays text', () => {
  assert.deepStrictEqual(CL.inline('a **b** `c` [d](https://x.y/z)').map(n => n.t), ['text', 'b', 'text', 'code', 'text', 'a']);
  assert.ok(CL.inline('[evil](javascript:alert(1))').every(n => n.t === 'text'));
  const doc = fakeDoc(), el = doc.createElement('div');
  CL.render('# T\n\n## [1.0] - 2026-01-01\n\n### Added\n- <img src=x onerror=alert(1)> **<b>x</b>**\n  - nested [ok](https://a.b) [bad](javascript:x)\n\n## Old\n- o', el, { open: 1 });
  const out = html(el);
  assert.ok(!/<img|<b>|javascript:/.test(out), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)>'), out);
  assert.ok(out.includes('<a href="https://a.b">ok</a>'));
  assert.ok(/<details open><summary>\[1\.0\] - 2026-01-01<\/summary>/.test(out) && /<details><summary>Old<\/summary>/.test(out), out);
  assert.ok(/<ul><li>.*<ul><li>nested/.test(out), 'nested list');
});
test('changelog: does not mention the retracted rally viewer', () => {
  assert.ok(!/rally\.html|Rally viewer/i.test(MD), 'CHANGELOG.md must not name the retracted rally viewer');
});
test('changelog: no innerHTML in the renderer', () => {
  assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(__dirname, '..', 'stage-builder', 'changelog.js'), 'utf8')));
});
