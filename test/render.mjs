// Renders one page of a PDF to a PNG, so a judgement call about whether text is
// actually visible can be settled by looking instead of by reasoning. Two
// findings were confirmed this way that argument alone would have got wrong.
//
//   node test/render.mjs <file.pdf> <page> <out.png>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
const MIME={'.mjs':'text/javascript','.js':'text/javascript','.pdf':'application/pdf','.html':'text/html','.map':'application/json'};
const server = createServer(async (req,res)=>{
  const u = new URL(req.url,'http://x').pathname;
  if (u === '/') { res.writeHead(200,{'content-type':'text/html'}); res.end(`<!doctype html><canvas id=c></canvas><script type=module>
    import * as pdfjs from '/node_modules/pdfjs-dist/build/pdf.mjs';
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
    const doc = await pdfjs.getDocument({ url:'/doc.pdf' }).promise;
    const page = await doc.getPage(Number(location.hash.slice(1)||1));
    const vp = page.getViewport({ scale: 2 });
    const c = document.getElementById('c'); c.width=vp.width; c.height=vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    document.title = 'done';
  </script>`); return; }
  const p = u === '/doc.pdf' ? resolve(process.argv[2]) : join(process.cwd(), u.slice(1));
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200,{'content-type':MIME[extname(p)]??'application/octet-stream'});
  res.end(await readFile(p));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const exe=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await puppeteer.launch({executablePath:exe,headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
await page.setViewport({width:1300,height:1700});
await page.goto(base+'#'+(process.argv[3]||'1'),{waitUntil:'networkidle0'});
await page.waitForFunction(()=>document.title==='done',{timeout:60000});
await page.screenshot({path: process.argv[4]});
await browser.close(); server.close(); console.log('rendered ->', process.argv[4]);
