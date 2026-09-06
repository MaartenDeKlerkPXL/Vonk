/**
 * De feed-runner: haalt alle bronnen op, normaliseert ze en zet er één
 * feed-document van in elkaar in exact het formaat dat de frontend leest.
 *
 * Gedeeld door de scheduled function (fetch-feed.js) en het lokale
 * testscript (scripts/run-local.mjs), zodat je niet hoeft te deployen om
 * te zien wat er uit komt.
 *
 * Uitgangspunt: één kapotte bron mag nooit de run slopen. Elke bron draait
 * geïsoleerd; wat faalt wordt gelogd en overgeslagen.
 */

import { CATEGORIES, SOURCES, ITEMS_PER_CATEGORY, validateSources } from './sources.js';
import { mapWithConcurrency } from './http.js';
import { fetchFeed } from './rss.js';
import { fetchRedditFeed } from './reddit.js';
import { fetchRodaJc } from './scrape-roda-jc.js';
import { fetchVueKerkrade } from './scrape-vue-kerkrade.js';
import { normalizeEntry } from './normalize.js';

export const FEED_VERSION = 2;

/** Haalt één bron op en levert genormaliseerde items terug. */
async function collectSource(source, fetchOptions) {
  switch (source.type) {
    case 'reddit': {
      const entries = await fetchRedditFeed(source.url, fetchOptions);
      return { items: entries.map((e) => normalizeEntry(e, source)).filter(Boolean) };
    }
    case 'google-news': {
      return { items: await fetchRodaJc(source, fetchOptions) };
    }
    case 'scrape': {
      const { items, warning, strategy } = await fetchVueKerkrade(source, fetchOptions);
      return { items, warning, note: strategy && 'strategie: ' + strategy };
    }
    case 'rss':
    default: {
      const entries = await fetchFeed(source.url, fetchOptions);
      return { items: entries.map((e) => normalizeEntry(e, source)).filter(Boolean) };
    }
  }
}

const newestFirst = (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt);

/**
 * @param {{previous?: object|null, concurrency?: number, fetchOptions?: object,
 *          sources?: object[], logger?: object}} options
 * @returns {Promise<{doc: object|null, report: object}>}
 */
export async function buildFeed(options = {}) {
  const {
    previous = null,
    concurrency = 6,
    fetchOptions = {},
    sources = SOURCES,
    logger = console
  } = options;

  const problems = validateSources();
  if (problems.length) throw new Error('sources.js is niet consistent: ' + problems.join('; '));

  const startedAt = Date.now();
  const settled = await mapWithConcurrency(sources, concurrency, (source) =>
    collectSource(source, fetchOptions));

  const perSource = [];
  const byCategory = new Map(CATEGORIES.map((c) => [c.id, []]));
  const failedCategories = new Map(CATEGORIES.map((c) => [c.id, { failed: 0, total: 0 }]));

  sources.forEach((source, index) => {
    const result = settled[index];
    const tally = failedCategories.get(source.category);
    if (tally) tally.total++;

    if (result.status === 'rejected') {
      if (tally) tally.failed++;
      perSource.push({
        id: source.id, name: source.name, category: source.category,
        ok: false, count: 0, error: String(result.reason && result.reason.message || result.reason)
      });
      return;
    }

    const { items, warning, note } = result.value;
    if (warning) logger.warn('[vonk] ' + warning);
    if (!items.length && tally) tally.failed++;

    const bucket = byCategory.get(source.category);
    if (bucket) bucket.push(...items);
    perSource.push({
      id: source.id, name: source.name, category: source.category,
      ok: true, count: items.length, warning: warning || undefined, note: note || undefined
    });
  });

  // vorige run als terugval per categorie
  const previousByCategory = new Map();
  if (previous && Array.isArray(previous.items)) {
    for (const item of previous.items) {
      if (!previousByCategory.has(item.category)) previousByCategory.set(item.category, []);
      previousByCategory.get(item.category).push(item);
    }
  }

  const items = [];
  const categoryReport = {};

  for (const category of CATEGORIES) {
    const collected = byCategory.get(category.id) || [];

    // dubbele links binnen een categorie (bv. hetzelfde bericht bij twee bronnen)
    const unique = new Map();
    for (const item of collected) {
      const existing = unique.get(item.id);
      if (!existing || new Date(item.publishedAt) > new Date(existing.publishedAt)) {
        unique.set(item.id, item);
      }
    }

    let list = [...unique.values()].sort(newestFirst).slice(0, ITEMS_PER_CATEGORY);
    let carriedOver = false;

    // Alle bronnen van deze categorie faalden: houd vast wat we al hadden,
    // in plaats van de categorie leeg te maken.
    const tally = failedCategories.get(category.id);
    if (!list.length && tally && tally.total > 0 && tally.failed === tally.total) {
      const fallback = previousByCategory.get(category.id) || [];
      if (fallback.length) {
        list = fallback.slice(0, ITEMS_PER_CATEGORY);
        carriedOver = true;
      }
    }

    items.push(...list);
    categoryReport[category.id] = {
      count: list.length,
      carriedOver,
      sourcesFailed: tally ? tally.failed : 0,
      sourcesTotal: tally ? tally.total : 0
    };
  }

  const okSources = perSource.filter((s) => s.ok && s.count > 0).length;
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    sourcesTotal: sources.length,
    sourcesOk: okSources,
    sourcesFailed: sources.length - okSources,
    totalItems: items.length,
    categories: categoryReport,
    sources: perSource,
    // Niets opgehaald én niets om op terug te vallen: dan is dit resultaat
    // waardeloos en mag de bestaande feed.json niet overschreven worden.
    fatal: items.length === 0
  };

  const doc = report.fatal ? null : {
    version: FEED_VERSION,
    generatedAt: new Date().toISOString(),
    source: 'live',
    categories: CATEGORIES,
    items
  };

  return { doc, report };
}

/** Compacte samenvatting voor de Netlify function-logs. */
export function formatReport(report) {
  const lines = [];
  lines.push(
    '[vonk] ' + report.totalItems + ' items uit ' + report.sourcesOk + '/' +
    report.sourcesTotal + ' bronnen in ' + Math.round(report.durationMs / 100) / 10 + 's'
  );
  for (const [id, info] of Object.entries(report.categories)) {
    const flags = [];
    if (info.carriedOver) flags.push('overgenomen uit vorige run');
    if (info.sourcesFailed) flags.push(info.sourcesFailed + '/' + info.sourcesTotal + ' bron(nen) mislukt');
    if (!info.count) flags.push('LEEG');
    lines.push('[vonk]   ' + id.padEnd(14) + String(info.count).padStart(3) +
      (flags.length ? '  — ' + flags.join(', ') : ''));
  }
  for (const source of report.sources) {
    if (!source.ok) lines.push('[vonk]   ! ' + source.id + ' (' + source.category + '): ' + source.error);
  }
  return lines.join('\n');
}
