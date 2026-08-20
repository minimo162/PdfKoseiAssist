import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const reviewSource = readFileSync(join(here, "../src/ReviewJob.ps1"), "utf8");
const serverSource = readFileSync(join(here, "../src/Server.ps1"), "utf8");
const htmlSource = readFileSync(join(here, "../index.html"), "utf8");

assert.match(reviewSource, /function ConvertTo-KoseiRecoveryAncestorIdList/);
assert.match(reviewSource, /ConvertTo-KoseiRecoveryAncestorIdList -Value \$AncestorJobIds/);
assert.match(serverSource, /ConvertTo-KoseiRecoveryAncestorIdList -Value \$body\.recovery_ancestor_job_ids/);
assert.match(reviewSource, /ConvertTo-KoseiRecoveryAncestorIdList -Value \$parentState\.recovery_ancestor_job_ids/);
assert.match(htmlSource, /\.filter\(value => \/\^\[0-9a-f\]\{32\}\$\/\.test\(value\)\)/);
assert.match(htmlSource, /\.\.\.\(recoveryAncestors\.length \? \{ recovery_ancestor_job_ids: recoveryAncestors \} : \{\}\)/);

console.log("Test-RecoveryAncestorNormalization: PASS");
