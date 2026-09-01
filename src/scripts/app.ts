import type { Report, Finding, Evidence } from '../lib/analyze.ts';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Builds an element. Text is always set via textContent — evidence strings
 *  come out of an untrusted PDF and must never be parsed as markup. */
function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** Adds 1 to a named tally. The request carries the name and nothing else —
 *  no file name, no size, no page count, no finding. */
export function count(name: 'scan' | 'scan-failed' | 'clean') {
  try {
    navigator.sendBeacon?.(
      '/api/event',
      new Blob([JSON.stringify({ name })], { type: 'application/json' }),
    );
  } catch { /* a missed count is not worth an error */ }
}

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = workerUrl;
      return m;
    });
  }
  return pdfjsPromise;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderEvidence(f: Finding): HTMLElement | null {
  if (!f.evidence.length) return null;
  const box = el('div', 'evidence');
  const head = f.id === 'hidden-text' ? 'Text recovered from under the boxes' : 'Found in this file';
  box.append(el('div', 'evidence-head', head));
  const ul = el('ul');
  for (const e of f.evidence as Evidence[]) {
    const li = el('li');
    if (e.page != null) li.append(el('span', 'pg', `p.${e.page}`));
    if (e.label) li.append(el('span', 'k', e.label));
    li.append(el('span', 'v', e.value));
    ul.append(li);
  }
  box.append(ul);
  if (f.truncated) {
    box.append(el('div', 'evidence-head', `+ ${f.truncated} more not shown`));
  }
  return box;
}

function renderFinding(f: Finding): HTMLElement {
  const card = el('article', `finding ${f.severity}`);
  const head = el('div', 'finding-head');
  head.append(el('span', 'chip', f.severity), el('h3', undefined, f.title));
  card.append(head);
  card.append(el('p', undefined, f.what));
  card.append(el('p', 'why', f.why));
  const ev = renderEvidence(f);
  if (ev) card.append(ev);
  const fix = el('div', 'fix');
  fix.append(el('b', undefined, 'What to do: '));
  fix.append(document.createTextNode(f.fix));
  card.append(fix);
  return card;
}

function reportToText(r: Report): string {
  const lines = [
    'ZeroLeak report',
    `File:   ${r.fileName}`,
    `Size:   ${formatBytes(r.bytes)}`,
    `Pages:  ${r.pages}${r.pagesScanned < r.pages ? ` (scanned ${r.pagesScanned})` : ''}`,
    `Result: ${r.counts.critical} critical, ${r.counts.warning} warning, ${r.counts.info} informational`,
    '',
  ];
  for (const f of r.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.title}`, `  ${f.what}`, `  ${f.why}`, `  Fix: ${f.fix}`);
    for (const e of f.evidence) {
      lines.push(`    - ${e.page != null ? `p.${e.page} ` : ''}${e.label ? `${e.label}: ` : ''}${e.value}`);
    }
    if (f.truncated) lines.push(`    (+${f.truncated} more)`);
    lines.push('');
  }
  lines.push('Scanned locally in the browser. The file was never uploaded. https://zeroleak.sehahub.info');
  return lines.join('\n');
}

type Extras = {
  bytes: Uint8Array;
  pdfjs: any;
  pages: number[];
  cleaner: typeof import('./cleaner.ts')['renderCleaner'];
};

/** Puts the dropzone back. Built before any branch below, because a report
 *  that ends without one leaves the reader with no way back but a reload. */
function scanAnotherButton(root: HTMLElement): HTMLElement {
  const b = el('button', 'btn btn-quiet', 'Scan another file');
  b.addEventListener('click', () => {
    root.textContent = '';
    $('status').hidden = true;
    $('dz').hidden = false;
    $('dz').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  return b;
}

function renderReport(r: Report, root: HTMLElement, extras?: Extras) {
  root.textContent = '';
  const again = scanAnotherButton(root);

  if (r.encrypted && !r.pages) {
    const v = el('div', 'verdict');
    const body = el('div', 'verdict-body');
    body.append(
      el('h2', undefined, 'This document is password-protected'),
      el('p', 'section-lede',
        'ZeroLeak cannot open encrypted files yet, so nothing inside this one was read. '
        + 'A file that merely restricts printing or copying does open — this message means a '
        + 'password is needed to view it at all.'),
    );
    const actions = el('div', 'verdict-actions');
    actions.append(again);
    body.append(actions);
    v.append(body);
    root.append(v);
    return;
  }

  // A page nobody could read is not a page with nothing on it, so it cannot
  // be allowed to end up under a headline that says nothing was found.
  const clean = r.counts.critical === 0 && r.counts.warning === 0 && r.pagesFailed.length === 0;
  const v = el('div', `verdict ${r.counts.critical ? 'has-critical' : clean ? 'is-clean' : ''}`);
  // The headline number has to be the one the sentence beside it is counting.
  v.append(el('div', 'verdict-score', String(r.counts.critical || r.counts.warning)));

  const body = el('div', 'verdict-body');
  body.append(el('h2', undefined,
    r.counts.critical
      ? `${r.counts.critical} serious leak${r.counts.critical > 1 ? 's' : ''} in this file`
      : clean
        ? 'No hidden content found'
        : `${r.counts.warning} thing${r.counts.warning > 1 ? 's' : ''} worth removing`));
  body.append(el('p', undefined,
    clean
      ? 'None of the structural leaks ZeroLeak checks for are present. This does not vouch for the visible content, and text burned into a scanned image is out of reach.'
      : 'Everything below is inside the file you just opened, and travels with it.'));
  if (r.pagesFailed.length) {
    const list = r.pagesFailed.slice(0, 12).join(', ');
    body.append(el('p', 'truncated',
      `${r.pagesFailed.length} page${r.pagesFailed.length > 1 ? 's' : ''} could not be read `
      + `(${list}${r.pagesFailed.length > 12 ? ', …' : ''}). Nothing on `
      + `${r.pagesFailed.length > 1 ? 'them' : 'it'} was checked, so treat this report as covering `
      + 'the rest of the document only.'));
  }

  if (r.pagesScanned < r.pages) {
    // This has to be impossible to miss: a partial scan that reports "nothing
    // found" would otherwise read as a clean bill of health for the whole file.
    body.append(el('p', 'truncated',
      `Only the first ${r.pagesScanned} of ${r.pages} pages were scanned. `
      + `Nothing on pages ${r.pagesScanned + 1} to ${r.pages} was checked, and cleaning will not touch them.`));
  }

  body.append(el('div', 'verdict-meta',
    `${r.fileName} · ${formatBytes(r.bytes)} · ${r.pages} page${r.pages > 1 ? 's' : ''}` +
    `${r.pagesScanned < r.pages ? ` (scanned first ${r.pagesScanned})` : ''} · ${r.ms} ms · not uploaded`));

  const actions = el('div', 'verdict-actions');
  const dl = el('button', 'btn btn-quiet', 'Download report');
  dl.addEventListener('click', () => {
    const blob = new Blob([reportToText(r)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.fileName.replace(/\.pdf$/i, '') + '-zeroleak.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  actions.append(dl, again);
  body.append(actions);

  v.append(body);
  root.append(v);

  if (extras && r.findings.length) {
    const panel = extras.cleaner(r, extras.bytes, extras.pdfjs, extras.pages,
      (cleaned, name) => { void scanBytes(cleaned, name, { counted: false }); });
    if (panel) root.append(panel);
  }

  for (const f of r.findings) root.append(renderFinding(f));
}

async function scanBytes(bytes: Uint8Array, fileName: string, { counted = true } = {}) {
  const status = $('status');
  const statusText = $('status-text');
  const bar = $<HTMLElement>('bar');
  const report = $('report');
  report.textContent = '';
  status.hidden = false;
  $('dz').hidden = true;
  statusText.textContent = 'Loading the parser…';
  bar.style.width = '6%';

  try {
    const [pdfjs, { analyzePdf, pagesWithHiddenText }, { renderCleaner }] = await Promise.all([
      loadPdfjs(), import('../lib/analyze.ts'), import('./cleaner.ts'),
    ]);
    statusText.textContent = `Reading ${fileName}…`;
    bar.style.width = '18%';

    const r = await analyzePdf(bytes, pdfjs, {
      fileName,
      onProgress: (done, total) => {
        statusText.textContent = `Scanning page ${done} of ${total}…`;
        bar.style.width = `${20 + (done / total) * 78}%`;
      },
    });

    bar.style.width = '100%';
    status.hidden = true;
    // Re-scanning a cleaned file is a verification step, not another
    // document. Counting it inflated the one number a decision rests on.
    if (counted) count('scan');
    renderReport(r, report, {
      bytes, pdfjs, pages: pagesWithHiddenText(r), cleaner: renderCleaner,
    });
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (counted) count('scan-failed');
    status.hidden = false;
    $('dz').hidden = false;
    statusText.textContent =
      `Could not read that file: ${err instanceof Error ? err.message : String(err)}`;
    bar.style.width = '0%';
  }
}

async function scan(file: File) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    const status = $('status');
    status.hidden = false;
    $('status-text').textContent = `${file.name} is not a PDF.`;
    $<HTMLElement>('bar').style.width = '0%';
    return;
  }
  await scanBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

function wireDropzone() {
  const dz = $('dz');
  const input = $<HTMLInputElement>('file');

  // Opening the picker by click or keyboard is the label's job now. Forwarding
  // it here meant a button wrapping a focusable control, which no screen reader
  // can announce sensibly.
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) scan(f);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.add('over'); });
  }
  for (const type of ['dragleave', 'dragend']) {
    dz.addEventListener(type, () => dz.classList.remove('over'));
  }
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) scan(f);
  });

  // The whole window accepts a drop, so a near-miss still works.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && !$('report').hasChildNodes()) scan(f);
  });

  window.addEventListener('paste', (e) => {
    const f = (e as ClipboardEvent).clipboardData?.files?.[0];
    if (f) scan(f);
  });
}

function wireSignup() {
  const form = document.getElementById('signup') as HTMLFormElement | null;
  const note = document.getElementById('signup-note');
  if (!form || !note) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input[name=email]') as HTMLInputElement;
    const notes = form.querySelector('textarea[name=note]') as HTMLTextAreaElement | null;
    const email = input.value.trim();
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      note.textContent = 'That address does not look right.';
      return;
    }
    note.textContent = 'Saving…';
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          note: notes?.value.trim() ?? '',
          source: location.pathname,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      form.hidden = true;
      note.textContent = 'Saved. You will hear from me once — when the command-line version ships.';
    } catch {
      note.textContent = 'Could not save that just now. Please try again later.';
    }
  });
}

/** Counts the page view. Sends the path and the referring site's host — never
 *  a full referrer URL, never anything about a scanned document. */
function countVisit() {
  let ref = '';
  try {
    if (document.referrer) {
      const h = new URL(document.referrer).host;
      if (h && h !== location.host) ref = h;
    }
  } catch { /* malformed referrer */ }
  navigator.sendBeacon?.(
    '/api/hit',
    new Blob([JSON.stringify({ path: location.pathname, ref })], { type: 'application/json' }),
  );
}

export function mount() {
  wireDropzone();
  wireSignup();
  countVisit();
}
