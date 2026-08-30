import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf, pagesWithHiddenText } from '../src/lib/analyze.ts';
import { cleanPdf } from '../src/lib/clean.ts';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

// A stand-in for canvas rendering; the browser test exercises the real one.
const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const stub = async () => ({ data: new Uint8Array(STUB_PNG), kind: 'png' });

async function allText(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    out += tc.items.map((i) => i.str ?? '').join(' ') + '\n';
  }
  return out;
}

const SECRETS = ['891-23-4567', 'settlement ceiling', 'Kim Min-jun', 'Jane Doe',
  'severance_master', 'launchURL', 'legal.reviewer', 'OFFPAGE'];

const original = new Uint8Array(readFileSync('test/fixtures/leaky.pdf'));
const before = await analyzePdf(original, pdfjs, { fileName: 'leaky.pdf' });
console.log(`before: ${before.counts.critical} critical, ${before.counts.warning} warning`);

const { bytes: cleaned, actions } = await cleanPdf(original, {
  metadata: true, attachments: true, scripts: true, annotations: true,
  flattenPages: pagesWithHiddenText(before), rasterize: stub,
});
console.log('actions:'); for (const a of actions) console.log('   -', a);

const after = await analyzePdf(cleaned, pdfjs, { fileName: 'cleaned.pdf' });
console.log(`after:  ${after.counts.critical} critical, ${after.counts.warning} warning, ` +
  `${after.counts.info} info  [${after.findings.map(f => f.id).join(', ') || 'nothing'}]`);

ok(after.counts.critical === 0, 'cleaned file has no critical findings');
ok(after.counts.warning === 0, 'cleaned file has no warnings');

// The real test: can the words be recovered by the same means an attacker uses?
const text = await allText(cleaned);
for (const s of ['891-23-4567', 'settlement ceiling', 'Kim Min-jun', 'OFFPAGE']) {
  ok(!text.includes(s), `text extraction cannot recover "${s}"`);
}

// And nothing may survive anywhere in the raw bytes either.
const raw = Buffer.from(cleaned).toString('latin1');
for (const s of SECRETS) ok(!raw.includes(s), `raw bytes no longer contain "${s}"`);

ok(cleaned.length > 0 && Buffer.from(cleaned.slice(0, 5)).toString() === '%PDF-', 'output is a PDF');

// The tricky document: only its one genuinely redacted page should flatten.
const tricky = new Uint8Array(readFileSync('test/fixtures/tricky.pdf'));
const tBefore = await analyzePdf(tricky, pdfjs, { fileName: 'tricky.pdf' });
const t = await cleanPdf(tricky, {
  metadata: true, attachments: true, scripts: true, annotations: true,
  flattenPages: pagesWithHiddenText(tBefore), rasterize: stub,
});
const tText = await allText(t.bytes);
ok(!tText.includes('8842-1109-3320'), 'tricky: the genuinely redacted account number is gone');

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
