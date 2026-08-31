import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf, pagesWithHiddenText } from '../src/lib/analyze.ts';
import { cleanPdf } from '../src/lib/clean.ts';
import { stillRecoverable } from './deep-search.mjs';

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

// And nothing may be recoverable from the file by any means. Searching the
// raw bytes proves nothing on its own: the output is saved with object
// streams, so every string in it is Flate-compressed and a cleaner that did
// nothing at all would pass. This inflates every stream first.
for (const s of SECRETS) {
  ok(!(await stillRecoverable(cleaned, s)), `"${s}" cannot be recovered from the cleaned file`);
}

// The check has to be able to fail, so prove it on a cleaner that only re-saves.
const untouched = (await cleanPdf(original, {})).bytes;
const caught = [];
for (const s of SECRETS) if (await stillRecoverable(untouched, s)) caught.push(s);
ok(caught.length >= 4,
  `the recovery check catches a cleaner that does nothing (${caught.length}/${SECRETS.length} secrets found)`);

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
ok(!(await stillRecoverable(t.bytes, '8842-1109-3320')),
  'tricky: and it is not recoverable from the object graph either');

// More hidden lines than the report will show. The evidence list is shortened
// for display, and driving the cleaner from the shortened list left every page
// past the cut-off untouched under a report that said the file was done.
{
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const many = await PDFDocument.create();
  const font = await many.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 30; i++) {
    const page = many.addPage([612, 792]);
    page.drawText(`BEYOND-THE-CUT-${i}`, { x: 60, y: 700, size: 12, font });
    page.drawRectangle({ x: 56, y: 694, width: 200, height: 18, color: rgb(0, 0, 0) });
  }
  const bytes = new Uint8Array(await many.save());
  const found = await analyzePdf(bytes, pdfjs, { fileName: 'many.pdf' });
  const hidden = found.findings.find((f) => f.id === 'hidden-text');

  ok((hidden?.truncated ?? 0) > 0, `the report shortens the evidence list (${hidden?.evidence.length} shown, ${hidden?.truncated} more)`);
  ok(hidden.pages.length === 30, `but the finding still knows all ${hidden.pages.length} pages`);

  const { bytes: out } = await cleanPdf(bytes, {
    flattenPages: pagesWithHiddenText(found), rasterize: stub,
  });
  const missed = [];
  for (let i = 1; i <= 30; i++) if (await stillRecoverable(out, `BEYOND-THE-CUT-${i}`)) missed.push(i);
  ok(missed.length === 0, `every page is cleaned, not just the shown ones${missed.length ? ' — missed ' + missed.join(', ') : ''}`);
}

// Asked to flatten pages with no way to render them, the cleaner used to return
// a file it had not cleaned, to a caller with no way to tell.
{
  let refused = false;
  try {
    await cleanPdf(original, { flattenPages: [1] });
  } catch {
    refused = true;
  }
  ok(refused, 'flattening without a rasterizer is refused rather than skipped');
}

// Scripts attached to an annotation are still scripts. The annotation stays;
// only the code on it goes, and an ordinary link keeps working.
{
  const { PDFDocument, StandardFonts, PDFName, PDFString } = await import('pdf-lib');
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const ctx = d.context;
  const page = d.addPage([612, 792]);
  page.drawText('a scripted link and a plain one', { x: 60, y: 700, size: 12, font });
  const scripted = ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: ctx.obj([60, 690, 300, 715]),
    A: ctx.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of('app.launchURL("https://ANNOTJSSECRET.example/")') }),
  });
  const plain = ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: ctx.obj([60, 650, 300, 675]),
    A: ctx.obj({ S: PDFName.of('URI'), URI: PDFString.of('https://ORDINARYLINK.example/') }),
  });
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Btn'), T: PDFString.of('b1'),
    Rect: ctx.obj([320, 690, 420, 715]),
    AA: ctx.obj({ U: ctx.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of('app.alert("WIDGETJSSECRET")') }) }),
  });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(scripted), ctx.register(plain), ctx.register(widget)]));

  const { bytes: out } = await cleanPdf(new Uint8Array(await d.save()), { scripts: true, annotations: false });
  ok(!(await stillRecoverable(out, 'ANNOTJSSECRET')), 'a script on a link annotation is removed');
  ok(!(await stillRecoverable(out, 'WIDGETJSSECRET')), 'a script on a form widget is removed');
  ok(await stillRecoverable(out, 'ORDINARYLINK'), 'an ordinary link is left alone');
}

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
