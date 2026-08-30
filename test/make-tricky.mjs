// A document full of things that LOOK like hidden text but are not, plus one
// genuine redaction. Guards against false positives must not cost true ones.
import { writeFileSync } from 'node:fs';
import {
  PDFDocument, StandardFonts, rgb, PDFName,
  pushGraphicsState, popGraphicsState, setGraphicsState,
  drawEllipse, rectangle, clip, endPath,
} from 'pdf-lib';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);
const ctx = doc.context;

// (A) Table cell shading drawn BEFORE the text that sits on it. Normal design.
page.drawRectangle({ x: 60, y: 714, width: 480, height: 22, color: rgb(0.91, 0.92, 0.94) });
page.drawText('Region              Revenue            Change', { x: 68, y: 720, size: 11, font });

// (B) A highlighter pen: an opaque-looking yellow bar painted AFTER the text,
//     but with Multiply blending, so the words stay perfectly readable.
const hl = ctx.obj({ Type: 'ExtGState', BM: PDFName.of('Multiply'), ca: 1 });
const hlName = page.node.newExtGState('ZLGS', ctx.register(hl));
page.drawText('Highlighted for the board meeting on Tuesday', { x: 68, y: 660, size: 11, font });
page.pushOperators(pushGraphicsState(), setGraphicsState(hlName));
page.drawRectangle({ x: 64, y: 654, width: 300, height: 17, color: rgb(1, 0.93, 0.2) });
page.pushOperators(popGraphicsState());

// (C) A semi-transparent grey wash over text — a draft overlay, not a redaction.
const wash = ctx.obj({ Type: 'ExtGState', BM: PDFName.of('Normal'), ca: 0.35 });
const washName = page.node.newExtGState('ZLGS', ctx.register(wash));
page.drawText('Draft figures pending audit sign-off', { x: 68, y: 620, size: 11, font });
page.pushOperators(pushGraphicsState(), setGraphicsState(washName));
page.drawRectangle({ x: 64, y: 614, width: 260, height: 17, color: rgb(0.2, 0.2, 0.2) });
page.pushOperators(popGraphicsState());

// (D) A filled ellipse sitting on top of text — curved art, not a redaction box.
page.drawText('Circled in the margin during review', { x: 68, y: 580, size: 11, font });
page.pushOperators(
  pushGraphicsState(),
  ...drawEllipse({
    x: 190, y: 586, xScale: 130, yScale: 14,
    color: rgb(0.1, 0.1, 0.1), borderColor: undefined, borderWidth: 0,
    rotate: undefined, borderDashArray: undefined, borderDashPhase: undefined,
    borderLineCap: undefined, graphicsState: undefined,
  }),
  popGraphicsState(),
);

// (E) A full-page background image laid over everything (a scan-style overlay).
//     1x1 grey PNG stretched across the page.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const img = await doc.embedPng(png);
page.drawText('Text beneath a full-page overlay image', { x: 68, y: 540, size: 11, font });
page.drawImage(img, { x: 0, y: 0, width: 612, height: 792, opacity: 1 });

// (F) The real thing: live text with an opaque black box painted over it.
page.drawText('Account number 8842-1109-3320 belongs to the trustee', { x: 68, y: 500, size: 11, font });
page.drawRectangle({ x: 64, y: 494, width: 330, height: 17, color: rgb(0, 0, 0) });

// (G) A hairline rule drawn the way real typesetters do it: a page-sized
//     rectangle clipped down to a sliver, painted after the text above it.
//     Ignoring the clip makes this look like a box over the whole page.
page.drawText('Section heading above a hairline rule', { x: 68, y: 460, size: 11, font });
page.pushOperators(
  pushGraphicsState(),
  rectangle(60, 450, 480, 0.75),
  clip(),
  endPath(),
);
page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.8, 0.8, 0.8) });
page.pushOperators(popGraphicsState());

// (H) A diagram label drawn once behind its box and again on top, which is how
//     many drawing tools emit shapes with captions.
page.drawText('MODEL', { x: 300, y: 400, size: 11, font });
page.drawRectangle({ x: 292, y: 394, width: 70, height: 18, color: rgb(0.79, 0.85, 0.97) });
page.drawText('MODEL', { x: 300, y: 400, size: 11, font });

// (I) An annotation whose position lives in its /Rect. A reader that ignores
//     annotation placement paints this black box at the page origin instead,
//     straight over the line of text sitting there.
page.drawText('Near the origin, and must stay visible', { x: 6, y: 8, size: 9, font });
const apOps = ['0 0 0 rg', '0 0 120 30 re', 'f'].join(String.fromCharCode(10));
const ap = ctx.formXObject(
  [{ toString: () => apOps, sizeInBytes: () => apOps.length, copyBytesInto: (buf, off) => {
      for (let i = 0; i < apOps.length; i++) buf[off + i] = apOps.charCodeAt(i);
      return apOps.length;
    } }],
  { BBox: ctx.obj([0, 0, 120, 30]), Resources: ctx.obj({}) },
);
const widget = ctx.obj({
  Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Btn'), F: 4,
  Rect: ctx.obj([400, 700, 520, 730]),
  AP: ctx.obj({ N: ctx.register(ap) }),
});
page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(widget)]));

writeFileSync('test/fixtures/tricky.pdf', await doc.save({ useObjectStreams: false }));
console.log('wrote test/fixtures/tricky.pdf');
