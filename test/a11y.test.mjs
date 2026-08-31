// Runs axe against every page, and against the report and cleaner as they
// appear after a real scan — the parts a visitor spends the most time in are
// the parts built by script, which a static crawl never sees.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.xml':'application/xml','.png':'image/png' };
// The policy the deployed site sends, read from the file that deploys it.
// A violation then shows up here rather than in production.
const POLICY = readFileSync('public/_headers', 'utf8')
  .split('\n').find((l) => l.trim().toLowerCase().startsWith('content-security-policy:'))
  .split(':').slice(1).join(':').trim();

const ROOT = resolve('dist');
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { res.writeHead(204); res.end(); return; }
  let p = join(ROOT, decodeURIComponent(u.pathname));
  if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p) && existsSync(p + '.html')) p = p + '.html';
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
      'content-type': MIME[extname(p)] ?? 'application/octet-stream',
      'content-security-policy': POLICY,
    });
  res.end(await readFile(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const AXE = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

async function audit(page, label) {
  await page.evaluate(AXE);
  const results = await page.evaluate(async () => await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  }));
  const violations = results.violations.filter((v) => v.impact !== 'minor');
  ok(violations.length === 0, `${label}: ${violations.length} violation(s)`);
  for (const v of violations) {
    console.log(`        [${v.impact}] ${v.id} — ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) console.log(`          ${n.html.slice(0, 100)}`);
  }
  return violations;
}

for (const path of ['/', '/guides/', '/guides/redact-a-pdf-properly/', '/research/government-pdfs/']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + path, { waitUntil: 'networkidle0' });
  await audit(page, path);
  await page.close();
}

// The report and cleaner only exist after a scan.
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(base, { waitUntil: 'networkidle0' });
await (await page.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await page.waitForSelector('.cleaner', { timeout: 45000 });
await audit(page, 'the report and cleaner after a scan');
await page.close();

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
