// Test-CopilotSamplingRounds.mjs — 校正の独立サンプル実験配線を確認する。
//
// 製品既定は独立 baseline 2サンプル。benchmark の startProofread({ samples,
// strategies }) は同じ product path で1〜3サンプルを比較できる。これはモデル出力の
// 一致を保証する仕組みではない。各サンプルの回答を既存 importResponse /
// dedupeFindings へ通し、厳格な品質ゲートを保った deterministic union を測る。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = path => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const html = read("index.html");
const driver = read("tools/Run-Benchmark.ps1");
const server = read("src/Server.ps1");
const reviewJob = read("src/ReviewJob.ps1");
const numericContext = read("js/numeric-source-context.mjs");

let failures = 0;
const t = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};

const buildStart = html.indexOf("async function buildAutoPackets");
const buildEnd = html.indexOf("\n    // 観点を1つに絞る差し込み文", buildStart);
const build = buildStart >= 0 && buildEnd > buildStart ? html.slice(buildStart, buildEnd) : "";
const samplingStart = html.indexOf("const AUTO_SAMPLE_STRATEGIES");
const sampling = samplingStart >= 0 && buildEnd > samplingStart ? html.slice(samplingStart, buildEnd) : "";
const hookStart = html.indexOf("window.__koseiBenchmark = {");
const hookEnd = html.indexOf("\n    };", hookStart);
const hook = hookStart >= 0 && hookEnd > hookStart ? html.slice(hookStart, hookEnd) : "";
const fullStart = html.indexOf("async function startFullReview");
const fullEnd = html.indexOf("\n    async function startAutoReview", fullStart);
const fullReview = fullStart >= 0 && fullEnd > fullStart ? html.slice(fullStart, fullEnd) : "";

// --- 1. expansion の契約 -----------------------------------------------
t("buildAutoPackets が samples/options を受け取る",
  /async function buildAutoPackets\(all, options = \{\}\)/.test(html)
  && /normalizeAutoSamplingOptions\(options\)/.test(build));
t("サンプル数は1〜3に制限され、製品既定は2",
  /rawSamples.*Number\(options\?\.samples\)/.test(sampling)
  && /rawSamples >= 1 && rawSamples <= 3/.test(sampling)
  && /: 2;/.test(sampling));
t("戦略allowlistは baseline / reverse / ledger",
  /Object\.freeze\(\["baseline", "reverse", "ledger"\]\)/.test(sampling)
  && /AUTO_SAMPLE_STRATEGIES\.includes\(strategy\)/.test(sampling));
t("サンプル1のpacket_idと旧payload順を維持する",
  /sampleNo === 1 \? effectivePacket\.packetId/.test(build)
  && /sampleNo === 1 && strategy === "baseline"/.test(build)
  && /buildPacketPromptText\(effectivePacket\) \+ autoPromptSuffix\(\) \+ maskingPromptSection\(hasRef\) \+ headingIndex/.test(build));
t("サンプル2/3は一意の _S2/_S3 packet_id",
  /`\$\{effectivePacket\.packetId\}_S\$\{sampleNo\}`/.test(build));
t("suffix helper はsample1を維持し2/3を衝突なしにする",
  /function withAutoSampleSuffix\(name, sampleNo\)/.test(sampling)
  && (() => {
    const suffix = (name, n) => n <= 1 ? String(name) : String(name).replace(/(\.[^.]+)$/, `_S${n}$1`);
    const names = [1, 2, 3].map(n => suffix("PROMPT_PACKET.txt", n));
    return names[0] === "PROMPT_PACKET.txt" && new Set(names).size === 3;
  })());
t("prompt/text/pdf 名にサンプル suffix を使う",
  /withAutoSampleSuffix\(packetPromptFileName\(effectivePacket\), sampleNo\)/.test(build)
  && /withAutoSampleSuffix\(packetTextFileName\(effectivePacket\), sampleNo\)/.test(build)
  && /withAutoSampleSuffix\(packetPdfFileName\(effectivePacket\), sampleNo\)/.test(build));
t("PDFマスク時は空名を保ち、PDF添付時はサンプルごとに分ける",
  /pdf_name: pdf_base64 \? packetPdfFileName\(effectivePacket\) : ""/.test(build)
  && /sampleNo > 1 && pdf_base64/.test(build));
t("最終指示で回答 packet_id を expected id に上書きする",
  /回答JSONの packet_id は.*sampleId.*正確に書いてください/.test(build));
t("サンプルは同じ生成済み text/pdf を共有し、添付内容を変えない",
  /const \{ text, pdf_base64 \} = applyMasking\(rawText, pdfBytes, effectivePacket\.packetId\)/.test(build)
  && /text,\n\s+text_name: textName,\n\s+pdf_base64/.test(build));
t("元データ/PDF/TEXTの生成は sample loop の外側で一度だけ",
  build.indexOf("const pdfBytes = await buildReviewPacketPdfBytes(effectivePacket);") < build.indexOf("for (let sampleNo")
  && build.indexOf("const rawText = await buildPacketTextSidecar(effectivePacket);") < build.indexOf("for (let sampleNo"));

// --- 2. 独立探索 strategy と厳格 gate ----------------------------------
const strategyStart = html.indexOf("function autoSampleStrategyPrompt");
const strategyEnd = html.indexOf("\n    async function buildAutoPackets", strategyStart);
const strategy = strategyStart >= 0 && strategyEnd > strategyStart ? html.slice(strategyStart, strategyEnd) : "";
t("baseline はプロンプトを変更しない",
  /if \(strategy === "baseline"\) return ""/.test(strategy));
t("reverse は末尾からの汎用走査手順を持つ",
  /末尾ページから先頭ページへ逆順/.test(strategy)
  && /表・注記・脚注・表の但し書き/.test(strategy)
  && /否定、条件/.test(strategy));
t("ledger はページ別の汎用棚卸し手順を持つ",
  /ページごとに/.test(strategy)
  && /各数値\/日付\/単位/.test(strategy)
  && /表頭・注記・脚注・但し書き/.test(strategy));
t("reverse/ledger は candidateValidationPromptSection を再利用する",
  (strategy.match(/candidateValidationPromptSection\(hasRef\)/g) || []).length === 1
  && /件数ノルマはありません/.test(strategy));
t("strategy 文面に fixture 固有語を埋め込まない",
  !/(Mazda|Shionogi|aoi-long|Q[14]|fixture)/i.test(strategy));

// --- 3. 同じ ordinary job と既存取り込み --------------------------------
t("全サンプルを一つの packets 配列へ積む",
  /const out = \[\];/.test(build)
  && /out\.push\(payload\)/.test(build)
  && /const packets = await buildAutoPackets\(all, sampling\)/.test(html));
t("同一jobにそのまま送信し、サンプル間の依存/digestを作らない",
  /submitAndPollAutoJob\(packets\)/.test(html)
  && !/priorDigest/.test(build)
  && !/ChatMode|Reuse|stability_mode|stable-replay/i.test(build));
t("Serverは各ordinary packetの expected packet_id を保存する",
  /\$packetId = \[string\]\$p\.packet_id/.test(server)
  && /packet_id\s+=\s+\$packetId/.test(server));
t("proofreadのReviewJobに強制multipass/Reuse変更を入れていない",
  /\$packetEngine = if \(\[string\]\$Packet\.kind -eq 'consistency'\) \{ 'multipass' \}/.test(reviewJob)
  && !/proofread2/.test(reviewJob));
t("既存の applyAutoAnswer/importResponse/dedupeFindings を通す",
  /async function applyAutoAnswer/.test(html)
  && /await importResponse\(\)/.test(html)
  && /dedupeFindings/.test(html));
t("数値同値判定は取込中だけ共有context helper/optionsを渡す",
  /import \{ collectNumericFindingContexts \} from ".\/js\/numeric-source-context\.mjs";/.test(html)
  && /const numericContextOptions = \{[\s\S]*?targetTextFor:[\s\S]*?referenceTextFor:[\s\S]*?referenceSourceFor[,\s][\s\S]*?\};/.test(html)
  && /collectNumericFindingContexts\(rawFindings,\s*numericContextOptions\)/.test(html)
  && /collectNumericFindingContexts\(restoredFindings,\s*numericContextOptions\)/.test(html)
  && /partitionNumericFalsePositives\([\s\S]*forFinding: contextForFinding/.test(html)
  && /findUniqueNumericSourceContext/.test(numericContext)
  && /function sameAuthoritativeNumericColumns/.test(read("js/review-merge.mjs")));
t("packetごとのページmapとretry payloadを保持する",
  /lastAutoPacketPageMaps\.set\(sampleId/.test(build)
  && /lastAutoPayloadByPacket = new Map\(packets\.map\(pl => \[pl\.packet_id, pl\]\)\)/.test(html));

// --- 4. product hook / benchmark ---------------------------------------
t("benchmark startProofread は同じ startAutoReview 経路に options を渡す",
  /startProofread\(opts\)/.test(hook)
  && /startAutoReview\(true, opts \|\| \{\}\)/.test(hook));
t("通常の製品ボタン・visibility resumeは既定samplingを維持し、full reviewはstage3 builderへ渡す",
  /async function startAutoReview\(all, samplingOptions = \{\}\)/.test(html)
  && (html.match(/startAutoReview\(true\);/g) || []).length >= 1
  && /autoReviewBtn\) els\.autoReviewBtn\.addEventListener\("click", \(\) => startAutoReview\(true\)\)/.test(html)
  && /autoReviewAllBtn\) els\.autoReviewAllBtn\.addEventListener\("click", \(\) => startAutoReview\(true\)\)/.test(html)
  && /const samples = .*: 2;/.test(sampling)
  && /独立\$\{sampling\.samples\}回で見落としを減らします/.test(html)
  && /async function buildFullRunPackets/.test(html)
  && /const pages = await buildAutoPackets\(true\)/.test(html)
  && /const completedState = await submitAndPollAutoJob\(packets\)/.test(html)
  && !/startAutoReview\(true/.test(fullReview));
t("旧proofread2/_R2/Reuse/cache機構を追加していない",
  !/proofreadRound2PromptSection|roundPacketId|stable-replay|stability_mode/i.test(`${html}\n${driver}`)
  && !/proofread2/.test(html));
t("PASS_LENS_LABELS に proofread sample lens を追加していない",
  !/proofread:\s*"/.test(html.slice(html.indexOf("const PASS_LENS_LABELS"), html.indexOf("function passLensLabel"))));

const experiments = ["proofread10x2same", "proofread10x2reverse", "proofread10x3strategies"];
t("benchmark に3つの独立サンプル構成を定義",
  experiments.every(name => new RegExp(`name = '${name}'`).test(driver)));
t("benchmark のサンプル構成は正しい strategy 配列を持つ",
  /proofread10x2same[^\n]*samples = 2[^\n]*strategies = @\('baseline','baseline'\)/.test(driver)
  && /proofread10x2reverse[^\n]*samples = 2[^\n]*strategies = @\('baseline','reverse'\)/.test(driver)
  && /proofread10x3strategies[^\n]*samples = 3[^\n]*strategies = @\('baseline','reverse','ledger'\)/.test(driver));
t("benchmark は options を startProofread にJSONで渡す",
  /ConvertTo-Json @\(\$cfg\.strategies\) -Compress/.test(driver)
  && /startProofread\(" \+ \$proofreadOpts \+ "\)/.test(driver));
t("benchmark の標準校正は samples=1 を明示して基準値を測る",
  /name = 'proofread10'[^\n]*samples = 1[^\n]*strategies = @\('baseline'\)/.test(driver)
  && /cfg\.ContainsKey\('samples'\)/.test(driver)
  && /startProofread\(" \+ \$proofreadOpts \+ "\)/.test(driver));

// --- 5. consistency の安全境界 -----------------------------------------
const consistencyStart = html.indexOf("async function startConsistencyReview");
const consistencyEnd = html.indexOf("\n    async function ", consistencyStart + 20);
const consistency = consistencyStart >= 0 && consistencyEnd > consistencyStart
  ? html.slice(consistencyStart, consistencyEnd) : "";
t("整合性はR1が0件でもR2をskipしない",
  !/ラウンド1で指摘が0件だったので、ラウンド2は行いません/.test(consistency)
  && /for \(let round = resumeRound; round <= rounds; round\+\+\)/.test(consistency)
  && /buildConsistencySectionPackets\(roundOpts\)/.test(consistency));
t("整合性の既存priorDigestは補助として維持",
  /priorDigest: priorFindingsDigest\(\)/.test(consistency));

if (failures) { console.error(`\nTest-CopilotSamplingRounds: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-CopilotSamplingRounds: PASS");
