// 画面・レポートに出す日本語の文から、依頼文の中の呼び名（REF・TARGET）を利用者の言葉へ直す。
// 実機の撮影で「REFでは…」という指摘文がそのまま利用者に見えていた。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const src = (html.match(/function userFacingFindingText\(value\) \{[\s\S]*?\n    \}/) || [])[0];
const results = [];
const t = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
t("userFacingFindingText が index.html にある", !!src);
const fn = src ? new Function(`${src}; return userFacingFindingText;`)() : (v => v);

t("REF を日本語の原稿に直す", fn("REFでは3,860、TARGETでは3,680です。") === "日本語の原稿では3,860、英文では3,680です。", fn("REFでは3,860、TARGETでは3,680です。"));
t("番号付き・候補付きの呼び名も直す", fn("REF1 P.3 と REF2_CANDIDATE を参照") === "日本語の原稿 P.3 と 日本語の原稿 を参照", fn("REF1 P.3 と REF2_CANDIDATE を参照"));
t("英文（貼れる修正案）には触れない", fn("See REF note and TARGET value.") === "See REF note and TARGET value.");
t("単語の一部は直さない", fn("REFERENCE と PREFIX の表記を確認") === "REFERENCE と PREFIX の表記を確認");
t("空の値はそのまま", fn("") === "" && fn(undefined) === "");
t("表示に使う文と書き出す文が通る", /issue_summary: findingPrimaryText\(f, 2000\)/.test(html)
  && /reason: userFacingFindingText\(f\.displayReason \|\| f\.reason \|\| ""\)/.test(html)
  && /suggestion: userFacingFindingText\(f\.suggestion \|\| ""\)/.test(html)
  && /safeText\(userFacingFindingText\(f\?\.displaySummary/.test(html));

// 一覧から外した理由は、開発用の分類名（unmasked-identical-numeric-mismatch など）のまま利用者に見せない。
// 実機のレポートで「このレポートについて」の内訳に分類名がそのまま出ていた。
const codes = [...new Set([...html.matchAll(/excludedReason\s*=\s*"([a-z0-9-]+)"/g)].map(m => m[1]))];
const appMap = (html.match(/const EXCLUDED_REASON_LABELS = \{([\s\S]*?)\};/) || [])[1] || "";
const reportMap = (html.match(/const reportExcludedReasonLabels = \{([\s\S]*?)\};/) || [])[1] || "";
const missingApp = codes.filter(c => !appMap.includes(`"${c}"`));
const missingReport = codes.filter(c => !reportMap.includes(`"${c}"`));
t("除外の理由はすべて画面の言葉を持つ（アプリ）", codes.length >= 10 && !missingApp.length, missingApp.join(", "));
t("除外の理由はすべて画面の言葉を持つ（レポート）", codes.length >= 10 && !missingReport.length, missingReport.join(", "));

// アプリ画面のPDF表示タブは、#202 で揃えた「日本語の原稿」の呼び名を使う（「比較PDF」を残さない）。
const appMarkup = html.split("指摘ビューア")[0];
t("PDF表示タブは「日本語の原稿」と書く", /id="viewReferencePdfBtn"[^>]*>日本語の原稿<\/button>/.test(html));
t("アプリ画面に「比較PDF」の表示名を残さない", !/>比較PDF<|"比較PDF|`比較PDF/.test(appMarkup));

// Copilot状態の表示は、異常か・待てばよいか・何を押せばよいかが分かる言葉にする。
const badgeSrc = (html.match(/async function pollReadyState\(\) \{[\s\S]*?\n    \}/) || [])[0] || "";
t("Copilot状態の表示処理が index.html にある", !!badgeSrc);
t("「Copilot状態未確認」を出さない", !html.includes("Copilot状態未確認"));
t("ウォームアップしていないときは、校正の開始時に接続すると伝える", badgeSrc.includes("Copilotには校正の開始時に接続します"));
t("状態を受け取れないときは「確認中」と伝える", badgeSrc.includes("Copilotの状態を確認中"));
t("サインインが必要なときは「Copilot画面を表示」を押すと伝える", /Copilotにサインインが必要です：「Copilot画面を表示」を押してください/.test(badgeSrc));

let failed = 0;
for (const r of results) { console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + r.detail}`); if (!r.ok) failed++; }
console.log(failed ? `Test-UserFacingText: FAIL (${failed})` : "Test-UserFacingText: PASS");
process.exit(failed ? 1 : 0);
