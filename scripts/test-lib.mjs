/**
 * Tests voor de feed-pijplijn. Draait zonder netwerk: elke bron krijgt
 * een nagebootste fetch die vaste XML/HTML teruggeeft.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripHtml, htmlToParagraphs, makeSnippet, pickImage,
  toIsoDate, stableId, canonicalUrl, normalizeEntry, decodeEntities
} from '../netlify/functions/lib/normalize.js';
import { parseFeed } from '../netlify/functions/lib/rss.js';
import { buildFeed } from '../netlify/functions/lib/build-feed.js';
import { SOURCES, CATEGORIES, ITEMS_PER_CATEGORY, validateSources } from '../netlify/functions/lib/sources.js';

/* ---------------- fixtures ---------------- */

const rssXml = (count = 3, prefix = 'rss') => `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Testfeed</title>
${Array.from({ length: count }, (_, i) => `
  <item>
    <title>${prefix} kop ${i} &amp; meer</title>
    <link>https://voorbeeld.nl/${prefix}/${i}?utm_source=feed</link>
    <description>&lt;p&gt;Zin een. Zin twee. Zin drie die er nog bij komt en het geheel flink langer maakt dan tweehonderd tekens zodat het afkappen getest wordt en er echt genoeg tekst staat.&lt;/p&gt;</description>
    <content:encoded>&lt;p&gt;Alinea een.&lt;/p&gt;&lt;p&gt;Alinea twee.&lt;/p&gt;</content:encoded>
    <pubDate>Tue, 0${(i % 9) + 1} Sep 2026 08:00:00 GMT</pubDate>
    <media:content url="https://voorbeeld.nl/${prefix}-${i}.jpg" type="image/jpeg"/>
  </item>`).join('')}
</channel></rss>`;

const atomXml = (count = 3) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>r/test</title>
${Array.from({ length: count }, (_, i) => `
  <entry>
    <title>[Nieuw] Atom kop ${i}</title>
    <link rel="alternate" href="https://www.reddit.com/r/test/comments/${i}/"/>
    <content type="html">&lt;img src="https://i.redd.it/${i}.png"&gt;&lt;p&gt;Reddit tekst ${i}&lt;/p&gt;</content>
    <updated>2026-09-0${(i % 9) + 1}T10:00:00Z</updated>
  </entry>`).join('')}
</feed>`;

const googleNewsXml = () => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Google News</title>
  <item>
    <title>Roda JC wint van Cambuur - De Limburger</title>
    <link>https://news.google.com/rss/articles/abc123</link>
    <description>&lt;a href="x"&gt;Roda JC wint van Cambuur&lt;/a&gt;&amp;nbsp;&amp;nbsp;De Limburger</description>
    <pubDate>Fri, 05 Sep 2026 20:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const vueHtml = () => `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Movie","name":"Testfilm Een","url":"https://www.vuecinemas.nl/film/testfilm-een","description":"Een film over iets.","image":"https://www.vuecinemas.nl/poster1.jpg"},
 {"@type":"Movie","name":"Testfilm Twee","url":"https://www.vuecinemas.nl/film/testfilm-twee","description":"Nog een film.","image":"https://www.vuecinemas.nl/poster2.jpg"}
]}
</script></head><body></body></html>`;

/** Nagebootste fetch die per bron-type het juiste formaat teruggeeft. */
function makeFakeFetch({ failing = new Set(), itemsPerFeed = 3 } = {}) {
  return async (url) => {
    if (failing.has(url)) {
      return { ok: false, status: 500, statusText: 'Server Error', text: async () => '' };
    }
    let body;
    if (url.includes('news.google.com')) body = googleNewsXml();
    else if (url.includes('reddit.com')) body = atomXml(itemsPerFeed);
    else if (url.includes('vuecinemas.nl')) body = vueHtml();
    else body = rssXml(itemsPerFeed, new URL(url).hostname.replace(/\W/g, ''));
    return { ok: true, status: 200, statusText: 'OK', text: async () => body };
  };
}

const silentLogger = { warn() {}, error() {}, log() {} };

/* ---------------- normalisatie ---------------- */

test('stripHtml verwijdert tags en decodeert entiteiten', () => {
  assert.equal(stripHtml('<p>Caf&eacute; &amp; bar</p>'), 'Café & bar');
  assert.equal(stripHtml('<script>kwaad()</script><p>Tekst</p>'), 'Tekst');
  assert.equal(stripHtml(null), '');
});

test('decodeEntities kent numerieke varianten', () => {
  assert.equal(decodeEntities('&#233;&#x27;'), "é'");
});

test('htmlToParagraphs behoudt alinea-indeling', () => {
  const out = htmlToParagraphs('<p>Een.</p><p>Twee.</p><br>Drie.');
  assert.equal(out, 'Een.\n\nTwee.\n\nDrie.');
});

test('makeSnippet kapt af op een zinsgrens, nooit midden in een woord', () => {
  const long = 'Eerste zin hier. ' + 'Tweede zin is langer en gaat maar door en door en door. '.repeat(6);
  const snippet = makeSnippet(long);
  assert.ok(snippet.length <= 205, 'snippet is ' + snippet.length + ' tekens');
  assert.ok(/[.!?…]$/.test(snippet), 'eindigt op leesteken: ' + snippet.slice(-30));
  assert.ok(!/\s\w{1,2}$/.test(snippet.replace('…', '')), 'geen afgebroken woord');
});

test('makeSnippet laat korte tekst met rust', () => {
  assert.equal(makeSnippet('Kort en klaar.'), 'Kort en klaar.');
});

test('pickImage volgt de vaste volgorde media → enclosure → img → null', () => {
  assert.equal(pickImage({
    media: [{ url: 'https://a.nl/1.jpg', type: 'image/jpeg' }],
    enclosures: [{ url: 'https://a.nl/2.jpg', type: 'image/jpeg' }],
    contentHtml: '<img src="https://a.nl/3.jpg">'
  }), 'https://a.nl/1.jpg');

  assert.equal(pickImage({
    enclosures: [{ url: 'https://a.nl/2.jpg', type: 'image/jpeg' }],
    contentHtml: '<img src="https://a.nl/3.jpg">'
  }), 'https://a.nl/2.jpg');

  assert.equal(pickImage({ contentHtml: '<img src="https://a.nl/3.jpg">' }), 'https://a.nl/3.jpg');
  assert.equal(pickImage({ contentHtml: '<p>niets</p>' }), null);
  assert.equal(pickImage({}), null);
});

test('pickImage negeert video-enclosures en maakt http https', () => {
  assert.equal(pickImage({ enclosures: [{ url: 'https://a.nl/v.mp4', type: 'video/mp4' }] }), null);
  assert.equal(pickImage({ media: [{ url: 'http://a.nl/1.jpg', type: 'image/jpeg' }] }), 'https://a.nl/1.jpg');
});

test('toIsoDate valt terug op nu bij rommel en weigert de toekomst', () => {
  assert.equal(toIsoDate('Tue, 01 Sep 2026 08:00:00 GMT'), '2026-09-01T08:00:00.000Z');
  assert.ok(toIsoDate('geen datum').startsWith('20'));
  const future = new Date(Date.now() + 5 * 86400000).toISOString();
  assert.ok(new Date(toIsoDate(future)).getTime() <= Date.now() + 1000);
});

test('canonicalUrl haalt tracking-parameters weg', () => {
  assert.equal(
    canonicalUrl('https://a.nl/x?utm_source=rss&utm_medium=feed&id=7#top'),
    'https://a.nl/x?id=7'
  );
});

test('stableId is stabiel en negeert tracking-parameters', () => {
  const a = stableId('bron', 'https://a.nl/x?utm_source=rss');
  const b = stableId('bron', 'https://a.nl/x');
  const c = stableId('bron', 'https://a.nl/y');
  assert.equal(a, b, 'zelfde artikel moet hetzelfde id houden');
  assert.notEqual(a, c);
  assert.match(a, /^bron-[0-9a-f]{10}$/);
});

test('normalizeEntry weigert entries zonder kop of link', () => {
  const source = { id: 's', category: 'memes', name: 'S' };
  assert.equal(normalizeEntry({ title: '', link: 'https://a.nl' }, source), null);
  assert.equal(normalizeEntry({ title: 'Kop', link: '' }, source), null);
});

/* ---------------- feed-parser ---------------- */

test('parseFeed leest RSS 2.0', () => {
  const { entries } = parseFeed(rssXml(2));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'rss kop 0 & meer');
});

test('parseFeed leest Atom', () => {
  const { entries } = parseFeed(atomXml(2));
  assert.equal(entries.length, 2);
  assert.match(entries[0].link, /^https:\/\/www\.reddit\.com/);
});

test('parseFeed leest RDF (RSS 1.0)', () => {
  const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <channel><title>Oud</title></channel>
    <item><title>Item</title><link>https://a.nl/1</link><description>Tekst</description></item>
  </rdf:RDF>`;
  assert.equal(parseFeed(rdf).entries.length, 1);
});

test('parseFeed klaagt duidelijk over onzin', () => {
  assert.throws(() => parseFeed(''), /lege respons/);
  assert.throws(() => parseFeed('<html><body>geen feed</body></html>'), /geen RSS-, RDF- of Atom-structuur/);
});

/* ---------------- bronnenlijst ---------------- */

test('sources.js is consistent', () => {
  assert.deepEqual(validateSources(), []);
});

test('geen enkele categorie leunt uitsluitend op Reddit', () => {
  for (const category of CATEGORIES) {
    const nonReddit = SOURCES.filter((s) => s.category === category.id && s.type !== 'reddit');
    assert.ok(nonReddit.length > 0, category.id + ' heeft alleen Reddit-bronnen');
  }
});

/* ---------------- volledige run ---------------- */

test('buildFeed levert een frontend-klaar document', async () => {
  const { doc, report } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });

  assert.ok(doc, 'document is gebouwd');
  assert.equal(report.fatal, false);
  assert.equal(doc.categories.length, 15);
  assert.ok(doc.items.length > 0);

  for (const category of CATEGORIES) {
    assert.ok(report.categories[category.id].count > 0, category.id + ' is leeg');
  }

  for (const item of doc.items) {
    for (const key of ['id', 'category', 'headline', 'snippet', 'fullContent', 'sourceUrl', 'publishedAt']) {
      assert.ok(item[key], 'ontbrekend veld ' + key + ' in ' + item.id);
    }
    assert.ok(item.photoUrl === null || /^https:\/\//.test(item.photoUrl));
    assert.ok(CATEGORIES.some((c) => c.id === item.category));
    assert.ok(!/<[a-z]/i.test(item.headline + item.snippet), 'HTML in tekst van ' + item.id);
    assert.ok(!isNaN(new Date(item.publishedAt)));
  }
});

test('id\'s zijn stabiel tussen twee runs met dezelfde brondata', async () => {
  const options = { fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 }, logger: silentLogger };
  const first = await buildFeed(options);
  const second = await buildFeed(options);
  assert.deepEqual(
    first.doc.items.map((i) => i.id).sort(),
    second.doc.items.map((i) => i.id).sort()
  );
});

test('items zijn uniek en gekapt op het maximum per categorie', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch({ itemsPerFeed: 40 }), retries: 0 },
    logger: silentLogger
  });
  const ids = doc.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'dubbele id\'s in de feed');

  for (const category of CATEGORIES) {
    const count = doc.items.filter((i) => i.category === category.id).length;
    assert.ok(count <= ITEMS_PER_CATEGORY, category.id + ' heeft er ' + count);
  }
});

test('een kapotte bron laat de rest van de run intact', async () => {
  const kapot = new Set([SOURCES[0].url, SOURCES[3].url, SOURCES[10].url]);
  const { doc, report } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch({ failing: kapot }), retries: 0 },
    logger: silentLogger
  });

  assert.ok(doc, 'de run levert nog steeds een document');
  assert.equal(report.sourcesFailed, 3);
  assert.ok(report.totalItems > 0);
  for (const failed of report.sources.filter((s) => !s.ok)) {
    assert.match(failed.error, /HTTP 500/);
  }
});

test('categorie waarvan alles faalt houdt de items van de vorige run', async () => {
  const rodaSource = SOURCES.find((s) => s.category === 'roda-jc');
  const previous = {
    items: [{
      id: 'roda-news-oud1', category: 'roda-jc', headline: 'Oud bericht',
      snippet: 'Uit de vorige run.', fullContent: 'Uit de vorige run.',
      photoUrl: null, sourceUrl: 'https://a.nl/oud', publishedAt: '2026-09-01T00:00:00.000Z'
    }]
  };

  const { doc, report } = await buildFeed({
    previous,
    fetchOptions: { fetchImpl: makeFakeFetch({ failing: new Set([rodaSource.url]) }), retries: 0 },
    logger: silentLogger
  });

  assert.equal(report.categories['roda-jc'].carriedOver, true);
  assert.ok(doc.items.some((i) => i.id === 'roda-news-oud1'));
});

test('alles kapot: geen document, zodat de bestaande feed blijft staan', async () => {
  const alles = new Set(SOURCES.map((s) => s.url));
  const { doc, report } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch({ failing: alles }), retries: 0 },
    logger: silentLogger
  });
  assert.equal(doc, null);
  assert.equal(report.fatal, true);
  assert.equal(report.totalItems, 0);
});

test('de scraper leest films uit JSON-LD', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });
  const films = doc.items.filter((i) => i.category === 'vue-kerkrade');
  assert.equal(films.length, 2);
  assert.equal(films.find((f) => f.headline === 'Testfilm Een').photoUrl, 'https://www.vuecinemas.nl/poster1.jpg');
});

test('Roda JC: uitgever uit de kop, fullContent gelijk aan snippet', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });
  const item = doc.items.find((i) => i.category === 'roda-jc');
  assert.equal(item.headline, 'Roda JC wint van Cambuur');
  assert.equal(item.fullContent, item.snippet);
});
