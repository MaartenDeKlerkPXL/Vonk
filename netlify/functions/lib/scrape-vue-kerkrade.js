/**
 * Scraper voor de bioscoopagenda van Vue Kerkrade.
 *
 * Dit is de enige bron zonder feed, en daarmee de kwetsbaarste: bioscoopsites
 * wijzigen regelmatig van opbouw. De scraper probeert daarom drie strategieën
 * op volgorde en geeft een lege lijst plus een duidelijke waarschuwing terug
 * als geen enkele werkt. Een lege categorie is beter dan een gecrashte run.
 *
 *   1. JSON-LD (schema.org Movie / ScreeningEvent) — het stabielst
 *   2. __NEXT_DATA__ / embedded JSON van de app zelf
 *   3. DOM-selectors op filmkaarten
 */

import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import { normalizeEntry, stripHtml } from './normalize.js';

const BASE = 'https://www.vuecinemas.nl';

const absolute = (href) => {
  if (!href) return '';
  try { return new URL(href, BASE).toString(); } catch { return ''; }
};

/** Strategie 1: schema.org-data in een <script type="application/ld+json">. */
function fromJsonLd($) {
  const found = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    let data;
    try { data = JSON.parse($(node).contents().text()); } catch { return; }
    for (const entry of flatten(data)) {
      const type = String(entry['@type'] || '');
      if (!/Movie|ScreeningEvent|Event/i.test(type)) continue;
      const movie = entry.workPresented || entry;
      const name = movie.name || entry.name;
      if (!name) continue;
      found.push({
        title: name,
        link: absolute(movie.url || entry.url),
        summary: movie.description || entry.description || '',
        descriptionHtml: movie.description || entry.description || '',
        image: pickJsonImage(movie.image || entry.image),
        published: entry.startDate || ''
      });
    }
  });
  return found;
}

function flatten(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.flatMap(flatten);
  if (typeof data !== 'object') return [];
  const nested = Array.isArray(data['@graph']) ? data['@graph'].flatMap(flatten) : [];
  return [data, ...nested];
}

function pickJsonImage(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return pickJsonImage(image[0]);
  return image.url || image.contentUrl || '';
}

/** Strategie 2: de JSON die een moderne frontend zelf in de pagina zet. */
function fromEmbeddedJson(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }

  const found = [];
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || depth > 8 || found.length > 120) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;

    const title = node.title || node.name || node.filmTitle;
    const slug = node.slug || node.url || node.path;
    if (typeof title === 'string' && title.length > 1 && typeof slug === 'string' && !seen.has(title)) {
      seen.add(title);
      found.push({
        title,
        link: absolute(slug.startsWith('http') || slug.startsWith('/') ? slug : '/film/' + slug),
        summary: node.synopsis || node.description || node.shortDescription || '',
        descriptionHtml: node.synopsis || node.description || node.shortDescription || '',
        image: node.poster || node.image || node.imageUrl || '',
        published: ''
      });
    }
    Object.values(node).forEach((value) => walk(value, depth + 1));
  })(data, 0);

  return found;
}

/** Strategie 3: filmkaarten uit de HTML zelf. */
function fromDom($) {
  const found = [];
  const seen = new Set();
  const selectors = [
    'a[href*="/film/"]',
    'a[href*="/movie"]',
    '[data-testid*="film"] a',
    '[class*="film-card"] a',
    '[class*="movie-card"] a',
    'article a[href]'
  ];

  for (const selector of selectors) {
    $(selector).each((_, node) => {
      const el = $(node);
      const href = absolute(el.attr('href'));
      if (!href || !/\/(film|movie)/i.test(href)) return;

      const title = stripHtml(
        el.attr('title') ||
        el.find('h1,h2,h3,h4,[class*="title"]').first().text() ||
        el.attr('aria-label') ||
        el.text()
      );
      if (!title || title.length < 2 || title.length > 120 || seen.has(title)) return;
      seen.add(title);

      const img = el.find('img').first();
      found.push({
        title,
        link: href,
        summary: stripHtml(el.find('[class*="description"],[class*="synopsis"],p').first().text()),
        descriptionHtml: '',
        image: absolute(img.attr('src') || img.attr('data-src') || ''),
        published: ''
      });
    });
    if (found.length >= 5) break;
  }
  return found;
}

/**
 * @returns {Promise<{items: object[], warning?: string}>}
 */
export async function fetchVueKerkrade(source, options = {}) {
  const html = await fetchText(source.url, {
    accept: 'text/html,application/xhtml+xml',
    ...options
  });
  const $ = cheerio.load(html);

  const strategies = [
    ['json-ld', () => fromJsonLd($)],
    ['embedded-json', () => fromEmbeddedJson(html)],
    ['dom', () => fromDom($)]
  ];

  let raw = [];
  let used = '';
  for (const [name, run] of strategies) {
    try {
      raw = run();
    } catch (err) {
      raw = [];
    }
    if (raw.length) { used = name; break; }
  }

  if (!raw.length) {
    return {
      items: [],
      warning:
        'Vue Kerkrade: geen films herkend op ' + source.url + '. De paginastructuur is ' +
        'waarschijnlijk gewijzigd — pas de selectors in lib/scrape-vue-kerkrade.js aan. ' +
        'Deze categorie blijft deze run leeg.'
    };
  }

  const items = raw
    .map((film) => normalizeEntry(
      {
        title: film.title,
        link: film.link || source.url,
        summary: film.summary || ('Nu te zien in Vue Kerkrade: ' + film.title + '.'),
        descriptionHtml: film.descriptionHtml,
        contentHtml: film.descriptionHtml,
        published: film.published,
        media: film.image ? [{ url: film.image, type: 'image/jpeg' }] : []
      },
      source
    ))
    .filter(Boolean);

  return { items, strategy: used };
}
