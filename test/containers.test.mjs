// Flattening a page destroys its text objects. That is only a guarantee if the
// same words are not sitting in one of the other places a PDF keeps them.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf, pagesWithHiddenText } from '../src/lib/analyze.ts';
import { cleanPdf } from '../src/lib/clean.ts';
import { recoverableText } from './deep-search.mjs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const stub = async () => ({ data: new Uint8Array(STUB_PNG), kind: 'png' });

const original = new Uint8Array(readFileSync('test/fixtures/containers.pdf'));
const before = await analyzePdf(original, pdfjs, { fileName: 'containers.pdf' });

const { bytes: cleaned, actions } = await cleanPdf(original, {
  metadata: true, attachments: true, scripts: true, annotations: true,
  flattenPages: pagesWithHiddenText(before), rasterize: stub,
});
const deep = await recoverableText(cleaned);

const CASES = [
  ['COVERED 891-23-4567', 'the text under the box'],
  ['ACTUALTEXT 999-88-7777', 'the accessibility tree copy, which rasterising does not touch'],
  ['ALT Alice Root', 'the alternate description'],
  ['PAGEXMP Bob Secret', 'the page-level XMP packet'],
  ['PIECEINFO original draft', 'private application data, where editors stash the original'],
  ['THUMBDATA 555-00-1234', 'the cached thumbnail of the page as it was'],
  ['OCGNAME internal only', 'the name of a switched-off layer'],
];

for (const [needle, what] of CASES) {
  ok(!deep.includes(needle), `${what} is gone`);
}

ok(actions.length > 0, `the cleaner reported what it did (${actions.length} actions)`);

// Removing the layer names must not turn a hidden layer back on: dropping
// /OCProperties outright would reveal exactly the content it was hiding.
const stillHasOc = deep.includes('OCProperties') || deep.includes('/OCG');
ok(stillHasOc, 'the optional content configuration itself is left in place');

// Someone who unticks the destructive option still gets the metadata work, and
// a thumbnail is a picture of the page as it was.
{
  const metadataOnly = await cleanPdf(original, { metadata: true });
  const shallow = await recoverableText(metadataOnly.bytes);
  ok(!shallow.includes('THUMBDATA 555-00-1234'),
    'the thumbnail goes even when no page is flattened');
  ok(!shallow.includes('PAGEXMP Bob Secret'),
    'so does the page-level XMP packet');
  ok(shallow.includes('COVERED 891-23-4567'),
    'and the hidden text is left alone, because that option was not chosen');
}

const after = await analyzePdf(cleaned, pdfjs, { fileName: 'cleaned.pdf' });
ok(after.counts.critical === 0, `the cleaned file scans clean (${after.counts.critical} critical)`);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
