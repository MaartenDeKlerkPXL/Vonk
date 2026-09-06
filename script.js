/* =========================================================
   Vonk — Fase 1
   Vanilla JS, geen frameworks.

   Opzet in lagen zodat latere fases weinig hoeven te raken:
   - CONFIG      : instellingen op één plek (o.a. de databron)
   - dataSource  : haalt items + categorieën op. Fase 2 vervangt
                   alleen de URL door de Netlify-functie.
   - storage     : dunne async adapter rond localStorage. Fase 3
                   vervangt alleen deze adapter door Supabase.
   - store       : app-state die van storage leest/schrijft.
   - ui          : schermen, deck, swipe, detail, archief.

   Categorieën staan NIET in de code: die komen uit de databron.
   ========================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------
     CONFIG
     ------------------------------------------------------ */
  const CONFIG = {
    // De live feed, gevuld door de scheduled function (fase 2). Lukt die niet
    // - lokaal draaien zonder Netlify, of nog geen geslaagde run - dan wordt
    // de rij hieronder op volgorde afgelopen tot er iets bruikbaars komt.
    dataUrl: '/.netlify/functions/get-feed',
    fallbackDataUrls: ['data/feed.json', 'data/dummy-data.json'],
    storagePrefix: 'vonk.v1.',
    visibleCards: 3,          // aantal kaarten zichtbaar in de stapel
    swipeThreshold: 0.3,      // fractie van de kaartbreedte
    swipeVelocity: 0.55,      // px/ms — snelle flick committeert ook
    // Verticaal bladeren en horizontaal swipen mogen elkaar niet in de weg
    // zitten: pas als één richting duidelijk overheerst wordt de as gekozen,
    // en daarna blijft die vast voor de rest van het gebaar.
    axisRatio: 1.3,           // hoeveel de winnende richting moet overheersen
    axisDecideAt: 8,          // px voordat er een as gekozen wordt
    browseThreshold: 0.18,    // fractie van de kaarthoogte om te bladeren
    browseVelocity: 0.4,      // px/ms
    wheelThreshold: 24,       // scrollafstand die als één stap telt
    wheelCooldownMs: 320,
    tapMaxMove: 10,           // px waarbinnen een druk als tik telt
    tapMaxTime: 500,          // ms
    toastMs: 2400
  };

  const KEYS = {
    followed: 'followed',
    dismissed: 'dismissed',
    saved: 'saved',
    lastAction: 'lastAction',
    onboarded: 'onboarded',
    // fase 3 - alleen deze drie hierboven worden gesynchroniseerd;
    // lastAction (undo) en onboarded blijven per apparaat
    syncCode: 'syncCode',
    syncPending: 'syncPending',
    syncAt: 'syncAt'
  };

  /** Wijzigingen aan deze sleutels gaan ook naar Supabase. */
  const SYNCED_KEYS = [KEYS.followed, KEYS.dismissed, KEYS.saved];

  /* ------------------------------------------------------
     STORAGE — async adapter (Fase 3: hier Supabase inpluggen)
     ------------------------------------------------------ */
  const storage = {
    available: (function () {
      try {
        const k = '__vonk_test__';
        window.localStorage.setItem(k, '1');
        window.localStorage.removeItem(k);
        return true;
      } catch (err) {
        return false;
      }
    })(),
    memory: new Map(),

    async get(key, fallback) {
      const full = CONFIG.storagePrefix + key;
      try {
        const raw = this.available ? window.localStorage.getItem(full) : this.memory.get(full);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch (err) {
        console.warn('[vonk] kon opslag niet lezen:', key, err);
        return fallback;
      }
    },

    async set(key, value) {
      const full = CONFIG.storagePrefix + key;
      const raw = JSON.stringify(value);
      try {
        if (this.available) window.localStorage.setItem(full, raw);
        else this.memory.set(full, raw);
      } catch (err) {
        console.warn('[vonk] kon opslag niet schrijven:', key, err);
      }
      // Lokaal is de bron van waarheid: hierboven is al geschreven, dus de
      // UI wacht nergens op. De server volgt op de achtergrond.
      if (SYNCED_KEYS.indexOf(key) !== -1) markSyncDirty();
    },

    async remove(key) {
      const full = CONFIG.storagePrefix + key;
      try {
        if (this.available) window.localStorage.removeItem(full);
        else this.memory.delete(full);
      } catch (err) {
        console.warn('[vonk] kon opslag niet wissen:', key, err);
      }
    }
  };

  /**
   * Leest beide vormen van de weggeswipete lijst: fase 1-3 sloeg alleen
   * id's op, fase 4 hele items. Oude id's blijven werken als item met
   * alleen een id, zodat de feed ze niet opnieuw laat zien.
   */
  function toDismissedMap(value) {
    const map = new Map();
    if (!Array.isArray(value)) return map;
    for (const entry of value) {
      if (typeof entry === 'string') map.set(entry, { id: entry });
      else if (entry && entry.id) map.set(entry.id, entry);
    }
    return map;
  }

  /* ------------------------------------------------------
     SYNC-BRUG
     Alles wat met Supabase praat zit in sync.js. Hier staat alleen
     hoe de app daarop reageert. Ontbreekt sync.js of de configuratie,
     dan doet dit niets en werkt de app puur lokaal door.
     ------------------------------------------------------ */
  function syncLayer() {
    return window.VonkSync || null;
  }

  function markSyncDirty() {
    const sync = syncLayer();
    if (!sync || sync.applyingRemote) return;
    sync.markDirty();
  }

  /** Een stand die van een ander apparaat binnenkomt toepassen. */
  function applyRemoteState(data) {
    state.saved = Array.isArray(data.saved) ? data.saved : [];
    state.savedIds = new Set(state.saved.map((i) => i.id));
    state.dismissed = toDismissedMap(data.dismissed);

    const known = new Set(state.categories.map((c) => c.id));
    state.followed = new Set(
      (Array.isArray(data.followed) ? data.followed : []).filter((id) => known.has(id))
    );

    // een undo van vóór de synchronisatie slaat nergens meer op
    state.lastAction = null;
    storage.remove(KEYS.lastAction);

    updateSavedBadge();
    updateUndoButtons();
    if (state.items.length) rebuildFeed();
    if (state.screen === 'saved') renderSaved();
    if (state.screen === 'categories') renderCategories();
  }

  /* ------------------------------------------------------
     DATABRON
     ------------------------------------------------------ */
  const dataSource = {
    // welke bron het uiteindelijk werd, puur voor de logs en de foutmelding
    lastUsedUrl: null,

    async loadFrom(url) {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = await res.json();
      const categories = Array.isArray(doc.categories) ? doc.categories : [];
      const items = Array.isArray(doc.items) ? doc.items : [];
      if (!categories.length || !items.length) throw new Error('databron bevat geen items');
      return { categories, items, generatedAt: doc.generatedAt || null, origin: doc.source || 'onbekend' };
    },

    async load() {
      const urls = [CONFIG.dataUrl].concat(CONFIG.fallbackDataUrls || []);
      const failures = [];

      for (const url of urls) {
        try {
          const data = await this.loadFrom(url);
          this.lastUsedUrl = url;
          if (failures.length) {
            console.warn('[vonk] teruggevallen op ' + url + ' (' + failures.join('; ') + ')');
          }
          return data;
        } catch (err) {
          failures.push(url + ': ' + err.message);
        }
      }
      throw new Error(failures.join(' | '));
    }
  };

  /* ------------------------------------------------------
     STATE
     ------------------------------------------------------ */
  const state = {
    categories: [],
    categoryById: new Map(),
    items: [],
    followed: new Set(),
    // fase 4: volledige items, niet alleen id's — zodat het scherm
    // Feed-kwaliteit per bron kan tellen wat er wordt weggeswipet
    dismissed: new Map(),
    saved: [],              // volledige item-objecten (bron kan wijzigen)
    savedIds: new Set(),
    queue: [],              // feed-stapel
    cursor: 0,              // welke kaart bovenop ligt; browsen verschuift dit
    lastAction: null,       // { type: 'save' | 'dismiss', item }
    screen: 'feed',
    detail: null,           // { item, context }
    savedFilter: 'all',
    savedQuery: '',
    onboarded: false,
    busy: false             // true tijdens een lopende swipe-animatie
  };

  /* ------------------------------------------------------
     DOM
     ------------------------------------------------------ */
  const el = {};
  function cacheDom() {
    const ids = [
      'app', 'deck', 'stateLoading', 'stateEmpty', 'stateError', 'emptyText', 'errorText',
      'btnRetry', 'deckControls', 'deckHint', 'btnSkip', 'btnSave', 'btnUndo', 'btnUndoBig',
      'btnSettings', 'savedList', 'savedEmpty', 'savedEmptyTitle', 'savedEmptyText',
      'savedSearch', 'savedSearchClear', 'savedFilters', 'savedCount', 'catGrid', 'catCount',
      'catTitle', 'catSub', 'btnCatDone', 'btnSelectAll', 'btnSelectNone', 'tabBadge',
      'detail', 'detailClose', 'detailFigure', 'detailImage', 'detailCategory',
      'detailDate', 'detailTitle', 'detailText', 'detailSource', 'detailActions', 'detailScroll',
      'toast',
      'syncPanel', 'syncStatus', 'syncIntro', 'syncCodeRow', 'syncCode', 'syncNote',
      'btnSyncCopy', 'btnSyncUnlink', 'btnSyncEnable', 'syncInput', 'btnSyncLink',
      'browseBar', 'browsePosition', 'btnPrev', 'btnNext',
      'qualityPanel', 'qualityList', 'qualityCount'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
    el.screens = {
      feed: document.getElementById('screen-feed'),
      saved: document.getElementById('screen-saved'),
      categories: document.getElementById('screen-categories')
    };
    el.tabs = Array.from(document.querySelectorAll('.tab'));
  }

  /* ------------------------------------------------------
     HELPERS
     ------------------------------------------------------ */
  const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
    'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d.getTime())) return iso;
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function categoryOf(item) {
    return state.categoryById.get(item.category) || {
      id: item.category, label: item.category, icon: '•', accent: '#0a84ff'
    };
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function highlight(text, query) {
    const safe = escapeHtml(text);
    if (!query) return safe;
    const needle = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(needle, 'gi'), (m) => '<mark>' + m + '</mark>');
  }

  function svgIcon(paths, opts) {
    const o = opts || {};
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', o.viewBox || '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', o.width || '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    });
    return svg;
  }

  const ICON = {
    check: ['M4 12.5 9.5 18 20 6.5'],
    cross: ['M6 6l12 12', 'M18 6 6 18'],
    bookmark: ['M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z'],
    trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 13h10l1-13']
  };

  let toastTimer = null;
  function toast(message) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.hidden = false;
    // forceer reflow zodat de transitie ook bij snelle opvolging speelt
    void el.toast.offsetWidth;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('is-visible');
      setTimeout(() => { el.toast.hidden = true; }, 240);
    }, CONFIG.toastMs);
  }

  /* ------------------------------------------------------
     FEED-STAPEL OPBOUWEN
     ------------------------------------------------------ */
  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Round-robin over categorieën zodat je niet vier keer hetzelfde
  // onderwerp achter elkaar krijgt.
  function buildQueue() {
    const buckets = new Map();
    state.items.forEach((item) => {
      if (!state.followed.has(item.category)) return;
      if (state.dismissed.has(item.id)) return;
      if (state.savedIds.has(item.id)) return;
      if (!buckets.has(item.category)) buckets.set(item.category, []);
      buckets.get(item.category).push(item);
    });

    const lanes = shuffle(Array.from(buckets.values()).map(shuffle));
    const queue = [];
    let round = 0;
    let added = true;
    while (added) {
      added = false;
      for (const lane of lanes) {
        if (lane.length > round) { queue.push(lane[round]); added = true; }
      }
      round++;
    }
    state.queue = queue;
    state.cursor = 0;
  }

  /* ------------------------------------------------------
     NAVIGATIE
     ------------------------------------------------------ */
  function showScreen(name) {
    if (!el.screens[name]) return;
    state.screen = name;
    Object.entries(el.screens).forEach(([key, node]) => {
      const active = key === name;
      node.classList.toggle('is-active', active);
      node.hidden = !active;
      if (active) node.scrollTop = 0;
    });
    el.tabs.forEach((tab) => {
      const active = tab.dataset.screen === name;
      tab.classList.toggle('is-active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    if (name === 'feed') updateFeedChrome();
    if (name === 'saved') renderSaved();
    if (name === 'categories') renderCategories();
  }

  /* ------------------------------------------------------
     CATEGORIEËN-SCHERM
     ------------------------------------------------------ */
  function renderCategories() {
    const grid = el.catGrid;
    grid.textContent = '';

    state.categories.forEach((cat, i) => {
      const on = state.followed.has(cat.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'cat-card' + (on ? ' is-on' : '');
      card.style.setProperty('--cat-accent', cat.accent || '#0a84ff');
      card.style.setProperty('--stagger', (i * 22) + 'ms');
      card.setAttribute('aria-pressed', String(on));
      card.dataset.category = cat.id;

      const icon = document.createElement('span');
      icon.className = 'cat-card__icon';
      icon.textContent = cat.icon || '•';

      const label = document.createElement('span');
      label.className = 'cat-card__label';
      label.textContent = cat.label;

      const check = document.createElement('span');
      check.className = 'cat-card__check';
      check.appendChild(svgIcon(ICON.check, { width: '3' }));

      card.append(icon, label, check);

      if (cat.description) {
        const desc = document.createElement('span');
        desc.className = 'cat-card__desc';
        desc.textContent = cat.description;
        card.insertBefore(desc, check);
      }

      card.addEventListener('click', () => toggleCategory(cat.id, card));
      grid.appendChild(card);
    });

    updateCategoryFooter();
    renderSync();
    renderQuality();

    const first = !state.onboarded;
    el.catTitle.textContent = first ? 'Wat wil je volgen?' : 'Jouw categorieën';
    el.catSub.textContent = first
      ? 'Kies je onderwerpen. Alleen deze categorieën komen in je feed.'
      : 'Zet categorieën aan of uit. Je feed past zich direct aan.';
    el.btnCatDone.textContent = first ? 'Start mijn feed' : 'Naar mijn feed';
  }

  async function toggleCategory(id, card) {
    if (state.followed.has(id)) state.followed.delete(id);
    else state.followed.add(id);

    const on = state.followed.has(id);
    if (card) {
      card.classList.toggle('is-on', on);
      card.setAttribute('aria-pressed', String(on));
    }
    updateCategoryFooter();
    await storage.set(KEYS.followed, Array.from(state.followed));
    rebuildFeed();
  }

  function updateCategoryFooter() {
    const n = state.followed.size;
    el.catCount.textContent = n === 0
      ? 'Nog geen categorie gekozen'
      : plural(n, 'categorie gevolgd', 'categorieën gevolgd');
    el.btnCatDone.disabled = n === 0;
  }

  /* ------------------------------------------------------
     FEED-KWALITEIT
     Telt per bron hoeveel je hebt weggeswipet. Niet om artikelen terug
     te lezen, maar om te zien welke feed structureel niets oplevert.
     ------------------------------------------------------ */
  function renderQuality() {
    const lijst = el.qualityList;
    lijst.textContent = '';

    const items = dismissedAsList();
    el.qualityCount.textContent = items.length
      ? plural(items.length, 'item overgeslagen', 'items overgeslagen')
      : 'nog niets overgeslagen';

    if (!items.length) {
      const leeg = document.createElement('p');
      leeg.className = 'quality__empty';
      leeg.textContent = 'Zodra je artikelen wegveegt, zie je hier per bron hoeveel dat er zijn.';
      lijst.appendChild(leeg);
      return;
    }

    // groeperen op bron; items van vóór fase 4 hebben er nog geen
    const perBron = new Map();
    for (const item of items) {
      const sleutel = item.sourceId || 'onbekend';
      if (!perBron.has(sleutel)) {
        perBron.set(sleutel, {
          id: sleutel,
          naam: item.sourceName || (item.sourceId ? item.sourceId : 'Onbekende bron'),
          category: item.category || null,
          aantal: 0
        });
      }
      perBron.get(sleutel).aantal++;
    }

    const rijen = [...perBron.values()].sort((a, b) => b.aantal - a.aantal);
    const hoogste = rijen[0].aantal;

    for (const rij of rijen) {
      const cat = rij.category ? state.categoryById.get(rij.category) : null;
      const row = document.createElement('div');
      row.className = 'quality-row';
      row.style.setProperty('--cat-accent', (cat && cat.accent) || '#0a84ff');

      const naam = document.createElement('span');
      naam.className = 'quality-row__name';
      naam.textContent = rij.naam;

      const meta = document.createElement('span');
      meta.className = 'quality-row__meta';
      meta.textContent = [cat ? cat.label : rij.category, rij.id !== 'onbekend' ? rij.id : null]
        .filter(Boolean).join(' · ') || 'bron onbekend (van vóór deze versie)';

      const aantal = document.createElement('span');
      aantal.className = 'quality-row__count';
      aantal.textContent = String(rij.aantal);

      const bar = document.createElement('div');
      bar.className = 'quality-row__bar';
      const vulling = document.createElement('span');
      vulling.style.width = Math.round((rij.aantal / hoogste) * 100) + '%';
      bar.appendChild(vulling);

      row.append(naam, aantal, meta, bar);
      lijst.appendChild(row);
    }
  }

  /* ------------------------------------------------------
     SYNC-SCHERM
     ------------------------------------------------------ */
  const SYNC_STATUS_TEKST = {
    'uit': 'uit',
    'aan': 'aan',
    'bezig': 'bezig',
    'wacht': 'wacht op verbinding',
    'fout': 'fout',
    'niet-ingesteld': 'niet ingesteld'
  };

  function setSyncNote(text, tone) {
    el.syncNote.textContent = text || '';
    if (tone) el.syncNote.dataset.tone = tone;
    else delete el.syncNote.dataset.tone;
  }

  function renderSync(syncState) {
    const sync = syncLayer();
    if (!sync) { el.syncPanel.hidden = true; return; }

    const st = syncState || sync.state;
    const linked = Boolean(st.code);

    el.syncStatus.textContent = SYNC_STATUS_TEKST[st.status] || st.status;
    el.syncStatus.dataset.status = st.status;

    el.syncCodeRow.hidden = !linked;
    el.btnSyncEnable.hidden = linked || !sync.configured;
    if (linked) el.syncCode.textContent = sync.formatCode(st.code);

    el.syncInput.disabled = !sync.configured;
    el.btnSyncLink.disabled = !sync.configured;

    if (!sync.configured) {
      el.syncIntro.textContent =
        'Synchronisatie is niet ingesteld voor deze installatie: de app draait zonder ' +
        'Supabase-gegevens. Alles werkt gewoon, maar blijft op dit apparaat.';
      return;
    }

    el.syncIntro.textContent = linked
      ? 'Voer deze code in op je andere apparaat om dezelfde bewaarde items, ' +
        'overgeslagen items en categorieën te zien. Bewaar hem goed en deel hem niet: ' +
        'wie de code heeft, heeft je archief.'
      : 'Met een syncode zie je je bewaarde items op al je apparaten. Geen account, ' +
        'geen wachtwoord: de code is de sleutel.';

    if (st.status === 'fout' && st.error) setSyncNote('Laatste poging mislukte: ' + st.error, 'fout');
    else if (st.status === 'wacht') setSyncNote('Wijzigingen staan klaar en gaan mee zodra er verbinding is.', null);
    else if (linked && st.lastSyncAt) setSyncNote('Laatst gesynchroniseerd om ' + tijdVan(st.lastSyncAt) + '.', null);
    else setSyncNote('', null);
  }

  function tijdVan(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  async function initSync() {
    const sync = syncLayer();
    if (!sync) return;
    try {
      await sync.init({
        storage: storage,
        keys: KEYS,
        onRemoteUpdate: applyRemoteState,
        onStatusChange: (st) => renderSync(st)
      });
    } catch (err) {
      console.warn('[vonk] sync kon niet starten:', err.message);
    }
    renderSync();
  }

  function bindSyncEvents() {
    const sync = syncLayer();
    if (!sync) return;

    el.btnSyncEnable.addEventListener('click', async () => {
      el.btnSyncEnable.disabled = true;
      try {
        const code = await sync.enable();
        renderSync();
        setSyncNote('Je code is ' + sync.formatCode(code) + '. Schrijf hem over op je andere apparaat.', 'goed');
        toast('Sync staat aan');
      } catch (err) {
        setSyncNote('Aanzetten mislukte: ' + err.message, 'fout');
      } finally {
        el.btnSyncEnable.disabled = false;
      }
    });

    el.btnSyncCopy.addEventListener('click', async () => {
      const code = sync.formatCode(sync.state.code || '');
      try {
        await navigator.clipboard.writeText(code);
        toast('Code gekopieerd');
      } catch (err) {
        // clipboard mag geweigerd worden; selecteren kan de gebruiker altijd
        setSyncNote('Kopiëren mocht niet. Selecteer de code hierboven en kopieer hem zelf.', null);
      }
    });

    el.btnSyncUnlink.addEventListener('click', async () => {
      await sync.unlink();
      renderSync();
      setSyncNote('Losgekoppeld. Je gegevens blijven op dit apparaat staan, en het andere ' +
        'apparaat blijft gewoon werken met de oude code.', null);
      toast('Sync losgekoppeld');
    });

    // Bij het openklappen onderaan de pagina zou het paneel half onder de
    // vaste knopbalk verdwijnen; even meescrollen scheelt zoeken.
    if (el.qualityPanel) {
      el.qualityPanel.addEventListener('toggle', () => {
        if (!el.qualityPanel.open) return;
        renderQuality();
        setTimeout(() => {
          el.qualityPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 60);
      });
    }

    el.btnSyncLink.addEventListener('click', () => linkSync());
    el.syncInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); linkSync(); }
    });
  }

  async function linkSync() {
    const sync = syncLayer();
    if (!sync) return;
    const input = el.syncInput.value;

    if (!sync.isValidCode(input)) {
      setSyncNote('Die code klopt niet: acht tekens, zonder 0, O, 1, I of L.', 'fout');
      el.syncInput.focus();
      return;
    }

    el.btnSyncLink.disabled = true;
    setSyncNote('Bezig met koppelen...', null);
    try {
      const result = await sync.link(input);
      applyRemoteState(result.data);
      el.syncInput.value = '';
      renderSync();
      setSyncNote(
        result.merged
          ? 'Gekoppeld en samengevoegd: ' + result.stats.saved + ' bewaarde items, ' +
            result.stats.followed + ' categorieën.'
          : 'Gekoppeld. ' + result.stats.saved + ' bewaarde items op dit apparaat.',
        'goed'
      );
      toast(result.merged ? 'Gekoppeld en samengevoegd' : 'Gekoppeld');
    } catch (err) {
      setSyncNote('Koppelen mislukte: ' + err.message, 'fout');
    } finally {
      el.btnSyncLink.disabled = false;
    }
  }

  /* ------------------------------------------------------
     FEED — rendering van de kaartenstapel
     ------------------------------------------------------ */
  const STACK = [
    { y: 0, scale: 1, opacity: 1 },
    { y: -22, scale: 0.955, opacity: 0.75 },
    { y: -40, scale: 0.912, opacity: 0.45 }
  ];

  function stackTransform(index) {
    const s = STACK[Math.min(index, STACK.length - 1)];
    return 'translate3d(0, ' + s.y + 'px, 0) scale(' + s.scale + ')';
  }

  // Extra tekstblok voor kaarten zonder (werkende) foto.
  function addExtraText(card, item) {
    if (!item.fullContent) return;
    const body = card.querySelector('.card__body');
    if (!body || body.querySelector('.card__extra')) return;
    const extra = document.createElement('p');
    extra.className = 'card__extra';
    extra.textContent = item.fullContent.split(/\n+/)[0];
    body.insertBefore(extra, body.querySelector('.card__foot'));
  }

  function buildCard(item) {
    const cat = categoryOf(item);
    const card = document.createElement('article');
    card.className = 'card card--enter';
    card.dataset.id = item.id;
    card.style.setProperty('--cat-accent', cat.accent || '#0a84ff');

    if (item.photoUrl) {
      const media = document.createElement('div');
      media.className = 'card__media';
      const img = document.createElement('img');
      img.src = item.photoUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      img.addEventListener('error', () => {
        // foto niet beschikbaar (offline of dode link): val terug op tekst
        media.remove();
        card.classList.add('card--no-media');
        addExtraText(card, item);
      });
      media.appendChild(img);
      card.appendChild(media);
    } else {
      card.classList.add('card--no-media');
    }

    const body = document.createElement('div');
    body.className = 'card__body';

    const tag = document.createElement('span');
    tag.className = 'cat-tag';
    const tagIcon = document.createElement('span');
    tagIcon.className = 'cat-tag__icon';
    tagIcon.textContent = cat.icon || '•';
    tag.append(tagIcon, document.createTextNode(cat.label));

    const headline = document.createElement('h2');
    headline.className = 'card__headline';
    headline.textContent = item.headline;

    const snippet = document.createElement('p');
    snippet.className = 'card__snippet';
    snippet.textContent = item.snippet;

    const foot = document.createElement('div');
    foot.className = 'card__foot';
    const date = document.createElement('span');
    date.textContent = formatDate(item.publishedAt);
    const more = document.createElement('span');
    more.className = 'card__more';
    more.textContent = 'Tik voor meer';
    foot.append(date, more);

    body.append(tag, headline, snippet);

    body.appendChild(foot);

    // Zonder foto is er ruimte over: toon alvast het begin van het artikel.
    if (!item.photoUrl) addExtraText(card, item);
    card.appendChild(body);

    const tintSave = document.createElement('div');
    tintSave.className = 'card__tint card__tint--save';
    const tintSkip = document.createElement('div');
    tintSkip.className = 'card__tint card__tint--skip';

    const stampSave = document.createElement('div');
    stampSave.className = 'card__stamp card__stamp--save';
    stampSave.appendChild(svgIcon(ICON.bookmark, { width: '2.2' }));
    stampSave.appendChild(document.createTextNode('Bewaren'));

    const stampSkip = document.createElement('div');
    stampSkip.className = 'card__stamp card__stamp--skip';
    stampSkip.appendChild(svgIcon(ICON.cross, { width: '2.6' }));
    stampSkip.appendChild(document.createTextNode('Nee'));

    card.append(tintSave, tintSkip, stampSave, stampSkip);

    card._parts = { tintSave, tintSkip, stampSave, stampSkip };
    return card;
  }

  function renderDeck() {
    const deck = el.deck;
    clampCursor();
    const wanted = state.queue.slice(state.cursor, state.cursor + CONFIG.visibleCards);
    const existing = new Map();
    Array.from(deck.children).forEach((node) => {
      if (node.classList.contains('is-flying')) return;
      existing.set(node.dataset.id, node);
    });

    const nodes = wanted.map((item) => {
      let node = existing.get(item.id);
      if (node) existing.delete(item.id);
      else node = buildCard(item);
      return node;
    });

    // afgevallen kaarten opruimen
    existing.forEach((node) => node.remove());

    nodes.forEach((node, i) => {
      if (node.parentNode !== deck) deck.appendChild(node);
      node.classList.add('card--stacking');
      node.classList.toggle('card--top', i === 0);
      node.classList.toggle('card--behind', i !== 0);
      node.style.zIndex = String(CONFIG.visibleCards - i);
      node.style.transform = stackTransform(i);
      node.style.opacity = String(STACK[Math.min(i, STACK.length - 1)].opacity);
      node.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
      if (i === 0) {
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', 'Open artikel: ' + wanted[0].headline);
        if (!node._bound) { bindCard(node); node._bound = true; }
        resetCardFeedback(node);
      } else {
        node.removeAttribute('tabindex');
        node.removeAttribute('role');
      }
    });

    // sorteer DOM-volgorde zodat z-index en stapel kloppen
    nodes.forEach((node) => deck.appendChild(node));
    Array.from(deck.children).forEach((node) => {
      if (node.classList.contains('is-flying')) deck.appendChild(node);
    });

    updateFeedChrome();
  }

  /** Houdt de cursor binnen de stapel. */
  function clampCursor() {
    if (state.cursor > state.queue.length - 1) state.cursor = Math.max(0, state.queue.length - 1);
    if (state.cursor < 0) state.cursor = 0;
  }

  /** Het item dat nu bovenop ligt. */
  function currentItem() {
    return state.queue[state.cursor] || null;
  }

  /**
   * Bladeren door de stapel zonder iets op te slaan of weg te gooien.
   * Puur kijken, zoals scrollen door een tijdlijn.
   * @param {number} step +1 = volgende, -1 = vorige
   */
  function browseBy(step) {
    if (state.busy || !state.queue.length) return false;
    const doel = state.cursor + step;
    if (doel < 0 || doel > state.queue.length - 1) {
      // even laten voelen dat je aan het einde zit
      const card = el.deck.querySelector('.card--top');
      if (card) {
        card.classList.add('card--bounce');
        setTimeout(() => card.classList.remove('card--bounce'), 320);
      }
      return false;
    }
    state.cursor = doel;
    renderDeck();
    updateBrowsePosition();
    return true;
  }

  function updateBrowsePosition() {
    if (!el.browsePosition) return;
    const totaal = state.queue.length;
    el.browsePosition.textContent = totaal ? (state.cursor + 1) + ' / ' + totaal : '';
    el.browsePosition.hidden = !totaal;
    if (el.btnPrev) el.btnPrev.disabled = state.cursor === 0 || !totaal;
    if (el.btnNext) el.btnNext.disabled = state.cursor >= totaal - 1 || !totaal;
  }

  function updateFeedChrome() {
    const hasCards = state.queue.length > 0;
    const noCategories = state.followed.size === 0;

    el.stateLoading.hidden = true;
    el.stateEmpty.hidden = hasCards;
    el.deckControls.hidden = !hasCards;
    el.deckHint.hidden = !hasCards;
    el.browseBar.hidden = !hasCards;
    el.btnSkip.disabled = !hasCards;
    el.btnSave.disabled = !hasCards;

    if (!hasCards) {
      const title = el.stateEmpty.querySelector('.state__title');
      if (noCategories) {
        title.textContent = 'Nog geen categorieën';
        el.emptyText.textContent = 'Kies eerst welke onderwerpen je wilt volgen, dan vult je feed zich.';
      } else {
        title.textContent = 'Je bent helemaal bij';
        el.emptyText.textContent = state.saved.length
          ? 'Alles uit je categorieën is langsgekomen. Je archief telt inmiddels ' +
            plural(state.saved.length, 'item', 'items') + '.'
          : 'Alles uit je categorieën is langsgekomen. Kom later terug voor nieuwe vonken.';
      }
    }
    updateUndoButtons();
    updateBrowsePosition();
  }

  function updateUndoButtons() {
    const can = !!state.lastAction;
    [el.btnUndo, el.btnUndoBig].forEach((btn) => { if (btn) btn.disabled = !can; });
  }

  function resetCardFeedback(card) {
    if (!card._parts) return;
    card._parts.tintSave.style.opacity = '0';
    card._parts.tintSkip.style.opacity = '0';
    card._parts.stampSave.style.opacity = '0';
    card._parts.stampSkip.style.opacity = '0';
  }

  function paintCardFeedback(card, dx, threshold) {
    if (!card._parts) return;
    const ratio = Math.min(1, Math.abs(dx) / threshold);
    const right = dx > 0;
    card._parts.tintSave.style.opacity = right ? String(ratio * 0.9) : '0';
    card._parts.tintSkip.style.opacity = right ? '0' : String(ratio * 0.9);
    card._parts.stampSave.style.opacity = right ? String(Math.min(1, ratio * 1.25)) : '0';
    card._parts.stampSkip.style.opacity = right ? '0' : String(Math.min(1, ratio * 1.25));
  }

  /* ------------------------------------------------------
     SWIPE — pointer events dekken muis én touch
     ------------------------------------------------------ */
  function bindCard(card) {
    let dragging = false;
    let pointerId = null;
    let startX = 0, startY = 0, startTime = 0;
    let dx = 0, dy = 0;
    let moved = false;
    let axis = null;          // null | 'x' | 'y' — eenmaal gekozen, blijft vast

    function threshold() {
      return Math.max(60, card.offsetWidth * CONFIG.swipeThreshold);
    }
    function browseThreshold() {
      return Math.max(50, card.offsetHeight * CONFIG.browseThreshold);
    }

    function onDown(e) {
      if (state.busy || dragging) return;
      if (!card.classList.contains('card--top')) return;
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      moved = false;
      axis = null;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
      dx = 0; dy = 0;
      card.classList.add('is-dragging');
      card.classList.remove('card--stacking', 'card--settling', 'card--enter');
      try { card.setPointerCapture(pointerId); } catch (err) { /* niet kritiek */ }
    }

    function onMove(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX > CONFIG.tapMaxMove || absY > CONFIG.tapMaxMove) moved = true;

      // As kiezen zodra de beweging groot genoeg is en één richting duidelijk
      // wint. Een schuine haal doet dus niets tot hij zich uitspreekt.
      if (!axis && (absX > CONFIG.axisDecideAt || absY > CONFIG.axisDecideAt)) {
        if (absX >= absY * CONFIG.axisRatio) axis = 'x';
        else if (absY >= absX * CONFIG.axisRatio) axis = 'y';
      }
      if (!axis) return;

      if (axis === 'x') {
        const rot = dx / 22;
        card.style.transform =
          'translate3d(' + dx + 'px, ' + (dy * 0.2) + 'px, 0) rotate(' + rot + 'deg)';
        paintCardFeedback(card, dx, threshold());
      } else {
        // Verticaal is puur bladeren: geen kleur, geen stempel, want er
        // verandert niets aan de status van dit artikel.
        const damped = dy * 0.55;
        card.style.transform = 'translate3d(0, ' + damped + 'px, 0) scale(0.985)';
        resetCardFeedback(card);
      }
    }

    function onUp(e) {
      if (!dragging || (e.pointerId !== undefined && e.pointerId !== pointerId)) return;
      dragging = false;
      card.classList.remove('is-dragging');
      try { card.releasePointerCapture(pointerId); } catch (err) { /* niet kritiek */ }

      const elapsed = Math.max(1, performance.now() - startTime);

      if (!moved && elapsed < CONFIG.tapMaxTime) {
        springBack(card);
        const item = currentItem();
        if (item) openDetail(item, 'feed');
        return;
      }

      if (axis === 'y') {
        const snelheid = Math.abs(dy) / elapsed;
        const bladeren = Math.abs(dy) >= browseThreshold() ||
          (snelheid >= CONFIG.browseVelocity && Math.abs(dy) > 40);
        // omhoog vegen = volgende, zoals bij een verticale tijdlijn
        if (bladeren && browseBy(dy < 0 ? 1 : -1)) return;
        springBack(card);
        return;
      }

      // Geen as gekozen betekent dat het gebaar te schuin was om te weten
      // wat de bedoeling was. Dan gebeurt er niets: liever een veeg die niet
      // aankomt dan een artikel dat ten onrechte wordt bewaard of weggegooid.
      if (axis !== 'x') {
        springBack(card);
        return;
      }

      const velocity = Math.abs(dx) / elapsed;
      const committed = Math.abs(dx) >= threshold() ||
        (velocity >= CONFIG.swipeVelocity && Math.abs(dx) > 40);

      if (committed) swipeTop(dx > 0 ? 'right' : 'left');
      else springBack(card);
    }

    function onCancel(e) {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('is-dragging');
      springBack(card);
    }

    card.addEventListener('pointerdown', onDown);
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onCancel);
    card.addEventListener('lostpointercapture', onCancel);
    card.addEventListener('dragstart', (e) => e.preventDefault());
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const item = currentItem();
        if (item) openDetail(item, 'feed');
      }
    });
  }

  function springBack(card) {
    card.classList.add('card--settling');
    card.style.transform = stackTransform(0);
    resetCardFeedback(card);
    setTimeout(() => card.classList.remove('card--settling'), 330);
  }

  function swipeTop(direction) {
    if (state.busy) return;
    const item = currentItem();
    if (!item) return;
    const card = el.deck.querySelector('.card--top');
    state.busy = true;

    if (card) {
      const sign = direction === 'right' ? 1 : -1;
      card.classList.remove('card--top', 'card--stacking', 'card--settling');
      card.classList.add('card--leaving', 'is-flying');
      card.style.zIndex = '9';
      card.style.transform =
        'translate3d(' + (sign * (window.innerWidth * 0.9 + 200)) + 'px, 40px, 0) rotate(' + (sign * 22) + 'deg)';
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 360);
    }

    state.queue.splice(state.cursor, 1);
    clampCursor();
    if (direction === 'right') applySave(item);
    else applyDismiss(item);

    state.lastAction = { type: direction === 'right' ? 'save' : 'dismiss', item: item };
    storage.set(KEYS.lastAction, state.lastAction);

    renderDeck();
    toast(direction === 'right'
      ? 'Bewaard onder ' + categoryOf(item).label
      : 'Overgeslagen');
    setTimeout(() => { state.busy = false; }, 220);
  }

  function applySave(item) {
    if (!state.savedIds.has(item.id)) {
      state.savedIds.add(item.id);
      state.saved.unshift(Object.assign({}, item, { savedAt: new Date().toISOString() }));
      storage.set(KEYS.saved, state.saved);
    }
    state.dismissed.delete(item.id);
    storage.set(KEYS.dismissed, dismissedAsList());
    updateSavedBadge();
  }

  /** De weggeswipete items als lijst, klaar voor opslag en synchronisatie. */
  function dismissedAsList() {
    return Array.from(state.dismissed.values());
  }

  function applyDismiss(item) {
    // Het volledige item bewaren, niet enkel het id: over een paar weken wil
    // je kunnen zien wélke bron veel niet-leuke content oplevert.
    state.dismissed.set(item.id, Object.assign({}, item, {
      dismissedAt: new Date().toISOString()
    }));
    storage.set(KEYS.dismissed, dismissedAsList());
  }

  function undoLast() {
    const action = state.lastAction;
    if (!action || state.busy) return;
    const item = action.item;

    if (action.type === 'save') {
      state.savedIds.delete(item.id);
      state.saved = state.saved.filter((s) => s.id !== item.id);
      storage.set(KEYS.saved, state.saved);
      updateSavedBadge();
    } else {
      state.dismissed.delete(item.id);
      storage.set(KEYS.dismissed, dismissedAsList());
    }

    // alleen terugleggen als de categorie nog gevolgd wordt, en wel op de
    // plek waar je nu staat zodat je hem meteen weer voor je hebt
    if (state.followed.has(item.category)) {
      state.queue.splice(state.cursor, 0, item);
    }

    state.lastAction = null;
    storage.remove(KEYS.lastAction);

    if (state.screen !== 'feed') showScreen('feed');
    renderDeck();
    if (state.screen === 'saved') renderSaved();
    toast('Ongedaan gemaakt');
  }

  function rebuildFeed() {
    const top = currentItem();
    buildQueue();
    // laat dezelfde kaart bovenop staan als die nog in de feed hoort
    if (top && state.followed.has(top.category) &&
        !state.dismissed.has(top.id) && !state.savedIds.has(top.id)) {
      const idx = state.queue.findIndex((i) => i.id === top.id);
      if (idx > -1) state.cursor = idx;
    }
    el.deck.textContent = '';
    renderDeck();
  }

  /* ------------------------------------------------------
     DETAIL-VIEW
     ------------------------------------------------------ */
  let lastFocused = null;

  function openDetail(item, context) {
    state.detail = { item: item, context: context };
    lastFocused = document.activeElement;
    const cat = categoryOf(item);

    el.detail.style.setProperty('--cat-accent', cat.accent || '#0a84ff');

    if (item.photoUrl) {
      el.detailImage.src = item.photoUrl;
      el.detailImage.alt = '';
      el.detailFigure.hidden = false;
    } else {
      el.detailImage.removeAttribute('src');
      el.detailFigure.hidden = true;
    }

    el.detailCategory.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'cat-tag__icon';
    icon.textContent = cat.icon || '•';
    el.detailCategory.append(icon, document.createTextNode(cat.label));
    el.detailCategory.style.setProperty('--cat-accent', cat.accent || '#0a84ff');

    el.detailDate.textContent = formatDate(item.publishedAt);
    el.detailDate.dateTime = item.publishedAt || '';
    el.detailTitle.textContent = item.headline;

    el.detailText.textContent = '';
    const body = (item.fullContent || item.snippet || '').split(/\n+/).filter(Boolean);
    body.forEach((para) => {
      const p = document.createElement('p');
      p.textContent = para;
      el.detailText.appendChild(p);
    });

    if (item.sourceUrl) {
      el.detailSource.href = item.sourceUrl;
      el.detailSource.hidden = false;
    } else {
      el.detailSource.hidden = true;
    }

    renderDetailActions(item, context);

    el.detail.hidden = false;
    el.detailScroll.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    setTimeout(() => el.detailClose.focus(), 40);
  }

  function renderDetailActions(item, context) {
    el.detailActions.textContent = '';

    if (context === 'feed') {
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'btn btn--danger';
      skip.textContent = 'Overslaan';
      skip.addEventListener('click', () => { closeDetail(); setTimeout(() => swipeTop('left'), 60); });

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn--primary';
      save.textContent = 'Bewaren';
      save.addEventListener('click', () => { closeDetail(); setTimeout(() => swipeTop('right'), 60); });

      el.detailActions.append(skip, save);
    } else if (context === 'saved') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--danger';
      remove.textContent = 'Verwijder uit bewaard';
      remove.addEventListener('click', () => { closeDetail(); removeSaved(item.id); });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn btn--ghost';
      close.textContent = 'Sluiten';
      close.addEventListener('click', closeDetail);

      el.detailActions.append(remove, close);
    }
  }

  function closeDetail() {
    if (el.detail.hidden) return;
    el.detail.hidden = true;
    state.detail = null;
    document.body.style.overflow = '';
    if (lastFocused && document.contains(lastFocused)) {
      try { lastFocused.focus(); } catch (err) { /* niet kritiek */ }
    }
  }

  /* ------------------------------------------------------
     ARCHIEF
     ------------------------------------------------------ */
  let revealObserver = null;

  function matchesQuery(item, q) {
    if (!q) return true;
    const hay = (item.headline + ' ' + item.snippet + ' ' + (item.fullContent || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderSavedFilters() {
    const row = el.savedFilters;
    row.textContent = '';

    const present = state.categories.filter((cat) =>
      state.saved.some((item) => item.category === cat.id));

    if (!present.length) { row.hidden = true; return; }
    row.hidden = false;

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (state.savedFilter === 'all' ? ' is-active' : '');
    all.textContent = 'Alles (' + state.saved.length + ')';
    all.addEventListener('click', () => { state.savedFilter = 'all'; renderSaved(); });
    row.appendChild(all);

    present.forEach((cat) => {
      const count = state.saved.filter((i) => i.category === cat.id).length;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (state.savedFilter === cat.id ? ' is-active' : '');
      chip.style.setProperty('--cat-accent', cat.accent || '#0a84ff');
      chip.textContent = cat.label + ' (' + count + ')';
      chip.addEventListener('click', () => {
        state.savedFilter = state.savedFilter === cat.id ? 'all' : cat.id;
        renderSaved();
      });
      row.appendChild(chip);
    });
  }

  function buildSavedCard(item, query) {
    const cat = categoryOf(item);
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.dataset.id = item.id;
    card.style.setProperty('--cat-accent', cat.accent || '#0a84ff');

    const thumb = document.createElement('div');
    thumb.className = 'saved-card__thumb';
    if (item.photoUrl) {
      const img = document.createElement('img');
      img.src = item.photoUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { img.remove(); thumb.textContent = cat.icon || '•'; });
      thumb.appendChild(img);
    } else {
      thumb.textContent = cat.icon || '•';
    }

    const main = document.createElement('div');
    main.className = 'saved-card__main';

    const title = document.createElement('h3');
    title.className = 'saved-card__title';
    title.innerHTML = highlight(item.headline, query);

    const snippet = document.createElement('p');
    snippet.className = 'saved-card__snippet';
    snippet.innerHTML = highlight(item.snippet, query);

    const meta = document.createElement('span');
    meta.className = 'saved-card__meta';
    meta.textContent = cat.label + ' · ' + formatDate(item.publishedAt);

    main.append(title, snippet, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-card__remove';
    remove.setAttribute('aria-label', 'Verwijder uit bewaard: ' + item.headline);
    remove.title = 'Verwijderen';
    remove.appendChild(svgIcon(ICON.trash, { width: '1.8' }));
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSaved(item.id);
    });

    card.append(thumb, main, remove);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => openDetail(item, 'saved'));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(item, 'saved'); }
    });
    return card;
  }

  function renderSaved() {
    const list = el.savedList;
    const query = state.savedQuery.trim().toLowerCase();
    list.textContent = '';
    renderSavedFilters();

    el.savedCount.textContent = state.saved.length
      ? plural(state.saved.length, 'item bewaard', 'items bewaard')
      : 'Je archief is nog leeg';

    let visible = state.saved.filter((item) => matchesQuery(item, query));
    if (state.savedFilter !== 'all') {
      visible = visible.filter((item) => item.category === state.savedFilter);
    }

    if (!visible.length) {
      el.savedEmpty.hidden = false;
      if (!state.saved.length) {
        el.savedEmptyTitle.textContent = 'Nog niets bewaard';
        el.savedEmptyText.textContent = 'Swipe in de feed naar rechts om iets in je archief te zetten.';
      } else {
        el.savedEmptyTitle.textContent = 'Geen resultaten';
        el.savedEmptyText.textContent = 'Geen bewaarde items gevonden voor deze zoekopdracht of filter.';
      }
      return;
    }
    el.savedEmpty.hidden = true;

    // groeperen per categorie, in de volgorde van de databron
    const groups = new Map();
    visible.forEach((item) => {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item);
    });

    const order = state.categories
      .map((c) => c.id)
      .filter((id) => groups.has(id))
      .concat(Array.from(groups.keys()).filter((id) => !state.categoryById.has(id)));

    if (revealObserver) revealObserver.disconnect();
    revealObserver = ('IntersectionObserver' in window)
      ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { root: el.screens.saved, rootMargin: '0px 0px -40px 0px', threshold: 0.05 })
      : null;

    order.forEach((catId) => {
      const cat = state.categoryById.get(catId) || { label: catId, accent: '#0a84ff' };
      const items = groups.get(catId);

      const group = document.createElement('section');
      group.className = 'saved-group';
      group.style.setProperty('--cat-accent', cat.accent || '#0a84ff');

      const head = document.createElement('div');
      head.className = 'saved-group__head';
      const title = document.createElement('h2');
      title.className = 'saved-group__title';
      title.textContent = cat.label;
      const count = document.createElement('span');
      count.className = 'saved-group__count';
      count.textContent = plural(items.length, 'item', 'items');
      head.append(title, count);

      const wrap = document.createElement('div');
      wrap.className = 'saved-group__items';
      items.forEach((item, i) => {
        const card = buildSavedCard(item, query);
        card.style.transitionDelay = Math.min(i * 40, 240) + 'ms';
        wrap.appendChild(card);
        if (revealObserver) revealObserver.observe(card);
        else card.classList.add('is-visible');
      });

      group.append(head, wrap);
      list.appendChild(group);
    });

    // kaarten die al in beeld staan meteen tonen
    if (revealObserver) {
      requestAnimationFrame(() => {
        list.querySelectorAll('.saved-card').forEach((card) => {
          const rect = card.getBoundingClientRect();
          if (rect.top < window.innerHeight) card.classList.add('is-visible');
        });
      });
    }
  }

  function removeSaved(id) {
    const card = el.savedList.querySelector('.saved-card[data-id="' + CSS.escape(id) + '"]');
    state.saved = state.saved.filter((item) => item.id !== id);
    state.savedIds.delete(id);
    storage.set(KEYS.saved, state.saved);

    if (state.lastAction && state.lastAction.item && state.lastAction.item.id === id) {
      state.lastAction = null;
      storage.remove(KEYS.lastAction);
      updateUndoButtons();
    }

    updateSavedBadge();
    toast('Verwijderd uit bewaard');

    if (card) {
      card.classList.add('is-removing');
      setTimeout(() => { if (state.screen === 'saved') renderSaved(); }, 260);
    } else if (state.screen === 'saved') {
      renderSaved();
    }
    if (state.screen === 'feed') updateFeedChrome();
  }

  function updateSavedBadge() {
    const n = state.saved.length;
    el.tabBadge.hidden = n === 0;
    el.tabBadge.textContent = n > 99 ? '99+' : String(n);
  }

  /* ------------------------------------------------------
     EVENTS
     ------------------------------------------------------ */
  function bindEvents() {
    el.tabs.forEach((tab) => {
      tab.addEventListener('click', () => showScreen(tab.dataset.screen));
    });
    el.btnSettings.addEventListener('click', () => showScreen('categories'));
    el.btnCatDone.addEventListener('click', async () => {
      state.onboarded = true;
      await storage.set(KEYS.onboarded, true);
      showScreen('feed');
    });
    el.btnSelectAll.addEventListener('click', async () => {
      state.categories.forEach((c) => state.followed.add(c.id));
      await storage.set(KEYS.followed, Array.from(state.followed));
      renderCategories();
      rebuildFeed();
    });
    el.btnSelectNone.addEventListener('click', async () => {
      state.followed.clear();
      await storage.set(KEYS.followed, []);
      renderCategories();
      rebuildFeed();
    });

    bindSyncEvents();

    // Scrollen over de stapel bladert; de rem voorkomt dat één trackpadveeg
    // door tien artikelen heen schiet.
    let wheelKlaarOm = 0;
    el.deck.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) < CONFIG.wheelThreshold) return;
      e.preventDefault();
      const nu = performance.now();
      if (nu < wheelKlaarOm) return;
      wheelKlaarOm = nu + CONFIG.wheelCooldownMs;
      browseBy(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    if (el.btnPrev) el.btnPrev.addEventListener('click', () => browseBy(-1));
    if (el.btnNext) el.btnNext.addEventListener('click', () => browseBy(1));

    el.btnSkip.addEventListener('click', () => swipeTop('left'));
    el.btnSave.addEventListener('click', () => swipeTop('right'));
    el.btnUndo.addEventListener('click', undoLast);
    el.btnUndoBig.addEventListener('click', undoLast);
    el.btnRetry.addEventListener('click', () => init());

    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.goto));
    });

    el.savedSearch.addEventListener('input', () => {
      state.savedQuery = el.savedSearch.value;
      el.savedSearchClear.hidden = !state.savedQuery;
      renderSaved();
    });
    el.savedSearchClear.addEventListener('click', () => {
      el.savedSearch.value = '';
      state.savedQuery = '';
      el.savedSearchClear.hidden = true;
      renderSaved();
      el.savedSearch.focus();
    });

    // foto in de detail-view die niet laadt: verberg het hele blok
    el.detailImage.addEventListener('error', () => { el.detailFigure.hidden = true; });

    el.detailClose.addEventListener('click', closeDetail);
    el.detail.querySelectorAll('[data-close-detail]').forEach((node) => {
      node.addEventListener('click', closeDetail);
    });

    document.addEventListener('keydown', (e) => {
      if (!el.detail.hidden) {
        if (e.key === 'Escape') closeDetail();
        return;
      }
      if (state.screen !== 'feed') return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName || '');
      if (typing) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); swipeTop('left'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); swipeTop('right'); }
      // omhoog/omlaag bladert alleen, zonder iets op te slaan of weg te gooien
      else if (e.key === 'ArrowDown') { e.preventDefault(); browseBy(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); browseBy(-1); }
      else if (e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); }
    });
  }

  /* ------------------------------------------------------
     INIT
     ------------------------------------------------------ */
  async function loadState() {
    const [followed, dismissed, saved, lastAction, onboarded] = await Promise.all([
      storage.get(KEYS.followed, null),
      storage.get(KEYS.dismissed, []),
      storage.get(KEYS.saved, []),
      storage.get(KEYS.lastAction, null),
      storage.get(KEYS.onboarded, false)
    ]);

    state.dismissed = toDismissedMap(dismissed);
    state.saved = Array.isArray(saved) ? saved : [];
    state.savedIds = new Set(state.saved.map((i) => i.id));
    state.lastAction = (lastAction && lastAction.item) ? lastAction : null;
    state.onboarded = !!onboarded;
    state.followed = new Set(Array.isArray(followed) ? followed : []);
    return { hasFollowedKey: Array.isArray(followed) };
  }

  async function init() {
    el.stateError.hidden = true;
    el.stateEmpty.hidden = true;
    el.stateLoading.hidden = false;

    let stored;
    try {
      stored = await loadState();
    } catch (err) {
      console.error('[vonk] opslag mislukt', err);
      stored = { hasFollowedKey: false };
    }

    let data;
    try {
      data = await dataSource.load();
    } catch (err) {
      console.error('[vonk] databron mislukt', err);
      el.stateLoading.hidden = true;
      el.stateEmpty.hidden = true;
      el.stateError.hidden = false;
      el.deckControls.hidden = true;
      el.deckHint.hidden = true;
      el.errorText.textContent = (location.protocol === 'file:')
        ? 'De feed wordt via fetch geladen; dat lukt niet bij het openen als bestand. Start de app via een lokale webserver (bijvoorbeeld: python3 -m http.server).'
        : 'Geen enkele databron reageerde. ' + err.message;
      return;
    }

    console.log(
      '[vonk] feed geladen via ' + dataSource.lastUsedUrl +
      ' (' + data.origin + (data.generatedAt ? ', opgehaald ' + data.generatedAt : '') + ')'
    );

    state.categories = data.categories;
    state.categoryById = new Map(data.categories.map((c) => [c.id, c]));
    state.items = data.items;

    // onbekende categorieën uit oude opslag opruimen
    Array.from(state.followed).forEach((id) => {
      if (!state.categoryById.has(id)) state.followed.delete(id);
    });

    updateSavedBadge();
    buildQueue();
    el.deck.textContent = '';
    renderDeck();
    renderCategories();

    const firstRun = !stored.hasFollowedKey || state.followed.size === 0;
    showScreen(firstRun ? 'categories' : 'feed');

    // Sync draait pas als de feed staat: een binnenkomende stand van een
    // ander apparaat moet tegen bekende categorieën aangehouden worden.
    await initSync();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .catch((err) => console.warn('[vonk] service worker niet geregistreerd:', err));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    bindEvents();
    registerServiceWorker();
    init();
  });
})();
