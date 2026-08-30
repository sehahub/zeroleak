import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf } from '../src/lib/analyze.ts';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const leaky = await analyzePdf(new Uint8Array(readFileSync('test/fixtures/leaky.pdf')), pdfjs, { fileName: 'leaky.pdf' });
console.log(`${leaky.fileName}  ${leaky.pages}p  ${leaky.ms}ms  ` +
  `critical=${leaky.counts.critical} warning=${leaky.counts.warning} info=${leaky.counts.info}`);
for (const f of leaky.findings) {
  console.log(`\n[${f.severity}] ${f.id} — ${f.title}`);
  for (const e of f.evidence.slice(0, 3)) console.log(`      ${e.label ? e.label + ': ' : ''}${e.value.slice(0, 88)}`);
}
console.log('\n---');
const ids = leaky.findings.map(f => f.id);
for (const id of ['hidden-text', 'invisible-text', 'off-page-text', 'attachments', 'javascript', 'metadata-identity', 'annotations'])
  ok(ids.includes(id), `detects ${id}`);

const clean = await analyzePdf(new Uint8Array(readFileSync('test/fixtures/clean.pdf')), pdfjs, { fileName: 'clean.pdf' });
console.log('clean findings:', clean.findings.map(f => `${f.severity}:${f.id}`).join(', ') || '(none)');
ok(clean.counts.critical === 0, 'clean document raises no critical finding');

// Invisible text on a page that is mostly a picture is OCR, not a hidden note.
const trickyReport = await analyzePdf(new Uint8Array(readFileSync('test/fixtures/tricky.pdf')), pdfjs, { fileName: 'tricky.pdf' });
const trickyIds = trickyReport.findings.map(f => f.id);
ok(trickyIds.includes('ocr-layer'), 'invisible text over a large image is reported as an OCR layer');
ok(!trickyIds.includes('invisible-text'), 'and is not reported as hidden text');
ok(trickyReport.findings.find(f => f.id === 'ocr-layer').severity === 'info', 'an OCR layer is informational, not critical');
ok(leaky.findings.find(f => f.id === 'invisible-text'), 'invisible text on a page with no image is still critical');

// Linearized files carry two end-of-file markers without ever being edited.
const { countRevisions, isLinearized } = await import('../src/lib/analyze.ts');
const bytes = (t) => new TextEncoder().encode(t);
const EOF = '%%EOF';
ok(countRevisions(bytes('%PDF-1.7 body ' + EOF)) === 1, 'a plain file counts as one revision');
ok(countRevisions(bytes('%PDF-1.7 body ' + EOF + ' more ' + EOF)) === 2, 'two markers without linearization means an incremental update');
ok(isLinearized(bytes('%PDF-1.7 1 0 obj << /Linearized 1 >> endobj')), 'linearization is detected from the header');
ok(countRevisions(bytes('%PDF-1.7 << /Linearized 1 >> body ' + EOF + ' rest ' + EOF)) === 1,
  'a linearized file with two markers is not reported as edited');
ok(countRevisions(bytes('%PDF-1.7 << /Linearized 1 >> body ' + EOF + ' rest ' + EOF + ' update ' + EOF)) === 2,
  'a linearized file that was then edited still counts the extra revision');

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
