// Places a PDF keeps a copy of the words in, other than the page content.
// Rasterising a page destroys its text objects and none of these, which is why
// they matter: the guarantee is that flattening leaves nothing to recover.
import { writeFileSync, mkdirSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib';

mkdirSync('test/fixtures', { recursive: true });

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const ctx = doc.context;
const page = doc.addPage([612, 792]);

page.drawText('Ordinary visible body text', { x: 60, y: 720, size: 12, font });
page.drawText('COVERED 891-23-4567', { x: 60, y: 690, size: 12, font });
page.drawRectangle({ x: 56, y: 684, width: 220, height: 18, color: rgb(0, 0, 0) });

// The accessibility tree keeps its own copy of what the page says. A screen
// reader is meant to use it; it survives rasterising the page entirely.
const element = ctx.obj({
  Type: 'StructElem',
  S: PDFName.of('P'),
  ActualText: PDFString.of('ACTUALTEXT 999-88-7777'),
  Alt: PDFString.of('ALT Alice Root'),
});
doc.catalog.set(PDFName.of('StructTreeRoot'), ctx.register(ctx.obj({
  Type: 'StructTreeRoot', K: ctx.register(element),
})));
doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));

// A second XMP packet, attached to the page rather than the document.
page.node.set(PDFName.of('Metadata'), ctx.register(ctx.stream(
  new TextEncoder().encode('<x:xmpmeta><dc:creator>PAGEXMP Bob Secret</dc:creator></x:xmpmeta>'),
  { Type: 'Metadata', Subtype: 'XML' },
)));

// Private application data. Illustrator and Office use this to keep an editable
// original inside the exported file.
const piece = ctx.obj({
  ACME: ctx.obj({
    Private: PDFString.of('PIECEINFO original draft text'),
    LastModified: PDFString.of('D:20260101000000Z'),
  }),
});
page.node.set(PDFName.of('PieceInfo'), piece);
doc.catalog.set(PDFName.of('PieceInfo'), piece);

// A cached rendering of the page as it was before anything was removed.
page.node.set(PDFName.of('Thumb'), ctx.register(ctx.stream(
  new TextEncoder().encode('THUMBDATA 555-00-1234'),
  {
    Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1,
    ColorSpace: PDFName.of('DeviceGray'), BitsPerComponent: 8,
  },
)));

// Layer names describe what a layer is for, which is often who it is for.
const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('OCGNAME internal only layer') }));
doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({
  OCGs: ctx.obj([ocg]),
  D: ctx.obj({ OFF: ctx.obj([ocg]) }),
}));

writeFileSync('test/fixtures/containers.pdf', await doc.save({ useObjectStreams: false }));
console.log('wrote test/fixtures/containers.pdf');
