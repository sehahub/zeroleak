// Does the cleaned page actually look like the page it replaced?
//
// Everywhere else the rasterizer is a stub that returns a one-pixel image, so a
// renderer that produced a blank sheet would pass every test in the suite while
// destroying the document. This drives the real site, takes the file it hands
// back, and compares the rendering of each page against the original.
import { createServer } from 'node:http';
import { readFile, stat, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png',
};

const POLICY = readFileSync('public/_headers', 'utf8')
  .split('\n').find((l) => l.trim().toLowerCase().startsWith('content-security-policy:'))
  .split(':').slice(1).join(':').trim();

const DL = resolve('.tmp-raster');
const ROOT = resolve('dist');

/** A page that renders two PDFs and reports how alike they are. */
const COMPARE = `<!doctype html><meta charset=utf-8><body>
<script type="module">
import * as pdfjs from '/node_modules/pdfjs-dist/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';

async function pixels(url, pageNumber) {
  const doc = await pdfjs.getDocument({ url, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
}

/** Fraction of pixels that are not background, and mean difference. */
function compare(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let inkA = 0, inkB = 0, diff = 0, count = 0;
  for (let i = 0; i < n; i += 4) {
    const la = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
    const lb = (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3;
    if (la < 240) inkA++;
    if (lb < 240) inkB++;
    diff += Math.abs(la - lb);
    count++;
  }
  return { inkA: inkA / count, inkB: inkB / count, meanDiff: diff / count / 255, sameSize: a.w === b.w && a.h === b.h };
}

window.run = async (pageNumber) => {
  const [before, after] = await Promise.all([
    pixels('/original.pdf', pageNumber),
    pixels('/cleaned.pdf', pageNumber),
  ]);
  return compare(before, after);
};
document.title = 'ready';
</script></body>`;

let cleanedBytes = null;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { res.writeHead(204); res.end(); return; }
  if (u.pathname === '/compare') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(COMPARE); return;
  }
  if (u.pathname === '/original.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(await readFile(resolve('test/fixtures/leaky.pdf'))); return;
  }
  if (u.pathname === '/cleaned.pdf') {
    if (!cleanedBytes) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(cleanedBytes); return;
  }
  const p = u.pathname.startsWith('/node_modules/')
    ? join(process.cwd(), decodeURIComponent(u.pathname).slice(1))
    : join(ROOT, decodeURIComponent(u.pathname));
  let file = p;
  if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
  // The site's own pages get the deployed policy; the comparison harness needs
  // to load pdf.js from node_modules, which that policy would forbid.
  if (!u.pathname.startsWith('/node_modules/')) headers['content-security-policy'] = POLICY;
  res.writeHead(200, headers);
  res.end(await readFile(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });

await rm(DL, { recursive: true, force: true });
await mkdir(DL, { recursive: true });

// Drive the real site so the real rasterizer runs.
const site = await browser.newPage();
const cdp = await site.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
await site.goto(base, { waitUntil: 'networkidle0' });
await (await site.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await site.waitForSelector('.cleaner', { timeout: 45000 });
await site.$$eval('.cleaner button', (bs) => bs.find((b) => /Clean and download/.test(b.textContent)).click());
await site.waitForSelector('.done', { timeout: 90000 });

let path = null;
for (let i = 0; i < 60 && !path; i++) {
  const found = (await readdir(DL)).filter((f) => f.endsWith('.pdf'));
  if (found.length) path = join(DL, found[0]);
  else await new Promise((r) => setTimeout(r, 250));
}
ok(path !== null, 'the site produced a cleaned file with its real rasterizer');
if (path) cleanedBytes = await readFile(path);
await site.close();

if (cleanedBytes) {
  ok(cleanedBytes.length > 20000,
    `the cleaned file carries a real picture, not a token one (${(cleanedBytes.length / 1024).toFixed(0)} KB)`);

  const page = await browser.newPage();
  await page.goto(base + '/compare', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.title === 'ready', { timeout: 30000 });
  const r = await page.evaluate(() => window.run(1));

  ok(r.sameSize, 'the cleaned page renders at the same size as the original');
  ok(r.inkA > 0.005, `the original page has ink to begin with (${(r.inkA * 100).toFixed(2)}%)`);
  ok(r.inkB > r.inkA * 0.6,
    `the cleaned page is not blank (${(r.inkB * 100).toFixed(2)}% ink against ${(r.inkA * 100).toFixed(2)}%)`);
  ok(r.meanDiff < 0.06,
    `and it looks like the page it replaced (mean difference ${(r.meanDiff * 100).toFixed(2)}%)`);
  await page.close();
}

await browser.close();
await rm(DL, { recursive: true, force: true });
server.close();
console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
