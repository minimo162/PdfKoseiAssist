// Test-Sectioning.mjs — sectioning.mjs の検証（node tools/Test-Sectioning.mjs）
import { computeSections, mapRefRange, sectionWarnings } from "../js/sectioning.mjs";

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

// 等幅＋重ね: 150p, width25, overlap3
{
  const s = computeSections(150, { sectionWidth: 25, overlap: 3 });
  t("先頭は1-25", s[0].startPage === 1 && s[0].endPage === 25);
  t("2番目は23始まり（3重ね）", s[1].startPage === 23);
  t("全ページを覆う（最後がtotal）", s[s.length - 1].endPage === 150);
  t("各セクション<=25p", s.every(x => x.pageCount <= 25));
  t("連続性（隙間なし）", s.every((x, i) => i === 0 || x.startPage <= s[i - 1].endPage + 1));
}

// 小さい文書: 20p width25 → 1セクション
{
  const s = computeSections(20, { sectionWidth: 25, overlap: 3 });
  t("20pは1セクション(1-20)", s.length === 1 && s[0].endPage === 20);
}

// 手動区切り: [26, 61, 96] → 1-25, 26-60, 61-95, 96-total
{
  const s = computeSections(120, { breakpoints: [26, 61, 96] });
  t("手動4セクション", s.length === 4);
  t("手動 境界どおり", s[0].endPage === 25 && s[1].startPage === 26 && s[1].endPage === 60 && s[2].startPage === 61 && s[3].endPage === 120);
  t("手動は重ねなし（隙間なし・重複なし）", s.every((x, i) => i === 0 || x.startPage === s[i - 1].endPage + 1));
}

// REF比率マッピング（1:1）
{
  const sec = { index: 0, startPage: 1, endPage: 25, pageCount: 25 };
  const r = mapRefRange(sec, { targetTotal: 100, refTotal: 100, buffer: 5 });
  t("1:1 REF ≈ 1..30(+buffer)", r.refStart === 1 && r.refEnd === 30 && r.mode === "ratio");
}

// REF比率マッピング（原文が長い＝ズレ）: TARGET100, REF130
{
  const sec = { index: 1, startPage: 26, endPage: 50, pageCount: 25 };
  const r = mapRefRange(sec, { targetTotal: 100, refTotal: 130, buffer: 5 });
  // rawStart = 1 + floor(25*130/100)=1+32=33; rawEnd=ceil(50*130/100)=65; ±5 → 28..70
  t("ズレREF 比率スケール", r.refStart === 28 && r.refEnd === 70);
  t("REF上限なし（refTotal内に収まる）", r.refEnd <= 130);
}

// REF手動区切り（TARGET区切り↔REF区切り対応）
{
  const sec = { index: 0, startPage: 1, endPage: 25, pageCount: 25 };
  const r = mapRefRange(sec, { targetTotal: 100, refTotal: 130, buffer: 2, targetBreakpoints: [26, 61], refBreakpoints: [30, 70] });
  // section start=1 → 区間0 → REF 1..(30-1)=29 ±2 → 1..31
  t("手動REF対応 区間0", r.mode === "manual" && r.refStart === 1 && r.refEnd === 31);
}

// ソフト警告: 巨大セクション
{
  const sec = { index: 0, startPage: 1, endPage: 55, pageCount: 55 };
  const r = mapRefRange(sec, { targetTotal: 100, refTotal: 100, buffer: 5 });
  const w = sectionWarnings(sec, r, { softMaxPages: 40 });
  t("55pセクションで警告", w.length >= 1);
}
{
  const sec = { index: 0, startPage: 1, endPage: 25, pageCount: 25 };
  const r = mapRefRange(sec, { targetTotal: 100, refTotal: 100, buffer: 5 });
  const w = sectionWarnings(sec, r, { softMaxPages: 40 });
  t("25pセクションは警告なし", w.length === 0);
}

// 末尾の極小セクションは前へ畳む（実測: 26p を 25/3 で割ると 4p の SEC_002 ができ、
// 往復が1回増えたうえ重ね合わせ区間で同じ誤りが二重に出た）
{
  const s = computeSections(26, { sectionWidth: 25, overlap: 3 });
  t("26p は1セクションに畳む", s.length === 1 && s[0].startPage === 1 && s[0].endPage === 26);
}
{
  const s = computeSections(150, { sectionWidth: 25, overlap: 3 });
  t("末尾が十分な長さなら畳まない(150p)", s[s.length - 1].pageCount >= 10 && s[s.length - 1].endPage === 150);
  t("畳んでも全ページを覆う(150p)", s[0].startPage === 1 && s.every((x, i) => i === 0 || x.startPage <= s[i - 1].endPage + 1));
}
{
  const s = computeSections(28, { sectionWidth: 25, overlap: 3, minLastSection: 1 });
  t("minLastSection=1 なら畳まない", s.length === 2 && s[1].endPage === 28);
}
{
  const s = computeSections(26, { sectionWidth: 25, overlap: 3 });
  t("畳んだ後も総ページを覆う", s[s.length - 1].endPage === 26);
}

if (failures > 0) { console.error(`\nTest-Sectioning: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-Sectioning: PASS");
