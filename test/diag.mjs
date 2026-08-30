import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
const file = process.argv[2], pageNo = Number(process.argv[3] || 1), limit = Number(process.argv[4] || 60);
const OPSN = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
const page = await doc.getPage(pageNo);
const ol = await page.getOperatorList();
console.log('view', page.view, ' ops', ol.fnArray.length);
const counts = {};
for (const fn of ol.fnArray) counts[OPSN[fn]] = (counts[OPSN[fn]] || 0) + 1;
console.log('op histogram:', Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([k,v])=>k+':'+v).join('  '));
console.log('--- first ' + limit + ' ops ---');
for (let i = 0; i < Math.min(limit, ol.fnArray.length); i++) {
  const name = OPSN[ol.fnArray[i]];
  const a = ol.argsArray[i];
  let s = JSON.stringify(a, (k, v) => (v && v.constructor && v.constructor.name === 'Glyph' ? v.unicode : v));
  if (s && s.length > 150) s = s.slice(0, 150) + '...';
  console.log(String(i).padStart(4), name.padEnd(26), s);
}
