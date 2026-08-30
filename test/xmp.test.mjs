import { parseXmp } from '../src/lib/xmp.ts';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

// Shaped exactly like the packets Acrobat writes, with invented values.
const packet = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.1">
   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
            xmlns:dc="http://purl.org/dc/elements/1.1/"
            pdf:Producer="Acrobat Distiller 24.0">
         <xmp:ModifyDate>2026-02-18T12:46:55Z</xmp:ModifyDate>
         <xmp:CreatorTool>Acrobat PDFMaker 25 for Word</xmp:CreatorTool>
         <xmpMM:DocumentID>uuid:8a1fdc64-b56d-4846-8553-534cf12ca0e7</xmpMM:DocumentID>
         <dc:format>application/pdf</dc:format>
         <dc:title>
            <rdf:Alt>
               <rdf:li xml:lang="x-default">Case notes &amp; annexes</rdf:li>
            </rdf:Alt>
         </dc:title>
         <dc:creator>
            <rdf:Seq>
               <rdf:li>Jordan Ellery</rdf:li>
            </rdf:Seq>
         </dc:creator>
         <dc:description>
            <rdf:Alt>
               <rdf:li xml:lang="x-default"/>
            </rdf:Alt>
         </dc:description>
      </rdf:Description>
   </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const fields = parseXmp(packet);
const get = (k) => fields.find((f) => f.key === k);

ok(get('dc:creator')?.value === 'Jordan Ellery', 'reads a name out of an rdf:Seq wrapper');
ok(get('dc:title')?.value === 'Case notes & annexes', 'reads a title out of an rdf:Alt wrapper and decodes entities');
ok(get('xmp:CreatorTool')?.value === 'Acrobat PDFMaker 25 for Word', 'reads a plain element value');
ok(get('xmpMM:DocumentID')?.value.startsWith('uuid:'), 'reads the document identifier');
ok(get('pdf:Producer')?.value === 'Acrobat Distiller 24.0', 'reads a property written as an attribute');
ok(!get('dc:format'), 'skips format boilerplate');
ok(!get('rdf:li') && !get('rdf:Description') && !get('x:xmpmeta'), 'skips structural containers');
ok(!fields.some((f) => f.key.startsWith('xmlns')), 'skips namespace declarations');
ok(!get('dc:description'), 'skips an empty value');
ok(get('dc:creator')?.identifying === true, 'marks a creator as identifying');
ok(get('xmp:ModifyDate')?.identifying === false, 'does not mark a timestamp as identifying');

// The outermost element must not swallow the packet.
ok(fields.length >= 6, `finds every field, not just the first (${fields.length} found)`);

ok(parseXmp('').length === 0, 'an empty packet yields nothing');
ok(parseXmp('not xml at all').length === 0, 'junk yields nothing');

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
