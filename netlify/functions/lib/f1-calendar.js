/**
 * F1-kalender via de Jolpica-API, de opvolger van het gestopte Ergast.
 * Geen sleutel nodig.
 *
 * Dit is het enige datatype dat geen artikelen levert maar races, dus de
 * omzetting naar het gedeelde item-formaat gebeurt hier met de hand:
 * elke race wordt één "artikel" met de circuitgegevens als tekst.
 *
 * Let op de .json-extensie in de URL: zonder komt er XML terug.
 */

import { fetchText } from './http.js';
import { stableId, toIsoDate } from './normalize.js';

const KALENDER_URL = 'https://www.formula1.com/en/racing/2026.html';

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function datumInWoorden(datum, tijd) {
  const d = new Date(datum + (tijd ? 'T' + tijd : 'T00:00:00Z'));
  if (isNaN(d.getTime())) return datum;
  const dag = d.getUTCDate() + ' ' + MAANDEN[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  if (!tijd) return dag;
  const uur = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  return dag + ' om ' + uur + ' UTC';
}

/** "Dutch Grand Prix" + Zandvoort -> "Grand Prix van Nederland" */
function nederlandseNaam(race) {
  const land = (race.Circuit && race.Circuit.Location && race.Circuit.Location.country) || '';
  if (land) return 'Grand Prix van ' + land;
  return race.raceName || 'Grand Prix';
}

export async function fetchF1Calendar(source, options = {}) {
  const body = await fetchText(source.url, {
    accept: 'application/json',
    ...options
  });

  let doc;
  try {
    doc = JSON.parse(body);
  } catch (err) {
    throw new Error('Jolpica gaf geen geldige JSON terug: ' + err.message);
  }

  const races = doc && doc.MRData && doc.MRData.RaceTable && doc.MRData.RaceTable.Races;
  if (!Array.isArray(races) || !races.length) throw new Error('geen races in het antwoord');

  return races.map((race) => {
    const circuit = race.Circuit || {};
    const locatie = circuit.Location || {};
    const plaats = [locatie.locality, locatie.country].filter(Boolean).join(', ');
    const wanneer = datumInWoorden(race.date, race.time);
    const headline = nederlandseNaam(race);

    const regels = [
      'Ronde ' + (race.round || '?') + ' van het seizoen ' + (race.season || '') + '.',
      circuit.circuitName ? 'Circuit: ' + circuit.circuitName + (plaats ? ' (' + plaats + ')' : '') + '.' : '',
      'Racedag: ' + wanneer + '.'
    ].filter(Boolean);

    const snippet = regels.join(' ');
    const sourceUrl = race.url || source.url || KALENDER_URL;

    return {
      // vast id per ronde: hetzelfde weekend houdt hetzelfde id, ook als de
      // API later een andere url teruggeeft
      id: stableId(source.id, 'f1-' + (race.season || '') + '-' + (race.round || ''), headline),
      category: source.category,
      sourceId: source.id,
      sourceName: source.name,
      headline: headline,
      snippet: snippet,
      fullContent: regels.join('\n\n'),
      photoUrl: null,
      sourceUrl: sourceUrl,
      publishedAt: toIsoDate(race.date)
    };
  });
}
