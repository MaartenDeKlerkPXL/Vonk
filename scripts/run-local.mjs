/**
 * Draait dezelfde feed-run als de scheduled function, maar lokaal en zonder
 * Netlify Blobs. Het resultaat gaat naar data/feed.local.json, zodat je het
 * kunt inzien én de frontend er lokaal tegenaan kunt laten draaien.
 *
 *   npm run feed:local
 *   npm run feed:local -- --category=memes     alleen die categorie
 *   npm run feed:local -- --serve              schrijf ook naar data/feed.json
 *
 * Let op: dit script heeft een normale internetverbinding nodig.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFeed, formatReport } from '../netlify/functions/lib/build-feed.js';
import { SOURCES } from '../netlify/functions/lib/sources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const categoryFilter = (args.find((a) => a.startsWith('--category')) || '').split('=')[1];
const alsoServe = args.includes('--serve');

const sources = categoryFilter
  ? SOURCES.filter((s) => s.category === categoryFilter)
  : SOURCES;

if (!sources.length) {
  console.error('Geen bronnen voor categorie "' + categoryFilter + '".');
  process.exit(1);
}

// vorige lokale run als terugval, net als in productie
let previous = null;
try {
  previous = JSON.parse(await readFile(join(ROOT, 'data/feed.local.json'), 'utf8'));
} catch { /* eerste run */ }

console.log('Ophalen van ' + sources.length + ' bronnen...\n');
const { doc, report } = await buildFeed({ previous, sources });

console.log(formatReport(report));
console.log('');

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(join(ROOT, 'data/last-run.json'), JSON.stringify(report, null, 2) + '\n');

if (!doc) {
  console.error('Geen enkel item opgehaald. data/feed.local.json is niet aangepast.');
  process.exit(1);
}

await writeFile(join(ROOT, 'data/feed.local.json'), JSON.stringify(doc, null, 2) + '\n');
console.log('Geschreven: data/feed.local.json (' + doc.items.length + ' items)');

if (alsoServe) {
  await writeFile(join(ROOT, 'data/feed.json'), JSON.stringify(doc, null, 2) + '\n');
  console.log('Geschreven: data/feed.json - de frontend pakt dit op via de terugval-URL');
}

const metFoto = doc.items.filter((i) => i.photoUrl).length;
console.log(
  'Items met foto: ' + metFoto + '/' + doc.items.length +
  ' - verslag: data/last-run.json'
);
