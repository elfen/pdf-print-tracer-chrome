(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const send = (msg) => chrome.runtime.sendMessage(Object.assign({ tabId: tab.id }, msg));

  let candidateId = null;
  let trace = null;
  let analysis = null;
  let lastKey = '';

  const instrumentable = /^(https?|file):/.test(tab.url || '');

  async function isInstrumented() {
    try { const r = await chrome.tabs.sendMessage(tab.id, { kind: 'ping' }); return !!(r && r.ok); } catch (_) { return false; }
  }

  async function refresh(force) {
    trace = await send({ kind: 'get' });
    if (!trace || trace.error) return;
    const active = !!trace.active;
    $('status').textContent = active ? '● Recording — ' + trace.count + ' events' : '○ Stopped — ' + trace.count + ' events';
    $('status').className = 'status' + (active ? ' on' : '');
    $('toggle').textContent = active ? 'Stop recording' : 'Start recording';
    $('adv').checked = !!trace.advanced;

    const notice = $('notice');
    if (!instrumentable) {
      notice.hidden = false;
      notice.textContent = 'This tab (' + (tab.url || '?') + ') cannot be instrumented.';
    } else if (!(await isInstrumented())) {
      notice.hidden = false;
      notice.textContent = 'The page is not instrumented yet: reload it (F5) before reproducing the printing.';
    } else if (active) {
      notice.hidden = false;
      notice.textContent = 'Now reproduce the PDF printing in the tab, then reopen this popup.';
    } else {
      notice.hidden = true;
    }

    const key = trace.count + '|' + candidateId + '|' + active;
    if (!force && key === lastKey) return;
    lastKey = key;
    analysis = PdfTraceAnalysis.analyze(trace, { candidateId });
    const sel = $('cands');
    $('candbar').hidden = analysis.candidates.length < 2;
    sel.replaceChildren();
    analysis.candidates.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = PdfTraceRender.fmtTime(c.t) + ' — ' + c.label;
      if (analysis.candidate && c.id === analysis.candidate.id) o.selected = true;
      sel.append(o);
    });
    PdfTraceRender.render($('out'), analysis);
  }

  $('cands').addEventListener('change', (e) => { candidateId = e.target.value; refresh(true); });

  // "debugger" cannot be an optional permission (Chrome rejects it): it is declared,
  // but the debugger is only attached to the tab when this box is ticked.
  $('adv').addEventListener('change', async (e) => {
    const box = e.target;
    await send({ kind: 'setAdvanced', value: box.checked });
    lastKey = '';
    refresh(true);
  });

  $('toggle').addEventListener('click', async () => {
    if (trace && trace.active) await send({ kind: 'stop' });
    else {
      await send({ kind: 'start' });
      if ($('reload').checked && instrumentable) chrome.tabs.reload(tab.id);
    }
    lastKey = '';
    refresh(true);
  });
  $('clear').addEventListener('click', async () => { await send({ kind: 'clear' }); lastKey = ''; refresh(true); });

  const maybeRedact = (text) => ($('redact').checked ? PdfTraceAnalysis.redact(text) : text);

  $('copy').addEventListener('click', async () => {
    if (!analysis) return;
    await navigator.clipboard.writeText(maybeRedact(PdfTraceAnalysis.toText(analysis)));
    $('copy').textContent = 'Copied ✔';
    setTimeout(() => { $('copy').textContent = 'Copy report'; }, 1500);
  });

  $('export').addEventListener('click', () => {
    if (!trace) return;
    const json = JSON.stringify({ format: 'pdf-print-tracer/1', exportedAt: new Date().toISOString(), env: trace.env, events: trace.events }, null, 1);
    const blob = new Blob([maybeRedact(json)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pdf-trace-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $('report').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('report.html') }));

  await refresh(true);
  setInterval(refresh, 1000);
})();
