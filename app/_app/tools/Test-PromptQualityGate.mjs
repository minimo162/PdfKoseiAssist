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
const consistencyLensSource = key => html.match(
  new RegExp("^\\s{6}" + key + ": [\\s\\S]*?(?=^\\s{6}[a-z_]+:|(?![\\s\\S]))", "m"),
)?.[0] || "";

test("初回の校正・整合性プロンプトへ共通ゲートを入れる",
  /\$\{candidateValidationPromptSection\(hasRefInPacket, \{ lens: promptOptions\.lens, round: promptOptions\.round \}\)\}/.test(html)
  && /\$\{candidateValidationPromptSection\(hasRefInPacket\)\}/.test(html));
test("並列の観点指示より後にも共通ゲートを再掲する",
  /prompt: basePrompt \+ suffix \+ \(suffix \? "\\n\\n" \+ candidateValidationPromptSection\(hasRef, \{[\s\S]*?includeScopedRules: false/.test(html));
test("候補数を成果とせず最低件数を要求しない",
  /指摘件数のノルマや最低件数はありません/.test(html)
  && /候補を見つけただけで「十分な件数を確認した」と考えず/.test(html));
test("初回プロンプトは自然さだけの誤候補を捨て、高確信候補を保持して再走査する",
  /英語校正の正確性ゲート:[\s\S]*「こちらの方が自然」[\s\S]*KPI名・表ラベル・定義語・安定したハウススタイル[\s\S]*same-entity/.test(html)
  && /style\/idiomだけの候補[\s\S]*まだ確認していないページ・注記・見出し・表・脚注を再走査/.test(html)
  && /exact spelling corruption[\s\S]*broken parallel verb structure[\s\S]*impossible copula\/subject-complement grammar[\s\S]*repeated defective sentence[\s\S]*defined-term number\/case contradiction[\s\S]*duplicated or semantically wrong neighboring table row labels/.test(html));
test("ReviewJobの全追撃プロンプトも同じ誤候補ガードと高確信再走査を含む",
  /英語校正の正確性ゲート:[\s\S]*「こちらの方が自然」[\s\S]*KPI名・表ラベル・定義語・安定したハウススタイル[\s\S]*same-entity/.test(reviewJob)
  && /style\/idiomだけの候補[\s\S]*まだ確認していないページ・注記・見出し・表・脚注を再走査/.test(reviewJob)
  && /exact spelling corruption[\s\S]*broken parallel verb structure[\s\S]*impossible copula\/subject-complement grammar[\s\S]*repeated defective sentence[\s\S]*defined-term number\/case contradiction[\s\S]*duplicated or semantically wrong neighboring table row labels/.test(reviewJob));
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
  /同じ指標・期間・連結\/単体範囲・実績\/予想区分などの比較scope/.test(html)
  && /アプリがTARGET_CHECKから抽出した番号付き見出し一覧/.test(html)
  && /reason に「アプリ抽出一覧に該当なし」と「番号＋見出し本文」を明記/.test(html));
test("候補検証gateはlens/round別にscoped rulesを一度だけ出す",
  /function candidateValidationPromptSection\(hasRef, promptOptions = \{\}\)/.test(html)
  && /const includeScopedRules = promptOptions\.includeScopedRules !== false/.test(html)
  && /\["broad", "gap"\]\.includes\(activeLens\)/.test(html)
  && /candidateValidationPromptSection\(hasRef, \{[\s\S]*?includeScopedRules: false/.test(html)
  && /5\. 数値比較なら/.test(html)
  && /6\. 欠番・参照欠落は/.test(html));
test("跨ぎ照合は対応を立証した目次・本文見出しの番号・単複差を報告対象にする",
  /CONSISTENCY_CROSS_LOCATION_PROCEDURE/.test(html)
  && /目次・番号付き一覧・箇条書き[\s\S]*対応する本文の見出し／番号付き見出し[\s\S]*単数／複数の違いも報告対象/.test(html)
  && /単数／複数だけを拾い、対応を立証できない場合[\s\S]*不一致としません/.test(html));
test("跨ぎ照合は本文と表ラベルを同じ分類・entityの根拠付きで比較する",
  /本文の文・段落と表頭・行ラベル[\s\S]*同じ分類・同じ entity（対象）[\s\S]*肯定的に確認/.test(html));
test("跨ぎ照合は節scopeと連結・非連結等の反対語を確認する",
  /周囲の節見出し・表題が示す scope[\s\S]*consolidated\/unconsolidated（連結／非連結）[\s\S]*同じ entity\/classification[\s\S]*肯定的/.test(html));
test("跨ぎ照合は両位置・両quote・同一scopeの根拠が無ければ0件にする",
  /両方の位置・両方の quote・同じ entity\/classification\/scope[\s\S]*曖昧な場合はその候補を出さず、findings は空配列/.test(html));
test("数値比較をmeasure familyと表scopeまでfail-closedにする",
  /単位\/measure familyの互換性/.test(html)
  && /両側で単位\/measure familyが明示されていて非互換なら絶対に報告しない/.test(html)
  && /同一表・同一行\/列・同じ表頭.*単位\/measure familyの欠落・曖昧さだけを理由に真の値差を捨てない/.test(html)
  && /単位\/measure familyを確認できない別表どうしは比較しない/.test(html)
  && /Total、Domestic、Overseas、Result、Plan/.test(html)
  && /比較scopeの必須項目が欠落・相違・曖昧なら/.test(html));
test("跨ページ数値は両側のunit captionを立証し、基準単位へ換算する",
  /CONSISTENCY_NUMERIC_UNIT_PROCEDURE/.test(html)
  && /跨ページの金額（通貨を伴う monetary amount）比較に限る/.test(html)
  && /両方の位置.*両方の短い quote.*単位 caption/.test(html)
  && /共通の基準単位へ換算し、表示桁の丸め幅を許容/.test(html)
  && /別ページ・別表の金額比較で、どちらか一方の単位 caption・通貨・scale が欠落、曖昧/.test(html)
  && /同じ表・同じ行／列・共通表頭などで同じ単位 scope\s*が確認できる場合/.test(html)
  && /件数・数量・比率・率などの非金額/.test(html)
  && /隣接する rate／percent 列は金額とは別/.test(html));
test("金額unit手順をbroadとnumbersだけへ差し込む",
  (html.match(/\$\{CONSISTENCY_NUMERIC_UNIT_PROCEDURE\}/g) || []).length === 2
  && /\$\{CONSISTENCY_NUMERIC_UNIT_PROCEDURE\}/.test(consistencyLensSource("numbers"))
  && !/\$\{CONSISTENCY_NUMERIC_UNIT_PROCEDURE\}/.test(consistencyLensSource("numbers_r2"))
  && /ものの数を述べている文/.test(consistencyLensSource("numbers_r2")));
test("観点レンズはTOC・用語手順を対象外へ漏らさない",
  /terms:\s*`\$\{CONSISTENCY_ENTITY_PROCEDURE\}\s*\n\$\{CONSISTENCY_SCOPE_PROCEDURE\}/.test(html)
  && /structure:\s*`\$\{CONSISTENCY_TOC_PROCEDURE\}/.test(html)
  && /terms_r2:\s*`\$\{CONSISTENCY_ENTITY_PROCEDURE\}\s*\n\$\{CONSISTENCY_SCOPE_PROCEDURE\}/.test(html)
  && /structure_r2:\s*`\$\{CONSISTENCY_TOC_PROCEDURE\}/.test(html)
  && /function consistencyBaseProcedureText\(lens, round = 1\)/.test(html)
  && /function consistencyFocusedChecklistText\(lens, round = 1\)/.test(html)
  && /const baseProcedureText = consistencyBaseProcedureText\(promptOptions\.lens, promptOptions\.round\)/.test(html)
  && /const focusedChecklistText = consistencyFocusedChecklistText\(promptOptions\.lens, promptOptions\.round\)/.test(html)
  && /\$\{focusedChecklistText \|\| `/.test(html)
  && /buildPacketPromptText\([\s\S]*\{ lens, round \}/.test(html)
  && !/numbers:\s*`\$\{CONSISTENCY_(?:CROSS_LOCATION|ENTITY|SCOPE|TOC)_PROCEDURE\}/.test(html)
  && !/numbers_r2:\s*`\$\{CONSISTENCY_(?:CROSS_LOCATION|ENTITY|SCOPE|TOC)_PROCEDURE\}/.test(html));
test("マスキングtailはplaceholder共通部と数値手順を観点別に分離する",
  /function maskingPromptSection\(hasRef, promptOptions = \{\}\)/.test(html)
  && /const focusedPlaceholderOnly = \["terms", "terms_r2", "structure", "structure_r2", "numbers_r2"\]/.test(html)
  && /const lensPromptTail = promptTail \+ maskingPromptSection\(hasRef, \{ lens, round \}\)/.test(html)
  && /本文中の ⟦#XXX⟧ は数値を伏せた記号です/.test(html)
  && /単位のスケール/.test(html));
test("numbers_r2のscope paragraphは重複しない",
  (consistencyLensSource("numbers_r2").match(/数値の比較を許すのは/g) || []).length === 1);
test("数値の符号・単位・欠落ダッシュを正規化してから判定する",
  /括弧の負数.*△100\.7.*▲100\.7/.test(reviewJob)
  && /million\/billion\/100 millions of yen.*百万円\/億円\/十億円/.test(reviewJob)
  && /ダッシュ（－\/—\/-）を欠落値と誤読せず/.test(reviewJob)
  && /正規化後に値が同じなら報告しない/.test(reviewJob));
test("日英PDFの目次ページ番号を直接比較せず同一PDF内で立証する",
  /TARGET と REFERENCE はページ割りが異なり得ます/.test(reviewJob)
  && /目次や相互参照の末尾ページ番号を両PDF間で直接比較せず/.test(reviewJob)
  && /同じPDF内の目次と実際の見出しページを照合して立証/.test(reviewJob));
test("比率指標の金額単位と割合の括弧崩れをTARGET内で再確認する",
  /ratio、rate、margin、Return on Equity/.test(reviewJob)
  && /ratio、rate、margin、Return on Equity/.test(html)
  && /指標と単位が明確に非互換なら unit/.test(reviewJob)
  && /二重括弧・不均衡括弧・分離した `%` は formatting/.test(reviewJob)
  && /二重・不均衡括弧は抽出TEXTにそのまま実在する場合、formatting/.test(html));
test("丸め表示を未記載の精度へ作り替えず表示区間で比較する",
  /原文が 0\.9 billion なら 906 billion のような未記載値へ置換せず/.test(html)
  && /0\.9 billion を 0\.85〜0\.95 billion の表示丸め区間/.test(html)
  && /868 million のように区間内なら不一致として報告しません/.test(html));
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
test("サーバー保存段階とブラウザー取込段階を分離して表示する",
  /saving\s+=\s*'回答JSONを保存しています'/.test(reviewJob)
  && /& \$onPhase 'saving'/.test(reviewJob)
  && !/importing\s*=/.test(reviewJob)
  && /processing_response:\s*"7\/7 回答JSONを検証・取り込み中"/.test(html)
  && /let autoImportingPacketId = ""/.test(html)
  && /function pendingAutoImportPacketId\(st\)/.test(html)
  && /const autoImportErrors = new Map\(\)/.test(html)
  && /function autoImportErrorPacketId\(st\)/.test(html)
  && /class="autoImportRetryLink"/.test(html)
  && /async function retryAutoImport\(packetId\)/.test(html)
  && /autoImportingPacketId = String\(packetId \|\| ""\)/.test(html)
  && /if \(importing\) \{[\s\S]*?完了表示は反映後に更新します/.test(html)
  && /const completionReady = reviewCompletionEligibility\(displayState,\s*\{/.test(html)
  && /if \(completionReady && !importPending && !importError\) showToast\("自動校正が完了しました"\)/.test(html)
  && !/if \(terminal\.announceCompletion && !importPending && !importError\)/.test(html));

if (failures) {
  console.error(`\nTest-PromptQualityGate: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-PromptQualityGate: PASS");
