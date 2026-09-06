/**
 * Roda JC via een Google News RSS-zoekopdracht.
 *
 * Google News geeft korte snippets zonder volledige artikeltekst, dus
 * fullContent is hier gelijk aan de snippet — er is niets rijkers beschikbaar
 * zonder het bronartikel zelf te scrapen, en dat zou per artikel een andere
 * site betekenen.
 */

import { fetchFeed } from './rss.js';
import { normalizeEntry } from './normalize.js';

/** "Kop van het artikel - De Limburger" → "Kop van het artikel" */
function stripPublisher(title) {
  return String(title || '').replace(/\s+-\s+[^-]{2,40}$/, '').trim();
}

export async function fetchRodaJc(source, options = {}) {
  const entries = await fetchFeed(source.url, options);

  return entries
    .map((entry) => {
      const item = normalizeEntry({ ...entry, title: stripPublisher(entry.title) }, source);
      if (!item) return null;
      // Google News stopt de bronvermelding in de omschrijving; die voegt niets toe
      item.fullContent = item.snippet;
      return item;
    })
    .filter(Boolean);
}
