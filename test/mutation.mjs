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
    find: 'const over = covers.filter((c) => c.order > r.order',
    into: 'const over = covers.filter((c) => c.order >= 0',
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
    name: 'text painted with a transparent fill is treated as visible',
    file: 'src/lib/scan-page.ts',
    find: 's.render === 3 || s.render === 7 || s.alpha < 0.05',
    into: 's.render === 3 || s.render === 7',
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
    name: 'the worker writes a column the schema does not declare',
    file: 'src/worker.ts',
    find: "'INSERT INTO subscribers (email, created_at, note, source) VALUES (?, ?, ?, ?) '",
    into: "'INSERT INTO subscribers (email, created_at, note, source, referrer) VALUES (?, ?, ?, ?) '",
  },
];

const SUITE = 'npm run test:unit';

function run() {
  try {
    execSync(SUITE, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
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
    caught = !run();
  } finally {
    if (only === null) writeFileSync(m.file, original);
  }

  console.log(`${String(i).padStart(2)}  ${caught ? 'caught ' : 'SURVIVED'} ${m.name}`);
  if (!caught) survivors.push({ ...m, reason: 'suite still passed' });
  if (only !== null) console.log(`\n(left applied in ${m.file} for inspection — git checkout to restore)`);
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
