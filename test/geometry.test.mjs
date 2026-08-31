// Pages whose geometry is not the simple case. The cleaner replaces a page with
// a picture of itself, so it has to put that picture exactly where the visible
// area was — otherwise a cleaned document comes back shifted or sideways, which
// is worse than not cleaning it at all.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf, pagesWithHiddenText } from '../src/lib/analyze.ts';
import { cleanPdf } from '../src/lib/clean.ts';
import { stillRecoverable } from './deep-search.mjs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const stub = async () => ({ data: new Uint8Array(STUB_PNG), kind: 'png' });

const original = new Uint8Array(readFileSync('test/fixtures/geometry.pdf'));
const before = await analyzePdf(original, pdfjs, { fileName: 'geometry.pdf' });
const hidden = before.findings.find((f) => f.id === 'hidden-text');

ok(!!hidden, 'hidden text is found at all');
ok(hidden?.evidence.some((e) => e.page === 1 && e.value.includes('77-2214')),
  'a redaction on a rotated page is found');
ok(hidden?.evidence.some((e) => e.page === 2 && e.value.includes('412,500')),
  'a redaction on a cropped page is found');
ok(!hidden?.evidence.some((e) => e.value.includes('must stay readable')),
  'visible text on those pages is not mistaken for hidden text');

const { bytes: cleaned } = await cleanPdf(original, {
  metadata: true, attachments: true, scripts: true, annotations: true,
  flattenPages: pagesWithHiddenText(before), rasterize: stub,
});

/** Where the replacement picture actually lands, read back off the page. */
async function placement(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const ol = await page.getOperatorList();
  let m = [1, 0, 0, 1, 0, 0];
  let found = null;
  let text = 0;
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    if (fn === pdfjs.OPS.transform) {
      const a = ol.argsArray[i];
      m = [
        a[0] * m[0] + a[1] * m[2], a[0] * m[1] + a[1] * m[3],
        a[2] * m[0] + a[3] * m[2], a[2] * m[1] + a[3] * m[3],
        a[4] * m[0] + a[5] * m[2] + m[4], a[4] * m[1] + a[5] * m[3] + m[5],
      ];
    } else if (fn === pdfjs.OPS.paintImageXObject) {
      found = { x: m[4], y: m[5], w: m[0], h: m[3] };
    } else if (fn === pdfjs.OPS.showText) {
      text++;
    }
  }
  return { image: found, textRuns: text, view: page.view, rotate: page.rotate };
}

const doc = await pdfjs.getDocument({ data: new Uint8Array(cleaned), verbosity: 0 }).promise;
const near = (a, b) => Math.abs(a - b) < 0.5;

const p1 = await placement(doc, 1);
ok(p1.rotate === 90, `the rotated page keeps its rotation (got ${p1.rotate})`);
ok(p1.image && near(p1.image.x, 0) && near(p1.image.y, 0)
  && near(p1.image.w, 612) && near(p1.image.h, 792),
  `the picture covers the rotated page exactly (${JSON.stringify(p1.image)})`);
ok(p1.textRuns === 0, 'no text object survives on the rotated page');

const p2 = await placement(doc, 2);
ok(p2.image && near(p2.image.x, 100) && near(p2.image.y, 500)
  && near(p2.image.w, 400) && near(p2.image.h, 200),
  `the picture covers the crop box, not the whole sheet (${JSON.stringify(p2.image)})`);
ok(near(p2.view[0], 100) && near(p2.view[2], 500), 'the crop box itself is left alone');
ok(p2.textRuns === 0, 'no text object survives on the cropped page');

const after = await analyzePdf(cleaned, pdfjs, { fileName: 'cleaned.pdf' });
ok(after.counts.critical === 0 && after.counts.warning === 0,
  `the cleaned file scans clean (${after.counts.critical}c/${after.counts.warning}w)`);

ok(!(await stillRecoverable(cleaned, '77-2214')) && !(await stillRecoverable(cleaned, '412,500')),
  'neither redacted value can be recovered from the cleaned file');

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
