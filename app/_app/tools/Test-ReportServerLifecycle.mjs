import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createInterface} from 'node:readline';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('    function buildReportServerPs1Text()'),html.indexOf('    function buildReportOpenCmdText()'));
const text=Function(code+';return buildReportServerPs1Text();')();
const root=mkdtempSync(join(tmpdir(),'report-lifecycle-'));
mkdirSync(join(root,'_data'));
const identity=join(root,'_data','.report-server.json');
const portFile=join(root,'_data','.report-port');
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
 let server=await start();
 // 覚えたポートが無い最初の起動は、フォルダのパスから決まる第一希望のポートを使う（動的ポート範囲の外の 20000〜29999）。
 // 第一希望はテスト側では計算しない（CI では Node と PowerShell でフォルダのパスの書き方が違い、値が食い違った）。
 const derivedPort=new URL(server.url).port;
 const derivedInRange=Number(derivedPort)>=20000 && Number(derivedPort)<=29999;
 if(!derivedInRange) console.log(`  note: the derived port was taken on this machine; the first launch fell back to ${derivedPort}`);
 assert.equal(readFileSync(portFile,'utf8').trim(),derivedPort,'the port is remembered for the next launch');
 assert.equal(decodeURIComponent(new URL(server.url).pathname),'/_data/指摘レポート.html','report is served from _data');
 assert(existsSync(state));assert(!existsSync(join(root,'確認状況.json')),'legacy marks migrated');
 const duplicate=await start(); await waitExit(duplicate.child);
 assert.equal(duplicate.url,server.url,'second launch reuses same server and token');
 const denied=await fetch(new URL('/_data/.report-server.json',server.url));assert.equal(denied.status,403);
 const deniedPort=await fetch(new URL('/_data/.report-port',server.url));assert.equal(deniedPort.status,403);
 for(let i=0;i<5;i++){await signal(server,'/__report-heartbeat');await sleep(600);assert.equal(server.child.exitCode,null);}
 await signal(server,'/__report-closed');await sleep(400);await signal(server,'/__report-heartbeat');await sleep(1100);
 assert.equal(server.child.exitCode,null,'heartbeat cancels pending close');
 await signal(server,'/__report-closed');await waitExit(server.child);assert(!existsSync(identity));
 // 起動の間だけ第一希望のポートを別のプロセスがふさいでいた状況（CI で時々起きた、#224）。覚えたポートも無い。
 // 予備のポートに逃げても、それを _data/.report-port に覚え、開き直すと同じポートを使う。
 rmSync(portFile,{force:true});
 const blocker=net.createServer();
 await new Promise((resolve,reject)=>{blocker.once('error',reject);blocker.listen(Number(derivedPort),'127.0.0.1',resolve);});
 server=await start();
 await new Promise(r=>blocker.close(r));
 const firstPort=new URL(server.url).port;
 assert.notEqual(firstPort,derivedPort,'a port another process listens on is never taken over');
 assert.equal(readFileSync(portFile,'utf8').trim(),firstPort,'the fallback port is remembered for the next launch');
 await signal(server,'/__report-closed');await waitExit(server.child);assert(!existsSync(identity));
 server=await start();
 // 同じレポートは同じポートで開き直す（ブラウザに同じページと分かり、古いタブへ開き直しを知らせられる）。
 assert.equal(new URL(server.url).port,firstPort,`reopening the same report reuses its port (first=${firstPort} reopened=${new URL(server.url).port})`);
 await signal(server,'/__report-heartbeat');await waitExit(server.child);assert(!existsSync(identity),'heartbeat timeout cleans identity');
 // Simulate stale record after a killed server. The named mutex is free.
 // 覚えたポートが無ければ、また第一希望のポートに戻る。
 rmSync(portFile,{force:true});
 writeFileSync(identity,JSON.stringify({port:1,token:'0'.repeat(32),pid:0}));
 server=await start(['-StartupTimeoutSeconds','1']);
 if(derivedInRange) assert.equal(new URL(server.url).port,derivedPort,'without a remembered port the folder uses its derived port again');
 await waitExit(server.child);assert(!existsSync(identity),'no first heartbeat exits and removes stale record');
 console.log('PASS ReportServerLifecycle');
} finally {
 for(const child of children) if(child.exitCode===null) {child.kill();await new Promise(r=>child.once('exit',r));}
 rmSync(root,{recursive:true,force:true});
}
