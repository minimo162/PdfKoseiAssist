// Test-MaskedTextMode.mjs — マスキングの配線が3層そろっているかを検証する。
//
//   node tools/Test-MaskedTextMode.mjs
//
// クライアント（index.html）・サーバ（Server.ps1）・ジョブ実行（ReviewJob.ps1）の
// どれか1つでも欠けると「テキストは伏せたのにPDFは素通り」になる。
// 一番まずい壊れ方なので、3層それぞれを別に押さえる。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, "..", f), "utf8");
const html = read("index.html"), server = read("src/Server.ps1"),
      job = read("src/ReviewJob.ps1"), settings = read("src/Settings.ps1");

let bad = 0;
const t = (n, c, d) => { if (c) console.log("  ok   " + n); else { bad++; console.error("  FAIL " + n); if (d !== undefined) console.error("       " + d); } };

// --- クライアント -------------------------------------------------------
t("index.html が number-mask.mjs を読む", /import \{[^}]*Masker[^}]*\} from "\.\/js\/number-mask\.mjs"/.test(html));
t("マスカーはジョブ単位で共有する（日英で同じ記号を振るため）",
  /let jobMasker = null/.test(html) && (html.match(/jobMasker = null;\s*\/\//g) || []).length >= 2);
t("マスキング時は pdf_base64 を空にする", /return \{ text: masked, pdf_base64: "" \}/.test(html));
t("PDF名も空にする（中身が無いのに名前だけ残さない）",
  /pdf_name: pdf_base64 \? packetPdfFileName\(effectivePacket\) : ""/.test(html));
t("attach_mode を masked-text で送る",
  /attach_mode: MASKING_ENABLED \? "masked-text" : "pdf"/.test(html));
t("送信前検証に落ちたら例外で止める（警告で済ませない）",
  /if \(!v\.ok\) \{[\s\S]{0,400}throw new Error/.test(html));
t("校正・整合性の両方でマスクを通す（呼び出しが2箇所）",
  (html.match(/= applyMasking\(rawText, pdfBytes/g) || []).length === 2);
t("指摘の記号を人が読める数値へ戻す", /restoreMaskedFindings\(coerceFindings\(data\)\)/.test(html));
t("戻すときに言語を取り違えない（quote は英・referenceQuote は日）",
  /quote: en\(f\.quote\)[\s\S]{0,160}referenceQuote: ja\(f\.referenceQuote\)/.test(html));

// --- サーバ（多層防御） -------------------------------------------------
t("Server.ps1 が masked-text を判定する", /\$maskedMode = \(\[string\]\$Body\.attach_mode -eq 'masked-text'\)/.test(server));
t("masked-text なら PDF を保存しない", /if \(-not \$maskedMode -and -not \[string\]::IsNullOrWhiteSpace\(\[string\]\$p\.pdf_base64\)\)/.test(server));
t("捨てたことをログに残す", /masked-text なので PDF を破棄しました/.test(server));

// --- ジョブ実行 ---------------------------------------------------------
t("ReviewJob.ps1 が masked-text を受理する", /@\('pdf','text','masked-text'\) -notcontains \$mode/.test(job));
t("masked-text の添付に pdf_path を含めない",
  /elseif \(\$State\.attach_mode -eq 'masked-text'\)[\s\S]{0,400}\$attach = @\(\[string\]\$p\.prompt_path, \[string\]\$p\.text_path\)/.test(job));
{
  const i = job.indexOf("elseif ($State.attach_mode -eq 'masked-text')");
  const block = job.slice(i, i + 1600);
  t("masked-text ブロックに pdf の添付が一切ない", !/\$attach\s*=\s*@\([^)]*pdf_path/.test(block));
  t("それでも pdf_path が来たら警告する", /masked-text なのに pdf_path があります/.test(block));
}
t("Settings に masked-text の説明がある", /'pdf' \| 'text' \| 'masked-text'/.test(settings));

if (bad) { console.error(`\nTest-MaskedTextMode: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-MaskedTextMode: PASS");
