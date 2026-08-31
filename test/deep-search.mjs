// Searches a PDF for a string the way someone trying to recover it would.
//
// The obvious check — look for the text in the file's bytes — proves nothing,
// because a PDF saved with object streams has every string, every content
// stream and the cross-reference table Flate-compressed. A cleaner that does
// nothing at all passes it. This walks the object graph and inflates each
// stream first, which is what an attacker with any PDF library does in a line.
import { PDFDocument, PDFRawStream, PDFDict, PDFArray, PDFString, PDFHexString, decodePDFRawStream } from 'pdf-lib';

function textOf(bytes) {
  return Buffer.from(bytes).toString('latin1');
}

/** Content streams write strings as hex as often as they write them literally —
 *  pdf-lib does it for every standard font — so a search for the words alone
 *  walks straight past them. */
function decodeHexRuns(text) {
  return text.replace(/<([0-9A-Fa-f\s]{4,})>/g, (whole, body) => {
    const hex = body.replace(/\s+/g, '');
    if (hex.length % 2) return whole;
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  });
}

/** UTF-16 text leaves a null between every character, which no plain search
 *  for a name will match. */
const stripNulls = (text) => text.split('\u0000').join('');

function variants(text) {
  const hex = decodeHexRuns(text);
  return [text, hex, stripNulls(hex), stripNulls(text)];
}

/** Every place a string could be hiding, as one searchable blob. */
export async function recoverableText(pdfBytes) {
  const parts = variants(textOf(pdfBytes));

  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return parts.join('\n'); // unparseable: the raw bytes are all we have
  }

  const seen = new Set();
  const walk = (obj, depth = 0) => {
    if (!obj || depth > 40) return;
    if (obj instanceof PDFRawStream) {
      try {
        parts.push(...variants(textOf(decodePDFRawStream(obj).decode())));
      } catch {
        parts.push(...variants(textOf(obj.contents ?? new Uint8Array())));
      }
      walk(obj.dict, depth + 1);
      return;
    }
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) { parts.push(k.asString()); walk(v, depth + 1); }
      return;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) walk(obj.get(i), depth + 1);
      return;
    }
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      parts.push(obj.decodeText());
      parts.push(obj.toString());
      return;
    }
  };

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (seen.has(ref.tag)) continue;
    seen.add(ref.tag);
    walk(obj);
  }

  return parts.join('\n');
}

/** True when `needle` can still be pulled out of the document by any means. */
export async function stillRecoverable(pdfBytes, needle) {
  const haystack = await recoverableText(pdfBytes);
  return haystack.includes(needle);
}
