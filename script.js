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
    // Fase 2: vervang dit door de live JSON-endpoint.
    dataUrl: 'data/dummy-data.json',
    storagePrefix: 'vonk.v1.',
    visibleCards: 3,          // aantal kaarten zichtbaar in de stapel
    swipeThreshold: 0.3,      // fractie van de kaartbreedte
    swipeVelocity: 0.55,      // px/ms — snelle flick committeert ook
    tapMaxMove: 10,           // px waarbinnen een druk als tik telt
    tapMaxTime: 500,          // ms
    toastMs: 2400
  };

  const KEYS = {
    followed: 'followed',
    dismissed: 'dismissed',
    saved: 'saved',
    lastAction: 'lastAction',
    onboarded: 'onboarded'
  };

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

  /* ------------------------------------------------------
     DATABRON
     ------------------------------------------------------ */
  const dataSource = {
    async load() {
      const res = await fetch(CONFIG.dataUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = await res.json();
      const categories = Array.isArray(doc.categories) ? doc.categories : [];
      const items = Array.isArray(doc.items) ? doc.items : [];
      if (!categories.length || !items.length) throw new Error('Databron bevat geen items');
      return { categories, items };
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
    dismissed: new Set(),
    saved: [],              // volledige item-objecten (bron kan wijzigen)
    savedIds: new Set(),
    queue: [],              // feed-stapel, index 0 = bovenste kaart
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
      'toast'
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
    const wanted = state.queue.slice(0, CONFIG.visibleCards);
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

  function updateFeedChrome() {
    const hasCards = state.queue.length > 0;
    const noCategories = state.followed.size === 0;

    el.stateLoading.hidden = true;
    el.stateEmpty.hidden = hasCards;
    el.deckControls.hidden = !hasCards;
    el.deckHint.hidden = !hasCards;
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

    function threshold() {
      return Math.max(60, card.offsetWidth * CONFIG.swipeThreshold);
    }

    function onDown(e) {
      if (state.busy || dragging) return;
      if (!card.classList.contains('card--top')) return;
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      moved = false;
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
      if (Math.abs(dx) > CONFIG.tapMaxMove || Math.abs(dy) > CONFIG.tapMaxMove) moved = true;
      const rot = dx / 22;
      card.style.transform =
        'translate3d(' + dx + 'px, ' + (dy * 0.35) + 'px, 0) rotate(' + rot + 'deg)';
      paintCardFeedback(card, dx, threshold());
    }

    function onUp(e) {
      if (!dragging || (e.pointerId !== undefined && e.pointerId !== pointerId)) return;
      dragging = false;
      card.classList.remove('is-dragging');
      try { card.releasePointerCapture(pointerId); } catch (err) { /* niet kritiek */ }

      const elapsed = Math.max(1, performance.now() - startTime);
      const velocity = Math.abs(dx) / elapsed;
      const committed = Math.abs(dx) >= threshold() ||
        (velocity >= CONFIG.swipeVelocity && Math.abs(dx) > 40);

      if (!moved && elapsed < CONFIG.tapMaxTime) {
        springBack(card);
        const item = state.queue[0];
        if (item) openDetail(item, 'feed');
        return;
      }
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
        const item = state.queue[0];
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
    const item = state.queue[0];
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

    state.queue.shift();
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
    updateSavedBadge();
  }

  function applyDismiss(item) {
    state.dismissed.add(item.id);
    storage.set(KEYS.dismissed, Array.from(state.dismissed));
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
      storage.set(KEYS.dismissed, Array.from(state.dismissed));
    }

    // alleen terugleggen als de categorie nog gevolgd wordt
    if (state.followed.has(item.category)) state.queue.unshift(item);

    state.lastAction = null;
    storage.remove(KEYS.lastAction);

    if (state.screen !== 'feed') showScreen('feed');
    renderDeck();
    if (state.screen === 'saved') renderSaved();
    toast('Ongedaan gemaakt');
  }

  function rebuildFeed() {
    const top = state.queue[0];
    buildQueue();
    // laat dezelfde kaart bovenop staan als die nog in de feed hoort
    if (top && state.followed.has(top.category) &&
        !state.dismissed.has(top.id) && !state.savedIds.has(top.id)) {
      const idx = state.queue.findIndex((i) => i.id === top.id);
      if (idx > 0) {
        state.queue.splice(idx, 1);
        state.queue.unshift(top);
      }
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

    state.dismissed = new Set(Array.isArray(dismissed) ? dismissed : []);
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
        : 'De databron is niet bereikbaar (' + err.message + ').';
      return;
    }

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
