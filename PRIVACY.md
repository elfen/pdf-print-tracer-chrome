# Privacy

**PDF Print Tracer does not collect, transmit or share any data.** The author operates no server, no analytics and no telemetry. The extension makes no network request of its own.

## What the extension records (locally only)

While recording is on for a tab, it keeps a trace of that tab in the browser's session memory (`chrome.storage.session`):

- URLs of requests and navigations (parameters can be masked in exports — option enabled by default), HTTP status, a few response headers (Content-Type, Content-Disposition, X-Frame-Options, CSP), timings, remote server IP address;
- page events (fetch/XHR, Blob URLs, `window.open`, `print()`, JavaScript errors, CSP violations);
- environment: Chrome version / user agent, names and permissions of installed extensions, the site's pop-up setting, connection type;
- advanced mode only: Chrome console messages, and the name / domain / reason of blocked cookies.

It **never reads** request headers, cookie values, form data, page content or the content of the PDF (only its first bytes, to check the `%PDF-` signature).

The trace disappears when Chrome is closed or when you press **Clear**. Nothing leaves your computer unless **you** use *Copy report* or *Export JSON*.

## GDPR notes for users

- Recording starts only on your action, on the tab you choose, and can be stopped at any time. The debugger permission is used only when you tick *Advanced mode*.
- A copied or exported report can contain personal data of the people whose session was traced (URLs, file names, IP addresses, installed extensions). You are responsible for it as soon as you export it: review and redact it before sharing it (for example in a public issue), and do not trace sessions of other people without a legal basis and information.
- This repository itself contains no personal data: test fixtures use fictitious values (`127.0.0.1`, `*.test`).

## Contact

Open an issue on the repository.
