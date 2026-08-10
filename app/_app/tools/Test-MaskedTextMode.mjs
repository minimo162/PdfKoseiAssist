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
t("マスキング時は pdf_base64 を空にする",
  /return \{ text: maskSidecarTextForSend\(rawText, packetId\), pdf_base64: "" \}/.test(html));
t("PDF名も空にする（中身が無いのに名前だけ残さない）",
  /pdf_name: pdf_base64 \? packetPdfFileName\(effectivePacket\) : ""/.test(html));
t("attach_mode を masked-text で送る",
  /attach_mode: MASKING_ENABLED \? "masked-text" : "pdf"/.test(html));
t("送信前検証に落ちたら例外で止める（警告で済ませない）",
  /if \(!v\.ok\) \{[\s\S]{0,400}throw new Error/.test(html));
t("サイドカーは役割ごとに言語を分けて masker にかける（通しがけにしない）",
  /maskSidecarByRole\(rawText, jobMasker\)/.test(html) && !/mask\(rawText, "ja"\)/.test(html));
t("校正・整合性の両方でマスクを通す（呼び出しが2箇所）",
  (html.match(/= applyMasking\(rawText, pdfBytes/g) || []).length === 2);
// 記号比較は続けるが、同じ指標・期間・範囲という立証が無い組は誤指摘になる。
t("REFあり／なしの双方に条件付きの記号照合手順がある",
  /同じ指標・同じ期間・同じ連結\/単体範囲/.test(html)
  && /REFは無いので、TARGET_CHECK内部/.test(html)
  && /対応するREFが無い、期間や範囲が不明/.test(html));
t("実量で振ってあることと単位スケールの例を示す",
  /48百万円 と 48 thousand yen → 違う記号/.test(html) && /12億円   と 1\.2 billion yen → 同じ記号/.test(html));
t("記号差だけで断定せず、同一scopeの肯定的根拠を必須にする",
  /不一致と断定できるのは、同じ指標・期間・範囲・実績\/予想区分/.test(html)
  && /伏字から大小関係、加減算、合計、増減率を推測・再計算しない/.test(html));
t("校正・整合性の両方のプロンプトに足す",
  (html.match(/\+ maskingPromptSection\(hasRef\)/g) || []).length === 2);
t("指摘の記号を人が読める数値へ戻す", /restoreMaskedFindings\((?:coerceFindings\(data\)|maskedNumericFilter\.kept)\)/.test(html));
// ⚠️ 実測（20260804のマスク実行）: reason だけ戻して displayReason を落としていたため、
//    レポートの「理由」に ⟦#WXY⟧ が残った。列挙方式はまた漏れるので、全文字列を走査する。
t("記号を含む文字列フィールドを全部戻す（列挙漏れで ⟦#XXX⟧ がレポートに残らない）",
  /for \(const \[key, value\] of Object\.entries\(f\)\)[\s\S]{0,220}value\.includes\("⟦#"\)/.test(html));
t("戻すときに言語を取り違えない（quote は英・それ以外は日）",
  /EN_FIELDS = new Set\(\["quote", "suggestion", "areaHint"\]\)/.test(html) &&
  /EN_FIELDS\.has\(key\) \? en\(value\) : ja\(value\)/.test(html));

// --- マスキング時のプロンプト（添付していないPDFを参照させない） ---------
// ⚠️ 実測（20260804のマスク実行）: プロンプト1行目が「添付した確認用PDF…を確認してください」
//    のままだった。存在しない添付を探させると read_error か指摘の取りこぼしになる。
t("マスキング時はPDFを添付していないと明言する",
  /\*\*今回はPDFを添付していません。\*\*/.test(html) && /存在しない添付PDFを探さないでください/.test(html));
t("マスキング時は字形・レイアウトを根拠にさせない",
  /字形・フォント・見た目の潰れ・レイアウト・罫線・桁揃えを根拠にした指摘は返さないでください/.test(html));
t("マスキング時は read_error の条件からPDFを外す",
  /MASKING_ENABLED \? "TEXTを確認できない場合" : "添付PDFまたはTEXTを確認できない場合"/.test(html));
t("手動ZIPにもPDFを入れない（READMEどおり添付されると伏せた意味が消える）",
  /if \(!MASKING_ENABLED\) files\.push\(\{ name: packetPdfFileName\(effectivePacket\), bytes: pdfBytes \}\)/.test(html));
t("手動ZIPのTEXTもマスクして書き出す",
  /const maskedText = maskSidecarTextForSend\(rawText, effectivePacket\.packetId\)/.test(html)
  && /packetTextFileName\(effectivePacket\), bytes: encodeUtf8\(maskedText\)/.test(html));
t("READMEに辞書がタブ内にしかないことを書く",
  /ページを閉じたり再読み込みしたりすると戻せなくなります/.test(html));

// --- サーバ（多層防御） -------------------------------------------------
t("Server.ps1 が masked-text を判定する", /\$maskedMode = \(\[string\]\$Body\.attach_mode -eq 'masked-text'\)/.test(server));
t("masked-text なら PDF を保存しない", /if \(-not \$maskedMode -and -not \[string\]::IsNullOrWhiteSpace\(\[string\]\$p\.pdf_base64\)\)/.test(server));
t("捨てたことをログに残す", /masked-text なので PDF を破棄しました/.test(server));

// --- ジョブ実行 ---------------------------------------------------------
t("ReviewJob.ps1 が masked-text を受理する", /@\('pdf','text','masked-text'\) -notcontains \$mode/.test(job));
t("masked-text の添付に pdf_path を含めない",
  /elseif \(\$State\.attach_mode -eq 'masked-text'\)[\s\S]{0,400}\$attach = @\(\[string\]\$Packet\.prompt_path, \[string\]\$Packet\.text_path\)/.test(job));
{
  const i = job.indexOf("elseif ($State.attach_mode -eq 'masked-text')");
  const block = job.slice(i, i + 1600);
  t("masked-text ブロックに pdf の添付が一切ない", !/\$attach\s*=\s*@\([^)]*pdf_path/.test(block));
  t("それでも pdf_path が来たら警告する", /masked-text なのに pdf_path があります/.test(block));
}
t("Settings に masked-text の説明がある", /'pdf' \| 'text' \| 'masked-text'/.test(settings));

if (bad) { console.error(`\nTest-MaskedTextMode: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-MaskedTextMode: PASS");
