/**
 * Vonk — synchronisatie tussen apparaten (fase 3)
 *
 * Geen account, geen wachtwoord: één syncode is de sleutel tot één rij in
 * Supabase. Wie de code heeft, heeft de gegevens — behandel hem als een
 * wachtwoord.
 *
 * Uitgangspunten:
 * - Lokaal blijft de bron van waarheid voor de UI. Elke swipe schrijft
 *   direct naar localStorage; de server volgt op de achtergrond.
 * - Mislukt een schrijfactie, dan blijft er een "nog te versturen"-vlag
 *   staan. Bij `online` en elke 30 seconden wordt het opnieuw geprobeerd.
 * - Bij het openen wint de nieuwste stand (updated_at), behalve als er
 *   lokaal nog iets klaarstaat dat niet verstuurd is — dan wint lokaal.
 * - Zonder configuratie of zonder code werkt alles gewoon lokaal door.
 *
 * Praten met Supabase gaat via PostgREST met gewone fetch, zodat er geen
 * externe scriptbron nodig is en de app offline blijft werken.
 */
(function () {
  'use strict';

  // Geen 0/O/1/l/I: een code moet over te typen zijn vanaf een schermpje.
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LENGTH = 8;
  const RETRY_MS = 30000;
  const PUSH_DEBOUNCE_MS = 1200;
  const REQUEST_TIMEOUT_MS = 10000;

  const config = window.VONK_SUPABASE || null;

  const sync = {
    /** Is er een Supabase-configuratie meegeleverd door de build? */
    configured: Boolean(config && config.url && config.anonKey),

    /** Waar tijdens het toepassen van een stand van de server. */
    applyingRemote: false,

    state: {
      code: null,
      status: 'uit',        // uit | aan | bezig | wacht | fout | niet-ingesteld
      lastSyncAt: null,
      pending: false,
      error: null
    },

    _storage: null,
    _keys: null,
    _onRemote: null,
    _onStatus: null,
    _pushTimer: null,
    _retryTimer: null,
    _inFlight: false,

    /* ---------------------------------------------------
       CODES
       --------------------------------------------------- */

    /** Nieuwe willekeurige code, bv. "K7QP-M3XR". */
    generateCode() {
      const bytes = new Uint32Array(CODE_LENGTH);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      let out = '';
      for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
      return out;
    },

    /**
     * Invoer van de gebruiker naar de vorm waarin we opslaan: hoofdletters,
     * streepjes en spaties eruit. Verder niets vervangen - het alfabet bevat
     * bewust geen 0/O/1/I/L, dus zulke tekens horen een nette foutmelding op
     * te leveren in plaats van stilzwijgend iets anders te worden.
     */
    normalizeCode(input) {
      return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    },

    /** Weergavevorm met een streepje in het midden. */
    formatCode(code) {
      const clean = this.normalizeCode(code);
      if (clean.length !== CODE_LENGTH) return clean;
      return clean.slice(0, 4) + '-' + clean.slice(4);
    },

    isValidCode(input) {
      const clean = this.normalizeCode(input);
      if (clean.length !== CODE_LENGTH) return false;
      return [...clean].every((ch) => ALPHABET.includes(ch));
    },

    /* ---------------------------------------------------
       OPSTARTEN
       --------------------------------------------------- */

    /**
     * @param {{storage: object, keys: object, onRemoteUpdate: Function, onStatusChange: Function}} deps
     */
    async init(deps) {
      this._storage = deps.storage;
      this._keys = deps.keys;
      this._onRemote = deps.onRemoteUpdate || function () {};
      this._onStatus = deps.onStatusChange || function () {};

      this.state.code = await this._storage.get(this._keys.syncCode, null);
      this.state.pending = Boolean(await this._storage.get(this._keys.syncPending, false));
      this.state.lastSyncAt = await this._storage.get(this._keys.syncAt, null);

      if (!this.configured) {
        this._setStatus('niet-ingesteld');
      } else if (!this.state.code) {
        this._setStatus('uit');
      } else {
        this._setStatus(this.state.pending ? 'wacht' : 'aan');
      }

      window.addEventListener('online', () => this.flush());
      this._retryTimer = setInterval(() => {
        if (this.state.pending && navigator.onLine) this.flush();
      }, RETRY_MS);

      // eerste ophaalronde, maar alleen als er iets te synchroniseren valt
      if (this.active()) await this.pull();
      return this.state;
    },

    /** Synchronisatie staat aan en kan iets doen. */
    active() {
      return this.configured && Boolean(this.state.code);
    },

    _setStatus(status, error) {
      this.state.status = status;
      this.state.error = error || null;
      this._onStatus(this.state);
    },

    /* ---------------------------------------------------
       SUPABASE (PostgREST)
       --------------------------------------------------- */

    async _request(path, options = {}) {
      if (!this.configured) throw new Error('sync is niet ingesteld op deze installatie');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(config.url + '/rest/v1/' + path, {
          ...options,
          signal: controller.signal,
          headers: {
            apikey: config.anonKey,
            Authorization: 'Bearer ' + config.anonKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(options.headers || {})
          }
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error('Supabase HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('time-out richting Supabase');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    /** Haalt de rij van een code op, of null als die er nog niet is. */
    async fetchRow(code) {
      const rows = await this._request(
        config.table + '?sync_code=eq.' + encodeURIComponent(code) +
        '&select=saved_items,dismissed_items,followed_categories,updated_at'
      );
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    /** Schrijft de complete stand weg (upsert op sync_code). */
    async writeRow(code, payload) {
      const body = [{
        sync_code: code,
        saved_items: payload.saved || [],
        // fase 4: volledige items, zodat het kwaliteitsoverzicht ook op een
        // tweede apparaat klopt
        dismissed_items: payload.dismissed || [],
        followed_categories: payload.followed || [],
        // expliciet meesturen: de default van de kolom geldt alleen bij insert
        updated_at: new Date().toISOString()
      }];
      const rows = await this._request(config.table, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(body)
      });
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    /* ---------------------------------------------------
       LOKALE STAND
       --------------------------------------------------- */

    async localSnapshot() {
      const [saved, dismissed, followed] = await Promise.all([
        this._storage.get(this._keys.saved, []),
        this._storage.get(this._keys.dismissed, []),
        this._storage.get(this._keys.followed, [])
      ]);
      return {
        saved: Array.isArray(saved) ? saved : [],
        dismissed: Array.isArray(dismissed) ? dismissed : [],
        followed: Array.isArray(followed) ? followed : []
      };
    },

    /**
     * Schrijft een binnengekomen stand lokaal weg. De vlag zorgt dat de
     * storage-hook in script.js dit niet als eigen wijziging ziet en
     * meteen weer terugstuurt.
     */
    async writeLocal(data) {
      this.applyingRemote = true;
      try {
        await this._writeLocalRaw(data);
      } finally {
        this.applyingRemote = false;
      }
    },

    async _writeLocalRaw(data) {
      await Promise.all([
        this._storage.set(this._keys.saved, data.saved),
        this._storage.set(this._keys.dismissed, data.dismissed),
        this._storage.set(this._keys.followed, data.followed)
      ]);
    },

    /** Zet een rij uit Supabase om naar de vorm die de app gebruikt. */
    rowToData(row) {
      const list = (value) => (Array.isArray(value) ? value : []);
      return {
        saved: list(row.saved_items),
        // dismissed_ids is het oude fase 3-veld; oude rijen blijven werken
        dismissed: list(row.dismissed_items).length
          ? list(row.dismissed_items)
          : list(row.dismissed_ids).map((id) => (typeof id === 'string' ? { id } : id)),
        followed: list(row.followed_categories),
        updatedAt: row.updated_at || null
      };
    },

    /**
     * Voegt twee standen samen. Bewaarde items op id ontdubbeld, nieuwste
     * savedAt wint; dismissed en categorieën zijn eenvoudige verzamelingen.
     */
    mergeData(a, b) {
      const savedById = new Map();
      for (const item of [...(a.saved || []), ...(b.saved || [])]) {
        if (!item || !item.id) continue;
        const existing = savedById.get(item.id);
        if (!existing) { savedById.set(item.id, item); continue; }
        const newer = new Date(item.savedAt || 0) > new Date(existing.savedAt || 0);
        if (newer) savedById.set(item.id, item);
      }
      const saved = [...savedById.values()].sort(
        (x, y) => new Date(y.savedAt || 0) - new Date(x.savedAt || 0)
      );
      const savedIds = new Set(saved.map((i) => i.id));

      // Weggeswipete items zijn sinds fase 4 volledige objecten; ontdubbelen
      // gaat dus op id, net als bij de bewaarde items.
      const dismissedById = new Map();
      for (const entry of [...(a.dismissed || []), ...(b.dismissed || [])]) {
        const item = typeof entry === 'string' ? { id: entry } : entry;
        if (!item || !item.id) continue;
        const bestaand = dismissedById.get(item.id);
        // het rijkste exemplaar wint: eentje mét bron boven eentje zonder
        if (!bestaand || (!bestaand.sourceId && item.sourceId)) dismissedById.set(item.id, item);
      }
      // een bewaard item hoort niet ook in de weggeswipete lijst te staan
      const dismissed = [...dismissedById.values()].filter((item) => !savedIds.has(item.id));

      const followed = [...new Set([...(a.followed || []), ...(b.followed || [])])];
      return { saved, dismissed, followed };
    },

    /* ---------------------------------------------------
       SYNCHRONISEREN
       --------------------------------------------------- */

    /** Markeert dat er lokaal iets is gewijzigd; verstuurt kort daarna. */
    markDirty() {
      if (!this.active()) return;
      this.state.pending = true;
      this._storage.set(this._keys.syncPending, true);
      if (this.state.status !== 'wacht') this._setStatus('wacht');

      clearTimeout(this._pushTimer);
      this._pushTimer = setTimeout(() => this.flush(), PUSH_DEBOUNCE_MS);
    },

    /** Stuurt de huidige lokale stand naar Supabase. */
    async flush() {
      if (!this.active() || this._inFlight) return false;
      if (!navigator.onLine) { this._setStatus('wacht'); return false; }

      this._inFlight = true;
      this._setStatus('bezig');
      try {
        const snapshot = await this.localSnapshot();
        await this.writeRow(this.state.code, snapshot);
        this.state.pending = false;
        this.state.lastSyncAt = new Date().toISOString();
        await this._storage.set(this._keys.syncPending, false);
        await this._storage.set(this._keys.syncAt, this.state.lastSyncAt);
        this._setStatus('aan');
        return true;
      } catch (err) {
        console.warn('[vonk] versturen mislukt, blijft in de wachtrij:', err.message);
        this.state.pending = true;
        await this._storage.set(this._keys.syncPending, true);
        this._setStatus('wacht', err.message);
        return false;
      } finally {
        this._inFlight = false;
      }
    },

    /**
     * Haalt de stand op en werkt lokaal bij.
     * Staat er lokaal nog iets klaar dat niet verstuurd is, dan wint lokaal.
     */
    async pull() {
      if (!this.active()) return null;
      if (!navigator.onLine) { this._setStatus('wacht'); return null; }

      this._setStatus('bezig');
      try {
        if (this.state.pending) {
          await this.flush();
          return null;
        }

        const row = await this.fetchRow(this.state.code);
        if (!row) {
          // nog geen rij: deze code is nieuw, dus zet de lokale stand erin
          await this.flush();
          return null;
        }

        const remote = this.rowToData(row);
        await this.writeLocal(remote);
        this.state.lastSyncAt = new Date().toISOString();
        await this._storage.set(this._keys.syncAt, this.state.lastSyncAt);
        this._setStatus('aan');
        this._onRemote(remote);
        return remote;
      } catch (err) {
        console.warn('[vonk] ophalen mislukt:', err.message);
        this._setStatus('fout', err.message);
        return null;
      }
    },

    /* ---------------------------------------------------
       KOPPELEN EN LOSKOPPELEN
       --------------------------------------------------- */

    /**
     * Koppelt dit apparaat aan een code.
     * Staat er lokaal al iets, dan wordt dat eenmalig samengevoegd met wat
     * er onder die code staat.
     *
     * @returns {Promise<{merged: boolean, data: object, stats: object}>}
     */
    async link(rawCode) {
      if (!this.configured) throw new Error('sync is niet ingesteld op deze installatie');
      const code = this.normalizeCode(rawCode);
      if (!this.isValidCode(code)) throw new Error('die code klopt niet (8 tekens, letters en cijfers)');

      const local = await this.localSnapshot();
      const hadLocalData = local.saved.length > 0 || local.dismissed.length > 0 || local.followed.length > 0;

      const row = await this.fetchRow(code);
      const remote = row ? this.rowToData(row) : { saved: [], dismissed: [], followed: [] };
      const remoteHadData = Boolean(row);

      const merged = (hadLocalData && remoteHadData)
        ? this.mergeData(remote, local)
        : (remoteHadData ? remote : local);

      await this.writeLocal(merged);

      this.state.code = code;
      await this._storage.set(this._keys.syncCode, code);

      await this.writeRow(code, merged);
      this.state.pending = false;
      this.state.lastSyncAt = new Date().toISOString();
      await this._storage.set(this._keys.syncPending, false);
      await this._storage.set(this._keys.syncAt, this.state.lastSyncAt);
      this._setStatus('aan');

      return {
        merged: hadLocalData && remoteHadData,
        data: merged,
        stats: {
          saved: merged.saved.length,
          dismissed: merged.dismissed.length,
          followed: merged.followed.length,
          savedToegevoegd: merged.saved.length - local.saved.length
        }
      };
    },

    /** Zet sync aan met een verse eigen code. */
    async enable() {
      const code = this.generateCode();
      this.state.code = code;
      await this._storage.set(this._keys.syncCode, code);
      this._setStatus(this.configured ? 'bezig' : 'niet-ingesteld');
      if (this.configured) await this.flush();
      return code;
    },

    /**
     * Koppelt dit apparaat los: nieuwe eigen code, lokale gegevens blijven
     * staan en de rij in Supabase blijft ongemoeid, zodat het andere
     * apparaat gewoon doorwerkt.
     */
    async unlink() {
      clearTimeout(this._pushTimer);
      this.state.code = null;
      this.state.pending = false;
      this.state.lastSyncAt = null;
      await this._storage.remove(this._keys.syncCode);
      await this._storage.set(this._keys.syncPending, false);
      await this._storage.remove(this._keys.syncAt);
      this._setStatus(this.configured ? 'uit' : 'niet-ingesteld');
    }
  };

  window.VonkSync = sync;
})();
