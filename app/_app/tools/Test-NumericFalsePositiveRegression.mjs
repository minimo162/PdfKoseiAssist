import assert from "node:assert/strict";
import { Masker, tokenizeJa, tokenizeEn, verify } from "../js/number-mask.mjs";
import { partitionNumericFalsePositives } from "../js/review-merge-core.mjs";
// index.html が実際に読み込む入口。`export *` の後に同名関数を再定義しているため、
// core 側の決定的判定が本番経路でも効いていることをここで固定する。
import {
  partitionNumericFalsePositives as appPartitionNumericFalsePositives,
  isExplicitTargetReferenceSameValueClaim,
  isMaskedPlaceholderOnlyMismatchFinding,
  downgradeSuspectNumericSeverity,
} from "../js/review-merge.mjs";

const symbolOf = text => text.match(/⟦#[A-Z]{3}⟧/)?.[0] || "";
const symbolsOf = text => text.match(/⟦#[A-Z]{3}⟧/g) || [];

{
  const masker = new Masker(103);
  const en20 = masker.mask("costs (20) oku", "en").text;
  const ja20 = masker.mask("費用 ▲20億円", "ja").text;
  assert.ok(verify(en20).ok, en20);
  assert.equal(symbolOf(en20), symbolOf(ja20), `${en20} <> ${ja20}`);
  assert.doesNotMatch(en20, /\b20\b/);

  const en54 = masker.mask("loss (54) k yen", "en").text;
  const ja54 = masker.mask("損失 ▲54千円", "ja").text;
  assert.ok(verify(en54).ok, en54);
  assert.equal(symbolOf(en54), symbolOf(ja54), `${en54} <> ${ja54}`);

  const en108 = masker.mask("Japan (108) oku.", "en").text;
  const ja108 = masker.mask("日本 (108)億円。", "ja").text;
  assert.equal(symbolOf(en108), symbolOf(ja108), `${en108} <> ${ja108}`);
  assert.match(en108, /^Japan \(⟦#[A-Z]{3}⟧\) oku\.$/);
  assert.match(ja108, /^日本 \(⟦#[A-Z]{3}⟧\)億円。$/);
  assert.equal(tokenizeEn("(108) oku")[0]?.chosenExp, 8);
  assert.equal(tokenizeJa("(108)億円")[0]?.chosenExp, 8);
  assert.equal(tokenizeJa("(108)億円")[0]?.sign, "(");
}

{
  const masker = new Masker(104);
  const en = masker.mask("Down (419) oku", "en").text;
  const ja = masker.mask("(419)億円", "ja").text;
  const sym = symbolOf(en);
  assert.equal(sym, symbolOf(ja));

  const noSource = partitionNumericFalsePositives([{
    id: "n8", category: "number_mismatch", quote: en, referenceQuote: ja,
    suggestion: en,
  }], { masker });
  assert.equal(noSource.kept.length, 0);
  assert.equal(noSource.dropped.length, 1);

  const partial = masker.mask("(508)億円、(692)億円", "ja").text;
  const en508 = masker.mask("(508) oku yen", "en").text;
  const partialResult = partitionNumericFalsePositives([{
    id: "n14", category: "number_mismatch", quote: en508, referenceQuote: partial,
    suggestion: "Use the Japanese amount.",
  }], { masker });
  assert.equal(partialResult.kept.length, 0);
  assert.equal(partialResult.dropped.length, 1);

  const signs = symbolsOf(partial);
  assert.ok(signs.length >= 2);
  const signMismatch = partitionNumericFalsePositives([{
    id: "guard-sign", category: "number_mismatch", quote: `+${sym} oku`, referenceQuote: `(${sym})億円`, suggestion: "check",
  }], { masker });
  assert.equal(signMismatch.kept.length, 1);

  const differentSymbol = partitionNumericFalsePositives([{
    id: "guard-symbol", category: "number_mismatch", quote: `(${sym}) oku`, referenceQuote: `(${signs[1]})億円`, suggestion: "check",
  }], { masker });
  assert.equal(differentSymbol.kept.length, 1);
}

{
  const nameNoise = partitionNumericFalsePositives([{
    id: "name", category: "name_mismatch", quote: "CX-50", referenceQuote: "CX-50",
    suggestion: "「CX-50」または「CX-50」に統一する",
  }]);
  assert.equal(nameNoise.kept.length, 0);
  assert.equal(nameNoise.dropped.length, 1);
}

{
  // 本番入口（review-merge.mjs）と core の判定が一致すること。
  const masker = new Masker(105);
  const en = masker.mask("Down (419) oku", "en").text;
  const ja = masker.mask("(419)億円", "ja").text;
  const cases = [
    { id: "same-symbol", category: "number_mismatch", quote: en, referenceQuote: ja, suggestion: en },
    { id: "self-duplicate", category: "name_mismatch", quote: "CX-50", referenceQuote: "CX-50",
      suggestion: "「CX-50」または「CX-50」に統一する" },
    { id: "real", category: "mistranslation", quote: "Foreign Currency Transaction adj.",
      referenceQuote: "為替換算調整勘定", suggestion: "Foreign Currency Translation Adjustment" },
  ];
  for (const finding of cases) {
    const core = partitionNumericFalsePositives([finding], { masker }).dropped.length;
    const app = appPartitionNumericFalsePositives([finding], { masker }).dropped.length;
    assert.equal(app, core, `app/core disagree on ${finding.id}: app=${app} core=${core}`);
  }
  assert.equal(appPartitionNumericFalsePositives([cases[2]], { masker }).kept.length, 1);
}

{
  // 適用しても変わらない指摘は数値証明では落とさない。除外理由を表示するため、
  // UI 側が excludedReason="no-op-suggestion" として除外一覧に残す。
  const noOp = {
    id: "no-op", category: "name_mismatch",
    quote: "CX-50 and Large models maintained volume",
    suggestion: "CX-50 and Large models maintained volume",
    referenceQuote: "CX-50、ラージは奨励金強化、フリート増により台数を維持",
  };
  assert.equal(partitionNumericFalsePositives([noOp]).kept.length, 1);
  assert.equal(appPartitionNumericFalsePositives([noOp]).kept.length, 1);
}

{
  // 壊れた括弧の符号表記は masked-symbol の一致だけでは落とさない（fail-closed）。
  const masker = new Masker(106);
  const en = masker.mask("Down (419 oku", "en").text;
  const ja = masker.mask("(419)億円", "ja").text;
  const malformed = { id: "malformed", category: "number_mismatch", quote: `(${symbolOf(ja)} oku`, referenceQuote: ja, suggestion: en };
  assert.equal(appPartitionNumericFalsePositives([malformed], { masker }).kept.length, 1);
}

{
  // #106: TARGET/REF の数値列が完全一致している number_mismatch は、
  // モデルの説明文・confidence によらず決定的に除外する。
  const identicalColumns = [
    {
      id: "p21", category: "number_mismatch", severity: "high",
      quote: "Total consolidated 1,183 - (3.6) 257 254 1,437",
      referenceQuote: "連結合計 1,183 - (3.6) 257 254 1,437",
      reason: "連結合計の期末残高が比較資料と一致していない。",
      confidence: 0.95,
    },
    {
      id: "p24", category: "number_mismatch", severity: "high",
      quote: "Market Capitalization (oku yen) 52 9,586 8,864 7,806 3,604 5,683 5,727 7,718 11,063 5,935 6,554 6,380",
      referenceQuote: "時価総額 (億円) 52 9,586 8,864 7,806 3,604 5,683 5,727 7,718 11,063 5,935 6,554 6,380",
      reason: "時価総額の数値列が比較資料と一致していない。",
      confidence: 0.9,
    },
  ];
  for (const finding of identicalColumns) {
    assert.equal(partitionNumericFalsePositives([finding]).dropped.length, 1, `core kept ${finding.id}`);
    assert.equal(appPartitionNumericFalsePositives([finding]).dropped.length, 1, `app kept ${finding.id}`);
  }

  // 値・符号・単位・列数・列順のいずれかが違えば従来どおり残す。
  const kept = [
    {
      id: "one-value-diff", category: "number_mismatch",
      quote: "Total consolidated 1,183 - (3.6) 257 254 1,437",
      referenceQuote: "連結合計 1,183 - (3.6) 257 254 1,438",
    },
    {
      id: "paren-sign-diff", category: "number_mismatch",
      quote: "Total consolidated 1,183 - 3.6 257 254 1,437",
      referenceQuote: "連結合計 1,183 - (3.6) 257 254 1,437",
    },
    {
      id: "triangle-sign-diff", category: "number_mismatch",
      quote: "Total consolidated 1,183 - 3.6 257 254 1,437",
      referenceQuote: "連結合計 1,183 - ▲3.6 257 254 1,437",
    },
    {
      id: "unit-diff", category: "number_mismatch",
      quote: "Market Capitalization (million yen) 52 9,586 8,864 7,806",
      referenceQuote: "時価総額 (億円) 52 9,586 8,864 7,806",
    },
    {
      id: "column-count-diff", category: "number_mismatch",
      quote: "Total consolidated 1,183 - (3.6) 257 254 1,437",
      referenceQuote: "連結合計 1,183 - (3.6) 257 254",
    },
    {
      id: "column-order-diff", category: "number_mismatch",
      quote: "Total consolidated 1,183 - (3.6) 257 254 1,437",
      referenceQuote: "連結合計 1,183 - (3.6) 254 257 1,437",
    },
    {
      // 同一言語で行ラベルだけが違う対は、同じ列でも別行の実指摘であり得る。
      id: "same-language-row-swap", category: "number_mismatch",
      quote: "Goodwill 1,183 3.6 257 254 1,437",
      referenceQuote: "Patent assets 1,183 3.6 257 254 1,437",
    },
    {
      // 2列程度の同値は別行どうしでも起こるため決定的除外の対象外。
      id: "short-column", category: "number_mismatch",
      quote: "Unrelated metric 630,263 630,626",
      referenceQuote: "別の指標 630,263 630,626",
    },
  ];
  for (const finding of kept) {
    assert.equal(partitionNumericFalsePositives([finding]).kept.length, 1, `core dropped ${finding.id}`);
    assert.equal(appPartitionNumericFalsePositives([finding]).kept.length, 1, `app dropped ${finding.id}`);
  }
}

{
  // #116: TARGET/REFの明示ラベル付き理由で同一値を不一致と述べた場合だけhard drop。
  const same = {
    id: "p81", category: "number_mismatch", severity: "high",
    reason: "TARGETでは22,857、比較資料では22,857で一致していない。",
  };
  assert.equal(appPartitionNumericFalsePositives([same]).dropped.length, 1);
  assert.equal(appPartitionNumericFalsePositives([{ ...same, reason: "TARGETでは22,857、比較資料では22,858で一致していない。" }]).kept.length, 1);
  assert.equal(isExplicitTargetReferenceSameValueClaim({ ...same, reason: "22,857と22,857が一致していない。" }), false);
  assert.equal(appPartitionNumericFalsePositives([{ ...same, reason: "TARGETでは22,857千円、比較資料では22,857百万円で一致していない。" }]).kept.length, 1);

  const masked = { category: "number_mismatch", issue_summary: "伏字記号⟦#ABC⟧が比較資料と異なる" };
  assert.equal(isMaskedPlaceholderOnlyMismatchFinding(masked), true);
  assert.equal(isMaskedPlaceholderOnlyMismatchFinding({ category: "number_mismatch", reason: "TARGET 10、REF 11で不一致" }), false);
  assert.equal(isMaskedPlaceholderOnlyMismatchFinding({ ...masked, reason: "伏字記号に加えてTARGET 10、REF 11も不一致" }), false);
  assert.equal(downgradeSuspectNumericSeverity(same).severity, "medium");
  assert.equal(downgradeSuspectNumericSeverity({ ...same, severity: "low" }).severity, "low");
}

console.log("Test-NumericFalsePositiveRegression: PASS");
