// Produces the full leak report for one PDF. Runs entirely in the caller's
// process — nothing here touches the network.
import { scanOperatorList } from './scan-page.ts';
import { parseXmp } from './xmp.ts';

export type Severity = 'critical' | 'warning' | 'info';

export type Evidence = { page?: number; label?: string; value: string };

export type Finding = {
  id: string;
  severity: Severity;
  title: string;
  what: string;
  why: string;
  fix: string;
  evidence: Evidence[];
  truncated?: number;
  /** Every page this finding touches, taken before the evidence list is
   *  shortened for display. Anything that acts on a finding has to read this:
   *  driving the cleaner from the shortened list silently left the pages past
   *  the cut-off untouched while the report said the file was done. */
  pages: number[];
};

export type Report = {
  fileName: string;
  bytes: number;
  pages: number;
  pagesScanned: number;
  /** Pages the scanner could not read. A page nobody looked at is not a page
   *  with nothing on it, and the report has to say so. */
  pagesFailed: number[];
  encrypted: boolean;
  findings: Finding[];
  counts: { critical: number; warning: number; info: number };
  ms: number;
};

// Annotation types that carry human commentary. Links and widgets also have
// contents, but a table-of-contents link is not a leaked review note and must
// not be reported as one.
const MARKUP_ANNOTATIONS = new Set([
  'Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly',
  'Caret', 'Stamp', 'Ink', 'Polygon', 'PolyLine', 'Line', 'Square', 'Circle',
  'FileAttachment', 'Sound', 'Popup',
]);

const MAX_EVIDENCE = 25;
// Measured at roughly 10-30 ms a page, so 500 pages is a few seconds behind a
// progress bar. The cap exists to stop a pathological document locking the tab,
// not to save work on ordinary ones.
const DEFAULT_PAGE_LIMIT = 500;

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

/** pdf.js returns some collections as a Map and others as a plain object. */
function entriesOf<T>(v: Map<string, T> | Record<string, T> | null | undefined): [string, T][] {
  if (!v) return [];
  if (v instanceof Map) return [...v.entries()];
  return Object.entries(v);
}

function makeFinding(f: Omit<Finding, 'evidence' | 'pages'> & { evidence: Evidence[] }): Finding {
  const all = f.evidence;
  const pages = [...new Set(all.map((e) => e.page).filter((p): p is number => p != null))]
    .sort((a, b) => a - b);
  return all.length > MAX_EVIDENCE
    ? { ...f, pages, evidence: all.slice(0, MAX_EVIDENCE), truncated: all.length - MAX_EVIDENCE }
    : { ...f, pages };
}

function countEofMarkers(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i <= bytes.length - 5; i++) {
    // %%EOF
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x25 && bytes[i + 2] === 0x45
      && bytes[i + 3] === 0x4f && bytes[i + 4] === 0x46) { n++; i += 4; }
  }
  return n;
}

/** A linearized ("fast web view") file is written in two sections and ends up
 *  with two end-of-file markers by design, having never been edited. */
export function isLinearized(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  return text.includes('/Linearized');
}

/** Counts complete revisions kept inside the file. A PDF that has been edited
 *  and saved incrementally keeps every earlier version verbatim. */
export function countRevisions(bytes: Uint8Array): number {
  const markers = countEofMarkers(bytes);
  return isLinearized(bytes) ? Math.max(1, markers - 1) : markers;
}

/** Pages carrying text that is in the file but not on the page. Only these
 *  need the destructive flattening pass; every other page is left alone. */
export function pagesWithHiddenText(report: Report): number[] {
  const ids = new Set(['hidden-text', 'invisible-text', 'off-page-text']);
  const pages = new Set<number>();
  for (const f of report.findings) {
    if (!ids.has(f.id)) continue;
    for (const p of f.pages) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

type PdfjsModule = {
  getDocument: (src: unknown) => { promise: Promise<any> };
  OPS: Record<string, number>;
};

export type AnalyzeOptions = {
  fileName?: string;
  pageLimit?: number;
  onProgress?: (done: number, total: number) => void;
};

export async function analyzePdf(
  bytes: Uint8Array,
  pdfjs: PdfjsModule,
  opts: AnalyzeOptions = {},
): Promise<Report> {
  const started = Date.now();
  const findings: Finding[] = [];

  // Read raw structure first: pdf.js may take ownership of the buffer.
  const revisions = countRevisions(bytes);
  const size = bytes.length;
  const copy = new Uint8Array(bytes);

  let doc: any;
  let encrypted = false;
  try {
    doc = await pdfjs.getDocument({ data: copy, verbosity: 0, isEvalSupported: false }).promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') {
      return {
        fileName: opts.fileName ?? 'document.pdf', bytes: size, pages: 0, pagesScanned: 0,
        encrypted: true, findings: [], counts: { critical: 0, warning: 0, info: 0 }, pagesFailed: [],
        ms: Date.now() - started,
      };
    }
    throw err;
  }

  try { encrypted = Boolean((await doc.getPermissions()) !== null); } catch { /* not encrypted */ }

  // ---- Document metadata -------------------------------------------------
  try {
    const meta = await doc.getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;

    const identity: Evidence[] = [];
    for (const key of ['Author', 'Title', 'Subject', 'Keywords']) {
      const v = info[key];
      if (typeof v === 'string' && v.trim()) identity.push({ label: key, value: clip(v) });
    }
    if (identity.length) {
      findings.push(makeFinding({
        id: 'metadata-identity', severity: 'warning',
        title: 'Document properties name people and topics',
        what: 'These fields travel with the file and are visible to anyone who opens its properties panel.',
        why: 'An author name is often enough to identify the source of a leaked or anonymously filed document, and a working title can reveal a matter that was never meant to be named.',
        fix: 'Clear these fields before sending the file outside your organisation.',
        evidence: identity,
      }));
    }

    const software: Evidence[] = [];
    for (const key of ['Producer', 'Creator']) {
      const v = info[key];
      if (typeof v === 'string' && v.trim()) software.push({ label: key, value: clip(v) });
    }
    for (const key of ['CreationDate', 'ModDate']) {
      const v = info[key];
      if (typeof v === 'string' && v.trim()) software.push({ label: key, value: clip(v) });
    }
    if (software.length) {
      findings.push(makeFinding({
        id: 'metadata-software', severity: 'info',
        title: 'Software and timestamps are recorded',
        what: 'The file records which application produced it, at which version, and when it was written.',
        why: 'Exact build numbers tell an attacker which parser bugs your organisation is exposed to, and timestamps can contradict a stated timeline.',
        fix: 'Strip these unless a downstream system depends on them.',
        evidence: software,
      }));
    }

    // pdf.js exposes only the raw packet, so the fields are pulled out here.
    const rawXmp: string | undefined = meta?.metadata?.getRaw?.();
    if (rawXmp) {
      const fields = parseXmp(rawXmp);
      if (fields.length) {
        const identifying = fields.some((f) => f.identifying);
        findings.push(makeFinding({
          id: 'xmp',
          severity: identifying ? 'warning' : 'info',
          title: identifying
            ? 'The XMP metadata packet names people or links this file to others'
            : 'An XMP metadata packet is embedded',
          what: 'XMP is a second, richer metadata block that most "remove properties" features leave untouched.',
          why: 'It commonly carries the original document identifier, the editing history, and the account name of whoever last handled the file — linking together copies you believed were unrelated. Clearing the document properties panel does not touch it.',
          fix: 'Remove the XMP packet, not just the basic document properties.',
          evidence: fields.map((f) => ({ label: f.key, value: f.value })),
        }));
      }
    }
  } catch { /* metadata unreadable */ }

  // ---- Retained earlier versions ----------------------------------------
  if (revisions > 1) {
    findings.push(makeFinding({
      id: 'prior-revisions', severity: 'critical',
      title: `The file still contains ${revisions - 1} earlier version${revisions > 2 ? 's' : ''} of itself`,
      what: 'This PDF was saved incrementally: each edit appended changes without discarding what came before.',
      why: 'Every earlier state of the document — text you deleted, values you corrected, pages you removed — is still inside the file and can be recovered with ordinary tools.',
      fix: 'Re-save the document as a single revision (a "save as" or print-to-PDF flattens the history).',
      evidence: [{ label: 'Revisions kept', value: String(revisions) }],
    }));
  }

  // ---- Attachments -------------------------------------------------------
  try {
    const att = await doc.getAttachments();
    const entries = entriesOf<{ filename?: string; content?: Uint8Array }>(att).map((e) => e[1]);
    if (entries.length) {
      findings.push(makeFinding({
        id: 'attachments', severity: 'critical',
        title: `${entries.length} complete file${entries.length > 1 ? 's are' : ' is'} embedded inside this PDF`,
        what: 'Whole files are stapled into the document and travel with it invisibly.',
        why: 'Attachments are the single most common way a spreadsheet of source data leaves a company inside an innocuous-looking report. Most readers never show them.',
        fix: 'Remove the embedded files unless the recipient is meant to have them.',
        evidence: entries.map((e) => ({
          label: e.filename ?? 'file',
          value: e.content ? `${e.content.length.toLocaleString()} bytes` : 'embedded',
        })),
      }));
    }
  } catch { /* none */ }

  // ---- Document-level JavaScript ----------------------------------------
  try {
    const js = await doc.getJSActions();
    const items: Evidence[] = [];
    for (const [name, actions] of entriesOf<string[]>(js)) {
      for (const a of actions ?? []) items.push({ label: name, value: clip(String(a), 200) });
    }
    if (items.length) {
      findings.push(makeFinding({
        id: 'javascript', severity: 'critical',
        title: 'The document carries executable JavaScript',
        what: 'Code stored in the PDF runs when the document is opened, in readers that allow it.',
        why: 'Document scripts are used to phone home the moment a file is opened, revealing that it was received and where. They are also the classic delivery route for reader exploits.',
        fix: 'Strip all scripts; a document that is meant to be read does not need them.',
        evidence: items,
      }));
    }
  } catch { /* none */ }

  // ---- Optional content (hidden layers) ----------------------------------
  try {
    const oc = await doc.getOptionalContentConfig();
    const hidden: Evidence[] = [];
    for (const [id, g] of entriesOf<{ name?: string }>(oc?.getGroups?.())) {
      let visible = true;
      try { visible = oc.getGroup(id)?.visible !== false; } catch { /* assume visible */ }
      if (!visible) hidden.push({ label: 'Layer', value: clip(String(g?.name ?? id)) });
    }
    if (hidden.length) {
      findings.push(makeFinding({
        id: 'hidden-layers', severity: 'warning',
        title: 'The document has layers that are switched off',
        what: 'Optional content groups let a PDF hold content that is present but not drawn.',
        why: 'A hidden layer is fully recoverable — anyone can switch it back on in a reader\'s layer panel. Draft watermarks, internal annotations and pre-edit artwork routinely survive here.',
        fix: 'Flatten the document so hidden layers are discarded rather than merely turned off.',
        evidence: hidden,
      }));
    }
  } catch { /* none */ }

  // ---- Per page ----------------------------------------------------------
  const total: number = doc.numPages;
  const limit = Math.min(total, opts.pageLimit ?? DEFAULT_PAGE_LIMIT);

  const pagesFailed: number[] = [];
  const covered: Evidence[] = [];
  const invisible: Evidence[] = [];
  const ocr: Evidence[] = [];
  const offPage: Evidence[] = [];
  const comments: Evidence[] = [];
  const formValues: Evidence[] = [];
  const links: Evidence[] = [];

  for (let p = 1; p <= limit; p++) {
    const page = await doc.getPage(p);

    try {
      const ol = await page.getOperatorList();
      const scan = scanOperatorList(ol.fnArray, ol.argsArray, page.view, pdfjs.OPS);
      for (const c of scan.covered) covered.push({ page: p, label: c.color, value: clip(c.text) });
      for (const t of scan.invisible) invisible.push({ page: p, value: clip(t) });
      for (const t of scan.ocr) ocr.push({ page: p, value: clip(t) });
      for (const t of scan.offPage) offPage.push({ page: p, value: clip(t) });
    } catch {
      pagesFailed.push(p);
    }

    try {
      const annots = (await page.getAnnotations()) as any[];
      for (const a of annots ?? []) {
        const author = a.titleObj?.str ?? a.title ?? '';
        const body = a.contentsObj?.str ?? a.contents ?? '';
        if (body && String(body).trim() && MARKUP_ANNOTATIONS.has(String(a.subtype))) {
          comments.push({ page: p, label: String(author || a.subtype || 'comment'), value: clip(String(body)) });
        }
        if (a.fieldName && a.fieldValue != null && String(a.fieldValue).trim()) {
          formValues.push({ page: p, label: String(a.fieldName), value: clip(String(a.fieldValue)) });
        }
        const url = a.unsafeUrl ?? a.url;
        if (url) links.push({ page: p, value: clip(String(url), 160) });
      }
    } catch { /* annotations unreadable */ }

    opts.onProgress?.(p, limit);
  }

  if (covered.length) {
    findings.push(makeFinding({
      id: 'hidden-text', severity: 'critical',
      title: `${covered.length} line${covered.length > 1 ? 's' : ''} of text sit under a box that only hides ${covered.length > 1 ? 'them' : 'it'} on screen`,
      what: 'A filled rectangle was drawn on top of live text. The text underneath was never removed.',
      why: 'This is the failure behind almost every published redaction scandal. Selecting the blacked-out area and copying it returns the original words — no special tooling required. The recovered text is shown below.',
      fix: 'Delete the underlying text, then re-draw the box. Covering is not redacting.',
      evidence: covered,
    }));
  }

  if (invisible.length) {
    findings.push(makeFinding({
      id: 'invisible-text', severity: 'critical',
      title: 'The document contains text that is never drawn on screen',
      what: 'This text uses an invisible rendering mode: it is searchable and copyable, but nothing appears on the page.',
      why: 'Scanners add an invisible layer legitimately, for search. But it is also where content lands when someone hides a paragraph instead of deleting it — and readers surface it the moment you press Ctrl+A.',
      fix: 'Confirm every invisible run is expected OCR output; remove anything else.',
      evidence: invisible,
    }));
  }

  if (ocr.length) {
    findings.push(makeFinding({
      id: 'ocr-layer', severity: 'info',
      title: 'This document has a machine-generated text layer behind its artwork',
      what: 'Pages that are pictures — scans, maps, plans — carry an invisible layer of text so the document can be searched. That is the feature working as intended.',
      why: 'Worth one check all the same: this layer is what copying and searching return, and it is generated separately from the artwork. If the page was altered after the layer was made — a name painted out of a scan, for instance — the layer can still hold what the picture no longer shows.',
      fix: 'Confirm the text layer agrees with what is visible. If the artwork was edited afterwards, regenerate the layer.',
      evidence: ocr,
    }));
  }

  if (offPage.length) {
    findings.push(makeFinding({
      id: 'off-page-text', severity: 'warning',
      title: 'Some text is positioned outside the visible page',
      what: 'These runs are placed beyond the page boundary, so no reader displays them.',
      why: 'Cropping a page changes what is shown, not what is stored. Content pushed off the edge stays in the file and comes back the moment the crop is undone.',
      fix: 'Remove the content rather than moving it out of frame.',
      evidence: offPage,
    }));
  }

  if (comments.length) {
    findings.push(makeFinding({
      id: 'annotations', severity: 'warning',
      title: `${comments.length} comment${comments.length > 1 ? 's' : ''} remain${comments.length > 1 ? '' : 's'} in the document`,
      what: 'Review notes, sticky notes and highlights are stored with the name of whoever wrote them.',
      why: 'Internal review threads are candid by design. Shipped to a counterparty, they expose your reasoning, your disagreements, and who held which position.',
      fix: 'Delete annotations before distribution — flattening the page is not enough on its own.',
      evidence: comments,
    }));
  }

  if (formValues.length) {
    findings.push(makeFinding({
      id: 'form-values', severity: 'warning',
      title: 'Filled form fields still hold their values',
      what: 'The document has interactive fields with data entered in them.',
      why: 'Field values live separately from the page you see. A field that was emptied on screen can still carry its previous value, and hidden fields are never displayed at all.',
      fix: 'Flatten the form so values become page content, or clear the fields.',
      evidence: formValues,
    }));
  }

  if (links.length) {
    findings.push(makeFinding({
      id: 'external-links', severity: 'info',
      title: 'The document links out to external addresses',
      what: 'Link annotations point at resources outside the file.',
      why: 'Worth a glance before sending: links are occasionally unique per recipient, which turns an ordinary click into a read receipt.',
      fix: 'Check that no address encodes a recipient identifier.',
      evidence: links,
    }));
  }

  // Within a severity, lead with the finding a reader can act on most directly.
  const sevOrder: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  const idOrder = [
    'hidden-text', 'invisible-text', 'prior-revisions', 'attachments', 'javascript',
    'annotations', 'form-values', 'metadata-identity', 'xmp', 'hidden-layers',
    'off-page-text', 'ocr-layer', 'external-links', 'metadata-software',
  ];
  const rank = (f: Finding) => {
    const i = idOrder.indexOf(f.id);
    return sevOrder[f.severity] * 100 + (i < 0 ? 99 : i);
  };
  findings.sort((a, b) => rank(a) - rank(b));

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    fileName: opts.fileName ?? 'document.pdf',
    bytes: size,
    pages: total,
    pagesScanned: limit,
    pagesFailed,
    encrypted,
    findings,
    counts,
    ms: Date.now() - started,
  };
}
