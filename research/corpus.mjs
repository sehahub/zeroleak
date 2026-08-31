// Builds a sample of published PDFs and measures how many of them are still
// carrying content their publisher did not mean to hand over.
//
//   node --experimental-strip-types research/corpus.mjs fetch
//   node --experimental-strip-types research/corpus.mjs scan
//   node --experimental-strip-types research/corpus.mjs report
//
// A deliberate constraint: the scan stores finding types and counts and
// NOTHING ELSE. No recovered text, no metadata values, no page images. The
// point of this study is to report how often documents leak, not to become the
// thing that publishes what leaked.
import { writeFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePdf } from '../src/lib/analyze.ts';

const DIR = 'research/corpus';
const MANIFEST = 'research/manifest.json';
const RESULTS = 'research/results.json';
const SUMMARY = 'research/summary.json';

const UA = 'ZeroLeakResearch/0.1 (PDF hygiene study; https://zeroleak.sehahub.info)';
const MAX_BYTES = 25 * 1024 * 1024;

// Categories chosen so the headline group (documents that were redacted before
// release) can be compared against ordinary publications that were not.
const CATEGORIES = [
  { slug: 'foi_release', want: 90, redacted: true },
  { slug: 'transparency', want: 40, redacted: true },
  { slug: 'corporate_report', want: 30, redacted: false },
  { slug: 'policy_paper', want: 25, redacted: false },
  { slug: 'research', want: 25, redacted: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCategory(cat, manifest) {
  const have = manifest.filter((m) => m.category === cat.slug).length;
  if (have >= cat.want) { console.log(`${cat.slug}: already have ${have}`); return; }

  let page = 0;
  let added = 0;
  while (added + have < cat.want && page < 12) {
    const search = `https://www.gov.uk/api/search.json?filter_format=${cat.slug}` +
      `&count=50&start=${page * 50}&fields=link,title,organisations,public_timestamp&order=-public_timestamp`;
    let results;
    try {
      results = (await getJson(search)).results ?? [];
    } catch (e) {
      console.log(`${cat.slug}: search failed (${e.message})`);
      return;
    }
    if (!results.length) break;
    page++;

    for (const r of results) {
      if (added + have >= cat.want) break;
      await sleep(700);
      let content;
      try {
        content = await getJson('https://www.gov.uk/api/content' + r.link);
      } catch { continue; }

      const attachments = (content.details?.attachments ?? [])
        .filter((a) => a.content_type === 'application/pdf' && a.url);
      if (!attachments.length) continue;

      const att = attachments[0];
      const id = createHash('sha1').update(att.url).digest('hex').slice(0, 16);
      if (manifest.some((m) => m.id === id)) continue;

      await sleep(900);
      try {
        const res = await fetch(att.url, { headers: { 'user-agent': UA } });
        if (!res.ok) continue;
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > MAX_BYTES) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > MAX_BYTES || buf.length < 1000) continue;
        if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4]) !== '%PDF-') continue;

        await mkdir(join(DIR, cat.slug), { recursive: true });
        await writeFile(join(DIR, cat.slug, `${id}.pdf`), buf);
        manifest.push({
          id,
          category: cat.slug,
          redacted: cat.redacted,
          organisation: (r.organisations ?? [])[0]?.title ?? null,
          published: r.public_timestamp ?? null,
          bytes: buf.length,
        });
        added++;
        if (added % 10 === 0) {
          console.log(`${cat.slug}: ${added + have}/${cat.want}`);
          await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
        }
      } catch { /* skip and move on */ }
    }
  }
  console.log(`${cat.slug}: ${added + have} documents`);
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
}

async function fetchAll() {
  const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : [];
  for (const cat of CATEGORIES) await fetchCategory(cat, manifest);
  console.log(`\nmanifest holds ${manifest.length} documents`);
}

async function scanAll() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const out = [];
  let done = 0;

  for (const m of manifest) {
    const path = join(DIR, m.category, `${m.id}.pdf`);
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(await readFile(path));
    const row = { id: m.id, category: m.category, redacted: m.redacted, bytes: m.bytes };
    try {
      const r = await analyzePdf(bytes, pdfjs, { fileName: m.id, pageLimit: 30 });
      row.pages = r.pages;
      row.ms = r.ms;
      row.encrypted = r.encrypted;
      // Counts only. Never the values.
      row.findings = {};
      for (const f of r.findings) row.findings[f.id] = f.evidence.length + (f.truncated ?? 0);
    } catch (e) {
      row.error = e.message.slice(0, 80);
    }
    out.push(row);
    if (++done % 25 === 0) console.log(`scanned ${done}/${manifest.length}`);
  }

  await writeFile(RESULTS, JSON.stringify(out, null, 1));
  console.log(`scanned ${out.length} documents -> ${RESULTS}`);
  await summarise();
}

const GROUPS = [['redacted', (r) => r.redacted], ['ordinary', (r) => !r.redacted], ['all', () => true]];

/** Writes the aggregate the site is built from. Per-document rows stay on this
 *  machine: the fetcher is in this repository, so anyone could rebuild the
 *  corpus and match a document id back to the file it came from. Publishing
 *  those rows would name the documents this study promises not to name. */
async function summarise() {
  const raw = JSON.parse(await readFile(RESULTS, 'utf8'));
  const rows = raw.filter((r) => !r.error && r.pages);
  const ids = new Set();
  for (const r of rows) for (const k of Object.keys(r.findings ?? {})) ids.add(k);

  const groups = {};
  for (const [name, filter] of GROUPS) {
    const set = rows.filter(filter);
    const sorted = set.map((r) => r.pages).sort((a, b) => a - b);
    const findings = {};
    for (const id of ids) findings[id] = set.filter((r) => r.findings?.[id]).length;
    groups[name] = {
      documents: set.length,
      pages: set.reduce((a, r) => a + r.pages, 0),
      medianPages: sorted[Math.floor(sorted.length / 2)] ?? 0,
      findings,
    };
  }

  const summary = { generated: new Date().toISOString().slice(0, 10), failedToParse: raw.length - rows.length, groups };
  await writeFile(SUMMARY, JSON.stringify(summary, null, 1));
  console.log(`wrote ${SUMMARY}: ${groups.all.documents} documents, ${groups.all.pages} pages`);
}

function pct(a, b) { return b ? ((a / b) * 100).toFixed(1) + '%' : '—'; }

async function report() {
  const rows = JSON.parse(await readFile(RESULTS, 'utf8')).filter((r) => !r.error && r.pages);
  const groups = [
    ['redacted before release (FOI and transparency)', rows.filter((r) => r.redacted)],
    ['ordinary publications', rows.filter((r) => !r.redacted)],
    ['all documents', rows],
  ];

  const IDS = ['hidden-text', 'invisible-text', 'ocr-layer', 'off-page-text', 'prior-revisions',
    'attachments', 'javascript', 'annotations', 'form-values', 'metadata-identity', 'xmp'];

  for (const [name, set] of groups) {
    if (!set.length) continue;
    console.log(`\n=== ${name} — ${set.length} documents ===`);
    const pages = set.reduce((a, r) => a + r.pages, 0);
    console.log(`${pages.toLocaleString()} pages, median ${set.map(r => r.pages).sort((a,b)=>a-b)[Math.floor(set.length/2)]} pages/doc`);
    for (const id of IDS) {
      const hit = set.filter((r) => r.findings?.[id]);
      if (!hit.length) { console.log(`  ${id.padEnd(18)} 0`); continue; }
      const items = hit.reduce((a, r) => a + r.findings[id], 0);
      console.log(`  ${id.padEnd(18)} ${String(hit.length).padStart(4)} docs  ${pct(hit.length, set.length).padStart(7)}   ${items.toLocaleString()} items`);
    }
  }

  const errs = JSON.parse(await readFile(RESULTS, 'utf8')).filter((r) => r.error);
  console.log(`\n${errs.length} documents failed to parse`);
  for (const e of errs.slice(0, 8)) console.log('   ', e.category, e.error);
}

const cmd = process.argv[2] ?? 'report';
if (cmd === 'fetch') await fetchAll();
else if (cmd === 'scan') await scanAll();
else if (cmd === 'summarise') await summarise();
else await report();
