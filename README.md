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
  generate-config.js           schrijft de Supabase-config uit env vars

sync.js                        synchronisatie tussen apparaten
public/supabase-config.js      gegenereerd per deploy, staat NIET in git
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

Fase 1, 2 en 3 zijn af.

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

## Synchroniseren tussen apparaten (fase 3)

Geen account, geen wachtwoord, geen e-mail: één **syncode** van acht tekens is
de sleutel tot één rij in Supabase. Zet je sync aan, dan krijg je een code;
voer je die code in op je telefoon, dan zien beide apparaten dezelfde bewaarde
items, overgeslagen items en gevolgde categorieën.

Synchronisatie is een opt-in bovenlaag. Zonder code — of zonder Supabase-
configuratie — werkt de app precies zoals in fase 1 en 2, volledig lokaal.

### Hoe het werkt

- **Lokaal is de bron van waarheid.** Elke swipe schrijft direct naar
  localStorage, dus de app wacht nooit op het netwerk. De server volgt op de
  achtergrond, kort na de wijziging.
- **Bij het openen** wordt de laatste stand opgehaald en lokaal toegepast. Staat
  er lokaal nog iets klaar dat niet verstuurd is, dan wint lokaal en wordt dat
  eerst weggeschreven. Verder geldt: laatste schrijfactie wint.
- **Offline** blijft een wijziging in de wachtrij staan (één vlag in
  localStorage, want de hele stand gaat in één keer mee). Zodra `online` afgaat
  of de retry van 30 seconden vuurt, gaat hij alsnog weg. De status in het
  instellingenscherm laat dat zien.
- **Koppelen met bestaande gegevens** voegt eenmalig samen: bewaarde items op
  id ontdubbeld (nieuwste `savedAt` wint), overgeslagen items en categorieën
  als verzameling samengevoegd. Een item dat op het ene apparaat bewaard is en
  op het andere overgeslagen, blijft bewaard.
- **Loskoppelen** geeft dit apparaat een nieuwe eigen code. De rij in Supabase
  blijft staan, dus je andere apparaat merkt er niets van.
- **Undo blijft lokaal.** Eén stap terug hoeft niet over het netwerk.

De syncode gebruikt een alfabet zonder 0, O, 1, I en L, zodat overtypen vanaf
een schermpje geen giswerk wordt.

### Wat je zelf moet instellen

De agent die dit bouwde heeft geen toegang tot het Supabase-account (dat staat
op een ander mailadres dan GitHub), dus deze stappen doe je handmatig.

**1. Project aanmaken** op supabase.com. Let op de gratis limiet van twee
actieve projecten; pauzeer er zo nodig een.

**2. Tabel aanmaken** in de SQL Editor:

```sql
create table vonk_sync (
  sync_code text primary key,
  saved_items jsonb not null default '[]',
  dismissed_ids jsonb not null default '[]',
  followed_categories jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

alter table vonk_sync enable row level security;

create policy "anon kan lezen en schrijven met syncode"
  on vonk_sync for all
  to anon
  using (true)
  with check (true);
```

**3. Sleutels in Netlify zetten** — Site settings → Environment variables:

| Variabele | Waarde |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API → anon/public key |

De build draait `node scripts/generate-config.js`, dat daar
`public/supabase-config.js` van maakt. Dat bestand staat in `.gitignore`: er
komt nooit een sleutel in git. Ontbreken de variabelen, dan schrijft het script
een lege configuratie en draait de app zonder synchronisatie — geen crash, wel
een duidelijke melding in het instellingenscherm.

### Over de beveiliging

De policy hierboven is bewust open: er is geen inlogsysteem, dus de syncode zelf
is het geheim. Eén ding om te weten voordat je hem zo laat staan: `using (true)`
geldt ook voor `select` zónder filter. Wie de anon key uit de gepubliceerde app
haalt, kan daarmee in principe álle rijen opvragen — inclusief andermans
syncodes — of ze wissen. Voor een app die alleen jij gebruikt is dat vooral
theoretisch, en het is precies de afweging die bij "geen account" hoort.

Wil je het toch dichtzetten zonder een accountsysteem te bouwen, dan is de
route: rechten op de tabel intrekken voor `anon` en twee functies met
`security definer` toevoegen die de code als argument nemen (`vonk_pull(code)`
en `vonk_push(code, ...)`). De client praat dan met die functies in plaats van
rechtstreeks met de tabel — een kleine wijziging in `sync.js`, maar geen die
hier al gemaakt is.

### Lokaal uitproberen

```bash
SUPABASE_URL=https://jouwproject.supabase.co \
SUPABASE_ANON_KEY=jouw-anon-key \
  npm run config

python3 -m http.server 8000
```

Twee browserprofielen (of normaal plus incognito) gedragen zich als twee
apparaten: elk heeft zijn eigen localStorage. Zet sync aan in het ene, voer de
code in bij het andere.

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
2. Zet `SUPABASE_URL` en `SUPABASE_ANON_KEY` in de environment variables
   (overslaan kan: de app draait dan zonder synchronisatie)
3. Deploy — scheduled functions draaien alleen op gepubliceerde deploys
4. `netlify functions:invoke fetch-feed` of wacht op de eerste cron-run
5. Controleer `/.netlify/functions/get-feed?debug=1`

Het schema staat in `netlify.toml` (`0 5 * * *`, UTC — 07:00 Nederlandse
zomertijd). Zet het op één plek: óf in `netlify.toml`, óf als
`export const config = { schedule: ... }` in de functie zelf, niet allebei.
