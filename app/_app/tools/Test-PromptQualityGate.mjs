// Copilot側で誤候補を最終回答へ入れず、代わりの有効候補を再探索する指示を固定する。
// 後段フィルターだけを強くすると、候補枠を誤指摘が消費して画面だけが空になるため、
// 初回プロンプトと全追撃プロンプトの両方に同じ立証責任が必要。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(join(here, "..", file), "utf8");
const html = read("index.html");
const reviewJob = read("src/ReviewJob.ps1");

let failures = 0;
const test = (name, condition) => {
  if (condition) console.log("  ok   " + name);
  else { failures++; console.error("  FAIL " + name); }
};

test("初回の校正・整合性プロンプトへ共通ゲートを入れる",
  (html.match(/\$\{candidateValidationPromptSection\(hasRefInPacket\)\}/g) || []).length === 2);
test("並列の観点指示より後にも共通ゲートを再掲する",
  /prompt: basePrompt \+ suffix \+ \(suffix \? "\\n\\n" \+ candidateValidationPromptSection\(hasRef\)/.test(html));
test("候補数を成果とせず最低件数を要求しない",
  /指摘件数のノルマや最低件数はありません/.test(html)
  && /候補を見つけただけで「十分な件数を確認した」と考えず/.test(html));
test("落とした候補の代わりに未確認箇所を再探索する",
  /不合格なら findings へ入れず、まだ見ていないページ・注記・見出し・表・脚注から別の候補を探してください/.test(html)
  && /不合格を捨てた後、検証合格が少ないページをもう一巡/.test(html));
test("quoteを対象ページの一意な原文として検証する",
  /quote はそのpageのTEXTから一字一句コピーできるか/.test(html)
  && /同じページ内で対象箇所を一意に識別できるか/.test(html));
test("翻訳scopeとTARGET単体校正を分離する",
  /REFを実際に根拠として使った指摘だけ issue_scope="translation_consistency"/.test(html)
  && /TARGETだけで完結する英語校正・文書内整合は issue_scope="english_proofreading" または "consistency"/.test(html));
test("翻訳指摘はREFの3項目を必須にし、欠落候補を置換する",
  /reference_file、reference_pages、reference_quote の3項目をすべて埋め/.test(html)
  && /1項目でも空、ページ未特定、引用を推測した場合はその候補を削除し、別の候補を探してください/.test(html));
test("REFなしで翻訳指摘を推測させない",
  /REFはありません。translation_consistency、mistranslation、訳抜けなど、原文を推測する指摘は不合格/.test(html));
test("伏字TEXTでは組版・抽出差を候補段階で禁止する",
  /PDFを添付していないため、ハイフン・空白・改行・文字の見た目・レイアウトだけを根拠にする候補は検証不能/.test(html));
test("数値と欠番を最終回答前に再検証する",
  /同じ指標・期間・連結\/単体範囲・実績\/予想区分・単位/.test(html)
  && /アプリがTARGET_CHECKから抽出した番号付き見出し一覧/.test(html)
  && /reason に「アプリ抽出一覧に該当なし」と「番号＋見出し本文」を明記/.test(html));
test("伏字処理後のTEXTから番号付き見出し一覧を作って両経路へ渡す",
  (html.match(/buildNumberedHeadingIndexPrompt\((?:maskedText|text)\)/g) || []).length === 3
  && /prompt = buildPacketPromptText\(effectivePacket\).*\+ headingIndex/.test(html));
test("JSONひな型がquality gateを自分で破らない",
  (html.match(/"reading_confidence": 0\.9/g) || []).length >= 2
  && (html.match(/"confidence": 0\.9/g) || []).length >= 2
  && !/"reading_confidence": 0\.0/.test(html));

test("観点追撃とgap追撃も共通ゲートを使う",
  (reviewJob.match(/\$qualityGate = Get-KoseiCandidateValidationRules -HasRef \$HasRef/g) || []).length === 2
  && (reviewJob.match(/^\$qualityGate$/gm) || []).length === 2);
test("追撃も不合格候補を数えず代替候補を探す",
  /候補数ではなく、次の検証に合格した件数だけを成果/.test(reviewJob)
  && /その候補を件数に数えないでください。その後、まだ見ていないページ・注記・見出し・表・脚注から別の候補を探してください/.test(reviewJob));
test("追撃もREF有無で翻訳根拠をfail-closedにする",
  /翻訳整合・誤訳は、REFを実際に開き、reference_file、reference_pages、reference_quoteをすべて埋め/.test(reviewJob)
  && /REFはありません。翻訳整合・誤訳・訳抜けを推測せず/.test(reviewJob));
test("整合性JSONひな型も翻訳scopeとREF資料名を要求する",
  /"issue_scope": "consistency \| translation_consistency"/.test(html)
  && /"reference_file": "翻訳整合の場合のみPAGE_MAP記載のREF番号付きファイル名/.test(html));

if (failures) {
  console.error(`\nTest-PromptQualityGate: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-PromptQualityGate: PASS");
