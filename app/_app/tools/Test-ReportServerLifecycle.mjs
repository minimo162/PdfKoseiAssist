import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('    function buildReportServerPs1Text()'),html.indexOf('    function buildReportOpenCmdText()'));
const text=Function(code+';return buildReportServerPs1Text();')();
const root=mkdtempSync(join(tmpdir(),'report-lifecycle-'));
mkdirSync(join(root,'_data'));
const identity=join(root,'_data','.report-server.json');
const state=join(root,'_data','確認状況.json');
writeFileSync(join(root,'指摘レポート.html'),'<title>report</title>');
writeFileSync(join(root,'_data','report-server.ps1'),text);
writeFileSync(join(root,'確認状況.json'),'{}');
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(extra=[]) {
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'_data','report-server.ps1'),'-NoBrowser','-HeartbeatTimeoutSeconds','2','-ClosedGraceSeconds','1','-StartupTimeoutSeconds',extra[1] || '4'],{windowsHide:true});
 children.push(child); let errors=''; child.stderr.on('data',b=>errors+=b);
 const url=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('startup timeout '+errors)),10000);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{if(line.startsWith('REPORT_URL=')){clearTimeout(timer);resolve(line.slice(11));}});
  child.on('exit',code=>{clearTimeout(timer);if(code)reject(Error('startup failed '+errors));});
 });
 return {child,url};
}
async function waitExit(child) {
 for(let i=0;i<80 && child.exitCode===null;i++) await sleep(100);
 assert.equal(child.exitCode,0,'server should exit normally');
}
async function signal(server,path) {
 const url=new URL(server.url);url.pathname=path;
 const response=await fetch(url,{method:'POST',body:'{}'});assert.equal(response.status,200);
}
try {
 let server=await start();
 assert(existsSync(state));assert(!existsSync(join(root,'確認状況.json')),'legacy marks migrated');
 const duplicate=await start(); await waitExit(duplicate.child);
 assert.equal(duplicate.url,server.url,'second launch reuses same server and token');
 const denied=await fetch(new URL('/_data/.report-server.json',server.url));assert.equal(denied.status,403);
 for(let i=0;i<5;i++){await signal(server,'/__report-heartbeat');await sleep(600);assert.equal(server.child.exitCode,null);}
 await signal(server,'/__report-closed');await sleep(400);await signal(server,'/__report-heartbeat');await sleep(1100);
 assert.equal(server.child.exitCode,null,'heartbeat cancels pending close');
 await signal(server,'/__report-closed');await waitExit(server.child);assert(!existsSync(identity));
 const firstPort=new URL(server.url).port;
 server=await start();
 // 同じレポートは同じポートで開き直す（ブラウザに同じページと分かり、古いタブへ開き直しを知らせられる）。
 assert.equal(new URL(server.url).port,firstPort,'reopening the same report reuses its port');
 await signal(server,'/__report-heartbeat');await waitExit(server.child);assert(!existsSync(identity),'heartbeat timeout cleans identity');
 // Simulate stale record after a killed server. The named mutex is free.
 writeFileSync(identity,JSON.stringify({port:1,token:'0'.repeat(32),pid:0}));
 server=await start(['-StartupTimeoutSeconds','1']);await waitExit(server.child);assert(!existsSync(identity),'no first heartbeat exits and removes stale record');
 console.log('PASS ReportServerLifecycle');
} finally {
 for(const child of children) if(child.exitCode===null) {child.kill();await new Promise(r=>child.once('exit',r));}
 rmSync(root,{recursive:true,force:true});
}
