'use strict';
const assert = require('assert');
const A = require('../analysis.js');

const URL_PDF = 'https://app.test/api/doc.pdf?id=1';
const BLOB = 'blob:https://app.test/abc-123';
let n = 0;
const E = (t, src, type, data, extra) => Object.assign({ t, n: ++n, src, type, tabId: 5, data: data || {} }, extra || {});
const wr = (t, type, data) => E(t, 'webRequest', type, Object.assign({ requestId: '1', url: URL_PDF, method: 'GET', resourceType: 'xmlhttprequest', frameId: 0, initiator: 'https://app.test' }, data));
const pg = (t, type, data) => E(t, 'page', type, data, { top: true });
const okAct = { isActive: true, hasFocus: true, visibility: 'visible', gestureAgeMs: 300, top: true };

function happy() {
  return [
    pg(990, 'env', { pdfViewerEnabled: true, online: true }),
    pg(998, 'fetch:start', { id: 1, url: URL_PDF }),
    wr(1000, 'wr:before'), wr(1002, 'wr:sent'),
    wr(1100, 'wr:headers', { statusCode: 200, contentType: 'application/pdf', headers: { 'content-type': 'application/pdf', 'content-length': '1000' } }),
    wr(1500, 'wr:completed', { statusCode: 200, ip: '1.2.3.4' }),
    pg(1110, 'fetch:response', { id: 1, url: URL_PDF, finalUrl: URL_PDF, status: 200, ok: true, contentType: 'application/pdf', ms: 112 }),
    // body:read is emitted after createObjectURL but timestamped at resolution
    pg(1520, 'body:read', { source: 'fetch.blob', url: URL_PDF, size: 1000, mime: 'application/pdf', isPdf: true, magic: '%PDF-1.7' }),
    pg(1525, 'blob:url', { url: BLOB, size: 1000, mime: 'application/pdf' }),
    pg(1530, 'dom:add', { tag: 'IFRAME', src: BLOB, sandbox: null }),
    pg(1700, 'frame:load', { tag: 'IFRAME', src: BLOB, docContentType: 'application/pdf' }),
    pg(1800, 'print:call', { via: 'window.print', act: okAct }),
    pg(1801, 'print:before', {}),
    pg(5000, 'print:after', {})
  ];
}
const status = (a, id) => a.steps.find((s) => s.id === id).status;

// 1. complete chain
{
  const a = A.analyze({ events: happy() });
  assert.strictEqual(a.candidates.length, 1);
  assert.strictEqual(a.verdict.level, 'ok', a.verdict.title);
  ['request', 'headers', 'complete', 'js-response', 'body', 'blob-url', 'frame-created', 'frame-load', 'viewer', 'print-call', 'dialog', 'after-print']
    .forEach((id) => assert.strictEqual(status(a, id), 'ok', id));
  assert.strictEqual(status(a, 'popup'), 'na');
  assert.ok(/without any anomaly/.test(a.verdict.title));
}

// 2. print() never called + JS error
{
  const evs = happy().filter((e) => !/^print:/.test(e.type));
  evs.push(pg(1900, 'js:error', { message: 'x is not a function', file: 'https://app.test/app.js', line: 12 }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.level, 'stall');
  assert.strictEqual(a.verdict.stepId, 'print-call');
  assert.ok(/x is not a function/.test(a.verdict.detail));
}

// 3. network: headers received but stream never finished
{
  const evs = [
    wr(1000, 'wr:before'),
    wr(1100, 'wr:headers', { statusCode: 200, contentType: 'application/pdf', headers: { 'content-type': 'application/pdf' } }),
    pg(30000, 'focus:blur', {})
  ];
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.level, 'fail');
  assert.strictEqual(a.verdict.stepId, 'complete');
  assert.strictEqual(status(a, 'body'), 'skipped');
}

// 4. network: Chrome error during download
{
  const evs = [
    wr(1000, 'wr:before'),
    wr(1100, 'wr:headers', { statusCode: 200, contentType: 'application/pdf', headers: { 'content-type': 'application/pdf' } }),
    wr(1600, 'wr:error', { error: 'net::ERR_CONTENT_LENGTH_MISMATCH' })
  ];
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'complete');
  assert.ok(/truncated/.test(a.verdict.hint));
}

// 5. window.open blocked: gesture too old
{
  const evs = happy().filter((e) => !/^(dom:add|frame:load|print:)/.test(e.type));
  evs.push(pg(7200, 'open:call', { url: BLOB, blocked: true, act: { isActive: false, gestureAgeMs: 7000, hasFocus: true, visibility: 'visible' } }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.level, 'fail');
  assert.strictEqual(a.verdict.stepId, 'popup');
  assert.ok(/7000 ms/.test(a.verdict.detail));
  assert.ok(/5 s/.test(a.verdict.detail + a.verdict.hint));
}

// 6. the server returns HTML (200) instead of the PDF
{
  const evs = happy().map((e) => (e.type === 'body:read' ? Object.assign({}, e, { data: Object.assign({}, e.data, { isPdf: false, magic: '<!DOCTYPE html><html>' }) }) : e));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'body');
  assert.ok(/HTML/.test(a.verdict.hint));
}

// 7. sandboxed iframe without allow-modals → reservation
{
  const evs = happy().map((e) => (e.type === 'dom:add' ? Object.assign({}, e, { data: Object.assign({}, e.data, { sandbox: 'allow-scripts' }) }) : e));
  const a = A.analyze({ events: evs });
  assert.strictEqual(status(a, 'frame-created'), 'warn');
  assert.strictEqual(a.verdict.level, 'warn');
}

// 8. Blob revoked before print()
{
  const evs = happy();
  evs.push(pg(1600, 'blob:revoke', { url: BLOB }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'blob-url');
}

// 9. PDF downloaded instead of displayed
{
  const evs = happy().filter((e) => !/^(frame:load|print:)/.test(e.type));
  evs.push(E(1600, 'download', 'dl:created', { url: BLOB, mime: 'application/pdf', filename: '/tmp/doc.pdf' }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'viewer');
}

// 10. viewer disabled
{
  const evs = happy().filter((e) => !/^(frame:load|print:)/.test(e.type)).map((e) => (e.type === 'env' ? Object.assign({}, e, { data: { pdfViewerEnabled: false } }) : e));
  evs.push(pg(1700, 'frame:load', { tag: 'IFRAME', src: BLOB, docContentType: 'text/html' }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'viewer');
  assert.ok(a.diagnostics.some((d) => /pdfViewerEnabled/.test(d.text)));
}

// 11. suspicious delay between two steps
{
  const evs = happy().map((e) => (e.type === 'print:call' ? Object.assign({}, e, { t: 9000 }) : e));
  const a = A.analyze({ events: evs });
  assert.ok(a.steps.find((s) => s.id === 'print-call').slow);
  assert.strictEqual(a.verdict.level, 'warn');
}

// 12. attached popup (other tab) + print in the popup
{
  const evs = happy().filter((e) => !/^(dom:add|frame:load|print:)/.test(e.type));
  evs.push(pg(1530, 'open:call', { url: BLOB, blocked: false, act: okAct }));
  evs.push(E(1540, 'webNavigation', 'wn:committed', { frameId: 0, url: BLOB }, { tabId: 9 }));
  evs.push(E(1700, 'webNavigation', 'wn:completed', { frameId: 0, url: BLOB }, { tabId: 9 }));
  evs.push(E(1800, 'page', 'print:call', { via: 'window.print', act: okAct }, { tabId: 9, top: true }));
  evs.push(E(1801, 'page', 'print:before', {}, { tabId: 9, top: true }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(status(a, 'popup'), 'ok');
  assert.strictEqual(status(a, 'frame-created'), 'ok');
  assert.strictEqual(status(a, 'frame-load'), 'ok');
  assert.strictEqual(status(a, 'print-call'), 'ok');
}

// 13. several attempts: analyse the last one without mixing in the first one's events
{
  const first = happy();
  const second = happy().map((e) => Object.assign({}, e, { t: e.t + 100000, data: Object.assign({}, e.data, e.data.requestId ? { requestId: '2' } : {}) }));
  const evs = first.concat(second.filter((e) => !/^print:/.test(e.type)));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.candidates.length, 2);
  assert.strictEqual(a.verdict.stepId, 'print-call');            // dernier essai : print absent
  const a1 = A.analyze({ events: evs }, { candidateId: a.candidates[0].id });
  assert.strictEqual(a1.verdict.level, 'ok');                    // premier essai : intact
}

// 14. empty trace / no PDF
{
  const a = A.analyze({ events: [pg(1, 'env', {})] });
  assert.strictEqual(a.verdict.level, 'none');
}

// 15. text report + URL parameter masking
{
  const txt = A.toText(A.analyze({ events: happy() }));
  assert.ok(/VERDICT/.test(txt) && /print\(\) called/.test(txt));
  assert.ok(!/id=1/.test(A.redact(txt)));
}

// ---------- newer signals: advanced mode, Workers, cross-origin ----------
const cd = (t, type, data) => E(t, 'cdp', type, data);

// 16. print() refused by Chrome (sandboxed frame): the browser message takes precedence over the page hook
{
  const evs = happy();
  evs.push(cd(1802, 'cdp:log', { level: 'error', text: "Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set." }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.level, 'fail');
  assert.strictEqual(a.verdict.stepId, 'print-call');
  assert.ok(/allow-modals/.test(a.verdict.hint));
}

// 17. print() never observed on the page side, but Chrome reports a cross-origin access (advanced mode)
{
  const evs = happy().filter((e) => !/^print:/.test(e.type));
  evs.push(pg(1790, 'iframe:contentWindow', { crossOrigin: true, target: { src: 'https://other.test/doc.pdf' } }));
  evs.push(cd(1800, 'cdp:exception', { text: 'SecurityError: Blocked a frame with origin "https://app.test" from accessing a cross-origin frame.' }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'print-call');
  assert.strictEqual(a.verdict.level, 'fail');
  assert.ok(/postMessage/.test(a.verdict.hint));
}

// 18. cross-origin contentWindow access observed on the page side, no error or print: targeted hint
{
  const evs = happy().filter((e) => !/^print:/.test(e.type));
  evs.push(pg(1790, 'iframe:contentWindow', { crossOrigin: true, target: { src: 'https://other.test/doc.pdf' } }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.level, 'stall');
  assert.ok(/another origin/.test(a.verdict.hint));
}

// 19. request sent by a Service Worker: JavaScript steps are "not applicable", not "missing"
{
  const w = (e) => Object.assign({}, e, { worker: true });
  const evs = [
    w(wr(1000, 'wr:before')), w(wr(1100, 'wr:headers', { statusCode: 200, contentType: 'application/pdf', headers: { 'content-type': 'application/pdf' } })), w(wr(1500, 'wr:completed', {})),
    pg(1600, 'blob:url', { url: BLOB, size: 1000, mime: 'application/pdf' }),
    pg(1610, 'dom:add', { tag: 'IFRAME', src: BLOB, sandbox: null }),
    pg(1700, 'frame:load', { tag: 'IFRAME', src: BLOB, docContentType: 'application/pdf' }),
    pg(1800, 'print:call', { via: 'window.print', act: okAct }), pg(1801, 'print:before', {})
  ];
  const a = A.analyze({ events: evs });
  assert.strictEqual(status(a, 'js-response'), 'na');
  assert.strictEqual(status(a, 'body'), 'na');
  assert.notStrictEqual(a.verdict.level, 'stall');
  assert.ok(a.diagnostics.some((d) => /Worker/.test(d.text)));
}

// 20. network blocking reason supplied by the debugger (CSP) while webRequest sees nothing more
{
  const evs = [wr(1000, 'wr:before'), cd(1010, 'cdp:loadingFailed', { url: URL_PDF, errorText: 'net::ERR_BLOCKED_BY_CSP', blockedReason: 'csp', canceled: false })];
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'headers');
  assert.ok(/Content-Security-Policy/.test(a.verdict.hint));
}

// 21. cookies blocked on the PDF request: reservation + diagnostic
{
  const evs = happy();
  evs.push(cd(1005, 'cdp:cookiesBlocked', { direction: 'request', url: URL_PDF, cookies: [{ name: 'sid', domain: 'app.test', reasons: ['SameSiteLax'] }] }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(status(a, 'headers'), 'warn');
  assert.ok(a.steps.find((s) => s.id === 'headers').notes.some((n) => /sid/.test(n)));
  assert.ok(a.diagnostics.some((d) => /cookie/.test(d.text)));
}

// 22. PDF viewer frame seen by the debugger: "viewer" step confirmed
{
  const evs = happy().filter((e) => e.type !== 'frame:load');
  evs.push(pg(1700, 'frame:load', { tag: 'IFRAME', src: BLOB, docContentType: null }));
  evs.push(cd(1650, 'cdp:target', { type: 'iframe', url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(status(a, 'viewer'), 'ok');
}

// 23. window.open: the debugger confirms the lack of a user gesture
{
  const evs = happy().filter((e) => !/^(dom:add|frame:load|print:)/.test(e.type));
  evs.push(pg(7200, 'open:call', { url: BLOB, blocked: true, act: { isActive: false, gestureAgeMs: 7000 } }));
  evs.push(cd(7201, 'cdp:windowOpen', { url: BLOB, userGesture: false }));
  const a = A.analyze({ events: evs });
  assert.strictEqual(a.verdict.stepId, 'popup');
  assert.ok(/userGesture = false/.test(a.verdict.detail));
}

// 24. another PDF request follows very quickly (< 200 ms): the window of the first one must not be empty
{
  const evs = happy().concat([
    wr(1300, 'wr:before', { requestId: '9', url: 'https://app.test/api/other.pdf' }),
    wr(1310, 'wr:completed', { requestId: '9', url: 'https://app.test/api/other.pdf', statusCode: 200 })
  ]);
  const a = A.analyze({ events: evs });
  const first = A.analyze({ events: evs }, { candidateId: a.candidates[0].id });
  assert.strictEqual(status(first, 'js-response'), 'ok');
}

// 25. a Service Worker request in parallel does not cut the page chain
{
  const evs = happy().concat([
    wr(1200, 'wr:before', { requestId: '8', url: 'https://app.test/api/doc.pdf?from=sw' }, ),
    wr(1250, 'wr:completed', { requestId: '8', url: 'https://app.test/api/doc.pdf?from=sw', statusCode: 200 })
  ].map((e) => Object.assign(e, { worker: true })));
  const a = A.analyze({ events: evs }, { candidateId: 'wr:1' });
  assert.strictEqual(a.verdict.level, 'ok');
  assert.strictEqual(status(a, 'print-call'), 'ok');
}

console.log('OK — all scenarios pass');
