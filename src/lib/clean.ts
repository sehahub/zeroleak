// Removes what the scanner found. Like the scanner, this runs wherever it is
// called — in the browser there is no upload and no server involved.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream,
} from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';

/** Renders one page to an image. Supplied by the caller so this module stays
 *  free of any canvas dependency. Page numbers are 1-based. */
export type Rasterizer = (page: number) => Promise<{ data: Uint8Array; kind: 'png' | 'jpeg' }>;

export type CleanOptions = {
  metadata?: boolean;
  attachments?: boolean;
  scripts?: boolean;
  annotations?: boolean;
  /** 1-based pages to replace with a flat image, destroying any text on them. */
  flattenPages?: number[];
  rasterize?: Rasterizer;
};

export type CleanResult = { bytes: Uint8Array; actions: string[] };

const n = (s: string) => PDFName.of(s);

function deleteFrom(dict: PDFDict | undefined, key: string): boolean {
  if (!dict || !dict.has(n(key))) return false;
  dict.delete(n(key));
  return true;
}

/** Unlinking an object is not enough: pdf-lib serialises everything still held
 *  in the context, orphaned or not. Anything no longer reachable from the
 *  trailer has to be dropped, or removed content would be written back out. */
function collectGarbage(ctx: PDFContext, roots: (PDFRef | undefined)[]): number {
  const live = new Set<string>();
  const queue: PDFObject[] = [];

  const visit = (obj: PDFObject | undefined) => {
    if (!obj) return;
    if (obj instanceof PDFRef) {
      if (live.has(obj.tag)) return;
      live.add(obj.tag);
      queue.push(ctx.lookup(obj) as PDFObject);
      return;
    }
    queue.push(obj);
  };

  for (const r of roots) visit(r);

  while (queue.length) {
    const obj = queue.pop();
    if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) visit(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i));
    } else if (obj instanceof PDFStream) {
      for (const [, v] of obj.dict.entries()) visit(v);
    }
  }

  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!live.has(ref.tag)) { ctx.delete(ref); dropped++; }
  }
  return dropped;
}

export async function cleanPdf(bytes: Uint8Array, opts: CleanOptions): Promise<CleanResult> {
  // updateMetadata:false stops pdf-lib stamping its own Producer and ModDate
  // onto a document we are in the middle of stripping.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const catalog = doc.catalog;
  const actions: string[] = [];

  if (opts.metadata) {
    const info = doc.getInfoDict();
    const keys = info.keys().map((k) => k.asString());
    for (const k of keys) info.delete(PDFName.of(k.replace(/^\//, '')));
    const hadXmp = deleteFrom(catalog, 'Metadata');
    if (ctx.trailerInfo.ID) { delete (ctx.trailerInfo as { ID?: unknown }).ID; }
    actions.push(hadXmp
      ? 'Cleared the document properties and removed the XMP metadata packet'
      : 'Cleared the document properties');
  }

  if (opts.attachments) {
    const names = catalog.lookupMaybe(n('Names'), PDFDict);
    const had = deleteFrom(names, 'EmbeddedFiles') || deleteFrom(catalog, 'AF');
    if (had) actions.push('Removed the embedded files');
  }

  if (opts.scripts) {
    const names = catalog.lookupMaybe(n('Names'), PDFDict);
    let had = deleteFrom(names, 'JavaScript');
    had = deleteFrom(catalog, 'OpenAction') || had;
    had = deleteFrom(catalog, 'AA') || had;
    for (const page of doc.getPages()) {
      had = deleteFrom(page.node, 'AA') || had;
    }
    if (had) actions.push('Removed document scripts and open actions');
  }

  if (opts.annotations) {
    let had = false;
    for (const page of doc.getPages()) {
      had = deleteFrom(page.node, 'Annots') || had;
    }
    had = deleteFrom(catalog, 'AcroForm') || had;
    if (had) actions.push('Removed comments, links and interactive form fields');
  }

  const flatten = opts.flattenPages ?? [];
  if (flatten.length && opts.rasterize) {
    for (const num of flatten) {
      const page = doc.getPage(num - 1);
      const box = page.getCropBox();
      const { data, kind } = await opts.rasterize(num);

      // Drop the page's own content and resources first, so the text objects
      // are unreachable before the image goes down in their place.
      page.node.delete(n('Contents'));
      page.node.set(n('Resources'), ctx.obj({}));

      const img = kind === 'png' ? await doc.embedPng(data) : await doc.embedJpg(data);
      page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height });
    }
    actions.push(flatten.length === 1
      ? `Replaced page ${flatten[0]} with a flat image, destroying the text hidden on it`
      : `Replaced ${flatten.length} pages with flat images, destroying the text hidden on them`);
  }

  const dropped = collectGarbage(ctx, [ctx.trailerInfo.Root as PDFRef, ctx.trailerInfo.Info as PDFRef]);
  if (dropped) actions.push(`Discarded ${dropped} now-unreferenced objects`);

  // Saving rewrites the file as a single revision, so any earlier versions the
  // original was carrying do not survive.
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, actions };
}
