// 共通ヘッドレスEdgeランナー。PDF.jsを使う監査・統合試験の起動、進捗監視、
// エラー診断、プロファイル単位の終了処理を1か所に集約する。
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { killHeadlessByProfile } from "./headless-cleanup.mjs";
import { TEXT_RECONSTRUCTION_VERSION } from "../js/pdf-text-reconstruct.mjs";

export const PDFJS_EXTRACT_SCHEMA = "kosei-pdfjs-extract-v1";
export const PDFJS_BUNDLED_VERSION = "5.6.205";
export { TEXT_RECONSTRUCTION_VERSION };
export const EXTRACT_TEXT_SEPARATOR = "\n\f\n";

export function findBrowserExe() {
  return [
    process.env.KOSEI_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean).find(existsSync) || null;
}

const MIME = { ".mjs":"text/javascript", ".js":"text/javascript", ".html":"text/html; charset=utf-8", ".pdf":"application/pdf", ".json":"application/json" };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runHeadlessPdfJsPage({
  appDir, html, routes = {}, tempPrefix = "kosei-pdfjs-", batchLabel = "PDF.js",
  startupTimeoutMs = 10000, idleTimeoutMs = 90000, totalTimeoutMs = 300000,
  onProgress = null,
}) {
  const exe = findBrowserExe();
  if (!exe) throw new Error("Edge/Chrome が見つかりません（KOSEI_BROWSER で指定できます）");
  const tempDir = mkdtempSync(join(tmpdir(), tempPrefix));
  const profile = join(tempDir, "profile");
  const indexPath = join(tempDir, "index.html");
  writeFileSync(indexPath, html, "utf8");
  const appRoot = resolve(appDir);
  const normalizedRoutes = new Map(Object.entries(routes).map(([url, path]) => [url, resolve(path)]));
  let server = null, child = null, timer = null, startupTimer = null, settled = false;
  let browserStderr = "", lastProgressAt = Date.now(), progressState = { phase:"browser-start" };
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = value => { if (!settled) { settled = true; resolve(value); } }; });
  try {
    server = createServer((req, res) => {
      const url = String(req.url || "/").split("?")[0];
      if (req.method === "POST" && (url === "/progress" || url === "/result")) {
        let body = "";
        req.on("data", chunk => { if (body.length < 50_000_000) body += chunk; });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (url === "/progress") {
              if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
              lastProgressAt = Date.now(); progressState = parsed || {};
              if (onProgress) onProgress(progressState);
            } else {
              if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
              resolveResult(parsed);
            }
            res.writeHead(200).end("ok");
          } catch (error) { res.writeHead(400).end("invalid json"); resolveResult({ error:`ブラウザ応答JSONを解析できません: ${error}` }); }
        });
        return;
      }
      let file = indexPath;
      if (url.startsWith("/app/")) {
        const candidate = resolve(appRoot, url.slice(5));
        const prefix = appRoot.endsWith("\\") || appRoot.endsWith("/") ? appRoot : appRoot + "\\";
        if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) { res.writeHead(403).end(); return; }
        file = candidate;
      } else if (normalizedRoutes.has(url)) file = normalizedRoutes.get(url);
      if (!existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type":MIME[extname(file).toLowerCase()] || "application/octet-stream", "cache-control":"no-store" });
      res.end(readFileSync(file));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    child = spawn(exe, ["--headless=new", "--disable-gpu", "--disable-gpu-compositing", "--disable-gpu-shader-disk-cache",
      "--disable-features=SkiaGraphite,DawnGraphiteCache,WebGPU,Vulkan",
      `--disk-cache-dir=${join(tempDir, "cache")}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`],
      { stdio:["ignore","ignore","pipe"] });
    startupTimer = setTimeout(() => {
      if (settled || progressState.phase !== "browser-start") return;
      const detail = browserStderr.trim().split(/\r?\n/).slice(-4).join(" / ");
      resolveResult({ error:`${batchLabel} browser startup made no progress for ${Math.round(startupTimeoutMs/1000)}s${detail ? `: ${detail}` : ""}` });
    }, startupTimeoutMs);
    startupTimer.unref();
    child.stderr?.on("data", chunk => { browserStderr = (browserStderr + chunk.toString()).slice(-6000); });
    child.once("error", error => resolveResult({ error:`ヘッドレスブラウザを起動できません: ${error}` }));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      const detail = browserStderr.trim().split(/\r?\n/).slice(-4).join(" / ");
      resolveResult({ error:`ヘッドレスブラウザが結果を返す前に終了しました (code=${code}, signal=${signal || "-"})${detail ? `: ${detail}` : ""}` });
    });
    const startedAt = Date.now();
    timer = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const detail = progressState.file ? `${progressState.file} ${progressState.done || 0}/${progressState.total || "?"}` : (progressState.phase || "unknown");
      if (now - lastProgressAt > idleTimeoutMs) resolveResult({ error:`${batchLabel}の進捗が${Math.round(idleTimeoutMs/1000)}秒停止しました (${detail})` });
      else if (now - startedAt > totalTimeoutMs) resolveResult({ error:`${batchLabel}が全体上限${Math.round(totalTimeoutMs/1000)}秒を超えました (${detail})` });
    }, 1000);
    const data = await result;
    if (data?.error) throw new Error(data.error);
    return data;
  } finally {
    settled = true;
    if (timer) clearInterval(timer);
    if (startupTimer) clearTimeout(startupTimer);
    if (child) killHeadlessByProfile(profile, child.pid);
    if (server) await new Promise(resolveClose => server.close(() => resolveClose())).catch(() => {});
    let removed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try { rmSync(tempDir, { recursive:true, force:true }); removed = !existsSync(tempDir); if (removed) break; }
      catch { await delay(100 * (attempt + 1)); }
    }
    if (!removed) throw new Error(`ヘッドレスブラウザの一時プロファイルを削除できませんでした: ${tempDir}`);
  }
}

export function writeJsonAtomic(path, value) {
  const full = resolve(path), temp = `${full}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, full);
}

export function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
export function sha256Text(value) { return createHash("sha256").update(String(value), "utf8").digest("hex"); }
