/**
 * Normalisatie: elke bron (RSS, Atom, Reddit, scraper) komt hier binnen en
 * gaat er uit in exact het item-formaat dat de frontend sinds fase 1 leest:
 *
 *   { id, category, headline, snippet, fullContent, photoUrl, sourceUrl, publishedAt }
 */

import { createHash } from 'node:crypto';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è', euml: 'ë',
  iuml: 'ï', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', euro: '€',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', laquo: '«', raquo: '»'
};

/** Zet HTML-entiteiten om naar tekens, inclusief numerieke varianten. */
export function decodeEntities(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+\d?);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/** Strip alle HTML en normaliseer witruimte tot één regel. */
export function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML maar houd de alinea-indeling vast: block-elementen en <br>
 * worden regelovergangen. De frontend splitst fullContent op \n+.
 */
export function htmlToParagraphs(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ');

  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Eerste paar zinnen, afgekapt op een zinsgrens en anders op een woordgrens.
 * Nooit midden in een woord.
 */
export function makeSnippet(text, { maxChars = 200, maxSentences = 3 } = {}) {
  const clean = stripHtml(text);
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;

  const sentences = clean.match(/[^.!?]+[.!?]+(?:["'”’)]+)?\s*/g) || [];
  let out = '';
  for (const sentence of sentences.slice(0, maxSentences)) {
    if (out && (out + sentence).trim().length > maxChars) break;
    out += sentence;
    if (out.trim().length >= maxChars * 0.6) break;
  }
  out = out.trim();

  if (!out || out.length > maxChars) {
    const slice = clean.slice(0, maxChars);
    const cut = slice.lastIndexOf(' ');
    out = (cut > maxChars * 0.5 ? slice.slice(0, cut) : slice).trim() + '…';
  }
  return out;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;

function isImageUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Zoekt een afbeelding in vaste volgorde:
 * media:content → media:thumbnail → enclosure → eerste <img> in de content.
 * Levert null als er niets bruikbaars is; de frontend vangt dat al op.
 */
export function pickImage(entry) {
  const candidates = [];
  const push = (url) => { if (isImageUrl(url)) candidates.push(url); };

  for (const media of toArray(entry.media)) {
    const type = media.type || media.medium || '';
    if (!type || /^image/i.test(type) || media.medium === 'image') push(media.url);
  }
  for (const thumb of toArray(entry.thumbnails)) push(thumb.url || thumb);
  for (const enclosure of toArray(entry.enclosures)) {
    const type = enclosure.type || '';
    if (/^image/i.test(type) || (!type && IMAGE_EXT.test(enclosure.url || ''))) push(enclosure.url);
  }

  const html = entry.contentHtml || entry.descriptionHtml || '';
  const imgMatch = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) push(decodeEntities(imgMatch[1]));

  const found = candidates.find(Boolean);
  if (!found) return null;
  // protocol-relatieve en http-urls opwaarderen naar https
  return found.replace(/^\/\//, 'https://').replace(/^http:\/\//i, 'https://');
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Datum uit de feed naar ISO. Onparseerbaar of afwezig → nu. */
export function toIsoDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(String(value).trim());
  if (isNaN(date.getTime())) return new Date().toISOString();
  // feeds met een datum ver in de toekomst zijn kapot; kap af op nu
  const now = Date.now();
  if (date.getTime() > now + 86400000) return new Date(now).toISOString();
  return date.toISOString();
}

/**
 * Stabiel id: dezelfde sourceUrl levert altijd hetzelfde id op, ook over
 * runs en deploys heen. Cruciaal, want de frontend bewaart dismissed- en
 * saved-items op id.
 */
export function stableId(sourceSlug, sourceUrl, fallbackKey = '') {
  const basis = canonicalUrl(sourceUrl) || fallbackKey;
  const hash = createHash('sha1').update(basis).digest('hex').slice(0, 10);
  return sourceSlug + '-' + hash;
}

/** Haalt tracking-parameters weg zodat dezelfde link één id houdt. */
export function canonicalUrl(url) {
  if (!url) return '';
  const raw = String(url).trim();
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source$|mc_cid|mc_eid)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

/**
 * Zet een geparste feed-entry om naar een Vonk-item.
 * @param {object} entry   ruwe entry uit rss.js / reddit.js / een scraper
 * @param {object} source  bron uit sources.js (levert category en slug)
 * @returns {object|null}  item, of null als er te weinig bruikbaars in zit
 */
export function normalizeEntry(entry, source) {
  const headline = stripHtml(entry.title);
  const sourceUrl = canonicalUrl(entry.link);
  if (!headline || !sourceUrl) return null;

  const bodyHtml = entry.contentHtml || entry.descriptionHtml || '';
  const fullContent = htmlToParagraphs(bodyHtml) || headline;
  const snippet = makeSnippet(entry.summary || bodyHtml || fullContent) || headline;

  return {
    id: stableId(source.id, sourceUrl, headline),
    category: source.category,
    // Welke feed dit item leverde. Nodig om per bron te kunnen zien hoeveel
    // er wordt weggeswipet, niet alleen per categorie.
    sourceId: source.id,
    sourceName: source.name,
    headline: headline.slice(0, 300),
    snippet,
    fullContent: fullContent.slice(0, 8000),
    photoUrl: pickImage(entry),
    sourceUrl,
    publishedAt: toIsoDate(entry.published)
  };
}

/**
 * Sommige bronnen zijn gedeeld: het Prezly-adres van persbureau BUZZ bevat
 * de berichten van al hun cliënten. Met `match` in sources.js houden we
 * alleen over wat over het juiste onderwerp gaat.
 *
 * @param {object} item        genormaliseerd item
 * @param {string[]} needles   zoektermen, hoofdletterongevoelig
 */
export function matchesSource(item, needles) {
  if (!Array.isArray(needles) || !needles.length) return true;
  const hay = (item.headline + ' ' + item.snippet + ' ' + item.fullContent).toLowerCase();
  return needles.some((needle) => hay.includes(String(needle).toLowerCase()));
}
