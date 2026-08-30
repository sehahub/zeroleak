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

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
