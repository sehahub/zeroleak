// The redaction is real on every page here; only the way it is drawn changes.
// Each case was a live false negative found by outside review, so each one is
// a document this tool would have called clean.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf, pagesWithHiddenText } from '../src/lib/analyze.ts';
import { cleanPdf } from '../src/lib/clean.ts';
import { stillRecoverable } from './deep-search.mjs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const bytes = new Uint8Array(readFileSync('test/fixtures/evasion.pdf'));
const report = await analyzePdf(bytes, pdfjs, { fileName: 'evasion.pdf' });

const said = (id) => report.findings.find((f) => f.id === id)?.evidence.map((e) => e.value).join(' | ') ?? '';
const hidden = said('hidden-text');
const invisible = said('invisible-text');
const offPage = said('off-page-text');
const everything = [hidden, invisible, offPage].join(' | ');

ok(hidden.includes('FORM-PLACED'), 'text placed by a form XObject matrix is measured where it lands');
ok(hidden.includes('STATE-LEAK'), 'a transparent fill left behind by a form does not excuse the box after it');
ok(hidden.includes('MASK-BAR'), 'a bar drawn as a stretched image mask counts as a cover');
ok(hidden.includes('EMPTY-PATH'), 'a paint operator with no path does not cost the rest of the page');
// Known limitation, held here on purpose. Reporting transparent-fill text was
// tried and withdrawn: design tools lay the same words over outlined headings
// that way, and two ordinary report covers produced 313 claims about text
// printed in plain sight. If someone finds a way to tell those apart, this
// assertion is where the case is waiting.
ok(!invisible.includes('ALPHA-ZERO'),
  'text painted with a transparent fill is not reported (known limitation, see the comment)');
ok(offPage.includes('CLIPPED-AWAY'), 'text clipped down to nothing is reported like text off the page');

// Controls: fixing the above must not be achieved by flagging everything.
ok(!everything.includes('plainly visible'),
  'a form whose bounding box clips its own fill is not treated as a cover');
ok(!everything.includes('Page 1 heading') && !everything.includes('Visible line'),
  'ordinary visible text on those pages stays unreported');

const onImage = report.findings.find((f) => f.id === 'covered-image');
ok(onImage && onImage.pages.includes(8),
  `a bar blacking out part of a scan is reported (${onImage ? 'pages ' + onImage.pages.join(', ') : 'not reported'})`);
ok(!onImage || !onImage.pages.includes(9),
  'a brand-coloured panel over a cover photograph is not');

ok(report.pagesFailed.length === 0,
  `every page was readable (${report.pagesFailed.join(', ') || 'none failed'})`);

// The secrets are the point: cleaning has to make all of them unrecoverable.
const pages = pagesWithHiddenText(report);
ok(pages.length >= 5, `every page the scanner reported is queued for cleaning (${pages.join(', ')})`);

const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const { bytes: cleaned } = await cleanPdf(bytes, {
  metadata: true, attachments: true, scripts: true, annotations: true,
  flattenPages: pages, rasterize: async () => ({ data: new Uint8Array(STUB_PNG), kind: 'png' }),
});

const markers = ['FORM-PLACED', 'STATE-LEAK', 'MASK-BAR', 'EMPTY-PATH', 'CLIPPED-AWAY'];
const survivors = [];
for (const m of markers) if (await stillRecoverable(cleaned, m)) survivors.push(m);
ok(survivors.length === 0,
  `nothing the scanner reported is recoverable from the cleaned file${survivors.length ? ': ' + survivors.join(', ') : ''}`);

// Stated rather than hidden: what the scanner does not report, the cleaner does
// not remove, and the transparent-fill page is the one case of that here.
ok(await stillRecoverable(cleaned, 'ALPHA-ZERO'),
  'the transparent-fill page is not cleaned either, because it is not reported');

const after = await analyzePdf(cleaned, pdfjs, { fileName: 'cleaned.pdf' });
ok(after.counts.critical === 0, `the cleaned file scans clean (${after.counts.critical} critical)`);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
