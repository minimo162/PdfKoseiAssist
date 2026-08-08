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

const results = [];
const t = (name, ok, detail) => results.push({ ok: !!ok, name, detail });

let reportHtmlDocument, suggestionKind;
try {
  const src = [
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
    const cards = [...html.matchAll(/<article class="issue[\s\S]*?<\/article>/g)].map(m => m[0]);
    t("指摘の数だけカードが出る", cards.length === data.findings.length,
      `指摘 ${data.findings.length} / カード ${cards.length}`);

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
    // ⚠️ 冒頭は「利用者に全部確かめてもらう指示」ではなく、
    //    **こちらが何を確かめたかの報告**でなければならない（利用者からの指摘・2026-08-08）。
    t("冒頭が指示の丸投げに戻っていない",
      !/1件ずつ原本と見比べて/.test(notice), notice.replace(/<[^>]*>/g, "").slice(0, 80));

    // ⚠️ **やっていない確認を「やった」と書かないこと。**
    //    素材は照合前の実行結果なので ok も error も 0。ここで「すべて照合しました」と
    //    書く版に戻ると、0件一致なのに確認済みだと言うことになる。
    const checked = Number(data.highlight_ok_count || 0) + Number(data.highlight_error_count || 0);
    t("照合していない書き出しで「照合した」と言わない",
      checked > 0 || /行っていません/.test(notice), `照合済み ${checked}件 / ${notice.replace(/<[^>]*>/g, "").slice(0, 80)}`);

    // 照合が走った形も見る（素材に件数だけ足して描き直す）。
    const withCounts = reportHtmlDocument(
      { ...data, count: 13, highlight_ok_count: 12, highlight_error_count: 1,
        self_check_suspect_count: 2, findings: data.findings.slice(0, 13) }, {});
    const n2 = (withCounts.match(/<p class="ai-notice">([\s\S]*?)<\/p>/) || [])[1] || "";
    t("照合した数・一致・不一致・要確認を数で出す",
      /13件すべて/.test(n2) && /一致 12件/.test(n2) && /見つからず 1件/.test(n2) && /2件/.test(n2),
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
