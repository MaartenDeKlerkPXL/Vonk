/**
 * Vervanger voor de kapotte Vue Kerkrade-scraper: "nu in de bioscoop"-films
 * uit The Movie Database (TMDB), voor de Nederlandse markt.
 *
 * Vue's eigen site laadt de programmering pas na een Cloudflare-botcheck
 * (zie git-historie van scrape-vue-kerkrade.js) — dat omzeilen we niet.
 * TMDB is een publieke, gratis API zonder anti-bot-laag en geeft per film
 * een titel + Nederlandstalige synopsis, precies wat deze categorie nodig
 * heeft. Het is niet exact het Kerkrade-programma, maar wel echte, actuele
 * films die nu in de Nederlandse bioscoop draaien.
 *
 * Vereist een gratis TMDB API-leessleutel in de env var TMDB_API_KEY
 * (v3 "API Key", geen v4 Bearer-token nodig). Zonder sleutel blijft deze
 * categorie leeg met een duidelijke waarschuwing — geen crash.
 */

import { fetchText } from './http.js';
import { normalizeEntry, stripHtml } from './normalize.js';

const API_BASE = 'https://api.themoviedb.org/3/movie/now_playing';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';

/**
 * @returns {Promise<{items: object[], warning?: string}>}
 */
export async function fetchTmdbNowPlaying(source, options = {}) {
  const apiKey = (process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) {
    return {
      items: [],
      warning:
        'Vue Kerkrade / nu-in-de-bioscoop: TMDB_API_KEY ontbreekt. Zet een gratis ' +
        'TMDB API-sleutel als env var om deze categorie te vullen. Deze run blijft leeg.'
    };
  }

  const url = API_BASE + '?region=NL&language=nl-NL&page=1&api_key=' + encodeURIComponent(apiKey);
  const body = await fetchText(url, { accept: 'application/json', ...options });

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return {
      items: [],
      warning: 'Vue Kerkrade / nu-in-de-bioscoop: onverwacht antwoord van TMDB, geen geldige JSON.'
    };
  }

  const films = Array.isArray(data.results) ? data.results : [];
  if (!films.length) {
    return {
      items: [],
      warning: 'Vue Kerkrade / nu-in-de-bioscoop: TMDB gaf geen films terug voor regio NL.'
    };
  }

  const items = films
    .filter((film) => film.title && film.overview)
    .map((film) => normalizeEntry(
      {
        title: film.title,
        link: 'https://www.themoviedb.org/movie/' + film.id,
        summary: stripHtml(film.overview),
        descriptionHtml: film.overview,
        contentHtml: film.overview,
        published: film.release_date || '',
        media: film.poster_path ? [{ url: POSTER_BASE + film.poster_path, type: 'image/jpeg' }] : []
      },
      source
    ))
    .filter(Boolean);

  return { items, strategy: 'tmdb-now-playing' };
}
