/**
 * Reddit levert Atom op /.rss, dus de gewone parser volstaat. Wat hier
 * bijkomt is context: Reddit blokkeert verkeer vanaf datacenter-IP's, en
 * Netlify draait op datacenter-IP's. Een 403 is hier dus verwacht gedrag en
 * geen bug — de bron wordt overgeslagen en gelogd, en elke categorie die op
 * Reddit leunt heeft in sources.js een niet-Reddit-bron ernaast staan.
 */

import { fetchFeed } from './rss.js';
import { FetchError } from './http.js';

export async function fetchRedditFeed(url, options = {}) {
  try {
    const entries = await fetchFeed(url, {
      accept: 'application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      ...options
    });
    // Reddit-titels dragen soms de subreddit als prefix; die halen we eraf
    return entries.map((entry) => ({
      ...entry,
      title: String(entry.title || '').replace(/^\s*\[[^\]]+\]\s*/, '')
    }));
  } catch (err) {
    if (err instanceof FetchError && (err.status === 403 || err.status === 429)) {
      throw new FetchError(
        'Reddit weigert dit verzoek (HTTP ' + err.status + '). Vrijwel zeker een ' +
        'blokkade op datacenter-IP’s, niet een fout in de code.',
        { status: err.status, url }
      );
    }
    throw err;
  }
}
