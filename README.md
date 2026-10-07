<p align="center"><img src="icons/icon-128.png" width="96" alt="PDF Print Tracer logo"></p>

# PDF Print Tracer

**English** · [Français](README.fr.md) · [Español](README.es.md) · [Deutsch](README.de.md)

**Finds out why a PDF will not print.** A Chrome extension (Manifest V3) that traces every step between the HTTP response carrying the PDF and the moment the print dialog is ready, and tells you which step fails — or is never reached.

It is built for the classic "it works on my machine but not on theirs": network filtering, proxy or antivirus, another extension, enterprise policy, browser settings, a slow connection, the popup blocker, a sandboxed iframe…

> The extension's name and description are localized (en, fr, es, de). Its interface (popup, verdicts, reports, logs) is in English.

## Quick start

1. Unzip, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the `pdf-print-tracer` folder (Chrome 119+). Pin the icon.
2. Open the page of your application, click the icon, then **Start recording** (the page reloads so it can be instrumented).
3. Reproduce the PDF printing, then reopen the popup: the **verdict** and the **step table** are displayed. Use **Copy report** to paste it into a message.

## Using it in detail

| Control | What it does |
|---|---|
| **Start / Stop recording** | Records the current tab (red `REC` badge). Popups opened by `window.open` from that tab are followed automatically. Optional page reload at start. |
| **Clear** | Empties the trace of the tab. |
| **Copy report** | Plain-text report (verdict, steps, diagnostics), ready to paste. |
| **Export JSON** | Full trace as a file. |
| **Compare traces…** | Opens a page where you load trace A (machine that works) and trace B (machine that fails): steps whose status differs are highlighted. |
| **Mask URL parameters** | Replaces `?token=…` by `?…` in exports and copied reports (checked by default). |
| **Advanced mode** | Attaches Chrome's debugger to the tab (see below). Chrome shows its "debugging this browser" banner. |
| **PDF selector** | Appears when several PDF requests were recorded; each attempt is analysed separately. |

**Reading the result.** The banner at the top is the verdict: **red** = a blocking step was found (with cause and fix hint); **orange** = the chain stops (a step is never observed) or everything happened with reservations; **green** = all observed steps are fine; **grey** = no PDF found in the trace. Each row of the table shows the status, the time, the delay since the request and the **delay since the previous step** (a gap above 3 s is highlighted). Statuses: ✔ OK · ⚠ OK with reservation · ✖ failure · ? never observed · … not observable · – not applicable · ⤼ not reached (consequence of an earlier failure).

**Advanced mode** (permission `debugger`, used only when you tick the box: the debugger is attached to the tab only then) adds what the page cannot see by itself: Chrome's own console messages (e.g. *"Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set."*), the real `userGesture` of `window.open`, the exact reason of a network block (CSP, mixed content, CORS, CORP/COEP, content filter), blocked cookies (name, domain and reason — never the value), and out-of-process frames (PDF viewer, Workers).

**Typical workflow.** On the machine that fails: *Start* → reproduce → *Copy report* (or *Export JSON*). Do the same on a machine that works and use *Compare traces…* to spot the first step that differs.

## The 13 steps

| # | Step | Source |
|---|---|---|
| 1 | HTTP request sent | `webRequest.onBeforeRequest` |
| 2 | Response headers received (status, Content-Type, Content-Disposition, X-Frame-Options, CSP) | `webRequest.onHeadersReceived` |
| 3 | Body fully received, or network error (`net::ERR_…`, explained) | `webRequest.onCompleted / onErrorOccurred` |
| 4 | Response received by JavaScript | `fetch` / `XMLHttpRequest` hooks |
| 5 | Body read as Blob/ArrayBuffer, `%PDF-` signature checked | `Response.blob/arrayBuffer`, XHR hooks |
| 6 | Blob URL created (and revoked too early?) | `URL.createObjectURL / revokeObjectURL` |
| 7 | Popup opened (blocked? last user gesture too old?) | `window.open` hook |
| 8 | iframe / embed / object inserted (`sandbox`?) or popup tab created | `MutationObserver`, `webNavigation` |
| 9 | Frame loaded | `load` event, `webNavigation` |
| 10 | Chrome PDF viewer started (or PDF downloaded instead) | `webNavigation`, `document.contentType`, `downloads`, `navigator.pdfViewerEnabled` |
| 11 | `print()` called (focus, visibility, activation, sandbox, cross-origin frame) | `window.print` and `iframe.contentWindow` hooks |
| 12 | Print dialog opened | `beforeprint` |
| 13 | Print dialog closed | `afterprint` |

## Cases handled

**Network**

| Case | What you see | Likely cause / fix |
|---|---|---|
| HTTP 4xx/5xx on the PDF | Step 2 fails with the status | Expired session, permissions, wrong route |
| 200 but `Content-Type` is not PDF | Step 2 warning | Server or proxy returns HTML/JSON |
| `Content-Disposition: attachment` | Step 2 warning | Chrome downloads instead of displaying |
| `X-Frame-Options` / CSP `frame-ancestors` on a framed PDF | Step 2 warning | The iframe is refused |
| CSP `sandbox` header on the PDF | Step 2 warning | The viewer cannot render a sandboxed document |
| Chrome network error before/during download | Step 2 or 3 fails, error explained in plain words | Blocked by an extension, connection reset/closed, timeout, DNS, proxy tunnel, truncated stream (length mismatch, chunked), HTTP/2, QUIC, TLS/certificate |
| Download starts but never ends (> 15 s) | Step 3 fails | Proxy, firewall or antivirus holding the stream |
| Very slow download (> 8 s) | Step 3 warning | Slow network |
| Blocked cookies *(advanced)* | Step 2 warning with names and reasons | A login page is returned instead of the PDF |
| Block reason from Chrome *(advanced)* | Step 2 or 3 fails with the reason | CSP, mixed content, CORS, CORP/COEP, content filter |

**JavaScript**

| Case | What you see | Likely cause / fix |
|---|---|---|
| `fetch` rejected, XHR error / abort / timeout | Step 4 fails | CORS, mixed content, blocking extension, proxy, script abort |
| HTTP ≥ 400, non-PDF type or opaque response seen by the script | Step 4 failure / warning | Server error, wrong type, CORS |
| Body does not start with `%PDF-` (login page, JSON error with status 200) | Step 5 fails and shows the first bytes | Session expired, captive portal, proxy rewriting |
| Empty body (0 bytes), body read error | Step 5 fails | Truncated stream |
| Blob without `application/pdf` type | Step 6 warning | Viewer not used, download or blank frame |
| Blob URL revoked before `print()` (or within 1.5 s) | Step 6 fails / warns | Race with a slow frame |
| Request made by a Worker or Service Worker | Network traced, JavaScript steps "not applicable" | Same-origin Workers are attached to the tab |
| Several PDF requests | PDF selector | Each attempt is analysed on its own |

**Popup**

| Case | What you see | Likely cause / fix |
|---|---|---|
| `window.open` returns `null` | Step 7 fails with the age of the last user gesture | Transient activation (~5 s) expired because the PDF arrived slowly: open the window on click, assign the Blob URL later |
| Site setting "Pop-ups" = blocked | Note in step 7 | `chrome://settings/content/popups` |
| Real `userGesture` *(advanced)* | Note in step 7 | Confirms or rules out a missing gesture |
| Popup tab | Its navigation, load and closing are followed | Part of the same trace |

**Display frame and viewer**

| Case | What you see | Likely cause / fix |
|---|---|---|
| iframe/embed/object with `sandbox` | Step 8 warning (and missing `allow-modals`) | Add `allow-modals`, or do not sandbox |
| Frame never finishes loading | Step 9 not observed | Invalid or revoked Blob, XFO/CSP, viewer not starting |
| Frame load or navigation error | Step 9 fails | See the explained error |
| `print()` before the frame finished loading | Step 9 warning | Wait for `load` |
| PDF downloaded instead of displayed | Step 10 fails | `attachment`, Blob without type, "Download PDFs" setting |
| `navigator.pdfViewerEnabled = false` | Step 10 fails | Setting or enterprise policy (`AlwaysOpenPdfExternally`) |
| PDF viewer frame detected | Step 10 OK | — |

**Printing**

| Case | What you see | Likely cause / fix |
|---|---|---|
| `print()` never called | Step 11 not observed, with JS errors / rejections / CSP violations listed | The JavaScript chain stops before |
| `print()` called but ignored | Step 11 warning: no focus, hidden tab, `sandbox` without `allow-modals`, returned instantly without `beforeprint` | Give focus, add `allow-modals`, wait for the PDF |
| `print()` on a cross-origin frame | Step 11 fails (SecurityError explained) | Print from the frame itself (`postMessage`) or serve the PDF as a same-origin Blob |
| Chrome's own refusal message *(advanced)* | Step 11 fails with the exact message | Follow the message |
| Print without an observable `print()` | Step 11 "not observable", step 12 OK | Viewer button, Ctrl+P |

**Environment (general diagnostics)**: extensions that may interfere (access to all sites + network/downloads) and policy-installed ones, popup setting, incognito, offline, slow connection (≤ 3G or RTT > 500 ms), CSP violations, JavaScript errors, number of blocked `window.open`, Resource Timing breakdown (DNS / connect / TLS / server wait / download), debugger attach failure or detach via the banner.

## Limits

| Limit | Status |
|---|---|
| Requests from a Service Worker / Worker (`tabId = -1`) | **Covered**: attached to the tracked tab of the same origin (their JavaScript side stays unobservable). |
| `print()` on a same-origin frame (including a Blob PDF) | **Covered**: the hook is installed as soon as `iframe.contentWindow` is accessed. |
| `print()` on a cross-origin frame | **Explained**: access is detected and the verdict states it is forbidden. |
| Refusals by Chrome (print, popup) | **Covered in advanced mode** (exact message); otherwise inferred. |
| PDF viewer (step 10) | **Confirmed in advanced mode**; otherwise inferred from indirect clues. |
| Inside the PDF viewer, Chrome's print dialog | **Out of reach**: internal Chrome UI; only its opening is inferred (`beforeprint`). |
| Workers of another origin than the tab | Cannot be attached reliably. |

## Permissions and privacy

| Permission | Why |
|---|---|
| `webRequest`, host access `<all_urls>` | Observe requests and responses (never blocks or modifies anything, never reads request headers) |
| `webNavigation`, `tabs` | Follow frames and popups of the tracked tab |
| `downloads` | Detect a PDF downloaded instead of displayed |
| `storage` | Keep the trace in session memory |
| `management` | List installed extensions that could interfere |
| `contentSettings` | Read the "Pop-ups" setting of the site |
| `debugger` | Advanced mode only — never attached unless you tick the box |

Request headers (cookies, Authorization) are never read. URLs are stored with their parameters: the "mask URL parameters" option (on by default) replaces them in exports and copied reports. In advanced mode only the name, domain and reason of blocked cookies are kept, never their value. Traces live in session memory (`chrome.storage.session`) and disappear when Chrome closes. Nothing is ever sent anywhere.

## Tests

```
node test/test-analysis.js                       # 23 analysis scenarios
PLAYWRIGHT_MODULE=… node test/test-inject.js     # page hooks in Chromium
PLAYWRIGHT_MODULE=… node test/test-e2e.js        # the real extension loaded in Chromium
```

Source of the logo: `icons/icon.svg` (PNG 16 / 32 / 48 / 128 / 512 generated from it).

## License and credits

MIT License — see [LICENSE](LICENSE). If you reuse this code, keep the copyright notice and the license text (this is the MIT attribution requirement) and please credit the project: **PDF Print Tracer by elfen** — https://github.com/elfen/pdf-print-tracer-chrome

Privacy and GDPR notes: see [PRIVACY.md](PRIVACY.md). Before posting a report in a public issue, review and redact it.
