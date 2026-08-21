// Test-NumberMask.mjs — 数値マスキングの単体テスト
//
//   node tools/Test-NumberMask.mjs
//
// 漏洩は静かに起きるので、テストは「漏れていないこと」を主張する形にする。
// 実測で踏んだ罠（docs/benchmarks/README.md / docs/plan/NUMBER_MASKING_SPEC.md）を
// そのままケースにしてある。とくに **部分マスク** は、モデルが漏れた桁から
// 記号の値を逆算できてしまうので、1件でも通してはいけない。

import { Masker, unmask, verify, unmaskFragment, unmaskFragmentVariants, tokenizeJa, tokenizeEn, maskSidecarByRole, truncateWithoutSplittingNumber, DEFAULT_ALLOW } from "../js/number-mask.mjs";

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
  {
    // 実測（別PC・SEC_001）: PDF表の列間空白が消え、4,500の直後に
    // 次セルの1〜2桁値がカンマだけで連結された。最後の値を「桁区切りの途中」
    // として飛ばすと `⟦#...⟧,6` が残り、partial-maskで送信が止まる。
    for (const lang of ["en", "ja"]) {
      const out = M().mask("4,500,6 8,200,17 9,100,2024", lang).text;
      t(`列間空白が消えたカンマ接続値を個別に伏せる [${lang}]`,
        verify(out).ok && (out.match(/⟦#[A-Z]{3}⟧/g) || []).length === 6, out);
    }
    t("正しい3桁区切りは従来どおり1トークン",
      tokenizeEn("1,234,567 units")[0]?.raw === "1,234,567", tokenizeEn("1,234,567 units"));
    for (const src of ["4500,567", "123.45,678", "4,500.0,123"]) {
      const out = M().mask(src, "en").text;
      t(`左セルが未グループ化・小数なら右3桁も別セルとして伏せる [${src}]`,
        verify(out).ok && (out.match(/⟦#[A-Z]{3}⟧/g) || []).length === 2, { out, leaks: verify(out).leaks });
    }
    const validGrouped = M().mask("12,345,678", "en").text;
    t("左側が正しい桁区切りなら12,345,678を1トークンで伏せる",
      verify(validGrouped).ok && (validGrouped.match(/⟦#[A-Z]{3}⟧/g) || []).length === 1, validGrouped);
    const clusteredRows = Array.from({ length: 12 }, (_, i) => `${i + 1},500,${(i % 17) + 1}`).join(" ");
    const sidecar = [
      "PAGE_MAP:",
      "===== PDF P.1 / TARGET_CHECK / failing.pdf =====",
      clusteredRows,
    ].join(String.fromCharCode(10));
    const sidecarOut = maskSidecarByRole(sidecar, M(), () => "en");
    t("SEC_001型の連続12件をサイドカー経路でも漏れなく伏せる",
      verify(sidecarOut).ok && !/\d[,，]⟦|⟧[,，]\d/.test(sidecarOut), { sidecarOut, leaks: verify(sidecarOut).leaks });
    const date = M().mask("September 30,2024", "en").text;
    t("空白なしの英語日付は公開日付として従来どおり残す", date === "September 30,2024" && verify(date).ok, date);
  }
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

// --- 3b. 記号のunit-family証拠（値そのものは外へ出さない） ------------
{
  const m = M();
  const money = m.mask("Net sales 1 million yen", "en").used[0].symbol;
  const sameMoney = m.mask("Net sales 1,000 thousand yen", "en").used[0].symbol;
  const units = m.mask("Vehicle sales 2 million units", "en").used[0].symbol;
  const untyped = m.mask("Total 3", "en").used[0].symbol;
  const collisionMasker = M();
  const collisionMoney = collisionMasker.mask("Net sales 1 million yen", "en").used[0].symbol;
  const collision = collisionMasker.mask("Vehicle sales 1 million units", "en").used[0].symbol;
  t("同一familyの記号証拠をknownとして公開する",
    m.getSymbolFamilyEvidence(money).status === "known"
      && m.getSymbolFamilyEvidence(money).family === "money");
  t("既知のmoneyとunitsはdisjointとして公開する",
    m.compareSymbolUnitFamilies(money, units).status === "disjoint");
  t("同じ実量でmoneyとunitsが衝突した記号はambiguousのままにする",
    collisionMoney === collision && collisionMasker.getSymbolFamilyEvidence(collisionMoney).status === "ambiguous"
      && collisionMasker.compareSymbolUnitFamilies(collisionMoney, collision).status === "unknown");
  t("未型記号のfamily証拠はunknownのままにする",
    m.getSymbolFamilyEvidence(untyped).status === "unknown"
      && m.compareSymbolUnitFamilies(untyped, sameMoney).status === "unknown");
  t("既存の丸め互換判定はfamily証拠追加後も維持する",
    m.areSymbolsCompatible(money, sameMoney));
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

  // ⚠️ 実測（26pフィクスチャをアプリの実経路で流した結果・2026-08-04）:
  //    段組みで `68,921百\n万円` と単位が行またぎになっており、「百万」が繋がっていないため
  //    裸の 68,921 として読んでいた。英文 `68,921 million yen` と 10⁶ ずれて別記号になり、
  //    **正しい訳をモデルが誤りとして報告した**（マスカー由来の誤検知）。
  const mb = M();
  const jaBroken = mb.mask("その他事業68,921百\n万円である。", "ja").text;
  const enBroken = mb.mask("and 68,921 million yen for the Other business.", "en").text;
  const symOf = t => (t.match(/⟦#[A-Z]{3}⟧/g) || [])[0];
  t("単位が行またぎでも同じ実量になる（百\\n万）", symOf(jaBroken) === symOf(enBroken), [jaBroken, enBroken]);
  t("行またぎの単位ごと伏せる", !/68,921/.test(jaBroken) && !/百\s*万/.test(jaBroken), jaBroken);

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

  {
    const m = M();
    m.mask("(In millions of yen)\nNet sales 100\n===== APP LAYOUT BLOCK / BODY =====\nDomestic 200", "en");
    const first = m.occurrences.find(o => o.raw === "100");
    const second = m.occurrences.find(o => o.raw === "200");
    t("layout block境界を越えて前表の単位を継承しない",
      first?.chosenExp === 6 && second?.chosenExp === 0,
      { first, second });
  }
  {
    const m=M();
    m.mask("Net sales (Millions of yen) 402,110\n===== APP LAYOUT BLOCK / TABLE =====\nAPP_TABLE_CONTEXT: (Millions of yen)\n72nd period 402,110","en");
    const found=m.occurrences.filter(o=>o.raw==="402,110");
    t("同一ページで分割された表blockは一意な単位証拠を補完する",found.length===2&&found[0].symbol===found[1].symbol,found);
  }
  {
    const m=M();
    m.mask("Net sales (Millions of yen) 1,680\n===== APP LAYOUT BLOCK / BODY =====\nOf the 1,680 patents held by the Group","en");
    const found=m.occurrences.filter(o=>o.raw==="1,680");
    t("特許件数を別blockの金額証拠で上書きしない",found.length===2&&found[0].symbol!==found[1].symbol,found);
  }
  {
    const m=M();
    m.mask("Net sales (Millions of yen) 1,680\n===== APP LAYOUT BLOCK / BODY =====\nThere were 1,680.","en");
    const found=m.occurrences.filter(o=>o.raw==="1,680");
    t("無型の散文数値を別blockの金額証拠で上書きしない",found.length===2&&found[0].symbol!==found[1].symbol,found);
  }
  {
    const m=M();
    m.mask("Net sales (Millions of yen) 1,680\n===== APP LAYOUT BLOCK / TABLE =====\nTemperature 1,680","en");
    const found=m.occurrences.filter(o=>o.raw==="1,680");
    t("無型TABLEを同値の金額証拠だけで上書きしない",found.length===2&&found[0].symbol!==found[1].symbol&&found[1].chosenExp===0&&!found[1].family,found.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)})));
  }
  {
    const m=M();
    m.mask("===== APP LAYOUT BLOCK / TABLE =====\n(In millions of yen)\n(In thousands of units)\nNet sales 100 200\nTemperature 300 400","en");
    const found=m.occurrences.filter(o=>["300","400"].includes(o.raw));
    t("単一の近傍ラベルで別の行を金額化しない",found.length===2&&found.every(o=>o.chosenExp===0&&!o.family),found.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)})));
  }
  {
    const m=M();
    m.mask("===== APP LAYOUT BLOCK / TABLE =====\n(In millions of yen)\n(In thousands of units)\nNet sales 100 200\nOperating income 50 60\nProfit before tax 20 30\n300 400","en");
    const found=m.occurrences.filter(o=>["300","400"].includes(o.raw));
    t("純数値行が1行だけなら表regionの単位を推測しない",found.length===2&&found.every(o=>o.chosenExp===0&&!o.family),found.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)})));
  }
  {
    const m=M();
    m.mask("===== APP LAYOUT BLOCK / TABLE =====\n(In millions of yen)\n(In thousands of units)\nDomestic 100\nOverseas 200\nTotal 300","en");
    const found=m.occurrences.filter(o=>["100","200","300"].includes(o.raw));
    t("混在単位表の地域名だけで最新の台数単位を採用しない",found.length===3&&found.every(o=>o.chosenExp===0&&!o.family),found.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)})));
  }
  {
    const m=M();
    m.mask("===== APP LAYOUT BLOCK / TABLE =====\n(In millions of yen)\n(In thousands of units)\nGlobal sales volume 300\nNet sales\nDomestic 1,000 1,100\nOverseas 2,500 2,600","en");
    const regions=m.occurrences.filter(o=>["1,000","1,100","2,500","2,600"].includes(o.raw));
    const volume=m.occurrences.find(o=>o.raw==="300");
    t("販売台数の単位を後続のNet salesセクションへ越境させない",
      volume?.family==="units"&&volume.chosenExp===3&&regions.length===4&&regions.every(o=>o.chosenExp===0&&!o.family),
      {volume:volume&&{raw:volume.raw,family:volume.family,chosenExp:volume.chosenExp,source:volume.source},regions:regions.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)}))});
  }
  {
    const sidecar =
      "===== PDF P.1 / TARGET_CHECK / x =====\n" +
      "===== APP LAYOUT BLOCK / TABLE =====\nAPP_TABLE_CONTEXT: (単位：千台)\n日本 147\n計 301\n" +
      "===== PDF P.2 / TARGET_CHECK / x =====\n" +
      "===== APP LAYOUT BLOCK / MARGINAL-HEADER =====\n(単位：千台／億円)\n" +
      "===== APP LAYOUT BLOCK / TABLE =====\nAPP_TABLE_CONTEXT: (単位：千台)\n北米 147\n計 301\n";
    const m=M(),out=maskSidecarByRole(sidecar,m);
    for(const raw of ["147","301"]){
      const found=m.occurrences.filter(o=>o.raw===raw&&o.layoutRole==="TABLE");
      t(`別blockの単位見出しを持つ表でも同じ台数を統一する ${raw}`,found.length===2&&found[0].symbol===found[1].symbol&&found.every(o=>o.family==="units"&&o.chosenExp===3),{found:found.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)})),out});
    }
  }
  {
    const sidecar =
      "===== PDF P.1 / REF1_CANDIDATE / x =====\n===== APP LAYOUT BLOCK / TABLE =====\nAPP_TABLE_CONTEXT: (単位：百万円)\n売上高 4,918,172\n" +
      "===== PDF P.2 / REF1_CANDIDATE / x =====\n===== APP LAYOUT BLOCK / MARGINAL-HEADER =====\n(単位：百万円)\n===== APP LAYOUT BLOCK / TABLE =====\nAPP_TABLE_CONTEXT: (単位：百万円)\n外部顧客への売上高 4,918,172\n";
    const m=M(),out=maskSidecarByRole(sidecar,m),found=m.occurrences.filter(o=>o.raw==="4,918,172"&&o.layoutRole==="TABLE");
    t("別blockの百万円見出しでも同じ売上高を統一する",found.length===2&&found[0].symbol===found[1].symbol&&found.every(o=>o.family==="money"&&o.chosenExp===6),{found:found.map(o=>({...o,micro:String(o.micro),quantum:String(o.quantum)})),out});
  }
  {
    const m=M();
    m.mask("APP_TABLE_CONTEXT: 連結業績 (単位：億円) グローバル販売台数 (単位：千台)\n為替レート（円）\nUSドル 155\nユーロ 180", "ja");
    for(const raw of ["155","180"]){
      const found=m.occurrences.find(o=>o.raw===raw);
      t(`混在表の為替レートを金額スケール化しない ${raw}`,found?.family==="rate"&&found?.chosenExp===0,{found:found?{...found,micro:String(found.micro),quantum:String(found.quantum)}:null});
    }
  }
  {
    const m=M();
    m.mask("APP_TABLE_CONTEXT: (単位：千台／億円)\n固定費他 17 +123 △166", "ja");
    const found=m.occurrences.find(o=>o.raw==="123");
    t("混在表の固定費を億円として扱う",found?.family==="money"&&found?.chosenExp===8,{found:found?{...found,micro:String(found.micro),quantum:String(found.quantum)}:null});
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

// --- 10. 抜粋の切り詰めが数値を割らない -------------------------------
// 実測（長尺フィクスチャ・PACKET_008ほか計8件）: FAST_REVIEW_INDEX の抜粋が
// `12,650` を `12,6…` で切り、マスカーが `12` だけを伏せて `,6` が平文で残った。
{
  t("切り詰めが数値の途中で起きない",
    !/\d[.,]?$/.test(truncateWithoutSplittingNumber("Buildings and structures (Millions of yen) 12,650 ほか", 45).replace(/…$/, "")),
    truncateWithoutSplittingNumber("Buildings and structures (Millions of yen) 12,650 ほか", 45));
  t("上限以下なら切らない（末尾の数値も残す）",
    truncateWithoutSplittingNumber("Total 12,650", 100) === "Total 12,650");

  // 前書き（役割ブロックの外）に切り詰めた抜粋が入っても検証を通ること。
  const src = "Buildings and structures (Millions of yen) 12,650 and more text follows here";
  const sidecar =
    "PDF校正アシスト 抽出テキスト: X\n\n" +
    "TARGET_CHECK_FAST_REVIEW_INDEX:\n" +
    `- 元PDF P.72 / text_chars=1234: ${truncateWithoutSplittingNumber(src, 48)}\n\n` +
    "===== PDF P.72 / TARGET_CHECK / 元PDF P.72 / t.pdf =====\n" + src + "\n";
  const out = maskSidecarByRole(sidecar, M());
  t("切り詰めた抜粋を含むサイドカーが検証を通る", verify(out).ok, verify(out).leaks);
}

// --- 11. 前書きの抜粋は TARGET の言語で伏せる -------------------------
// ⚠️ 前書きを丸ごと ja で伏せると、英文 `68,921 million yen` が index行では 68,921、
//    本文では 68,921×10⁶ と読まれ、**同じ文に別の記号**が付く。モデルは設計どおり
//    「記号が違えば別の値」と信じるので、正しい訳を誤りとして報告する（§2.3 と同型）。
{
  const line = "Operating profit was 68,921 million yen this year.";
  const sidecar =
    "HEAD\n\n" +
    "TARGET_CHECK_FAST_REVIEW_INDEX:\n" +
    `- 元PDF P.5 / text_chars=99: ${line}\n\n` +
    "===== PDF P.5 / TARGET_CHECK / 元PDF P.5 / t.pdf =====\n" + line + "\n";
  const out = maskSidecarByRole(sidecar, M());
  const syms = [...out.matchAll(/⟦#[A-Z]{3}⟧/g)].map(x => x[0]);
  // text_chars=99 の分を除いた、本文由来の2つが一致すること
  const body = syms.slice(-2);
  t("index行と本文で同じ実量に同じ記号が付く", body.length === 2 && body[0] === body[1], { out, syms });
  t("前書きに抜粋がある場合も検証を通る", verify(out).ok, verify(out).leaks);
}

// --- 表の単位は行の見出しにある（セルは裸の数字） ----------------------
// 実測（200ページ版・幅25・masked-text の整合性レビュー）: 表の `458,921`
// （単位は行の見出し「(Millions of yen)」）と本文の `458,921 million yen` に
// **別の記号**が付き、Copilot が「P.6 と P.22 の売上高が一致しない」と6件報告した。
// 整合性レビューは離れた2箇所の突き合わせが仕事なので、これでは仕事にならない。
{
  // 1つの Masker に両方を通し、最後の記号どうしを比べる
  const pair = (a, b, lang) => {
    const m = M();
    const x = m.mask(a, lang).text.match(/⟦#[A-Z]{3}⟧/g) || [];
    const y = m.mask(b, lang).text.match(/⟦#[A-Z]{3}⟧/g) || [];
    return [x[x.length - 1], y[y.length - 1]];
  };
  {
    const [a, b] = pair("Net sales (Millions of yen) 458,921", "Net sales were 458,921 million yen.", "en");
    t("[en] 行の見出しの単位を裸のセルが継承する", a === b, { a, b });
  }

  {
    const m = M();
    const text = m.mask("===== PDF P.1 =====\n(In millions of yen)\nRate (%)\nMargin 16.9\nDeferred tax assets 16.9\nDeferred tax assets were 16.9 million yen", "en").text;
    const lines = text.split("\n");
    const margin = lines.find(line => line.startsWith("Margin"))?.match(/⟦#[A-Z]{3}⟧/)?.[0];
    const taxLines = lines.filter(line => line.startsWith("Deferred"));
    const tax = taxLines[0]?.match(/⟦#[A-Z]{3}⟧/)?.[0];
    const explicitMillion = taxLines[1]?.match(/⟦#[A-Z]{3}⟧/)?.[0];
    t("比率見出し後でも単一小数の金額行はページ単位を継承", margin !== tax && tax === explicitMillion, { margin, tax, explicitMillion, text });
  }
  {
    const [a, b] = pair("売上高（百万円） 458,921", "売上高は458,921百万円である。", "ja");
    t("[ja] 行の見出しの単位を裸のセルが継承する", a === b, { a, b });
  }
  {
    // 行をまたいで効かせてはいけない（同じ表に「（人）」の行が並ぶ）
    const out = M().mask("Net sales (Millions of yen) 3,214" + String.fromCharCode(10)
      + "Number of employees (Persons) 3,214", "en").text;
    const syms = out.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("次の行には継承しない（（人）の行が百万倍にならない）", syms.length === 2 && syms[0] !== syms[1], syms);
  }
  {
    // 単位語が付いている数値は継承より優先（二重に掛けない）
    const [a, b] = pair("Total (Millions of yen) 1,200 million yen", "Total was 1,200 million yen", "en");
    t("単位語がある数値に継承を重ねない", a === b, { a, b });
  }
  t("継承しても平文の数字は残らない",
    verify(M().mask("Net sales (Millions of yen) 458,921 428,090", "en").text).ok);
  {
    // 自分の単位を持つ数値は継承しない。
    // 「(Millions of yen) … (up 7.2%)」の 7.2 まで百万倍にすると、他ページの 7.2% と
    // 別記号になり、直そうとした幻の不一致を別の形で作ってしまう。
    const [a, b] = pair("Net sales (Millions of yen) 458,921 (up 7.2%)", "The margin was 7.2% this year.", "en");
    t("同じ行の % は継承しない", a === b, { a, b });
  }
  {
    const [a, b] = pair("売上高（百万円） 458,921 従業員 3,214人", "従業員数は3,214人である。", "ja");
    t("同じ行の「人」は継承しない", a === b, { a, b });
  }
  t("継承した4桁は西暦として素通りしない",
    (M().mask("Net sales (Millions of yen) 2,026", "en").text.match(/⟦#[A-Z]{3}⟧/g) || []).length === 1);
  {
    const m=M(),masked=m.mask("Overseas 2,000", "en").text;
    t("カンマ付き2,000を西暦として平文に残さない",/⟦#[A-Z]{3}⟧/.test(masked),masked);
    const checked=verify("Overseas 2,000");
    t("未マスクのカンマ付き2,000をverifyが拒否する",!checked.ok,checked);
    t("桁区切りのない西暦2000は従来どおり許可する",M().mask("Year 2000", "en").text.includes("2000"));
    const commaMasker=M(),ascii=commaMasker.mask("Overseas 2,000", "en"),wide=commaMasker.mask("Overseas 2，000", "en");
    t("全角カンマ付き2，000を1数値としてASCIIカンマと統一する",
      ascii.used.length===1&&wide.used.length===1&&ascii.used[0].symbol===wide.used[0].symbol,{ascii,wide});
    const roundTrip=M().mask("Overseas 2，000", "en");
    t("全角カンマ表記を往復復元する",unmask(roundTrip.text,roundTrip.used)==="Overseas 2，000",roundTrip);
  }

  // --- NUMBER_MASKING_SPEC §4.2c（実物の有報167ページで送信が止まった件） ---
  //
  // ⚠️ ここが壊れると**実物では1指摘も出せない**。合成フィクスチャは通ってしまうので、
  //    この節のテストが唯一の歯止めになる（実物PDFは第三者の著作物なのでコミットしていない）。
  //    実物での再確認は `node tools/Audit-DocumentMask.mjs <pdf>`。
  const NL = String.fromCharCode(10);
  {
    // 規則1・2: 注記参照の番号列は塊。途中で割ると残りが平文で出て、送信が中止される。
    for (const [name, src] of [
      ["(Notes 4,5)", "Ratio of male employees taking childcare leave (%) (Notes 4,5)"],
      ["*2,6", "Number of shares (Shares) 1,234 *2,6"],
      ["表の注記参照列 16,17", "Finance income 16,17 1,234 5,678"],
      ["注記 3,4", "退職給付に係る負債 注記3,4 1,234"],
    ]) {
      const out = M().mask(src, /[ぁ-ん一-龥]/.test(src) ? "ja" : "en").text;
      t(`注記参照の番号列を割らない（${name}）`, verify(out).ok, out);
    }
  }
  {
    // 規則4: 桁区切りは3桁ずつ。`30,2024` は桁区切りではないので `30,202` を食ってはいけない。
    // 実物 p126: `September 30,2024`（カンマ後の空白なし）で `4` が平文で残った。
    const out = M().mask("Ordinary shares 24,357 85.00 September 30,2024 December 2, 2024", "en").text;
    t("カンマ後が4桁なら桁区切りとして食わない（September 30,2024）", verify(out).ok, out);
  }
  {
    // 規則5: 単位がキャプション行にしかない表。実物では行内8件・キャプション8件で半々だった。
    // ⚠️ pair() は**最後の**記号を比べる。表の行に数値を2つ書くと `(30.6)` の記号を
    //    見てしまうので、比べたい数値だけを最後に置くこと。
    const [a, b] = pair("Amount (Millions of yen) Year-on-year change" + NL + "Pharmaceutical Business 119,870",
      "Net sales were 119,870 million yen.", "en");
    t("キャプション行の単位が次の行の表セルに継承される", a === b, { a, b });
  }
  {
    // 規則5の歯止め: 散文へ漏らさない。漏らすと §2.3 の「幻の不一致」を作る。
    // ⚠️ 英語は語数で分かるが、**日本語の行には空白が無い**ので語数では分けられない。
    //    文末（。/ .）で判定している。
    const [a, b] = pair("Amount (Millions of yen)" + NL
      + "The number of product units shipped in the current consolidated fiscal year was 12,480.",
      "The number of units was 12,480.", "en");
    t("[en] 散文には継承しない（表の直後の文）", a === b, { a, b });
    const [c, d] = pair("金額（百万円）" + NL + "当連結会計年度の水使用量は512,400立方メートルである。",
      "水使用量は512,400立方メートルである。", "ja");
    t("[ja] 散文には継承しない（空白が無いので文末で判定する）", c === d, { c, d });
  }
  {
    // ⚠️ 2026-08-06 に設計を変えた。**空行では打ち切らない。**
    //    以前は「単位行から下へ伝播し、空行・無数字行で打ち切る」だったが、実物の財務諸表は
    //    ラベルが複数行に折り返し、単位の書き方もページ内で混在するため、
    //    打ち切り条件をどう調整しても**表の途中で単位が切れて同じ金額が割れた**
    //    （記号の割れ: 打ち切り2行→85件 / 6行→70件 / 行頭限定→83件。0に近づかなかった）。
    //    財務諸表ではスケールは表＝たいていページごとに一度だけ宣言されるので、
    //    **ブロック内で一度宣言されたらブロック全体に効かせる**設計にした（34件→26件）。
    const out = M().mask("Amount (Millions of yen)" + NL + "Segment A 1,200" + NL + NL + "Total 1,200", "en").text;
    const syms = out.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("空行をまたいでも同じブロックなら継承する（表の途中で切らない）",
      syms.length === 2 && syms[0] === syms[1], syms);
  }
  {
    // 括弧の無い単位列（実物 p4 の5期比較表）。百万倍してはいけない。
    const out = M().mask("Revenue Millions" + NL + "of Yen 297,177 335,138" + NL
      + "Basic earnings per share Yen 186.17 200.36", "en").text;
    const syms = out.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("2行に割れた単位見出しを読む（Millions / of Yen …）", syms.length === 4, syms);
    const [a, b] = pair("Revenue Millions" + NL + "of Yen 297,177", "Revenue was 297,177 million yen.", "en");
    t("2行に割れた見出しでも本文と同じ記号になる", a === b, { a, b });
    const [c, d] = pair("Basic earnings per share Yen 186.17", "EPS was 186.17 yen.", "en");
    t("括弧の無い単位列（Yen）は百万倍しない", c === d, { c, d });
  }
  {
    // 規則5の打ち切り: ページ（ブロック見出し）を跨いで継承しない。
    const out = M().mask("Amount (Millions of yen)" + NL + "Segment A 1,200" + NL
      + "===== PDF P.2 / TARGET_CHECK / x =====" + NL + "Segment A 1,200", "en").text;
    const syms = out.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("ページを跨いで継承しない", syms.length === 2 && syms[0] !== syms[1], syms);
  }
  {
    // 規則3: 部分マスクの検出。カンマの後ろが1〜2桁でも部分マスクとして報告する。
    // 実測では41件が「許可リスト外の数字」に分類され、原因の型が見えなかった。
    const v = verify("Finance income ⟦#JTC⟧,17 ⟦#ABC⟧");
    t("部分マスクを型として検出する（⟦#…⟧,17）",
      !v.ok && v.leaks.some(l => l.why === "partial-mask"), JSON.stringify(v.leaks));
  }
}

{
  // 断片の復元は「最初に見た表記」を当てるので、同じ実量の別表記に化ける。
  // 実測（2026-08-07・校正20パケット）: 本文 `15 Supplementary Schedules` に対して
  // quote が `15.0 Supplementary Schedules` になり、88件中8件がハイライト不可だった。
  const m = new Masker(7);
  m.mask("15.0 percent of the total", "en");
  const masked = m.mask("15 Supplementary Schedules (continued)", "en").text;
  const restored = unmaskFragment(masked, m, "en");
  t("断片の復元は別表記に化けうる（この挙動自体は仕様）",
    restored === "15.0 Supplementary Schedules (continued)", restored);
  const variants = unmaskFragmentVariants(masked, m, "en");
  t("候補の先頭は unmaskFragment と同じ", variants[0] === restored, variants);
  t("候補に本文どおりの表記が含まれる",
    variants.includes("15 Supplementary Schedules (continued)"), variants);
  t("記号が無ければ候補を作らない", unmaskFragmentVariants("no numbers", m, "en").length === 0);
  const many = new Masker(3);
  many.mask("1,000 and 2,000 and 3,000 and 4,000", "en");
  const wide = many.mask("1,000 2,000 3,000 4,000", "en").text;
  t("候補は上限で打ち切る", unmaskFragmentVariants(wide, many, "en", 3).length <= 3);
}

{
  // 比較資料（日本語）でも同じことが起きる。
  //
  // ⚠️ ここは以前 `(1) 監視、(2) 予防、(4) 復旧` で試していたが、
  //    **項番を伏せていること自体が不具合だった**（引き継ぎ書 §項番）。
  //    比較資料の引用欄に、日本語原稿に存在しない `(001) 監視` が出ていた。
  //    項番は構造番号なので伏せないのが正しい。伏せなければ化けようがない。
  //    候補の仕組み自体は**金額**で引き続き守る（`15` と `15.0` は同じ量）。
  const m = new Masker(11);
  m.mask("当期の売上高は 15.0 億円である。", "ja");
  const masked = m.mask("注記 当期の売上高は 15 億円である。", "ja").text;
  t("日本語でも別表記に化ける（金額）",
    unmaskFragment(masked, m, "ja").includes("15.0"), unmaskFragment(masked, m, "ja"));
  t("候補にREF本文どおりの表記が含まれる",
    unmaskFragmentVariants(masked, m, "ja").some(v => /は 15 億円/.test(v)),
    unmaskFragmentVariants(masked, m, "ja"));
  // 項番はそもそも伏せない。これが崩れると引用が改竤される。
  const enumMasked = new Masker(3).mask("対応は、(1) 監視、(2) 予防、(4) 復旧である。", "ja").text;
  t("文中の項番を伏せない",
    enumMasked.includes("(1) 監視、(2) 予防、(4) 復旧"), enumMasked);
  // 英文表の負値は引き続き伏せる（括弧を無条件に許さない）。
  const negMasked = new Masker(3).mask("貸倒引当金 (603) (643)", "ja").text;
  t("表の負値は伏せる", !negMasked.includes("603"), negMasked);
}


// --- 12. ローマ字の規模語（社内資料の実態） ---------------------------
{
  // 利用者からの指摘（2026-08-08）: 「億円を oku yen にしたり、oku とか、
  // 人によっては Oku とか Oku yen とか、スペースも 100 oku か 100oku で揃ってない」
  //
  // 読めないと日本語の「100億円」と別の記号になり、**正しい訳が全部誤検出になる**。
  // 実測（修正前）: 5通りとも日本語とずれていた。
  const forms = ["100 oku yen", "100oku yen", "100 Oku yen", "100 OKU", "100 oku"];
  for (const en of forms) {
    const m = M();
    const a = m.mask("当期の売上高は100億円である。", "ja").text;
    const b = m.mask("Net sales were " + en + ".", "en").text;
    const s = t2 => (t2.match(/⟦#[A-Z]{3}⟧/) || [])[0];
    t(`100億円 と ${en} が同じ記号`, s(a) === s(b), { a, b });
  }
  // ⚠️ 実態（利用者からの訂正・2026-08-08）:
  //    **cho（兆）は使わない**。一兆円は 10,000 oku yen と書く。
  //    **man（万）も使わない**。万円は 10k yen のように k で書く。
  {
    const s2 = x => (x.match(/⟦#[A-Z]{3}⟧/) || [])[0];
    for (const [ja, en] of [["1兆円", "10,000 oku yen"], ["1万円", "10k yen"],
                            ["1万円", "10K yen"], ["10万円", "100k yen"]]) {
      const m2 = M();
      const a2 = m2.mask(ja, "ja").text, b2 = m2.mask(en, "en").text;
      t(ja + " と " + en + " が同じ記号", s2(a2) === s2(b2), { a2, b2 });
    }
  }
  // ⚠️ k は衝突しやすい。単位として取ってはいけない形を固定する。
  {
    const out = M().mask("The site is 10km away and uses 10kW. See Form 10-K.", "en").text;
    t("10km / 10kW / Form 10-K を千として取らない",
      out.includes("km") && out.includes("kW") && out.includes("-K"), out);
  }
}

// --- 13. Mazda短信で実測した単位見出しと丸め ----------------------------
{
  const symbol = text => (text.match(/⟦#[A-Z]{3}⟧/) || [])[0];

  {
    const m = M();
    const exact = m.mask("Net sales were 1,285,706 million yen.", "en").text;
    const rounded = m.mask("Net sales were ¥1,285.7 billion.", "en").text;
    t("1,285,706 million と丸めた1,285.7 billionを同じ量として扱う",
      symbol(exact) === symbol(rounded), { exact, rounded });

    const outside = m.mask("Net sales were 1,285,801 million yen.", "en").text;
    t("丸め幅の外にある1,285,801 millionは別の量",
      symbol(exact) !== symbol(outside), { exact, outside });
  }

  {
    const m = M();
    const low = m.mask("1.2 billion yen", "en").text;
    const high = m.mask("1.3 billion yen", "en").text;
    t("丸め区間の境界で触れる1.2と1.3は別の量", symbol(low) !== symbol(high), { low, high });
  }

  {
    const m = M();
    const hundredMillions = m.mask("(In 100 millions of Yen) Net sales 12,857", "en").text;
    const millions = m.mask("Net sales 1,285,700 million yen", "en").text;
    t("100 millions of Yen表の12,857を10億単位に誤読しない",
      symbol(hundredMillions) === symbol(millions), { hundredMillions, millions });
  }

  {
    const m = M();
    const table = m.mask("(In thousands of units) Total 304", "en").text;
    const prose = m.mask("Total retail sales were 304 thousand units.", "en").text;
    t("thousands of units表の裸セルを千台として扱う",
      symbol(table) === symbol(prose), { table, prose });
  }

  {
    const m = M();
    const en = m.mask("(In thousands of units)\nVolume Rate (%)\nJapan 32 33 1 2.7", "en").text;
    const ja = m.mask("（単位：千台）\n日本 32 33 +1 +2.7%", "ja").text;
    const enSymbols = en.match(/⟦#[A-Z]{3}⟧/g) || [];
    const jaSymbols = ja.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("日英の千台表で販売台数・増減・率に同じ記号が付く",
      JSON.stringify(enSymbols) === JSON.stringify(jaSymbols), { en, ja });
  }

  {
    // 実物のマツダ短信P.4。Rate (%) と Other の間に4行以上あるため、
    // 「直前4行」だけを見る実装では英文の (14.0) が千倍され、日本語の
    // △14.0% と別記号になっていた。
    const m = M();
    const en = m.mask("(In thousands of units)\nFY 2026 FY 2027 vs. Prior Year\nFirst 3 Months First 3 Months\nVolume Rate (%)\nJapan 32 33 1 2.7\nNorth America 147 154 7 4.8\nEurope 39 43 5 11.6\nChina 18 18 0 0.5\nOther 65 56 (9) (14.0)\nTotal 301 304 4 1.2\nUSA 100 107 7 7.4", "en").text;
    const ja = m.mask("（単位：千台）\n2026年3月期 2027年3月期 前年同期比\n増減 増減率\n日本 32 33 +1 +2.7%\n北米 147 154 +7 +4.8%\n欧州 39 43 +5 +11.6%\n中国 18 18 +0 +0.5%\nその他 65 56 △9 △14.0%\n計 301 304 +4 +1.2%\n米国 100 107 +7 +7.4%", "ja").text;
    const last = text => (text.match(/⟦#[A-Z]{3}⟧/g) || []).slice(-4);
    t("離れた比率列見出しでも日英の14.0/1.2/7.4を揃える",
      JSON.stringify(last(en)) === JSON.stringify(last(ja)), { en: last(en), ja: last(ja) });
  }

  {
    // 同じ実PDF P.15/P.14。比率見出しからNet sales行まで離れ、英日で行数も違う。
    const m = M();
    const en = m.mask("(In 100 millions of yen)\n(In thousands of units)\n(Upper left: return on sales)\n% % % %\nDomestic 1 1,524 24.3 1,474 (3.3) 6,160 6.5 6,400 3.9\nOverseas 2 9,474 (12.5) 11,383 20.2 43,022 (3.1) 48,600 13.0\nNet sales 3 10,998 (8.8) 12,857 16.9 49,182 (2.0) 55,000 11.8", "en").text;
    const ja = m.mask("(単位：千台／億円)\n(左肩：売上高利益率)\n％ ％ ％ ％\n売上高 国内 1 1,524 +24.3 1,474 △3.3 6,160 +6.5 6,400 +3.9\n売上高 海外 2 9,474 △12.5 11,383 +20.2 43,022 △3.1 48,600 +13.0\n売上高 計 3 10,998 △8.8 12,857 +16.9 49,182 △2.0 55,000 +11.8", "ja").text;
    const lineSymbols = (text, label) => ((text.split("\n").find(line => line.includes(label)) || "").match(/⟦#[A-Z]{3}⟧/g) || []);
    t("混在単位表のNet sales値・比率を日英で揃える",
      JSON.stringify(lineSymbols(en, "Net sales")) === JSON.stringify(lineSymbols(ja, "売上高 計")),
      { en: lineSymbols(en, "Net sales"), ja: lineSymbols(ja, "売上高 計") });
  }

  {
    const m = M();
    const ja = m.mask("（単位：百万円）\n売上高 1,285,706", "ja").text;
    const en = m.mask("Net sales 1,285,706 million yen", "en").text;
    t("日本語の（単位：百万円）を表のスケールとして扱う",
      symbol(ja) === symbol(en), { ja, en });
  }

  {
    const m = M();
    const ja = m.mask("(単位：千台／億円)\n％ ％\n売上高 計 3 10,998 12,857 16.9", "ja").text;
    const en = m.mask("(In 100 millions of yen)\n% %\nNet sales 3 10,998 12,857 16.9", "en").text;
    const jaSymbols = ja.match(/⟦#[A-Z]{3}⟧/g) || [];
    const enSymbols = en.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("混在見出し（千台／億円）の金額を英語の100 millionsと揃える",
      JSON.stringify(jaSymbols) === JSON.stringify(enSymbols), { ja, en });
  }

  {
    // 実機のマツダ短信 P.4/P.15。P.15 は億円と千台の混在表で、従来は先にある
    // 億円を Global sales volume 行にも継承し、同じ 304千台へ別記号を付けていた。
    const m = M();
    const explicitUnits = m.mask("Global sales volume was 304 thousand units.", "en").text;
    const explicitRegionUnits = m.mask("Japan sales volume was 33 thousand units.", "en").text;
    const mixed = m.mask(
      "(In 100 millions of yen)\n" +
      "(In thousands of units)\n" +
      "Net sales 12,857\n" +
      "Global sales volume 34 301 304 1.2\n" +
      "Japan 29 32 33 2.7",
      "en"
    ).text;
    const explicitMoney = m.mask("Net sales were 1,285,700 million yen.", "en").text;
    const lineSymbols = (text, label) => ((text.split("\n").find(line => line.includes(label)) || "").match(/⟦#[A-Z]{3}⟧/g) || []);
    const mixedVolume = lineSymbols(mixed, "Global sales volume");
    t("ページをまたぐ304千台に同じ記号が付く",
      mixedVolume[2] === symbol(explicitUnits), { explicitUnits, mixed, mixedVolume });
    t("販売台数見出し配下の地域行にも千台を継承する",
      lineSymbols(mixed, "Japan")[2] === symbol(explicitRegionUnits), { explicitRegionUnits, mixed });
    t("混在表の金額行は従来どおり億円を継承する",
      lineSymbols(mixed, "Net sales")[0] === symbol(explicitMoney), { explicitMoney, mixed });
  }

  {
    const m = M();
    const explicitUnits = m.mask("グローバル販売台数は30万4千台", "ja").text;
    const mixed = m.mask("(単位：千台／億円)\nグローバル販売台数 301 304", "ja").text;
    const mixedSymbols = mixed.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("日本語の千台／億円混在表でも販売台数へ千台を適用する",
      mixedSymbols.at(-1) === symbol(explicitUnits), { explicitUnits, mixed, mixedSymbols });
  }

  {
    // 実PDFのPDF.js抽出形。P.14では縦書きの「グローバル販売台数」が数値行から消え、
    // 地域名と値だけが残る。行ラベルだけで単位を選ぶと304が億円になる。
    const p15 =
      "===== PDF P.15 / TARGET_CHECK / en.pdf =====\n" +
      "(In 100 millions of yen)\n(In thousands of units)\n% % % %\n" +
      "Domestic 1 1,524 24.3 1,474 3.3 6,160 6.5 6,400 3.9\n" +
      "Overseas 2 9,474 12.5 11,383 20.2 43,022 3.1 48,600 13.0\n" +
      "Net sales 3 10,998 8.8 12,857 16.9 49,182 2.0 55,000 11.8\n" +
      "Operating income 4 461 328 516 72.3 1,500 190.8\n" +
      "Ordinary income 5 343 428 1,318 30.2 1,400 6.2\n" +
      "Income before income taxes 6 429 399 594 61.9 1,300 118.9\n" +
      "Net income attributable to owners of the parent 7 421 296 351 69.2 900 156.5\n" +
      "Japan 29 32 10.5 33 2.7 144 5.3 153 6.1\n" +
      "North America 30 147 0.7 154 4.8 582 5.7 629 8.1\n" +
      "Europe 31 39 20.8 43 11.6 164 6.0 197 20.5\n" +
      "China 32 18 2.3 18 0.5 71 4.0 71 0.6\n" +
      "Other 33 65 3.1 56 14.0 262 8.2 274 4.8\n" +
      "Global sales volume 34 301 2.8 304 1.2 1,223 6.1 1,324 8.3\n" +
      "Japan 35 35 22.0 33 6.4 142 4.9 148 3.7\n" +
      "North America 36 142 7.7 159 11.9 581 9.6 632 8.7\n" +
      "Europe 37 30 24.6 32 5.3 169 10.2 184 8.7\n" +
      "Other 38 58 14.4 56 3.4 254 11.3 270 6.2\n" +
      "Consolidated wholesales volume 39 266 8.6 280 5.3 1,147 5.9 1,233 7.5\n" +
      "Domestic 40 167 10.0 188 12.5 735 1.8\n" +
      "Overseas 41 109 4.9 108 1.2 430 6.3\n" +
      "Global production volume 42 276 8.0 296 7.1 1,165 3.5\n";
    const p4 =
      "===== PDF P.4 / REF1_CANDIDATE / ja.pdf =====\n" +
      "当第１四半期連結累計期間のグローバル販売台数は、前年同期比1.2%増の304千台となりました。\n" +
      "（単位：千台）\n日本 32 33 +1 +2.7%\n計 301 304 +4 +1.2%\n";
    const p14 =
      "===== PDF P.14 / REF1_CANDIDATE / ja.pdf =====\n" +
      "(単位：千台／億円)\n(左肩：売上高利益率)\n％ ％ ％ ％\n" +
      "売 国 内 1 1,524 +24.3 1,474 △3.3 6,160 +6.5 6,400 +3.9\n上\n" +
      "海 外 2 9,474 △12.5 11,383 +20.2 43,022 △3.1 48,600 +13.0\n高\n" +
      "計 3 10,998 △8.8 12,857 +16.9 49,182 △2.0 55,000 +11.8\n" +
      "日 本 29 32 +10.5 33 +2.7 144 △5.3 153 +6.1\n" +
      "北 米 30 147 +0.7 154 +4.8 582 △5.7 629 +8.1\n" +
      "欧 州 31 39 △20.8 43 +11.6 164 △6.0 197 +20.5\n" +
      "中 国 32 18 △2.3 18 +0.5 71 △4.0 71 △0.6\n" +
      "その他 33 65 △3.1 56 △14.0 262 △8.2 274 +4.8\n" +
      "計 34 301 △2.8 304 +1.2 1,223 △6.1 1,324 +8.3\n" +
      "日 本 35 35 +22.0 33 △6.4 142 +4.9 148 +3.7\n連\n" +
      "結 北 米 36 142 △7.7 159 +11.9 581 △9.6 632 +8.7\n出\n" +
      "欧 州 37 30 △24.6 32 +5.3 169 +10.2 184 +8.7\n荷\n" +
      "台 その他 38 58 △14.4 56 △3.4 254 △11.3 270 +6.2\n数\n" +
      "計 39 266 △8.6 280 +5.3 1,147 △5.9 1,233 +7.5\n" +
      "国 内 40 167 △10.0 188 +12.5 735 △1.8\n" +
      "海 外 41 109 △4.9 108 △1.2 430 △6.3\n" +
      "計 42 276 △8.0 296 +7.1 1,165 △3.5\n";
    const run = sidecar => {
      const m = M();
      maskSidecarByRole(sidecar, m);
      const records = raw => m.occurrences.filter(x => x.raw.replace(/[,\s]/g, "") === raw);
      return { m, units304: records("304"), money12857: records("12857") };
    };
    for (const [name, sidecar] of [["正順", p15 + p4 + p14], ["逆順", p14 + p4 + p15]]) {
      const result = run(sidecar);
      t(`実抽出形の304千台をページ順に依存せず統一（${name}）`,
        new Set(result.units304.map(x => x.micro.toString())).size === 1,
        { units304: result.units304.map(x => ({ raw: x.raw, micro: x.micro.toString(), symbol: x.symbol })) });
      t(`実抽出形の12,857億円を維持（${name}）`,
        result.money12857.some(x => x.micro === 1285700000000000000n),
        { money12857: result.money12857.map(x => ({ micro: x.micro.toString(), exp: x.chosenExp, family: x.family, source: x.source })) });
      for (const raw of ["1223", "1324", "266", "280"]) {
        const records = result.m.occurrences.filter(x => x.raw.replace(/[,\s]/g, "") === raw && x.family === "units");
        t(`実抽出形の${raw}千台を日英で統一（${name}）`,
          records.length >= 2 && new Set(records.map(x => x.micro.toString())).size === 1
            && records.every(x => x.chosenExp === 3), records.map(x => ({ raw: x.raw, lang: x.lang, exp: x.chosenExp, source: x.source })));
      }
      const amount296 = result.m.occurrences.filter(x => x.raw === "296");
      t(`296億円と296千台を別量として維持（${name}）`,
        new Set(amount296.map(x => x.micro.toString())).size === 2
          && new Set(amount296.filter(x => x.family === "units").map(x => x.micro.toString())).size === 1,
        amount296.map(x => ({ lang: x.lang, exp: x.chosenExp, family: x.family, source: x.source })));
    }
  }

  {
    const m = M();
    const text = m.mask(
      "(In 100 millions of yen)\n(In thousands of units)\n" +
      "Global sales volume 301 304\n\nFinancial summary\nShareholders' equity 1,474\nTotal assets 12,857",
      "en"
    ).text;
    const lineSymbol = label => (text.split("\n").find(x => x.startsWith(label)) || "").match(/⟦#[A-Z]{3}⟧/g) || [];
    const money = m.mask("1,285,700 million yen", "en").text;
    t("units表の状態を後続money表へ漏らさない", lineSymbol("Total assets")[0] === symbol(money), { text, money });
  }

  {
    const m = M();
    const text = m.mask(
      "(In millions of yen)\nFirst table 1,200\n\n(In thousands of yen)\nSecond table 1,200",
      "en"
    ).text;
    const syms = text.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("同じページの百万円表と千円表を別指数にする", syms.at(-2) !== syms.at(-1), { text, syms });
  }

  {
    const m = M();
    const explicit = m.mask("売上台数は304千台", "ja").text;
    const table = m.mask("(単位：千台／億円)\n売上台数 301 304", "ja").text;
    t("売上台数を金額ではなく台数に分類する", (table.match(/⟦#[A-Z]{3}⟧/g) || []).at(-1) === symbol(explicit), { explicit, table });
  }

  {
    const m = M();
    const table = m.mask(
      "(In millions of yen)\nNumber of shares issued 631,803,979\nNumber of employees 4,955\nNet sales 1,200",
      "en"
    ).text;
    const shares = m.mask("631,803,979 shares", "en").text;
    const employees = m.mask("4,955 persons", "en").text;
    const money = m.mask("1,200 million yen", "en").text;
    const lineSymbol = label => (table.split("\n").find(x => x.startsWith(label)) || "").match(/⟦#[A-Z]{3}⟧/)?.[0];
    t("株数をページの金額単位へフォールバックしない", lineSymbol("Number of shares") === symbol(shares), { table, shares });
    t("従業員数をページの金額単位へフォールバックしない", lineSymbol("Number of employees") === symbol(employees), { table, employees });
    t("非金額行の後も金額行はページ単位を維持", lineSymbol("Net sales") === symbol(money), { table, money });
  }

  {
    const m = M();
    const table = m.mask("(In thousands of units)\nVolume Rate (%)\nJapan 32 33 1 2", "en").text;
    const ratio = m.mask("The rate was 2%.", "en").text;
    const units = m.mask("The increase was 1 thousand units.", "en").text;
    const syms = table.split("\n").at(-1).match(/⟦#[A-Z]{3}⟧/g) || [];
    t("整数の率列を千台にせず2%と揃える", syms.at(-1) === symbol(ratio), { table, ratio, syms });
    t("率列の直前にある増減台数は千台を維持", syms.at(-2) === symbol(units), { table, units, syms });
  }

  {
    const m = M();
    const table = m.mask(
      "(In 100 millions of yen)\n(In thousands of units)\n" +
      "North America 30 147 154 629\nEurope 31 39 43 197\nChina 32 18 18 71\n" +
      "Other areas 33 65 56 274\nGlobal sales volume 34 301 304 1,324\nJapan 35 35 33 148",
      "en"
    ).text;
    const explicit = m.mask("The volume was 34 thousand units.", "en").text;
    const row = table.split("\n").find(x => x.startsWith("Global sales volume")) || "";
    const syms = row.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("連番の行IDを同じ数値の台数とは別namespaceにする", syms[0] !== symbol(explicit), { table, explicit, row, syms });
    t("行IDは平文で残さずマスクする", !/\b34\b/.test(row), { row });
  }

  {
    const m = M();
    m.mask("Global sales volume was 304 thousand units.", "en");
    const money = m.mask("(In 100 millions of yen)\n(In thousands of units)\nNet sales 304", "en");
    const rec = money.used.at(-1);
    t("別familyの明示値が強いmoneyラベルを上書きしない",
      rec.family === "money" && rec.chosenExp === 8 && rec.source === "label", rec);
  }

  {
    const m = M();
    const before = m.mask("Japan 32 33\nEurope 39 43\n(In millions of yen)\nNet sales 1,200", "en");
    const rows = before.used.filter(x => ["32", "33", "39", "43"].includes(x.raw));
    t("後方の単位宣言を前の表へ逆流させない", rows.every(x => !x.chosenExp), rows);
  }

  {
    const m = M();
    const text = m.mask("Volume Rate (%)\nJapan 32 33 1 2\n\n(In 100 millions of yen)\nNet sales 100 200 300", "en");
    const last = text.used.slice(-3);
    t("率列見出しを後続の別表へ漏らさない", last.every(x => x.chosenExp === 8),
      last.map(x => ({ raw: x.raw, exp: x.chosenExp, family: x.family, source: x.source })));
  }

  {
    const m = M();
    const text = m.mask("Volume Rate (%)\nJapan 32 33 1 2.5\n\n(In millions of yen)\nNet sales 100.5 200.5 300.5", "en");
    const last = text.used.slice(-3);
    t("小数の率列見出しも後続の別表へ漏らさない", last.every(x => x.chosenExp === 6),
      last.map(x => ({ raw: x.raw, exp: x.chosenExp, family: x.family, source: x.source })));
  }

  {
    const m = M();
    m.mask("(In thousands of units)\nA 1 10 20\nB 2 10 20\nC 3 10 20\nD 4 10 20\nE 5 10 20\nGlobal sales volume 6 10 20", "en");
    const money = m.mask("(In millions of yen)\nA 1 100 200\nB 2 100 200\nC 3 100 200\nD 4 100 200\nE 5 100 200\nF 6 100 200", "en");
    const amounts = money.used.filter(x => !["1", "2", "3", "4", "5", "6"].includes(x.raw));
    t("同じ行IDを持つ別表へfamily証拠を越境させない",
      amounts.every(x => x.family === "money" && x.chosenExp === 6),
      amounts.map(x => ({ raw: x.raw, exp: x.chosenExp, family: x.family, source: x.source })));
  }

  {
    const m = M();
    const text = m.mask("A 1 10 20\nB 2 10 20\nC 3 10 20\n===== PDF P.2 / TARGET_CHECK / x =====\nD 4 10 20\nE 5 10 20\nF 6 10 20", "en");
    t("ページ境界を越えて連番を行ID化しない", text.used.every(x => x.namespace === "amount"),
      text.used.map(x => ({ raw: x.raw, namespace: x.namespace })));
  }

  {
    const m = M();
    const text = m.mask("A 1 10 20\nB 2 10 20\nC 3 10 20\n(In millions of yen)\nD 4 10 20\nE 5 10 20\nF 6 10 20", "en");
    t("単位宣言を越えて連番を行ID化しない", text.used.every(x => x.namespace === "amount"),
      text.used.map(x => ({ raw: x.raw, namespace: x.namespace })));
  }

  {
    const m = M();
    const text = m.mask("(単位：千台／億円)\n％ ％ ％ ％\n計 301 304 1.2", "ja");
    t("率だけの見出しを百万円宣言と誤認しない",
      text.used.every(x => !(x.family === "generic" && x.chosenExp === 6)),
      text.used.map(x => ({ raw: x.raw, exp: x.chosenExp, family: x.family, source: x.source })));
  }

  {
    const m = M();
    const text = m.mask("(In millions of yen)\nJapan 1 100 200\nEurope 2 100 200\nChina 3 100 200", "en");
    const ids = text.used.filter(x => ["1", "2", "3"].includes(x.raw));
    t("3行だけの連番を行IDと誤認しない", ids.every(x => x.namespace === "amount"), ids);
  }

  {
    const m = M();
    const row = m.mask("(In thousands of units)\nA 1 10 20\nB 2 10 20\nC 3 10 20\nD 4 10 20\nE 5 10 20\nF 6 10 20", "en");
    const amount = m.mask("Amount 1", "en");
    t("異なるnamespaceの記号を丸め互換と判定しない",
      !m.areSymbolsCompatible(row.used[0]?.symbol, amount.used[0]?.symbol), { row: row.used[0], amount: amount.used[0] });
  }

  {
    const m = M();
    const text = m.mask("Revenue Millions\n100 200\nProduction Thousands\n10 20\nof Units\nof Yen", "en");
    const revenue = text.used.find(x => x.raw === "100");
    const production = text.used.find(x => x.raw === "10");
    t("分割見出しをfamilyを越えて交差結合しない",
      revenue?.family === "money" && revenue.chosenExp === 6
        && production?.family === "units" && production.chosenExp === 3,
      { revenue: revenue && { raw: revenue.raw, family: revenue.family, exp: revenue.chosenExp, source: revenue.source },
        production: production && { raw: production.raw, family: production.family, exp: production.chosenExp, source: production.source } });
  }

  {
    const m = M();
    const header = m.mask("コ ー ド 番 号 7261\nマツダ㈱(7261) 2027年３月期", "ja").text;
    const amount = m.mask("（単位：百万円）\n投資有価証券 7,261", "ja").text;
    t("証券コードは公開構造情報として記号化しない", (header.match(/7261/g) || []).length === 2, { header });
    t("同じ数字の金額7,261は証券コードと区別してマスクする", /⟦#[A-Z]{3}⟧/.test(amount), { amount });
  }

  {
    // 広い丸め表記が先に別の厳密値と結び付いてrangeが狭まっても、元の表記幅は失わない。
    const m = M();
    m.mask("Europe 3,770 million yen", "en");
    const rounded = m.mask("(In 100 millions of yen) Europe 38", "en").text.match(/⟦#[A-Z]{3}⟧/g).at(-1);
    const exact = m.mask("Europe 3,776 million yen", "en").text.match(/⟦#[A-Z]{3}⟧/g).at(-1);
    t("異なる記号でも元の丸め区間が重なれば互換と判定する",
      rounded !== exact && m.areSymbolsCompatible(rounded, exact), { rounded, exact });
    const far = m.mask("Europe 3,900 million yen", "en").text.match(/⟦#[A-Z]{3}⟧/g).at(-1);
    t("丸め区間が重ならない実値は互換にしない", !m.areSymbolsCompatible(rounded, far), { rounded, far });
  }

  {
    // 実物では金額・構成比・EPSの列見出しが前行にあり、ページには百万円スケールがある。
    // ％とEPSまで百万倍すると、日英で同じ値に別記号が付く。
    const sidecar =
      "===== PDF P.7 / TARGET_CHECK / 元PDF P.7 / en.pdf =====\n" +
      "millions of yen % millions of yen %\n" +
      "FY2027 1,285,706 16.9 32,836 43.3\n" +
      "Yen Yen\n" +
      "Earnings per share 46.97 46.95\n" +
      "===== PDF P.7 / REF1_CANDIDATE / 元PDF P.7 / ja.pdf =====\n" +
      "百万円 ％ 百万円 ％\n" +
      "2027年3月期 1,285,706 16.9 32,836 43.3\n" +
      "円 銭 円 銭\n" +
      "1株当たり利益 46.97 46.95\n";
    const out = maskSidecarByRole(sidecar, M());
    const [target, reference] = out.split(/===== PDF P\.7 \/ REF1_CANDIDATE[^\n]*=====\n/);
    const targetSymbols = target.match(/⟦#[A-Z]{3}⟧/g) || [];
    const referenceSymbols = reference?.match(/⟦#[A-Z]{3}⟧/g) || [];
    t("日英の百万円・％・EPS列で同じ値に同じ記号が付く",
      JSON.stringify(targetSymbols) === JSON.stringify(referenceSymbols),
      { targetSymbols, referenceSymbols, out });
  }
}

// ⚠️ 合否判定は**必ず末尾**に置く。上にあると、後から追記したテストが
//    落ちても exit 0 になる（実測 2026-08-08 でそうなっていた）。
if (bad) { console.error(`\nTest-NumberMask: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-NumberMask: PASS");
