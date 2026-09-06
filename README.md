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
index.html            de drie schermen plus de detail-view
style.css             dark thema, electric blue, glassmorphism
script.js             databron, opslag, feed, swipe, archief
manifest.json         PWA-manifest
service-worker.js     offline cache
data/dummy-data.json  categorieën en items
icons/                app-icons, 192 en 512 px
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

Fase 1 is af: de complete app draait op dummy-data.

- Fase 2 — een scheduled function haalt echte RSS-feeds, Reddit en scrapers op
  en vervangt `data/dummy-data.json`
- Fase 3 — synchronisatie via een syncode, zodat je saves op meerdere apparaten
  terugziet
