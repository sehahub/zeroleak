// End-to-end smoke test: serves dist/, drives a real browser, drops the leaky
// fixture into the page and checks the rendered report.
import { createServer } from 'node:http';
import { readFile, writeFile, stat, readdir, mkdir, rm } from 'node:fs/promises';
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
/** Everything the page posted to its own origin, as the server saw it. */
const received = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // Stand in for the Worker so the page behaves as it does in production,
    // and keep what it was sent so the tests can check it.
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received.push({ path: url.pathname, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204); res.end(); return;
    }
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

// ---- the paths where things go wrong ------------------------------------
// A report that ends without a way back leaves the reader stuck on a reload,
// and a second scan must not inherit anything from the first.
const BAD = resolve('.tmp-downloads');
await mkdir(BAD, { recursive: true });
await writeFile(join(BAD, 'notes.txt'), 'this is plainly not a PDF');
await writeFile(join(BAD, 'truncated.pdf'), (await readFile(resolve('test/fixtures/leaky.pdf'))).subarray(0, 400));

const p4 = await browser.newPage();
p4.on('pageerror', (e) => errors.push('errors: ' + String(e)));
await p4.goto(base, { waitUntil: 'networkidle0' });

await (await p4.$('#file')).uploadFile(join(BAD, 'notes.txt'));
await p4.waitForFunction(() => /not a PDF/.test(document.getElementById('status-text').textContent), { timeout: 20000 });
ok(await p4.$eval('#dz', (n) => !n.hidden), 'a non-PDF leaves the dropzone in place');

await (await p4.$('#file')).uploadFile(join(BAD, 'truncated.pdf'));
await p4.waitForFunction(() => /Could not read/.test(document.getElementById('status-text').textContent), { timeout: 45000 });
ok(await p4.$eval('#dz', (n) => !n.hidden), 'a corrupt PDF brings the dropzone back');

// Two documents in a row: the second report must be about the second file.
await (await p4.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await p4.waitForSelector('.finding', { timeout: 45000 });
await p4.$$eval('.verdict-actions button', (bs) => bs.find((b) => /Scan another file/.test(b.textContent)).click());
await p4.waitForFunction(() => !document.getElementById('dz').hidden, { timeout: 10000 });
await (await p4.$('#file')).uploadFile(resolve('test/fixtures/clean.pdf'));
await p4.waitForSelector('.verdict', { timeout: 45000 });
const second = await p4.$eval('#report', (n) => n.innerText);
ok(/No hidden content found/.test(second), 'a second scan reports on the second file');
ok(!/891-23-4567/.test(second), 'nothing from the first scan survives into the second');
const cleanerHead = await p4.$eval('.cleaner h3', (n) => n.textContent).catch(() => '');
ok(/Nothing is hidden/.test(cleanerHead),
  `a file with no leaks still offers to strip its metadata, without claiming something was found ("${cleanerHead}")`);
const cleanerOpts = await p4.$$eval('.cleaner .opt b', (bs) => bs.map((b) => b.textContent));
ok(cleanerOpts.length === 1 && /metadata/i.test(cleanerOpts[0]),
  `and offers only what applies (${JSON.stringify(cleanerOpts)})`);
await p4.close();

// ---- a document longer than the scan limit -------------------------------
// A partial scan that finds nothing must not read as a clean bill of health.
{
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const big = await PDFDocument.create();
  const f = await big.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 505; i++) {
    const pg = big.addPage([612, 792]);
    pg.drawText(`Page ${i} of the long report`, { x: 60, y: 720, size: 11, font: f });
    if (i === 1 || i === 502) {
      pg.drawText(`Withheld on page ${i}: reference 55-${i}`, { x: 60, y: 680, size: 11, font: f });
      pg.drawRectangle({ x: 56, y: 674, width: 280, height: 17, color: rgb(0, 0, 0) });
    }
  }
  const path = join(BAD, 'long.pdf');
  await writeFile(path, await big.save());

  const p5 = await browser.newPage();
  p5.on('pageerror', (e) => errors.push('long: ' + String(e)));
  await p5.goto(base, { waitUntil: 'networkidle0' });
  await (await p5.$('#file')).uploadFile(path);
  await p5.waitForSelector('.verdict', { timeout: 180000 });

  const notice = await p5.$eval('.truncated', (n) => n.textContent).catch(() => '');
  ok(/first 500 of 505 pages/.test(notice), `a truncated scan says so prominently ("${notice.slice(0, 90)}")`);
  const body = await p5.$eval('#report', (n) => n.innerText);
  ok(body.includes('reference 55-1'), 'the redaction inside the scanned range is still reported');
  ok(!body.includes('reference 55-502'), 'and the one beyond the limit is not claimed to be checked');
  await p5.close();
}

// ---- what leaves the browser during a scan -----------------------------
// The privacy claim is that a counter request carries a bare event name and
// nothing about the document. That is worth enforcing rather than asserting.
const p3 = await browser.newPage();
received.length = 0;
await p3.goto(base, { waitUntil: 'networkidle0' });
await (await p3.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await p3.waitForSelector('.finding', { timeout: 45000 });
await new Promise((r) => setTimeout(r, 600));

const events = received.filter((b) => b.path === '/api/event');
ok(events.length === 1 && events[0].body === JSON.stringify({ name: 'scan' }),
  `the scan tally carries only its name (${events.length} sent, body ${JSON.stringify(events[0]?.body ?? '')})`);

const all = received.map((b) => b.body).join(' ');
const forbidden = ['leaky', '891-23-4567', 'Jane Doe', 'settlement', 'severance', '.pdf'];
const leaked = forbidden.filter((f) => all.includes(f));
ok(leaked.length === 0, `nothing the page posted mentions the document${leaked.length ? ': ' + leaked.join(', ') : ''}`);
ok(received.every((b) => ['/api/hit', '/api/event'].includes(b.path)),
  `only the two counter endpoints are called (${[...new Set(received.map((b) => b.path))].join(', ')})`);
await p3.close();

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
