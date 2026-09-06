/**
 * Controleert elke bron uit sources.js: is de URL bereikbaar, komt er
 * parseerbare RSS/Atom uit, en hoeveel items levert het op.
 *
 *   npm run feed:verify
 *   npm run feed:verify -- --category=natuur
 *
 * Draai dit vanaf een normale internetverbinding. Bronnen die hier rood
 * zijn, zijn dat in productie ook - met één uitzondering: Reddit weigert
 * datacenter-IP's, dus die kunnen thuis groen zijn en op Netlify rood.
 *
 * Exitcode 1 als een categorie geen enkele werkende bron overhoudt.
 */

import { SOURCES } from '../netlify/functions/lib/sources.js';
import { fetchText } from '../netlify/functions/lib/http.js';
import { parseFeed } from '../netlify/functions/lib/rss.js';

const ESC = String.fromCharCode(27);
const color = (code) => (text) => ESC + '[' + code + 'm' + text + ESC + '[0m';
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);

const args = process.argv.slice(2);
const categoryFilter = (args.find((a) => a.startsWith('--category')) || '').split('=')[1];
const sources = categoryFilter ? SOURCES.filter((s) => s.category === categoryFilter) : SOURCES;

const results = [];

for (const source of sources) {
  const started = Date.now();
  try {
    const body = await fetchText(source.url, {
      timeoutMs: 15000,
      retries: 0,
      accept: source.type === 'scrape' ? 'text/html,application/xhtml+xml' : undefined
    });

    if (source.type === 'scrape') {
      const looksLikePage = /<html/i.test(body);
      results.push({
        source, ok: looksLikePage, count: null, ms: Date.now() - started,
        detail: looksLikePage
          ? 'HTML ontvangen (' + Math.round(body.length / 1024) + ' kB) - draai feed:local om te zien of er films uit komen'
          : 'geen HTML ontvangen'
      });
      continue;
    }

    const { entries, title } = parseFeed(body);
    results.push({
      source, ok: entries.length > 0, count: entries.length, ms: Date.now() - started,
      detail: title ? '"' + title + '"' : ''
    });
  } catch (err) {
    results.push({ source, ok: false, count: 0, ms: Date.now() - started, detail: err.message });
  }
}

let lastCategory = '';
for (const result of results) {
  if (result.source.category !== lastCategory) {
    lastCategory = result.source.category;
    console.log('\n' + lastCategory);
  }
  const mark = result.ok ? green('  ok  ') : red(' FOUT ');
  const count = result.count === null ? '   -' : String(result.count).padStart(4);
  const risk = result.source.risk ? yellow(' [' + result.source.risk + ']') : '';
  console.log(
    mark + count + '  ' + result.source.id.padEnd(16) + dim(result.source.url) + risk +
    (result.detail ? '\n            ' + dim(result.detail) : '')
  );
}

const broken = results.filter((r) => !r.ok);
const emptyCategories = [...new Set(sources.map((s) => s.category))]
  .filter((cat) => !results.some((r) => r.ok && r.source.category === cat));

console.log('\n' + (results.length - broken.length) + '/' + results.length + ' bronnen in orde');
if (emptyCategories.length) {
  console.log(red('Categorieen zonder werkende bron: ' + emptyCategories.join(', ')));
}
process.exit(emptyCategories.length ? 1 : 0);
