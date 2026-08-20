// Test-ReportRender.mjs — 実際の指摘から書き出しレポートHTMLを作り、中身を見る。
//
// なぜ要るか:
//   書き出しの経路には検査が無かった。reportHtmlDocument が壊れても、
//   **20分かけて1本走らせ、書き出すまで気付けない**。実際この道具は、
//   修正案／やることの出し分けを実データで確かめるために書いたものである。
//
// 素材は runs/raw に置いてある実行結果。Copilot も PDF も要らない。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const L = readFileSync(join(ROOT, "index.html"), "utf8").split(/\r?\n/);

// 同じ字下がりの閉じ括弧までを1つの定義として取る。
const fn = (needle) => {
  const i = L.findIndex(s => s.includes(needle));
  if (i < 0) throw new Error("index.html に見つかりません: " + needle);
  const indent = L[i].match(/^\s*/)[0];
  for (let j = i + 1; j < L.length; j++) if (L[j] === indent + "}") return L.slice(i, j + 1).join("\n");
  throw new Error("閉じ括弧が見つかりません: " + needle);
};
const line = (needle) => {
  const value = L.find(s => s.includes(needle));
  if (!value) throw new Error("index.html に見つかりません: " + needle);
  return value;
};

const results = [];
const t = (name, ok, detail) => results.push({ ok: !!ok, name, detail });

let reportHtmlDocument, suggestionKind;
try {
  const src = [
    line("const categoryLabels ="),
    line("const categoryLabel ="),
    fn("function reportHtmlDocument("),
    fn("function suggestionKind(s)"),
    fn("function severityLabel(sev)"),
    fn("function pagesToRangeText(pages)"),
    fn("function escapeHtml(value)"),
    fn("function safeText(value, max"),
    // 画面でしか要らない小物。レポートの中身には関わらない。
    `function reportScriptTag(s){ return '<script src="' + s + '"></scr' + 'ipt>' }`,
    `function locatorTokens(){ return [] }`,
  ].join("\n");
  ({ reportHtmlDocument, suggestionKind } =
    eval("(function(){" + src + "; return { reportHtmlDocument, suggestionKind }})()"));
  t("index.html から書き出し器を取り出せる", true);
} catch (e) {
  t("index.html から書き出し器を取り出せる", false, String(e.message || e));
}

// いちばん新しい実行結果を素材にする。
const rawDir = join(ROOT, "docs/benchmarks/runs/raw");
const pick = existsSync(rawDir)
  ? readdirSync(rawDir).filter(f => f.endsWith(".json")).sort().pop()
  : null;
t("素材の実行結果がある", !!pick, rawDir);

if (reportHtmlDocument && pick) {
  const data = JSON.parse(readFileSync(join(rawDir, pick), "utf8"));
  for (const r of data.findings) r.suggestion_kind = suggestionKind(r.suggestion);
  data.suggestion_action_count = data.findings.filter(r => r.suggestion_kind === "action").length;
  data.suggestion_replacement_count = data.findings.filter(r => r.suggestion_kind === "replacement").length;

  let html = "";
  try { html = reportHtmlDocument(data, {}); t(`${pick} を書き出せる`, true); }
  catch (e) { t(`${pick} を書き出せる`, false, String(e.message || e)); }

  if (html) {
    // レポート本文は report-pane を唯一の縦スクロール面にする。ここが
    // flex のまま戻ると PDF と指摘一覧の双方が縦に狭くなり、二重スクロールになる。
    t("生成HTMLの縦スクロールをreport-paneへ集約する",
      html.includes(".report-pane{display:block!important;overflow-y:auto}"),
      "report-paneの表示・縦スクロール固定が生成HTMLにありません");
    // reportHtmlDocument は別文脈で実行される生成スクリプトを埋め込むため、
    // \s の正規表現を一段多くエスケープする必要がある。実行後のHTMLでは
    // バックスラッシュが1本だけ残ることを、固定文字列として検査する。
    t("生成スクリプトの空白正規化regexを保持する",
      html.includes("replace(/\\s+/g,' ')")
        && !html.includes("replace(/s+/g,' ')"),
      "生成HTMLの空白正規化regexが壊れています");
    t("生成スクリプトの差分token regexを保持する",
      html.includes("match(/\\s+|")
        && !html.includes("match(/s+|"),
      "生成HTMLの差分token regexが壊れています");
    const excludedFixture = {
      ...data,
      findings: [{
        ...data.findings[0],
        no: 9001,
        id: "EXCLUDED-FIXTURE",
        excluded_reason: "quote-not-found",
      }],
    };
    let excludedHtml = "";
    try { excludedHtml = reportHtmlDocument(excludedFixture, {}); }
    catch (e) { t("excluded_reason付きfixtureを外側helperなしで書き出せる", false, String(e.message || e)); }
    t("excluded_reason付きfixtureを外側helperなしで書き出せる",
      !!excludedHtml && excludedHtml.includes("通常一覧から除外済み・場所を特定できない")
        && !excludedHtml.includes("excludedReasonLabel is not defined"),
      "除外理由の表示生成に失敗しました");
    const unknownReasonFixture = {
      ...excludedFixture,
      findings: [{ ...excludedFixture.findings[0], excluded_reason: "<unknown-reason>" }],
    };
    const unknownReasonHtml = reportHtmlDocument(unknownReasonFixture, {});
    t("未知のexcluded_reasonはエラーにせずHTML escapeする",
      unknownReasonHtml.includes("&lt;unknown-reason&gt;")
        && !unknownReasonHtml.includes("<unknown-reason>"),
      "未知の除外理由が安全に表示されません");

    const cards = [...html.matchAll(/<article class="issue[\s\S]*?<\/article>/g)].map(m => m[0]);
    t("指摘の数だけカードが出る", cards.length === data.findings.length,
      `指摘 ${data.findings.length} / カード ${cards.length}`);

    // 初めて開いた人が、選択中の指摘をどう消し込むか迷わない導線を固定する。
    t("選択中の指摘に名前付きの確認済み操作がある",
      html.includes('data-master-done') && html.includes("renderMasterDone(r)"),
      "選択中の詳細に確認済み操作が見つかりません");
    t("確認済み操作の関数が詳細描画の外にある",
      html.indexOf("function renderMasterDone(r)") > html.indexOf("masterDetail.innerHTML=")
        && html.indexOf("function renderMasterDone(r)") < html.indexOf("function fillDiffs()"),
      "renderMasterDone が renderMasterDetail の内側に入り込んでいます");
    t("一覧の小さいチェックにも説明がある",
      html.includes('title="この指摘を確認済みにする"'),
      "一覧チェックの説明が見つかりません");
    t("三点リーダーではなく表示設定と書く",
      html.includes("optionsBtn.textContent='表示設定'"),
      "表示設定が無記名のボタンに戻っています");
    t("案内と検査範囲を表示設定に整理している",
      html.includes("guide.className='options-help'")
        && html.includes("packetDetails.className='packet-details'")
        && html.includes("検査範囲の詳細（0件の区間あり）"),
      "補助情報が作業画面に常時積み上がっています");
    t("選択中の指摘と一覧を見分けられる",
      html.includes(".master-detail{margin:0 10px 8px")
        && html.includes(".issue.active{background:#f0efff!important"),
      "選択中の詳細と一覧の視覚的な区別が見つかりません");
    t("書き出しHTMLに選択中の指摘と指摘一覧のラベルがある",
      html.includes("masterDetail.setAttribute('aria-label','選択中の指摘')")
        && html.includes('masterDetailHeading">選択中の指摘')
        && html.includes("findingsListHeading")
        && html.includes("textContent='指摘一覧'"),
      "書き出しHTMLの master/detail ラベルが見つかりません");
    t("書き出しHTMLの詳細と一覧に独立した領域指定がある",
      html.includes("masterDetail.setAttribute('aria-labelledby','masterDetailHeading')")
        && html.includes("issuesRoot.setAttribute('aria-labelledby','findingsListHeading')"),
      "詳細/一覧の aria-labelledby が見つかりません");
    t("書き出しHTMLの詳細・一覧のDOM順を固定する",
      html.includes("issuesRoot.before(masterDetail, findingsListHeading)")
        && !html.includes("issuesRoot.before(findingsListHeading)")
        && !html.includes("issuesRoot.before(masterDetail)"),
      "detail → 指摘一覧見出し → list の単一挿入が見つかりません");
    t("書き出しHTMLに一覧の重複pseudo-labelがない",
      !html.includes(".page-jump:before"),
      "page-jump の疑似要素ラベルが残っています");
    t("選択中詳細の描画を再ラップしない",
      !html.includes("renderMasterDetail=function")
        && !html.includes("renderMasterDetailWithHeading")
        && !html.includes("ensureMasterDetailHeading"),
      "renderMasterDetail の再代入またはラッパーが残っています");
    t("選択中詳細の実描画にも見出しを含める",
      html.includes("masterDetail.innerHTML='<h2 id=\"masterDetailHeading\">選択中の指摘</h2><div class=\"master-detail-head\">")
        && html.includes("masterDetail.innerHTML='<h2 id=\"masterDetailHeading\">選択中の指摘</h2><div class=\"hint-muted\">") ,
      "空/選択済みの詳細描画に選択中ラベルがありません");
    t("重要度を文字付きラベルで示す",
      html.includes(".issue-main .severity-label{display:inline-flex!important")
        && html.includes(".severity-label.sev-high{background:#feeceb"),
      "重要度が色や小さい点だけに依存しています");
    t("絞り込み条件をいつでも解除できる",
      html.includes("filterReset.textContent='条件を解除'")
        && html.includes("filterReset.addEventListener('click',clearActiveFilters)"),
      "結果が残っている状態から条件を戻す操作が見つかりません");
    t("キーボードフォーカスが明確に見える",
      html.includes("outline:2px solid #4f46e5!important"),
      "2pxのフォーカス表示が見つかりません");
    t("PDF案内に内部用語を出さない",
      html.includes("pdfHint.textContent='右の指摘を選ぶと、該当箇所を黄色で表示します。'")
        && html.includes("該当箇所を表示できませんでした"),
      "PDF案内が初回利用者向けの文言になっていません");
    t("非表示の体裁指摘が一覧に残らない",
      html.includes(".issue.hidden{display:none!important}"),
      "除外済みカードを隠す画面用CSSが見つかりません");
    t("選択中の指摘を支援技術にも伝える",
      html.includes("button.setAttribute('aria-current',selected?'true':'false')"),
      "選択状態の aria-current が見つかりません");

    // ⚠️ ここが本題。種類が付いていないと、閲覧側は「やること」を
    //    原文との差分（緑の置き換え）として描いてしまう。
    const noKind = cards.filter(c => !/data-kind="(action|replacement)"/.test(c)
                                  && /data-new="[^"]+"/.test(c));
    t("修正案のあるカードに種類が付いている", noKind.length === 0, `${noKind.length}件で欠落`);

    // 分類が英語の識別子のまま出ていないか。実際に画面へ出る文字列を見る。
    const shown = [...new Set([...html.matchAll(/<span class="category-label">([^<]*)</g)].map(m => m[1]))];
    const english = shown.filter(s => /^[a-z_]+$/.test(s));
    t("分類が日本語で出ている", english.length === 0, english.join(", ") + " / 出た分類: " + shown.join(" "));

    // 冒頭の注意書きに内訳が出ているか。
    const notice = (html.match(/<p class="ai-notice">([\s\S]*?)<\/p>/) || [])[1] || "";
    const about = (html.match(/<div class="report-about-body">([\s\S]*?)<\/div>/) || [])[1] || "";
    // ⚠️ 冒頭は「利用者に全部確かめてもらう指示」ではなく、
    //    **こちらが何を確かめたかの報告**でなければならない（利用者からの指摘・2026-08-08）。
    t("冒頭が指示の丸投げに戻っていない",
      !/1件ずつ原本と見比べて/.test(notice), notice.replace(/<[^>]*>/g, "").slice(0, 80));

    // ⚠️ **やっていない確認を「やった」と書かないこと。**
    //    素材は照合前の実行結果なので ok も error も 0。ここで「すべて照合しました」と
    //    書く版に戻ると、0件一致なのに確認済みだと言うことになる。
    const checked = Number(data.highlight_ok_count || 0) + Number(data.highlight_error_count || 0);
    t("確かめていない書き出しで「確かめた」と言わない",
      checked > 0 || /確かめていません/.test(about),
      `照合済み ${checked}件 / ${about.replace(/<[^>]*>/g, "").slice(0, 80)}`);
    // ⚠️ 冒頭は**1文だけ**。明細を並べられても利用者は動けない（利用者の指摘・2026-08-08）。
    t("冒頭が短い", notice.replace(/<[^>]*>/g, "").trim().length <= 60,
      notice.replace(/<[^>]*>/g, "").trim());

    // 照合が走った形も見る（素材に件数だけ足して描き直す）。
    const sample = data.findings.slice(0, 13).map((r, i) => ({ ...r,
      self_check: i < 2 ? "suspect" : "",
      self_check_reason: i < 2 ? "同じ数値どうしを不一致と述べています" : "" }));
    const withCounts = reportHtmlDocument(
      { ...data, count: 13, highlight_ok_count: 12, highlight_error_count: 1,
        self_check_suspect_count: 2, findings: sample }, {});
    const n2 = (withCounts.match(/<p class="ai-notice">([\s\S]*?)<\/p>/) || [])[1] || "";
    const a2 = (withCounts.match(/<div class="report-about-body">([\s\S]*?)<\/div>/) || [])[1] || "";
    t("まず何件見ればよいかを先に言う", /^まず見るのは/.test(n2.replace(/<[^>]*>/g, "").trim()),
      n2.replace(/<[^>]*>/g, "").slice(0, 60));
    t("照合した数・一致・不一致を数で出す",
      /13件すべて/.test(a2) && /一致 12件/.test(a2) && /見つからず 1件/.test(a2),
      n2.replace(/<[^>]*>/g, "").slice(0, 110));
    // ⚠️ 「要確認」を一覧に散らすと半分に印が付いて印として働かない。下にまとめる。
    t("要確認件数と理由を示し、自動削除しない",
      /要確認として表示/.test(a2) && /同じ数値どうし/.test(a2) && /自動削除はしていません/.test(a2), n2.replace(/<[^>]*>/g, "").slice(0, 140));
    // ⚠️ 「念のため残す」は判断したふりで、結局利用者に押し戻している（利用者の指摘）。
    t("保険をかける言い回しが無い", !/念のため|まとめてあります/.test(a2),
      n2.replace(/<[^>]*>/g, "").slice(0, 110));
    t("消したものはカードとして出ていない",
      !/suspect-group/.test(withCounts), "suspect-group が残っている");
    const duplicateWarning = "quoteが同一ページ内の複数箇所に一致します。";
    const warningBase = data.findings[0] || {};
    const ambiguityWarningHtml = reportHtmlDocument({
      ...data,
      count: 1,
      findings: [{ ...warningBase, no: 9101, quality_warning: duplicateWarning, self_check: "" }],
    }, {});
    t("曖昧一致だけのwarningは理由を残し強いラベルを抑制する",
      ambiguityWarningHtml.includes(duplicateWarning)
        && !ambiguityWarningHtml.includes("<strong>内容を確認してください</strong>")
        && !ambiguityWarningHtml.includes('<span class="nhr-label">要確認</span>'),
      "曖昧一致warningの表示が強い確認ラベルへ昇格しています");
    const substantiveWarningHtml = reportHtmlDocument({
      ...data,
      count: 1,
      findings: [{ ...warningBase, no: 9102, quality_warning: `${duplicateWarning} 追加の品質確認が必要です。`, self_check: "" }],
    }, {});
    t("曖昧一致以外のwarningは具体的な確認ラベルを残す",
      substantiveWarningHtml.includes("<strong>内容を確認してください</strong>")
        && !substantiveWarningHtml.includes("人による確認が必要"),
      "実質的なwarningの確認ラベルが不明瞭です");
    const invalidSuggestionHtml = reportHtmlDocument({
      ...data,
      count: 1,
      findings: [{
        ...warningBase,
        no: 9103,
        suggestion_integrity: "numeric-token-change",
        quality_warning: "修正案に無関係な数値・日付の変更があるため、元の修正案を無効化しました。",
        self_check: "suspect",
        self_check_reason: "修正案が原文の数値・日付トークンを変更しています。修正案を再生成してください",
      }],
    }, {});
    const invalidSuggestionCard = (invalidSuggestionHtml.match(/<article class="issue[\s\S]*?<\/article>/) || [""])[0];
    t("無効化した修正案は利用可否を直接示す",
      invalidSuggestionCard.includes("<strong>元の修正案は使えません</strong>")
        && !invalidSuggestionCard.includes("人による確認が必要")
        && !invalidSuggestionCard.includes("これは誤りかもしれません"),
      "数値整合性で無効化した修正案の表示が曖昧です");

    // Counterpart quotes must already be source-validated before report
    // generation.  A missing/ambiguous page is retained as page-only and may
    // never inherit the primary quote.
    const counterpartFixture = {
      ...data,
      count: 1,
      findings: [{
        ...warningBase,
        no: 9201,
        id: "COUNTERPART-FIXTURE",
        page: 5,
        quote: "(Millions of yen)",
        quality_warning: "",
        counterparts_validated: true,
        counterpart_pages: [11, 12, 13],
        counterparts: [
          { page: 11, quote: "Validated P.11 counterpart", status: "ok", boxes: [] },
          { page: 12, quote: "", status: "page-only", boxes: [] },
          { page: 13, quote: "", status: "page-only", boxes: [] },
        ],
      }],
    };
    const counterpartHtml = reportHtmlDocument(counterpartFixture, {});
    const counterpartJsonText = (counterpartHtml.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/) || [])[1] || "";
    let counterpartData = null;
    try { counterpartData = JSON.parse(counterpartJsonText); } catch (_) {}
    const counterpartRecord = counterpartData?.findings?.[0] || {};
    t("生成レポートがvalidated counterpartを保持する",
      counterpartRecord.quote === "(Millions of yen)"
        && counterpartRecord.counterparts?.find(c => c.page === 11)?.quote === "Validated P.11 counterpart"
        && counterpartRecord.counterparts?.find(c => c.page === 11)?.quote !== counterpartRecord.quote
        && counterpartHtml.includes("P.11 も表示"),
      "P.11のvalidated counterpartがレポートに残っていません");
    t("missing/ambiguous counterpartはページだけで出す",
      counterpartRecord.counterparts?.find(c => c.page === 12)?.quote === ""
        && counterpartRecord.counterparts?.find(c => c.page === 13)?.quote === ""
        && counterpartHtml.includes("P.12 も表示（位置不明）")
        && counterpartHtml.includes("P.13 も表示（位置不明）"),
      "missing/ambiguous counterpartが主引用または未検証引用を再利用しています");
    const counterpartSource = fn("async function attachCounterpartHighlights(");
    t("相手ページのレポート照合はvalidated recordだけを使う",
      /records\.length !== 1/.test(counterpartSource)
        && !counterpartSource.includes("counterpartNumberNeedles")
        && !counterpartSource.includes("r.quote"),
      "レポート相手ページが理由文・数値・主引用へフォールバックしています");
    // ⚠️ 「検算」「引っかかった」はこちらの作業を語る言葉で、利用者の関心事ではない
    //    （利用者の指摘・2026-08-08）。画面に出す文へ戻さないこと。
    t("開発側の言い回しが出ていない", !/検算|引っかかった/.test(n2 + a2),
      n2.replace(/<[^>]*>/g, "").slice(0, 110));
    t("冒頭に修正案の内訳が出る",
      data.suggestion_action_count === 0 || notice.includes(String(data.suggestion_action_count)),
      `やること ${data.suggestion_action_count} / 注意書き: ${notice.replace(/<[^>]*>/g, "").slice(0, 90)}`);

    console.log(`  素材 ${pick}: 指摘 ${data.findings.length}件`
      + `（やること ${data.suggestion_action_count} / 貼れる英文 ${data.suggestion_replacement_count}）`);
  }
}

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ReportRender: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
