// Removes what the scanner found. Like the scanner, this runs wherever it is
// called — in the browser there is no upload and no server involved.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString,
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
    let hadXmp = deleteFrom(catalog, 'Metadata');
    if (ctx.trailerInfo.ID) { delete (ctx.trailerInfo as { ID?: unknown }).ID; }

    // A second XMP packet can hang off any page, and clearing the document's
    // does not touch it.
    for (const page of doc.getPages()) {
      hadXmp = deleteFrom(page.node, 'Metadata') || hadXmp;
      // A cached rendering of the page as it was before any of this.
      deleteFrom(page.node, 'Thumb');
      // Private application data: where an editor keeps an editable original
      // inside the exported file.
      deleteFrom(page.node, 'PieceInfo');
    }
    deleteFrom(catalog, 'PieceInfo');

    // Layer names describe what a layer holds, which is often who it is for.
    // The configuration itself has to stay: removing it would switch every
    // hidden layer back on, revealing exactly what it was hiding.
    const oc = catalog.lookupMaybe(n('OCProperties'), PDFDict);
    const groups = oc?.lookupMaybe(n('OCGs'), PDFArray);
    if (groups) {
      for (let i = 0; i < groups.size(); i++) {
        const group = ctx.lookupMaybe(groups.get(i), PDFDict);
        if (group?.has(n('Name'))) group.set(n('Name'), PDFString.of('Layer'));
      }
    }

    actions.push(hadXmp
      ? 'Cleared the document properties and removed every XMP metadata packet'
      : 'Cleared the document properties');
  }

  if (opts.attachments) {
    // Every one of these has to be evaluated. A file is reachable from more
    // than one place, and the sweep at the end only drops what nothing points
    // at — so leaving a single reference behind carries the whole file into the
    // output while the report says it was removed. Short-circuiting these with
    // || did exactly that: /AF kept the stream alive and the attachment came
    // back out of a document this tool had just called clean.
    const names = catalog.lookupMaybe(n('Names'), PDFDict);
    const removals = [
      deleteFrom(names, 'EmbeddedFiles'),
      deleteFrom(catalog, 'AF'),
      ...doc.getPages().map((page) => deleteFrom(page.node, 'AF')),
    ];
    // A file attachment annotation holds one too, and belongs with the files
    // rather than with review comments.
    for (const page of doc.getPages()) {
      const annots = page.node.lookupMaybe(n('Annots'), PDFArray);
      if (!annots) continue;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const annot = ctx.lookupMaybe(annots.get(i), PDFDict);
        const subtype = annot?.get(n('Subtype'));
        if (subtype && String(subtype) === '/FileAttachment') {
          annots.remove(i);
          removals.push(true);
        }
      }
    }
    if (removals.some(Boolean)) actions.push('Removed the embedded files');
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
      // And the thumbnail, which is a picture of the page as it was.
      deleteFrom(page.node, 'Thumb');

      const img = kind === 'png' ? await doc.embedPng(data) : await doc.embedJpg(data);
      page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height });
    }
    actions.push(flatten.length === 1
      ? `Replaced page ${flatten[0]} with a flat image, destroying the text hidden on it`
      : `Replaced ${flatten.length} pages with flat images, destroying the text hidden on them`);

    // The structure tree carries its own copy of the words, for screen readers,
    // and nothing about turning a page into a picture disturbs it. Leaving it
    // would mean the text survived a step whose whole purpose is that it cannot.
    const hadStructure = deleteFrom(catalog, 'StructTreeRoot');
    deleteFrom(catalog, 'MarkInfo');
    if (hadStructure) {
      actions.push('Removed the structure tree, which held its own copy of the text');
    }
  }

  const dropped = collectGarbage(ctx, [ctx.trailerInfo.Root as PDFRef, ctx.trailerInfo.Info as PDFRef]);
  if (dropped) actions.push(`Discarded ${dropped} now-unreferenced objects`);

  // Saving rewrites the file as a single revision, so any earlier versions the
  // original was carrying do not survive.
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, actions };
}
