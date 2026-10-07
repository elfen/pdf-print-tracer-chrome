'use strict';
/*
 * Test of inject.js in a real Chromium (Playwright): the script is loaded in the MAIN world,
 * the fetch → Blob → Blob URL → iframe → print() / window.open chain is played, then
 * the emitted events are checked and fed to the analysis.
 * Usage: node test/test-inject.js   (needs playwright, e.g. /opt/npm-tools/node_modules/playwright)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const A = require('../analysis.js');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/doc.pdf')) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(PDF); }
  else if (req.url.startsWith('/fake.pdf')) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('<html>Session expired</html>'); }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>t</title><body><button id="b">go</button></body>'); }
});

// Replaces relay.js: collects events in window.__events (same protocol as relay.js).
const collector = `(() => {
  window.__events = [];
  window.addEventListener('__pdftracer_ev__', e => window.__events.push(JSON.parse(e.detail)));
  window.addEventListener('__pdftracer_ping__', () => window.dispatchEvent(new CustomEvent('__pdftracer_hello__')));
  window.dispatchEvent(new CustomEvent('__pdftracer_hello__'));
})();`;

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(collector);
  await ctx.addInitScript(fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8'));
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.click('#b');

  // Full chain: fetch → blob → Blob URL → iframe → print()
  const printed = await page.evaluate(async () => {
    const res = await fetch('/doc.pdf?id=42');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const f = document.createElement('iframe');
    f.src = url;
    document.body.append(f);
    await new Promise((r) => { f.onload = r; setTimeout(r, 3000); });
    let called = false;
    try { f.contentWindow.print(); called = true; } catch (e) { called = 'exception ' + e.message; }
    window.print();
    // Check of the load event captured on an HTML iframe (headless Chromium has no PDF viewer).
    const h = document.createElement('iframe');
    h.src = URL.createObjectURL(new Blob(['<p>x</p>'], { type: 'text/html' }));
    document.body.append(h);
    await new Promise((r) => { h.onload = r; setTimeout(r, 3000); });
    return called;
  });
  // XHR as arraybuffer + non-PDF content + JS error + popup
  await page.evaluate(async () => {
    await fetch('/fake.pdf').then((r) => r.blob());
    await new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/doc.pdf?xhr=1'); x.responseType = 'arraybuffer';
      x.onload = resolve; x.send();
    });
    window.open('about:blank');
    setTimeout(() => { throw new Error('boom'); }, 0);
    await new Promise((r) => setTimeout(r, 300));
  });
  await page.waitForTimeout(500);
  const events = await page.evaluate(() => window.__events);
  await browser.close();
  server.close();

  const types = events.map((e) => e.type);
  const has = (t, pred) => events.some((e) => e.type === t && (!pred || pred(e.data)));
  console.log('emitted types:', [...new Set(types)].join(', '));
  console.log('print via iframe :', printed);

  assert.ok(has('env', (d) => typeof d.pdfViewerEnabled === 'boolean'), 'env');
  assert.ok(has('fetch:start'), 'fetch:start');
  assert.ok(has('fetch:response', (d) => d.status === 200 && /pdf/.test(d.contentType)), 'fetch:response');
  assert.ok(has('body:read', (d) => d.isPdf && d.size === PDF.length && d.source === 'fetch.blob'), 'body:read pdf');
  assert.ok(has('body:read', (d) => !d.isPdf && /Session/.test(d.magic)), 'body:read faux pdf');
  assert.ok(has('body:read', (d) => d.isPdf && d.source === 'xhr.arraybuffer'), 'body:read xhr');
  assert.ok(has('blob:url', (d) => /^blob:/.test(d.url) && /pdf/.test(d.mime)), 'blob:url');
  assert.ok(has('dom:add', (d) => d.tag === 'IFRAME' && /^blob:/.test(d.src)), 'dom:add');
  assert.ok(has('frame:load', (d) => d.tag === 'IFRAME' && d.docContentType === 'text/html'), 'frame:load (iframe HTML)');
  console.log('frame:load on the PDF iframe:', has('frame:load', (d) => /^blob:/.test(d.src) && d.docContentType !== 'text/html') ? 'yes' : 'no (expected in headless, without a PDF viewer)');
  assert.ok(has('print:call', (d) => d.via === 'window.print'), 'print:call');
  assert.ok(has('print:returned'), 'print:returned');
  assert.ok(has('open:call', (d) => d.url === 'about:blank'), 'open:call');
  assert.ok(has('js:error', (d) => /boom/.test(d.message)), 'js:error');
  assert.ok(has('gesture'), 'gesture');
  assert.ok(has('perf:resource'), 'perf:resource');

  // All of it fed to the analysis: the chain must be recognised end to end on the page side.
  const evs = events.map((e, i) => Object.assign({ n: i, src: 'page', tabId: 1 }, e));
  const first = evs.find((e) => e.type === 'fetch:start');
  evs.push({ n: 9001, t: first.t - 1, src: 'webRequest', type: 'wr:before', tabId: 1, data: { requestId: 'r1', url: first.data.url, method: 'GET', resourceType: 'xmlhttprequest' } });
  evs.push({ n: 9002, t: first.t + 5, src: 'webRequest', type: 'wr:headers', tabId: 1, data: { requestId: 'r1', url: first.data.url, statusCode: 200, contentType: 'application/pdf', headers: { 'content-type': 'application/pdf' } } });
  evs.push({ n: 9003, t: first.t + 8, src: 'webRequest', type: 'wr:completed', tabId: 1, data: { requestId: 'r1', url: first.data.url, statusCode: 200 } });
  const a = A.analyze({ events: evs }, { candidateId: 'wr:r1' });
  console.log('\n' + A.toText(a));
  ['js-response', 'body', 'blob-url', 'frame-created', 'print-call'].forEach((id) => {
    const s = a.steps.find((x) => x.id === id);
    assert.ok(/^(ok|warn)$/.test(s.status), id + ' = ' + s.status);
  });
  console.log('\nOK — inject.js emits all the expected events in Chromium');
})().catch((e) => { console.error(e); process.exit(1); });
