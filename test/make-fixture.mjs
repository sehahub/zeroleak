// Builds a deliberately "leaky" PDF used to verify the analyzer.
import { writeFileSync } from 'node:fs';
import {
  PDFDocument, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, beginText, endText,
  setTextRenderingMode, setFontAndSize, setTextMatrix, showText,
  TextRenderingMode, PDFHexString, PDFName, PDFString,
} from 'pdf-lib';

const doc = await PDFDocument.create();
doc.setTitle('Q3 Layoff List — CONFIDENTIAL');
doc.setAuthor('Jane Doe (HR Business Partner)');
doc.setSubject('Internal only. Do not distribute.');
doc.setKeywords(['layoff', 'severance', 'internal']);
doc.setProducer('Acme Legal Suite 12.4 (build 8871)');
doc.setCreator('Microsoft Word for Microsoft 365');

const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);

page.drawText('SEVERANCE SUMMARY', { x: 72, y: 740, size: 16, font });

// (1) Fake redaction: real text, then an opaque black box painted on top.
const secret = 'Employee: Kim Min-jun   Payout: $184,000   SSN: 891-23-4567';
page.drawText(secret, { x: 72, y: 700, size: 11, font });
page.drawRectangle({ x: 68, y: 694, width: 400, height: 18, color: rgb(0, 0, 0) });

const secret2 = 'Reason for termination: performance improvement plan failure';
page.drawText(secret2, { x: 72, y: 660, size: 11, font });
page.drawRectangle({ x: 68, y: 654, width: 360, height: 18, color: rgb(0.05, 0.05, 0.08) });

page.drawText('Approved by the compensation committee.', { x: 72, y: 610, size: 11, font });

// (2) Invisible text (render mode 3) — present in the file, never painted.
const fontRef = page.node.newFontDictionary('ZLF', font.ref);
page.pushOperators(
  pushGraphicsState(),
  beginText(),
  setTextRenderingMode(TextRenderingMode.Invisible),
  setFontAndSize(fontRef, 11),
  setTextMatrix(1, 0, 0, 1, 72, 560),
  showText(font.encodeText('HIDDEN NOTE: settlement ceiling is $250k, do not reveal')),
  endText(),
  popGraphicsState(),
);

// (3) Content painted outside the visible page area.
page.drawText('OFFPAGE: draft figures 2.3M', { x: 72, y: -40, size: 11, font });

// (4) Embedded attachment.
await doc.attach(
  new TextEncoder().encode('name,payout\nKim Min-jun,184000\nPark Ji-woo,201500\n'),
  'severance_master.csv',
  { mimeType: 'text/csv', description: 'master list' },
);

// (5) Document-level JavaScript.
doc.addJavaScript('phoneHome', 'app.launchURL("https://example.com/track?id=1", true);');

// (6) An annotation carrying a reviewer name and internal comment.
const ctx = doc.context;
const annot = ctx.obj({
  Type: 'Annot', Subtype: 'Text', Rect: ctx.obj([500, 700, 520, 720]),
  T: PDFString.of('legal.reviewer@acme.example'),
  Contents: PDFString.of('Do NOT send externally until Feb 3. Numbers still disputed.'),
});
page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));

const bytes = await doc.save({ useObjectStreams: false });
writeFileSync('test/fixtures/leaky.pdf', bytes);
console.log('wrote test/fixtures/leaky.pdf', bytes.length, 'bytes');

// A clean control document.
const clean = await PDFDocument.create();
const f2 = await clean.embedFont(StandardFonts.Helvetica);
clean.addPage([612, 792]).drawText('Public notice: office closed on Monday.', { x: 72, y: 700, size: 12, font: f2 });
const cb = await clean.save();
writeFileSync('test/fixtures/clean.pdf', cb);
console.log('wrote test/fixtures/clean.pdf', cb.length, 'bytes');
