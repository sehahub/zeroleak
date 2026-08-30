// A document full of things that LOOK like hidden text but are not, plus one
// genuine redaction. Guards against false positives must not cost true ones.
import { writeFileSync } from 'node:fs';
import {
  PDFDocument, StandardFonts, rgb, PDFName,
  pushGraphicsState, popGraphicsState, setGraphicsState,
  drawEllipse,
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

writeFileSync('test/fixtures/tricky.pdf', await doc.save({ useObjectStreams: false }));
console.log('wrote test/fixtures/tricky.pdf');
