/**
 * Genereert public/supabase-config.js uit de environment variables.
 *
 * Draait als build-stap op Netlify (zie netlify.toml) en lokaal met
 * `npm run config`. Het bestand staat in .gitignore: er hoort nooit een
 * sleutel in git terecht te komen.
 *
 * De anon key is bedoeld om in de browser te staan - dat is hoe Supabase
 * werkt, de beveiliging zit in de RLS-policy en in de syncode. Daarom is
 * build-time genereren genoeg en is er geen proxy-function nodig.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'public/supabase-config.js');

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
const configured = Boolean(url && key);

if (!configured) {
  console.warn(
    '[vonk] SUPABASE_URL en/of SUPABASE_ANON_KEY ontbreken. ' +
    'public/supabase-config.js wordt leeg geschreven; de app werkt gewoon, ' +
    'alleen zonder synchronisatie.'
  );
} else if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
  // geen harde fout: een self-hosted Supabase heeft een ander domein
  console.warn('[vonk] SUPABASE_URL ziet er ongebruikelijk uit: ' + url);
}

const body = `/* Automatisch gegenereerd door scripts/generate-config.js - niet bewerken. */
window.VONK_SUPABASE = ${JSON.stringify(
  configured ? { url, anonKey: key, table: 'vonk_sync' } : null
)};
`;

await mkdir(dirname(TARGET), { recursive: true });
await writeFile(TARGET, body);

console.log(
  '[vonk] public/supabase-config.js geschreven (' +
  (configured ? 'sync ingesteld voor ' + url : 'sync uit') + ')'
);
