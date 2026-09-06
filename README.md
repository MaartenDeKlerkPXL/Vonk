# Vonk

Een persoonlijke "For You"-feed als installeerbare webapp. Je kiest zelf welke
categorieën je volgt, swipet door de content zoals bij Tinder en bouwt zo je
eigen archief van bewaarde artikelen, foto's en memes op. Geen algoritme dat
bepaalt wat je te zien krijgt.

Vanilla HTML, CSS en JavaScript. Geen frameworks, geen build-stap.

## Draaien

De feed wordt met `fetch` geladen, dus openen als bestand (`file://`) werkt niet.
Start een lokale server in de projectmap:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Wat er in zit

**Feed** — Kaartenstapel met drie zichtbare kaarten. Swipen gaat via pointer
events, dus zowel met touch als met muis-drag. Tijdens het slepen schalen een
kleur-overlay en een stempel mee met de afstand; de swipe committeert vanaf 30%
van de kaartbreedte of bij een snelle flick.

- Links = permanent weg (alleen het ID gaat naar de dismissed-lijst)
- Rechts = bewaren onder de categorie die het item al heeft
- Undo van één stap, voor zowel overslaan als bewaren
- Tik op een kaart opent de volledige tekst; sluiten houdt je plek in de stapel
- Op desktop ook te bedienen met ← / → / Z

**Archief** — Alle bewaarde items, gegroepeerd per categorie, met filterchips,
zoeken op trefwoord (met highlight in de resultaten) en verwijderen.

**Categorieën** — Vijftien onderwerpen om te volgen. Bij het eerste gebruik als
onboarding, daarna via het instellingen-icoon.

**PWA** — Installeerbaar via het manifest; de service worker cachet de app én de
databron, zodat Vonk ook offline opent met de laatst geladen data.

## Bestanden

```
index.html                     de drie schermen plus de detail-view
style.css                      dark thema, electric blue, glassmorphism
script.js                      databron, opslag, feed, swipe, archief
manifest.json                  PWA-manifest
service-worker.js              offline cache
data/dummy-data.json           terugval als de live feed er niet is
icons/                         app-icons, 192 en 512 px

netlify.toml                   site-config plus het schema van de cron
netlify/functions/
  fetch-feed.js                de scheduled function: haalt alles op
  get-feed.js                  endpoint waar de frontend zijn feed haalt
  lib/sources.js               alle bronnen per categorie
  lib/build-feed.js            de runner die alles samenvoegt
  lib/rss.js                   RSS-, RDF- en Atom-parser
  lib/reddit.js                Reddit-specifieke afhandeling
  lib/scrape-vue-kerkrade.js   scraper voor de bioscoopagenda
  lib/scrape-roda-jc.js        Google News-zoekopdracht
  lib/normalize.js             alles naar één item-formaat
  lib/http.js                  fetch met timeout, retry en user-agent
  lib/blobs.js                 namen van de blob-store en sleutels
scripts/
  run-local.mjs                complete feed-run zonder Netlify
  verify-sources.mjs           controleert elke bron-URL
  test-lib.mjs                 tests, draaien zonder netwerk
```

## Opzet

De code is in lagen opgedeeld zodat de databron en de opslag los te vervangen
zijn:

- `CONFIG.dataUrl` in `script.js` wijst naar de databron. Eén regel aanpassen is
  genoeg om van het dummy-bestand naar een live feed te gaan.
- `storage` is een async adapter rond `localStorage`. Dezelfde methodes kunnen
  naar een externe database schrijven zonder dat de rest van de app verandert.
- Bewaarde items slaan het volledige item op, niet alleen het ID, zodat je
  archief blijft kloppen als de bron verandert.
- Categorieën staan in de databron, niet in de code. Een categorie toevoegen is
  een regel JSON.

### Status

Fase 1 en 2 zijn af. Fase 3 — synchronisatie via een syncode, zodat je saves op
meerdere apparaten terugziet — komt later; `storage` in `script.js` is daar het
enige aanknopingspunt voor.

## De feed (fase 2)

Een scheduled function haalt elke ochtend 35 bronnen op, normaliseert ze en zet
het resultaat in een Netlify Blob. De frontend leest die blob via een klein
endpoint.

```
cron (netlify.toml)
  └─ fetch-feed.js ──> 35 bronnen parallel ──> normaliseren ──> Blob "vonk-feed"
                                                                     │
  browser ──> get-feed.js ─────────────────────────────────────────> ┘
```

De function schrijft niet terug naar de repo: dat zou een commit per run
kosten. Vandaar de blob.

### Wat er misgaat blijft klein

- Elke bron draait geïsoleerd, met een timeout van 12 seconden en één retry.
  Een bron die 404 geeft of onzin teruglevert, wordt overgeslagen en gelogd.
- Faalt élke bron van een categorie, dan houdt die categorie de items van de
  vorige geslaagde run in plaats van leeg te worden.
- Levert de hele run nul items op, dan wordt de bestaande `feed.json` **niet**
  overschreven en eindigt de function met een fout in de logs.
- Herkent de Vue-scraper de pagina niet, dan logt hij een waarschuwing en blijft
  alleen die ene categorie deze run leeg.

### Terugvalketen in de frontend

`CONFIG.dataUrl` wijst naar het endpoint; `CONFIG.fallbackDataUrls` is de rij
erachter. De app probeert op volgorde:

1. `/.netlify/functions/get-feed` — de live feed
2. `data/feed.json` — lokale uitvoer van `npm run feed:local -- --serve`
3. `data/dummy-data.json` — de dataset uit fase 1

Zo blijft `python3 -m http.server` werken voor frontend-werk, en toont de app
nooit een leeg scherm doordat er nog geen run is geweest.

### Item-id's

Een id is `<bron-id>-<sha1 van de sourceUrl>`, met tracking-parameters
(`utm_*`, `fbclid`) er eerst afgehaald. Hetzelfde artikel houdt dus over runs
heen hetzelfde id — noodzakelijk, want de frontend onthoudt weggeswipete en
bewaarde items op id. **Wijzig het `id`-veld van een bestaande bron in
`sources.js` daarom nooit**: alle items van die bron krijgen dan nieuwe id's en
komen terug in de feed.

## Bronnen

35 bronnen over 15 categorieën. Eén bron hoort bij precies één categorie, dus
er is geen classificatie nodig.

De categorie-slugs zijn die van fase 1: `leerzaam` (niet `leerzame-artikelen`)
en `business` (niet `ondernemerschap`), zodat bestaande saves blijven kloppen.

### Wijzigingen ten opzichte van de bronnenlijst uit het plan

| Categorie | Wijziging | Reden |
|---|---|---|
| memes | xkcd, CommitStrip en SMBC toegevoegd | de categorie stond volledig op Reddit; zie hieronder |
| natuur | `r/NatureIsFuckingLit` → `r/AnimalsBeingBros`, iflscience → ScienceDaily | nettere naam, en het iflscience-pad was niet te verifiëren |
| geschiedenis | Today I Found Out + ScienceDaily Archeologie | het plan had hier geen concrete bron |
| gerechten, innovatief, ui-ux, psychologie | één niet-Reddit-bron extra | zodat geen categorie op Reddit alleen leunt |
| vue-kerkrade | URL vastgelegd op `vuecinemas.nl/cinema/kerkrade/nu-in-de-bioscoop` | de actuele agenda-pagina |

**Reddit werkt vermoedelijk niet vanaf Netlify.** Reddit blokkeert verkeer
vanaf datacenter-IP's, en daar draaien serverless functions op. Een 403 op een
Reddit-bron is dus verwacht gedrag, geen bug. Daarom heeft elke categorie die
op Reddit leunde er een gewone feed naast gekregen; een test bewaakt dat.

### Verificatiestatus

De bron-URL's zijn **niet** live geverifieerd tijdens het bouwen: de omgeving
waarin dit geschreven is, kan alleen bij package-registries en blokkeert al het
andere uitgaande verkeer (elke bron gaf `HTTP 403 Forbidden` van de proxy).
De lijst is samengesteld op basis van de opgegeven URL's plus onderzoek naar de
twijfelgevallen.

Draai daarom vóór of vlak na de eerste deploy:

```bash
npm run feed:verify
```

Dat controleert elke bron één voor één en meldt per bron of er parseerbare RSS
uit komt en hoeveel items. De exitcode is 1 zodra een categorie geen enkele
werkende bron overhoudt. Wat rood is, vervang je in `netlify/functions/lib/sources.js`.

## Lokaal testen

```bash
npm install

npm test                  # de pijplijn, met nagebootste bronnen, zonder netwerk
npm run feed:verify       # elke bron-URL controleren (heeft internet nodig)
npm run feed:local        # complete run -> data/feed.local.json
npm run feed:local -- --category=memes
npm run feed:local -- --serve   # ook naar data/feed.json, zodat de frontend het pakt
```

`npm test` draait 25 tests zonder netwerk: HTML strippen, snippets afkappen op
zinsgrens, afbeelding kiezen, id-stabiliteit tussen twee runs, het maximum per
categorie, en het gedrag als één bron, een hele categorie of alles faalt.

De frontend erbij pakken zonder Netlify:

```bash
npm run feed:local -- --serve
python3 -m http.server 8000     # de app valt terug op data/feed.json
```

Met de Netlify CLI kan het ook compleet:

```bash
netlify dev                              # inclusief blobs en het endpoint
netlify functions:invoke fetch-feed      # de scheduled function één keer draaien
```

De function-logs tonen per run een regel per categorie met het aantal items en
welke bronnen faalden. Datzelfde verslag staat in de blob onder `last-run.json`
en is op te vragen via `/.netlify/functions/get-feed?debug=1`.

## Deployen

De site is statisch, er is geen build-stap: `publish = "."`. Netlify installeert
de dependencies en bundelt de functions zelf.

1. Koppel de repo aan een Netlify-site
2. Deploy — scheduled functions draaien alleen op gepubliceerde deploys
3. `netlify functions:invoke fetch-feed` of wacht op de eerste cron-run
4. Controleer `/.netlify/functions/get-feed?debug=1`

Het schema staat in `netlify.toml` (`0 5 * * *`, UTC — 07:00 Nederlandse
zomertijd). Zet het op één plek: óf in `netlify.toml`, óf als
`export const config = { schedule: ... }` in de functie zelf, niet allebei.
