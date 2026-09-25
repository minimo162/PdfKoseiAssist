import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.split('<script id="report-direct-open-guard">')[1].split('<\\/script>')[0];
assert(!/\b(?:let|const|class)\b|=>|`/.test(source),'guard uses ES5 only');
function run(mode,protocol,hostname){
 const nodes=[]; const node=tag=>({tag,children:[],appendChild(x){this.children.push(x);x.parentNode=this;},removeChild(x){this.children=this.children.filter(n=>n!==x);},setAttribute(){}});
 const head=node('head'),body=node('body');
 const document={documentMode:mode,body,createElement(tag){const n=node(tag);nodes.push(n);return n;},createTextNode(text){return {text};},getElementsByTagName(){return [head];}};
 const window={};vm.runInNewContext(source,{window,document,location:{protocol,hostname}});
 return {window,nodes,body};
}
assert.equal(run(false,'http:','127.0.0.1').window.__reportDirectBlocked,false);
for(const args of [[11,'file:',''],[false,'file:',''],[false,'http:','evil.example'],[false,'https:','127.0.0.1']]) assert.equal(run(...args).window.__reportDirectBlocked,true);
assert.equal(run(11,'file:','').nodes.filter(n=>n.tag==='a').length,0);
const file=run(false,'file:','');file.nodes.find(n=>n.tag==='a').onclick();assert.equal(file.window.__reportDirectBlocked,false);
console.log('PASS ReportDirectOpenGuard');
