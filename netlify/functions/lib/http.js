/**
 * Gedeelde HTTP-helper: timeout, één retry en een herkenbare user-agent.
 * Elke bron gaat hier doorheen, zodat een trage of dode host nooit de hele
 * run kan ophouden.
 */

export const USER_AGENT =
  'VonkFeedBot/1.0 (+https://github.com/MaartenDeKlerkPXL/vonk)';

export class FetchError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Haalt een URL op als tekst.
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number, accept?: string, fetchImpl?: Function}} options
 * @returns {Promise<string>}
 */
export async function fetchText(url, options = {}) {
  const {
    timeoutMs = 12000,
    retries = 1,
    accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
    fetchImpl = globalThis.fetch
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          'Accept-Language': 'nl,en;q=0.8'
        }
      });
      if (!res.ok) {
        throw new FetchError('HTTP ' + res.status + ' ' + res.statusText, {
          status: res.status,
          url
        });
      }
      return await res.text();
    } catch (err) {
      lastError = err instanceof FetchError
        ? err
        : new FetchError(
          err.name === 'AbortError' ? 'timeout na ' + timeoutMs + 'ms' : err.message,
          { url }
        );
      // 4xx komt niet goed bij een tweede poging; alleen netwerk/5xx opnieuw proberen
      if (lastError.status >= 400 && lastError.status < 500) break;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Voert taken uit met een maximum aantal tegelijk, zodat we niet twintig
 * hosts tegelijk aanslaan. Faalt nooit als geheel: elke taak levert een
 * settled-resultaat op.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (err) {
        results[index] = { status: 'rejected', reason: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
