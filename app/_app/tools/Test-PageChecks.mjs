// Test-PageChecks.mjs — page-checks.mjs の検証（node tools/Test-PageChecks.mjs）
import { validatePageChecks } from "../js/page-checks.mjs";

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

const expected = [7, 8, 9, 10, 11, 12, 13, 14, 15];

// 100% 網羅 → complete
{
  const r = validatePageChecks(
    { ok_pages: "7,10-13,15", exceptions: [{ page: 8, verdict: "finding" }, { page: 9, verdict: "unreadable" }, { page: 14, verdict: "skipped" }] },
    expected,
    [{ page: 8 }]
  );
  t("100%網羅で complete=true", r.complete === true && r.ok === true);
  t("missing=[]", r.missing.length === 0);
}

// 欠落あり → not complete、missing 検出
{
  const r = validatePageChecks({ ok_pages: "7,10-13", exceptions: [] }, expected, []);
  t("欠落で complete=false", r.complete === false);
  t("missing に 8,9,14,15", JSON.stringify(r.missing) === JSON.stringify([8, 9, 14, 15]));
}

// 95% でも complete にしない（§10.2）
{
  // 9件中8件 = 88.9%。仮に閾値0.95未満でも complete は 100% のみ
  const r = validatePageChecks({ ok_pages: "7-14", exceptions: [] }, expected, []);
  t("88.9%は complete=false", r.complete === false);
  t("coverage≈0.889", Math.abs(r.coverage - 8 / 9) < 1e-9);
}

// 降順range → エラー
{
  const r = validatePageChecks({ ok_pages: "13-10", exceptions: [] }, expected, []);
  t("降順rangeでエラー", r.errors.some(e => e.includes("降順")) && r.complete === false);
}

// 対象外ページ → エラー
{
  const r = validatePageChecks({ ok_pages: "7,99", exceptions: [] }, expected, []);
  t("対象外ページでエラー", r.errors.some(e => e.includes("対象外")));
}

// ok_pages と exceptions の重複 → エラー
{
  const r = validatePageChecks({ ok_pages: "7,8", exceptions: [{ page: 8, verdict: "finding" }] }, expected, [{ page: 8 }]);
  t("ok/exception重複でエラー", r.errors.some(e => e.includes("重複")));
}

// 不正 verdict → エラー
{
  const r = validatePageChecks({ ok_pages: "7", exceptions: [{ page: 8, verdict: "bogus" }] }, expected, []);
  t("不正verdictでエラー", r.errors.some(e => e.includes("verdict")));
}

// verdict=finding だが finding 不在 → エラー
{
  const r = validatePageChecks({ ok_pages: "7,9-15", exceptions: [{ page: 8, verdict: "finding" }] }, expected, [{ page: 12 }]);
  t("finding不在でエラー", r.errors.some(e => e.includes("対応する finding")));
}

// 不正文字 → エラー
{
  const r = validatePageChecks({ ok_pages: "7;8", exceptions: [] }, expected, []);
  t("不正文字でエラー", r.errors.some(e => e.includes("不正な文字")));
}

// null / 空 → complete=false（安全側）
{
  const r = validatePageChecks(null, expected, []);
  t("null は ok=false", r.ok === false && r.complete === false);
}

if (failures > 0) { console.error(`\nTest-PageChecks: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-PageChecks: PASS");
