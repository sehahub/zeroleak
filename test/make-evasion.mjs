// Ways a redaction can be hidden from a scanner that only understands filled
// rectangles drawn straight onto the page. Every case here was a live false
// negative found by review, except the two marked as controls, which must stay
// unreported so the fixes cannot be "achieved" by flagging everything.
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  PDFDocument, StandardFonts, rgb, drawObject,
  pushGraphicsState, popGraphicsState, setGraphicsState, setFillingRgbColor,
  concatTransformationMatrix, rectangle, clip, endPath, fill,
} from 'pdf-lib';

mkdirSync('test/fixtures', { recursive: true });

/** A raw content-stream fragment pdf-lib will copy verbatim. */
const literal = (text) => ({
  toString: () => text,
  sizeInBytes: () => text.length,
  copyBytesInto: (buf, offset) => {
    for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i);
    return text.length;
  },
});

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const ctx = doc.context;

// (1) Text living inside a form XObject, placed by the form's /Matrix, with the
//     black box painted on the page over where it lands. A very ordinary
//     arrangement: the body is a form, the annotation is page content.
{
  const page = doc.addPage([612, 792]);
  const form = ctx.formXObject(
    [literal('BT /F1 12 Tf 0 0 Td (FORM-PLACED 891-23-4567) Tj ET')],
    {
      BBox: ctx.obj([0, 0, 300, 20]),
      Matrix: ctx.obj([1, 0, 0, 1, 100, 600]),
      Resources: ctx.obj({ Font: ctx.obj({ F1: font.ref }) }),
    },
  );
  page.drawText('Page 1 heading', { x: 60, y: 720, size: 13, font });
  page.pushOperators(drawObject(page.node.newXObject('Fm', ctx.register(form))));
  page.drawRectangle({ x: 96, y: 594, width: 320, height: 20, color: rgb(0, 0, 0) });
}

// (2) A form that sets a transparent fill and does not put it back. Without the
//     implicit save and restore around a form, that alpha leaks onto the page
//     and the real black box afterwards looks see-through.
{
  const page = doc.addPage([612, 792]);
  const gs = ctx.obj({ Type: 'ExtGState', ca: 0.2 });
  const form = ctx.formXObject([literal('/GS0 gs')], {
    BBox: ctx.obj([0, 0, 10, 10]),
    Resources: ctx.obj({ ExtGState: ctx.obj({ GS0: ctx.register(gs) }) }),
  });
  page.drawText('STATE-LEAK 891-23-4567', { x: 60, y: 700, size: 12, font });
  page.pushOperators(drawObject(page.node.newXObject('Fm', ctx.register(form))));
  page.drawRectangle({ x: 56, y: 694, width: 240, height: 18, color: rgb(0, 0, 0) });
}

// (3) CONTROL. A form paints a page-sized black rectangle but its /BBox clips
//     it to a corner. Ignoring the bounding box turns this into a cover over
//     everything on the page.
{
  const page = doc.addPage([612, 792]);
  page.drawText('Control page: this line is plainly visible', { x: 60, y: 700, size: 12, font });
  const form = ctx.formXObject([literal('0 0 0 rg 0 0 612 792 re f')], {
    BBox: ctx.obj([0, 0, 20, 20]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
    Resources: ctx.obj({}),
  });
  page.pushOperators(drawObject(page.node.newXObject('Fm', ctx.register(form))));
}

// (4) The black bar drawn as a stretched one-pixel image mask rather than as a
//     filled rectangle. Identical on screen.
{
  const page = doc.addPage([612, 792]);
  page.drawText('MASK-BAR 891-23-4567', { x: 100, y: 600, size: 12, font });
  const mask = ctx.stream(new Uint8Array([0x00]), {
    Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1,
    ImageMask: true, Decode: ctx.obj([0, 1]), BitsPerComponent: 1,
  });
  page.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(0, 0, 0),
    concatTransformationMatrix(210, 0, 0, 20, 95, 595),
    drawObject(page.node.newXObject('Im', ctx.register(mask))),
    popGraphicsState(),
  );
}

// (5) Text painted with a fully transparent fill: nothing appears, everything
//     copies. Rendering mode 3 was covered; this route was not.
{
  const page = doc.addPage([612, 792]);
  page.drawText('Visible line on the alpha page', { x: 60, y: 700, size: 12, font });
  const gs = ctx.obj({ Type: 'ExtGState', ca: 0 });
  const name = page.node.newExtGState('ZLA', ctx.register(gs));
  page.pushOperators(pushGraphicsState(), setGraphicsState(name));
  page.drawText('ALPHA-ZERO 891-23-4567', { x: 60, y: 640, size: 12, font });
  page.pushOperators(popGraphicsState());
}

// (6) Text clipped down to a single point. Off the page in every sense that
//     matters, and previously invisible to the scanner.
{
  const page = doc.addPage([612, 792]);
  page.drawText('Visible line on the clip page', { x: 60, y: 700, size: 12, font });
  page.pushOperators(pushGraphicsState(), rectangle(0, 0, 1, 1), clip(), endPath());
  page.drawText('CLIPPED-AWAY 891-23-4567', { x: 60, y: 560, size: 12, font });
  page.pushOperators(popGraphicsState());
}

// (7) A paint operator with no path in front of it. pdf.js reports that as a
//     null path; reaching into it threw, and the per-page catch turned one
//     malformed operator into a page nobody scanned.
{
  const page = doc.addPage([612, 792]);
  page.drawText('EMPTY-PATH 891-23-4567', { x: 60, y: 700, size: 12, font });
  page.pushOperators(fill());
  page.drawRectangle({ x: 56, y: 694, width: 240, height: 18, color: rgb(0, 0, 0) });
}

writeFileSync('test/fixtures/evasion.pdf', await doc.save({ useObjectStreams: false }));
console.log('wrote test/fixtures/evasion.pdf (7 pages)');
