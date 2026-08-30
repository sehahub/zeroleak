import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { scanOperatorList } from '../src/lib/scan-page.ts';

async function scan(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const ol = await page.getOperatorList();
    out.push(scanOperatorList(ol.fnArray, ol.argsArray, page.view, pdfjs.OPS));
  }
  return out;
}

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) fail++; };

const leaky = (await scan('test/fixtures/leaky.pdf'))[0];
console.log(JSON.stringify(leaky, (k, v) => (k === 'box' ? undefined : v), 2));
console.log('---');
ok(leaky.covered.some(c => c.text.includes('891-23-4567')), 'finds SSN hidden under a black box');
ok(leaky.covered.some(c => c.text.includes('performance improvement')), 'finds text under near-black box');
ok(leaky.invisible.some(t => t.includes('settlement ceiling')), 'finds invisible (Tr 3) text');
ok(leaky.offPage.some(t => t.includes('OFFPAGE')), 'finds text drawn outside the page');
ok(!leaky.covered.some(c => c.text.includes('Approved by')), 'does not flag ordinary visible text');
ok(!leaky.covered.some(c => c.text.includes('SEVERANCE SUMMARY')), 'does not flag the heading');

const clean = (await scan('test/fixtures/clean.pdf'))[0];
ok(clean.covered.length === 0 && clean.invisible.length === 0 && clean.offPage.length === 0, 'clean control document is silent');

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
