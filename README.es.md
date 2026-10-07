<p align="center"><img src="icons/icon-128.png" width="96" alt="Logo de PDF Print Tracer"></p>

# PDF Print Tracer

[![Tests](https://github.com/elfen/pdf-print-tracer-chrome/actions/workflows/tests.yml/badge.svg)](https://github.com/elfen/pdf-print-tracer-chrome/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/github/license/elfen/pdf-print-tracer-chrome)](LICENSE)
![Version](https://img.shields.io/github/manifest-json/v/elfen/pdf-print-tracer-chrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Chrome 119+](https://img.shields.io/badge/Chrome-119%2B-4285F4?logo=googlechrome&logoColor=white)
[![Privacy: no data collected](https://img.shields.io/badge/privacy-no%20data%20collected-2e7d32)](PRIVACY.md)
![i18n: en | fr | es | de](https://img.shields.io/badge/i18n-en%20%7C%20fr%20%7C%20es%20%7C%20de-blue)
![Last commit](https://img.shields.io/github/last-commit/elfen/pdf-print-tracer-chrome)

[English](README.md) · [Français](README.fr.md) · **Español** · [Deutsch](README.de.md)

**Descubre por qué un PDF no se imprime.** Extensión de Chrome (Manifest V3) que traza cada paso entre la respuesta HTTP que devuelve el PDF y el momento en que el cuadro de impresión está listo, e indica qué paso falla — o nunca se alcanza.

Está pensada para el clásico «en mi equipo funciona, en el suyo no»: filtrado de red, proxy o antivirus, otra extensión, política de empresa, ajustes del navegador, conexión lenta, bloqueador de ventanas emergentes, iframe con sandbox…

> El nombre y la descripción de la extensión están localizados (en, fr, es, de). Su interfaz (popup, veredictos, informes, logs) está en inglés.

## Inicio rápido

1. Descomprima, abra `chrome://extensions`, active el **Modo de desarrollador**, pulse **Cargar descomprimida** y elija la carpeta `pdf-print-tracer` (Chrome 119+). Fije el icono en la barra.
2. Abra la página de su aplicación, haga clic en el icono y luego en **Iniciar grabación** (la página se recarga para poder instrumentarla).
3. Reproduzca la impresión del PDF y vuelva a abrir el popup: se muestran el **veredicto** y la **tabla de pasos**. Use **Copiar informe** para pegarlo en un mensaje.

## Uso detallado

| Control | Qué hace |
|---|---|
| **Iniciar / Detener la grabación** | Graba la pestaña actual (insignia roja `REC`). Las ventanas abiertas con `window.open` desde esa pestaña se siguen automáticamente. Recarga opcional al iniciar. |
| **Borrar** | Vacía la traza de la pestaña. |
| **Copiar informe** | Informe en texto plano (veredicto, pasos, diagnósticos), listo para pegar. |
| **Exportar JSON** | Traza completa en un archivo. |
| **Comparar trazas…** | Abre una página donde se carga la traza A (equipo que funciona) y la traza B (equipo que falla): se resaltan los pasos cuyo estado difiere. |
| **Ocultar parámetros de URL** | Sustituye `?token=…` por `?…` en las exportaciones y los informes copiados (activado por defecto). |
| **Modo avanzado** | Conecta el depurador de Chrome a la pestaña (ver más abajo). Chrome muestra su aviso «está depurando este navegador». |
| **Selector de PDF** | Aparece cuando se registraron varias peticiones de PDF; cada intento se analiza por separado. |

**Leer el resultado.** El banner superior es el veredicto: **rojo** = se encontró un paso bloqueante (con causa y pista de solución); **naranja** = la cadena se detiene (un paso nunca se observa) o todo ocurrió con reservas; **verde** = todos los pasos observados están bien; **gris** = no se encontró ningún PDF en la traza. Cada fila de la tabla muestra el estado, la hora, el retardo desde la petición y el **retardo desde el paso anterior** (un intervalo superior a 3 s se resalta). Estados: ✔ OK · ⚠ OK con reservas · ✖ fallo · ? nunca observado · … no observable · – no aplicable · ⤼ no alcanzado (consecuencia de un fallo anterior).

**Modo avanzado** (permiso `debugger`, usado solo al marcar la casilla: el depurador solo se conecta a la pestaña en ese momento) añade lo que la página no puede ver por sí sola: los mensajes de consola propios de Chrome (p. ej. *«Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set.»*), el `userGesture` real de `window.open`, el motivo exacto de un bloqueo de red (CSP, contenido mixto, CORS, CORP/COEP, filtro de contenido), las cookies bloqueadas (nombre, dominio y motivo — nunca el valor) y los frames fuera de proceso (visor de PDF, Workers).

**Flujo típico.** En el equipo que falla: *Iniciar* → reproducir → *Copiar informe* (o *Exportar JSON*). Haga lo mismo en un equipo que funcione y use *Comparar trazas…* para localizar el primer paso que difiere.

## Los 13 pasos

| # | Paso | Fuente |
|---|---|---|
| 1 | Petición HTTP enviada | `webRequest.onBeforeRequest` |
| 2 | Cabeceras de respuesta recibidas (estado, Content-Type, Content-Disposition, X-Frame-Options, CSP) | `webRequest.onHeadersReceived` |
| 3 | Cuerpo recibido por completo, o error de red (`net::ERR_…`, explicado) | `webRequest.onCompleted / onErrorOccurred` |
| 4 | Respuesta recibida por JavaScript | hooks de `fetch` / `XMLHttpRequest` |
| 5 | Cuerpo leído como Blob/ArrayBuffer, firma `%PDF-` comprobada | `Response.blob/arrayBuffer`, hooks XHR |
| 6 | URL Blob creada (¿y revocada demasiado pronto?) | `URL.createObjectURL / revokeObjectURL` |
| 7 | Ventana emergente abierta (¿bloqueada? ¿último gesto del usuario demasiado antiguo?) | hook de `window.open` |
| 8 | iframe / embed / object insertado (¿`sandbox`?) o pestaña emergente creada | `MutationObserver`, `webNavigation` |
| 9 | Frame cargado | evento `load`, `webNavigation` |
| 10 | Visor de PDF de Chrome iniciado (o PDF descargado en su lugar) | `webNavigation`, `document.contentType`, `downloads`, `navigator.pdfViewerEnabled` |
| 11 | `print()` llamado (foco, visibilidad, activación, sandbox, frame de otro origen) | hooks de `window.print` e `iframe.contentWindow` |
| 12 | Cuadro de impresión abierto | `beforeprint` |
| 13 | Cuadro de impresión cerrado | `afterprint` |

## Casos tratados

**Red**

| Caso | Qué se ve | Causa probable / solución |
|---|---|---|
| HTTP 4xx/5xx en el PDF | El paso 2 falla con el código de estado | Sesión caducada, permisos, ruta incorrecta |
| 200 pero `Content-Type` no es PDF | Aviso en el paso 2 | El servidor o el proxy devuelve HTML/JSON |
| `Content-Disposition: attachment` | Aviso en el paso 2 | Chrome descarga en lugar de mostrar |
| `X-Frame-Options` / CSP `frame-ancestors` en un PDF incrustado | Aviso en el paso 2 | El iframe es rechazado |
| Cabecera CSP `sandbox` en el PDF | Aviso en el paso 2 | El visor no puede mostrar un documento con sandbox |
| Error de red de Chrome antes/durante la descarga | El paso 2 o 3 falla, error explicado en lenguaje claro | Bloqueo por una extensión, conexión restablecida/cerrada, timeout, DNS, túnel de proxy, flujo truncado (longitud incorrecta, chunked), HTTP/2, QUIC, TLS/certificado |
| La descarga empieza pero nunca termina (> 15 s) | El paso 3 falla | Proxy, cortafuegos o antivirus que retiene el flujo |
| Descarga muy lenta (> 8 s) | Aviso en el paso 3 | Red lenta |
| Cookies bloqueadas *(avanzado)* | Aviso en el paso 2 con nombres y motivos | Se devuelve una página de login en lugar del PDF |
| Motivo de bloqueo dado por Chrome *(avanzado)* | El paso 2 o 3 falla con el motivo | CSP, contenido mixto, CORS, CORP/COEP, filtro de contenido |

**JavaScript**

| Caso | Qué se ve | Causa probable / solución |
|---|---|---|
| `fetch` rechazado, XHR en error / abortado / timeout | El paso 4 falla | CORS, contenido mixto, extensión que bloquea, proxy, aborto del script |
| HTTP ≥ 400, tipo no PDF o respuesta opaca vista por el script | Fallo / aviso en el paso 4 | Error del servidor, tipo incorrecto, CORS |
| El cuerpo no empieza por `%PDF-` (página de login, error JSON con estado 200) | El paso 5 falla y muestra los primeros bytes | Sesión caducada, portal cautivo, proxy que reescribe |
| Cuerpo vacío (0 bytes), error al leer el cuerpo | El paso 5 falla | Flujo truncado |
| Blob sin tipo `application/pdf` | Aviso en el paso 6 | Visor no utilizado, descarga o frame en blanco |
| URL Blob revocada antes de `print()` (o en menos de 1,5 s) | El paso 6 falla / avisa | Carrera con un frame lento |
| Petición hecha por un Worker o Service Worker | Red trazada, pasos JavaScript «no aplicable» | Los Workers del mismo origen se asocian a la pestaña |
| Varias peticiones de PDF | Selector de PDF | Cada intento se analiza por separado |

**Ventana emergente**

| Caso | Qué se ve | Causa probable / solución |
|---|---|---|
| `window.open` devuelve `null` | El paso 7 falla con la antigüedad del último gesto del usuario | La activación transitoria (~5 s) caducó porque el PDF llegó lento: abra la ventana al hacer clic y asigne la URL Blob después |
| Ajuste del sitio «Ventanas emergentes» = bloqueado | Nota en el paso 7 | `chrome://settings/content/popups` |
| `userGesture` real *(avanzado)* | Nota en el paso 7 | Confirma o descarta la falta de gesto |
| Pestaña emergente | Se siguen su navegación, carga y cierre | Forma parte de la misma traza |

**Frame de visualización y visor**

| Caso | Qué se ve | Causa probable / solución |
|---|---|---|
| iframe/embed/object con `sandbox` | Aviso en el paso 8 (y falta `allow-modals`) | Añada `allow-modals` o no use sandbox |
| El frame nunca termina de cargar | Paso 9 no observado | Blob inválido o revocado, XFO/CSP, el visor no arranca |
| Error de carga o de navegación del frame | El paso 9 falla | Vea el error explicado |
| `print()` antes de que el frame termine de cargar | Aviso en el paso 9 | Espere al evento `load` |
| PDF descargado en lugar de mostrado | El paso 10 falla | `attachment`, Blob sin tipo, ajuste «Descargar PDF» |
| `navigator.pdfViewerEnabled = false` | El paso 10 falla | Ajuste o política de empresa (`AlwaysOpenPdfExternally`) |
| Frame del visor de PDF detectado | Paso 10 OK | — |

**Impresión**

| Caso | Qué se ve | Causa probable / solución |
|---|---|---|
| `print()` nunca llamado | Paso 11 no observado, con errores JS / rechazos / violaciones CSP listados | La cadena JavaScript se detiene antes |
| `print()` llamado pero ignorado | Aviso en el paso 11: sin foco, pestaña oculta, `sandbox` sin `allow-modals`, retorno inmediato sin `beforeprint` | Dé el foco, añada `allow-modals`, espere al PDF |
| `print()` sobre un frame de otro origen | El paso 11 falla (SecurityError explicado) | Imprima desde el propio frame (`postMessage`) o sirva el PDF como Blob del mismo origen |
| Mensaje de rechazo propio de Chrome *(avanzado)* | El paso 11 falla con el mensaje exacto | Siga el mensaje |
| Impresión sin `print()` observable | Paso 11 «no observable», paso 12 OK | Botón del visor, Ctrl+P |

**Entorno (diagnósticos generales)**: extensiones que pueden interferir (acceso a todos los sitios + red/descargas) y las instaladas por política, ajuste de ventanas emergentes, modo incógnito, sin conexión, conexión lenta (≤ 3G o RTT > 500 ms), violaciones CSP, errores JavaScript, número de `window.open` bloqueados, desglose de Resource Timing (DNS / conexión / TLS / espera del servidor / descarga), fallo al conectar el depurador o desconexión mediante el aviso.

## Límites

| Límite | Estado |
|---|---|
| Peticiones de un Service Worker / Worker (`tabId = -1`) | **Cubierto**: se asocian a la pestaña vigilada del mismo origen (su lado JavaScript sigue sin ser observable). |
| `print()` sobre un frame del mismo origen (incluido un PDF Blob) | **Cubierto**: el hook se instala en cuanto se accede a `iframe.contentWindow`. |
| `print()` sobre un frame de otro origen | **Explicado**: se detecta el acceso y el veredicto indica que está prohibido. |
| Rechazos de Chrome (impresión, ventana emergente) | **Cubierto en modo avanzado** (mensaje exacto); si no, se infiere. |
| Visor de PDF (paso 10) | **Confirmado en modo avanzado**; si no, se infiere por indicios indirectos. |
| Cuadro de impresión de Chrome dentro del visor de PDF | **Fuera de alcance**: interfaz interna de Chrome; solo se infiere su apertura (`beforeprint`). |
| Workers de un origen distinto al de la pestaña | No se pueden asociar de forma fiable. |

## Permisos y privacidad

| Permiso | Para qué |
|---|---|
| `webRequest`, acceso a hosts `<all_urls>` | Observar peticiones y respuestas (nunca bloquea ni modifica nada, nunca lee las cabeceras de petición) |
| `webNavigation`, `tabs` | Seguir los frames y ventanas emergentes de la pestaña vigilada |
| `downloads` | Detectar un PDF descargado en lugar de mostrado |
| `storage` | Conservar la traza en memoria de sesión |
| `management` | Listar las extensiones instaladas que podrían interferir |
| `contentSettings` | Leer el ajuste «Ventanas emergentes» del sitio |
| `debugger` | Solo para el modo avanzado — nunca se conecta sin que marque la casilla |

Las cabeceras de petición (cookies, Authorization) nunca se leen. Las URL se guardan con sus parámetros: la opción «ocultar parámetros de URL» (activada por defecto) los sustituye en las exportaciones y los informes copiados. En modo avanzado solo se conservan el nombre, el dominio y el motivo de las cookies bloqueadas, nunca su valor. Las trazas viven en la memoria de sesión (`chrome.storage.session`) y desaparecen al cerrar Chrome. Nunca se envía nada a ningún sitio.

## Pruebas

```
node test/test-analysis.js                       # 23 escenarios de análisis
PLAYWRIGHT_MODULE=… node test/test-inject.js     # hooks de página en Chromium
PLAYWRIGHT_MODULE=… node test/test-e2e.js        # la extensión real cargada en Chromium
```

Origen del logo: `icons/icon.svg` (PNG de 16 / 32 / 48 / 128 / 512 generados a partir de él).

## Licencia y créditos

Licencia MIT — véase [LICENSE](LICENSE). Si reutiliza este código, conserve el aviso de copyright y el texto de la licencia (obligación de atribución de la MIT) y mencione el proyecto: **PDF Print Tracer por elfen** — https://github.com/elfen/pdf-print-tracer-chrome

Privacidad y RGPD: véase [PRIVACY.md](PRIVACY.md) (en inglés). Antes de publicar un informe en una issue pública, revíselo y elimine los datos personales.
