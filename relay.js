/*
 * PDF Print Tracer — relay (ISOLATED world).
 * Collects the events emitted by inject.js (MAIN world) via CustomEvents
 * and forwards them to the service worker.
 */
(() => {
  'use strict';
  const EV = '__pdftracer_ev__';
  const PING = '__pdftracer_ping__';
  const HELLO = '__pdftracer_hello__';

  window.addEventListener(EV, (e) => {
    try {
      const ev = JSON.parse(e.detail);
      chrome.runtime.sendMessage({ kind: 'page', ev }).catch(() => {});
    } catch (_) { /* extension context invalidated or malformed message */ }
  });

  // Handshake: whatever the injection order, inject.js knows when the relay is ready.
  window.addEventListener(PING, () => window.dispatchEvent(new CustomEvent(HELLO)));
  window.dispatchEvent(new CustomEvent(HELLO));

  // Lets the popup check that the page is instrumented.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.kind === 'ping') sendResponse({ ok: true });
    });
  } catch (_) { /* ignore */ }
})();
