/*
 * PDF Print Tracer — service worker.
 *  - observes the network (webRequest), navigations (webNavigation) and downloads;
 *  - receives the page's events (via relay.js);
 *  - stores the trace per tab (chrome.storage.session);
 *  - automatically follows popups opened by a traced tab (window.open);
 *  - attaches Worker / Service Worker requests (tabId -1) to the traced tab of the same origin;
 *  - optional advanced mode ("debugger" permission, attached only when the box is ticked): console messages emitted by Chrome itself,
 *    window.open with userGesture, network blocking reasons, blocked cookies, PDF viewer frame.
 *
 * Privacy: request headers (cookies, Authorization) are NEVER read;
 * only a few response headers useful for diagnosis are kept. In advanced mode, only the name,
 * domain and blocking reason of cookies are kept (never their value).
 */
'use strict';

const MAX_EVENTS = 6000;
const FILTER = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'object', 'other', 'ping'] };
const KEEP_HEADERS = new Set([
  'content-type', 'content-length', 'content-disposition', 'content-encoding', 'transfer-encoding',
  'x-frame-options', 'content-security-policy', 'x-content-type-options', 'cache-control', 'location', 'server', 'via'
]);

const activeMem = new Set();   // root tabs currently being traced
const routeMem = new Map();    // onglet enfant (popup) -> onglet racine
const rootOrigin = new Map();  // root tab -> origin (to attach Worker requests)
const traces = new Map();      // onglet racine -> Promise<trace>
let counter = 0;
let advancedOn = false;

const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
const originOf = (u) => { try { const o = new URL(u).origin; return o === 'null' ? null : o; } catch (_) { return null; } };
async function refreshOrigin(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const o = originOf(t.url);
    if (o) rootOrigin.set(tabId, o);
  } catch (_) { /* onglet disparu */ }
}

const ready = Promise.all([
  chrome.storage.session.get(['active', 'route']),
  chrome.storage.local.get('advanced')
]).then(async ([s, l]) => {
  (s.active || []).forEach((id) => activeMem.add(id));
  Object.entries(s.route || {}).forEach(([k, v]) => routeMem.set(Number(k), v));
  advancedOn = !!l.advanced;
  await Promise.all([...activeMem].map(refreshOrigin));
}).catch(() => {});

const newTrace = () => ({ active: false, startedAt: null, stoppedAt: null, env: null, events: [] });
function load(root) {
  if (!traces.has(root)) {
    const key = 'trace:' + root;
    traces.set(root, chrome.storage.session.get(key).then((o) => o[key] || newTrace()).catch(() => newTrace()));
  }
  return traces.get(root);
}

let flushTimer = null;
const dirty = new Set();
function scheduleFlush(root) {
  dirty.add(root);
  if (!flushTimer) flushTimer = setTimeout(flush, 300);
}
async function flush() {
  flushTimer = null;
  const ids = [...dirty];
  dirty.clear();
  const obj = {};
  for (const id of ids) {
    if (traces.has(id)) obj['trace:' + id] = await traces.get(id);
  }
  try { await chrome.storage.session.set(obj); } catch (e) { console.warn('[tracer] flush', e); }
}
const persistRouting = () => chrome.storage.session.set({
  active: [...activeMem], route: Object.fromEntries(routeMem)
}).catch(() => {});

async function record(tabId, ev) {
  await ready;
  const root = activeMem.has(tabId) ? tabId : routeMem.get(tabId);
  if (root == null) return;
  const tr = await load(root);
  if (!tr.active) return;
  ev.tabId = tabId;
  ev.n = ++counter;
  tr.events.push(ev);
  if (tr.events.length > MAX_EVENTS) tr.events.splice(0, tr.events.length - MAX_EVENTS);
  scheduleFlush(root);
}
async function recordEverywhere(ev) {
  await ready;
  for (const root of activeMem) await record(root, Object.assign({}, ev));
}
// Request sent by a Worker / Service Worker: webRequest gives no tab (tabId -1).
// Attach it to the traced tab whose origin is the initiator's.
async function recordFromWorker(initiator, ev) {
  await ready;
  const o = originOf(initiator);
  if (!o) return;
  for (const root of activeMem) {
    if (rootOrigin.get(root) === o) await record(root, Object.assign({}, ev, { worker: true }));
  }
}

/* ---------- network ---------- */
const base = (d, extra) => Object.assign({
  requestId: d.requestId, url: d.url, method: d.method, resourceType: d.type,
  frameId: d.frameId, parentFrameId: d.parentFrameId, initiator: d.initiator
}, extra || {});
const wr = (type, extra) => (d) => {
  const ev = { t: Math.round(d.timeStamp), src: 'webRequest', type, data: base(d, extra ? extra(d) : null) };
  if (d.tabId >= 0) record(d.tabId, ev);
  else recordFromWorker(d.initiator, ev);
};
function pickHeaders(list) {
  const h = {};
  (list || []).forEach((x) => {
    const k = x.name.toLowerCase();
    if (KEEP_HEADERS.has(k)) h[k] = String(x.value || '').slice(0, 400);
  });
  return h;
}
chrome.webRequest.onBeforeRequest.addListener(wr('wr:before'), FILTER);
chrome.webRequest.onSendHeaders.addListener(wr('wr:sent'), FILTER);
chrome.webRequest.onHeadersReceived.addListener(wr('wr:headers', (d) => {
  const h = pickHeaders(d.responseHeaders);
  return { statusCode: d.statusCode, statusLine: d.statusLine, contentType: h['content-type'] || null, headers: h, fromCache: d.fromCache };
}), FILTER, ['responseHeaders', 'extraHeaders']);
chrome.webRequest.onResponseStarted.addListener(wr('wr:started', (d) => ({ statusCode: d.statusCode, ip: d.ip, fromCache: d.fromCache })), FILTER);
chrome.webRequest.onBeforeRedirect.addListener(wr('wr:redirect', (d) => ({ redirectUrl: d.redirectUrl, statusCode: d.statusCode })), FILTER);
chrome.webRequest.onCompleted.addListener(wr('wr:completed', (d) => ({ statusCode: d.statusCode, ip: d.ip, fromCache: d.fromCache })), FILTER);
chrome.webRequest.onErrorOccurred.addListener(wr('wr:error', (d) => ({ error: d.error, fromCache: d.fromCache })), FILTER);

/* ---------- navigations (frames, popups, visionneuse PDF) ---------- */
const wn = (type) => (d) => {
  if (d.tabId < 0) return;
  record(d.tabId, {
    t: Math.round(d.timeStamp), src: 'webNavigation', type,
    data: { frameId: d.frameId, parentFrameId: d.parentFrameId, url: d.url, error: d.error || null, transitionType: d.transitionType || null }
  });
};
chrome.webNavigation.onBeforeNavigate.addListener(wn('wn:before'));
chrome.webNavigation.onCommitted.addListener(wn('wn:committed'));
chrome.webNavigation.onDOMContentLoaded.addListener(wn('wn:dom'));
chrome.webNavigation.onCompleted.addListener(wn('wn:completed'));
chrome.webNavigation.onErrorOccurred.addListener(wn('wn:error'));

// Popup opened by window.open / target=_blank from a traced tab: attach it to the same trace.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  await ready;
  const root = activeMem.has(d.sourceTabId) ? d.sourceTabId : routeMem.get(d.sourceTabId);
  if (root == null) return;
  routeMem.set(d.tabId, root);
  persistRouting();
  record(d.tabId, { t: Math.round(d.timeStamp), src: 'webNavigation', type: 'wn:target', data: { sourceTabId: d.sourceTabId, tabId: d.tabId, url: d.url } });
  if (advancedOn) dbgAttach(d.tabId);
});
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (tab.openerTabId == null) return;
  const root = activeMem.has(tab.openerTabId) ? tab.openerTabId : routeMem.get(tab.openerTabId);
  if (root == null || routeMem.has(tab.id)) return;
  routeMem.set(tab.id, root);
  persistRouting();
  if (advancedOn) dbgAttach(tab.id);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await ready;
  if (activeMem.has(tabId)) refreshOrigin(tabId);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  routeMem.delete(tabId);
  rootOrigin.delete(tabId);
  dbgTabs.delete(tabId);
  if (activeMem.has(tabId)) {
    activeMem.delete(tabId);
    traces.delete(tabId);
    chrome.storage.session.remove('trace:' + tabId).catch(() => {});
  }
  persistRouting();
});

/* ---------- downloads (a PDF downloaded instead of displayed explains the missing print) ---------- */
chrome.downloads.onCreated.addListener((item) => {
  if (String(item.url).startsWith('blob:chrome-extension://' + chrome.runtime.id)) return; // nos propres exports
  recordEverywhere({
    t: Date.now(), src: 'download', type: 'dl:created',
    data: { id: item.id, url: item.url, finalUrl: item.finalUrl, mime: item.mime, filename: item.filename, state: item.state, byExtensionName: item.byExtensionName || null }
  });
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.error) return;
  recordEverywhere({
    t: Date.now(), src: 'download', type: 'dl:changed',
    data: { id: delta.id, state: delta.state && delta.state.current, error: delta.error && delta.error.current }
  });
});

/* ---------- advanced mode: chrome.debugger (attached only on request) ---------- */
const dbgTabs = new Set();
const attachedAt = new Map();   // tab -> time the debugger was attached
const netUrl = new Map();       // requestId (CDP) -> URL
let dbgRegistered = false;

function onDebuggerEvent(source, method, p) {
  const tabId = source.tabId;
  if (tabId == null || !p) return;
  const ts = p.timestamp || (p.entry && p.entry.timestamp);
  const epoch = typeof ts === 'number' && ts > 1e12;
  // Log.enable / Runtime.enable replay the page history: discard whatever predates the attach.
  if (epoch && /^(Log\.entryAdded|Runtime\.exceptionThrown|Runtime\.consoleAPICalled)$/.test(method) && ts < (attachedAt.get(tabId) || 0) - 50) return;
  const t = epoch ? Math.round(ts) : Date.now();
  const rec = (type, data) => record(tabId, { t, src: 'cdp', type, data });
  const urlOfReq = () => netUrl.get(p.requestId) || null;
  switch (method) {
    case 'Log.entryAdded': {
      const e = p.entry || {};
      // Messages emitted by Chrome itself (e.g. "Ignored call to 'print()'. The document is sandboxed…")
      if (e.level === 'warning' || e.level === 'error') rec('cdp:log', { source: e.source, level: e.level, text: cut(e.text, 500), url: cut(e.url, 200), line: e.lineNumber });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails || {};
      rec('cdp:exception', { text: cut((d.exception && d.exception.description) || d.text, 500), url: cut(d.url, 200), line: d.lineNumber });
      break;
    }
    case 'Runtime.consoleAPICalled':
      if (/^(error|warning|assert)$/.test(p.type)) {
        rec('cdp:console', { level: p.type, text: cut((p.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' '), 500) });
      }
      break;
    case 'Page.windowOpen':
      rec('cdp:windowOpen', { url: cut(p.url, 200), windowName: p.windowName, features: (p.windowFeatures || []).join(','), userGesture: p.userGesture });
      break;
    case 'Network.requestWillBeSent':
      netUrl.set(p.requestId, p.request && p.request.url);
      if (netUrl.size > 800) netUrl.delete(netUrl.keys().next().value);
      break;
    case 'Network.loadingFailed':
      if (p.blockedReason || p.corsErrorStatus || !p.canceled) {
        rec('cdp:loadingFailed', {
          url: urlOfReq(), errorText: p.errorText, blockedReason: p.blockedReason || null,
          cors: p.corsErrorStatus ? p.corsErrorStatus.corsError : null, canceled: !!p.canceled, resourceType: p.type
        });
      }
      break;
    case 'Network.requestWillBeSentExtraInfo': {
      const b = (p.associatedCookies || []).filter((c) => c.blockedReasons && c.blockedReasons.length);
      if (b.length) rec('cdp:cookiesBlocked', { direction: 'request', url: urlOfReq(), cookies: b.map((c) => ({ name: c.cookie && c.cookie.name, domain: c.cookie && c.cookie.domain, reasons: c.blockedReasons })) });
      break;
    }
    case 'Network.responseReceivedExtraInfo': {
      const b = p.blockedCookies || [];
      if (b.length) {
        rec('cdp:cookiesBlocked', {
          direction: 'response', url: urlOfReq(),
          cookies: b.map((c) => ({ name: (c.cookie && c.cookie.name) || String(c.cookieLine || '').split('=')[0], domain: c.cookie && c.cookie.domain, reasons: c.blockedReasons }))
        });
      }
      break;
    }
    case 'Target.attachedToTarget': {
      // Out-of-process frames (PDF viewer), workers: observe them too.
      const ti = p.targetInfo || {};
      rec('cdp:target', { type: ti.type, url: cut(ti.url, 200) });
      const dbg = chrome.debugger;
      if (dbg && p.sessionId) {
        const dbgee = { tabId, sessionId: p.sessionId };
        ['Log.enable', 'Runtime.enable', 'Network.enable'].forEach((m) => dbg.sendCommand(dbgee, m).catch(() => {}));
        dbg.sendCommand(dbgee, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      }
      break;
    }
    default: break;
  }
}
function registerDebuggerEvents() {
  if (dbgRegistered || !chrome.debugger) return;
  dbgRegistered = true;
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId == null) return;
    dbgTabs.delete(source.tabId);
    record(source.tabId, { t: Date.now(), src: 'cdp', type: 'cdp:detached', data: { reason } });
  });
}
registerDebuggerEvents();
chrome.permissions.onAdded.addListener(registerDebuggerEvents);

async function dbgAttach(tabId) {
  registerDebuggerEvents();
  const dbg = chrome.debugger;
  if (!dbg || dbgTabs.has(tabId)) return;
  // Mark the tab before awaiting: a popup triggers both tabs.onCreated and onCreatedNavigationTarget,
  // and a second concurrent attach would fail with "Another debugger is already attached".
  dbgTabs.add(tabId);
  attachedAt.set(tabId, Date.now());
  try {
    await dbg.attach({ tabId }, '1.3');
  } catch (e) {
    dbgTabs.delete(tabId);
    record(tabId, { t: Date.now(), src: 'cdp', type: 'cdp:attachError', data: { message: String((e && e.message) || e) } });
    return;
  }
  const send = (m, params) => dbg.sendCommand({ tabId }, m, params).catch(() => {});
  await Promise.all([send('Log.enable'), send('Runtime.enable'), send('Page.enable'), send('Network.enable')]);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}
async function dbgDetach(tabId) {
  if (!chrome.debugger || !dbgTabs.has(tabId)) return;
  dbgTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* already detached */ }
}
const tabsOfTrace = (root) => [root].concat([...routeMem].filter(([, r]) => r === root).map(([c]) => c));

/* ---------- environment (extensions, popup setting…) ---------- */
async function collectEnv(tabId) {
  const env = { collectedAt: Date.now(), userAgent: navigator.userAgent };
  try {
    const tab = await chrome.tabs.get(tabId);
    env.tabUrl = tab.url;
    env.incognito = tab.incognito;
    if (tab.url && /^https?:/.test(tab.url)) {
      const r = await chrome.contentSettings.popups.get({ primaryUrl: tab.url, incognito: tab.incognito });
      env.popupSetting = r && r.setting;
    }
  } catch (e) { env.popupSettingError = String((e && e.message) || e); }
  try { env.platform = await chrome.runtime.getPlatformInfo(); } catch (_) { /* ignore */ }
  try {
    const all = await chrome.management.getAll();
    env.extensions = all
      .filter((x) => x.type === 'extension' && x.enabled && x.id !== chrome.runtime.id)
      .map((x) => ({
        id: x.id, name: x.name, version: x.version, installType: x.installType,
        hostAll: (x.hostPermissions || []).some((p) => /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/.test(p)),
        permissions: x.permissions || []
      }));
  } catch (e) { env.extensionsError = String((e && e.message) || e); }
  env.advanced = advancedOn;
  const tr = await load(tabId);
  tr.env = env;
  scheduleFlush(tabId);
}

/* ---------- popup commands ---------- */
const setBadge = (tabId, on) => {
  chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#c62828' }).catch(() => {});
};
const controls = {
  async start({ tabId }) {
    await ready;
    for (const [child, root] of [...routeMem]) if (root === tabId) routeMem.delete(child);
    const tr = newTrace();
    tr.active = true;
    tr.startedAt = Date.now();
    traces.set(tabId, Promise.resolve(tr));
    activeMem.add(tabId);
    await refreshOrigin(tabId);
    await persistRouting();
    setBadge(tabId, true);
    scheduleFlush(tabId);
    collectEnv(tabId);
    if (advancedOn) await dbgAttach(tabId);
    return { ok: true };
  },
  async stop({ tabId }) {
    await ready;
    activeMem.delete(tabId);
    const tr = await load(tabId);
    tr.active = false;
    tr.stoppedAt = Date.now();
    for (const id of tabsOfTrace(tabId)) await dbgDetach(id);
    await persistRouting();
    setBadge(tabId, false);
    scheduleFlush(tabId);
    await flush();
    return { ok: true };
  },
  async clear({ tabId }) {
    await ready;
    const tr = await load(tabId);
    tr.events.length = 0;
    tr.env = null;
    scheduleFlush(tabId);
    if (tr.active) collectEnv(tabId);
    return { ok: true };
  },
  async get({ tabId }) {
    await ready;
    const tr = await load(tabId);
    return {
      active: activeMem.has(tabId), startedAt: tr.startedAt, stoppedAt: tr.stoppedAt,
      env: tr.env, events: tr.events, count: tr.events.length,
      advanced: advancedOn, debuggerAvailable: !!chrome.debugger, debuggerAttached: dbgTabs.has(tabId)
    };
  },
  async setAdvanced({ value }) {
    await ready;
    advancedOn = !!value;
    await chrome.storage.local.set({ advanced: advancedOn });
    if (advancedOn) {
      registerDebuggerEvents();
      for (const root of activeMem) for (const id of tabsOfTrace(root)) await dbgAttach(id);
    } else {
      for (const id of [...dbgTabs]) await dbgDetach(id);
    }
    return { ok: true, advanced: advancedOn, debuggerAvailable: !!chrome.debugger };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.kind !== 'string') return;
  if (msg.kind === 'page') {
    if (sender.tab && msg.ev && typeof msg.ev === 'object') {
      const ev = msg.ev;
      record(sender.tab.id, {
        t: Number(ev.t) || Date.now(), src: 'page', type: String(ev.type), top: !!ev.top,
        frameId: sender.frameId, frameUrl: ev.frameUrl, data: ev.data || {}
      });
    }
    return;
  }
  const handler = controls[msg.kind];
  if (!handler) return;
  handler(msg).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
