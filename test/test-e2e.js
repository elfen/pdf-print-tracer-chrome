'use strict';
/*
 * End-to-end test: the REAL extension is loaded in Chromium (Playwright, --load-extension).
 * Scenarios: fetch → Blob → iframe → print chain, attached popup, Service Worker request,
 * print() on a cross-origin frame, then advanced mode (debugger): print() refused in a sandboxed iframe.
 *
 * Usage : PLAYWRIGHT_MODULE=/opt/npm-tools/node_modules/playwright node test/test-e2e.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const A = require('../analysis.js');

const EXT_SRC = path.join(__dirname, '..');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const server = http.createServer((req, res) => {
  const u = req.url;
  if (u.startsWith('/doc.pdf')) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(PDF); }
  else if (u === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', async (e) => { const r = await fetch('/doc.pdf?from=sw'); const b = await r.blob(); e.source.postMessage({ size: b.size }); });`);
  } else if (u === '/frame.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><p>other origin</p>'); }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>app</title><body><button id="b">go</button></body>'); }
});

const step = (m) => console.log('\n— ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;      // origine de l'appli
  const other = 'http://localhost:' + port;     // other origin (cross-origin)

  // Copy of the extension in a temp dir (so the real folder stays untouched).
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ext-'));
  for (const f of fs.readdirSync(EXT_SRC)) if (!/^(test|node_modules)$/.test(f) && !f.endsWith('.zip')) fs.cpSync(path.join(EXT_SRC, f), path.join(extDir, f), { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-prof-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir]
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // Extension page used as a remote control: it talks to the service worker the way the popup would.
  const ctrl = await ctx.newPage();
  await ctrl.goto('chrome-extension://' + extId + '/report.html');
  const cmd = (m) => ctrl.evaluate((x) => chrome.runtime.sendMessage(x), m);

  const page = await ctx.newPage();
  await page.goto(base + '/');
  const tabId = await ctrl.evaluate(async (b) => (await chrome.tabs.query({ url: b + '/*' }))[0].id, base);
  assert.ok(tabId > 0, 'tabId');

  async function fresh(advanced) {
    await cmd({ kind: 'stop', tabId });
    await cmd({ kind: 'setAdvanced', value: advanced });
    await cmd({ kind: 'start', tabId });
    await page.goto(base + '/');
    await sleep(500);
  }
  const trace = async () => { await sleep(800); return cmd({ kind: 'get', tabId }); };
  const has = (events, type, pred) => events.some((e) => e.type === type && (!pred || pred(e.data || {}, e)));

  /* ------------------------------------------------------------------ */
  step('1. Basic mode: full chain + popup + Service Worker + cross-origin frame');
  await fresh(false);
  await page.click('#b');
  await page.evaluate(async (otherOrigin) => {
    const res = await fetch('/doc.pdf?id=42');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const f = document.createElement('iframe');
    f.src = url;
    document.body.append(f);
    await new Promise((r) => { f.onload = r; setTimeout(r, 3000); });
    try { f.contentWindow.print(); } catch (_) { /* ignore */ }
    window.open(url);                                            // popup (attached to the trace)
    // frame from another origin: print() forbidden
    const x = document.createElement('iframe');
    x.src = otherOrigin + '/frame.html';
    document.body.append(x);
    await new Promise((r) => { x.onload = r; setTimeout(r, 3000); });
    setTimeout(() => { x.contentWindow.print(); }, 0);           // uncaught SecurityError
    // request sent by a Service Worker
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    const answer = new Promise((r) => navigator.serviceWorker.addEventListener('message', (e) => r(e.data)));
    (reg.active || reg.waiting).postMessage('go');
    await answer;
  }, other);
  const t1 = await trace();
  console.log('events:', t1.count, '· tabs:', [...new Set(t1.events.map((e) => e.tabId))].join(', '));
  console.log('types :', [...new Set(t1.events.map((e) => e.type))].sort().join(', '));

  assert.ok(t1.env && t1.env.userAgent && Array.isArray(t1.env.extensions), 'env collected');
  assert.ok(has(t1.events, 'wr:headers', (d) => /pdf/.test(d.contentType || '')), 'webRequest sees the PDF headers');
  assert.ok(has(t1.events, 'body:read', (d) => d.isPdf && d.source === 'fetch.blob'), 'signature %PDF lue');
  assert.ok(has(t1.events, 'blob:url'), 'createObjectURL');
  assert.ok(has(t1.events, 'open:call'), 'window.open observed');
  assert.ok(t1.events.some((e) => e.tabId !== tabId && e.type === 'wn:committed'), 'popup attached to the trace (other tabId)');
  assert.ok(has(t1.events, 'iframe:contentWindow', (d) => d.crossOrigin === true), 'cross-origin contentWindow access detected');
  assert.ok(has(t1.events, 'js:error', (d) => /cross-origin/i.test(d.message)), 'cross-origin SecurityError captured');
  assert.ok(t1.events.some((e) => e.worker && e.type === 'wr:before' && /from=sw/.test(e.data.url)), 'Service Worker request attached to the tab');

  const cands = A.analyze(t1).candidates;
  const swCand = cands.find((c) => /from=sw/.test(c.label));
  const mainCand = cands.find((c) => /id=42/.test(c.label));
  assert.ok(swCand && mainCand, 'deux candidats PDF (page et Service Worker)');

  const aMain = A.analyze(t1, { candidateId: mainCand.id });
  const st = (a, id) => a.steps.find((s) => s.id === id).status;
  ['request', 'headers', 'complete', 'js-response', 'body', 'blob-url', 'popup', 'frame-created'].forEach((id) => assert.ok(/^(ok|warn)$/.test(st(aMain, id)), 'main: ' + id + ' = ' + st(aMain, id)));
  const aSw = A.analyze(t1, { candidateId: swCand.id });
  assert.strictEqual(st(aSw, 'request'), 'ok');
  assert.strictEqual(st(aSw, 'complete'), 'ok');
  assert.strictEqual(st(aSw, 'js-response'), 'na');
  console.log('Verdict (main PDF) :', aMain.verdict.title);
  console.log('Verdict (Service Worker PDF) :', aSw.verdict.title);

  /* ------------------------------------------------------------------ */
  step('2. Advanced mode: print() refused in a sandboxed iframe + window.open with a gesture');
  await fresh(true);
  const t0adv = await cmd({ kind: 'get', tabId });
  assert.ok(t0adv.debuggerAvailable && t0adv.debuggerAttached, 'debugger attached to the tab');
  await page.click('#b');
  await page.evaluate(async () => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.srcdoc = '<script>print()</script>';
    document.body.append(f);
    await new Promise((r) => setTimeout(r, 800));
    window.open('about:blank');                                   // popup right after a click: the debugger reports userGesture
    await new Promise((r) => setTimeout(r, 300));
  });
  const t2 = await trace();
  assert.ok(!has(t2.events, 'cdp:exception', (d) => /cross-origin/i.test(d.text)), 'previous page history discarded');
  assert.ok(has(t2.events, 'cdp:windowOpen'), 'Page.windowOpen (userGesture) captured');
  console.log('types :', [...new Set(t2.events.map((e) => e.type))].sort().join(', '));
  const cdpTexts = t2.events.filter((e) => e.src === 'cdp').map((e) => e.type + ' ' + JSON.stringify(e.data).slice(0, 160));
  console.log(cdpTexts.slice(0, 8).join('\n'));
  assert.ok(!has(t2.events, 'cdp:attachError'), 'debugger attached without error');
  assert.ok(t2.events.some((e) => e.src === 'cdp' && /print\(\)/i.test((e.data && e.data.text) || '')),
    'Chrome reports the ignored print() (browser message captured via the debugger)');

  // Same scenario seen by the analysis: the browser message becomes the verdict.
  const fakePdf = [
    { t: 1000, n: 1, src: 'webRequest', type: 'wr:before', tabId, data: { requestId: 'x', url: base + '/doc.pdf', method: 'GET', resourceType: 'xmlhttprequest' } },
    { t: 1100, n: 2, src: 'webRequest', type: 'wr:headers', tabId, data: { requestId: 'x', url: base + '/doc.pdf', statusCode: 200, contentType: 'application/pdf', headers: { 'content-type': 'application/pdf' } } },
    { t: 1200, n: 3, src: 'webRequest', type: 'wr:completed', tabId, data: { requestId: 'x', url: base + '/doc.pdf', statusCode: 200 } }
  ];
  const merged = fakePdf.concat(t2.events.map((e) => Object.assign({}, e, { t: e.t + 1e9 - Date.now() + 1300 })));
  const aAdv = A.analyze({ events: merged });
  console.log('Verdict (advanced mode):', aAdv.verdict.title);
  console.log('   ', aAdv.verdict.detail);
  assert.strictEqual(aAdv.verdict.stepId, 'print-call');
  assert.strictEqual(aAdv.verdict.level, 'fail');
  assert.ok(/sandboxed/.test(aAdv.verdict.detail) && /allow-modals/.test(aAdv.verdict.hint), 'the verdict quotes Chrome\'s exact message');

  // Stop: the debugger must be detached (the banner goes away).
  await cmd({ kind: 'stop', tabId });
  const after = await cmd({ kind: 'get', tabId });
  assert.strictEqual(after.debuggerAttached, false, 'debugger detached on stop');

  await ctx.close();
  server.close();
  console.log('\nOK — the real extension works end to end in Chromium');
})().catch((e) => { console.error(e); process.exit(1); });
