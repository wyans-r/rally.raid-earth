/* changelog.js - the Changelog tab of the stage builder (19 Nov 2026).
 * Renders CHANGELOG.md (copied next to index.html by deploy.sh, so every deploy shows the current file) with a tiny,
 * safe markdown subset: "# " title, "## " sections (collapsible, file order = newest first), "### " sub-headings,
 * "- " bullets (2-space nesting), paragraphs, **bold**, `code` and [text](https://...) links. Nothing is parsed as HTML:
 * every piece of text goes in with textContent, and links are kept only for http(s) URLs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RRChangelog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /** inline markdown -> [{ t: 'text' | 'b' | 'code' | 'a', v, href? }] (bold may hold text / code / links) */
  function inline(s) {
    var out = [], re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
      if (m[1] != null) out.push({ t: 'b', v: m[1], kids: inline(m[1]) });
      else if (m[2] != null) out.push({ t: 'code', v: m[2] });
      else if (/^https?:\/\//i.test(m[4])) out.push({ t: 'a', v: m[3], href: m[4] });
      else out.push({ t: 'text', v: m[3] });   // not http(s): the text only
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
    return out;
  }
  /** CHANGELOG.md -> { title, intro: [block], sections: [{ title, blocks }] }; block = { t: 'h' | 'p' | 'ul', ... } */
  function parse(md) {
    var lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    var doc = { title: '', intro: [], sections: [] }, cur = doc.intro, para = null, list = null;
    var flush = function () { para = null; list = null; };
    lines.forEach(function (ln) {
      var m;
      if (/^\s*$/.test(ln)) { flush(); return; }
      if ((m = ln.match(/^# (.*)$/))) { flush(); doc.title = m[1].trim(); return; }
      if ((m = ln.match(/^## (.*)$/))) { flush(); var sec = { title: m[1].trim(), blocks: [] }; doc.sections.push(sec); cur = sec.blocks; return; }
      if ((m = ln.match(/^#{3,6} (.*)$/))) { flush(); cur.push({ t: 'h', v: m[1].trim() }); return; }
      if ((m = ln.match(/^( *)[-*] (.*)$/))) {
        para = null;
        var depth = Math.floor(m[1].length / 2);
        if (!list) { list = { t: 'ul', items: [] }; cur.push(list); }
        var host = list;
        for (var d = 0; d < depth && host.items.length; d++) { var lastItem = host.items[host.items.length - 1]; if (!lastItem.sub) lastItem.sub = { t: 'ul', items: [] }; host = lastItem.sub; }
        host.items.push({ v: m[2] });
        return;
      }
      if (list && /^ {2,}\S/.test(ln)) {   // continuation of the last bullet
        var h = list; while (h.items.length && h.items[h.items.length - 1].sub) h = h.items[h.items.length - 1].sub;
        h.items[h.items.length - 1].v += ' ' + ln.trim(); return;
      }
      list = null;
      if (para) para.v += ' ' + ln.trim(); else { para = { t: 'p', v: ln.trim() }; cur.push(para); }
    });
    return doc;
  }
  function addInline(doc, el, s) {
    inline(s).forEach(function (n) {
      if (n.t === 'text') el.appendChild(doc.createTextNode(n.v));
      else if (n.t === 'code') { var c = doc.createElement('code'); c.textContent = n.v; el.appendChild(c); }
      else if (n.t === 'b') { var b = doc.createElement('strong'); addInline(doc, b, n.v); el.appendChild(b); }
      else if (n.t === 'a') { var a = doc.createElement('a'); a.textContent = n.v; a.href = n.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; el.appendChild(a); }
    });
  }
  function addBlocks(doc, el, blocks) {
    blocks.forEach(function (bk) {
      if (bk.t === 'h') { var h = doc.createElement('h4'); addInline(doc, h, bk.v); el.appendChild(h); }
      else if (bk.t === 'p') { var p = doc.createElement('p'); addInline(doc, p, bk.v); el.appendChild(p); }
      else if (bk.t === 'ul') el.appendChild(listEl(doc, bk));
    });
  }
  function listEl(doc, ul) {
    var u = doc.createElement('ul');
    ul.items.forEach(function (it) { var li = doc.createElement('li'); addInline(doc, li, it.v); if (it.sub) li.appendChild(listEl(doc, it.sub)); u.appendChild(li); });
    return u;
  }
  /** render into el (cleared first); opts.open = how many sections start open (default 2) */
  function render(md, el, opts) {
    var doc = el.ownerDocument, d = parse(md), n = (opts && opts.open != null) ? opts.open : 2;
    while (el.firstChild) el.removeChild(el.firstChild);
    if (d.title) { var t = doc.createElement('h3'); t.className = 'cl-title'; addInline(doc, t, d.title); el.appendChild(t); }
    var intro = doc.createElement('div'); intro.className = 'cl-intro'; addBlocks(doc, intro, d.intro); el.appendChild(intro);
    d.sections.forEach(function (s, i) {
      var det = doc.createElement('details'); det.className = 'cl-sec'; if (i < n) det.open = true;
      var sum = doc.createElement('summary'); addInline(doc, sum, s.title); det.appendChild(sum);
      var body = doc.createElement('div'); body.className = 'cl-body'; addBlocks(doc, body, s.blocks); det.appendChild(body);
      el.appendChild(det);
    });
    return d;
  }
  return { inline: inline, parse: parse, render: render };
});
