/**
 * RSS/Atom-parser. Levert per feed een lijst ruwe entries op in één vorm,
 * ongeacht of de bron RSS 2.0, RDF of Atom is (Reddit levert Atom).
 * De omzetting naar het Vonk-item-formaat gebeurt in normalize.js.
 */

import { XMLParser } from 'fast-xml-parser';
import { fetchText } from './http.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  // deze knopen zijn soms enkelvoudig, soms een lijst: altijd als lijst behandelen
  isArray: (name) => [
    'item', 'entry', 'link', 'enclosure', 'category',
    'media:content', 'media:thumbnail', 'media:group'
  ].includes(name)
});

const text = (node) => {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') return text(node['#text'] ?? node['@_href'] ?? '');
  return '';
};

const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '') || '';

/** Kiest de bruikbare link uit een Atom-entry (rel=alternate, of de eerste). */
function atomLink(entry) {
  const links = Array.isArray(entry.link) ? entry.link : [entry.link].filter(Boolean);
  const alternate = links.find((l) => l && (l['@_rel'] === 'alternate' || !l['@_rel']));
  const chosen = alternate || links[0];
  if (!chosen) return '';
  return typeof chosen === 'string' ? chosen : (chosen['@_href'] || text(chosen));
}

function mediaNodes(node) {
  const group = node['media:group'];
  const fromGroup = group
    ? (Array.isArray(group) ? group : [group]).flatMap((g) => toList(g['media:content']))
    : [];
  return [...toList(node['media:content']), ...fromGroup].map((m) => ({
    url: m['@_url'],
    type: m['@_type'],
    medium: m['@_medium']
  }));
}

function toList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Zet een RSS-<item> om naar een ruwe entry. */
function fromRssItem(item) {
  return {
    title: text(item.title),
    link: first(text(item.link), text(item['atom:link']), text(item.guid)),
    summary: text(item.description),
    descriptionHtml: text(item.description),
    contentHtml: first(text(item['content:encoded']), text(item.description)),
    published: first(text(item.pubDate), text(item['dc:date']), text(item.published)),
    media: mediaNodes(item),
    thumbnails: toList(item['media:thumbnail']).map((t) => ({ url: t['@_url'] })),
    enclosures: toList(item.enclosure).map((e) => ({ url: e['@_url'], type: e['@_type'] }))
  };
}

/** Zet een Atom-<entry> om naar een ruwe entry. */
function fromAtomEntry(entry) {
  const contentHtml = first(text(entry.content), text(entry.summary));
  return {
    title: text(entry.title),
    link: first(atomLink(entry), text(entry.id)),
    summary: first(text(entry.summary), contentHtml),
    descriptionHtml: contentHtml,
    contentHtml,
    published: first(text(entry.published), text(entry.updated), text(entry['dc:date'])),
    media: mediaNodes(entry),
    thumbnails: toList(entry['media:thumbnail']).map((t) => ({ url: t['@_url'] })),
    enclosures: []
  };
}

/**
 * Parseert XML naar ruwe entries.
 * @param {string} xml
 * @returns {{title: string, entries: object[]}}
 */
export function parseFeed(xml) {
  if (!xml || !String(xml).trim()) throw new Error('lege respons');

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error('XML niet parseerbaar: ' + err.message);
  }

  // RSS 2.0
  if (doc.rss && doc.rss.channel) {
    const channel = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
    return {
      title: text(channel.title),
      entries: toList(channel.item).map(fromRssItem)
    };
  }

  // RDF (RSS 1.0): items staan naast het channel
  if (doc['rdf:RDF']) {
    const rdf = doc['rdf:RDF'];
    return {
      title: text(rdf.channel && rdf.channel.title),
      entries: toList(rdf.item).map(fromRssItem)
    };
  }

  // Atom
  if (doc.feed) {
    return {
      title: text(doc.feed.title),
      entries: toList(doc.feed.entry).map(fromAtomEntry)
    };
  }

  throw new Error('geen RSS-, RDF- of Atom-structuur gevonden');
}

/**
 * Haalt een feed op en parseert hem.
 * @returns {Promise<object[]>} ruwe entries
 */
export async function fetchFeed(url, options = {}) {
  const xml = await fetchText(url, options);
  const { entries } = parseFeed(xml);
  if (!entries.length) throw new Error('feed bevat geen items');
  return entries;
}
