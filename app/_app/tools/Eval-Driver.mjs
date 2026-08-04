#!/usr/bin/env node
// Eval-Driver.mjs — index.html を headless Chromium で動かし、**本番の経路のまま**
// パケットを作り、回答を貼り戻し、指摘レポートを書き出す評価用ドライバ。
//
// Runs the app's REAL production code path in headless Chromium:
//   build  : load the two fixture PDFs through the real file inputs, build packets
//            exactly like buildAutoPackets() does, dump PROMPT/TEXT/RAW + masker dict.
//   import : reload the app, inject the saved masker dictionary, paste model
//            responses into the manual-import UI, export the JSON report.
//   mkfake : generate a fake RESPONSE_*.json from a build output (round-trip proof).
//
// 実機の Copilot は1本20分かかるので、モデル役を別に立てて検出力を測るのに使う。
// docs/benchmarks/README.md の「ローカル実行で測る」を参照。
//
//   node tools/Eval-Driver.mjs build  --out <dir> [--no-mask]
//   node tools/Eval-Driver.mjs import --dir <dir> --responses <dir> --out <report.json> [--no-mask]
//   node tools/Eval-Driver.mjs mkfake --dir <dir> --out <dir>
//
// 必要なもの: playwright（グローバル可）と Chromium。PLAYWRIGHT_BROWSERS_PATH を見る。
//
// ⚠️ アプリのモジュールスコープ（jobMasker など）は外から触れないので、
//    index.html を index.__driver.html にコピーして末尾に window.__drv を足す。
//    このコピーは成功時も失敗時も必ず消す。それ以外のファイルは書き換えない。

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- constants
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_SRC = path.join(APP_DIR, "index.html");
const PATCHED_NAME = "index.__driver.html";
const PATCHED_PATH = path.join(APP_DIR, PATCHED_NAME);
// 既定は26ページのフィクスチャ。--target / --ref / --range / --chunk で差し替えられる。
let TARGET_PDF = path.join(APP_DIR, "docs/benchmarks/fixtures/aoi-seiki_en_TARGET.pdf");
let REF_PDF = path.join(APP_DIR, "docs/benchmarks/fixtures/aoi-seiki_ja_REF.pdf");
let PAGE_RANGE = "1-26";
let CHUNK_SIZE = 10;
let EXPECT_PACKETS = 0;   // 0 なら件数を検査しない

const PLAYWRIGHT_CANDIDATES = [
  "playwright",
  "file:///opt/node22/lib/node_modules/playwright/index.mjs",
];

// ---------------------------------------------------------------- utilities
// --no-mask: MASKING_ENABLED=false のビルド（マスキング前の挙動を対照群として測るため）
let NO_MASK = false;

const log = (...a) => console.log("[driver]", ...a);
const warn = (...a) => console.log("[driver][warn]", ...a);

function parseArgs(argv) {
  const cmd = argv[2];
  const opts = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else { opts[key] = next; i++; }
    }
  }
  return { cmd, opts };
}

async function loadPlaywright() {
  let lastErr;
  for (const spec of PLAYWRIGHT_CANDIDATES) {
    try { return await import(spec); } catch (e) { lastErr = e; }
  }
  throw new Error(`playwright not importable: ${lastErr?.message}`);
}

// ------------------------------------------------------------ static server
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function startServer(root) {
  const server = http.createServer((req, res) => {
    // The app pings /__heartbeat, /__ready etc. against its PowerShell host.
    // Answer them cheaply so the page never hangs on a pending fetch.
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/__")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, driver: true, state: "unavailable" }));
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

// ------------------------------------------------------------- page patching
// Appends a `window.__drv = {...}` export block at the very END of the module
// <script type="module"> block of index.html, so the driver can reach the
// app's internal functions and the module-scoped `jobMasker` binding.
const PATCH = `

    /* ===== injected by driver.mjs (test harness only) ===== */
    window.__drv = {
      MASKING_ENABLED,
      Masker,
      unmaskFragment,
      makeAllPackets,
      makeCurrentPacket,
      buildPacketTextSidecar,
      buildPacketPromptText,
      buildReviewPacketPdfBytes,
      maskSidecarTextForSend,
      applyMasking,
      autoPromptSuffix,
      maskingPromptSection,
      packetPdfModeLabel,
      packetPromptFileName,
      packetTextFileName,
      coerceFindings,
      restoreMaskedFindings,
      getMasker: () => jobMasker,
      setMasker: (m) => { jobMasker = m; },
      getFindings: () => findings.map(f => ({ ...f })),
      state: () => ({
        hasDoc: !!pdfDoc,
        totalPages,
        targetPageCount: targetPages.length,
        referenceCount: referenceList.length,
        referenceTotalPages,
        chunkSize: getTargetChunkSize(),
        contextPages: getTargetContextPageCount(),
        status: document.getElementById("status")?.textContent || "",
      }),
    };
    window.__drvReady = true;
`;

async function writePatchedIndex() {
  const src = await fsp.readFile(INDEX_SRC, "utf8");
  const idx = src.lastIndexOf("</script>");
  if (idx < 0) throw new Error("could not find the closing </script> of the module block");
  let head = src.slice(0, idx);
  if (NO_MASK) {
    const before = head;
    head = head.replace("const MASKING_ENABLED = true;", "const MASKING_ENABLED = false;");
    if (head === before) throw new Error("--no-mask: MASKING_ENABLED の宣言が見つかりません");
  }
  const patched = head + PATCH + src.slice(idx);
  await fsp.writeFile(PATCHED_PATH, patched, "utf8");
  return PATCHED_PATH;
}

async function removePatchedIndex() {
  try { await fsp.rm(PATCHED_PATH, { force: true }); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ session
async function openSession({ headless = true } = {}) {
  const { chromium } = await loadPlaywright();
  await removePatchedIndex();          // idempotent: kill leftovers first
  await writePatchedIndex();
  const server = await startServer(APP_DIR);
  log(`static server on ${server.origin}`);

  const browser = await chromium.launch({ headless, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", msg => {
    const t = msg.type();
    if (t === "error" || t === "warning") consoleErrors.push(`[console.${t}] ${msg.text()}`);
  });
  page.on("pageerror", err => consoleErrors.push(`[pageerror] ${err?.stack || err}`));
  page.on("requestfailed", r => {
    const u = r.url();
    if (!u.includes("/__")) consoleErrors.push(`[requestfailed] ${u} ${r.failure()?.errorText}`);
  });
  page.on("response", r => {
    if (r.status() >= 400 && !r.url().includes("/__") && !r.url().endsWith("/favicon.ico")) {
      consoleErrors.push(`[http ${r.status()}] ${r.url()}`);
    }
  });

  const session = {
    server, browser, context, page, consoleErrors,
    async close() {
      try { await context.close(); } catch {}
      try { await browser.close(); } catch {}
      try { await server.close(); } catch {}
      await removePatchedIndex();
    },
    dumpErrors() {
      if (!consoleErrors.length) { log("no browser console/page errors"); return; }
      console.log("---- browser console / page errors ----");
      for (const line of consoleErrors.slice(-60)) console.log(line);
      console.log("---------------------------------------");
    },
  };
  return session;
}

async function loadAppAndPdfs(session) {
  const { page } = session;
  const url = `${session.server.origin}/${PATCHED_NAME}?advanced=1`;
  log(`opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__drvReady === true, null, { timeout: 60000 });
  log("module booted; __drv exposed");

  // The manual-import and export controls live inside collapsed <details>
  // (and .advanced-only blocks, hence ?advanced=1). Open everything so real
  // Playwright clicks work on visible elements.
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach(d => { d.open = true; });
  });

  log("loading TARGET pdf via #pdfFile ...");
  await page.setInputFiles("#pdfFile", TARGET_PDF);
  await page.waitForFunction(() => window.__drv.state().totalPages > 0, null, { timeout: 180000 });

  log("loading REFERENCE pdf via #referencePdfFile ...");
  await page.setInputFiles("#referencePdfFile", REF_PDF);
  await page.waitForFunction(() => window.__drv.state().referenceCount > 0, null, { timeout: 180000 });

  // Both PDFs are in; the packet buttons come alive at that point.
  await page.waitForFunction(
    () => !document.getElementById("createAllPacketsBtn")?.disabled
       && !document.getElementById("createReviewPdfBtn")?.disabled,
    null, { timeout: 180000 });

  const st0 = await page.evaluate(() => window.__drv.state());
  log(`loaded: target=${st0.totalPages}p reference=${st0.referenceTotalPages}p`);

  // Range + packet size, through the real listeners.
  await page.evaluate(({ range, chunk }) => {
    const fire = (el, types) => types.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    const chunkEl = document.getElementById("targetChunkSizeInput");
    chunkEl.value = String(chunk);
    fire(chunkEl, ["input", "change"]);
    const rangeEl = document.getElementById("pageRangeInput");
    rangeEl.value = range;
    fire(rangeEl, ["input", "change"]);
  }, { range: PAGE_RANGE, chunk: CHUNK_SIZE });

  const st = await page.evaluate(() => window.__drv.state());
  const masking = await page.evaluate(() => window.__drv.MASKING_ENABLED);
  log(`settings: pages=${st.targetPageCount} chunk=${st.chunkSize} context=${st.contextPages} `
    + `MASKING_ENABLED=${masking}`);
  if (st.targetPageCount !== 26) throw new Error(`target page count is ${st.targetPageCount}, expected 26`);
  if (st.chunkSize !== CHUNK_SIZE) throw new Error(`chunk size is ${st.chunkSize}, expected ${CHUNK_SIZE}`);
  return st;
}

// --------------------------------------------------------------- build packets
// Mirrors buildAutoPackets() exactly, minus buildReviewPacketPdfBytes (the
// review PDF is not an input to the sidecar text or the prompt; with
// MASKING_ENABLED the PDF is discarded by applyMasking anyway).
async function buildPacketsInPage(page) {
  return page.evaluate(async () => {
    const d = window.__drv;
    const basePackets = d.makeAllPackets();
    if (!basePackets.length) throw new Error("no packets");
    const out = [];
    for (const packet of basePackets) {
      const effectivePacket = {
        ...packet,
        packetPdfMode: "source",
        packetPdfModeLabel: d.packetPdfModeLabel("source"),
      };
      Object.assign(packet, {
        packetPdfMode: effectivePacket.packetPdfMode,
        packetPdfModeLabel: effectivePacket.packetPdfModeLabel,
      });
      const rawText = await d.buildPacketTextSidecar(effectivePacket);
      const { text } = d.applyMasking(rawText, new Uint8Array(0), effectivePacket.packetId);
      const prompt = d.buildPacketPromptText(effectivePacket) + d.autoPromptSuffix() + d.maskingPromptSection();
      out.push({
        packet_id: effectivePacket.packetId,
        kind: effectivePacket.kind || "proofread",
        target_check_pages: [...effectivePacket.targetCheckPages],
        target_context_pages: [...effectivePacket.targetContextPages],
        reference_pages: (effectivePacket.referenceSections || []).flatMap(s => [...(s.pages || [])]),
        reference_files: (effectivePacket.referenceSections || []).map(s => s.fileName),
        prompt_name: d.packetPromptFileName(effectivePacket),
        text_name: d.packetTextFileName(effectivePacket),
        prompt,
        rawText,
        maskedText: text,
      });
    }
    return out;
  });
}

async function dumpMasker(page) {
  return page.evaluate(() => {
    const m = window.__drv.getMasker();
    if (!m) throw new Error("jobMasker is null - masking did not run");
    return {
      surfaces: Array.from(m.surfaces.entries()),
      byKey: Array.from(m.byKey.entries()),
      occurrences: m.occurrences.map(o => ({ ...o })),
      seed: m._seed,
    };
  });
}

// -------------------------------------------------------------------- build
async function cmdBuild(opts) {
  const outDir = path.resolve(opts.out || "./packets");
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const session = await openSession();
  try {
    await loadAppAndPdfs(session);
    log("building packets (makeAllPackets + sidecar + mask + prompt) ...");
    const packets = await buildPacketsInPage(session.page);
    log(`built ${packets.length} packet(s)`);

    const index = [];
    for (const p of packets) {
      await fsp.writeFile(path.join(outDir, `PROMPT_${p.packet_id}.txt`), p.prompt, "utf8");
      await fsp.writeFile(path.join(outDir, `TEXT_${p.packet_id}.txt`), p.maskedText, "utf8");
      await fsp.writeFile(path.join(outDir, `RAW_${p.packet_id}.txt`), p.rawText, "utf8");
      index.push({
        packet_id: p.packet_id,
        target_check_pages: p.target_check_pages,
        target_context_pages: p.target_context_pages,
        reference_pages: p.reference_pages,
      });
      log(`  ${p.packet_id}: target=${p.target_check_pages.join(",")} `
        + `context=[${p.target_context_pages.join(",")}] ref=${p.reference_pages.length}p `
        + `prompt=${p.prompt.length}ch text=${p.maskedText.length}ch raw=${p.rawText.length}ch`);
    }
    await fsp.writeFile(path.join(outDir, "packets.json"), JSON.stringify(index, null, 2), "utf8");

    if (!NO_MASK) {
      const masker = await dumpMasker(session.page);
      await fsp.writeFile(path.join(outDir, "masker.json"), JSON.stringify(masker, null, 2), "utf8");
      log(`masker: ${masker.byKey.length} distinct quantities, ${masker.surfaces.length} surfaces, `
        + `${masker.occurrences.length} occurrences`);
    } else {
      log("masker: --no-mask のため辞書なし");
    }

    // ---- self checks -----------------------------------------------------
    const problems = [];
    if (EXPECT_PACKETS && packets.length !== EXPECT_PACKETS) {
      problems.push(`expected ${EXPECT_PACKETS} packets, got ${packets.length}`);
    }
    for (const p of packets) {
      if (p.rawText.includes("⟦#")) problems.push(`${p.packet_id}: RAW text contains ⟦# symbols`);
      if (NO_MASK) {
        if (p.maskedText.includes("⟦#")) problems.push(`${p.packet_id}: --no-mask なのに記号が入っている`);
        if (p.prompt.includes("数値はプレースホルダーに置き換えてあります")) {
          problems.push(`${p.packet_id}: --no-mask なのにマスキング説明が入っている`);
        }
        if (p.prompt.includes("今回はPDFを添付していません")) {
          problems.push(`${p.packet_id}: --no-mask なのにマスク用の材料行が入っている`);
        }
      } else {
        if (!p.maskedText.includes("⟦#")) problems.push(`${p.packet_id}: masked TEXT has no ⟦# symbols`);
        if (!p.prompt.includes("数値はプレースホルダーに置き換えてあります")) {
          problems.push(`${p.packet_id}: prompt lacks maskingPromptSection()`);
        }
      }
      if (!p.prompt.includes("KOSEI_END")) problems.push(`${p.packet_id}: prompt lacks autoPromptSuffix()`);
    }
    const nm = await import(pathToFileURL(path.join(APP_DIR, "js/number-mask.mjs")).href);
    for (const p of NO_MASK ? [] : packets) {
      const v = nm.verify(p.maskedText);
      log(`  verify(${p.packet_id}) ok=${v.ok}${v.ok ? "" : " leaks=" + JSON.stringify(v.leaks.slice(0, 5))}`);
      if (!v.ok) problems.push(`${p.packet_id}: verify() reported ${v.leaks.length} leak(s)`);
    }
    if (problems.length) {
      session.dumpErrors();
      throw new Error("build self-check failed:\n  - " + problems.join("\n  - "));
    }
    log(`OK -> ${outDir}`);
  } catch (e) {
    session.dumpErrors();
    throw e;
  } finally {
    await session.close();
  }
}

// ------------------------------------------------------------------- import
async function cmdImport(opts) {
  const dir = path.resolve(opts.dir || "./packets");
  const respDir = path.resolve(opts.responses || "./responses");
  const outFile = path.resolve(opts.out || "./report.json");

  const maskerState = NO_MASK ? null
    : JSON.parse(await fsp.readFile(path.join(dir, "masker.json"), "utf8"));
  const packetIndex = JSON.parse(await fsp.readFile(path.join(dir, "packets.json"), "utf8"));
  const responses = (await fsp.readdir(respDir))
    .filter(f => /^RESPONSE_.+\.json$/i.test(f))
    .sort();
  if (!responses.length) throw new Error(`no RESPONSE_*.json in ${respDir}`);
  log(`${responses.length} response file(s) in ${respDir}`);

  const session = await openSession();
  try {
    await loadAppAndPdfs(session);
    const { page } = session;

    // Rebuild the packets so the page is in exactly the post-build state,
    // then overwrite the freshly seeded jobMasker with the SAVED dictionary.
    // The dictionary is what restoreMaskedFindings() reads, so it must be the
    // one that produced the TEXT_* files, not a new random one.
    log("rebuilding packets in-session ...");
    const rebuilt = await buildPacketsInPage(page);
    log(`rebuilt ${rebuilt.length} packet(s)`);

    const injected = NO_MASK ? { surfaces: 0, byKey: 0 } : await page.evaluate((state) => {
      const d = window.__drv;
      const m = new d.Masker(state.seed || 1);
      m.surfaces = new Map(state.surfaces);
      m.byKey = new Map(state.byKey);
      m.occurrences = state.occurrences || [];
      d.setMasker(m);
      const back = d.getMasker();
      return { surfaces: back.surfaces.size, byKey: back.byKey.size };
    }, maskerState);
    log(NO_MASK ? "masker: --no-mask のため注入なし"
      : `masker injected: ${injected.surfaces} surfaces / ${injected.byKey} keys`);

    // Sanity: the rebuilt masked text must match the saved TEXT_* byte for byte
    // when re-masked through the injected dictionary (same symbols).
    for (const p of rebuilt) {
      const saved = await fsp.readFile(path.join(dir, `RAW_${p.packet_id}.txt`), "utf8").catch(() => null);
      if (saved !== null && saved !== p.rawText) {
        warn(`${p.packet_id}: rebuilt RAW text differs from the saved one (non-deterministic extraction?)`);
      }
    }

    for (const file of responses) {
      const packetId = file.replace(/^RESPONSE_/, "").replace(/\.json$/i, "");
      const body = await fsp.readFile(path.join(respDir, file), "utf8");
      log(`importing ${file} (packet ${packetId}) ...`);

      const before = await page.textContent("#importStatus");
      await page.fill("#responseText", body);
      await page.click("#importBtn");

      // Import is async (quote/page correction reads the PDF text layers).
      // Wait for the status to change, then for it to stop changing.
      await page.waitForFunction(
        (prev) => document.getElementById("importStatus").textContent !== prev,
        before, { timeout: 120000 });
      await waitForStableText(page, "#importStatus", 1500, 120000);
      const status = (await page.textContent("#importStatus")).trim();
      log(`  importStatus: ${status}`);
      if (/取り込みエラー/.test(status)) throw new Error(`import failed for ${file}: ${status}`);
    }

    const findingsCount = await page.evaluate(() => window.__drv.getFindings().length);
    log(`findings in app: ${findingsCount}`);
    if (!findingsCount) warn("no findings imported - the JSON export will be empty");

    log("exporting JSON report ...");
    await page.waitForFunction(() => !document.getElementById("exportJsonBtn").disabled,
      null, { timeout: 30000 });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.click("#exportJsonBtn"),
    ]);
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await download.saveAs(outFile);
    log(`report written -> ${outFile} (suggested name: ${download.suggestedFilename()})`);

    // Round-trip proof: no placeholder symbols must survive in the report.
    const report = await fsp.readFile(outFile, "utf8");
    const leftovers = report.match(/⟦#[A-Z]{3}⟧/g) || [];
    if (leftovers.length) {
      warn(`report still contains ${leftovers.length} placeholder symbol(s): ${[...new Set(leftovers)].join(" ")}`);
    } else {
      log("round trip OK: no ⟦#XXX⟧ symbols left in the exported report");
    }
    void packetIndex;
  } catch (e) {
    session.dumpErrors();
    throw e;
  } finally {
    await session.close();
  }
}

async function waitForStableText(page, selector, stableMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const cur = await page.textContent(selector);
    if (cur !== last) { last = cur; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= stableMs) return last;
    await new Promise(r => setTimeout(r, 200));
  }
  return last;
}

// -------------------------------------------------------------------- mkfake
// Builds a minimal, app-shaped response JSON whose quote is copied verbatim
// out of a TARGET_CHECK block of the masked TEXT and contains a ⟦#XXX⟧ symbol.
async function cmdMkfake(opts) {
  const dir = path.resolve(opts.dir || "./packets");
  const outDir = path.resolve(opts.out || path.join(dir, "..", "responses"));
  const packets = JSON.parse(await fsp.readFile(path.join(dir, "packets.json"), "utf8"));
  await fsp.mkdir(outDir, { recursive: true });

  const only = opts.packet ? String(opts.packet) : packets[0].packet_id;
  const p = packets.find(x => x.packet_id === only);
  if (!p) throw new Error(`packet ${only} not in packets.json`);

  const masked = await fsp.readFile(path.join(dir, `TEXT_${p.packet_id}.txt`), "utf8");
  const lines = masked.split(/\r?\n/);

  // Walk only TARGET_CHECK blocks; take the first line that carries a symbol.
  const HEADER = /^===== PDF P\.\d+ \/ (\S+) \/ 元PDF P\.(\d+) \/.*=====$/;
  let role = "", srcPage = 0, picked = null;
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) { role = m[1]; srcPage = Number(m[2]); continue; }
    if (role !== "TARGET_CHECK") continue;
    const t = line.trim();
    if (t.length >= 12 && t.length <= 400 && /⟦#[A-Z]{3}⟧/.test(t)) { picked = { quote: t, page: srcPage }; break; }
  }
  if (!picked) throw new Error(`no TARGET_CHECK line with a ⟦#XXX⟧ symbol in TEXT_${p.packet_id}.txt`);

  const response = {
    packet_id: p.packet_id,
    checked_pages: p.target_check_pages,
    target_context_pages: p.target_context_pages,
    reference_candidate_pages: p.reference_pages,
    target_language: "英語",
    reference_language: "日本語",
    findings: [{
      page: picked.page,
      reference_pages: p.reference_pages.slice(0, 1),
      reference_page: p.reference_pages[0] ?? null,
      reference_file: "",
      issue_scope: "translation_consistency",
      evidence_quality: "clear",
      reading_confidence: 0.9,
      issue_summary: "DRIVER FAKE: 数値プレースホルダーの復元確認用のダミー指摘です。",
      quote: picked.quote,
      reference_quote: "",
      category: "number_mismatch",
      severity: "low",
      suggestion: "（ダミー）このquoteの数値がREFと一致するか確認してください。",
      reason: "driver.mjs が生成した往復テスト用のダミー指摘です。",
      confidence: 0.5,
      needs_human_review: true,
    }],
    omitted_uncertain_findings: 0,
    read_error: "",
    reviewed_target_page_count: p.target_check_pages.length,
    no_findings_reason: "",
  };
  const file = path.join(outDir, `RESPONSE_${p.packet_id}.json`);
  await fsp.writeFile(file, JSON.stringify(response, null, 2), "utf8");
  log(`fake response -> ${file}`);
  log(`  page=${picked.page}`);
  log(`  quote=${picked.quote}`);
  return file;
}

// ---------------------------------------------------------------------- main
const USAGE = `usage:
  node driver.mjs build  --out <dir>
  node driver.mjs mkfake --dir <dir> [--out <responsesDir>] [--packet PACKET_001]
  node driver.mjs import --dir <dir> --responses <dir2> --out <report.json>
`;

const { cmd, opts } = parseArgs(process.argv);
NO_MASK = !!opts["no-mask"];
if (opts.target) TARGET_PDF = path.resolve(String(opts.target));
if (opts.ref) REF_PDF = path.resolve(String(opts.ref));
if (opts.range) PAGE_RANGE = String(opts.range);
if (opts.chunk) CHUNK_SIZE = Number(opts.chunk) || CHUNK_SIZE;
if (opts["expect-packets"]) EXPECT_PACKETS = Number(opts["expect-packets"]) || 0;
try {
  if (cmd === "build") await cmdBuild(opts);
  else if (cmd === "import") await cmdImport(opts);
  else if (cmd === "mkfake") await cmdMkfake(opts);
  else { console.log(USAGE); process.exit(cmd ? 2 : 0); }
} catch (err) {
  console.error("[driver] FAILED:", err?.stack || err);
  await removePatchedIndex();
  process.exit(1);
}
void fileURLToPath;
