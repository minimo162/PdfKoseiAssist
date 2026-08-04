// Test-NumberMask.mjs — 数値マスキングの単体テスト
//
//   node tools/Test-NumberMask.mjs
//
// 漏洩は静かに起きるので、テストは「漏れていないこと」を主張する形にする。
// 実測で踏んだ罠（docs/benchmarks/README.md / docs/plan/NUMBER_MASKING_SPEC.md）を
// そのままケースにしてある。とくに **部分マスク** は、モデルが漏れた桁から
// 記号の値を逆算できてしまうので、1件でも通してはいけない。

import { Masker, unmask, verify, tokenizeJa, tokenizeEn, maskSidecarByRole, DEFAULT_ALLOW } from "../js/number-mask.mjs";

let bad = 0;
const t = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name);
  else { bad++; console.error("  FAIL " + name); if (detail !== undefined) console.error("       " + JSON.stringify(detail)); }
};
const M = (seed = 7) => new Masker(seed);

// --- 1. 部分マスクを作らない（最重要） --------------------------------
{
  // 実測: `-4,500` の先頭桁が伏せられず `-4,⟦#NCH⟧` になり、モデルが値を逆算した。
  for (const [lang, src] of [["en", "a loss of -4,500 million yen"], ["en", "(4,500) million yen"],
                             ["en", "4500 units"], ["ja", "△4,500百万円"], ["ja", "4500台"]]) {
    const m = M();
    const { text } = m.mask(src, lang);
    t(`部分マスクにならない [${lang}] ${src}`, !/[\d,]\s*⟦|⟧\s*[\d,]/.test(text), text);
  }
  // "4500" が "450" で切れないこと（カンマ形を `*` にすると起きる）
  t("カンマ無しの4桁が途中で切れない", tokenizeEn("4500 units")[0]?.raw === "4500", tokenizeEn("4500 units"));
  t("カンマ有りが1トークンになる", tokenizeEn("4,500 units")[0]?.raw === "4,500", tokenizeEn("4,500 units"));
}

// --- 2. 検証器が部分マスクを捕まえる ----------------------------------
{
  t("記号に数字が隣接していたら中止", verify("金額は -4,⟦#NCH⟧ です").ok === false);
  t("その理由が partial-mask", verify("金額は -4,⟦#NCH⟧ です").leaks.some(l => l.why === "partial-mask"));
  // ⚠️ 残りが短いと (2) の許可リストを素通りしうる。密着検査 (1) が本命。
  t("残った桁が1桁でも捕まえる", verify("⟦#ABC⟧4 million").ok === false);
  {   // 手書きではなく、実際にマスクした出力を検証する
    const src = "2026年3月期 第2四半期 (12) P.48 の売上高は458,921百万円";
    const out = M().mask(src, "ja").text;
    t("正常なマスク済みテキストは通る", verify(out).ok === true, { out, leaks: verify(out).leaks });
  }
  t("許可リスト外の数字が残っていたら中止", verify("売上高は 458,921 百万円").ok === false);
  t("壊れた記号を捕まえる", verify("売上高は⟦#PQ⟧円").ok === false);
}

// --- 3. 同じ実量には同じ記号（日英を通じて） --------------------------
{
  const m = M();
  const ja = m.mask("売上高は1兆2,857億円となりました。", "ja").text;
  const en = m.mask("Net sales amounted to ¥1,285.7 billion.", "en").text;
  const s1 = ja.match(/⟦#[A-Z]{3}⟧/)[0], s2 = en.match(/⟦#[A-Z]{3}⟧/)[0];
  t("1兆2,857億円 と ¥1,285.7 billion が同じ記号", s1 === s2, { ja, en });

  const m2 = M();
  const a = m2.mask("48百万円", "ja").text, b = m2.mask("48 million yen", "en").text;
  t("48百万円 と 48 million yen が同じ記号", a.match(/⟦#[A-Z]{3}⟧/)[0] === b.match(/⟦#[A-Z]{3}⟧/)[0]);

  const m3 = M();
  const c = m3.mask("48百万円", "ja").text, d = m3.mask("48 thousand yen", "en").text;
  t("48百万円 と 48 thousand yen は違う記号（誤訳として出る）",
    c.match(/⟦#[A-Z]{3}⟧/)[0] !== d.match(/⟦#[A-Z]{3}⟧/)[0]);

  const m4 = M();
  const e = m4.mask("12億円", "ja").text, f = m4.mask("1.2 billion yen", "en").text;
  t("12億円 と 1.2 billion yen が同じ記号（正しい換算を誤検知しない）",
    e.match(/⟦#[A-Z]{3}⟧/)[0] === f.match(/⟦#[A-Z]{3}⟧/)[0]);

  const m5 = M();
  const g = m5.mask("12億円", "ja").text, h = m5.mask("12 million yen", "en").text;
  t("12億円 と 12 million yen は違う記号", g.match(/⟦#[A-Z]{3}⟧/)[0] !== h.match(/⟦#[A-Z]{3}⟧/)[0]);
}

// --- 4. 浮動小数点を使っていない --------------------------------------
{
  // 実測: 32.8×10⁹ が float だと 32799999999.999996 になり、別の記号が振られた。
  const m = M();
  const a = m.mask("328億円", "ja").text, b = m.mask("32.8 billion yen", "en").text;
  t("328億円 と 32.8 billion yen が同じ記号（10進で厳密に計算している）",
    a.match(/⟦#[A-Z]{3}⟧/)[0] === b.match(/⟦#[A-Z]{3}⟧/)[0], { a, b });
}

// --- 5. 許可リスト -----------------------------------------------------
{
  const m = M();
  const s = m.mask("2026年3月期 第160期 注1 P.48 の売上高は458,921百万円", "ja").text;
  t("年を残す", s.includes("2026"), s);
  t("構造番号を残す（第N期・注・ページ）",
    s.includes("第160期") && s.includes("注1") && s.includes("P.48"), s);
  t("事業データはマスクする", !s.includes("458,921"), s);

  // ⚠️ 実測（実物の短信・20260804のマスク実行）: 括弧付きの数字を無条件で見出し番号として
  //    許していたため、英文表の負値が **平文のまま外へ出た**。
  //      Allowance for doubtful receivables (603) (643)
  //      Total (926) / Other ⟦#PLF⟧ ⟦#WXM⟧ (9)
  //    見出し番号は行頭（か「:」直後）で直後が文字。表の値は行の途中で直後が数値・記号・行末。
  const mp = M();
  const sp = mp.mask([
    "(1) Overview of Consolidated Business Results",
    "Notes: (2) Application of accounting treatment",
    "Allowance for doubtful receivables (603) (643)",
    "Total (926)",
    "Income taxes (429) - (461)",
  ].join("\n"), "en").text;
  t("行頭の見出し番号は残す", sp.includes("(1) Overview"), sp);
  t("「:」直後の見出し番号も残す", sp.includes("Notes: (2) Application"), sp);
  t("表の括弧付き負値は伏せる（見出し番号と誤認しない）",
    !/\(603\)|\(643\)|\(926\)|\(429\)|\(461\)/.test(sp), sp);
  t("括弧は残るので符号は読める", /\(⟦#[A-Z]{3}⟧\)/.test(sp), sp);
  t("マスク後は検証を通る（括弧付き負値）", verify(sp).ok, verify(sp).leaks);

  // ⚠️ 許可パターンが数値の **頭だけ** を食うと、残りごと平文で通る。
  //    脚注記号 `* 1` を許していたので `* 1,234` の 1,234 が素通りしていた。
  const mc = M();
  const sc = mc.mask("※ 1,234百万円 / Note 12,345 / P.1,500", "ja").text;
  t("許可パターンが頭だけ食った数値は伏せる", !/1,234|12,345|1,500/.test(sc), sc);
  t("マスク後は検証を通る（頭食い）", verify(sc).ok, verify(sc).leaks);

  // ⚠️ 実測（実物の有報）: 「1〜2桁なら構造番号」という規則にしていたため、
  //    `Scope 1 (direct emissions) 97 97` の 97（実データ）が平文で残った。
  //    桁数ではなく **書式** で判定すること。
  const m2 = M();
  const s2 = m2.mask("Scope 1 (direct emissions) 97 97 and Note 2 on p.12", "en").text;
  t("表の中の2桁データは伏せる（桁数で判定しない）", !/\b97\b/.test(s2), s2);
  t("そのとき Note 2 と p.12 は残る", s2.includes("Note 2") && s2.includes("p.12"), s2);
  t("マスク後は検証を通る", verify(s2).ok, verify(s2).leaks);

  // 構造番号を外すと位置が報告できなくなる（実測で指摘が丸ごと使えなくなった）
  const m3 = M();
  const s3 = m3.mask("P.48 の本文", "ja", { ...DEFAULT_ALLOW, structure: false }).text;
  t("許可リストを切れば構造番号も伏せられる（切ると危険であることの確認）", !s3.includes("48"), s3);
}

// --- 6. 符号 -----------------------------------------------------------
{
  const m = M();
  const s = m.mask("営業利益は△1,234百万円、経常損失は▲567百万円", "ja").text;
  t("△ ▲ は平文で残る", s.includes("△") && s.includes("▲"), s);
  const m2 = M();
  const a = m2.mask("△1,234百万円", "ja").text, b = m2.mask("1,234百万円", "ja").text;
  t("記号は絶対値で振る（符号違いが記号の違いに化けない）",
    a.match(/⟦#[A-Z]{3}⟧/)[0] === b.match(/⟦#[A-Z]{3}⟧/)[0], { a, b });
  // ハイフンを負号にすると符号が一斉に逆になる（実測で 296↔-296 が8件出た）
  t("ハイフンは負号として扱わない", tokenizeEn("­ 4,500 ­")[0].sign === "", tokenizeEn("­ 4,500 ­"));
  t("開いて閉じた括弧だけ負号", tokenizeEn("(4,500) million")[0].sign === "(");
  t("閉じていない括弧は負号にしない", tokenizeEn("see (item A 4,500 million")[0].sign === "");
}

// --- 7. 往復 -----------------------------------------------------------
{
  const cases = [
    ["ja", "当連結会計年度の研究開発人員は312人である。売上高は1兆2,857億円、営業利益は△328億円。"],
    ["en", "Net sales amounted to ¥1,285.7 billion, an increase of (9.8) billion yen or 16.9%."],
    ["ja", "2026年3月期 第2四半期 (12) 注1 の金額は48百万円、前期は4,500千円であった。"],
  ];
  for (const [lang, src] of cases) {
    const m = M();
    const { text, used } = m.mask(src, lang);
    t(`往復で元に戻る [${lang}]`, unmask(text, used) === src, { src, text, back: unmask(text, used) });
    t(`マスク後は検証を通る [${lang}]`, verify(text).ok, verify(text).leaks);
  }
}

// --- 8. 採番 -----------------------------------------------------------
{
  const m = M(12345);
  const syms = [];
  for (let v = 100; v < 130; v++) syms.push(m.mask(`${v},000円`, "ja").text.match(/⟦#[A-Z]{3}⟧/)[0]);
  t("記号が重複しない", new Set(syms).size === syms.length);
  t("記号が出現順に並んでいない（大小関係を推測されない）",
    !syms.every((s, i) => i === 0 || s >= syms[i - 1]), syms.slice(0, 6));
  t("記号に数字を使わない（残った数字＝漏れ、で判定できる）", syms.every(s => !/\d/.test(s)));
  const m2 = M(1), m3 = M(2);
  t("ジョブごとに採番が変わる",
    m2.mask("1,000円", "ja").text !== m3.mask("1,000円", "ja").text);
}

// --- 9. TEXTサイドカー（英日が1ファイルに同居） ------------------------
{
  // ⚠️ 実測: ja→en の通しがけにしたら、日本語パスが英文の 1,285.7 を裸の数値として
  //    先に伏せ、billion が効かず **日英で別の記号** になった。設計の根幹が壊れる。
  const sidecar =
    "TARGET_CHECK: P.1-2 / REF_CANDIDATE: P.3-4\n" +
    "===== PDF P.1 / TARGET_CHECK / 元PDF P.1 / a.pdf =====\n" +
    "Net sales amounted to ¥1,285.7 billion.\n" +
    "===== PDF P.2 / REF1_CANDIDATE / 元PDF P.2 / b.pdf =====\n" +
    "売上高は1兆2,857億円となりました。\n";
  const out = maskSidecarByRole(sidecar, M());
  const syms = [...out.matchAll(/⟦#[A-Z]{3}⟧/g)].map(x => x[0]);
  t("役割ごとに言語を分けるので日英で同じ記号になる", syms.length === 2 && syms[0] === syms[1], { out, syms });
  t("ブロック見出しは伏せない（REF1_CANDIDATE が読めなくならない）",
    out.includes("REF1_CANDIDATE") && out.includes("PDF P.1 / TARGET_CHECK"), out);
  t("ページ範囲 P.1-2 を伏せない", out.includes("P.1-2"), out);
  t("サイドカー全体が検証を通る", verify(out).ok, verify(out).leaks);
}

if (bad) { console.error(`\nTest-NumberMask: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-NumberMask: PASS");
