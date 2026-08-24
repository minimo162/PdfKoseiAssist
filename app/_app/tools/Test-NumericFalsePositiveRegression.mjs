import assert from "node:assert/strict";
import { Masker, tokenizeJa, tokenizeEn, verify } from "../js/number-mask.mjs";
import { partitionNumericFalsePositives } from "../js/review-merge-core.mjs";

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

console.log("Test-NumericFalsePositiveRegression: PASS");
