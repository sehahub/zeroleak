// Renders the social preview card. Built as a page and screenshotted so the
// card uses the same type and colours as the site rather than drifting from it.
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const card = `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: x; src: local("Segoe UI"); }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    justify-content: space-between; padding: 68px 72px;
    background: #fbfaf8; color: #14161a;
    font-family: "Segoe UI", -apple-system, Inter, Arial, sans-serif;
  }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 27px; font-weight: 650; letter-spacing: -0.02em; }
  .dot { width: 20px; height: 20px; border-radius: 5px; background: #c0261c; box-shadow: 0 0 0 7px rgba(192,38,28,0.14); }
  h1 { font-size: 74px; line-height: 1.04; letter-spacing: -0.035em; font-weight: 680; max-width: 17ch; }
  .sub { margin-top: 26px; font-size: 27px; color: #5d636e; max-width: 40ch; line-height: 1.45; }
  .demo {
    margin: 40px 0 34px; background: #fff; border: 1px solid #e2e1dd; border-radius: 14px;
    padding: 22px 26px; font-family: Consolas, "SF Mono", monospace; font-size: 22px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .demo .lbl { font-size: 15px; letter-spacing: 0.07em; text-transform: uppercase; color: #8a9098; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 18px; margin-top: 14px; }
  .bar { width: 250px; height: 30px; background: #14161a; border-radius: 3px; flex: none; }
  .arrow { color: #c0261c; font-size: 20px; flex: none; }
  .out { color: #14161a; }
  .foot { display: flex; justify-content: space-between; align-items: baseline; font-size: 23px; color: #5d636e; }
  .foot b { color: #14161a; font-weight: 600; }
</style>
<div>
  <div class="brand"><span class="dot"></span>ZeroLeak</div>
  <h1>See what your PDF is still carrying.</h1>
  <p class="sub">Text under redaction boxes, earlier drafts, metadata — found and removed in your browser.</p>
  <div class="demo">
    <div class="lbl">Recovered from under the box</div>
    <div class="row">
      <span class="bar"></span>
      <span class="arrow">&rarr;</span>
      <span class="out">Payout: $184,000&nbsp;&nbsp;SSN: 891-23-4567</span>
    </div>
  </div>
</div>
<div class="foot"><span><b>No upload.</b> No account. Works offline.</span><span>zeroleak.sehahub.info</span></div>`;

const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(card, { waitUntil: 'load' });
await mkdir(resolve('public'), { recursive: true });
const png = await page.screenshot({ type: 'png' });
await writeFile(resolve('public/og.png'), png);
await browser.close();
console.log(`wrote public/og.png (${(png.length / 1024).toFixed(0)} KB)`);
