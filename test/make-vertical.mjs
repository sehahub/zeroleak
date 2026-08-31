// A page whose text runs top-to-bottom. Written as raw PDF because pdf-lib
// cannot author a Type0 font, and Identity-V is the whole point: it is what
// tells a reader the writing mode is vertical.
//
// No font is embedded. The glyphs come from a substitute, which is fine — this
// fixture exists to test geometry, and it keeps the file free of any font
// licence. A ToUnicode map makes the recovered text readable.
import { writeFileSync } from 'node:fs';

const CODES = [...new Set([...'CONFIDENTIALVISIBLE'])].map((c) => c.charCodeAt(0));
const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');

// Identity-V takes two-byte codes; use the character code as the CID directly
// so the ToUnicode map below is a straight identity.
const runHex = [...'CONFIDENTIAL'].map((c) => hex(c.charCodeAt(0))).join('');

const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom def
/CMapType 2 def
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${CODES.length} beginbfchar
${CODES.map((c) => `<${hex(c)}> <${hex(c)}>`).join('\n')}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

// Text starts high and runs down the page; the box is tall and narrow, so it
// only overlaps the text if the writing direction was understood.
const content = `BT
/F1 22 Tf
1 0 0 1 200 540 Tm
<${runHex}> Tj
ET
0 0 0 rg
188 250 34 300 re
f
BT
/F1 12 Tf
1 0 0 1 60 560 Tm
<${[...'VISIBLE'].map((c) => hex(c.charCodeAt(0))).join('')}> Tj
ET`;

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] '
    + '/Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-V '
    + '/DescendantFonts [5 0 R] /ToUnicode 8 0 R >>',
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica '
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> '
    + '/FontDescriptor 7 0 R /DW 1000 /DW2 [880 -1000] /CIDToGIDMap /Identity >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /FontDescriptor /FontName /Helvetica /Flags 4 '
    + '/FontBBox [-200 -300 1100 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 '
    + '/CapHeight 700 /StemV 80 >>',
  `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`,
];

let pdf = '%PDF-1.7\n';
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefAt = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

writeFileSync('test/fixtures/vertical.pdf', Buffer.from(pdf, 'latin1'));
console.log(`wrote test/fixtures/vertical.pdf (${pdf.length} bytes)`);
