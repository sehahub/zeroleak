import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.xml':'application/xml'};
const ROOT=resolve('dist');
const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://x');if(u.pathname.startsWith('/api/')){res.writeHead(204);res.end();return;}
  let p=join(ROOT,decodeURIComponent(u.pathname));if((await stat(p).catch(()=>null))?.isDirectory())p=join(p,'index.html');
  if(!existsSync(p)&&existsSync(p+'.html'))p=p+'.html';
  if(!existsSync(p)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':MIME[extname(p)]??'application/octet-stream'});res.end(await readFile(p));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const exe=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await puppeteer.launch({executablePath:exe,headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
await page.goto(base,{waitUntil:'networkidle0'});
await page.screenshot({path:'shots/m-hero.png'});
// horizontal overflow is the classic mobile failure
const overflow = await page.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('home horizontal overflow:', overflow, 'px');
await (await page.$('#file')).uploadFile(resolve('test/fixtures/leaky.pdf'));
await page.waitForSelector('.cleaner',{timeout:60000});
await new Promise(r=>setTimeout(r,400));
await page.evaluate(()=>document.getElementById('report').scrollIntoView());
await page.screenshot({path:'shots/m-report.png'});
console.log('report horizontal overflow:', await page.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth), 'px');
await page.goto(base+'/guides/redact-a-pdf-properly/',{waitUntil:'networkidle0'});
console.log('guide horizontal overflow:', await page.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth), 'px');
await page.screenshot({path:'shots/m-guide.png'});
await browser.close();server.close();
