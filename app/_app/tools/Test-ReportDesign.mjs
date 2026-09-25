// Test-ReportDesign.mjs — 指摘レポートの画面デザインの回帰テスト。
//
// 画面のスタイルは、上書きを重ねた層をやめて1枚のスタイルシートに書き直した。確かめること:
//   1. 1枚のスタイルシートで、!important の上書き合戦や古い配色が戻っていない。色・書体の決めごと（avoid-ai-design の監査で決めた）。
//   2. 常に見せるのは作業に毎回使うものだけ。たまに使う操作は「表示設定」、日時・範囲・案内は「このレポートについて」へ。
//   3. 見た目の要所: 校正のゲラとして組み、目立たせるのは修正の赤字（朱）だけ。重要度は文字の濃さ、ボタンは文字だけ。
//   4. #190 の読みやすさ（文を切らない・確認済みの文字・太い黄色の枠）と、狭い幅・印刷の表示。
// 画面での見え方はスクリーンショットで確かめた（PR の本文を参照）。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportCss, cssRules, effective } from "./report-css.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const L = readFileSync(join(ROOT, "index.html"), "utf8").split(/\r?\n/);
const fn = (needle) => {
  const i = L.findIndex(s => s.includes(needle));
  if (i < 0) throw new Error("index.html に見つかりません: " + needle);
  const indent = L[i].match(/^\s*/)[0];
  for (let j = i + 1; j < L.length; j++) if (L[j] === indent + "}") return L.slice(i, j + 1).join("\n");
  throw new Error("閉じ括弧が見つかりません: " + needle);
};
const line = (needle) => L.find(s => s.includes(needle)) || "";
const src = [line("const categoryLabels ="), line("const categoryLabel ="), fn("function reportHtmlDocument("), fn("function suggestionKind(s)"),
  fn("function severityLabel(sev)"), fn("function pagesToRangeText(pages)"), fn("function escapeHtml(value)"), fn("function safeText(value, max"),
  `function reportScriptTag(s){ return '<script src="' + s + '"></scr' + 'ipt>' }`, `function locatorTokens(){ return [] }`].join("\n");
const { reportHtmlDocument } = eval("(function(){" + src + "; return { reportHtmlDocument }})()");
const rawDir = join(ROOT, "docs/benchmarks/runs/raw");
const pick = readdirSync(rawDir).filter(f => f.endsWith(".json")).sort().pop();
const html = reportHtmlDocument(JSON.parse(readFileSync(join(rawDir, pick), "utf8")), {});
const text = reportCss(html);
const rules = cssRules(text);
const css = (selector, prop, media) => effective(rules, selector, prop, media);

const results = [];
const t = (name, ok, detail = "") => results.push({ ok: !!ok, name, detail });

// 1. 1枚のスタイルシート・色と書体の決めごと
const importants = (text.match(/!important/g) || []).length;
t("!important は印刷・非表示など最小限（上書きの層を重ねていない）", importants <= 6, String(importants));
t("<style> はレポートに1つだけ", (html.match(/<style>/g) || []).length === 1);
const oldColors = ["#7567d9", "#5645d4", "#f0efff", "#4f46e5", "#fbfaff", "#0a1530", "#1a2a52", "#f9e79f", "#2952cc", "#eef2fc", "#1a7f4b", "#ebf6f0"];
const leftover = oldColors.filter(c => text.toLowerCase().includes(c));
t("古い配色（紫・紺の帯・青の強調・緑の完了）が残っていない", leftover.length === 0, leftover.join(", "));
t("目立たせる色は朱（赤字）1つだけで、1か所で決める", (text.match(/--shu:/g) || []).length === 1 && !/--accent/.test(text));
t("補足の文字色は白地で 4.5:1 以上（#646468）", /--muted:#646468/.test(text));
t("画面の書体は BIZ UDPゴシック、原文・修正案は明朝系", /--font:"BIZ UDPGothic"/.test(text) && /--font-text:"Cambria"/.test(text)
  && css(".master-diff-box span", "font-family") === "var(--font-text)");
t("動きを減らす設定ではハイライトの点滅をやめる", css(".report-highlight-box.flash", "animation", "(prefers-reduced-motion:reduce)") === "none");

// 2. 画面の組み立て
t("進み具合（確認済み n / N）は上部の右側に置く", html.includes("document.querySelector('.actions').prepend(compactProgress)")
  && !html.includes("compact.append(compactProgress)"));
t("表示設定は上部の右端に置く", html.includes("document.querySelector('.actions').append(optionsWrap)"));
t("文字サイズ・元PDF・印刷・未確認のみ・分類は表示設定にまとめる",
  html.includes("optionsPopover.append(optionsPopover.querySelector('.options-title'),cat,uncheckedWrap,showExcludedWrap,fontRow,optionsMenu,guide,packetDetails)")
  && html.includes("optionsMenu.append(openTargetBtn,printBtn,copyProgress,keyHelp)"));
t("日時・範囲・案内は「このレポートについて」の中へ", html.includes("aboutBody.prepend(document.querySelector('.header-copy>.meta').cloneNode(true),document.querySelector('.ai-notice'))")
  && css(".header-copy>.meta", "display") === "none");
t("印刷では日時・範囲を文書名の下に出す", css(".header-copy>.meta", "display", "print") === "block");
t("ページ選択は絞り込みの列に置き、一覧の見出しの行は作らない", html.includes("compact.append(document.querySelector('.page-jump'))") && !html.includes("list-head"));
t("「指摘レポート」と「指摘一覧」の見出しは画面に出さず読み上げ用に残す",
  css(".header-line h1", "clip") === "rect(0 0 0 0)" && css(".issues-heading", "clip") === "rect(0 0 0 0)");
t("ハイライトの状態の文字は出さない（黄色の枠と案内で分かる）", !html.includes("document.querySelector('.pdfbar').append(matchStatus)"));
t("ページ番号は1か所（左上）だけ", html.includes("pageLabel.textContent='P.'+currentPage;") && !html.includes("'</span><span>P.'+Number(r.page)"));
t("問題が無いときはPDFの下に案内を出さない", !html.includes("showPdfHint('黄色の枠が、この指摘の該当箇所です。',false)"));
t("いまの指摘の重要度と分類を別々の文字で出す", html.includes('<div class="master-detail-meta"><span class="severity-label sev-\'+'));
t("札の中は格子で並べ、見出しの行・操作の行を分ける", css(".master-detail", "display") === "grid"
  && css(".master-detail-head", "display") === "contents" && css(".master-detail-actions", "display") === "contents");
t("「確認済み」は札の右下、前後移動は右上", css(".master-done", "order") === "7" && css(".master-nav", "order") === "2");
t("「選択中の指摘」の見出しは画面に出さず読み上げ用に残す", css(".master-detail>h2:first-child", "clip") === "rect(0 0 0 0)");

// 3. 見た目の要所
t("いまの指摘は枠や影で囲まず、罫1本で一覧と分ける", css(".master-detail", "border-bottom") === "1px solid var(--rule)"
  && css(".master-detail", "box-shadow") === "" && css(".master-detail", "border-radius") === "");
t("修正は校正の赤字: 削る文字は朱の取り消し線、入れる文字は朱の下線", css(".master-diff-box mark", "color") === "var(--shu)"
  && css(".master-diff-box:first-child mark", "text-decoration-line") === "line-through"
  && css(".master-diff-box:not(:first-child) mark", "text-decoration-line") === "underline"
  && css(".master-diff-box mark", "background") === "none");
t("原文・修正案は箱に入れず、見出しを左に置いた2行で並べる", css(".master-diff-box", "border") === "0" && css(".master-diff-box", "background") === "none"
  && css(".master-diff-box", "grid-template-columns") === "4.5em minmax(0,1fr)");
t("選択行は薄い地だけで示す（左の色帯を付けない）", css(".issue.active", "background") === "var(--wash)" && css(".issue.active", "box-shadow") === "");
t("重要度は色ではなく文字の濃さで示す", css(".severity-label.sev-high", "color") === "var(--ink)" && css(".severity-label.sev-high", "font-weight") === "700"
  && css(".severity-label.sev-low", "color") === "var(--muted)");
t("件数の切り替えは文字だけで、選んだものに墨の下線", css(".stat", "background") === "transparent" && css(".stat.active", "border-bottom-color") === "var(--ink)");
t("「未確認のみ」などは標準のチェックボックス", css(".unchecked-toggle input", "appearance") === "" && css(".unchecked-toggle input", "accent-color") === "var(--ink)");
t("表示設定のボタンは普段は枠も地も無い", css(".options-wrap>.viewer-btn", "background") === "transparent" && css(".options-wrap>.viewer-btn", "border") === "0");
t("表示設定の中の操作は枠の無い一覧（メニュー）", css(".options-menu .viewer-btn", "border") === "0" && css(".options-menu .viewer-btn", "text-align") === "left");
t("原稿は机の色の上に紙として置き、操作は文字だけで置く", css(".page-pane", "background") === "var(--desk)"
  && css(".pdfbar", "background") === "" && css(".pdfbar .viewer-btn", "border") === "0" && css(".report-pdf-page", "box-shadow").includes("rgba"));
t("確認済みの丸は墨で埋まる", css(".master-done input:checked", "background-color") === "var(--ink)");

// 4. 読みやすさ・狭い幅・印刷
t("原文・修正案の枠に高さの上限が無い", css(".master-diff-box", "max-height") === "none" && css(".master-diff-box", "overflow") === "visible");
t("確認済みの操作に文字が出る", !["0", ""].includes(css(".issue .card-done", "font-size")));
t("確認済みの行は薄く表示する", css(".issue.done .issue-main", "opacity") === ".5");
t("黄色の枠が太い", /^3px solid/.test(css(".report-highlight-box", "outline")));
t("一覧の題名は1行で省略し、行の高さは固定しない", css(".issue-title strong", "text-overflow") === "ellipsis" && css(".issue", "height") === "auto");
t("狭い幅では上下に積む", css(".main", "display", "(max-width:1180px)") === "block" && css(".page-pane", "height", "(max-width:1180px)") === "60vh");
t("狭い幅では操作の列を折り返す", css(".compact-controls", "flex-wrap") === "wrap");
t("印刷では操作・原稿・いまの指摘を出さない", /(^|,)\.master-detail(,|$)/.test(rules.filter(r => r.media === "print").map(r => r.selectors.join(",")).join(",")));
t("印刷では全件を出し、選択行の色を残さない", css(".issue.active", "display", "print") === "block" && css(".issue.active", "background", "print") === "#fff");
t("印刷には除外した指摘（誤指摘と判断したものなど）を出さない", css('.issue:not([data-excluded=""])', "display", "print") === "none"
  && css(".page-group[data-all-excluded]", "display", "print") === "none" && src.includes('records.every(r => r.excluded_reason) ? ` data-all-excluded="1"`'));
t("印刷では一覧の題名を折り返す", css(".issue-title strong", "white-space", "print") === "normal");

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + String(r.detail).slice(0, 300)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ReportDesign: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
