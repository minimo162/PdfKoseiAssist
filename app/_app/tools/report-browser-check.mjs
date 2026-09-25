import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export async function checkReportBrowser(browser,zip) {
 const root=mkdtempSync(join(tmpdir(),'kosei-report-browser-'));let child;
 try {
  for(let pos=0;zip.readUInt32LE(pos)===0x04034b50;) {
   assert.equal(zip.readUInt16LE(pos+8),0,'stored ZIP entry');
   const size=zip.readUInt32LE(pos+18),nameLength=zip.readUInt16LE(pos+26),extra=zip.readUInt16LE(pos+28);
   const name=zip.subarray(pos+30,pos+30+nameLength).toString('utf8');
   assert(!name.includes('..')&&!/^[\\/]|:/.test(name));
   const start=pos+30+nameLength+extra,path=join(root,name);
   mkdirSync(dirname(path),{recursive:true});writeFileSync(path,zip.subarray(start,start+size));pos=start+size;
  }
  assert.deepEqual(readdirSync(root).sort(),['_data','指摘レポート.html','指摘レポートを開く.cmd'].sort());
  child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'_data','report-server.ps1'),'-NoBrowser','-ClosedGraceSeconds','1'],{windowsHide:true});
  let errors='';child.stderr.on('data',b=>errors+=b);
  const url=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('report startup '+errors)),10000);
   createInterface({input:child.stdout}).on('line',line=>{if(line.startsWith('REPORT_URL=')){clearTimeout(timer);resolve(line.slice(11));}});
   child.once('error',reject);
  });
  const page=await browser.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(()=>document.querySelector('#pdfCanvas')?.width>300 && document.querySelector('#pdfCanvas')?.height>300);
  assert.equal(await page.locator('#report-direct-message').count(),0);
  assert.deepEqual(pageErrors,[]);
  await page.close();
  const direct=await browser.newPage();
  await direct.goto(pathToFileURL(join(root,'指摘レポート.html')).href,{waitUntil:'commit'});
  await direct.locator('#report-direct-message').waitFor();
  assert.equal(await direct.locator('.app').isVisible(),false);
  await direct.locator('#report-direct-message a').click();
  await direct.locator('.app').waitFor({state:'visible'});
  await direct.waitForFunction(()=>document.querySelector('#pdfCanvas')?.width>300);
  await direct.close();
  console.log('PASS generated report HTTP rendering and file-open guard');
 } finally {
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  rmSync(root,{recursive:true,force:true});
 }
}
