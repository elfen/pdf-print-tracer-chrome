<p align="center"><img src="icons/icon-128.png" width="96" alt="Logo PDF Print Tracer"></p>

# PDF Print Tracer

[English](README.md) · **Français** · [Español](README.es.md) · [Deutsch](README.de.md)

**Trouve pourquoi un PDF ne s'imprime pas.** Extension Chrome (Manifest V3) qui trace chaque étape entre la réponse HTTP qui porte le PDF et le moment où le dialogue d'impression est prêt, et indique quelle étape échoue — ou n'est jamais atteinte.

Elle est conçue pour le classique « ça marche chez moi mais pas chez eux » : filtrage réseau, proxy ou antivirus, autre extension, stratégie d'entreprise, réglages du navigateur, connexion lente, bloqueur de popups, iframe sandboxé…

> Le nom et la description de l'extension sont localisés (en, fr, es, de). Son interface (popup, verdicts, rapports, logs) est en anglais.

## Démarrage rapide

1. Décompresser, ouvrir `chrome://extensions`, activer le **Mode développeur**, cliquer sur **Charger l'extension non empaquetée** et choisir le dossier `pdf-print-tracer` (Chrome 119+). Épingler l'icône.
2. Ouvrir la page de l'application, cliquer sur l'icône puis sur **Démarrer l'enregistrement** (la page est rechargée pour être instrumentée).
3. Reproduire l'impression du PDF, puis rouvrir le popup : le **verdict** et le **tableau des étapes** s'affichent. **Copier le rapport** permet de le coller dans un message.

## Utilisation détaillée

| Commande | Effet |
|---|---|
| **Démarrer / Arrêter l'enregistrement** | Enregistre l'onglet courant (badge rouge `REC`). Les popups ouverts par `window.open` depuis cet onglet sont suivis automatiquement. Rechargement de la page optionnel au démarrage. |
| **Effacer** | Vide la trace de l'onglet. |
| **Copier le rapport** | Rapport texte (verdict, étapes, diagnostics), prêt à coller. |
| **Exporter JSON** | Trace complète dans un fichier. |
| **Comparer des traces…** | Ouvre une page où l'on charge la trace A (machine qui fonctionne) et la trace B (machine qui échoue) : les étapes dont le statut diffère sont surlignées. |
| **Masquer les paramètres d'URL** | Remplace `?token=…` par `?…` dans les exports et les rapports copiés (coché par défaut). |
| **Mode avancé** | Attache le débogueur de Chrome à l'onglet (voir plus bas). Chrome affiche sa bannière « débogage en cours ». |
| **Sélecteur de PDF** | Apparaît quand plusieurs requêtes PDF ont été enregistrées ; chaque tentative est analysée séparément. |

**Lire le résultat.** Le bandeau du haut est le verdict : **rouge** = une étape bloquante a été trouvée (avec la cause et une piste de correction) ; **orange** = la chaîne s'arrête (une étape n'est jamais observée) ou tout s'est passé avec des réserves ; **vert** = toutes les étapes observées sont correctes ; **gris** = aucun PDF dans la trace. Chaque ligne du tableau indique le statut, l'heure, le délai depuis la requête et le **délai depuis l'étape précédente** (un écart supérieur à 3 s est surligné). Statuts : ✔ OK · ⚠ OK avec réserve · ✖ échec · ? jamais observée · … non observable · – non applicable · ⤼ non atteinte (conséquence d'un échec antérieur).

**Mode avancé** (permission `debugger`, utilisée seulement quand on coche la case : le débogueur n'est attaché à l'onglet qu'à ce moment) : il ajoute ce que la page ne peut pas voir d'elle-même — les messages de console émis par Chrome lui-même (p. ex. *« Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set. »*), le vrai `userGesture` de `window.open`, la raison exacte d'un blocage réseau (CSP, contenu mixte, CORS, CORP/COEP, filtre de contenu), les cookies bloqués (nom, domaine et raison — jamais la valeur) et les frames hors processus (visionneuse PDF, Workers).

**Scénario typique.** Sur la machine qui échoue : *Démarrer* → reproduire → *Copier le rapport* (ou *Exporter JSON*). Faire de même sur une machine qui fonctionne, puis *Comparer des traces…* pour repérer la première étape qui diffère.

## Les 13 étapes

| # | Étape | Source |
|---|---|---|
| 1 | Requête HTTP émise | `webRequest.onBeforeRequest` |
| 2 | En-têtes de réponse reçus (statut, Content-Type, Content-Disposition, X-Frame-Options, CSP) | `webRequest.onHeadersReceived` |
| 3 | Corps entièrement reçu, ou erreur réseau (`net::ERR_…`, expliquée) | `webRequest.onCompleted / onErrorOccurred` |
| 4 | Réponse reçue par le JavaScript | hooks `fetch` / `XMLHttpRequest` |
| 5 | Corps lu en Blob/ArrayBuffer, signature `%PDF-` vérifiée | hooks `Response.blob/arrayBuffer`, XHR |
| 6 | URL Blob créée (et révoquée trop tôt ?) | `URL.createObjectURL / revokeObjectURL` |
| 7 | Popup ouverte (bloquée ? dernier geste utilisateur trop ancien ?) | hook `window.open` |
| 8 | iframe / embed / object inséré (`sandbox` ?) ou onglet popup créé | `MutationObserver`, `webNavigation` |
| 9 | Frame chargé | événement `load`, `webNavigation` |
| 10 | Visionneuse PDF de Chrome démarrée (ou PDF téléchargé à la place) | `webNavigation`, `document.contentType`, `downloads`, `navigator.pdfViewerEnabled` |
| 11 | `print()` appelé (focus, visibilité, activation, sandbox, frame cross-origin) | hooks `window.print` et `iframe.contentWindow` |
| 12 | Dialogue d'impression ouvert | `beforeprint` |
| 13 | Dialogue d'impression fermé | `afterprint` |

## Cas gérés

**Réseau**

| Cas | Ce que l'on voit | Cause probable / piste |
|---|---|---|
| HTTP 4xx/5xx sur le PDF | Étape 2 en échec avec le statut | Session expirée, droits, mauvaise route |
| 200 mais `Content-Type` ≠ PDF | Étape 2 : réserve | Le serveur ou un proxy renvoie du HTML/JSON |
| `Content-Disposition: attachment` | Étape 2 : réserve | Chrome télécharge au lieu d'afficher |
| `X-Frame-Options` / CSP `frame-ancestors` sur un PDF en frame | Étape 2 : réserve | L'iframe est refusé |
| En-tête CSP `sandbox` sur le PDF | Étape 2 : réserve | La visionneuse ne peut pas afficher un document sandboxé |
| Erreur réseau Chrome avant/pendant le téléchargement | Étape 2 ou 3 en échec, erreur expliquée en clair | Bloqué par une extension, connexion réinitialisée/fermée, délai dépassé, DNS, tunnel proxy, flux tronqué (longueur, chunked), HTTP/2, QUIC, TLS/certificat |
| Téléchargement commencé mais jamais terminé (> 15 s) | Étape 3 en échec | Proxy, pare-feu ou antivirus qui retient le flux |
| Téléchargement très lent (> 8 s) | Étape 3 : réserve | Réseau lent |
| Cookies bloqués *(avancé)* | Étape 2 : réserve avec noms et raisons | Une page de login est renvoyée à la place du PDF |
| Raison de blocage donnée par Chrome *(avancé)* | Étape 2 ou 3 en échec avec la raison | CSP, contenu mixte, CORS, CORP/COEP, filtre de contenu |

**JavaScript**

| Cas | Ce que l'on voit | Cause probable / piste |
|---|---|---|
| `fetch` rejeté, XHR en erreur / abort / timeout | Étape 4 en échec | CORS, contenu mixte, extension de blocage, proxy, abort du script |
| HTTP ≥ 400, type non PDF ou réponse opaque vus par le script | Étape 4 : échec / réserve | Erreur serveur, mauvais type, CORS |
| Corps qui ne commence pas par `%PDF-` (page de login, JSON d'erreur avec statut 200) | Étape 5 en échec, avec les premiers octets | Session expirée, portail captif, proxy qui réécrit |
| Corps vide (0 octet), erreur de lecture du corps | Étape 5 en échec | Flux tronqué |
| Blob sans type `application/pdf` | Étape 6 : réserve | Visionneuse non utilisée, téléchargement ou frame vide |
| URL Blob révoquée avant `print()` (ou en moins de 1,5 s) | Étape 6 : échec / réserve | Course avec un frame lent |
| Requête émise par un Worker ou Service Worker | Réseau tracé, étapes JavaScript « non applicables » | Les Workers de même origine sont rattachés à l'onglet |
| Plusieurs requêtes PDF | Sélecteur de PDF | Chaque tentative est analysée séparément |

**Popup**

| Cas | Ce que l'on voit | Cause probable / piste |
|---|---|---|
| `window.open` renvoie `null` | Étape 7 en échec avec l'âge du dernier geste utilisateur | L'activation transitoire (~5 s) a expiré car le PDF est arrivé lentement : ouvrir la fenêtre au clic, lui affecter l'URL Blob ensuite |
| Réglage du site « Pop-ups » = bloqué | Note à l'étape 7 | `chrome://settings/content/popups` |
| `userGesture` réel *(avancé)* | Note à l'étape 7 | Confirme ou écarte l'absence de geste |
| Onglet popup | Sa navigation, son chargement et sa fermeture sont suivis | Fait partie de la même trace |

**Frame d'affichage et visionneuse**

| Cas | Ce que l'on voit | Cause probable / piste |
|---|---|---|
| iframe/embed/object avec `sandbox` | Étape 8 : réserve (et `allow-modals` absent) | Ajouter `allow-modals`, ou ne pas sandboxer |
| Le frame ne finit jamais de charger | Étape 9 non observée | Blob invalide ou révoqué, XFO/CSP, visionneuse qui ne démarre pas |
| Erreur de chargement ou de navigation du frame | Étape 9 en échec | Voir l'erreur expliquée |
| `print()` avant la fin du chargement du frame | Étape 9 : réserve | Attendre `load` |
| PDF téléchargé au lieu d'être affiché | Étape 10 en échec | `attachment`, Blob sans type, réglage « Télécharger les PDF » |
| `navigator.pdfViewerEnabled = false` | Étape 10 en échec | Réglage ou stratégie d'entreprise (`AlwaysOpenPdfExternally`) |
| Frame de la visionneuse PDF détecté | Étape 10 OK | — |

**Impression**

| Cas | Ce que l'on voit | Cause probable / piste |
|---|---|---|
| `print()` jamais appelé | Étape 11 non observée, avec les erreurs JS / rejets / violations CSP listés | La chaîne JavaScript s'arrête avant |
| `print()` appelé mais ignoré | Étape 11 : réserve — pas de focus, onglet masqué, `sandbox` sans `allow-modals`, retour immédiat sans `beforeprint` | Donner le focus, ajouter `allow-modals`, attendre le PDF |
| `print()` sur un frame cross-origin | Étape 11 en échec (SecurityError expliquée) | Imprimer depuis le frame lui-même (`postMessage`) ou servir le PDF en Blob de même origine |
| Message de refus de Chrome *(avancé)* | Étape 11 en échec avec le message exact | Suivre le message |
| Impression sans `print()` observable | Étape 11 « non observable », étape 12 OK | Bouton de la visionneuse, Ctrl+P |

**Environnement (diagnostics généraux)** : extensions susceptibles d'interférer (accès à tous les sites + réseau/téléchargements) et extensions imposées par stratégie, réglage popups, navigation privée, hors ligne, connexion lente (≤ 3G ou RTT > 500 ms), violations CSP, erreurs JavaScript, nombre de `window.open` bloqués, détail des timings (DNS / connexion / TLS / attente serveur / téléchargement), échec d'attachement du débogueur ou détachement via la bannière.

## Limites

| Limite | Statut |
|---|---|
| Requêtes d'un Service Worker / Worker (`tabId = -1`) | **Couvert** : rattachées à l'onglet tracé de même origine (leur côté JavaScript reste inobservable). |
| `print()` sur un frame de même origine (dont un PDF en Blob) | **Couvert** : hook posé dès l'accès à `iframe.contentWindow`. |
| `print()` sur un frame cross-origin | **Expliqué** : l'accès est détecté et le verdict indique que c'est interdit. |
| Refus de Chrome (print, popup) | **Couvert en mode avancé** (message exact) ; sinon déduit. |
| Visionneuse PDF (étape 10) | **Confirmée en mode avancé** ; sinon déduite d'indices indirects. |
| Intérieur de la visionneuse PDF, dialogue d'impression de Chrome | **Hors d'atteinte** : interface interne de Chrome ; seule l'ouverture est déduite (`beforeprint`). |
| Workers d'une autre origine que l'onglet | Rattachement fiable impossible. |

## Permissions et confidentialité

| Permission | Pourquoi |
|---|---|
| `webRequest`, accès `<all_urls>` | Observer requêtes et réponses (ne bloque ni ne modifie rien, ne lit jamais les en-têtes de requête) |
| `webNavigation`, `tabs` | Suivre les frames et popups de l'onglet tracé |
| `downloads` | Détecter un PDF téléchargé au lieu d'être affiché |
| `storage` | Garder la trace en mémoire de session |
| `management` | Lister les extensions installées qui pourraient interférer |
| `contentSettings` | Lire le réglage « Pop-ups » du site |
| `debugger` | Mode avancé uniquement — jamais attaché sans que vous cochiez la case |

Les en-têtes de requête (cookies, Authorization) ne sont jamais lus. Les URLs sont enregistrées avec leurs paramètres : l'option « masquer les paramètres d'URL » (active par défaut) les remplace dans les exports et les rapports copiés. En mode avancé, seuls le nom, le domaine et la raison des cookies bloqués sont conservés, jamais leur valeur. Les traces vivent en mémoire de session (`chrome.storage.session`) et disparaissent à la fermeture de Chrome. Rien n'est jamais envoyé nulle part.

## Tests

```
node test/test-analysis.js                       # 23 scénarios d'analyse
PLAYWRIGHT_MODULE=… node test/test-inject.js     # hooks de la page dans Chromium
PLAYWRIGHT_MODULE=… node test/test-e2e.js        # l'extension réelle chargée dans Chromium
```

Source du logo : `icons/icon.svg` (PNG 16 / 32 / 48 / 128 / 512 générés à partir de lui).

## Licence et crédits

Licence MIT — voir [LICENSE](LICENSE). Si vous réutilisez ce code, conservez la mention de copyright et le texte de la licence (obligation d'attribution de la MIT) et mentionnez le projet : **PDF Print Tracer par elfen** — https://github.com/elfen/pdf-print-tracer-chrome

Vie privée et RGPD : voir [PRIVACY.md](PRIVACY.md) (en anglais). Avant de publier un rapport dans une issue publique, relisez-le et masquez ce qui est personnel.
