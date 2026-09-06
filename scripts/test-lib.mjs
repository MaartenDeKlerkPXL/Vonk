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
  toIsoDate, stableId, canonicalUrl, normalizeEntry, decodeEntities, matchesSource
} from '../netlify/functions/lib/normalize.js';
import { parseFeed } from '../netlify/functions/lib/rss.js';
import { buildFeed } from '../netlify/functions/lib/build-feed.js';
import {
  SOURCES, CATEGORIES, ITEMS_PER_CATEGORY, validateSources, REDDIT_ONLY_CATEGORIES
} from '../netlify/functions/lib/sources.js';

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

const atomXml = (count = 3, sub = 'test') => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>r/${sub}</title>
${Array.from({ length: count }, (_, i) => `
  <entry>
    <title>[Nieuw] Atom kop ${i}</title>
    <link rel="alternate" href="https://www.reddit.com/r/${sub}/comments/${i}/"/>
    <content type="html">&lt;img src="https://i.redd.it/${i}.png"&gt;&lt;p&gt;Reddit tekst ${i}&lt;/p&gt;</content>
    <updated>2026-09-0${(i % 9) + 1}T10:00:00Z</updated>
  </entry>`).join('')}
</feed>`;

// De zoekopdracht bepaalt de inhoud, zodat drie Google News-bronnen niet
// toevallig hetzelfde artikel leveren (en de dedupe ze zou opslokken).
const googleNewsXml = (query = 'roda') => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Google News</title>
  <item>
    <title>${query} in het nieuws - De Krant</title>
    <link>https://news.google.com/rss/articles/${encodeURIComponent(query)}</link>
    <description>&lt;a href="x"&gt;${query} in het nieuws&lt;/a&gt;&amp;nbsp;&amp;nbsp;De Krant</description>
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

const f1Json = () => JSON.stringify({
  MRData: {
    RaceTable: {
      season: '2026',
      Races: [
        {
          season: '2026', round: '1', raceName: 'Bahrain Grand Prix',
          url: 'https://en.wikipedia.org/wiki/2026_Bahrain_Grand_Prix',
          date: '2026-03-08', time: '15:00:00Z',
          Circuit: {
            circuitName: 'Bahrain International Circuit',
            Location: { locality: 'Sakhir', country: 'Bahrain' }
          }
        },
        {
          season: '2026', round: '2', raceName: 'Dutch Grand Prix',
          url: 'https://en.wikipedia.org/wiki/2026_Dutch_Grand_Prix',
          date: '2026-08-30',
          Circuit: {
            circuitName: 'Circuit Zandvoort',
            Location: { locality: 'Zandvoort', country: 'Netherlands' }
          }
        }
      ]
    }
  }
});

/** Gedeelde persbureau-feed: twee cliënten door elkaar. */
const prezlyXml = () => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>BUZZ</title>
  <item>
    <title>The Ginger One pakt podium in Ieper</title>
    <link>https://buzz.prezly.com/ginger-one-ieper</link>
    <description>Thomas Martens reed naar het podium.</description>
    <pubDate>Mon, 01 Sep 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Thomas Martens tekent bij nieuw team</title>
    <link>https://buzz.prezly.com/martens-team</link>
    <description>De coureur uit Hasselt maakt de overstap.</description>
    <pubDate>Tue, 02 Sep 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Bakkerij opent derde filiaal in Hasselt</title>
    <link>https://buzz.prezly.com/bakkerij</link>
    <description>Een heel andere client van hetzelfde persbureau.</description>
    <pubDate>Wed, 03 Sep 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** Nagebootste fetch die per bron-type het juiste formaat teruggeeft. */
function makeFakeFetch({ failing = new Set(), itemsPerFeed = 3 } = {}) {
  return async (url) => {
    if (failing.has(url)) {
      return { ok: false, status: 500, statusText: 'Server Error', text: async () => '' };
    }
    let body;
    if (url.includes('jolpi.ca')) body = f1Json();
    else if (url.includes('prezly.com')) body = prezlyXml();
    else if (url.includes('news.google.com')) {
      const q = new URL(url).searchParams.get('q') || 'nieuws';
      body = googleNewsXml(q.replace(/["+]/g, ' ').trim());
    }
    else if (url.includes('reddit.com')) {
      const sub = (url.match(/\/r\/([^/]+)\//) || [, 'test'])[1];
      body = atomXml(itemsPerFeed, sub);
    }
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

test('alleen de twee geaccepteerde categorieën leunen op Reddit alleen', () => {
  // Reddit weert datacenter-IP's, dus een categorie zonder alternatief blijft
  // op Netlify leeg. Voor f1-memes en voetbalmemes is dat een bewuste keuze
  // (geen bruikbare niet-Reddit-bron gevonden); de rest moet een vangnet hebben.
  const bewust = new Set(['f1-memes', 'memes-voetbal']);
  for (const category of CATEGORIES) {
    if (bewust.has(category.id)) continue;
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
  assert.equal(doc.categories.length, CATEGORIES.length);
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
  assert.equal(item.headline, 'Roda JC in het nieuws', 'uitgever hoort van de kop af');
  assert.equal(item.fullContent, item.snippet);
});


/* ---------------- fase 4 ---------------- */

test('matchesSource filtert een gedeelde feed op onderwerp', () => {
  const item = { headline: 'The Ginger One wint', snippet: '', fullContent: '' };
  const ander = { headline: 'Bakkerij opent filiaal', snippet: '', fullContent: '' };
  assert.equal(matchesSource(item, ['ginger one', 'thomas martens']), true);
  assert.equal(matchesSource(ander, ['ginger one', 'thomas martens']), false);
  assert.equal(matchesSource(ander, []), true, 'zonder zoektermen mag alles door');
});

test('elk item draagt een sourceId dat naar een bestaande bron wijst', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });
  const bronIds = new Set(SOURCES.map((s) => s.id));
  for (const item of doc.items) {
    assert.ok(item.sourceId, 'geen sourceId op ' + item.id);
    assert.ok(bronIds.has(item.sourceId), 'onbekende sourceId ' + item.sourceId);
    assert.ok(item.sourceName, 'geen sourceName op ' + item.id);
    assert.ok(item.id.startsWith(item.sourceId + '-'), 'id hoort met de bron te beginnen: ' + item.id);
  }
});

test('The Ginger One houdt alleen de eigen berichten over', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });
  const items = doc.items.filter((i) => i.category === 'the-ginger-one');
  assert.equal(items.length, 2, 'het bakkerijbericht hoort eruit');
  for (const item of items) {
    assert.match(item.headline.toLowerCase(), /ginger one|thomas martens/);
  }
});

test('de F1-kalender wordt races in het gedeelde item-formaat', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });
  const races = doc.items.filter((i) => i.category === 'f1-kalender');
  assert.equal(races.length, 2);

  const zandvoort = races.find((r) => r.headline === 'Grand Prix van Netherlands');
  assert.ok(zandvoort, 'kop is opgebouwd uit het land');
  assert.match(zandvoort.snippet, /Circuit Zandvoort/);
  assert.match(zandvoort.snippet, /Ronde 2/);
  assert.match(zandvoort.snippet, /30 augustus 2026/);
  assert.equal(zandvoort.photoUrl, null);
  assert.match(zandvoort.sourceUrl, /^https:\/\//);
});

test('races houden hun id als de API een andere url gaat teruggeven', async () => {
  const eerste = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 }, logger: silentLogger
  });
  const anderUrl = makeFakeFetch();
  const tweede = await buildFeed({
    fetchOptions: {
      fetchImpl: async (url) => {
        if (!url.includes('jolpi.ca')) return anderUrl(url);
        const doc = JSON.parse(f1Json());
        doc.MRData.RaceTable.Races.forEach((r) => { r.url = 'https://formula1.com/anders/' + r.round; });
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(doc) };
      },
      retries: 0
    },
    logger: silentLogger
  });
  const ids = (res) => res.doc.items.filter((i) => i.category === 'f1-kalender').map((i) => i.id).sort();
  assert.deepEqual(ids(eerste), ids(tweede));
});

test('geen enkel artikel komt in twee categorieën terecht', async () => {
  const { doc } = await buildFeed({
    fetchOptions: { fetchImpl: makeFakeFetch(), retries: 0 },
    logger: silentLogger
  });
  const perUrl = new Map();
  for (const item of doc.items) {
    const sleutel = canonicalUrl(item.sourceUrl);
    if (perUrl.has(sleutel)) {
      assert.fail('dezelfde url in ' + perUrl.get(sleutel) + ' en ' + item.category + ': ' + sleutel);
    }
    perUrl.set(sleutel, item.category);
  }
});

test('alleen f1-memes en voetbalmemes leunen volledig op Reddit', () => {
  assert.deepEqual([...REDDIT_ONLY_CATEGORIES].sort(), ['f1-memes', 'memes-voetbal']);
});

test('de meme-subcategorieën bestaan en hebben hun eigen bronnen', () => {
  for (const id of ['memes-dev', 'memes-auto', 'memes-voetbal', 'f1-memes']) {
    assert.ok(CATEGORIES.some((c) => c.id === id), 'categorie ontbreekt: ' + id);
    assert.ok(SOURCES.some((s) => s.category === id), 'geen bron voor ' + id);
  }
  // de stripfeeds horen nu bij de programmeurmemes
  for (const id of ['xkcd', 'commitstrip', 'smbc']) {
    assert.equal(SOURCES.find((s) => s.id === id).category, 'memes-dev');
  }
  // en de algemene memes zijn niet leeg achtergebleven
  assert.ok(SOURCES.some((s) => s.category === 'memes' && s.type !== 'reddit'));
});
