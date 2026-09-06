/**
 * On-demand endpoint waar de frontend zijn feed vandaan haalt.
 * Leest feed.json uit de Blobs store en geeft het onbewerkt terug.
 *
 * Nog geen geslaagde run gehad? Dan volgt een 503. De frontend valt in dat
 * geval zelf terug op de meegeleverde data/dummy-data.json, zodat de app
 * nooit leeg is (zie CONFIG.fallbackDataUrl in script.js).
 *
 * Met ?debug=1 komt het verslag van de laatste run terug — handig om te zien
 * welke bron klaagt zonder in de function-logs te hoeven duiken.
 */

import { getStore } from '@netlify/blobs';
import { STORE_NAME, FEED_KEY, REPORT_KEY } from './lib/blobs.js';

const json = (body, status = 200, extraHeaders = {}) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200
        ? 'public, max-age=300, stale-while-revalidate=3600'
        : 'no-store',
      ...extraHeaders
    }
  }
);

export default async function handler(request) {
  const url = new URL(request.url);
  const store = getStore(STORE_NAME);

  if (url.searchParams.get('debug') === '1') {
    const report = await store.get(REPORT_KEY, { type: 'json' }).catch(() => null);
    return json(report || { error: 'nog geen runverslag' }, report ? 200 : 404);
  }

  let doc;
  try {
    doc = await store.get(FEED_KEY, { type: 'json' });
  } catch (err) {
    console.error('[vonk] blob niet leesbaar:', err.message);
    return json({ error: 'feed niet beschikbaar', detail: err.message }, 503);
  }

  if (!doc || !Array.isArray(doc.items) || !doc.items.length) {
    return json({ error: 'nog geen feed opgehaald; wacht op de eerste run' }, 503);
  }

  return json(doc, 200, { 'X-Vonk-Generated': doc.generatedAt || '' });
}
