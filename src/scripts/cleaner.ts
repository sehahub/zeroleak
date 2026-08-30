// The cleaner panel: choose what to strip, run it in this tab, download the
// result, and re-scan the result to prove it came out clean.
import type { Report } from '../lib/analyze.ts';
import type { CleanOptions, Rasterizer } from '../lib/clean.ts';

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

type OptionSpec = {
  key: keyof CleanOptions;
  label: string;
  detail: string;
  destructive?: boolean;
  applies: (r: Report, pages: number[]) => boolean;
};

const OPTIONS: OptionSpec[] = [
  {
    key: 'metadata',
    label: 'Document properties and XMP metadata',
    detail: 'Author, title, subject, keywords, producing software, timestamps, and the document identifier that links copies of a file together.',
    applies: (r) => r.findings.some((f) => f.id === 'metadata-identity' || f.id === 'metadata-software' || f.id === 'xmp'),
  },
  {
    key: 'attachments',
    label: 'Embedded files',
    detail: 'Any complete file stapled inside the document.',
    applies: (r) => r.findings.some((f) => f.id === 'attachments'),
  },
  {
    key: 'scripts',
    label: 'Scripts and open actions',
    detail: 'JavaScript stored in the document, and anything set to run when it is opened.',
    applies: (r) => r.findings.some((f) => f.id === 'javascript'),
  },
  {
    key: 'annotations',
    label: 'Comments, links and form fields',
    detail: 'Review notes with their authors, link targets, and values held in interactive fields.',
    applies: (r) => r.findings.some((f) => f.id === 'annotations' || f.id === 'form-values' || f.id === 'external-links'),
  },
  {
    key: 'flattenPages',
    label: 'Text that is in the file but not on the page',
    detail: 'The only way to be certain this text is gone is to replace the affected pages with a flat picture of themselves. Those pages will look identical and print identically, but their text can no longer be selected or searched. Every other page is left untouched.',
    destructive: true,
    applies: (_r, pages) => pages.length > 0,
  },
];

/** Renders a page to a JPEG at roughly 144 DPI. */
function makeRasterizer(pdfjs: any, bytes: Uint8Array): Rasterizer {
  let docPromise: Promise<any> | null = null;
  const getDoc = () => (docPromise ??= pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise);

  return async (pageNumber: number) => {
    const doc = await getDoc();
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    // JPEG has no alpha, so an unpainted page would come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not render the page'))), 'image/jpeg', 0.9);
    });
    return { data: new Uint8Array(await blob.arrayBuffer()), kind: 'jpeg' as const };
  };
}

function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

export function renderCleaner(
  report: Report,
  bytes: Uint8Array,
  pdfjs: any,
  pages: number[],
  onVerify: (cleaned: Uint8Array, name: string) => void,
): HTMLElement | null {
  const applicable = OPTIONS.filter((o) => o.applies(report, pages));
  if (!applicable.length) return null;

  const panel = el('div', 'cleaner');
  panel.append(el('h3', undefined, 'Remove what was found'));
  panel.append(el('p', undefined,
    'The cleaning runs in this tab too. Your file is still never uploaded — you get a new copy back, ' +
    'and the original on your disk is not touched.'));

  const opts = el('div', 'opts');
  const boxes = new Map<string, HTMLInputElement>();
  for (const o of applicable) {
    const row = el('label', `opt${o.destructive ? ' destructive' : ''}`);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    boxes.set(o.key, input);
    const body = el('span');
    const b = el('b', undefined, o.label);
    if (o.key === 'flattenPages') {
      b.textContent = `${o.label} (page${pages.length > 1 ? 's' : ''} ${pages.join(', ')})`;
    }
    body.append(b, document.createTextNode(o.detail));
    row.append(input, body);
    opts.append(row);
  }
  panel.append(opts);

  const actions = el('div', 'cleaner-actions');
  const run = el('button', 'btn', 'Clean and download');
  const status = el('span', 'cleaner-status');
  actions.append(run, status);
  panel.append(actions);

  run.addEventListener('click', async () => {
    (run as HTMLButtonElement).disabled = true;
    status.textContent = 'Working…';
    try {
      const { cleanPdf } = await import('../lib/clean.ts');
      const chosen: CleanOptions = {};
      for (const o of applicable) {
        if (!boxes.get(o.key)?.checked) continue;
        if (o.key === 'flattenPages') {
          chosen.flattenPages = pages;
          chosen.rasterize = makeRasterizer(pdfjs, bytes);
        } else {
          (chosen as Record<string, boolean>)[o.key] = true;
        }
      }

      const { bytes: out, actions: done } = await cleanPdf(bytes, chosen);
      const { count } = await import('./app.ts');
      count('clean');
      const name = report.fileName.replace(/\.pdf$/i, '') + '-cleaned.pdf';
      download(out, name);

      status.textContent = '';
      const box = el('div', 'done');
      box.append(el('h4', undefined, `Done — ${name} saved to your downloads`));
      const ul = el('ul');
      for (const a of done) ul.append(el('li', undefined, a));
      box.append(ul);

      const verifyRow = el('div', 'cleaner-actions');
      const verify = el('button', 'btn btn-quiet', 'Scan the cleaned file');
      verify.addEventListener('click', () => onVerify(out, name));
      const again = el('button', 'btn btn-quiet', 'Download again');
      again.addEventListener('click', () => download(out, name));
      verifyRow.append(verify, again);
      box.append(verifyRow);

      panel.append(box);
      (run as HTMLButtonElement).hidden = true;
    } catch (err) {
      (run as HTMLButtonElement).disabled = false;
      status.textContent = `Could not clean that file: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  return panel;
}
