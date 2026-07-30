// Local-only static server for PDF Kosei Assist.
// No external packages. Listens only on 127.0.0.1 and opens a local URL.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const ROOT = __dirname;
const STARTUP_LOG = path.join(ROOT, 'startup-log.txt');
const URL_FILE = path.join(ROOT, 'local-app.url');
const PID_FILE = path.join(ROOT, 'local-app.pid');
const AUTO_OPEN = !process.argv.includes('--no-open') && process.env.AUTO_OPEN !== '0';
const HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000; // v86: 長時間作業中にローカルサーバーが先に終了しないよう延長
const NO_BROWSER_TIMEOUT_MS = 30 * 60 * 1000; // v86: 起動直後の読み込み遅延でも終了しにくくする

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(STARTUP_LOG, line, 'utf8'); } catch {}
}

try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
process.on('exit', () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(URL_FILE); } catch {}
});
process.on('uncaughtException', error => {
  logLine(`uncaughtException: ${error && error.stack || error}`);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  logLine(`unhandledRejection: ${reason && reason.stack || reason}`);
  process.exit(1);
});

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream'
};

function safePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return null; }
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '');
  const target = path.join(ROOT, normalized || 'index.html');
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (target !== ROOT && !target.startsWith(rootWithSep)) return null;
  return target;
}

function openBrowser(url) {
  if (!AUTO_OPEN) return;
  if (process.platform === 'win32') {
    const edgeCandidates = [
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);
    const edgePath = edgeCandidates.find(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (edgePath) {
      execFile(edgePath, [url], { windowsHide: true }, error => {
        if (error) logLine(`edge auto-open failed: ${error.message || error}`);
      });
      return;
    }
    execFile('cmd', ['/c', 'start', '', `microsoft-edge:${url}`], { windowsHide: true }, error => {
      if (error) logLine(`edge protocol auto-open failed: ${error.message || error}`);
    });
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(command, [url], { windowsHide: true }, error => {
    if (error) logLine(`browser auto-open failed: ${error.message || error}`);
  });
}

let activeServer = null;
let hasBrowserHeartbeat = false;
let lastHeartbeatAt = Date.now();
let closeTimer = null;
const startedAt = Date.now();

function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function stopLocalServer(reason) {
  logLine(`shutdown: ${reason}`);
  clearCloseTimer();
  try { fs.unlinkSync(URL_FILE); } catch {}
  const finish = () => process.exit(0);
  if (activeServer) {
    try {
      activeServer.close(finish);
      setTimeout(finish, 1200).unref();
    } catch {
      finish();
    }
  } else {
    finish();
  }
}

function scheduleCloseAfterTabClosed() {
  const markedAt = Date.now();
  clearCloseTimer();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (lastHeartbeatAt <= markedAt) stopLocalServer('browser tab closed');
  }, 5000);
  closeTimer.unref();
}


const REPORT_TARGET_PAYLOAD_SCRIPT_PLACEHOLDER = '__PDF_KOSEI_TARGET_PDF_PAYLOAD_SCRIPT_TAGS__';
const REPORT_TARGET_PDF_RAW_CHUNK_SIZE = 49152;
const REPORT_B64_CHUNK_SIZE = 98304;
const PDF_CHUNK_GLOBAL = '__PDF_KOSEI_TARGET_PDF_B64_CHUNKS__';
const REPORT_WORKER_COMPAT_POLYFILL_SOURCE = `
function installGetOrInsertComputedPolyfill() {
  const install = proto => {
    if (!proto || typeof proto.getOrInsertComputed === "function") return;
    Object.defineProperty(proto, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value: function(key, callback) {
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      }
    });
  };
  install(Map.prototype);
  install(WeakMap.prototype);
}
installGetOrInsertComputedPolyfill();
`;

function readRequestBody(req, limitBytes = 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limitBytes) {
        settled = true;
        reject(new Error('アップロードサイズが大きすぎます。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on('error', err => { if (!settled) reject(err); });
  });
}

function multipartBoundary(contentType) {
  const m = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return m && (m[1] || m[2]);
}

function parseMultipartForm(body, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error('multipart boundary を取得できません。');
  const boundaryBuf = Buffer.from('--' + boundary);
  const headerSep = Buffer.from('\r\n\r\n');
  const fields = new Map();
  let pos = body.indexOf(boundaryBuf);
  while (pos >= 0) {
    pos += boundaryBuf.length;
    if (body[pos] === 45 && body[pos + 1] === 45) break;
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    const headerEnd = body.indexOf(headerSep, pos);
    if (headerEnd < 0) break;
    const headers = body.slice(pos, headerEnd).toString('utf8');
    const contentStart = headerEnd + headerSep.length;
    const next = body.indexOf(boundaryBuf, contentStart);
    if (next < 0) break;
    let contentEnd = next;
    if (contentEnd >= 2 && body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) contentEnd -= 2;
    const content = body.slice(contentStart, contentEnd);
    const disposition = headers.split(/\r?\n/).find(line => /^content-disposition:/i.test(line)) || '';
    const nameMatch = disposition.match(/\bname="([^"]+)"/i);
    const filenameMatch = disposition.match(/\bfilename="([^"]*)"/i);
    if (nameMatch) fields.set(nameMatch[1], { filename: filenameMatch ? filenameMatch[1] : '', data: content, headers });
    pos = next;
  }
  return fields;
}

function multipartText(fields, name, required = true) {
  const part = fields.get(name);
  if (!part) {
    if (required) throw new Error(`${name} が送信されていません。`);
    return '';
  }
  return part.data.toString('utf8');
}

function multipartBuffer(fields, name, required = true) {
  const part = fields.get(name);
  if (!part) {
    if (required) throw new Error(`${name} が送信されていません。`);
    return null;
  }
  return part.data;
}

function splitBase64Chunks(b64, chunkSize = REPORT_B64_CHUNK_SIZE) {
  const src = String(b64 || '');
  const size = Math.max(4, Math.floor(Number(chunkSize) || REPORT_B64_CHUNK_SIZE));
  const safeSize = size - (size % 4);
  const out = [];
  for (let i = 0; i < src.length; i += safeSize) out.push(src.slice(i, i + safeSize));
  return out;
}

function base64ChunksPayloadStatement(globalName, b64) {
  return `window.${globalName}=${JSON.stringify(splitBase64Chunks(b64))};\n`;
}

function reportScriptTag(src) {
  return `<script src="${String(src).replace(/"/g, '%22')}"></script>`;
}

function buildTargetPdfPayloadFiles(targetPdfBytes) {
  const files = [{ name: 'assets/report_payload.js', data: Buffer.from(`window.${PDF_CHUNK_GLOBAL}=window.${PDF_CHUNK_GLOBAL}||[];\n`, 'utf8') }];
  const tags = [reportScriptTag('assets/report_payload.js')];
  let chunkIndex = 0;
  for (let i = 0; i < targetPdfBytes.length; i += REPORT_TARGET_PDF_RAW_CHUNK_SIZE) {
    const b64 = targetPdfBytes.subarray(i, i + REPORT_TARGET_PDF_RAW_CHUNK_SIZE).toString('base64');
    const name = `assets/pdf_chunks/target_${String(chunkIndex).padStart(5, '0')}.js`;
    files.push({ name, data: Buffer.from(`window.${PDF_CHUNK_GLOBAL}.push(${JSON.stringify(b64)});\n`, 'utf8') });
    tags.push(reportScriptTag(name));
    chunkIndex++;
  }
  return { files, scriptTags: tags.join('\n'), chunkCount: chunkIndex };
}

function buildPdfJsPayloadFile() {
  const pdfjsSource = fs.readFileSync(path.join(ROOT, 'pdfjs', 'build', 'pdf.min.mjs'), 'utf8');
  const workerSource = REPORT_WORKER_COMPAT_POLYFILL_SOURCE + '\n' + fs.readFileSync(path.join(ROOT, 'pdfjs', 'build', 'pdf.worker.min.mjs'), 'utf8');
  const payload = [
    base64ChunksPayloadStatement('__PDF_KOSEI_PDFJS_LIB_B64_CHUNKS__', Buffer.from(pdfjsSource, 'utf8').toString('base64')),
    base64ChunksPayloadStatement('__PDF_KOSEI_PDFJS_WORKER_B64_CHUNKS__', Buffer.from(workerSource, 'utf8').toString('base64'))
  ].join('\n');
  return { name: 'assets/pdfjs_payload.js', data: Buffer.from(payload, 'utf8') };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) c = CRC32_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const d = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

function buildZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const file of files) {
    const nameBytes = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || []);
    if (data.length > 0xFFFFFFFF || offset > 0xFFFFFFFF) throw new Error('ZIP64が必要なサイズのため、このビューアZIPでは出力できません。');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28); nameBytes.copy(local, 30);
    localParts.push(local, data);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42); nameBytes.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function buildHtmlReportZipFromMultipart(fields) {
  const targetPdf = multipartBuffer(fields, 'targetPdf');
  const referencePdf = multipartBuffer(fields, 'referencePdf', false);
  const targetPayload = buildTargetPdfPayloadFiles(targetPdf);
  let reportHtml = multipartText(fields, 'reportHtml');
  if (reportHtml.includes(REPORT_TARGET_PAYLOAD_SCRIPT_PLACEHOLDER)) {
    reportHtml = reportHtml.replace(REPORT_TARGET_PAYLOAD_SCRIPT_PLACEHOLDER, targetPayload.scriptTags);
  } else {
    reportHtml = reportHtml.replace('<script type="module">', `${targetPayload.scriptTags}\n<script type="module">`);
  }
  const files = [
    { name: '指摘レポート.html', data: Buffer.from(reportHtml, 'utf8') },
    { name: '指摘.json', data: multipartBuffer(fields, 'reportJson') },
    { name: '指摘.csv', data: multipartBuffer(fields, 'reportCsv') },
    buildPdfJsPayloadFile(),
    ...targetPayload.files,
    { name: 'README_使い方.txt', data: multipartBuffer(fields, 'readme') }
  ];
  if (referencePdf && referencePdf.length) files.push({ name: 'files/reference.pdf', data: referencePdf });
  return buildZipBuffer(files);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${HOST}/`);

    if (requestUrl.pathname === '/__build-html-report-zip') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'POST' });
        res.end('Method Not Allowed');
        return;
      }
      try {
        const body = await readRequestBody(req);
        const fields = parseMultipartForm(body, req.headers['content-type'] || '');
        const zip = buildHtmlReportZipFromMultipart(fields);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="report.zip"'
        });
        res.end(zip);
      } catch (error) {
        logLine(`html report zip build failed: ${error && error.stack || error}`);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(String(error && error.message || error));
      }
      return;
    }

    if (requestUrl.pathname === '/__health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, time: new Date().toISOString() }));
      return;
    }

    if (requestUrl.pathname === '/__heartbeat') {
      hasBrowserHeartbeat = true;
      lastHeartbeatAt = Date.now();
      clearCloseTimer();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/__page-closed') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      scheduleCloseAfterTabClosed();
      return;
    }

    if (requestUrl.pathname === '/__shutdown') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Local app server is stopping. You can close this tab.');
      setTimeout(() => stopLocalServer('manual shutdown'), 80);
      return;
    }

    let filePath = safePath(requestUrl.pathname);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error && error.stack || error));
  }
});

server.on('error', error => {
  logLine(`server error: ${error.code || ''} ${error.message || error}`);
  process.exit(1);
});

setInterval(() => {
  const now = Date.now();
  if (!hasBrowserHeartbeat && now - startedAt > NO_BROWSER_TIMEOUT_MS) {
    stopLocalServer('browser did not connect after startup');
    return;
  }
  if (hasBrowserHeartbeat && now - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
    stopLocalServer('browser heartbeat stopped');
  }
}, 5000).unref();

server.listen(0, HOST, () => {
  activeServer = server;
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://${HOST}:${port}/`;
  try { fs.writeFileSync(URL_FILE, url, 'utf8'); } catch {}
  logLine(`server listening: ${url}`);
  openBrowser(url);
});
