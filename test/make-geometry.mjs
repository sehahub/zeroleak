// Pages whose geometry is not the simple case: one rotated, one whose visible
// area is a crop of a larger sheet. Both carry a genuine redaction, so the
// cleaner has to both find it and hand back a page that still looks right.
import { writeFileSync, mkdirSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFNumber } from 'pdf-lib';

// git does not track empty directories, so a fresh clone has no fixtures
// folder at all until something makes one.
mkdirSync('test/fixtures', { recursive: true });

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

// (1) A landscape page produced by rotating a portrait one.
const rotated = doc.addPage([612, 792]);
rotated.drawText('ROTATED PAGE — this line must stay readable', { x: 60, y: 700, size: 13, font });
rotated.drawText('Case reference 77-2214 assigned to R. Alvarez', { x: 60, y: 650, size: 12, font });
rotated.drawRectangle({ x: 56, y: 644, width: 300, height: 18, color: rgb(0, 0, 0) });
rotated.node.set(PDFName.of('Rotate'), PDFNumber.of(90));

// (2) A page trimmed down from a larger sheet, so the crop origin is not 0,0.
const cropped = doc.addPage([612, 792]);
cropped.drawText('CROPPED PAGE — this line must stay readable', { x: 120, y: 620, size: 13, font });
cropped.drawText('Settlement figure 412,500 withheld from disclosure', { x: 120, y: 570, size: 12, font });
cropped.drawRectangle({ x: 116, y: 564, width: 320, height: 18, color: rgb(0, 0, 0) });
cropped.node.set(
  PDFName.of('CropBox'),
  doc.context.obj([100, 500, 500, 700]),
);

// (3) A crop box recorded from the opposite corner. Taken at face value this
//     becomes a negative width and height, and the replacement image lands
//     mirrored somewhere off the page — over content already deleted.
const flipped = doc.addPage([612, 792]);
flipped.drawText('FLIPPED PAGE — this line must stay readable', { x: 150, y: 640, size: 12, font });
flipped.drawText('Reference 55-9001 withheld from disclosure', { x: 150, y: 600, size: 12, font });
flipped.drawRectangle({ x: 146, y: 594, width: 300, height: 18, color: rgb(0, 0, 0) });
flipped.node.set(PDFName.of('CropBox'), doc.context.obj([500, 700, 100, 500]));

writeFileSync('test/fixtures/geometry.pdf', await doc.save({ useObjectStreams: false }));
console.log('wrote test/fixtures/geometry.pdf');
