import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {createInterface} from 'node:readline';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('    function buildReportServerPs1Text()'),html.indexOf('    function buildReportOpenCmdText()'));
const text=Function(code+';return buildReportServerPs1Text();')();
const root=mkdtempSync(join(tmpdir(),'report-lifecycle-'));
mkdirSync(join(root,'_data'));
const identity=join(root,'_data','.report-server.json');
const portFile=join(root,'_data','.report-port');
// report-server.ps1 と同じ計算で、このフォルダの第一希望のポートを求める（動的ポート範囲の外の 20000〜29999）。
const derivedPort=20000+(parseInt(createHash('sha256').update(root.toLowerCase(),'utf8').digest('hex').slice(0,4),16)%10000);
const state=join(root,'_data','確認状況.json');
writeFileSync(join(root,'_data','指摘レポート.html'),'<title>report</title>');
writeFileSync(join(root,'_data','report-server.ps1'),text);
writeFileSync(join(root,'確認状況.json'),'{}');
const children=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// 最初の心拍までの待ち時間は長めにする。短いと、2つ目の起動（PowerShell の起動）が遅い CI では
// 1つ目のサーバーが心拍待ちで先に終わり、次の fetch が ECONNREFUSED になる（2026-09-27 main CI）。
// 心拍が来ないと終わることは、最後に 1 秒を指定して別に確かめている。
async function start(extra=[]) {
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'_data','report-server.ps1'),'-NoBrowser','-HeartbeatTimeoutSeconds','2','-ClosedGraceSeconds','1','-StartupTimeoutSeconds',extra[1] || '30'],{windowsHide:true});
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
 // 1回目の起動の間だけ第一希望のポートをふさぐ。ほかのプロセスが一時的に使っていた状況（CI で時々起きた、#224）。
 // 予備のポートに逃げても、開き直しでは同じポートを使えること（前回のポートを _data/.report-port に覚える）を下で確かめる。
 const blocker=net.createServer();
 const blocked=await new Promise(r=>{blocker.once('error',()=>r(false));blocker.listen(derivedPort,'127.0.0.1',()=>r(true));});
 let server=await start();
 if(blocked) await new Promise(r=>blocker.close(r));
 assert.notEqual(new URL(server.url).port,String(derivedPort),'a port another process listens on is never taken over');
 assert.equal(readFileSync(portFile,'utf8').trim(),new URL(server.url).port,'the port is remembered for the next launch');
 assert.equal(decodeURIComponent(new URL(server.url).pathname),'/_data/指摘レポート.html','report is served from _data');
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
 assert.equal(new URL(server.url).port,firstPort,`reopening the same report reuses its port (first=${firstPort} reopened=${new URL(server.url).port})`);
 await signal(server,'/__report-heartbeat');await waitExit(server.child);assert(!existsSync(identity),'heartbeat timeout cleans identity');
 // Simulate stale record after a killed server. The named mutex is free.
 // 覚えたポートが無いときは、フォルダのパスから決まる第一希望のポートを使う。
 rmSync(portFile,{force:true});
 writeFileSync(identity,JSON.stringify({port:1,token:'0'.repeat(32),pid:0}));
 server=await start(['-StartupTimeoutSeconds','1']);
 assert.equal(new URL(server.url).port,String(derivedPort),'without a remembered port the folder uses its derived port (below the dynamic range)');
 await waitExit(server.child);assert(!existsSync(identity),'no first heartbeat exits and removes stale record');
 console.log('PASS ReportServerLifecycle');
} finally {
 for(const child of children) if(child.exitCode===null) {child.kill();await new Promise(r=>child.once('exit',r));}
 rmSync(root,{recursive:true,force:true});
}
