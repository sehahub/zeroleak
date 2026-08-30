// End-to-end smoke test: serves dist/, drives a real browser, drops the leaky
// fixture into the page and checks the rendered report.
import { createServer } from 'node:http';
import { readFile, stat, readdir, mkdir, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf } from '../src/lib/analyze.ts';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.pdf': 'application/pdf',
};

const ROOT = resolve('dist');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // Stand in for the Worker so the page behaves as it does in production.
    if (url.pathname.startsWith('/api/')) { res.writeHead(204); res.end(); return; }
    let p = join(ROOT, decodeURIComponent(url.pathname));
    if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) { console.error('no browser found'); process.exit(1); }

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base, { waitUntil: 'networkidle0' });
ok(await page.$('#dz') !== null, 'landing page renders the dropzone');

const input = await page.$('#file');
await input.uploadFile(resolve('test/fixtures/leaky.pdf'));

await page.waitForSelector('.finding', { timeout: 45000 });
const text = await page.$eval('#report', (n) => n.innerText);
const verdict = await page.$eval('.verdict-score', (n) => n.textContent);

ok(/891-23-4567/.test(text), 'browser report recovers text hidden under the black box');
ok(/settlement ceiling/.test(text), 'browser report surfaces invisible text');
ok(/Jane Doe/.test(text), 'browser report surfaces the author metadata');
ok(/severance_master\.csv/.test(text), 'browser report lists the embedded file');
const headline = await page.$eval('.verdict-body h2', (n) => n.textContent);
ok(headline.startsWith(verdict + ' '), `headline number matches the score (score ${verdict}, headline "${headline}")`);
ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);

// Nothing may be sent anywhere: assert no request left the origin.
const offOrigin = [];
page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) offOrigin.push(r.url()); });
await page.reload({ waitUntil: 'networkidle0' });
await (await page.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await page.waitForSelector('.finding', { timeout: 45000 });
ok(offOrigin.length === 0, `no off-origin requests during a scan${offOrigin.length ? ': ' + offOrigin.join(', ') : ''}`);

// ---- the cleaner, end to end -------------------------------------------
const DL = resolve('.tmp-downloads');
await rm(DL, { recursive: true, force: true });
await mkdir(DL, { recursive: true });

const p2 = await browser.newPage();
p2.on('pageerror', (e) => errors.push('cleaner: ' + String(e)));
const cdp = await p2.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

await p2.goto(base, { waitUntil: 'networkidle0' });
await (await p2.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await p2.waitForSelector('.cleaner', { timeout: 45000 });
ok(true, 'cleaner panel appears for a file with findings');

const flattenLabel = await p2.$eval('.opt.destructive b', (n) => n.textContent);
ok(/\(page 1\)/.test(flattenLabel), `cleaner names the page it will flatten (${flattenLabel})`);

await p2.$$eval('.cleaner button', (bs) => bs.find((b) => /Clean and download/.test(b.textContent)).click());
await p2.waitForSelector('.done', { timeout: 90000 });

let file = null;
for (let i = 0; i < 60 && !file; i++) {
  const found = (await readdir(DL)).filter((f) => f.endsWith('.pdf'));
  if (found.length) file = join(DL, found[0]); else await new Promise((r) => setTimeout(r, 250));
}
ok(file !== null, `the cleaned PDF is downloaded (${file ? file.split(/[\/]/).pop() : 'nothing appeared'})`);

if (file) {
  const cleanedBytes = new Uint8Array(await readFile(file));
  const after = await analyzePdf(cleanedBytes, pdfjs, { fileName: 'cleaned.pdf' });
  ok(after.counts.critical === 0 && after.counts.warning === 0,
    `the browser-cleaned file scans clean (${after.counts.critical}c/${after.counts.warning}w)`);
  const raw = Buffer.from(cleanedBytes).toString('latin1');
  ok(!raw.includes('891-23-4567') && !raw.includes('Jane Doe'),
    'no secret survives in the browser-cleaned bytes');
}

await p2.$$eval('.done button', (bs) => bs.find((b) => /Scan the cleaned file/.test(b.textContent)).click());
await p2.waitForSelector('.verdict.is-clean', { timeout: 60000 });
const verdictText = await p2.$eval('.verdict-body h2', (n) => n.textContent);
ok(/No hidden content found/.test(verdictText), `re-scanning in the page confirms it is clean ("${verdictText}")`);

await rm(DL, { recursive: true, force: true });

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
