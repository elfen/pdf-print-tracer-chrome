(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { el, badge, render, fmtMs } = PdfTraceRender;
  const result = { A: null, B: null };

  function load(side, file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const tr = JSON.parse(reader.result);
        if (!tr || !Array.isArray(tr.events)) throw new Error('file has no "events" field');
        result[side] = PdfTraceAnalysis.analyze(tr);
        render($('out' + side), result[side]);
        $('out' + side).prepend(el('h3', null, 'Trace ' + side + ' — ' + file.name));
      } catch (e) {
        $('out' + side).replaceChildren(el('div', { class: 'verdict fail' }, 'Unreadable file: ' + e.message));
        result[side] = null;
      }
      compare();
    };
    reader.readAsText(file);
  }

  function cell(step) {
    if (!step) return el('td', null, '—');
    return el('td', null, badge(step.status), step.rel != null ? el('span', { class: 'mono' }, ' ' + fmtMs(step.rel)) : null);
  }

  function compare() {
    const box = $('cmp');
    if (!result.A || !result.B) { box.replaceChildren(); return; }
    const table = el('table', { class: 'cmp' },
      el('thead', null, el('tr', null, el('th', null, 'Step'), el('th', null, 'A (works)'), el('th', null, 'B (fails)'))));
    const tb = el('tbody');
    const ids = result.A.steps.map((s) => s.id);
    ids.forEach((id) => {
      const a = result.A.steps.find((s) => s.id === id);
      const b = result.B.steps.find((s) => s.id === id);
      const tdB = cell(b);
      if (!a || !b || a.status !== b.status) tdB.className = 'diff';
      tb.append(el('tr', null, el('td', null, a ? a.n + '. ' + a.label : id), cell(a), tdB));
    });
    table.append(tb);
    box.replaceChildren(el('h3', null, 'Step by step'), table);
  }

  $('fileA').addEventListener('change', (e) => e.target.files[0] && load('A', e.target.files[0]));
  $('fileB').addEventListener('change', (e) => e.target.files[0] && load('B', e.target.files[0]));
})();
