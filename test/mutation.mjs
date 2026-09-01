// Breaks one guarantee at a time and checks that the suite notices.
//
// Every serious bug in this project so far was found the same way: assume the
// checks are lying and prove it. An outside review gutted the cleaner to a
// no-op and watched the tests pass 8/8. This automates that move — if a
// behaviour can be removed and the suite still goes green, the suite is not
// testing that behaviour, whatever its assertion names say.
//
//   node test/mutation.mjs          run them all
//   node test/mutation.mjs <n>      run one, and leave it applied for a look
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/** Each mutation removes one thing the product claims to do. */
const MUTATIONS = [
  {
    name: 'cleaner stops removing embedded files',
    file: 'src/lib/clean.ts',
    find: '  if (opts.attachments) {',
    into: '  if (false && opts.attachments) {',
  },
  {
    name: 'cleaner stops clearing metadata',
    file: 'src/lib/clean.ts',
    find: '  if (opts.metadata) {',
    into: '  if (false && opts.metadata) {',
  },
  {
    name: 'cleaner stops removing scripts',
    file: 'src/lib/clean.ts',
    find: '  if (opts.scripts) {',
    into: '  if (false && opts.scripts) {',
  },
  {
    name: 'cleaner stops removing annotations',
    file: 'src/lib/clean.ts',
    find: '  if (opts.annotations) {',
    into: '  if (false && opts.annotations) {',
  },
  {
    name: 'cleaner stops flattening pages with hidden text',
    file: 'src/lib/clean.ts',
    find: '  if (flatten.length && opts.rasterize) {',
    into: '  if (false && flatten.length && opts.rasterize) {',
  },
  {
    name: 'cleaner keeps objects nothing references any more',
    file: 'src/lib/clean.ts',
    find: '  const dropped = collectGarbage(ctx, [ctx.trailerInfo.Root as PDFRef, ctx.trailerInfo.Info as PDFRef]);',
    into: '  const dropped = 0;',
  },
  {
    name: 'the /AF short-circuit comes back',
    file: 'src/lib/clean.ts',
    find: '      deleteFrom(names, \'EmbeddedFiles\'),\n      deleteFrom(catalog, \'AF\'),',
    into: '      deleteFrom(names, \'EmbeddedFiles\') || deleteFrom(catalog, \'AF\'),',
  },
  {
    name: 'cleaning is driven by the shortened evidence list again',
    file: 'src/lib/analyze.ts',
    find: '    for (const p of f.pages) pages.add(p);',
    into: '    for (const e of f.evidence) if (e.page != null) pages.add(e.page);',
  },
  {
    name: 'paint order is ignored, so anything near a shape counts as covered',
    file: 'src/lib/scan-page.ts',
    find: '  const over = covers.filter((c) => c.order > run.order && unionCoverage(run.box, [c.box]) > 0.02);',
    into: '  const over = covers.filter((c) => unionCoverage(run.box, [c.box]) > 0.02);',
  },
  {
    name: 'clipping is ignored when sizing a cover',
    file: 'src/lib/scan-page.ts',
    find: '          const box = intersect(transformBox(s.ctm, r), s.clip);',
    into: '          const box = transformBox(s.ctm, r);',
  },
  {
    name: 'a form XObject is placed at the page origin',
    file: 'src/lib/scan-page.ts',
    find: '        if (args[0]) s.ctm = mul(toMatrix(args[0]), s.ctm);',
    into: '        if (false && args[0]) s.ctm = mul(toMatrix(args[0]), s.ctm);',
  },
  {
    name: 'image masks stop counting as covers',
    file: 'src/lib/scan-page.ts',
    find: '      case OPS.paintImageMaskXObject:\n      case OPS.paintSolidColorImageMask:',
    into: '      case -101:\n      case -102:',
  },
  {
    name: 'vertical writing is measured as though it ran to the right',
    file: 'src/lib/scan-page.ts',
    find: '    const vertical = Array.isArray(first?.vmetric);',
    into: '    const vertical = false && Array.isArray(first?.vmetric);',
  },
  {
    name: 'text clipped down to nothing is treated as visible',
    file: 'src/lib/scan-page.ts',
    find: '    if (clippedAway(r)) {',
    into: '    if (false && clippedAway(r)) {',
  },
  {
    name: 'a page that fails to scan is silently skipped again',
    file: 'src/lib/analyze.ts',
    find: '      pagesFailed.push(p);',
    into: '      void p;',
  },
  {
    name: 'linearized files are accused of hiding earlier revisions',
    file: 'src/lib/analyze.ts',
    find: '  return isLinearized(bytes) ? Math.max(1, markers - 1) : markers;',
    into: '  return markers;',
  },
  {
    name: 'the XMP packet stops being read',
    file: 'src/lib/xmp.ts',
    find: 'export function parseXmp(raw: string, maxValue = 200): XmpField[] {',
    into: 'export function parseXmp(raw: string, maxValue = 200): XmpField[] {\n  if (raw) return [];',
  },
  {
    name: 'a page-level XMP packet is left behind',
    file: 'src/lib/clean.ts',
    find: "      hadXmp = deleteFrom(page.node, 'Metadata') || hadXmp;",
    into: '      hadXmp = hadXmp;',
  },
  {
    name: 'private application data is left behind',
    file: 'src/lib/clean.ts',
    find: "      deleteFrom(page.node, 'PieceInfo');",
    into: '      void page;',
  },
  {
    name: 'the cached thumbnail of the original page is kept',
    file: 'src/lib/clean.ts',
    find: "      // A cached rendering of the page as it was before any of this.\n      deleteFrom(page.node, 'Thumb');",
    into: '      void page;',
  },
  {
    name: 'layer names are kept',
    file: 'src/lib/clean.ts',
    find: "        if (group?.has(n('Name'))) group.set(n('Name'), PDFString.of('Layer'));",
    into: '        void group;',
  },
  {
    name: 'flattening leaves the structure tree, which holds the same words',
    file: 'src/lib/clean.ts',
    find: "    const hadStructure = deleteFrom(catalog, 'StructTreeRoot');",
    into: '    const hadStructure = false;',
  },
  {
    name: 'removing layer names turns the hidden layers back on',
    file: 'src/lib/clean.ts',
    find: "    const oc = catalog.lookupMaybe(n('OCProperties'), PDFDict);",
    into: "    deleteFrom(catalog, 'OCProperties');\n    const oc = catalog.lookupMaybe(n('OCProperties'), PDFDict);",
  },
  {
    name: 'flattening without a rasterizer goes back to being skipped silently',
    file: 'src/lib/clean.ts',
    find: "    throw new Error('pages were listed for flattening but no rasterizer was supplied');",
    into: '    void flatten;',
  },
  {
    name: 'the crop box is taken as written, negative sizes and all',
    file: 'src/lib/clean.ts',
    find: '        width: Math.abs(raw.width),\n        height: Math.abs(raw.height),',
    into: '        width: raw.width,\n        height: raw.height,',
  },
  {
    name: 'scripts attached to annotations are left in place',
    file: 'src/lib/clean.ts',
    find: "        const action = annot.lookupMaybe(n('A'), PDFDict);",
    into: '        continue;',
  },
  {
    name: 'the rasterizer hands back a blank page',
    file: 'src/scripts/cleaner.ts',
    find: '    await page.render({ canvasContext: ctx, viewport }).promise;',
    into: '    void page;',
    suite: 'astro build && node test/raster.test.mjs',
  },
  {
    name: 'the rasterizer renders at a size the page never had',
    file: 'src/scripts/cleaner.ts',
    find: "    const viewport = page.getViewport({ scale: 2, rotation: 0 });",
    into: "    const viewport = page.getViewport({ scale: 0.05, rotation: 90 });",
    suite: 'astro build && node test/raster.test.mjs',
  },
  {
    name: 'a black bar over a picture stops counting',
    file: 'src/lib/scan-page.ts',
    find: '      if (!isRedactionBlack(cover.color)) continue;',
    into: '      continue;',
  },
  {
    name: 'any dark colour over a picture counts, brand panels included',
    file: 'src/lib/scan-page.ts',
    find: '  return Math.max((v >> 16) & 255, (v >> 8) & 255, v & 255) < 60;',
    into: '  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255 < 0.35;',
  },
  {
    name: 'the worker writes a column the schema does not declare',
    file: 'src/worker.ts',
    find: "'INSERT INTO subscribers (email, created_at, note, source) VALUES (?, ?, ?, ?) '",
    into: "'INSERT INTO subscribers (email, created_at, note, source, referrer) VALUES (?, ?, ?, ?) '",
  },
];

const DEFAULT_SUITE = 'npm run test:unit';

function run(suite) {
  try {
    execSync(suite, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return true; // suite passed
  } catch {
    return false; // suite failed, which is what a mutation should cause
  }
}

const only = process.argv[2] ? Number(process.argv[2]) : null;
const survivors = [];

console.log(`Checking that ${MUTATIONS.length} guarantees are actually tested.\n`);

for (const [i, m] of MUTATIONS.entries()) {
  if (only !== null && i !== only) continue;

  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    console.log(`${String(i).padStart(2)}  SKIP    ${m.name}`);
    console.log(`            (anchor no longer present in ${m.file} — the mutation needs updating)`);
    survivors.push({ ...m, reason: 'anchor missing' });
    continue;
  }

  writeFileSync(m.file, original.replace(m.find, m.into));
  let caught;
  try {
    caught = !run(m.suite ?? DEFAULT_SUITE);
  } finally {
    // Always restore from what was read, never from git: the working tree
    // usually holds changes that are not committed yet, and restoring from
    // HEAD throws them away. That happened once and cost an hour.
    writeFileSync(m.file, original);
  }

  console.log(`${String(i).padStart(2)}  ${caught ? 'caught ' : 'SURVIVED'} ${m.name}`);
  if (!caught) survivors.push({ ...m, reason: 'suite still passed' });
  if (only !== null) console.log('\n' + m.file + " was restored; apply the mutation by hand to inspect it.");
}

console.log();
if (!survivors.length) {
  console.log('Every guarantee above fails the suite when removed.');
  process.exit(0);
}
console.log(`${survivors.length} mutation(s) went unnoticed:`);
for (const s of survivors) console.log(`  - ${s.name}  (${s.reason})`);
console.log('\nA behaviour that can be deleted without a test failing is not being tested.');
process.exit(1);
