import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  PDFJS_EXTRACT_SCHEMA, PDFJS_BUNDLED_VERSION, TEXT_RECONSTRUCTION_VERSION,
  EXTRACT_TEXT_SEPARATOR, sha256Text,
} from "./pdfjs-headless-runner.mjs";

let bad = 0;
const t = (name, ok, detail = {}) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { bad++; console.error("      ", JSON.stringify(detail)); }
};

const dir = mkdtempSync(join(tmpdir(), "kosei-mask-audit-"));
const here = dirname(fileURLToPath(import.meta.url));
try {
  const input = join(dir, "extract.json");
  const output = join(dir, "audit.json");
  const pages = [
    "グローバル販売台数は304千台となりました。\n（単位：千台）\n計 301 304 +4 +1.2%",
    "(単位：千台／億円)\n(左肩：売上高利益率)\n％ ％ ％ ％\n計 3 10,998 △8.8 12,857 +16.9\n日 本 29 32 +10.5 33 +2.7\n北 米 30 147 +0.7 154 +4.8\n計 34 301 △2.8 304 +1.2",
  ];
  const validExtract = { schema: PDFJS_EXTRACT_SCHEMA, source: "mazda-mini.pdf",
    sourceSha256: "0".repeat(64), pdfjsVersion: PDFJS_BUNDLED_VERSION,
    reconstructionVersion: TEXT_RECONSTRUCTION_VERSION,
    textSha256: sha256Text(pages.join(EXTRACT_TEXT_SEPARATOR)), pages };
  writeFileSync(input, JSON.stringify(validExtract));
  const run = spawnSync(process.execPath, [join(here, "Audit-ExtractedMask.mjs"), input, "--lang", "ja", "--json", output], { encoding: "utf8" });
  t("抽出済みJSONをブラウザ無しで再監査できる", run.status === 0, { status: run.status, stderr: run.stderr, stdout: run.stdout });
  const audit = JSON.parse(readFileSync(output, "utf8"));
  const amount304 = audit.occurrences.filter(x => x.raw.replace(/[,\s]/g, "") === "304" && x.namespace === "amount");
  t("監査JSONへchosenExp/family/source/namespaceを保存する",
    amount304.length >= 2 && amount304.every(x => Object.hasOwn(x, "chosenExp")
      && Object.hasOwn(x, "family") && Object.hasOwn(x, "source") && Object.hasOwn(x, "namespace")), { amount304 });
  const split304 = audit.splits.find(x => x.surface === "304");
  t("同じ表記の単位解釈割れを桁差の種類にかかわらず警告する",
    new Set(amount304.map(x => x.micro)).size === 1 || split304?.suspicious === true,
    { amount304, split304 });
  t("監査JSONへ単位メタデータ矛盾の一覧を保存する", Array.isArray(audit.metadataIssues), audit.metadataIssues);

  for (const [name, patch] of [
    ["本文改変", { pages: [...pages.slice(0, -1), pages.at(-1) + "x"] }],
    ["PDF.js版不一致", { pdfjsVersion: "0.0.0" }],
    ["行復元版不一致", { reconstructionVersion: "legacy" }],
    ["schema欠落", { schema: undefined }],
  ]) {
    const badInput = join(dir, `${name}.json`);
    const changed = { ...validExtract, ...patch };
    if (patch.schema === undefined) delete changed.schema;
    writeFileSync(badInput, JSON.stringify(changed));
    const rejected = spawnSync(process.execPath, [join(here, "Audit-ExtractedMask.mjs"), badInput], { encoding: "utf8" });
    t(`古い・改変済みsidecarを拒否: ${name}`, rejected.status !== 0,
      { status: rejected.status, stdout: rejected.stdout, stderr: rejected.stderr });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (bad) { console.error(`\nTest-MaskAudit: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-MaskAudit: PASS");
