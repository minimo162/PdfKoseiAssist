// Regression tests for the async finding-import selection anchor.
import {
  selectionAnchorForFinding,
  resolveSelectedFinding,
} from "../js/finding-selection.mjs";

let failures = 0;
const t = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
};

const finding = (id, page, quote, extra = {}) => ({
  id, page, quote, category: "number_mismatch", areaHint: "table", ...extra,
});

// A user changes cards while importResponse is awaiting quote validation. The
// commit-time active id/anchor must win over the stale selection from import
// start, so this models the state immediately before the final commit.
{
  const first = finding("F0001", 2, "Net sales 1,000");
  const second = finding("F0002", 8, "Operating income 200");
  const started = first;
  let active = started;
  const pending = Promise.resolve().then(() => { active = second; });
  await pending;
  const resolved = resolveSelectedFinding([first, second], active.id, selectionAnchorForFinding(active));
  t("await中に利用者が選んだカードをcommit時に優先", resolved === second && resolved.id === "F0002");
}

// Dedupe can replace a representative with a fresh id while retaining the
// same page/quote (for example, a verified candidate outranks the first one).
{
  const old = finding("F0010", 4, "Net income attributable 114,079");
  const replacement = finding("F0099", 4, "Net income attributable 114,079", { confidence: 0.99 });
  const anchor = selectionAnchorForFinding(old);
  const resolved = resolveSelectedFinding([replacement], old.id, anchor);
  t("dedupe代表IDが変わってもページとquoteで復元", resolved === replacement);
}

// Incremental responses may reorder the entire list. The selected finding id
// remains stable and must not fall back to the first newly-arrived card.
{
  const selected = finding("F0020", 12, "Other regions");
  const reordered = [finding("F0030", 1, "Title"), selected, finding("F0040", 20, "Notes")];
  const resolved = resolveSelectedFinding(reordered, selected.id, selectionAnchorForFinding(selected));
  t("増分取込で一覧が並び替わっても選択を維持", resolved === selected);
}

// A representative with a longer/shorter source-backed quote is still the
// same location, but unrelated short snippets must not steal the selection.
{
  const old = finding("F0050", 6, "Operating income 150.0");
  const replacement = finding("F0051", 6, "Consolidated operating income 150.0 for FY2026");
  const unrelated = finding("F0052", 6, "income");
  const anchor = selectionAnchorForFinding(old);
  t("代表引用の包含差を同じ位置として復元", resolveSelectedFinding([replacement], old.id, anchor) === replacement);
  t("短い無関係な引用へ選択を誤移動しない", resolveSelectedFinding([unrelated], old.id, anchor) === null);
}

// Dedupe deliberately ignores footnote markers.  Selection restoration must
// use the same location identity when that normalization causes a new
// representative id to replace the selected finding.
{
  const old = finding("F0060", 17, "Profit per share (Yen)3");
  const replacement = finding("F0061", 17, "Profit per share (Yen)*3");
  t("dedupeと同じ脚注記号正規化で選択を復元", resolveSelectedFinding(
    [replacement], old.id, selectionAnchorForFinding(old)
  ) === replacement);
}

if (failures) {
  console.error(`\nTest-FindingSelection: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-FindingSelection: PASS");
