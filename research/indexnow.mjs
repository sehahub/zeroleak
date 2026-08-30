// Tells IndexNow-participating search engines (Bing, Yandex, Seznam) that
// pages have appeared or changed. No account needed: ownership is proved by
// hosting a key file at the site root.
import { readFileSync } from 'node:fs';
const key = readFileSync('.indexnow-key', 'utf8').trim();
const host = 'zeroleak.sehahub.info';
const urlList = [
  '/', '/guides', '/guides/redact-a-pdf-properly',
  '/guides/remove-pdf-metadata', '/guides/hidden-content-in-pdfs',
].map((p) => `https://${host}${p}`);

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }),
});
console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs`);
console.log(await res.text().catch(() => ''));
