/**
 * Scheduled function: haalt alle bronnen op en schrijft het resultaat als
 * feed.json naar de Netlify Blobs store.
 *
 * Het schema staat in netlify.toml ([functions."fetch-feed"] schedule).
 * Scheduled functions draaien alleen op gepubliceerde deploys en zijn niet
 * via een URL aan te roepen; lokaal test je met `npm run feed:local` of
 * `netlify functions:invoke fetch-feed`.
 */

import { getStore } from '@netlify/blobs';
import { buildFeed, formatReport } from './lib/build-feed.js';
import { STORE_NAME, FEED_KEY, REPORT_KEY } from './lib/blobs.js';

export default async function handler() {
  const store = getStore(STORE_NAME);

  // De vorige feed dient als terugval voor categorieën waarvan deze run
  // álle bronnen faalden.
  let previous = null;
  try {
    previous = await store.get(FEED_KEY, { type: 'json' });
  } catch (err) {
    console.warn('[vonk] vorige feed niet leesbaar:', err.message);
  }

  let doc;
  let report;
  try {
    ({ doc, report } = await buildFeed({ previous }));
  } catch (err) {
    // Alleen een fout in de opzet zelf komt hier terecht; bronfouten worden
    // per bron afgevangen. De bestaande feed blijft in beide gevallen staan.
    console.error('[vonk] run afgebroken:', err.stack || err.message);
    return new Response('run afgebroken: ' + err.message, { status: 500 });
  }

  console.log(formatReport(report));

  if (!doc) {
    console.error(
      '[vonk] geen enkel item opgehaald — de bestaande feed.json blijft staan ' +
      '(' + (previous ? previous.items.length + ' items' : 'nog geen eerdere feed') + ')'
    );
    await safeWriteReport(store, report);
    return new Response('geen items opgehaald, vorige feed behouden', { status: 500 });
  }

  await store.setJSON(FEED_KEY, doc);
  await safeWriteReport(store, report);

  return new Response(
    'ok: ' + doc.items.length + ' items uit ' + report.sourcesOk + '/' + report.sourcesTotal + ' bronnen',
    { status: 200 }
  );
}

async function safeWriteReport(store, report) {
  try {
    await store.setJSON(REPORT_KEY, report);
  } catch (err) {
    console.warn('[vonk] runverslag niet opgeslagen:', err.message);
  }
}
