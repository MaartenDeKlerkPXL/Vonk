/**
 * Namen van de Blobs-store en de sleutels erin. Staan apart zodat het
 * publieke endpoint (get-feed) niets van de scheduled function (fetch-feed)
 * hoeft te importeren.
 */

export const STORE_NAME = 'vonk-feed';
export const FEED_KEY = 'feed.json';
export const REPORT_KEY = 'last-run.json';
