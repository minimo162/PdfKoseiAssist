import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {writeReportFolder} from '../js/report-folder.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('    async function buildHtmlReportZipInBrowser('),html.indexOf('    async function buildHtmlReportOutput('));
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
// 結果フォルダの上の階層は入口の .cmd と _data だけ。レポート本体は _data の中（#203）。
assert.deepEqual(Array.from(files).filter(f=>!f.name.startsWith('_data/')).map(f=>f.name),['指摘レポートを開く.cmd']);
assert(files.some(f=>f.name==='_data/指摘レポート.html'),'report HTML is inside _data');
assert(!files.some(f=>f.name==='指摘レポート.html'),'report HTML is not at the top');
const zip=await vm.runInContext('buildHtmlReportZipInBrowser({data:{},csvText:"",readmeText:""})',context);
assert.deepEqual(zip.map(f=>f.name),files.map(f=>f.name));
// HTML は _data の中から自分のフォルダを起点に assets/ を参照する。
assert(html.includes('cMapUrl:"assets/cmaps/"'));
assert(!html.includes('cMapUrl:"_data/assets/cmaps/"'));
assert(html.includes('<script src="assets/pdfjs_payload.js">'));
assert(!html.includes('<script src="_data/assets/pdfjs_payload.js">'));
const tagCode=html.slice(html.indexOf('    function reportScriptTag('),html.indexOf('    async function blobToBase64Payload('));
const reportScriptTag=Function(tagCode+';return reportScriptTag;')();
assert.equal(reportScriptTag('_data/assets/pdf_chunks/target_00000.js'),'<script src="assets/pdf_chunks/target_00000.js"></script>');
class Directory {
 constructor(name, fail=false) { this.name=name;this.children=new Map();this.fail=fail; }
 async getDirectoryHandle(name,options={}) {
  if(!this.children.has(name)) {
   if(!options.create) throw Object.assign(new Error('missing'),{name:'NotFoundError'});
   this.children.set(name,new Directory(name,this.fail));
  }
  const value=this.children.get(name);
  if(!(value instanceof Directory)) throw Object.assign(new Error('file'),{name:'TypeMismatchError'});
  return value;
 }
 async getFileHandle(name) {
  return {createWritable:async()=>({write:async bytes=>{if(this.fail)throw Error('write failed');this.children.set(name,bytes);},close:async()=>{},abort:async()=>{}})};
 }
 async removeEntry(name) {this.children.delete(name);}
}
const parent=new Directory('documents');
const first=await writeReportFolder(parent,'結果',files);
assert.equal(first,'結果');
const existing=parent.children.get('結果');
assert.equal(await writeReportFolder(parent,'結果',files),'結果 (2)');
assert.equal(parent.children.get('結果'),existing);
parent.children.set('file',new Uint8Array([1]));
assert.equal(await writeReportFolder(parent,'file',files),'file (2)');
const failure=new Directory('readonly',true);
await assert.rejects(writeReportFolder(failure,'結果',files),/write failed/);
assert.equal(failure.children.size,0,'partial directory removed');
await assert.rejects(writeReportFolder(parent,'結果',[{name:'../escape',bytes:[]}]),/不正/);
assert.deepEqual(Array.from(parent.children.get('結果').children.keys()).sort(),['_data','指摘レポートを開く.cmd'].sort());
const written=parent.children.get('結果').children.get('_data').children.get('指摘レポート.html');
assert.deepEqual(written,files.find(f=>f.name==='_data/指摘レポート.html').bytes);
console.log('PASS ReportFolderLayout');
