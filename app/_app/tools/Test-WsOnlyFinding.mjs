const removeWhitespace = value => String(value || "").replace(/[\s\u00a0\u3000\u200b\u200c\u200d\ufeff]+/g, "");
const wsOnly = (quote, suggestion) => !!quote && !!suggestion && quote !== suggestion && removeWhitespace(quote) === removeWhitespace(suggestion);

const cases = [
  ["( (71.6) %)", "((71.6)%)", true, "spaces"],
  ["Other", "other", false, "case"],
  ["available\u00adfor-sale", "availablefor-sale", false, "soft-hyphen"],
  ["A\u3000B", "AB", true, "fullwidth-space"],
  ["A\u200bB", "AB", true, "zero-width"]
];
for (const [quote, suggestion, expected, name] of cases) {
  const actual = wsOnly(quote, suggestion);
  if (actual !== expected) throw new Error(`${name}: expected=${expected} actual=${actual}`);
}
console.log("Test-WsOnlyFinding: PASS");
