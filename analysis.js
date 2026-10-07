/*
 * PDF Print Tracer — trace analysis.
 * Rebuilds the "pipeline" between the PDF's HTTP response and the print dialog,
 * and points at the first step that fails or is never observed.
 * Works in the browser (global PdfTraceAnalysis) and under Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfTraceAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PDF_URL_RE = /\.pdf(?:[?#]|$)/i;
  const VIEWER_RE = /mhjfbmdgcfjbbpaeojofohoefgiehjai|chrome-untrusted:\/\/pdf|chrome:\/\/pdf-viewer/i;
  const FRAMEY = /^(IFRAME|EMBED|OBJECT)$/;
  const isPdfCT = (ct) => /pdf/i.test(ct || '');
  const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch (_) { return String(u || '').split('#')[0]; } };
  const short = (u, n) => { u = String(u || ''); n = n || 90; return u.length > n ? u.slice(0, n - 1) + '…' : u; };
  const sortEvents = (evs) => evs.slice().sort((a, b) => (a.t - b.t) || ((a.n || 0) - (b.n || 0)));
  // a may have been truncated ("…") by the instrumentation: compare the prefix in that case.
  const sameUrl = (a, b) => !!a && !!b && (a === b || (a.endsWith('…') && b.startsWith(a.slice(0, -1))));

  const NET_ERRORS = {
    'net::ERR_BLOCKED_BY_CLIENT': 'Request blocked on the client side: an extension (ad blocker, antivirus/web security, corporate filter) cut the request.',
    'net::ERR_BLOCKED_BY_RESPONSE': 'Blocked by the response itself (X-Frame-Options, CSP frame-ancestors, Cross-Origin-Resource-Policy…).',
    'net::ERR_ABORTED': 'Request aborted: navigation interrupted, frame removed by the script, or response turned into a download (Content-Disposition: attachment).',
    'net::ERR_CONNECTION_RESET': 'Connection reset midway: a firewall, proxy or antivirus cutting the stream, or the server closing the connection.',
    'net::ERR_CONNECTION_CLOSED': 'Connection closed prematurely (proxy/firewall/antivirus or server).',
    'net::ERR_CONNECTION_TIMED_OUT': 'Connection timed out: host unreachable or filtered by the network.',
    'net::ERR_TIMED_OUT': 'Timed out: very slow or filtered network.',
    'net::ERR_NAME_NOT_RESOLVED': 'DNS resolution failed for this host.',
    'net::ERR_INTERNET_DISCONNECTED': 'The computer is offline.',
    'net::ERR_PROXY_CONNECTION_FAILED': 'Could not connect to the proxy.',
    'net::ERR_TUNNEL_CONNECTION_FAILED': 'Proxy tunnel (CONNECT) refused: the proxy blocks this domain.',
    'net::ERR_CONTENT_LENGTH_MISMATCH': 'Received length ≠ Content-Length: stream truncated by a proxy, an antivirus or the server.',
    'net::ERR_INCOMPLETE_CHUNKED_ENCODING': 'Chunked response interrupted: truncated stream (proxy, antivirus or server).',
    'net::ERR_HTTP2_PROTOCOL_ERROR': 'HTTP/2 protocol error: often a proxy / SSL inspection mishandling the stream.',
    'net::ERR_QUIC_PROTOCOL_ERROR': 'QUIC/HTTP3 error: a firewall blocking UDP/443.',
    'net::ERR_SSL_PROTOCOL_ERROR': 'TLS error: a proxy\'s SSL inspection, or an invalid certificate/protocol.'
  };
  function explainNetError(err) {
    if (!err) return '';
    if (NET_ERRORS[err]) return NET_ERRORS[err];
    if (/^net::ERR_CERT_/.test(err)) return 'TLS certificate problem (corporate CA not installed, SSL inspection, wrong system date).';
    if (/^net::ERR_SSL_/.test(err)) return 'TLS error (SSL inspection, server configuration).';
    return 'Chrome network error "' + err + '".';
  }
  // Blocking reasons reported by the debugger (Network.loadingFailed.blockedReason / corsErrorStatus).
  const BLOCKED = {
    csp: 'Blocked by the page\'s Content-Security-Policy (connect-src / frame-src / object-src…).',
    'mixed-content': 'Mixed content: an http resource loaded from an https page.',
    origin: 'Blocked by the origin policy (CORS or Private Network Access).',
    inspector: 'Blocked by a developer tool.',
    'subresource-filter': 'Blocked by Chrome\'s built-in subresource filter (ad-blocker style).',
    'content-type': 'Content type refused (X-Content-Type-Options: nosniff).',
    'collapsed-by-client': 'Element collapsed by the client (content blocker).'
  };
  function explainBlocked(d) {
    const out = [];
    if (d.blockedReason) {
      out.push(BLOCKED[d.blockedReason] || (/^(corp|coep|coop)/.test(d.blockedReason)
        ? 'Blocked by a Cross-Origin policy (CORP / COEP / COOP): ' + d.blockedReason + '.'
        : 'Blocked by Chrome: ' + d.blockedReason + '.'));
    }
    if (d.cors) out.push('CORS error: ' + d.cors + '.');
    return out.join(' ');
  }

  /* ---------- candidates: which PDF to analyse? ---------- */
  function groupFlows(evs) {
    const flows = new Map();
    for (const e of evs) {
      if (e.src !== 'webRequest') continue;
      const d = e.data || {};
      let f = flows.get(d.requestId);
      if (!f) {
        f = { requestId: d.requestId, tabId: e.tabId, frameId: d.frameId, method: d.method, resourceType: d.resourceType, firstUrl: d.url, url: d.url, urls: [], events: [], contentType: null, t: e.t };
        flows.set(d.requestId, f);
      }
      f.events.push(e);
      if (d.url) { f.url = d.url; if (f.urls.indexOf(d.url) === -1) f.urls.push(d.url); }
      if (d.contentType) f.contentType = d.contentType;
    }
    return Array.from(flows.values());
  }

  function findCandidates(evs) {
    const out = [];
    for (const f of groupFlows(evs)) {
      if (isPdfCT(f.contentType) || PDF_URL_RE.test(f.url) || PDF_URL_RE.test(f.firstUrl)) {
        out.push({
          id: 'wr:' + f.requestId, kind: 'request', requestId: f.requestId, tabId: f.tabId,
          resourceType: f.resourceType, url: f.url, urls: f.urls, t: f.t, flow: f,
          worker: f.events.some((e) => e.worker),
          label: (f.method || 'GET') + ' ' + short(f.url, 80) + ' [' + f.resourceType + ']'
        });
      }
    }
    if (!out.length) {
      evs.forEach((e, i) => {
        if (e.src === 'page' && e.type === 'body:read' && e.data && e.data.isPdf) {
          out.push({ id: 'body:' + i, kind: 'body', requestId: null, tabId: e.tabId, resourceType: 'other', url: e.data.url, urls: [e.data.url], t: e.t, flow: null, label: 'PDF read in JavaScript: ' + short(e.data.url, 80) });
        }
      });
    }
    if (!out.length) {
      evs.forEach((e, i) => {
        if (e.src === 'page' && e.type === 'blob:url' && /pdf/i.test((e.data && e.data.mime) || '')) {
          out.push({ id: 'blob:' + i, kind: 'blob', requestId: null, tabId: e.tabId, resourceType: 'other', url: e.data.url, urls: [e.data.url], t: e.t, flow: null, label: 'PDF Blob: ' + short(e.data.url, 80) });
        }
      });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /* ---------- reading helpers ---------- */
  function fmtErr(e) {
    const d = e.data || {};
    if (e.type === 'js:error') return 'JS error: ' + short(d.message, 120) + (d.file ? ' (' + short(d.file, 60) + ':' + d.line + ')' : '');
    if (e.type === 'js:rejection') return 'Promise rejected: ' + short(d.reason, 140);
    if (e.type === 'csp:violation') return 'CSP: "' + (d.effectiveDirective || d.violatedDirective) + '" blocks ' + short(d.blockedURI, 80);
    if (e.type === 'resource:error') return 'Load failure ' + d.tag + ' ' + short(d.src, 80);
    if (e.type === 'cdp:exception') return 'Exception (Chrome): ' + short(d.text, 140);
    if (e.type === 'cdp:log' || e.type === 'cdp:console') return 'Browser console: ' + short(d.text, 140);
    return e.type;
  }
  function actNotes(a, forOpen) {
    const n = [];
    if (!a) return n;
    const age = a.gestureAgeMs == null ? 'unknown' : a.gestureAgeMs + ' ms';
    if (forOpen) {
      if (a.isActive === false) n.push('No transient user activation when window.open was called (last gesture in this frame: ' + age + '). Chrome blocks popups outside a recent gesture (~5 s).');
      else if (a.gestureAgeMs != null && a.gestureAgeMs > 4500) n.push('Last user gesture was ' + age + ' ago: close to the expiry of the transient activation (~5 s).');
    } else if (a.isActive != null) {
      n.push('User activation when print() was called: ' + (a.isActive ? 'active' : 'inactive') + ' (last gesture: ' + age + ').');
    }
    if (a.hasFocus === false) n.push('The document did not have focus.');
    if (a.visibility && a.visibility !== 'visible') n.push('Tab/frame not visible (' + a.visibility + ').');
    return n;
  }

  /* ---------- pipeline ---------- */
  function buildSteps(tr, evs, cand, tEnd) {
    const t0 = cand.t;
    const env = tr.env || {};
    const win = evs.filter((e) => e.t >= t0 - 2000 && e.t <= tEnd);
    const lastT = evs.length ? evs[evs.length - 1].t : t0;
    const urls = cand.urls && cand.urls.length ? cand.urls : [cand.url];
    const urlIs = (u) => !!u && urls.some((x) => norm(x) === norm(u));
    const wrEv = (type) => (cand.flow ? cand.flow.events.filter((e) => e.type === type) : []);
    const pg = (type, pred) => win.filter((e) => e.src === 'page' && e.type === type && (!pred || pred(e.data || {}, e)));
    const wnEv = (type, pred) => win.filter((e) => e.src === 'webNavigation' && e.type === type && (!pred || pred(e.data || {}, e)));

    /* network */
    const before = wrEv('wr:before')[0] || wrEv('wr:sent')[0];
    const hdr = wrEv('wr:headers').slice(-1)[0] || wrEv('wr:started').slice(-1)[0];
    const netErr = wrEv('wr:error').slice(-1)[0];
    const done = wrEv('wr:completed').slice(-1)[0];
    // Advanced-mode (debugger) signals: network blocking reasons, blocked cookies.
    const cdp = (type, pred) => win.filter((e) => e.src === 'cdp' && e.type === type && (!pred || pred(e.data || {}, e)));
    const loadFail = cdp('cdp:loadingFailed', (d) => urlIs(d.url))[0];
    const netFail = (netErr || loadFail) ? {
      ev: netErr || loadFail,
      text: [netErr && netErr.data.error, loadFail && (loadFail.data.blockedReason ? 'blocked (' + loadFail.data.blockedReason + ')' : loadFail.data.errorText)].filter(Boolean).join(' / '),
      hint: [loadFail ? explainBlocked(loadFail.data) : '', netErr ? explainNetError(netErr.data.error) : ''].filter(Boolean).join(' ')
    } : null;
    const cookiesBlocked = cdp('cdp:cookiesBlocked', (d) => urlIs(d.url));

    /* JavaScript: response + body */
    const fr = pg('fetch:response', (d) => urlIs(d.url) || urlIs(d.finalUrl))[0];
    const xl = pg('xhr:load', (d) => urlIs(d.url))[0];
    const fe = pg('fetch:error', (d) => urlIs(d.url))[0];
    const xe = pg('xhr:error', (d) => urlIs(d.url))[0];
    const jsResp = fr || xl;
    const jsErr = fe || xe;
    let body = pg('body:read', (d) => urlIs(d.url))[0];
    let bodyApprox = false;
    if (!body && (jsResp || hdr)) {
      body = pg('body:read', (d, e) => e.t >= (jsResp ? jsResp.t : t0))[0];
      bodyApprox = !!body;
    }
    const bodyErr = pg('body:error', (d) => urlIs(d.url) || !d.url)[0];
    const bodyT = body ? body.t : (jsResp ? jsResp.t : t0);

    /* blob URL */
    const blobs = pg('blob:url', (d, e) => e.t >= bodyT - 50);
    const blob = blobs.find((e) => /pdf/i.test(e.data.mime || '') || (body && e.data.size === body.data.size)) || blobs[0];
    const blobUrl = blob ? blob.data.url : null;
    const revoke = blob ? pg('blob:revoke', (d) => d.url === blobUrl)[0] : null;

    /* popup */
    const opens = pg('open:call', (d, e) => e.t >= t0);
    const open = opens.find((e) => e.data.blocked) || opens[0];
    const popupNav = open && !open.data.blocked
      ? wnEv('wn:committed', (d, e) => e.tabId !== cand.tabId && d.frameId === 0 && e.t >= open.t - 50)[0] : null;
    const popupDone = popupNav ? wnEv('wn:completed', (d, e) => e.tabId === popupNav.tabId && d.frameId === 0 && e.t >= popupNav.t)[0] : null;

    /* display frame */
    const srcOf = (e) => (e.type === 'dom:add' ? e.data.src : e.data.value);
    const domEvs = win.filter((e) => e.src === 'page' &&
      ((e.type === 'dom:add' && FRAMEY.test(e.data.tag)) || (e.type === 'dom:attr' && FRAMEY.test(e.data.tag) && /^(src|data)$/.test(e.data.attr))));
    const isOurSrc = (s) => !!s && ((blobUrl && sameUrl(s, blobUrl)) || urls.some((u) => sameUrl(s, u)));
    let domEv = domEvs.find((e) => isOurSrc(srcOf(e)));
    if (!domEv) domEv = domEvs.find((e) => e.t >= bodyT && /^(blob:|data:application\/pdf)/i.test(srcOf(e) || ''));
    const domSrc = domEv ? srcOf(domEv) : null;
    const frameLoad = domSrc ? pg('frame:load', (d) => sameUrl(d.src, domSrc) || sameUrl(domSrc, d.src))[0] : null;
    const wnDone = domSrc ? wnEv('wn:completed', (d) => d.frameId !== 0 && sameUrl(domSrc, d.url))[0] : null;
    const wnErr = wnEv('wn:error', (d, e) => (domSrc && sameUrl(domSrc, d.url)) || (popupNav && e.tabId === popupNav.tabId))[0];
    const resErr = domSrc ? pg('resource:error', (d) => sameUrl(d.src, domSrc))[0] : null;
    const loadedEv = frameLoad || wnDone || popupDone;

    /* PDF viewer, download */
    const viewerFrom = domEv ? domEv.t : (open ? open.t : t0);
    const viewerEv = win.find((e) => e.t >= viewerFrom && (
      (e.src === 'cdp' && e.type === 'cdp:target' && VIEWER_RE.test((e.data && e.data.url) || '')) ||
      (e.src === 'webNavigation' && VIEWER_RE.test((e.data && e.data.url) || '')) ||
      (e.src === 'page' && e.type === 'doc:state' && /pdf/i.test((e.data && e.data.contentType) || '')) ||
      (e.src === 'page' && e.type === 'frame:load' && /pdf/i.test((e.data && e.data.docContentType) || '')) ||
      (e.src === 'page' && e.type === 'dom:add' && e.data.tag === 'EMBED' && /pdf/i.test(e.data.type || ''))));
    const dl = win.find((e) => e.src === 'download' && e.type === 'dl:created' &&
      (/pdf/i.test(e.data.mime || '') || /\.pdf(\?|$)/i.test(e.data.filename || '') || urlIs(e.data.url) || urlIs(e.data.finalUrl)));
    const penv = evs.find((e) => e.src === 'page' && e.type === 'env' && e.top);
    const pdfViewerEnabled = penv ? penv.data.pdfViewerEnabled : null;

    /* printing */
    const printCall = pg('print:call')[0];
    const printRet = printCall ? win.find((e) => e.src === 'page' && e.type === 'print:returned' && e.t >= printCall.t) : null;
    const anyBefore = pg('print:before')[0];
    const printAfter = anyBefore ? win.find((e) => e.src === 'page' && e.type === 'print:after' && e.t >= anyBefore.t) : null;
    const errList = pg('js:error').concat(pg('js:rejection'), pg('csp:violation'), pg('resource:error'), cdp('cdp:exception')).sort((a, b) => a.t - b.t);
    // Explicit refusals from Chrome (advanced mode) and accesses to cross-origin frames.
    const printLogs = win.filter((e) => e.src === 'cdp' && /^cdp:(log|console|exception)$/.test(e.type) &&
      /print\(\)|window\.print|cross-origin frame/i.test((e.data && e.data.text) || '') && e.t >= t0);
    const cwAcc = pg('iframe:contentWindow');
    const crossAcc = cwAcc.find((e) => e.data.crossOrigin);
    const errText = (e) => (e.data && (e.data.message || e.data.reason || e.data.text)) || '';
    const crossErr = errList.find((e) => /cross-origin|SecurityError|Blocked a frame/i.test(errText(e)));

    /* ---------- assembly ---------- */
    const steps = [];
    const add = (id, label, where, status, ev, detail, notes, hint) => {
      steps.push({ id, n: steps.length + 1, label, where, status, t: ev ? ev.t : null, rel: ev ? ev.t - t0 : null, detail: detail || '', notes: notes || [], hint: hint || '', gap: null, slow: false });
      return steps[steps.length - 1];
    };

    // 1. request
    if (cand.flow && before) {
      add('request', 'HTTP request sent', 'webRequest.onBeforeRequest', 'ok', before,
        before.data.method + ' ' + short(before.data.url, 140) + ' (type ' + before.data.resourceType + ', initiator ' + (before.data.initiator || '?') + ')');
    } else if (cand.flow) {
      add('request', 'HTTP request sent', 'webRequest.onBeforeRequest', 'ok', cand.flow.events[0], short(cand.url, 140));
    } else {
      add('request', 'HTTP request sent', 'webRequest.onBeforeRequest', 'missing', null, 'No network event associated with this PDF.', [],
        'The trace may have started after the request (restart recording, then reload the page), or the request comes from a Worker of another origin than the tab (cannot be attached).');
    }

    // 2. response headers
    if (hdr) {
      const d = hdr.data;
      const h = d.headers || {};
      const ct = h['content-type'] || d.contentType || '';
      const notes = [];
      let status = 'ok';
      if (d.statusCode >= 400) status = 'fail';
      if (!isPdfCT(ct)) { notes.push('Content-Type = "' + (ct || 'missing') + '" (≠ application/pdf).'); if (status === 'ok') status = 'warn'; }
      if (h['content-disposition'] && /attachment/i.test(h['content-disposition'])) {
        notes.push('Content-Disposition: ' + h['content-disposition'] + ' → Chrome downloads the PDF instead of displaying it in a frame/tab.'); if (status === 'ok') status = 'warn';
      }
      const framed = d.resourceType === 'sub_frame' || d.resourceType === 'object';
      if (framed && h['x-frame-options']) { notes.push('X-Frame-Options: ' + h['x-frame-options'] + ' (may forbid display in an iframe).'); if (status === 'ok') status = 'warn'; }
      if (framed && /frame-ancestors/i.test(h['content-security-policy'] || '')) { notes.push('CSP frame-ancestors present (may forbid the iframe).'); if (status === 'ok') status = 'warn'; }
      if (/(^|[;\s])sandbox(\s|;|$)/i.test(h['content-security-policy'] || '')) { notes.push('CSP "sandbox" on the PDF: the PDF viewer does not render inside a sandboxed document.'); if (status === 'ok') status = 'warn'; }
      if (/nosniff/i.test(h['x-content-type-options'] || '') && !isPdfCT(ct)) notes.push('X-Content-Type-Options: nosniff with a non-PDF type.');
      cookiesBlocked.forEach((c) => {
        notes.push('Cookies blocked (' + c.data.direction + '): ' + (c.data.cookies || []).map((k) => (k.name || '?') + ' [' + (k.reasons || []).join(', ') + ']').join(', ') + ' → the response may differ (login page instead of the PDF).');
        if (status === 'ok') status = 'warn';
      });
      add('headers', 'Response headers received', 'webRequest.onHeadersReceived', status, hdr,
        'HTTP ' + d.statusCode + ' · ' + (ct || 'no Content-Type') + (h['content-length'] ? ' · ' + h['content-length'] + ' bytes' : '') + (d.fromCache ? ' · from cache' : ''),
        notes, d.statusCode >= 400 ? 'The server answers with an HTTP error: this is not a printing problem but a problem accessing the document (expired session, permissions, route).' : '');
    } else if (netFail) {
      add('headers', 'Response headers received', 'webRequest.onHeadersReceived', 'fail', netFail.ev, 'Network error before any response: ' + netFail.text, [], netFail.hint);
    } else {
      add('headers', 'Response headers received', 'webRequest.onHeadersReceived', 'missing', null,
        'No HTTP response received.', [], 'The request was sent but the server never answered (network, proxy, firewall) or the trace stopped too early.');
    }

    // 3. complete response
    if (done) {
      const dur = done.t - (before ? before.t : t0);
      const notes = [];
      let status = 'ok';
      if (dur > 8000) { status = 'warn'; notes.push('Very slow download (' + dur + ' ms).'); }
      add('complete', 'Response body fully received (network)', 'webRequest.onCompleted', status, done,
        'Completed in ' + dur + ' ms' + (done.data.ip ? ' · server ' + done.data.ip : '') + (done.data.fromCache ? ' · cache' : ''), notes);
    } else if (netFail && hdr) {
      add('complete', 'Response body fully received (network)', 'webRequest.onErrorOccurred', 'fail', netFail.ev, 'Error during download: ' + netFail.text, [], netFail.hint);
    } else if (netFail) {
      add('complete', 'Response body fully received (network)', 'webRequest.onCompleted', 'skipped', null, 'Not reached (failure at the previous step).');
    } else if (hdr && lastT - hdr.t > 15000) {
      add('complete', 'Response body fully received (network)', 'webRequest.onCompleted', 'fail', null,
        'The response started but never finished (no completion event more than ' + Math.round((lastT - hdr.t) / 1000) + ' s after the headers).', [],
        'Stream stuck midway: a proxy/firewall/antivirus holding or inspecting the file, an unstable network, or a server that does not send the end.');
    } else {
      add('complete', 'Response body fully received (network)', 'webRequest.onCompleted', 'missing', null,
        'End of download not observed.', [], 'Either the download is still in progress, or the trace was stopped before the end.');
    }

    // 4. response received by JavaScript
    if (jsErr) {
      const d = jsErr.data;
      add('js-response', 'Response received by JavaScript (fetch / XHR)', 'fetch / XMLHttpRequest', 'fail', jsErr,
        (jsErr.type === 'fetch:error' ? 'fetch rejected: ' + (d.name || '') + ' ' + (d.message || '') : 'XHR "' + d.kind + '"') + ' after ' + d.ms + ' ms', [],
        'On the browser side the request failed before the script received the response: CORS, mixed content, blocking extension, proxy, timeout, or abort() by the script.');
    } else if (jsResp) {
      const d = jsResp.data;
      const notes = [];
      let status = 'ok';
      const code = d.status;
      const ct = d.contentType || '';
      if (code >= 400) status = 'fail';
      if (!isPdfCT(ct) && status === 'ok') { status = 'warn'; notes.push('Content-Type seen by the script: "' + (ct || 'missing') + '".'); }
      if (jsResp.type === 'fetch:response' && (d.type === 'opaque' || d.type === 'opaqueredirect')) { status = status === 'fail' ? status : 'warn'; notes.push('Opaque response (' + d.type + '): body unreadable by the script (CORS).'); }
      add('js-response', 'Response received by JavaScript (fetch / XHR)', jsResp.type === 'fetch:response' ? 'fetch' : 'XMLHttpRequest', status, jsResp,
        'HTTP ' + code + ' · ' + (ct || 'no type') + ' · ' + (d.ms != null ? d.ms + ' ms' : ''), notes, code >= 400 ? 'The script receives an HTTP error.' : '');
    } else if (cand.worker) {
      add('js-response', 'Response received by JavaScript (fetch / XHR)', 'fetch / XMLHttpRequest', 'na', null,
        'Request sent by a Worker / Service Worker: the network is traced, but reception on the Worker\'s JavaScript side is not observable.');
    } else if (/^(xmlhttprequest|other)$/.test(cand.resourceType) && cand.kind === 'request') {
      add('js-response', 'Response received by JavaScript (fetch / XHR)', 'fetch / XMLHttpRequest', 'missing', null,
        'No matching fetch/XHR event on the page side.', [],
        done ? 'The network did deliver the PDF but the script did not see it: request made from an uninstrumented Worker/iframe, or page reloaded before the end.' : 'See the network steps.');
    } else {
      add('js-response', 'Response received by JavaScript (fetch / XHR)', 'fetch / XMLHttpRequest', 'na', null, 'PDF loaded directly by the browser (navigation / iframe), not via fetch/XHR.');
    }

    // 5. body reading
    if (bodyErr) {
      add('body', 'Body read as Blob / ArrayBuffer (%PDF signature)', 'Response.blob() / arrayBuffer() / XHR', 'fail', bodyErr,
        'Reading the body failed: ' + bodyErr.data.message, [], 'Stream interrupted while reading (network, proxy, abort).');
    } else if (body) {
      const d = body.data;
      const notes = [];
      let status = 'ok';
      let hint = '';
      if (bodyApprox) notes.push('Matched by time proximity (URL differs from the request).');
      if (!d.isPdf || !(d.size > 0)) {
        status = 'fail';
        hint = d.size === 0 ? 'Empty body: the server/proxy returned 0 bytes.' : 'The content does not start with "%PDF-": the server (or a proxy / captive portal / login page) returns something other than a PDF, e.g. an HTML page or a JSON error with a 200 status.';
      }
      add('body', 'Body read as Blob / ArrayBuffer (%PDF signature)', d.source, status, body,
        d.size + ' bytes' + (d.mime ? ' · Blob type "' + d.mime + '"' : '') + ' · starts with: "' + d.magic + '"', notes, hint);
    } else if (jsResp) {
      add('body', 'Body read as Blob / ArrayBuffer (%PDF signature)', 'Response.blob() / arrayBuffer() / XHR', 'missing', null,
        'Body never read via blob()/arrayBuffer().', [], 'The script may have read the body another way (text(), stream, FileReader) or never called the read after the response: check in the code.');
    } else if (cand.worker) {
      add('body', 'Body read as Blob / ArrayBuffer (%PDF signature)', 'Response.blob() / arrayBuffer() / XHR', 'na', null,
        'Body read inside a Worker: not observable (the Blob passed to the page is: see the next step).');
    } else if (/^(xmlhttprequest|other)$/.test(cand.resourceType) && cand.kind === 'request') {
      add('body', 'Body read as Blob / ArrayBuffer (%PDF signature)', 'Response.blob() / arrayBuffer() / XHR', 'missing', null,
        'No body read observed on the page side.', [], 'Depends on the previous step: as long as the script does not receive the response, the body is not read.');
    } else {
      add('body', 'Body read as Blob / ArrayBuffer (%PDF signature)', 'Response.blob() / arrayBuffer() / XHR', 'na', null, 'No JavaScript body read (native load).');
    }

    // 6. Blob URL
    if (blob) {
      const d = blob.data;
      const notes = [];
      let status = 'ok';
      let detail = d.url + ' · ' + d.size + ' bytes · type "' + (d.mime || '') + '"';
      if (!/pdf/i.test(d.mime || '')) { status = 'warn'; notes.push('Blob without an application/pdf type: Chrome\'s PDF viewer will not be used (blank display or download).'); }
      if (revoke) {
        const lag = revoke.t - blob.t;
        notes.push('URL revoked ' + lag + ' ms after its creation.');
        if (printCall && revoke.t < printCall.t) status = 'fail';
        else if (!printCall && lag < 1500 && status === 'ok') status = 'warn';
      }
      add('blob-url', 'Blob URL created', 'URL.createObjectURL', status, blob, detail, notes,
        status === 'fail' ? 'revokeObjectURL() is called before print(): the PDF no longer exists when printing starts (race caused by a slow network/frame).' : '');
    } else if (domEv && domSrc && !/^blob:/i.test(domSrc)) {
      add('blob-url', 'Blob URL created', 'URL.createObjectURL', 'na', null, 'The frame points directly at the server (no Blob).');
    } else {
      add('blob-url', 'Blob URL created', 'URL.createObjectURL', 'missing', null, 'No URL.createObjectURL after the body was read.', [], 'The PDF is not converted into a Blob URL (or reading the body did not complete).');
    }

    // 7. popup
    if (open) {
      const d = open.data;
      const notes = actNotes(d.act, true);
      const cdpOpen = cdp('cdp:windowOpen', (c, e) => Math.abs(e.t - open.t) < 2000)[0];
      if (cdpOpen) notes.push('Chrome (debugger): window.open received with userGesture = ' + cdpOpen.data.userGesture + (cdpOpen.data.userGesture ? ' (valid gesture: check the Pop-ups setting).' : ' (no valid user gesture).'));
      if (d.blocked) {
        if (env.popupSetting === 'block') notes.push('Chrome "Pop-ups" setting for the site = blocked.');
        add('popup', 'Popup opened', 'window.open', 'fail', open,
          'window.open(' + short(d.url, 80) + ') returned null' + (d.thrown ? ' (exception: ' + d.thrown + ')' : '') + ' → popup blocked.', notes,
          'Chrome only allows window.open as a direct reaction to a recent user gesture (~5 s). If the PDF is first downloaded over the network and the popup is opened when the response arrives, a slow network lets the permission expire. Fix: open the window immediately (on click), then assign it the Blob URL once the PDF has arrived.');
      } else {
        add('popup', 'Popup opened', 'window.open', notes.length ? 'warn' : 'ok', open, 'window.open(' + short(d.url, 80) + ') → window created', notes);
      }
    } else {
      add('popup', 'Popup opened', 'window.open', 'na', null, 'No call to window.open (printing through a frame in the page?).');
    }

    // 8. frame insertion
    if (popupNav) {
      add('frame-created', 'Display frame / tab created', 'webNavigation.onCommitted (popup)', 'ok', popupNav, 'Tab #' + popupNav.tabId + ' → ' + short(popupNav.data.url, 120));
    } else if (domEv) {
      const d = domEv.data;
      const notes = [];
      let status = 'ok';
      if (d.sandbox != null) {
        status = 'warn';
        notes.push('sandbox="' + d.sandbox + '" attribute on the frame.');
        if (!/allow-modals/.test(d.sandbox)) notes.push('Without "allow-modals", print() is ignored in this frame.');
      }
      add('frame-created', 'Display frame inserted in the page', 'MutationObserver (iframe / embed / object)', status, domEv,
        d.tag + ' src=' + short(srcOf(domEv), 100) + (d.type ? ' type=' + d.type : ''), notes,
        d.sandbox != null ? 'A sandboxed iframe often prevents Chrome\'s viewer from displaying the PDF and blocks printing without allow-modals.' : '');
    } else if (open && !open.data.blocked) {
      add('frame-created', 'Display frame / tab created', 'webNavigation.onCommitted (popup)', 'missing', null, 'The popup was opened but no navigation was observed in the new tab.');
    } else {
      add('frame-created', 'Display frame inserted in the page', 'MutationObserver (iframe / embed / object)', 'missing', null,
        'No iframe/embed/object created with the PDF or Blob URL.', [], 'The PDF is never attached to a display element.');
    }

    // 9. frame load
    if (resErr || wnErr) {
      const e = resErr || wnErr;
      add('frame-load', 'Frame finished loading', 'load event / webNavigation.onCompleted', 'fail', e,
        resErr ? 'error event on ' + resErr.data.tag : 'Navigation error: ' + (wnErr.data.error || ''), [],
        wnErr && wnErr.data.error ? explainNetError(wnErr.data.error) : 'The frame could not load its content.');
    } else if (loadedEv) {
      const notes = [];
      let status = 'ok';
      if (printCall && printCall.t < loadedEv.t) { status = 'warn'; notes.push('print() was called ' + (loadedEv.t - printCall.t) + ' ms before the frame finished loading.'); }
      add('frame-load', 'Frame finished loading', frameLoad ? 'load event' : 'webNavigation.onCompleted', status, loadedEv, 'Loaded', notes);
    } else if (domEv || popupNav) {
      add('frame-load', 'Frame finished loading', 'load event / webNavigation.onCompleted', 'missing', null, 'The frame was created but never finished loading.', [],
        'The frame content is blocked or does not arrive: invalid/revoked Blob, X-Frame-Options/CSP, PDF viewer not starting, network.');
    } else {
      add('frame-load', 'Frame finished loading', 'load event / webNavigation.onCompleted', 'missing', null, 'No frame to load.');
    }

    // 10. PDF viewer
    if (dl) {
      add('viewer', 'Chrome PDF viewer started', 'webNavigation / document.contentType / downloads', 'fail', dl,
        'The PDF was downloaded (' + (dl.data.filename || dl.data.url) + ') instead of being displayed.', [],
        'Content-Disposition: attachment, Blob without a PDF type, or Chrome configured to download PDFs (chrome://settings/content/pdfDocuments, AlwaysOpenPdfExternally policy).');
    } else if (viewerEv) {
      add('viewer', 'Chrome PDF viewer started', 'webNavigation / document.contentType', 'ok', viewerEv, 'PDF viewer detected');
    } else if (pdfViewerEnabled === false) {
      add('viewer', 'Chrome PDF viewer started', 'navigator.pdfViewerEnabled', 'fail', null,
        'navigator.pdfViewerEnabled = false', [], 'The built-in PDF viewer is disabled on this computer (setting or enterprise policy): Chrome downloads PDFs, no printing is possible from the page.');
    } else {
      add('viewer', 'Chrome PDF viewer started', 'indirect', 'unknown', null, 'Not directly observable.', [],
        'The viewer runs in an internal Chrome frame: enable advanced mode to see it directly. Otherwise, if the steps before/after are OK, it worked.');
    }

    // 11. print() call
    const refused = printLogs[0];
    if (refused) {
      const sandboxed = /sandbox/i.test(refused.data.text);
      const crossO = /cross-origin/i.test(refused.data.text);
      add('print-call', 'print() called', printCall ? printCall.data.via : 'window.print', 'fail', refused,
        'Chrome refused the call: "' + short(refused.data.text, 220) + '"', printCall ? actNotes(printCall.data.act, false) : [],
        sandboxed ? 'The frame is sandboxed without allow-modals: add allow-modals to the sandbox attribute (or do not sandbox this frame).'
          : crossO ? 'print() cannot be called on the window of a frame from another origin: trigger printing from the frame itself (postMessage), or serve the PDF as a same-origin Blob.'
            : 'See Chrome\'s message above.');
    } else if (printCall) {
      const d = printCall.data;
      const notes = actNotes(d.act, false);
      let status = 'ok';
      if (d.act && d.act.hasFocus === false) status = 'warn';
      if (d.act && d.act.visibility && d.act.visibility !== 'visible') status = 'warn';
      if (d.sandbox != null && !/allow-modals/.test(d.sandbox)) { status = 'warn'; notes.push('Sandboxed frame without allow-modals ("' + d.sandbox + '"): print() ignored.'); }
      if (d.opaqueOrigin) notes.push('Opaque origin (sandboxed document).');
      if (printRet && printRet.data.ms < 30 && !anyBefore) { status = 'warn'; notes.push('print() returned in ' + printRet.data.ms + ' ms with no beforeprint event: call probably ignored by Chrome.'); }
      add('print-call', 'print() called', d.via, status, printCall, d.via + (d.act && d.act.top === false ? ' (in a subframe)' : ''), notes,
        status === 'warn' ? 'Chrome ignores print() without focus, with a hidden tab, in a sandboxed frame without allow-modals, or when the PDF is not ready yet.' : '');
    } else if (anyBefore) {
      add('print-call', 'print() called', 'window.print', 'unknown', null, 'Printing triggered without an observable print() call (viewer button, Ctrl+P, or uninstrumented frame).');
    } else if (crossErr) {
      add('print-call', 'print() called', 'iframe.contentWindow.print', 'fail', crossErr,
        'Access forbidden to a frame of another origin: ' + short(errText(crossErr), 200), [],
        'print() cannot be called through iframe.contentWindow on a frame of another origin (SecurityError). Trigger printing from the frame itself (postMessage) or serve the PDF as a same-origin Blob.');
    } else {
      const errs = errList.slice(0, 3).map(fmtErr);
      let hint = 'If the app prints on the PDF viewer through a frame the extension cannot reach, the call is not observable (enable advanced mode to read Chrome\'s refusals). Otherwise the JavaScript chain stops before print() (exception, promise never resolved, load handler never fired).';
      if (crossAcc) hint = 'The code accesses iframe.contentWindow of a frame from another origin (observed, ' + short(crossAcc.data.target.src, 60) + '): print() is forbidden there (SecurityError). Print from the frame itself (postMessage) or serve the PDF as a same-origin Blob.';
      else if (cwAcc.length) hint = 'The code accesses iframe.contentWindow (same-origin frame) but print() is never called: the code stops in between, or waits for an event that never comes.';
      add('print-call', 'print() called', 'window.print', 'missing', null,
        errs.length ? 'print() never called; errors observed: ' + errs.join(' | ') : 'No print() call observed.', [], hint);
    }

    // 12. print dialog
    if (anyBefore) {
      add('dialog', 'Print dialog opened', 'beforeprint event', 'ok', anyBefore, 'beforeprint received');
    } else if (printCall) {
      add('dialog', 'Print dialog opened', 'beforeprint event', 'unknown', null, 'beforeprint not received.', [],
        'For a PDF displayed by the viewer, Chrome may not emit beforeprint in the page. If the dialog does not really open, see the reservations of the previous step.');
    } else {
      add('dialog', 'Print dialog opened', 'beforeprint event', 'missing', null, 'No print dialog observed.');
    }

    // 13. closing
    if (printAfter) add('after-print', 'Print dialog closed', 'afterprint event', 'ok', printAfter, 'afterprint received');
    else add('after-print', 'Print dialog closed', 'afterprint event', anyBefore ? 'unknown' : 'na', null, anyBefore ? 'Dialog still open or afterprint not emitted.' : 'Not applicable.');

    // "Missing" steps after the first failure are consequences, not causes.
    const firstFail = steps.findIndex((s) => s.status === 'fail');
    if (firstFail >= 0) {
      for (let i = firstFail + 1; i < steps.length; i++) {
        if (steps[i].status === 'missing') { steps[i].status = 'skipped'; steps[i].detail = 'Not reached (failure at step ' + steps[firstFail].n + ').'; steps[i].hint = ''; }
      }
    }
    // Delays between observed steps.
    // (fetch/XHR answers as soon as the headers arrive, before the network is done: compare with the latest timestamp already seen.
    //  Closing the dialog depends on the user: never flagged as slow.)
    let maxT = null;
    for (const s of steps) {
      if (s.t == null || !/^(ok|warn|fail)$/.test(s.status)) continue;
      if (maxT != null) {
        s.gap = Math.max(0, s.t - maxT);
        s.slow = s.gap > 3000 && s.id !== 'after-print';
      }
      maxT = maxT == null ? s.t : Math.max(maxT, s.t);
    }
    return steps;
  }

  function makeVerdict(steps) {
    const fail = steps.find((s) => s.status === 'fail');
    if (fail) {
      return { level: 'fail', stepId: fail.id, title: 'Blocking step detected at step ' + fail.n + ' — ' + fail.label, detail: [fail.detail].concat(fail.notes).filter(Boolean).join('\n'), hint: fail.hint };
    }
    const missing = steps.find((s) => s.status === 'missing');
    if (missing) {
      const prev = steps.slice().reverse().find((s) => /^(ok|warn)$/.test(s.status) && s.n < missing.n);
      return {
        level: 'stall', stepId: missing.id,
        title: prev ? 'Chain interrupted after step ' + prev.n + ' (' + prev.label + ') — step ' + missing.n + ' (' + missing.label + ') was never observed'
          : 'Step ' + missing.n + ' (' + missing.label + ') was never observed',
        detail: missing.detail, hint: missing.hint
      };
    }
    const warns = steps.filter((s) => s.status === 'warn');
    const slow = steps.filter((s) => s.slow);
    const lines = warns.map((w) => 'Step ' + w.n + ': ' + w.notes.join(' / ')).concat(slow.map((s) => 'Delay of ' + s.gap + ' ms before step ' + s.n + ' (' + s.label + ').'));
    return {
      level: warns.length || slow.length ? 'warn' : 'ok', stepId: warns[0] ? warns[0].id : null,
      title: warns.length || slow.length ? 'All observed steps happened, with reservations' : 'All observed steps went through without any anomaly',
      detail: lines.join('\n'), hint: ''
    };
  }

  /* ---------- cross-cutting diagnostics (independent of the chosen PDF) ---------- */
  function diagnose(tr, evs) {
    const out = [];
    const env = tr.env || {};
    const penv = evs.find((e) => e.src === 'page' && e.type === 'env' && e.top);
    const pe = penv ? penv.data : {};
    if (pe.pdfViewerEnabled === false) out.push({ level: 'bad', text: 'navigator.pdfViewerEnabled = false: Chrome\'s PDF viewer is disabled ("Download PDFs" setting or policy). The PDF is downloaded, never displayed.' });
    if (env.popupSetting === 'block') out.push({ level: 'bad', text: 'Chrome "Pop-ups" setting = blocked for this site (chrome://settings/content/popups).' });
    if (pe.online === false) out.push({ level: 'bad', text: 'The browser reports being offline (navigator.onLine = false).' });
    const c = pe.conn;
    if (c && (/^(slow-2g|2g|3g)$/.test(c.effectiveType) || c.rtt > 500)) out.push({ level: 'warn', text: 'Slow connection according to Chrome: type ' + c.effectiveType + ', RTT ' + c.rtt + ' ms, downlink ' + c.downlink + ' Mb/s.' });
    const exts = env.extensions || [];
    const risky = exts.filter((x) => x.hostAll && (x.permissions || []).some((p) => /^(webRequest|webRequestBlocking|declarativeNetRequest|declarativeNetRequestWithHostAccess|proxy|contentSettings|downloads)$/.test(p)));
    if (risky.length) out.push({ level: 'warn', text: 'Active extensions that may interfere (access to all sites + network/downloads): ' + risky.map((x) => x.name).join(', ') + '.' });
    const admin = exts.filter((x) => x.installType === 'admin');
    if (admin.length) out.push({ level: 'info', text: 'Extensions forced by the administrator (enterprise policy): ' + admin.map((x) => x.name).join(', ') + '.' });
    if (env.incognito) out.push({ level: 'info', text: 'Incognito tab (extensions may be restricted there).' });
    const csp = evs.filter((e) => e.type === 'csp:violation');
    if (csp.length) out.push({ level: 'warn', text: csp.length + ' CSP violation(s), e.g.: ' + fmtErr(csp[0]) });
    const errs = evs.filter((e) => e.type === 'js:error' || e.type === 'js:rejection');
    if (errs.length) out.push({ level: 'warn', text: errs.length + ' JavaScript error(s), e.g.: ' + fmtErr(errs[0]) });
    const blocked = evs.filter((e) => e.type === 'open:call' && e.data.blocked);
    if (blocked.length) out.push({ level: 'bad', text: blocked.length + ' window.open call(s) blocked by Chrome.' });
    evs.filter((e) => e.type === 'cdp:log' || e.type === 'cdp:console').slice(0, 3)
      .forEach((e) => out.push({ level: 'warn', text: 'Browser console (' + e.data.level + '): ' + short(e.data.text, 200) }));
    const ck = evs.filter((e) => e.type === 'cdp:cookiesBlocked');
    if (ck.length) out.push({ level: 'warn', text: ck.length + ' cookie blocking event(s), e.g. ' + short((ck[0].data.cookies || []).map((k) => (k.name || '?') + ' [' + (k.reasons || []).join(', ') + ']').join(', '), 160) + ' on ' + short(ck[0].data.url, 70) + '.' });
    const att = evs.find((e) => e.type === 'cdp:attachError');
    if (att) out.push({ level: 'info', text: 'Advanced mode: could not attach the debugger (' + short(att.data.message, 120) + ').' });
    if (evs.some((e) => e.type === 'cdp:detached' && e.data.reason === 'canceled_by_user')) out.push({ level: 'info', text: 'Debugger detached via the Chrome banner: browser messages are no longer collected.' });
    const workerReq = evs.filter((e) => e.worker && e.type === 'wr:before');
    if (workerReq.length) out.push({ level: 'info', text: workerReq.length + ' request(s) sent by a Worker / Service Worker were attached to the tab (same origin).' });
    const perf = evs.filter((e) => e.type === 'perf:resource' && (PDF_URL_RE.test(e.data.name) || e.data.duration > 3000));
    perf.slice(0, 3).forEach((e) => out.push({ level: e.data.duration > 3000 ? 'warn' : 'info', text: 'Timing ' + short(e.data.name, 70) + ': total ' + e.data.duration + ' ms (DNS ' + e.data.dns + ', connect ' + e.data.connect + ', TLS ' + e.data.tls + ', server wait ' + e.data.ttfb + ', download ' + e.data.download + ' ms; ' + e.data.protocol + ').' }));
    return out;
  }

  /* ---------- API ---------- */
  function analyze(input, opts) {
    opts = opts || {};
    const tr = Array.isArray(input) ? { events: input } : (input || { events: [] });
    const evs = sortEvents(tr.events || []);
    const candidates = findCandidates(evs);
    const diagnostics = diagnose(tr, evs);
    if (!candidates.length) {
      return {
        candidates: [], candidate: null, steps: [], diagnostics, eventCount: evs.length,
        verdict: { level: 'none', stepId: null, title: 'No PDF detected in the trace', detail: 'No PDF request (pdf Content-Type or .pdf URL), no "%PDF-" body read in JavaScript, no PDF Blob.', hint: 'Start recording, reload the page, then reproduce the printing.' }
      };
    }
    const cand = candidates.find((c) => c.id === opts.candidateId) || candidates[candidates.length - 1];
    const next = candidates.slice(candidates.indexOf(cand) + 1).find((c) => c.t > cand.t);
    const steps = buildSteps(tr, evs, cand, next ? next.t - 200 : Infinity);
    return {
      candidates: candidates.map((c) => ({ id: c.id, label: c.label, t: c.t })),
      candidate: { id: cand.id, label: cand.label, url: cand.url, t: cand.t, kind: cand.kind },
      steps, verdict: makeVerdict(steps), diagnostics, eventCount: evs.length
    };
  }

  const STATUS_TXT = { ok: 'OK', warn: 'OK (reservation)', fail: 'FAILED', missing: 'NOT OBSERVED', unknown: 'not observable', na: 'n/a', skipped: 'not reached' };
  function toText(a) {
    const L = [];
    L.push('PDF Print Tracer — report');
    if (a.candidate) L.push('PDF analysed: ' + a.candidate.label);
    L.push('Events: ' + a.eventCount);
    L.push('');
    L.push('VERDICT: ' + a.verdict.title);
    if (a.verdict.detail) L.push(a.verdict.detail);
    if (a.verdict.hint) L.push('→ ' + a.verdict.hint);
    L.push('');
    for (const s of a.steps) {
      L.push(s.n + '. [' + STATUS_TXT[s.status] + '] ' + s.label + (s.rel != null ? '  (+' + s.rel + ' ms' + (s.gap != null ? ', Δ ' + s.gap + ' ms' : '') + ')' : ''));
      if (s.detail) L.push('     ' + s.detail);
      s.notes.forEach((n) => L.push('     · ' + n));
      if (s.hint && /^(fail|missing|warn)$/.test(s.status)) L.push('     → ' + s.hint);
    }
    if (a.diagnostics.length) {
      L.push('');
      L.push('General diagnostics:');
      a.diagnostics.forEach((d) => L.push(' - [' + d.level + '] ' + d.text));
    }
    return L.join('\n');
  }
  // Masks URL parameters (tokens, identifiers) before sharing.
  const redact = (text) => String(text).replace(/\?[^"\\\s#]*/g, '?…');

  return { analyze, findCandidates, toText, redact, explainNetError, sortEvents };
});
