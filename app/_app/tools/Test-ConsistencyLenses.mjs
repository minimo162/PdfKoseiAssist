// Test-ConsistencyLenses.mjs — 観点を分けて投げる仕組みが、両側で食い違っていないかを見る。
//
//   node tools/Test-ConsistencyLenses.mjs
//
// 観点を1つに絞る指示文は2箇所にある。
//   - index.html の CONSISTENCY_LENS_PROMPTS … パケットとして**並列に**投げるとき
//   - src/ReviewJob.ps1 の $script:KoseiReviewLenses … 同じチャットで**直列に**追撃するとき
// 同じ観点なのに片方だけ直すと、構成を変えたときに測っているものが変わってしまう。
//
// ⚠️ なぜ2経路あるのか（消さないこと）:
//    追撃（Reuse turn）は前のターンに依存するので直列にしか流せない。gap のように
//    「既出以外を探す」観点はこれが要る。一方 terms / numbers は既出一覧を渡さないので
//    独立に投げられ、パケットに分ければ review_max_workers でそのまま並列になる。
//    実測（2026-08-05・200ページ）: 1ターンに詰め込むと出力の枠を数値の照合が食い切り、
//    表記の揺れ（term）が 2/24 まで落ちた。観点を分けると 11/24 に戻る。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { resolvePassSchedule } from "../js/pass-schedule.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const html = readFileSync(join(app, "index.html"), "utf8");
const ps = readFileSync(join(app, "src", "ReviewJob.ps1"), "utf8");
const driver = readFileSync(join(app, "tools", "Run-Benchmark.ps1"), "utf8");

let bad = 0;
const t = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name);
  else { bad++; console.error("  FAIL " + name); if (detail) console.error("       " + detail); }
};

// --- 1. 並列側（index.html）の差し込み文 --------------------------------
const block = html.slice(html.indexOf("const CONSISTENCY_LENS_PROMPTS = {"),
  html.indexOf("};", html.indexOf("const CONSISTENCY_LENS_PROMPTS = {")));
t("index.html に観点の差し込み文がある", block.length > 100);
for (const lens of ["terms", "numbers", "structure"]) {
  t(`並列側に ${lens} の指示がある`, new RegExp(`^\\s{6}${lens}:`, "m").test(block));
}
t("観点を1つに絞ると明記している", /観点を1つに絞ります/.test(block));
t("当てはまらない指摘を出さないよう指示している",
  (block.match(/この観点に当てはまらない指摘は出さないでください/g) || []).length >= 2);
// マスクした状態で数値を比べる唯一の方法。ここが抜けると記号を値として読もうとする。
t("数値の観点は記号どうしの照合だと明記している", /記号が同じかどうか\S*で判定/.test(block));
t("並列側はscope必須・明示非互換drop・unit unknown境界を要求する",
  /同じ指標・期間・連結\/単体範囲・実績\/予想区分などの比較scope/.test(block)
  && /単位\/measure familyが明示されていて非互換なら報告しません/.test(block)
  && /単位\/measure familyの欠落・曖昧さだけで真の値差を捨てない/.test(block)
  && /確認できない別表どうしは比較しない/.test(block)
  && /Total、Domestic、Overseas、Result、Plan/.test(block));
t("並列側のnumbers/numbers_r2もscope欠落を空にし、unit unknownを一律抑止しない",
  /numbers:[\s\S]*比較scopeの必須項目が欠落・相違・曖昧なら findings は空配列/.test(block)
  && /numbers_r2:[\s\S]*比較scopeの必須項目が欠落・相違・曖昧な候補は報告しない/.test(block)
  && /numbers_r2:[\s\S]*単位\/measure familyの欠落・曖昧さだけで真の値差を捨てない/.test(block));
t("観点ごとの跨ぎ手順を対象範囲どおりに分離する", (() => {
  const constantBody = name => {
    const start = html.indexOf(`const ${name} = `);
    if (start < 0) return "";
    const bodyStart = html.indexOf("`", start) + 1;
    const bodyEnd = html.indexOf("`;", bodyStart);
    return bodyStart > 0 && bodyEnd >= bodyStart ? html.slice(bodyStart, bodyEnd) : "";
  };
  const constants = Object.fromEntries([
    "CONSISTENCY_TOC_PROCEDURE", "CONSISTENCY_ENTITY_PROCEDURE", "CONSISTENCY_SCOPE_PROCEDURE",
    "CONSISTENCY_CROSS_LOCATION_PROCEDURE", "CONSISTENCY_NUMERIC_UNIT_PROCEDURE",
  ].map(name => [name, constantBody(name)]));
  const expand = source => {
    let out = String(source || "");
    for (let i = 0; i < 4; i++) {
      const next = out.replace(/\$\{(CONSISTENCY_[A-Z_]+)\}/g,
        (_, name) => constants[name] || "");
      if (next === out) break;
      out = next;
    }
    return out;
  };
  const lensBody = name => {
    const start = block.indexOf(`      ${name}: `);
    if (start < 0) return "";
    const bodyStart = block.indexOf("`", start) + 1;
    const bodyEnd = block.indexOf("`,", bodyStart);
    return expand(bodyStart > 0 && bodyEnd >= bodyStart ? block.slice(bodyStart, bodyEnd) : "");
  };
  const focusedLenses = ["terms", "terms_r2", "structure", "structure_r2", "numbers", "numbers_r2"];
  const baseProcedure = (name, round) => {
    const active = Number(round) > 1 && ["terms", "structure", "numbers"].includes(name)
      ? name + "_r2"
      : name;
    return focusedLenses.includes(active)
      ? ""
      : expand("${CONSISTENCY_CROSS_LOCATION_PROCEDURE}\n${CONSISTENCY_NUMERIC_UNIT_PROCEDURE}");
  };
  const assembledLens = (name, round = 1) => {
    const active = Number(round) > 1 && ["terms", "structure", "numbers"].includes(name)
      ? name + "_r2"
      : name;
    return `${baseProcedure(name, round)}\n${lensBody(active)}`;
  };
  const terms = assembledLens("terms");
  const structure = assembledLens("structure");
  const termsR2 = assembledLens("terms", 2);
  const structureR2 = assembledLens("structure", 2);
  const numbers = assembledLens("numbers");
  const numbersR2 = assembledLens("numbers", 2);
  const gap = assembledLens("gap");
  const broad = assembledLens("broad");
  return /同じ分類・同じ entity/.test(terms)
    && /周囲の節見出し・表題/.test(terms)
    && !/目次・番号付き一覧/.test(terms)
    && /目次・番号付き一覧/.test(structure)
    && !/同じ分類・同じ entity/.test(structure)
    && !/周囲の節見出し・表題/.test(structure)
    && /同じ分類・同じ entity/.test(termsR2)
    && /目次・番号付き一覧/.test(structureR2)
    && !/周囲の節見出し・表題/.test(structureR2)
    && !/同じ分類・同じ entity/.test(numbers)
    && !/目次・番号付き一覧/.test(numbers)
    && !/周囲の節見出し・表題/.test(numbers)
    && !/同じ分類・同じ entity/.test(numbersR2)
    && !/目次・番号付き一覧/.test(numbersR2)
    && !/周囲の節見出し・表題/.test(numbersR2)
    && /目次・番号付き一覧/.test(gap)
    && /同じ分類・同じ entity/.test(gap)
    && /周囲の節見出し・表題/.test(gap)
    && /目次・番号付き一覧/.test(broad)
    && /同じ分類・同じ entity/.test(broad)
    && /周囲の節見出し・表題/.test(broad)
    && /跨ページの金額（通貨を伴う monetary amount）比較に限る/.test(broad);
})());
t("実際のbuildConsistencyPromptTextに観点suffixを足した完全promptを分離する", (() => {
  const helperStart = html.indexOf("    const CONSISTENCY_TOC_PROCEDURE = `");
  const builderEnd = html.indexOf("    function buildPacketPromptText", helperStart);
  const candidateStart = html.indexOf("    function candidateValidationPromptSection(");
  const candidateEnd = html.indexOf("    // 整合性セクション用プロンプト", candidateStart);
  const lensStart = html.indexOf("    const CONSISTENCY_LENS_PROMPTS = {");
  const lensEnd = html.indexOf("    };\n\n    // 整合性セクションのジョブ用パケットを作る", lensStart);
  const tailStart = html.indexOf("    function maskingPromptSection(hasRef", helperStart);
  const tailEnd = html.indexOf("    /**\n     * パケットの本文をマスク", tailStart);
  const autoStart = html.indexOf("    function autoPromptSuffix()");
  const autoEnd = html.indexOf("    function setAutoCard", autoStart);
  if (helperStart < 0 || builderEnd < 0 || candidateStart < 0 || candidateEnd < 0
      || lensStart < 0 || lensEnd < 0 || tailStart < 0 || tailEnd < 0 || autoStart < 0 || autoEnd < 0) return false;
  const source = `
const MASKING_ENABLED = true;
const pagesToRangeText = pages => Array.isArray(pages) ? pages.join(", ") : String(pages || "");
const safeText = value => String(value || "");
const buildPacketPageMapText = () => "PAGE_MAP";
${html.slice(candidateStart, candidateEnd)}
${html.slice(helperStart, builderEnd)}
${html.slice(lensStart, lensEnd + "    };".length)}
${html.slice(tailStart, tailEnd)}
${html.slice(autoStart, autoEnd)}
globalThis.__consistencyPromptRuntime = {
  buildConsistencyPromptText,
  consistencyActiveLens,
  CONSISTENCY_LENS_PROMPTS,
  candidateValidationPromptSection,
  maskingPromptSection,
  autoPromptSuffix,
};`;
  const context = {};
  try {
    runInNewContext(source, context);
  } catch (error) {
    console.error("       prompt runtime extraction failed:", error.message);
    return false;
  }
  const runtime = context.__consistencyPromptRuntime;
  const packet = {
    packetId: "SEC_001",
    targetCheckPages: [1, 2],
    targetLanguage: "英語",
    referenceLanguage: "日本語",
    referenceSections: [],
    combined: true,
  };
  const assembled = (lens, round = 1) => {
    const active = runtime.consistencyActiveLens(lens, round);
    const base = runtime.buildConsistencyPromptText(
      { ...packet, packetId: `${packet.packetId}_${String(lens).toUpperCase()}` },
      { lens, round },
    );
    const promptTail = runtime.maskingPromptSection(false, { lens, round });
    const focus = runtime.CONSISTENCY_LENS_PROMPTS[active] || "";
    const suffix = focus ? `\n\n${focus}\n` : "";
    const finalGate = suffix
      ? `\n\n${runtime.candidateValidationPromptSection(false, {
        lens,
        round,
        includeScopedRules: false,
      })}`
      : "";
    return `${base}${runtime.autoPromptSuffix()}\n${promptTail}${suffix}${finalGate}`;
  };
  const terms = assembled("terms");
  const termsR2 = assembled("terms", 2);
  const structure = assembled("structure");
  const structureR2 = assembled("structure", 2);
  const numbers = assembled("numbers");
  const numbersR2 = assembled("numbers", 2);
  const gap = assembled("gap");
  const broad = assembled("broad");
  const genericNumericGate = prompt => (prompt.match(/  5\. 数値比較なら/g) || []).length;
  const genericMissingGate = prompt => (prompt.match(/  6\. 欠番・参照欠落は/g) || []).length;
  return /同じ分類・同じ entity/.test(terms)
    && /表記の統一/.test(terms)
    && /⟦#XXX⟧/.test(terms)
    && !/A\. TARGET/.test(terms)
    && !/目次・番号付き一覧/.test(terms)
    && !/■ 数値の確認手順/.test(terms)
    && !/単位のスケール/.test(terms)
    && /同じ分類・同じ entity/.test(termsR2)
    && !/A\. TARGET/.test(termsR2)
    && /目次・番号付き一覧/.test(structure)
    && /番号と参照の整合/.test(structure)
    && /⟦#XXX⟧/.test(structure)
    && !/同じ指標の値/.test(structure)
    && !/表記の統一/.test(structure)
    && !/■ 数値の確認手順/.test(structure)
    && !/単位のスケール/.test(structure)
    && /目次・番号付き一覧/.test(structureR2)
    && !/A\. TARGET/.test(structureR2)
    && /■ 数値の確認手順/.test(numbers)
    && /単位のスケール/.test(numbers)
    && /数を述べる文/.test(numbersR2)
    && /⟦#XXX⟧/.test(numbersR2)
    && !/A\. TARGET/.test(numbersR2)
    && !/項番・見出し・ラベル/.test(numbersR2)
    && !/跨ページの金額（通貨を伴う monetary amount）比較に限る/.test(numbersR2)
    && !/■ 数値の確認手順/.test(numbersR2)
    && !/単位のスケール/.test(numbersR2)
    && /A\. TARGET/.test(broad)
    && /同じ指標の値/.test(broad)
    && /項番・見出し・ラベル/.test(broad)
    && /A\. TARGET/.test(gap)
    && /跨ページの金額（通貨を伴う monetary amount）比較に限る/.test(gap)
    && [terms, termsR2, structure, structureR2, numbers, numbersR2].every(prompt => genericNumericGate(prompt) === 0)
    && [terms, termsR2, structure, structureR2, numbers, numbersR2].every(prompt => genericMissingGate(prompt) === 0)
    && genericNumericGate(broad) === 1
    && genericMissingGate(broad) === 1
    && genericNumericGate(gap) === 1
    && genericMissingGate(gap) === 1
    && [terms, termsR2, structure, structureR2, numbers, numbersR2, broad, gap]
      .every(prompt => /■ 最終出力前の候補検証/.test(prompt) && /quote はそのpageのTEXTから一字一句コピーできるか/.test(prompt));
})());
t("金額unit手順はbroadとnumbersだけに差し込む", (() => {
  const unit = html.match(/const CONSISTENCY_NUMERIC_UNIT_PROCEDURE = `([\s\S]*?)`;/)?.[1] || "";
  const numbers = block.match(/^\s{6}numbers: `([\s\S]*?)`,/m)?.[1] || "";
  const numbersR2 = block.match(/^\s{6}numbers_r2: `([\s\S]*?)`,/m)?.[1] || "";
  return /跨ページの金額（通貨を伴う monetary amount）比較に限る/.test(unit)
    && /同じ表・同じ行／列・共通表頭/.test(unit)
    && /件数・数量・比率・率などの非金額/.test(unit)
    && /328億円[\s\S]*32,836百万円[\s\S]*不一致にしません/.test(unit)
    && /406億円の減少[\s\S]*△40,552百万円/.test(unit)
    && /実量記号の不一致/.test(unit)
    && /700億円[\s\S]*7 billion yen[\s\S]*区間が重ならない/.test(unit)
    && /source-bound\s+に確認できる場合だけ使います/.test(unit)
    && /CONSISTENCY_NUMERIC_UNIT_PROCEDURE/.test(numbers)
    && !/CONSISTENCY_NUMERIC_UNIT_PROCEDURE/.test(numbersR2)
    && /ものの数を述べている文/.test(numbersR2);
})());
t("共通手順は対応を立証した目次・本文見出しの単複差を報告対象にする",
  /目次・番号付き一覧・箇条書き[\s\S]*対応する本文の見出し／番号付き見出し[\s\S]*単数／複数の違いも報告対象/.test(html)
  && /単数／複数だけを拾い、対応を立証できない場合[\s\S]*不一致としません/.test(html));
t("共通手順は本文・表ラベルの同一分類entityを肯定確認する",
  /本文の文・段落と表頭・行ラベル[\s\S]*同じ分類・同じ entity（対象）[\s\S]*肯定的に確認/.test(html));
t("共通手順はsection scopeの反対語を確認し曖昧なら空にする",
  /consolidated\/unconsolidated（連結／非連結）[\s\S]*同じ entity\/classification[\s\S]*両方の位置・両方の quote[\s\S]*findings は空配列/.test(html));

// ⚠️ 観点には「何を見るか」だけでなく**どう探すか**を書く。実測（2026-08-05〜06）:
//    numbers のラウンド2は「探し方」を書くまで0件だった。同じ穴が他の観点にもあった。
//      - structure-local の未検出は3runとも**脚注の対応**に集中（sl02 / sl06 / sl08）。
//        本文側と脚注側を**両方向**で照合する手順が、round1 にも round2 にも無かった。
//        特に「脚注はあるのに本文から参照されていない」型は、欠番・重複の検査では見つからない。
//      - term の未検出は距離 70/90/130 に偏っていた（m070c / m090b / m130c）。
//        round1 は「離れたページを見よ」と警告するだけで、手順は round2 にしか無かった。
t("脚注は本文側と脚注側を両方向で照合すると書いてある（片側だけだと見つからない型がある）",
  /両方向/.test(block) && /脚注はあるのに本文から参照されていない/.test(block));
// ⚠️ structure の未検出は型で割れていた（2026-08-06・3回）:
//      相互参照（同じ内容が別の番号）  s005 / s130 / s046 … 3回とも検出
//      番号の使い回し（同じ番号が別の内容） s026 3回未検出、s016 / s053 / s070 が2回未検出
//    指示は「番号の重複」としか書いておらず、注記番号は参照側と本体で2回出るのが正常なので、
//    モデルは重複と見なさない。**回数ではなく、指している内容が同じかどうか**で判断させる。
t("同じ番号が別の内容を指していないかを読み比べると書いてある",
  /同じ番号が別の内容を指していないか/.test(block) && /指している内容が同じかどうかで判断/.test(block));
t("番号が2回出ること自体は正常だと断っている（回数で判断させない）",
  (block.match(/番号が2回出ること自体は正常/g) || []).length >= 2);
t("表記の観点に探し方が書いてある（最初の一致で打ち切らせない）",
  /最後のページまで/.test(block) && /最初の一致で打ち切らないでください/.test(block));
// 類似名称を同一実体と推測すると誤指摘になる。同一性の立証責任をモデル側に置く。
t("表記の観点に同一実体の肯定的根拠を要求する",
  /肯定的な根拠/.test(block) && /定義、略称の展開、同じREF原語、同じ役割/.test(block));
t("証拠不在を同一性の根拠にしない",
  /根拠不在は同一性の根拠ではありません/.test(block));
t("地名・番号・年号などの別実体は報告させない",
  /地名・番号・年号・人名・製品・組織・期間・制度が違う場合は別実体/.test(block));

// --- 2. 直列側（ReviewJob.ps1）の観点定義 -------------------------------
for (const lens of ["terms", "numbers", "structure"]) {
  t(`直列側に ${lens} の観点定義がある`, new RegExp(`^\\s{4}${lens}\\s*=\\s*@\\{`, "m").test(ps));
}
t("直列側もscope必須・明示非互換drop・unit unknown境界を要求する",
  /同じ指標・期間・連結\/単体範囲・実績\/予想区分などの比較scope/.test(ps)
  && /単位\/measure familyが明示されていて非互換なら報告/.test(ps)
  && /単位\/measure familyの欠落・曖昧さだけで真の値差を捨てない/.test(ps)
  && /確認できない別表どうしは比較しない/.test(ps)
  && /比較scopeの必須項目が欠落・相違・曖昧/.test(ps));

// --- 3. 指示にベンチマークの答えが混ざっていないか ------------------------
//
// ⚠️ これが今日いちばん効く検査である。実測（2026-08-05）: 観点の指示に具体例として
//    フィクスチャの表記揺れ4件をそのまま書いていたため、その4件は 4/4 で検出され、
//    例に無い20件は 17/20 だった。**答えを見せた状態で測っていた**ことになる。
//    指示に書いてよいのは「どういう形の違いを探すか」だけで、素材の中身は書かない。
const psTerms = ps.slice(ps.indexOf("terms       = @{"), ps.indexOf("gap         = @{"));
{
  const gold = JSON.parse(readFileSync(join(app, "docs", "benchmarks", "fixtures", "gold-long.json"), "utf8"));
  const planted = gold.packets[0].planted;
  // 素材の「答え」に当たる文字列: 引用と、跨ぎの相手方の引用。
  const secrets = [];
  for (const p of planted) {
    for (const q of [p.quote, ...(p.alt || []).map(a => a.quote)]) {
      // 短すぎる断片はどこにでも現れるので、意味のある長さのものだけ見る
      for (const frag of String(q).match(/[A-Za-z][A-Za-z&.,'’ -]{14,60}/g) || []) {
        const f = frag.trim();
        if (f.length >= 15) secrets.push({ id: p.id, frag: f });
      }
    }
  }
  const leaked = secrets.filter(s2 => block.includes(s2.frag) || psTerms.includes(s2.frag));
  t(`観点の指示に素材の答えが入っていない（${secrets.length}断片を照合）`, leaked.length === 0,
    leaked.slice(0, 5).map(x => `${x.id}: ${x.frag}`).join(" / "));
}
t("どちらも「訳の当否は問わない」と言っている",
  /訳が正しいかどうかは問いません/.test(block) && /訳が正しいかどうかは問わない/.test(psTerms));

// --- 4. プロファイルと構成 ------------------------------------------------
const sched = resolvePassSchedule({ profile: "consistency2", hasRef: false, gapPass: true, maxPasses: 8 });
t("consistency2 は broad → terms → numbers",
  JSON.stringify(sched.passes.map(p => p.lens)) === JSON.stringify(["broad", "terms", "numbers"]),
  sched.passes.map(p => p.lens).join(","));
t("consistency2 は gap を持たない（既出一覧に依存しない観点だけで構成する）",
  !sched.passes.some(p => p.kind === "gap"));

// --- 4b. 画面のボタンと、測っている構成が同じか --------------------------
//
// ⚠️ 整合性レビューは 2026-08-05 まで `__koseiBenchmark` 経由でしか呼べず、画面に導線が無かった。
//    導線を付けるとき怖いのは「押して走る構成」と「README が数字を載せている構成」がずれること。
//    ずれても誰も気づかない（どちらも正常に動いてしまう）ので、ここで縛る。
{
  const m = html.match(/const RECOMMENDED_CONSISTENCY = \{([\s\S]{0,400}?)\};/);
  t("画面側に推奨構成の定数がある（RECOMMENDED_CONSISTENCY）", !!m);
  const ui = m ? m[1] : "";
  const rounds2 = driver.split("\n").find(l => /name = 'rounds2'/.test(l)) || "";
  t("Run-Benchmark に rounds2 の定義がある", !!rounds2);

  const uiList = (key) => {
    const mm = ui.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
    return mm ? mm[1].match(/"[^"]+"/g).map(s => s.slice(1, -1)).join(",") : "";
  };
  const psList = (key) => {
    const mm = rounds2.match(new RegExp(`${key} = @\\(([^)]*)\\)`));
    return mm ? mm[1].match(/'[^']+'/g).map(s => s.slice(1, -1)).join(",") : "";
  };
  for (const [uiKey, psKey] of [["lenses", "lenses"], ["round2Lenses", "round2Lenses"]]) {
    t(`${uiKey} が画面とベンチで一致している`, uiList(uiKey) && uiList(uiKey) === psList(psKey),
      `画面=${uiList(uiKey)} / ベンチ=${psList(psKey)}`);
  }
  t("rounds が画面とベンチで一致している（2）",
    /rounds:\s*2/.test(ui) && /rounds = 2/.test(rounds2));
  t("overlap が画面とベンチで一致している（3）",
    /overlap:\s*3/.test(ui) && /overlap = 3/.test(rounds2));
  t("combined が画面とベンチで一致している（true）",
    /combined:\s*true/.test(ui) && /combined = \$true/.test(rounds2));
  t("profile が画面とベンチで一致している（consistency1）",
    /profile:\s*"consistency1"/.test(ui) && /profile = 'consistency1'/.test(rounds2));

  // 推奨構成の定数自体は文書全体の幅を持たない。structure_r2 だけは長大添付を避ける安全幅を別定数で持つ。
  t("推奨構成の定数は sectionWidth を持たない（幅は文書のページ数から決める）",
    !/sectionWidth/.test(ui));
  t("画面のボタンは推奨構成＋現在のページ数で呼ぶ",
    /startConsistencyReview\(\{ \.\.\.RECOMMENDED_CONSISTENCY, sectionWidth: Math\.max\(1, targetPages\.length/.test(html));
  t("整合性レビューのボタンが画面にある",
    /id="consistencyReviewBtn"/.test(html) && /els\.consistencyReviewBtn\.addEventListener/.test(html));
  t("整合性レビューのボタンも実行中は押せない",
    /els\.consistencyReviewBtn\.disabled = !pdfDoc \|\| autoReviewRunning/.test(html));

  t("structure_r2 に長大添付を避ける安全幅がある",
    /const CONSISTENCY_STRUCTURE_R2_SECTION_WIDTH = 40/.test(html));
  t("round2 の structure だけを安全幅へ分割するヘルパーがある",
    /async function buildConsistencyRoundPackets[\s\S]{0,1800}round <= 1 \|\| !lenses.includes\("structure"\)/.test(html) &&
    /Math\.min\(requestedWidth, CONSISTENCY_STRUCTURE_R2_SECTION_WIDTH\)/.test(html) &&
    /lenses: \["structure"\]/.test(html));
  t("全体実行と単独実行が同じ分割ヘルパーを使う",
    /const round1 = await buildConsistencyRoundPackets\(/.test(html) &&
    /const round2 = await buildConsistencyRoundPackets\(/.test(html) &&
    /const packets = await buildConsistencyRoundPackets\(roundOpts, operationOwner\)/.test(html));

}

t("Run-Benchmark に並列構成（lenses 指定）がある", /lenses = @\('broad','terms','numbers','structure'\)/.test(driver));
t("並列構成は startConsistency へ lenses を渡す", /", lenses: "/.test(driver));
t("直列版（split200）は既定の -Config all から外してある（比較用）",
  /name = 'split200'[^\n]*inAll = \$false/.test(driver));

// --- 5. パケット展開 ------------------------------------------------------
// 観点ごとに packet_id を分けないと、取り込み側で同じIDの結果が上書きされる。
t("観点ごとに packet_id を分けている",
  /const idSuffix = \(lens \? "_" \+ lens\.toUpperCase\(\) : ""\)/.test(html) &&
  /const lensPacketId = effectivePacket\.packetId \+ idSuffix/.test(html) &&
  /packet_id: lensPacketId/.test(html));
// ⚠️ 依頼文のJSONテンプレートにも観点付きidを載せること。
//    実測（2026-08-14）: 基パケットidのままだと Copilot がそれを echo し、
//    サーバー検証（packet_id完全一致）で全観点パケットが毎回落ちて分割再試行へ流れた。
t("依頼文のJSONテンプレートにも観点付き packet_id を載せる（基idのままだと検証で全観点が落ちる）",
  /buildPacketPromptText\([\s\S]*?idSuffix \? \{ \.\.\.effectivePacket, packetId: lensPacketId \} : effectivePacket[\s\S]*?\{ lens, round \}/.test(html) &&
  /回答JSONの packet_id は "\$\{lensPacketId\}" と正確に書いてください/.test(html));
t("観点で分けたパケットは追撃を持たない（1パケット1ターン）",
  /profile: lens \? "consistency1"/.test(html));
t("未知の観点は例外にする（黙って観点なしで走らせない）",
  /未知の観点です/.test(html));
// ⚠️ 添付ファイル名も観点ごとに変えること。
//    実測（2026-08-05）: 同名のまま3パケットを並列に投げたら、同じジョブディレクトリの
//    同じ名前へ同時に書く形になり、「添付完了を80秒以内に確認できませんでした」で
//    観点パケットが落ちた。落ち方が静かで、結果だけ見ると「その観点は何も出さなかった」に見える。
// --- 6. ラウンド2（既出以外を探す） --------------------------------------
{
  // ⚠️ 既出一覧は**マスクし直してから**渡すこと。画面上の findings は記号を実値へ戻した後の姿で、
  //    そのまま送ると「伏せた数値を自分で送り返す」ことになり、マスキングが無意味になる。
  //    §4.5 と同じく、伏せきれないなら渡さない（警告ではなく不採用）。
  t("既出一覧をマスクし直してから渡している",
    /function priorFindingsDigest[\s\S]{0,900}jobMasker\.mask\(body, "en"\)/.test(html));
  t("伏せきれない既出一覧は渡さない（平文の数値を送り返さない）",
    /function priorFindingsDigest[\s\S]{0,1200}verifyMask\(masked\)[\s\S]{0,300}return "";/.test(html));
  t("既出一覧は「報告禁止リスト」として渡す（参考として渡すと言い換えて再掲される）",
    /報告禁止リスト/.test(html));
  t("ラウンド2は 0件でも正しいと明示する（無理に絞り出させない）",
    /0件が正しい答えになりえます/.test(html));
  const consistencyStart = html.indexOf("async function startConsistencyReview");
  const consistencyEnd = html.indexOf("async function applyAutoAnswer", consistencyStart);
  const consistencyReview = html.slice(consistencyStart, consistencyEnd);
  t("整合性roundはround1完了後に次roundを作る",
    /const resumeRound = Math\.max\(1, Number\(opts\.resumeRound \|\| 1\)\)/.test(consistencyReview)
    && /for \(let round = resumeRound; round <= rounds; round\+\+\)/.test(consistencyReview));
  t("round1/各roundのjob完了を待ってから次へ進む",
    /const completedState = await submitAndPollAutoJob\(packets(?:,[^)]*)?\);[\s\S]*lastAutoJobState\?\.mode === "needs_user_visibility"[\s\S]*return;/.test(consistencyReview));
  t("needs_user_visibility時は次roundを投入しない",
    /isNeedsUserVisibilityState\(completedState\)[\s\S]*fullRunWaitingVisibility = true[\s\S]*return;/.test(consistencyReview));
  t("ラウンド2のパケットIDとファイル名を分ける（同名だと結果が上書きされ、添付も競合する）",
    /"_R" \+ round/.test(html));
  // ⚠️ ラウンド2で同じ指示を出すと、同じものが見つかり、それは報告禁止リストに載っているので
  //    出力が0件になる（実測 2026-08-05: numbers のラウンド2がちょうどこれで0件だった）。
  t("ラウンド2は専用の指示に切り替える（同じ探し方を繰り返さない）",
    /CONSISTENCY_LENS_PROMPTS\[lens \+ "_r2"\]/.test(html));
  // 観点ごとに「1回目とは別の探し方」を用意する。numbers だけ変えても他が同じでは、
  // 他の観点のラウンド2は同じ結果を出して報告禁止リストに弾かれるだけになる。
  for (const lens of ["numbers", "terms", "structure"]) {
    t(`${lens} にラウンド2の指示がある`, new RegExp(`^\\s{6}${lens}_r2:`, "m").test(block));
  }
  t("ラウンド2はどれも「探し方を変える」と明示している",
    (block.match(/1回目とは\*\*探し方を変えてください/g) || []).length >= 3);
  t("gap は「報告禁止リストに出てこないページ」から見るよう指示している",
    /出てこないページ/.test(block));
  // ⚠️ 2026-08-06 に numbers のラウンド2を書き換えた。旧版は「指標名を列挙してから記号を
  //    突き合わせる」だったが、**それは1回目と同じ入口**で、実測では 0〜1件しか出なくなっていた
  //    （27回の run のうち6回が0件、3回が1件）。1回目が 14〜17件を出し、
  //    3回とも取れない planted が7件あるのに、ラウンド2が何も足せていなかった。
  //    そこで一度**入口を逆にした**（記号から入り、1回しか出てこない記号を残す）。
  //
  // ⚠️ 2026-08-07、その入口を測ったら**まったく絞れていなかった**。
  //    `node tools/Audit-DocumentMask.mjs <pdf> --symbol-stats` で、200ページの文書は
  //    569個の記号のうち **433個（76%）が1回だけ**。433件を見きれるはずがない。
  //    3回とも取れない n050 / n070b / n130b の記号も、数えたら全部「1回だけ」で、
  //    入口は通っていた。つまり**候補が多すぎて届いていなかった**。
  //    そこで入口を「ものの数を述べている文」に絞った。実測でこの言い回しは
  //    134文中12文しかなく、取れない3件の相手側はすべてこの型だった。
  t("ラウンド2の数値は「数を述べている文」から入る",
    /数を述べている文/.test(block) && /数えられるものの個数/.test(block));
  t("ラウンド2の数値は記号を数える入口を明示的に禁じている（絞れないため）",
    /1回しか出てこない記号を探す」やり方は\*\*しないでください/.test(block) && /433/.test(block));
  t("ラウンド2の数値は指標名の再列挙を明示的に禁じている",
    /指標名の一覧を作り直すやり方は\*\*しないでください/.test(block));
}

// --- 7. 指示文と出力ひな型が食い違っていないか ----------------------------
//
// ⚠️ 実測（2026-08-05）: 整合性プロンプトは「needs_human_review の区別は使いません」と
//    書いておきながら、直下の出力JSONひな型に "needs_human_review": true が残っていた。
//    モデルはひな型を写すので、写した run では 47件中37件に旗が付いて strict 12.5%、
//    写さなかった run では 50件中7件で strict 76.8%。同じ構成なのに strict だけが振れる。
//    採点側（report-to-run.mjs）はこの旗で findings と uncertain_candidates を分けるため、
//    ひな型に1行残っているだけで「何を測っているか」が run ごとに変わってしまう。
{
  const start = html.indexOf("function buildConsistencyPromptText");
  const consistencyPrompt = html.slice(start, html.indexOf("\n    function ", start + 10));
  t("整合性プロンプトを切り出せている", consistencyPrompt.length > 1000 && consistencyPrompt.includes("\"packet_id\""));
  t("整合性プロンプトは曖昧候補を通常findingへ入れない",
    /evidence_quality=clear、reading_confidence>=0\.75/.test(consistencyPrompt));
  t("整合性プロンプトの出力ひな型に needs_human_review が残っていない（指示文と食い違わせない）",
    !/"needs_human_review"/.test(consistencyPrompt));

  // ⚠️ omitted_uncertain_findings も同じ型の食い違いだった。この箱の使い方を書いた指示は
  //    校正パケット側にしか無く、整合性のひな型には**説明なしで欄だけ**あった。
  //    「指摘はすべて要確認候補」と言っているモードで「確信が持てないものを入れる箱」を
  //    渡すのは、recall で測る側から見れば黙って落としてよい置き場を渡すのと同じ。
  t("整合性プロンプトの出力ひな型に omitted_uncertain_findings が無い",
    !/omitted_uncertain_findings/.test(consistencyPrompt));
  // 校正パケット側は弁として残す。ただし返ってきた件数を捨てないこと。
  t("校正パケット側は omitted_uncertain_findings を使い続けている",
    /omitted_uncertain_findings に件数だけ入れてください/.test(html));
  t("取り込み時に omitted_uncertain_findings の件数を画面へ出す（黙って捨てない）",
    /data\?\.omitted_uncertain_findings/.test(html) && /報告せず件数だけ返しました/.test(html));
}

t("添付ファイル名も観点ごとに分けている（並列で同名だと添付が競合する）",
  /prompt_name: withLens\(/.test(html) && /text_name: withLens\(/.test(html) &&
  /pdf_name: pdf_base64 \? withLens\(/.test(html));

if (bad) { console.error(`\nTest-ConsistencyLenses: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-ConsistencyLenses: PASS");
