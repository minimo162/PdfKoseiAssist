// report-css.mjs — 書き出しレポートのCSSを読み、ある要素に最後に効く値を調べる小物（テスト用）。
//
// 文字列の一致ではなく「実際に効く値」で確かめるために使う。@media は条件の文字列ごとに分け、
// 条件の無い規則は "all"、印刷は "print" として扱う。詳細度は見ず、同じセレクタの後勝ちと !important だけを見る。

export function reportCss(html) {
  return ((html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1]).replace(/\/\*[\s\S]*?\*\//g, "");
}

export function cssRules(css) {
  const rules = [];
  let i = 0;
  const walk = (media) => {
    while (i < css.length) {
      const open = css.indexOf("{", i), close = css.indexOf("}", i);
      if (close >= 0 && (open < 0 || close < open)) { i = close + 1; return; }
      if (open < 0) { i = css.length; return; }
      const head = css.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith("@keyframes")) { let depth = 1; while (depth && i < css.length) { const c = css[i++]; if (c === "{") depth++; else if (c === "}") depth--; } continue; }
      if (head.startsWith("@")) { walk(/\bprint\b/.test(head) ? "print" : head.replace(/^@media\s*/, "").replace(/\s+/g, "")); continue; }
      const end = css.indexOf("}", i);
      rules.push({ media, selectors: head.split(",").map(s => s.trim()), body: css.slice(i, end) });
      i = end + 1;
    }
  };
  walk("all");
  return rules;
}

// media: "all"（条件なし）/ "print" / "(max-height:800px)" のような条件。条件付きを見るときは、条件なしの規則の上に重ねて見る。
export function effective(rules, selector, prop, media = "all") {
  let normal = "", important = "";
  for (const r of rules) {
    if (r.media !== "all" && r.media !== media) continue;
    if (!r.selectors.includes(selector)) continue;
    for (const decl of r.body.split(";")) {
      const k = decl.indexOf(":");
      if (k < 0 || decl.slice(0, k).trim() !== prop) continue;
      const value = decl.slice(k + 1).trim();
      if (/!important$/.test(value)) important = value; else normal = value;
    }
  }
  return (important || normal).replace(/\s*!important$/, "");
}
