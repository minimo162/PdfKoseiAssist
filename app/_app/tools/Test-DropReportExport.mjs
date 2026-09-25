import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('    async function buildHtmlReportZipBytes(');
const end = html.indexOf('    async function exportAnnotatedPdf(', start);
const context = vm.createContext({ originalPdfBytes: new Uint8Array([1]), findings: [], originalFileName: 'sample.pdf', referenceList: [],
  buildReportDataWithHighlights: async () => ({findings: [], highlight_error_count: 0}), safeFileBase: () => 'sample',
  reportCsvText: () => '', setImportStatus() {}, buildHtmlReportZipInBrowser: async () => new Uint8Array([80,75,3,4]),
  els: {}, showToast() {}, downloadBlob() { throw new Error('unexpected download'); }, console });
vm.runInContext(html.slice(start,end),context);
await assert.rejects(vm.runInContext('buildHtmlReportZipBytes()',context), /Copilot/);
const result = await vm.runInContext('buildHtmlReportZipBytes({allowEmpty:true})',context);
assert.equal(result.zipBytes[0],80);
assert.equal(result.findings,0);
assert.equal(result.excluded,0);
await vm.runInContext('exportHtmlReportZip()',context); // zero findings never downloads
context.buildReportDataWithHighlights = async () => ({findings:[{}, {excluded_reason:'quote-not-found'}],highlight_error_count:1});
const mixed = await vm.runInContext('buildHtmlReportZipBytes({allowEmpty:true})',context);
assert.equal(mixed.findings,1); assert.equal(mixed.excluded,1);
console.log('PASS DropReportExport');
