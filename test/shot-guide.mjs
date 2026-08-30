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
await page.setViewport({width:1280,height:1150});
await page.goto(base+'/research/government-pdfs/',{waitUntil:'networkidle0'});
await page.screenshot({path:'shots/study-top.png'});
await page.evaluate(()=>window.scrollBy(0,1250));
await new Promise(r=>setTimeout(r,300));
await page.screenshot({path:'shots/study-mid.png'});
await browser.close();server.close();console.log('ok');
