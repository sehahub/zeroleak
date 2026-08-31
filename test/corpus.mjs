// Fetches a small, diverse set of public PDFs and runs the analyzer over them.
// The point is robustness: these come from producers the fixtures never
// exercise (LaTeX, Word, InDesign, government publishing systems, scanners),
// so anything the scanner claims about them is a claim about the real world.
//
//   node --experimental-strip-types test/corpus.mjs fetch
//   node --experimental-strip-types test/corpus.mjs scan
import { writeFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf } from '../src/lib/analyze.ts';

const DIR = 'test/corpus';

const SOURCES = [
  // LaTeX / pdfTeX
  ['arxiv-attention.pdf', 'https://arxiv.org/pdf/1706.03762v7'],
  ['arxiv-resnet.pdf', 'https://arxiv.org/pdf/1512.03385v1'],
  ['arxiv-bert.pdf', 'https://arxiv.org/pdf/1810.04805v2'],
  // Standards bodies
  ['rfc9110.pdf', 'https://www.rfc-editor.org/rfc/rfc9110.pdf'],
  ['rfc8446.pdf', 'https://www.rfc-editor.org/rfc/rfc8446.pdf'],
  ['rfc2119.pdf', 'https://www.rfc-editor.org/rfc/rfc2119.pdf'],
  // US federal publishing
  ['gao-report.pdf', 'https://www.gao.gov/assets/gao-24-106223.pdf'],
  ['cisa-advisory.pdf', 'https://www.cisa.gov/sites/default/files/2023-06/aa23-158a_stopransomware_cl0p_ransomware_gang_exploits_moveit_vulnerability.pdf'],
  ['nist-csf.pdf', 'https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf'],
  ['gpo-constitution.pdf', 'https://www.govinfo.gov/content/pkg/CDOC-110hdoc50/pdf/CDOC-110hdoc50.pdf'],
  // Courts and legal
  ['supremecourt-opinion.pdf', 'https://www.supremecourt.gov/opinions/23pdf/23-175_dbfi.pdf'],
  ['uscourts-form.pdf', 'https://www.uscourts.gov/sites/default/files/ao120.pdf'],
  // International institutions
  ['un-sdg.pdf', 'https://unstats.un.org/sdgs/report/2023/The-Sustainable-Development-Goals-Report-2023.pdf'],
  ['who-report.pdf', 'https://iris.who.int/bitstream/handle/10665/376869/9789240094703-eng.pdf'],
  ['ecb-report.pdf', 'https://www.ecb.europa.eu/pub/pdf/annrep/ecb.ar2022~8ada2fa0dd.en.pdf'],
  // Corporate / InDesign-style production
  ['sec-filing.pdf', 'https://www.sec.gov/files/form10-k.pdf'],
  ['irs-form1040.pdf', 'https://www.irs.gov/pub/irs-pdf/f1040.pdf'],
  ['irs-pub17.pdf', 'https://www.irs.gov/pub/irs-pdf/p17.pdf'],
  // Non-Latin scripts: the glyph-to-unicode mapping and the advance widths
  // behave differently for CID-keyed fonts, and nothing else here exercises that.
  ['irs-korean.pdf', 'https://www.irs.gov/pub/irs-pdf/p1ko.pdf'],
  ['irs-chinese.pdf', 'https://www.irs.gov/pub/irs-pdf/p1zhs.pdf'],
  ['irs-spanish.pdf', 'https://www.irs.gov/pub/irs-pdf/p17sp.pdf'],
  // PDF specification and conformance material
  ['pdf-association-sample.pdf', 'https://pdfa.org/wp-content/uploads/2019/09/PDF20ExamplesSummary.pdf'],
  ['adobe-pdf17-extension.pdf', 'https://www.adobe.com/content/dam/acom/en/devnet/pdf/pdfs/adobe_supplement_iso32000.pdf'],
];

const UA = 'ZeroLeakResearch/0.1 (PDF hygiene research; contact via zeroleak.sehahub.info)';

async function fetchAll() {
  await mkdir(DIR, { recursive: true });
  const have = new Set(await readdir(DIR).catch(() => []));
  for (const [name, url] of SOURCES) {
    if (have.has(name)) { console.log('have  ', name); continue; }
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/pdf' }, redirect: 'follow' });
      if (!res.ok) { console.log(`skip   ${name} (HTTP ${res.status})`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 1000 || String.fromCharCode(...buf.slice(0, 5)) !== '%PDF-') {
        console.log(`skip   ${name} (not a PDF)`); continue;
      }
      await writeFile(join(DIR, name), buf);
      console.log(`saved  ${name}  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      console.log(`skip   ${name} (${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // be a polite guest
  }
}

async function scanAll() {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.pdf')).sort();
  const rows = [];
  const flags = [];

  for (const f of files) {
    const path = join(DIR, f);
    const bytes = new Uint8Array(await readFile(path));
    const size = (await stat(path)).size;
    try {
      const r = await analyzePdf(bytes, pdfjs, { fileName: f, pageLimit: 40 });
      const ids = r.findings.map((x) => x.id);
      rows.push({ f, pages: r.pages, mb: (size / 1048576).toFixed(1), ms: r.ms, ids });

      // Any claim of hidden text in a published document is either a real
      // finding or a bug, and both are worth looking at by hand.
      for (const id of ['hidden-text', 'invisible-text', 'off-page-text']) {
        const finding = r.findings.find((x) => x.id === id);
        if (finding) {
          flags.push({ f, id, n: finding.evidence.length + (finding.truncated ?? 0), sample: finding.evidence.slice(0, 3) });
        }
      }
    } catch (e) {
      rows.push({ f, pages: 0, mb: (size / 1048576).toFixed(1), ms: 0, ids: ['ERROR: ' + e.message] });
    }
  }

  console.log('\n=== corpus scan ===');
  for (const r of rows) {
    console.log(`${r.f.padEnd(34)} ${String(r.pages).padStart(4)}p ${r.mb.padStart(5)}MB ${String(r.ms).padStart(6)}ms  ${r.ids.join(' ') || '(clean)'}`);
  }

  console.log('\n=== claims that need a human look ===');
  if (!flags.length) console.log('none');
  for (const fl of flags) {
    console.log(`\n${fl.f}  [${fl.id}]  ${fl.n} item(s)`);
    for (const e of fl.sample) console.log(`   p.${e.page ?? '?'} ${e.label ? e.label + ' ' : ''}${JSON.stringify(e.value.slice(0, 100))}`);
  }

  const errors = rows.filter((r) => r.ids.some((i) => i.startsWith('ERROR')));
  console.log(`\n${rows.length} files, ${errors.length} failed to parse`);
}

/** Takes a real Korean document, paints a black box over a line of its text the
 *  way a person would, and checks the scanner gets the Korean back. Extraction
 *  working is only half the question; catching a redaction is the other half.
 *  Kept here rather than in the unit suite because it needs the fetched corpus,
 *  and the font belongs to the source document rather than to this repository. */
async function cjkRedaction() {
  const { PDFDocument, rgb } = await import('pdf-lib');
  for (const [name, label] of [['irs-korean.pdf', 'Korean'], ['irs-chinese.pdf', 'Chinese']]) {
    const path = join(DIR, name);
    if (!existsSync(path)) { console.log(`${label}: ${name} not fetched, skipping`); continue; }
    const original = new Uint8Array(await readFile(path));

    // Find a line of text on page 1 and note where it sits.
    const doc = await pdfjs.getDocument({ data: new Uint8Array(original), verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const items = (await page.getTextContent()).items.filter((i) => (i.str ?? '').trim().length > 6);
    const target = items[Math.floor(items.length / 2)];
    const [x, y] = [target.transform[4], target.transform[5]];

    // Paint over it, exactly as somebody would with a drawing tool.
    const lib = await PDFDocument.load(original, { updateMetadata: false });
    lib.getPage(0).drawRectangle({
      x: x - 2, y: y - target.height * 0.25,
      width: target.width + 4, height: target.height * 1.35,
      color: rgb(0, 0, 0),
    });
    const covered = new Uint8Array(await lib.save());
    await writeFile(join(DIR, `redacted-${name}`), covered);

    const r = await analyzePdf(covered, pdfjs, { fileName: name });
    const hidden = r.findings.find((f) => f.id === 'hidden-text');
    const recovered = hidden ? hidden.evidence.map((e) => e.value).join(' ') : '';
    const wanted = target.str.trim();
    const found = recovered.includes(wanted.slice(0, Math.min(8, wanted.length)));
    console.log(`${label.padEnd(8)} covered ${JSON.stringify(wanted.slice(0, 24))}`);
    console.log(`         -> ${found ? 'RECOVERED' : 'MISSED'}  ${hidden ? hidden.evidence.length + ' run(s)' : 'no hidden-text finding'}`);
    if (hidden) console.log(`         -> ${JSON.stringify(recovered.slice(0, 60))}`);
  }
}

const cmd = process.argv[2] ?? 'scan';
if (cmd === 'fetch') await fetchAll();
else if (cmd === 'cjk') await cjkRedaction();
else await scanAll();
