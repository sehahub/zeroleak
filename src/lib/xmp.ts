// Pulls readable fields out of an XMP packet. pdf.js hands over the raw XML
// and nothing else, and a real XML parser is not worth pulling into the bundle
// for a format this shallow: XMP is a flat set of namespaced properties, held
// either as attributes or as elements, with values sometimes wrapped in an
// rdf:Seq / rdf:Alt container that carries no meaning of its own.

/** Containers and wrappers that hold no value under their own name. */
const STRUCTURAL = new Set([
  'x:xmpmeta', 'rdf:RDF', 'rdf:Description', 'rdf:Seq', 'rdf:Bag', 'rdf:Alt', 'rdf:li',
]);

/** Fields that describe the format rather than the document or its author. */
const BORING = /^(dc:format|xmp:metadatadate|pdfaid:|pdfuaid:|xmp:rating|xml:lang|rdf:about)/i;

/** Fields that identify a person, an organisation, or the lineage of a file. */
const IDENTIFYING = /^(dc:creator|dc:title|dc:description|dc:subject|dc:rights|dc:publisher|dc:contributor|xmp:creatortool|xmpmm:documentid|xmpmm:originaldocumentid|xmpmm:derivedfrom|xmpmm:history|photoshop:|iptc4xmpcore:|pdfx:|pdf:keywords|xmp:label)/i;

export type XmpField = { key: string; value: string; identifying: boolean };

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export function parseXmp(raw: string, maxValue = 200): XmpField[] {
  const found = new Map<string, string>();

  const record = (key: string, value: string) => {
    if (!key.includes(':') || STRUCTURAL.has(key) || BORING.test(key)) return;
    const v = decode(value);
    if (!v) return;
    const existing = found.get(key);
    if (existing && existing.length >= v.length) return;
    found.set(key, v.length > maxValue ? v.slice(0, maxValue) + '…' : v);
  };

  // Properties written as attributes: <rdf:Description xmp:CreateDate="…">
  for (const m of raw.matchAll(/([A-Za-z][\w.-]*:[A-Za-z][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    if (m[1].startsWith('xmlns')) continue;
    record(m[1], m[2]);
  }

  // Properties written as elements. Walking the tag stream rather than matching
  // whole elements matters: a regex for <tag>…</tag> lets the outermost element
  // swallow the entire packet in one match.
  const tag = /<(\/?)([A-Za-z][\w.-]*:[A-Za-z][\w.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  const stack: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(raw)) !== null) {
    const text = raw.slice(last, m.index);
    if (text.trim()) {
      // Attribute the text to the nearest ancestor that names something.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (!STRUCTURAL.has(stack[i])) { record(stack[i], text); break; }
      }
    }
    last = tag.lastIndex;
    if (m[1]) {
      const at = stack.lastIndexOf(m[2]);
      if (at >= 0) stack.length = at;
    } else if (!m[4]) {
      stack.push(m[2]);
    }
  }

  return [...found.entries()].map(([key, value]) => ({
    key, value, identifying: IDENTIFYING.test(key),
  }));
}
