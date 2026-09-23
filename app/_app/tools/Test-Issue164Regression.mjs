// Regression coverage for issue #164: the second automatic proofreading sample
// must be an independent pass, not a resend of the first request.
//
//   node tools/Test-Issue164Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
function extractFunction(name) {
  let start = indexHtml.indexOf(`async function ${name}(`);
  if (start < 0) start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = indexHtml.indexOf(") {", start) + 2; i < indexHtml.length; i++) {
    if (indexHtml[i] === "{") depth++;
    else if (indexHtml[i] === "}" && --depth === 0) return indexHtml.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}
function extractLine(prefix) {
  const start = indexHtml.indexOf(prefix);
  if (start < 0) throw new Error(`${prefix} not found`);
  return indexHtml.slice(start, indexHtml.indexOf("\n", start));
}

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); failures.push(name); }
};

// Helpers this test does not care about resolve to a stub returning "".
// Everything the assertions depend on is either extracted from index.html or
// given explicitly below.
function load(names, overrides) {
  const context = vm.createContext({ ...overrides });
  const source = [
    extractLine("const MASKING_ENABLED"),
    extractLine("const AUTO_SAMPLE_STRATEGIES"),
    ...names.map(extractFunction),
  ].join("\n");
  const stubbed = new Proxy(context, {
    has: (target, key) => typeof key === "string" && !(key in globalThis) && !(key in target),
    get: () => () => "",
  });
  context.__stubs = stubbed;
  vm.runInContext(`with (__stubs) { ${source}; Object.assign(globalThis, { ${names.join(", ")} }); }`, context);
  return context;
}

const packet = {
  packetId: "PACKET_001", kind: "proofread", targetCheckPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  targetContextPages: [], referenceSections: [], referenceCandidatePages: [],
  targetLanguage: "英語", referenceLanguage: "日本語",
};
const overrides = {
  originalFileName: "sample.pdf",
  safeFileBase: name => String(name).replace(/\.pdf$/i, ""),
  pagesToRangeText: pages => pages.length ? `${pages[0]}-${pages[pages.length - 1]}` : "",
  makeAllPackets: () => [{ ...packet }],
  makeCurrentPacket: () => ({ ...packet }),
  buildPacketTextSidecar: async () => ({ text: "RAW", localReview: null }),
  applyMasking: () => ({ text: "MASKED", pdf_base64: "" }),
  lastAutoPacketPageMaps: null,
  lastPacketLocalReviews: null,
};
const app = load([
  "normalizeAutoSamplingOptions", "withAutoSampleSuffix", "autoSampleStrategyPrompt", "fileRangePart",
  "packetPdfFileName", "packetPromptFileName", "packetTextFileName",
  "buildPacketPromptText", "buildConsistencyPromptText", "buildAutoPackets",
], overrides);

// --- 1. the default second sample uses a different procedure ---
{
  const { strategies } = app.normalizeAutoSamplingOptions({});
  check("既定の2サンプルは baseline と reverse", JSON.stringify(strategies) === '["baseline","reverse"]', JSON.stringify(strategies));
  const three = app.normalizeAutoSamplingOptions({ samples: 3 }).strategies;
  check("3サンプルの既定は baseline / reverse / ledger", JSON.stringify(three) === '["baseline","reverse","ledger"]', JSON.stringify(three));
  const explicit = app.normalizeAutoSamplingOptions({ samples: 2, strategies: ["baseline", "baseline"] }).strategies;
  check("明示した strategies はそのまま使う", JSON.stringify(explicit) === '["baseline","baseline"]', JSON.stringify(explicit));
}

// --- 2. the _S2 prompt names the files that are actually attached ---
{
  const payloads = await app.buildAutoPackets(true, {});
  const [first, second] = payloads;
  check("既定で2つのサンプルを作る", payloads.length === 2, String(payloads.length));
  check("_S2 の添付TEXT名は TEXT_PACKET_001_TARGET_P1-10_S2.txt", second?.text_name === "TEXT_PACKET_001_TARGET_P1-10_S2.txt", second?.text_name);
  check("_S2 の依頼文が実際の添付TEXT名を読むよう指示する", second?.prompt.includes(`「${second?.text_name}」`));
  check("_S2 の依頼文に添付していないTEXT名が無い", !second?.prompt.includes("TEXT_PACKET_001_S2_TARGET_P1-10.txt"));
  check("_S2 の依頼文は1回目と別の手順（逆順走査）", second?.prompt.includes("末尾からの逆順走査"));
  check("1回目の依頼文は従来どおり自分の添付TEXT名を読む", first?.prompt.includes(`「${first?.text_name}」`) && first?.text_name === "TEXT_PACKET_001_TARGET_P1-10.txt", first?.text_name);
  check("_S2 の回答 packet_id は PACKET_001_S2", second?.packet_id === "PACKET_001_S2" && second?.prompt.includes('packet_id は "PACKET_001_S2"'));
}

// --- 3. the escape instruction keeps its backslashes ---
{
  const proofread = app.buildPacketPromptText({ ...packet });
  check("校正の依頼文に「直前に \\ を付けて（\\*2 のように）」が届く",
    proofread.includes("直前に \\ を付けてください（\\*2 のように）"));
  const consistency = app.buildPacketPromptText({ ...packet, kind: "consistency" });
  check("整合性確認の依頼文にも「\\*2」が届く",
    consistency.includes("直前に \\ を付けてください（\\*2 のように）"));
}

if (failures.length) {
  console.error(`\nTest-Issue164Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue164Regression: PASS");
