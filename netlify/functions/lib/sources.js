/**
 * Alle bronnen, per categorie.
 *
 * Eén bron hoort bij precies één categorie, dus er is geen classificatie
 * nodig: de categorie van het item is de categorie van de bron.
 *
 * De categorie-slugs zijn exact die van fase 1 (`leerzaam` en `business`,
 * niet `leerzame-artikelen`/`ondernemerschap`), zodat bestaande saved- en
 * dismissed-items in localStorage blijven kloppen.
 *
 * Velden per bron:
 *   id       stabiele prefix voor item-id's — WIJZIG DIT NIET voor een
 *            bestaande bron, want dan krijgen alle items nieuwe id's en
 *            komen eerder weggeswipete items terug
 *   type     rss | reddit | google-news | scrape
 *   risk     bekend risico, puur informatief voor de logs
 */

export const CATEGORIES = [
  { id: 'ai-nieuws', label: 'AI-nieuws', icon: '◈', accent: '#4da3ff', description: 'Alleen nieuwe ontwikkelingen, geen hype-herhaling.' },
  { id: 'gerechten', label: 'Simpele gerechten', icon: '◑', accent: '#ff8a4d', description: 'Nieuwe recepten die je binnen 30 minuten maakt.' },
  { id: 'innovatief', label: 'Innovatief', icon: '✦', accent: '#7bd8ff', description: 'Ideeën en producten die iets echt anders doen.' },
  { id: 'memes', label: 'Memes', icon: '◉', accent: '#ffd24d', description: 'Korte humor, meer niet.' },
  { id: 'leerzaam', label: 'Leerzame artikelen', icon: '▤', accent: '#9d8cff', description: 'Diepgang die je iets bijbrengt.' },
  { id: 'roda-jc', label: 'Roda JC', icon: '⚽', accent: '#ffd84d', description: 'Nieuws en uitslagen uit Kerkrade.' },
  { id: 'vue-kerkrade', label: 'Vue Kerkrade', icon: '▶', accent: '#ff5f8f', description: 'Bioscoopagenda en releases.' },
  { id: 'ui-ux', label: 'UI/UX & webdesign', icon: '◰', accent: '#5ce1c0', description: 'Interface-inspiratie en designpatronen.' },
  { id: 'gadgets', label: 'Gadgets & tech', icon: '▣', accent: '#8ab4ff', description: 'Reviews en nieuwe hardware.' },
  { id: 'ruimtevaart', label: 'Ruimtevaart & wetenschap', icon: '☄', accent: '#a48bff', description: 'Missies, ontdekkingen, onderzoek.' },
  { id: 'psychologie', label: 'Psychologie & zelfverbetering', icon: '◔', accent: '#66d29a', description: 'Gedrag, gewoontes en focus.' },
  { id: 'geschiedenis', label: 'Geschiedenis & weetjes', icon: '◴', accent: '#d9a86c', description: 'Verhalen uit het verleden.' },
  { id: 'natuur', label: 'Natuur & dieren', icon: '▲', accent: '#6fd66f', description: 'Dieren, landschappen, ecologie.' },
  { id: 'reizen', label: 'Reizen & avontuur', icon: '◆', accent: '#4dd0e1', description: 'Plekken om ooit naartoe te gaan.' },
  { id: 'business', label: 'Ondernemerschap & business', icon: '▰', accent: '#ff9f6b', description: 'Bouwen, verkopen, opschalen.' },

  // ---------- fase 4 ----------
  { id: 'pxl-nieuws', label: 'Hogeschool PXL', icon: '▥', accent: '#6fc3ff', description: 'Nieuws over de hogeschool.' },
  { id: 'the-ginger-one', label: 'The Ginger One', icon: '⚑', accent: '#ff7a3d', description: 'Persberichten van rallycoureur Thomas Martens.' },
  { id: 'nl-hiphop-releases', label: 'NL hiphop releases', icon: '◍', accent: '#c98bff', description: 'Nieuwe Nederlandse hiphop.' },
  { id: 'f1-kalender', label: 'F1-kalender', icon: '⚑', accent: '#ff4d4d', description: 'Het racekalender van dit seizoen.' },
  { id: 'f1-memes', label: 'F1-memes', icon: '◉', accent: '#ff6b6b', description: 'Humor uit de paddock.' },
  { id: 'memes-dev', label: 'Programmeurmemes', icon: '◧', accent: '#7bd8ff', description: 'Code- en webdevhumor.' },
  { id: 'memes-auto', label: 'Auto- & motorsportmemes', icon: '◑', accent: '#ffb04d', description: 'Humor over auto\'s en racen.' },
  { id: 'memes-voetbal', label: 'Voetbalmemes', icon: '◐', accent: '#5ce08a', description: 'Humor uit het voetbal.' }
];

export const SOURCES = [
  // ---------- AI-nieuws ----------
  { id: 'tc-ai', name: 'TechCrunch AI', category: 'ai-nieuws', type: 'rss', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { id: 'verge-ai', name: 'The Verge AI', category: 'ai-nieuws', type: 'rss', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { id: 'vb-ai', name: 'VentureBeat AI', category: 'ai-nieuws', type: 'rss', url: 'https://venturebeat.com/category/ai/feed/' },

  // ---------- Simpele gerechten ----------
  { id: 'budgetbytes', name: 'Budget Bytes', category: 'gerechten', type: 'rss', url: 'https://www.budgetbytes.com/feed/' },
  { id: 'simplyrecipes', name: 'Simply Recipes', category: 'gerechten', type: 'rss', url: 'https://www.simplyrecipes.com/feed' },
  { id: 'r-recipes', name: 'r/recipes', category: 'gerechten', type: 'reddit', url: 'https://www.reddit.com/r/recipes/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Innovatief ----------
  { id: 'springwise', name: 'Springwise', category: 'innovatief', type: 'rss', url: 'https://www.springwise.com/feed/' },
  { id: 'newatlas', name: 'New Atlas', category: 'innovatief', type: 'rss', url: 'https://newatlas.com/index.rss' },
  { id: 'r-futurology', name: 'r/Futurology', category: 'innovatief', type: 'reddit', url: 'https://www.reddit.com/r/Futurology/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Memes (algemeen) ----------
  // De stripfeeds die hier in fase 2 stonden zijn naar memes-dev verhuisd;
  // Bored Panda is het niet-Reddit-alternatief dat overblijft.
  { id: 'boredpanda', name: 'Bored Panda', category: 'memes', type: 'rss', url: 'https://www.boredpanda.com/feed/', risk: 'niet-geverifieerd' },
  { id: 'r-wholesome', name: 'r/wholesomememes', category: 'memes', type: 'reddit', url: 'https://www.reddit.com/r/wholesomememes/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Leerzame artikelen ----------
  { id: 'aeon', name: 'Aeon', category: 'leerzaam', type: 'rss', url: 'https://aeon.co/feed.rss' },
  { id: 'fsblog', name: 'Farnam Street', category: 'leerzaam', type: 'rss', url: 'https://fs.blog/feed/' },

  // ---------- Roda JC ----------
  { id: 'roda-news', name: 'Google News — "Roda JC"', category: 'roda-jc', type: 'google-news', url: 'https://news.google.com/rss/search?q=%22Roda+JC%22&hl=nl&gl=NL&ceid=NL:nl' },

  // ---------- Vue Kerkrade ----------
  { id: 'vue-kerkrade', name: 'Vue Kerkrade', category: 'vue-kerkrade', type: 'scrape', url: 'https://www.vuecinemas.nl/cinema/kerkrade/nu-in-de-bioscoop', risk: 'html-structuur-kan-wijzigen' },

  // ---------- UI/UX & webdesign ----------
  { id: 'smashing', name: 'Smashing Magazine', category: 'ui-ux', type: 'rss', url: 'https://www.smashingmagazine.com/feed' },
  { id: 'csstricks', name: 'CSS-Tricks', category: 'ui-ux', type: 'rss', url: 'https://css-tricks.com/feed/' },
  { id: 'r-webdesign', name: 'r/web_design', category: 'ui-ux', type: 'reddit', url: 'https://www.reddit.com/r/web_design/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Gadgets & tech ----------
  { id: 'verge', name: 'The Verge', category: 'gadgets', type: 'rss', url: 'https://www.theverge.com/rss/index.xml' },
  { id: 'engadget', name: 'Engadget', category: 'gadgets', type: 'rss', url: 'https://www.engadget.com/rss.xml' },

  // ---------- Ruimtevaart & wetenschap ----------
  { id: 'nasa', name: 'NASA', category: 'ruimtevaart', type: 'rss', url: 'https://www.nasa.gov/news-release/feed/' },
  { id: 'space', name: 'Space.com', category: 'ruimtevaart', type: 'rss', url: 'https://www.space.com/feeds/all' },

  // ---------- Psychologie & zelfverbetering ----------
  { id: 'psytoday', name: 'Psychology Today', category: 'psychologie', type: 'rss', url: 'https://www.psychologytoday.com/us/rss.xml' },
  { id: 'sd-psych', name: 'ScienceDaily Psychologie', category: 'psychologie', type: 'rss', url: 'https://www.sciencedaily.com/rss/mind_brain/psychology.xml' },

  // ---------- Geschiedenis & weetjes ----------
  { id: 'tifo', name: 'Today I Found Out', category: 'geschiedenis', type: 'rss', url: 'https://www.todayifoundout.com/index.php/feed/' },
  { id: 'sd-archeo', name: 'ScienceDaily Archeologie', category: 'geschiedenis', type: 'rss', url: 'https://www.sciencedaily.com/rss/fossils_ruins/archaeology.xml' },

  // ---------- Natuur & dieren ----------
  { id: 'sd-nature', name: 'ScienceDaily Planten & dieren', category: 'natuur', type: 'rss', url: 'https://www.sciencedaily.com/rss/plants_animals.xml' },
  { id: 'r-animalsbros', name: 'r/AnimalsBeingBros', category: 'natuur', type: 'reddit', url: 'https://www.reddit.com/r/AnimalsBeingBros/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Reizen & avontuur ----------
  { id: 'guardian-travel', name: 'The Guardian Travel', category: 'reizen', type: 'rss', url: 'https://www.theguardian.com/uk/travel/rss' },
  { id: 'atlasobscura', name: 'Atlas Obscura', category: 'reizen', type: 'rss', url: 'https://www.atlasobscura.com/feeds/latest' },

  // ---------- Ondernemerschap & business ----------
  { id: 'inc', name: 'Inc.', category: 'business', type: 'rss', url: 'https://www.inc.com/rss/' },
  { id: 'entrepreneur', name: 'Entrepreneur', category: 'business', type: 'rss', url: 'https://www.entrepreneur.com/latest.rss' },

  // ---------- Hogeschool PXL ----------
  // Geen eigen RSS gevonden; dezelfde aanpak als Roda JC.
  { id: 'pxl-news', name: 'Google News - "Hogeschool PXL"', category: 'pxl-nieuws', type: 'google-news', url: 'https://news.google.com/rss/search?q=%22Hogeschool+PXL%22&hl=nl&gl=BE&ceid=BE:nl' },

  // ---------- The Ginger One ----------
  // Gedeelde feed van persbureau BUZZ met meerdere cliënten: alleen items
  // over Thomas Martens / The Ginger One horen hier thuis.
  {
    id: 'buzz-prezly', name: 'BUZZ (Prezly)', category: 'the-ginger-one', type: 'rss',
    url: 'https://buzz.prezly.com/feed.rss',
    match: ['ginger one', 'thomas martens'],
    risk: 'gedeelde-feed-gefilterd'
  },

  // ---------- NL hiphop releases ----------
  // 101Barz heeft geen bevestigde RSS (zie README); Google News is de
  // tijdelijke vervanger.
  { id: 'hiphop-news', name: 'Google News - NL hiphop releases', category: 'nl-hiphop-releases', type: 'google-news', url: 'https://news.google.com/rss/search?q=%22nieuwe+releases%22+hiphop+Nederland&hl=nl&gl=NL&ceid=NL:nl' },

  // ---------- F1-kalender ----------
  // Geen feed maar een JSON-API: de opvolger van Ergast. De .json-extensie
  // is nodig, want zonder komt er XML terug.
  { id: 'f1-kalender', name: 'Jolpica F1', category: 'f1-kalender', type: 'f1', url: 'https://api.jolpi.ca/ergast/f1/current.json' },

  // ---------- F1-memes ----------
  // Zwakke categorie: alleen Reddit, en dat werkt vanaf Netlify vermoedelijk
  // niet. Bewust geaccepteerd tot er een betere bron opduikt.
  { id: 'r-formuladank', name: 'r/formuladank', category: 'f1-memes', type: 'reddit', url: 'https://www.reddit.com/r/formuladank/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Programmeurmemes ----------
  { id: 'xkcd', name: 'xkcd', category: 'memes-dev', type: 'rss', url: 'https://xkcd.com/rss.xml' },
  { id: 'commitstrip', name: 'CommitStrip', category: 'memes-dev', type: 'rss', url: 'https://www.commitstrip.com/en/feed/' },
  { id: 'smbc', name: 'SMBC', category: 'memes-dev', type: 'rss', url: 'https://www.smbc-comics.com/comic/rss' },
  { id: 'r-proghumor', name: 'r/ProgrammerHumor', category: 'memes-dev', type: 'reddit', url: 'https://www.reddit.com/r/ProgrammerHumor/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Auto- & motorsportmemes ----------
  // Jalopnik is geen memesite maar autocultuur met een humoristische inslag;
  // het beste niet-Reddit-alternatief dat ik kon vinden.
  { id: 'jalopnik', name: 'Jalopnik', category: 'memes-auto', type: 'rss', url: 'https://jalopnik.com/rss', risk: 'niet-geverifieerd' },
  { id: 'r-carmemes', name: 'r/carmemes', category: 'memes-auto', type: 'reddit', url: 'https://www.reddit.com/r/carmemes/.rss', risk: 'reddit-blokkeert-datacenter-ip' },

  // ---------- Voetbalmemes ----------
  // Geen bruikbaar niet-Reddit-alternatief gevonden; dunne categorie.
  { id: 'r-footballmemes', name: 'r/footballmemes', category: 'memes-voetbal', type: 'reddit', url: 'https://www.reddit.com/r/footballmemes/.rss', risk: 'reddit-blokkeert-datacenter-ip' }
];

/** Aantal items dat per categorie in feed.json terechtkomt. */
export const ITEMS_PER_CATEGORY = 20;

export function sourcesForCategory(categoryId) {
  return SOURCES.filter((source) => source.category === categoryId);
}

/** Controle bij het opstarten: elke bron hoort bij een bestaande categorie. */
export function validateSources() {
  const ids = new Set(CATEGORIES.map((c) => c.id));
  const problems = [];
  const seen = new Set();
  for (const source of SOURCES) {
    if (!ids.has(source.category)) problems.push(source.id + ': onbekende categorie ' + source.category);
    if (seen.has(source.id)) problems.push(source.id + ': dubbel bron-id');
    seen.add(source.id);
  }
  for (const category of CATEGORIES) {
    if (!SOURCES.some((s) => s.category === category.id)) problems.push(category.id + ': geen enkele bron');
  }
  return problems;
}

/**
 * Categorieën die volledig op Reddit leunen. Geen fout - Reddit weert
 * datacenter-IP's, dus deze blijven op Netlify waarschijnlijk leeg. Bewust
 * geaccepteerd voor f1-memes en voetbalmemes; de run logt het per keer.
 */
export const REDDIT_ONLY_CATEGORIES = CATEGORIES
  .filter((c) => {
    const own = SOURCES.filter((s) => s.category === c.id);
    return own.length > 0 && own.every((s) => s.type === 'reddit');
  })
  .map((c) => c.id);
