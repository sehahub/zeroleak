import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
const OPSN = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('test/corpus/uscourts-form.pdf')), verbosity: 0 }).promise;
const page = await doc.getPage(1);
const ol = await page.getOperatorList();
// Find every op index whose showText spells Print, and print the surrounding window.
const marks = [];
for (let i = 0; i < ol.fnArray.length; i++) {
  if (OPSN[ol.fnArray[i]] === 'showText') {
    const t = (ol.argsArray[i][0] || []).map(g => (typeof g === 'object' && g ? g.unicode : '')).join('');
    if (/Print|Save|As\.\.\./.test(t)) marks.push([i, t]);
  }
}
console.log('text runs of interest:', JSON.stringify(marks));
const lo = Math.max(0, marks[0][0] - 22), hi = Math.min(ol.fnArray.length, marks[marks.length-1][0] + 10);
for (let i = lo; i < hi; i++) {
  const name = OPSN[ol.fnArray[i]];
  let s = JSON.stringify(ol.argsArray[i], (k, v) => (v && v.constructor && v.constructor.name === 'Glyph' ? v.unicode : v));
  if (s && s.length > 130) s = s.slice(0, 130) + '...';
  console.log(String(i).padStart(4), name.padEnd(24), s);
}
console.log('--- annotations ---');
for (const a of await page.getAnnotations()) console.log(a.subtype, JSON.stringify(a.fieldName ?? a.id), 'rect', a.rect && a.rect.map(Math.round).join(','));
