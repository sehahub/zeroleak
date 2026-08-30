import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.map':'application/json' };
const ROOT = resolve('dist');
const server = createServer(async (req,res)=>{ let p=join(ROOT, decodeURIComponent(new URL(req.url,'http://x').pathname));
  if((await stat(p).catch(()=>null))?.isDirectory()) p=join(p,'index.html');
  if(!existsSync(p)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':MIME[extname(p)]??'application/octet-stream'}); res.end(await readFile(p)); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args:['--no-sandbox'] });
const out = process.argv[2] || 'shots';
for (const scheme of ['light','dark']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value: scheme }]);
  await page.goto(base, { waitUntil:'networkidle0' });
  await page.screenshot({ path: `${out}/hero-${scheme}.png` });
  await (await page.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
  await page.waitForSelector('.finding', { timeout: 45000 });
  await new Promise(r=>setTimeout(r,600));
  await page.evaluate(()=>document.getElementById('report').scrollIntoView());
  await page.screenshot({ path: `${out}/report-${scheme}.png` });
  await page.close();
}
await browser.close(); server.close();
console.log('shots written');
