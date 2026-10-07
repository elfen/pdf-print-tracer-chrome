<p align="center"><img src="icons/icon-128.png" width="96" alt="PDF-Print-Tracer-Logo"></p>

# PDF Print Tracer

[![Tests](https://github.com/elfen/pdf-print-tracer-chrome/actions/workflows/tests.yml/badge.svg)](https://github.com/elfen/pdf-print-tracer-chrome/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/github/license/elfen/pdf-print-tracer-chrome)](LICENSE)
![Version](https://img.shields.io/github/manifest-json/v/elfen/pdf-print-tracer-chrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Chrome 119+](https://img.shields.io/badge/Chrome-119%2B-4285F4?logo=googlechrome&logoColor=white)
[![Privacy: no data collected](https://img.shields.io/badge/privacy-no%20data%20collected-2e7d32)](PRIVACY.md)
![i18n: en | fr | es | de](https://img.shields.io/badge/i18n-en%20%7C%20fr%20%7C%20es%20%7C%20de-blue)
![Last commit](https://img.shields.io/github/last-commit/elfen/pdf-print-tracer-chrome)

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · **Deutsch**

**Findet heraus, warum ein PDF nicht gedruckt wird.** Eine Chrome-Erweiterung (Manifest V3), die jeden Schritt zwischen der HTTP-Antwort mit dem PDF und dem Moment, in dem der Druckdialog bereit ist, aufzeichnet und anzeigt, welcher Schritt fehlschlägt — oder nie erreicht wird.

Gedacht für das klassische „Bei mir funktioniert es, bei denen nicht": Netzwerkfilter, Proxy oder Virenscanner, eine andere Erweiterung, Unternehmensrichtlinie, Browser-Einstellungen, langsame Verbindung, Popup-Blocker, iframe mit Sandbox …

> Name und Beschreibung der Erweiterung sind lokalisiert (en, fr, es, de). Die Oberfläche (Popup, Befunde, Berichte, Logs) ist auf Englisch.

## Schnellstart

1. Entpacken, `chrome://extensions` öffnen, den **Entwicklermodus** aktivieren, auf **Entpackte Erweiterung laden** klicken und den Ordner `pdf-print-tracer` wählen (Chrome 119+). Das Symbol anheften.
2. Die Seite Ihrer Anwendung öffnen, auf das Symbol klicken, dann auf **Aufzeichnung starten** (die Seite wird neu geladen, damit sie instrumentiert werden kann).
3. Den PDF-Druck reproduzieren und das Popup erneut öffnen: **Befund** und **Schritttabelle** werden angezeigt. Mit **Bericht kopieren** lässt er sich in eine Nachricht einfügen.

## Bedienung im Detail

| Bedienelement | Funktion |
|---|---|
| **Aufzeichnung starten / stoppen** | Zeichnet den aktuellen Tab auf (rotes `REC`-Abzeichen). Per `window.open` aus diesem Tab geöffnete Fenster werden automatisch mitverfolgt. Optionales Neuladen beim Start. |
| **Leeren** | Löscht die Aufzeichnung des Tabs. |
| **Bericht kopieren** | Textbericht (Befund, Schritte, Diagnosen), bereit zum Einfügen. |
| **JSON exportieren** | Vollständige Aufzeichnung als Datei. |
| **Aufzeichnungen vergleichen …** | Öffnet eine Seite, in die Aufzeichnung A (Rechner, auf dem es funktioniert) und B (Rechner, auf dem es fehlschlägt) geladen werden: Schritte mit abweichendem Status werden hervorgehoben. |
| **URL-Parameter maskieren** | Ersetzt `?token=…` durch `?…` in Exporten und kopierten Berichten (standardmäßig aktiviert). |
| **Erweiterter Modus** | Verbindet den Chrome-Debugger mit dem Tab (siehe unten). Chrome zeigt seinen Hinweis „Dieser Browser wird debuggt" an. |
| **PDF-Auswahl** | Erscheint, wenn mehrere PDF-Anfragen aufgezeichnet wurden; jeder Versuch wird einzeln analysiert. |

**Das Ergebnis lesen.** Das Banner oben ist der Befund: **rot** = ein blockierender Schritt wurde gefunden (mit Ursache und Lösungshinweis); **orange** = die Kette bricht ab (ein Schritt wird nie beobachtet) oder alles lief nur mit Vorbehalten; **grün** = alle beobachteten Schritte sind in Ordnung; **grau** = in der Aufzeichnung wurde kein PDF gefunden. Jede Tabellenzeile zeigt Status, Uhrzeit, Verzögerung seit der Anfrage und die **Verzögerung seit dem vorherigen Schritt** (eine Lücke über 3 s wird hervorgehoben). Status: ✔ OK · ⚠ OK mit Vorbehalt · ✖ Fehler · ? nie beobachtet · … nicht beobachtbar · – nicht zutreffend · ⤼ nicht erreicht (Folge eines früheren Fehlers).

**Erweiterter Modus** (Berechtigung `debugger`, nur beim Anhaken der Option genutzt: erst dann wird der Debugger an den Tab angehängt) liefert, was die Seite selbst nicht sehen kann: Chromes eigene Konsolenmeldungen (z. B. *„Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set."*), das echte `userGesture` von `window.open`, den genauen Grund einer Netzwerksperre (CSP, Mixed Content, CORS, CORP/COEP, Inhaltsfilter), blockierte Cookies (Name, Domain und Grund — nie der Wert) sowie prozessexterne Frames (PDF-Viewer, Workers).

**Typischer Ablauf.** Auf dem Rechner, auf dem es fehlschlägt: *Starten* → reproduzieren → *Bericht kopieren* (oder *JSON exportieren*). Dasselbe auf einem Rechner, auf dem es funktioniert, und mit *Aufzeichnungen vergleichen …* den ersten abweichenden Schritt finden.

## Die 13 Schritte

| # | Schritt | Quelle |
|---|---|---|
| 1 | HTTP-Anfrage gesendet | `webRequest.onBeforeRequest` |
| 2 | Antwort-Header empfangen (Status, Content-Type, Content-Disposition, X-Frame-Options, CSP) | `webRequest.onHeadersReceived` |
| 3 | Body vollständig empfangen oder Netzwerkfehler (`net::ERR_…`, erklärt) | `webRequest.onCompleted / onErrorOccurred` |
| 4 | Antwort von JavaScript empfangen | Hooks auf `fetch` / `XMLHttpRequest` |
| 5 | Body als Blob/ArrayBuffer gelesen, `%PDF-`-Signatur geprüft | `Response.blob/arrayBuffer`, XHR-Hooks |
| 6 | Blob-URL erstellt (und zu früh widerrufen?) | `URL.createObjectURL / revokeObjectURL` |
| 7 | Popup geöffnet (blockiert? letzte Nutzerinteraktion zu lange her?) | `window.open`-Hook |
| 8 | iframe / embed / object eingefügt (`sandbox`?) oder Popup-Tab erstellt | `MutationObserver`, `webNavigation` |
| 9 | Frame geladen | `load`-Ereignis, `webNavigation` |
| 10 | Chrome-PDF-Viewer gestartet (oder PDF stattdessen heruntergeladen) | `webNavigation`, `document.contentType`, `downloads`, `navigator.pdfViewerEnabled` |
| 11 | `print()` aufgerufen (Fokus, Sichtbarkeit, Aktivierung, Sandbox, Cross-Origin-Frame) | Hooks auf `window.print` und `iframe.contentWindow` |
| 12 | Druckdialog geöffnet | `beforeprint` |
| 13 | Druckdialog geschlossen | `afterprint` |

## Behandelte Fälle

**Netzwerk**

| Fall | Was Sie sehen | Wahrscheinliche Ursache / Abhilfe |
|---|---|---|
| HTTP 4xx/5xx beim PDF | Schritt 2 schlägt mit dem Status fehl | Abgelaufene Sitzung, Berechtigungen, falsche Route |
| 200, aber `Content-Type` ist kein PDF | Warnung in Schritt 2 | Server oder Proxy liefert HTML/JSON |
| `Content-Disposition: attachment` | Warnung in Schritt 2 | Chrome lädt herunter, statt anzuzeigen |
| `X-Frame-Options` / CSP `frame-ancestors` bei eingebettetem PDF | Warnung in Schritt 2 | Der iframe wird abgelehnt |
| CSP-`sandbox`-Header am PDF | Warnung in Schritt 2 | Der Viewer kann kein Sandbox-Dokument darstellen |
| Chrome-Netzwerkfehler vor/während des Downloads | Schritt 2 oder 3 schlägt fehl, Fehler in verständlichen Worten erklärt | Blockade durch eine Erweiterung, Verbindung zurückgesetzt/geschlossen, Timeout, DNS, Proxy-Tunnel, abgeschnittener Stream (Längenabweichung, chunked), HTTP/2, QUIC, TLS/Zertifikat |
| Download beginnt, endet aber nie (> 15 s) | Schritt 3 schlägt fehl | Proxy, Firewall oder Virenscanner hält den Stream zurück |
| Sehr langsamer Download (> 8 s) | Warnung in Schritt 3 | Langsames Netzwerk |
| Blockierte Cookies *(erweitert)* | Warnung in Schritt 2 mit Namen und Gründen | Statt des PDFs wird eine Login-Seite geliefert |
| Von Chrome gemeldeter Sperrgrund *(erweitert)* | Schritt 2 oder 3 schlägt mit dem Grund fehl | CSP, Mixed Content, CORS, CORP/COEP, Inhaltsfilter |

**JavaScript**

| Fall | Was Sie sehen | Wahrscheinliche Ursache / Abhilfe |
|---|---|---|
| `fetch` abgelehnt, XHR-Fehler / Abbruch / Timeout | Schritt 4 schlägt fehl | CORS, Mixed Content, blockierende Erweiterung, Proxy, Skript-Abbruch |
| HTTP ≥ 400, Nicht-PDF-Typ oder opake Antwort aus Sicht des Skripts | Fehler / Warnung in Schritt 4 | Serverfehler, falscher Typ, CORS |
| Body beginnt nicht mit `%PDF-` (Login-Seite, JSON-Fehler mit Status 200) | Schritt 5 schlägt fehl und zeigt die ersten Bytes | Sitzung abgelaufen, Captive Portal, Proxy schreibt um |
| Leerer Body (0 Bytes), Lesefehler | Schritt 5 schlägt fehl | Abgeschnittener Stream |
| Blob ohne Typ `application/pdf` | Warnung in Schritt 6 | Viewer nicht genutzt, Download oder leerer Frame |
| Blob-URL vor `print()` widerrufen (oder innerhalb von 1,5 s) | Schritt 6 schlägt fehl / warnt | Wettlauf mit einem langsamen Frame |
| Anfrage von einem Worker oder Service Worker | Netzwerk aufgezeichnet, JavaScript-Schritte „nicht zutreffend" | Same-Origin-Workers werden dem Tab zugeordnet |
| Mehrere PDF-Anfragen | PDF-Auswahl | Jeder Versuch wird einzeln analysiert |

**Popup**

| Fall | Was Sie sehen | Wahrscheinliche Ursache / Abhilfe |
|---|---|---|
| `window.open` liefert `null` | Schritt 7 schlägt fehl, mit dem Alter der letzten Nutzerinteraktion | Die transiente Aktivierung (~5 s) ist abgelaufen, weil das PDF langsam kam: Fenster beim Klick öffnen, Blob-URL später zuweisen |
| Website-Einstellung „Pop-ups" = blockiert | Hinweis in Schritt 7 | `chrome://settings/content/popups` |
| Echtes `userGesture` *(erweitert)* | Hinweis in Schritt 7 | Bestätigt oder widerlegt eine fehlende Nutzerinteraktion |
| Popup-Tab | Navigation, Laden und Schließen werden verfolgt | Teil derselben Aufzeichnung |

**Anzeige-Frame und Viewer**

| Fall | Was Sie sehen | Wahrscheinliche Ursache / Abhilfe |
|---|---|---|
| iframe/embed/object mit `sandbox` | Warnung in Schritt 8 (und fehlendes `allow-modals`) | `allow-modals` hinzufügen oder keine Sandbox verwenden |
| Frame wird nie fertig geladen | Schritt 9 nicht beobachtet | Ungültiger oder widerrufener Blob, XFO/CSP, Viewer startet nicht |
| Lade- oder Navigationsfehler des Frames | Schritt 9 schlägt fehl | Siehe den erklärten Fehler |
| `print()` bevor der Frame fertig geladen ist | Warnung in Schritt 9 | Auf `load` warten |
| PDF heruntergeladen statt angezeigt | Schritt 10 schlägt fehl | `attachment`, Blob ohne Typ, Einstellung „PDFs herunterladen" |
| `navigator.pdfViewerEnabled = false` | Schritt 10 schlägt fehl | Einstellung oder Unternehmensrichtlinie (`AlwaysOpenPdfExternally`) |
| PDF-Viewer-Frame erkannt | Schritt 10 OK | — |

**Drucken**

| Fall | Was Sie sehen | Wahrscheinliche Ursache / Abhilfe |
|---|---|---|
| `print()` nie aufgerufen | Schritt 11 nicht beobachtet, mit aufgelisteten JS-Fehlern / Rejections / CSP-Verstößen | Die JavaScript-Kette bricht vorher ab |
| `print()` aufgerufen, aber ignoriert | Warnung in Schritt 11: kein Fokus, versteckter Tab, `sandbox` ohne `allow-modals`, sofortige Rückkehr ohne `beforeprint` | Fokus geben, `allow-modals` hinzufügen, auf das PDF warten |
| `print()` auf einem Cross-Origin-Frame | Schritt 11 schlägt fehl (SecurityError erklärt) | Aus dem Frame selbst drucken (`postMessage`) oder das PDF als Same-Origin-Blob ausliefern |
| Chromes eigene Ablehnungsmeldung *(erweitert)* | Schritt 11 schlägt mit der genauen Meldung fehl | Der Meldung folgen |
| Drucken ohne beobachtbares `print()` | Schritt 11 „nicht beobachtbar", Schritt 12 OK | Viewer-Schaltfläche, Strg+P |

**Umgebung (allgemeine Diagnosen)**: möglicherweise störende Erweiterungen (Zugriff auf alle Websites + Netzwerk/Downloads) und per Richtlinie installierte, Popup-Einstellung, Inkognito, offline, langsame Verbindung (≤ 3G oder RTT > 500 ms), CSP-Verstöße, JavaScript-Fehler, Anzahl blockierter `window.open`, Resource-Timing-Aufschlüsselung (DNS / Verbindung / TLS / Serverwartezeit / Download), Fehler beim Anhängen des Debuggers oder Trennung über den Hinweis.

## Grenzen

| Grenze | Stand |
|---|---|
| Anfragen eines Service Workers / Workers (`tabId = -1`) | **Abgedeckt**: dem überwachten Tab desselben Origins zugeordnet (ihre JavaScript-Seite bleibt nicht beobachtbar). |
| `print()` auf einem Same-Origin-Frame (inkl. Blob-PDF) | **Abgedeckt**: der Hook wird installiert, sobald auf `iframe.contentWindow` zugegriffen wird. |
| `print()` auf einem Cross-Origin-Frame | **Erklärt**: der Zugriff wird erkannt und der Befund nennt das Verbot. |
| Ablehnungen durch Chrome (Drucken, Popup) | **Im erweiterten Modus abgedeckt** (genaue Meldung); sonst abgeleitet. |
| PDF-Viewer (Schritt 10) | **Im erweiterten Modus bestätigt**; sonst aus indirekten Hinweisen abgeleitet. |
| Chromes Druckdialog im PDF-Viewer | **Außer Reichweite**: interne Chrome-Oberfläche; nur das Öffnen wird abgeleitet (`beforeprint`). |
| Workers eines anderen Origins als der Tab | Lassen sich nicht zuverlässig zuordnen. |

## Berechtigungen und Datenschutz

| Berechtigung | Wozu |
|---|---|
| `webRequest`, Host-Zugriff `<all_urls>` | Anfragen und Antworten beobachten (blockiert oder verändert nie etwas, liest nie Anfrage-Header) |
| `webNavigation`, `tabs` | Frames und Popups des überwachten Tabs verfolgen |
| `downloads` | Ein heruntergeladenes statt angezeigtes PDF erkennen |
| `storage` | Die Aufzeichnung im Sitzungsspeicher halten |
| `management` | Installierte Erweiterungen auflisten, die stören könnten |
| `contentSettings` | Die Popup-Einstellung der Website lesen |
| `debugger` | Nur für den erweiterten Modus — wird ohne Ihr Anhaken nie angehängt |

Anfrage-Header (Cookies, Authorization) werden nie gelesen. URLs werden mit ihren Parametern gespeichert: Die Option „URL-Parameter maskieren" (standardmäßig aktiv) ersetzt sie in Exporten und kopierten Berichten. Im erweiterten Modus werden nur Name, Domain und Grund blockierter Cookies behalten, nie ihr Wert. Aufzeichnungen liegen im Sitzungsspeicher (`chrome.storage.session`) und verschwinden beim Schließen von Chrome. Es wird nie etwas irgendwohin gesendet.

## Tests

```
node test/test-analysis.js                       # 23 Analyse-Szenarien
PLAYWRIGHT_MODULE=… node test/test-inject.js     # Seiten-Hooks in Chromium
PLAYWRIGHT_MODULE=… node test/test-e2e.js        # die echte Erweiterung in Chromium geladen
```

Quelle des Logos: `icons/icon.svg` (daraus erzeugte PNGs in 16 / 32 / 48 / 128 / 512).

## Lizenz und Credits

MIT-Lizenz — siehe [LICENSE](LICENSE). Bei Wiederverwendung des Codes müssen der Copyright-Vermerk und der Lizenztext beibehalten werden (Namensnennungspflicht der MIT-Lizenz); bitte nennen Sie das Projekt: **PDF Print Tracer von elfen** — https://github.com/elfen/pdf-print-tracer-chrome

Datenschutz und DSGVO: siehe [PRIVACY.md](PRIVACY.md) (auf Englisch). Prüfen und schwärzen Sie einen Bericht, bevor Sie ihn in einer öffentlichen Issue posten.
