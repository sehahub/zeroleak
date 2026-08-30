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

function renderReport(r: Report, root: HTMLElement) {
  root.textContent = '';

  if (r.encrypted && !r.pages) {
    const v = el('div', 'verdict');
    const body = el('div', 'verdict-body');
    body.append(
      el('h2', undefined, 'This document is password-protected'),
      el('p', 'section-lede', 'ZeroLeak cannot read encrypted files yet, so nothing inside it was scanned.'),
    );
    v.append(body);
    root.append(v);
    return;
  }

  const clean = r.counts.critical === 0 && r.counts.warning === 0;
  const v = el('div', `verdict ${r.counts.critical ? 'has-critical' : clean ? 'is-clean' : ''}`);
  v.append(el('div', 'verdict-score', String(r.counts.critical + r.counts.warning)));

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
  const again = el('button', 'btn btn-quiet', 'Scan another file');
  again.addEventListener('click', () => {
    root.textContent = '';
    $('dz').hidden = false;
    $('dz').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  actions.append(dl, again);
  body.append(actions);

  v.append(body);
  root.append(v);

  for (const f of r.findings) root.append(renderFinding(f));
}

async function scan(file: File) {
  const status = $('status');
  const statusText = $('status-text');
  const bar = $<HTMLElement>('bar');
  const report = $('report');
  report.textContent = '';

  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    status.hidden = false;
    statusText.textContent = `${file.name} is not a PDF.`;
    bar.style.width = '0%';
    return;
  }

  status.hidden = false;
  $('dz').hidden = true;
  statusText.textContent = 'Loading the parser…';
  bar.style.width = '6%';

  try {
    const [pdfjs, { analyzePdf }] = await Promise.all([loadPdfjs(), import('../lib/analyze.ts')]);
    statusText.textContent = `Reading ${file.name}…`;
    bar.style.width = '18%';

    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await analyzePdf(bytes, pdfjs, {
      fileName: file.name,
      onProgress: (done, total) => {
        statusText.textContent = `Scanning page ${done} of ${total}…`;
        bar.style.width = `${20 + (done / total) * 78}%`;
      },
    });

    bar.style.width = '100%';
    status.hidden = true;
    renderReport(r, report);
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status.hidden = false;
    $('dz').hidden = false;
    statusText.textContent =
      `Could not read that file: ${err instanceof Error ? err.message : String(err)}`;
    bar.style.width = '0%';
  }
}

function wireDropzone() {
  const dz = $('dz');
  const input = $<HTMLInputElement>('file');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') { e.preventDefault(); input.click(); }
  });
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
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(String(res.status));
      form.hidden = true;
      note.textContent = 'Saved. You will hear from me once — when the cleaner ships.';
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
