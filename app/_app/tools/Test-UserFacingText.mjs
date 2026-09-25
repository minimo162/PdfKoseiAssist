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

let failed = 0;
for (const r of results) { console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + r.detail}`); if (!r.ok) failed++; }
console.log(failed ? `Test-UserFacingText: FAIL (${failed})` : "Test-UserFacingText: PASS");
process.exit(failed ? 1 : 0);
