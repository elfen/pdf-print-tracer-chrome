/*
 * PDF Print Tracer — passive instrumentation (MAIN world, all frames).
 *
 * It never alters the page's behaviour: every hook calls the original function
 * and merely emits an event towards relay.js.
 *
 * Steps observed on the page side:
 *   fetch / XHR (request, response)  →  body read (blob / arrayBuffer, %PDF signature)
 *   →  URL.createObjectURL  →  window.open  →  iframe/embed/object insertion  →  frame load
 *   →  window.print()  →  beforeprint / afterprint
 * + user activation, focus, JS errors, CSP violations, network timings (Resource Timing).
 */
(() => {
  'use strict';

  const SYM = Symbol.for('__pdfPrintTracer__');
  try {
    if (window[SYM]) return;
    Object.defineProperty(window, SYM, { value: true });
  } catch (_) { return; }

  const EV = '__pdftracer_ev__';
  const PING = '__pdftracer_ping__';
  const HELLO = '__pdftracer_hello__';

  const isTop = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const cut = (s, n) => { s = String(s == null ? '' : s); n = n || 300; return s.length > n ? s.slice(0, n) + '…' : s; };
  const safe = (fn, dflt) => {
    try { const v = fn(); return v === undefined ? (dflt === undefined ? null : dflt) : v; }
    catch (_) { return dflt === undefined ? null : dflt; }
  };
  const abs = (u) => safe(() => new URL(String(u), location.href).href, String(u));
  const printable = (s) => String(s).replace(/[^\x20-\x7e]/g, '.');

  /* ---------- emission (queued until the relay is ready) ---------- */
  let ready = false;
  const queue = [];
  const send = (ev) => {
    try { window.dispatchEvent(new CustomEvent(EV, { detail: JSON.stringify(ev) })); } catch (_) { /* ignore */ }
  };
  window.addEventListener(HELLO, () => {
    if (ready) return;
    ready = true;
    queue.splice(0).forEach(send);
  });
  const emit = (type, data, t) => {
    const ev = { t: t || Date.now(), type, top: isTop, frameUrl: cut(location.href, 200), data: data || {} };
    if (ready) send(ev);
    else { queue.push(ev); if (queue.length > 500) queue.shift(); }
  };
  window.dispatchEvent(new CustomEvent(PING));

  /* ---------- activation utilisateur / focus ---------- */
  let lastGesture = 0;
  let lastGestureType = null;
  let lastGestureEmit = 0;
  ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart'].forEach((name) => {
    window.addEventListener(name, (e) => {
      if (!e.isTrusted) return;
      const now = Date.now();
      lastGesture = now;
      lastGestureType = name;
      if (now - lastGestureEmit > 250) { lastGestureEmit = now; emit('gesture', { kind: name }); }
    }, true);
  });
  const act = () => ({
    isActive: safe(() => navigator.userActivation.isActive),
    hasBeenActive: safe(() => navigator.userActivation.hasBeenActive),
    gestureAgeMs: lastGesture ? Date.now() - lastGesture : null,
    lastGestureType,
    hasFocus: safe(() => document.hasFocus()),
    visibility: safe(() => document.visibilityState),
    top: isTop
  });

  /* ---------- frame environment ---------- */
  emit('env', {
    ua: navigator.userAgent,
    pdfViewerEnabled: safe(() => navigator.pdfViewerEnabled),
    pdfMimeTypes: safe(() => Array.from(navigator.mimeTypes).map((m) => m.type).filter((t) => /pdf/i.test(t)), []),
    online: navigator.onLine,
    secure: window.isSecureContext,
    origin: safe(() => self.origin),
    opaqueOrigin: safe(() => self.origin === 'null'),
    referrer: cut(document.referrer, 200),
    docContentType: safe(() => document.contentType),
    readyState: document.readyState,
    conn: safe(() => ({
      effectiveType: navigator.connection.effectiveType,
      rtt: navigator.connection.rtt,
      downlink: navigator.connection.downlink,
      saveData: navigator.connection.saveData
    })),
    frameSandbox: safe(() => window.frameElement && window.frameElement.getAttribute('sandbox'))
  });

  const docState = (why) => emit('doc:state', {
    why,
    readyState: document.readyState,
    contentType: safe(() => document.contentType),
    embeds: safe(() => Array.from(document.querySelectorAll('embed,object')).map((e) => e.getAttribute('type')), [])
  });
  document.addEventListener('readystatechange', () => docState('readystatechange'));
  document.addEventListener('DOMContentLoaded', () => docState('DOMContentLoaded'));
  window.addEventListener('load', () => docState('load'));

  /* ---------- body reading: %PDF signature ---------- */
  async function describeBlob(blob, source, url, tRes) {
    try {
      const head = await blob.slice(0, 1024).text();
      emit('body:read', {
        source, url, size: blob.size, mime: blob.type,
        isPdf: head.indexOf('%PDF-') !== -1, magic: printable(head.slice(0, 40))
      }, tRes);
    } catch (e) {
      emit('body:error', { source, url, message: cut(e && e.message, 200) }, tRes);
    }
  }
  function describeBuffer(buf, source, url, tRes) {
    try {
      const u8 = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
      let head = '';
      for (let i = 0; i < u8.length; i++) head += String.fromCharCode(u8[i]);
      emit('body:read', {
        source, url, size: buf.byteLength, mime: null,
        isPdf: head.indexOf('%PDF-') !== -1, magic: printable(head.slice(0, 40))
      }, tRes);
    } catch (e) {
      emit('body:error', { source, url, message: cut(e && e.message, 200) }, tRes);
    }
  }

  /* ---------- fetch ---------- */
  let seq = 0;
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      const id = ++seq;
      const input = arguments[0];
      const init = arguments[1];
      let url = '';
      let method = 'GET';
      try {
        url = abs(typeof input === 'string' ? input : (input && input.url) || input);
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch (_) { /* ignore */ }
      const t0 = Date.now();
      emit('fetch:start', { id, url, method });
      const p = origFetch.apply(this, arguments);
      try {
        p.then((res) => {
          emit('fetch:response', {
            id, url, finalUrl: res.url, status: res.status, ok: res.ok, redirected: res.redirected, type: res.type,
            contentType: safe(() => res.headers.get('content-type')),
            contentLength: safe(() => res.headers.get('content-length')),
            contentDisposition: safe(() => res.headers.get('content-disposition')),
            ms: Date.now() - t0
          });
        }, (err) => {
          emit('fetch:error', { id, url, name: err && err.name, message: cut(err && err.message, 200), ms: Date.now() - t0 });
        });
      } catch (_) { /* ignore */ }
      return p;
    };
  }
  if (window.Response && Response.prototype) {
    const hookBody = (name, describe) => {
      const orig = Response.prototype[name];
      if (typeof orig !== 'function') return;
      Response.prototype[name] = function () {
        const res = this;
        const url = safe(() => res.url, '');
        const p = orig.apply(this, arguments);
        try {
          p.then(
            (r) => describe(r, 'fetch.' + name, url, Date.now()),
            (err) => emit('body:error', { source: 'fetch.' + name, url, message: cut(err && err.message, 200) })
          );
        } catch (_) { /* ignore */ }
        return p;
      };
    };
    hookBody('blob', describeBlob);
    hookBody('arrayBuffer', describeBuffer);
  }

  /* ---------- XMLHttpRequest ---------- */
  if (window.XMLHttpRequest) {
    const X = XMLHttpRequest.prototype;
    const oOpen = X.open;
    const oSend = X.send;
    X.open = function (method, url) {
      try { this.__pt = { id: ++seq, method, url: abs(url) }; } catch (_) { /* ignore */ }
      return oOpen.apply(this, arguments);
    };
    X.send = function () {
      const x = this;
      const m = x.__pt;
      if (m) {
        const t0 = Date.now();
        try {
          emit('xhr:send', { id: m.id, url: m.url, method: m.method, responseType: x.responseType });
          x.addEventListener('readystatechange', () => {
            if (x.readyState === 2) {
              emit('xhr:headers', { id: m.id, url: m.url, status: x.status, contentType: safe(() => x.getResponseHeader('content-type')), ms: Date.now() - t0 });
            }
          });
          x.addEventListener('load', () => {
            const now = Date.now();
            const r = safe(() => x.response);
            const size = r == null ? null : (r.size != null ? r.size : (r.byteLength != null ? r.byteLength : (typeof r === 'string' ? r.length : null)));
            emit('xhr:load', {
              id: m.id, url: m.url, status: x.status, responseType: x.responseType,
              contentType: safe(() => x.getResponseHeader('content-type')), size, ms: now - t0
            });
            if (x.responseType === 'blob' && r) describeBlob(r, 'xhr.blob', m.url, now);
            else if (x.responseType === 'arraybuffer' && r) describeBuffer(r, 'xhr.arraybuffer', m.url, now);
          });
          ['error', 'abort', 'timeout'].forEach((k) => x.addEventListener(k, () => {
            emit('xhr:error', { id: m.id, url: m.url, kind: k, status: x.status, ms: Date.now() - t0 });
          }));
        } catch (_) { /* ignore */ }
      }
      return oSend.apply(this, arguments);
    };
  }

  /* ---------- Blob URL ---------- */
  if (window.URL && typeof URL.createObjectURL === 'function') {
    const oCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const u = oCreate.apply(this, arguments);
      emit('blob:url', {
        url: u, size: safe(() => obj.size), mime: safe(() => obj.type),
        kind: safe(() => obj.constructor && obj.constructor.name)
      });
      return u;
    };
    const oRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (u) {
      emit('blob:revoke', { url: String(u) });
      return oRevoke.apply(this, arguments);
    };
  }

  /* ---------- window.open (popup) ---------- */
  const oOpenWin = window.open;
  if (typeof oOpenWin === 'function') {
    window.open = function (url, target, features) {
      const a = act();
      const t0 = Date.now();
      let r = null;
      let thrown = null;
      try { r = oOpenWin.apply(this, arguments); } catch (e) { thrown = e; }
      emit('open:call', {
        url: cut(url == null ? '' : url, 200), target: target == null ? null : String(target),
        features: features == null ? null : cut(features, 100),
        blocked: !r, thrown: thrown ? cut(thrown.message, 200) : null, act: a
      });
      if (thrown) throw thrown;
      if (r) {
        try {
          let polls = 0;
          const iv = setInterval(() => {
            polls++;
            let closed = false;
            try { closed = r.closed; } catch (_) { closed = true; }
            if (closed || polls > 240) {
              clearInterval(iv);
              if (closed) emit('popup:closed', { afterMs: Date.now() - t0 });
            }
          }, 500);
        } catch (_) { /* ignore */ }
        try { hookWinPrint(r, null, 'popup.print (hook parent)'); } catch (_) { /* ignore */ }
      }
      return r;
    };
  }

  /* ---------- print ---------- */
  const sandboxInfo = () => safe(() => window.frameElement && window.frameElement.getAttribute('sandbox'));
  const origPrint = window.print;
  if (typeof origPrint === 'function') {
    const wrapped = function print() {
      const a = act();
      emit('print:call', { via: 'window.print', act: a, sandbox: sandboxInfo(), opaqueOrigin: safe(() => self.origin === 'null') });
      const t0 = Date.now();
      try { return origPrint.apply(this, arguments); }
      finally { emit('print:returned', { ms: Date.now() - t0 }); }
    };
    try {
      Object.defineProperty(wrapped, '__pt', { value: true });
      window.print = wrapped;
    } catch (_) { /* ignore */ }
  }
  // If the app calls iframe.contentWindow.print() (same-origin frame), install a hook on the parent side.
  // Internal contentWindow access, bypassing our own getter hook (hence no spurious event).
  let origCW = null;
  const cwOf = (el) => safe(() => (origCW ? origCW.call(el) : el.contentWindow));
  function hookWinPrint(w, holder, via) {
    if (!w) return;
    try {
      const orig = w.print;
      if (typeof orig !== 'function' || orig.__pt) return;
      const wrapped = function print() {
        emit('print:call', { via: via || 'iframe.contentWindow.print (hook parent)', act: act(), target: holder && holder.tagName ? describeEl(holder) : null });
        return orig.apply(this, arguments);
      };
      Object.defineProperty(wrapped, '__pt', { value: true });
      w.print = wrapped;
    } catch (_) { /* frame cross-origin : non observable */ }
  }
  window.addEventListener('beforeprint', () => emit('print:before', { act: act() }), true);
  window.addEventListener('afterprint', () => emit('print:after', {}), true);

  /* ---------- insertion iframe / embed / object ---------- */
  const describeEl = (el) => ({
    tag: el.tagName,
    id: el.id || null,
    src: cut(el.getAttribute('src') || el.getAttribute('data') || '', 160),
    type: el.getAttribute('type'),
    sandbox: el.hasAttribute('sandbox') ? el.getAttribute('sandbox') : null,
    width: el.getAttribute('width'),
    height: el.getAttribute('height'),
    style: cut(el.getAttribute('style') || '', 80)
  });
  const FRAMEY = /^(IFRAME|EMBED|OBJECT)$/;
  const onAdded = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (FRAMEY.test(node.tagName)) emit('dom:add', describeEl(node));
    if (node.querySelectorAll) node.querySelectorAll('iframe,embed,object').forEach((el) => emit('dom:add', describeEl(el)));
  };
  // Access to iframe.contentWindow: the code is about to drive the frame (print(), focus()…).
  // If the frame is same-origin, install the print() hook on its window right away;
  // otherwise report it (print() is then forbidden: SecurityError).
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (desc && desc.get) {
      origCW = desc.get;
      let accesses = 0;
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          const w = desc.get.call(this);
          if (w) {
            const crossOrigin = safe(() => { void w.document; return false; }, true);
            if (!crossOrigin) hookWinPrint(w, this);
            if (++accesses <= 40) emit('iframe:contentWindow', { target: describeEl(this), crossOrigin, stack: cut(new Error().stack, 400) });
          }
          return w;
        }
      });
    }
  } catch (_) { /* ignore */ }

  try {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach(onAdded);
        else if (m.type === 'attributes' && FRAMEY.test(m.target.tagName)) {
          const d = describeEl(m.target);
          d.attr = m.attributeName;
          d.value = cut(m.target.getAttribute(m.attributeName) || '', 160);
          emit('dom:attr', d);
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data', 'sandbox', 'srcdoc', 'type'] });
  } catch (_) { /* ignore */ }

  /* ---------- load / error (phase de capture) ---------- */
  let jsErrors = 0;
  // Elements' "load" events do not bubble up to window: listen on document.
  document.addEventListener('load', (e) => {
    const el = e.target;
    if (el && el.tagName && FRAMEY.test(el.tagName)) {
      const d = describeEl(el);
      d.docContentType = safe(() => el.contentDocument && el.contentDocument.contentType);
      d.embedType = safe(() => { const em = el.contentDocument && el.contentDocument.querySelector('embed'); return em && em.getAttribute('type'); });
      emit('frame:load', d);
      if (el.tagName === 'IFRAME') hookWinPrint(cwOf(el), el);
    }
  }, true);
  window.addEventListener('error', (e) => {
    const el = e.target;
    if (el && el !== window && el.tagName) {
      if (/^(IFRAME|EMBED|OBJECT|IMG|SCRIPT|LINK)$/.test(el.tagName)) emit('resource:error', describeEl(el));
      return;
    }
    if (++jsErrors > 50) return;
    emit('js:error', {
      message: cut(e.message, 300), file: cut(e.filename, 200), line: e.lineno, col: e.colno,
      stack: cut(e.error && e.error.stack, 600)
    });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    if (++jsErrors > 50) return;
    const r = e.reason;
    emit('js:rejection', { reason: cut(r && (r.stack || r.message) || r, 600) });
  });
  document.addEventListener('securitypolicyviolation', (e) => {
    emit('csp:violation', {
      blockedURI: cut(e.blockedURI, 200), violatedDirective: e.violatedDirective, effectiveDirective: e.effectiveDirective,
      disposition: e.disposition, sourceFile: cut(e.sourceFile, 200), line: e.lineNumber, sample: cut(e.sample, 100),
      policy: cut(e.originalPolicy, 200)
    });
  }, true);

  /* ---------- network timings (DNS / connect / TLS / TTFB / download) ---------- */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!/^(fetch|xmlhttprequest|iframe|embed|object|other)$/.test(e.initiatorType)) continue;
        emit('perf:resource', {
          name: cut(e.name, 200), initiatorType: e.initiatorType,
          start: Math.round(e.startTime), duration: Math.round(e.duration),
          dns: Math.round(e.domainLookupEnd - e.domainLookupStart),
          connect: Math.round(e.connectEnd - e.connectStart),
          tls: e.secureConnectionStart ? Math.round(e.connectEnd - e.secureConnectionStart) : 0,
          ttfb: Math.round(e.responseStart - e.requestStart),
          download: Math.round(e.responseEnd - e.responseStart),
          transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize,
          status: e.responseStatus, protocol: e.nextHopProtocol
        });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (_) { /* ignore */ }

  /* ---------- frame lifecycle ---------- */
  let focusEvents = 0;
  ['focus', 'blur'].forEach((n) => window.addEventListener(n, () => { if (++focusEvents <= 30) emit('focus:' + n, { hasFocus: safe(() => document.hasFocus()) }); }));
  document.addEventListener('visibilitychange', () => emit('visibility', { state: document.visibilityState }));
  window.addEventListener('pagehide', (e) => emit('lifecycle:pagehide', { persisted: e.persisted }));
})();
