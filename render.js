/*
 * PDF Print Tracer — DOM rendering of the analysis (popup and report page).
 * All page-originated content is inserted via textContent: no HTML injection possible.
 */
(function (root) {
  'use strict';

  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    for (const c of kids) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const STATUS = {
    ok: ['✔', 'OK'], warn: ['⚠', 'OK, with reservation'], fail: ['✖', 'FAILED'], missing: ['?', 'Not observed'],
    unknown: ['…', 'Not observable'], na: ['–', 'Not applicable'], skipped: ['⤼', 'Not reached']
  };
  const pad = (n, w) => String(n).padStart(w, '0');
  const fmtTime = (t) => {
    const d = new Date(t);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
  };
  const fmtMs = (ms) => (ms == null ? '' : (ms >= 0 ? '+' : '') + ms + ' ms');

  function badge(status) {
    const s = STATUS[status] || ['', status];
    return el('span', { class: 'badge ' + status }, s[0] + ' ' + s[1]);
  }

  function renderVerdict(a) {
    const v = a.verdict;
    const box = el('div', { class: 'verdict ' + v.level }, el('div', { class: 'vtitle' }, v.title));
    if (v.detail) box.append(el('div', { class: 'vdetail' }, v.detail));
    if (v.hint) box.append(el('div', { class: 'vhint' }, '→ ' + v.hint));
    return box;
  }

  function renderSteps(a) {
    if (!a.steps.length) return el('div');
    const table = el('table', { class: 'steps' },
      el('thead', null, el('tr', null, el('th', null, '#'), el('th', null, 'Step'), el('th', null, 'Status'), el('th', null, 'Time'), el('th', null, 'Since request'), el('th', null, 'Detail'))));
    const tb = el('tbody');
    for (const s of a.steps) {
      const detail = el('td', { class: 'detail' });
      if (s.detail) detail.append(el('div', null, s.detail));
      s.notes.forEach((n) => detail.append(el('div', { class: 'note' }, '· ' + n)));
      if (s.hint && /^(fail|missing|warn)$/.test(s.status)) detail.append(el('div', { class: 'hint' }, '→ ' + s.hint));
      const label = el('td', null, el('div', { class: 'label' }, s.label), el('div', { class: 'where' }, s.where));
      const rel = el('td', { class: 'mono' }, fmtMs(s.rel));
      if (s.gap != null) rel.append(el('div', { class: 'gap' + (s.slow ? ' slow' : '') }, 'Δ ' + s.gap + ' ms'));
      tb.append(el('tr', { class: 'row-' + s.status },
        el('td', { class: 'mono' }, s.n), label, el('td', null, badge(s.status)), el('td', { class: 'mono' }, s.t != null ? fmtTime(s.t) : ''), rel, detail));
    }
    table.append(tb);
    return table;
  }

  function renderDiagnostics(a) {
    if (!a.diagnostics.length) return el('div');
    const ul = el('ul', { class: 'diag' });
    a.diagnostics.forEach((d) => ul.append(el('li', { class: d.level }, d.text)));
    return el('div', null, el('h3', null, 'General diagnostics'), ul);
  }

  function render(container, a) {
    container.replaceChildren(renderVerdict(a), renderSteps(a), renderDiagnostics(a));
  }

  root.PdfTraceRender = { render, el, badge, STATUS, fmtTime, fmtMs };
})(self);
