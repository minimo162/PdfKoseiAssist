import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('    async function buildHtmlReportZipInBrowser('),html.indexOf('    async function buildHtmlReportZipBytes('));
const asset=name=>({name:'_data/assets/'+name,bytes:new Uint8Array([1])});
const context=vm.createContext({originalPdfBytes:new Uint8Array([1]),
 buildReportTargetPdfPayloadFiles:()=>({files:[asset('target.js')],scriptTags:''}),
 buildReportReferencePdfPayloadFiles:()=>({files:[asset('reference.js')],scriptTags:''}),
 reportHtmlDocument:()=>'',encodeUtf8:s=>new TextEncoder().encode(s),
 buildReportOpenCmdText:()=>'',buildReportServerPs1Text:()=>'',
 buildReportPdfJsPayloadFile:async()=>asset('pdfjs_payload.js'),buildReportCMapFilesForZip:()=>[asset('cmaps/a.bcmap')],
 assertReportZipSize(){},buildZip:files=>files});
vm.runInContext(code,context);
const files=await vm.runInContext('buildHtmlReportFiles({data:{},csvText:"",readmeText:""})',context);
assert.deepEqual(Array.from(files).filter(f=>!f.name.startsWith('_data/')).map(f=>f.name).sort(),['指摘レポート.html','指摘レポートを開く.cmd'].sort());
const zip=await vm.runInContext('buildHtmlReportZipInBrowser({data:{},csvText:"",readmeText:""})',context);
assert.deepEqual(zip.map(f=>f.name),files.map(f=>f.name));
assert(html.includes('cMapUrl:"_data/assets/cmaps/"'));
assert(html.includes('<script src="_data/assets/pdfjs_payload.js">'));
console.log('PASS ReportFolderLayout');
