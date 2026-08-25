import assert from "node:assert/strict";
import {
  isReferenceFreeConsistencyPacket,
  scopeOrCategoryRequiresReferenceEvidence,
  shouldCommitExcludedOnlyPacket,
} from "../js/auto-import-evidence.mjs";

const noRefConsistency = { kind: "consistency", has_ref: false };
const withRefConsistency = { kind: "consistency", has_ref: true };

assert.equal(isReferenceFreeConsistencyPacket(noRefConsistency), true);
assert.equal(scopeOrCategoryRequiresReferenceEvidence({
  issueScope: "translation_consistency",
  category: "terminology",
}, noRefConsistency), false);
assert.equal(scopeOrCategoryRequiresReferenceEvidence({
  issueScope: "translation_consistency",
  category: "translation_consistency",
}, noRefConsistency), false);
assert.equal(scopeOrCategoryRequiresReferenceEvidence({
  issueScope: "translation_consistency",
  category: "mistranslation",
}, noRefConsistency), true);
assert.equal(scopeOrCategoryRequiresReferenceEvidence({
  issueScope: "translation_consistency",
  category: "terminology",
}, withRefConsistency), true);
assert.equal(scopeOrCategoryRequiresReferenceEvidence({
  issueScope: "translation_consistency",
  category: "terminology",
}, null), true);

assert.equal(shouldCommitExcludedOnlyPacket({
  isAutoImport: true,
  candidateCount: 2,
  acceptedCount: 0,
}), true);
assert.equal(shouldCommitExcludedOnlyPacket({
  isAutoImport: true,
  readError: "PDF unavailable",
  candidateCount: 2,
  acceptedCount: 0,
}), false);
assert.equal(shouldCommitExcludedOnlyPacket({
  isAutoImport: true,
  candidateCount: 0,
  acceptedCount: 0,
}), false);
assert.equal(shouldCommitExcludedOnlyPacket({
  isAutoImport: false,
  candidateCount: 2,
  acceptedCount: 0,
}), false);

console.log("Test-Issue124Regression: PASS");
