import assert from "node:assert/strict";
import {
  detectDocumentLanguage,
  languageDetectionSnapshotIsCurrent,
  mergeDetectedDocumentLanguages,
} from "../js/review-settings.mjs";

assert.equal(detectDocumentLanguage("This is an English proofreading sample with enough letters."), "英語");
assert.equal(detectDocumentLanguage("これは日本語の校正対象です。"), "日本語");
assert.equal(detectDocumentLanguage("这是中文文档。"), "その他");
assert.equal(detectDocumentLanguage("한국어 문서입니다."), "その他");
assert.equal(detectDocumentLanguage("1234 ---"), "その他");
assert.equal(mergeDetectedDocumentLanguages(["英語", "英語"]), "英語");
assert.equal(mergeDetectedDocumentLanguages(["英語", "日本語"]), "その他");
assert.equal(mergeDetectedDocumentLanguages([]), "その他");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function resolveDetection(snapshot, readCurrent, language, delay) {
  await wait(delay);
  return languageDetectionSnapshotIsCurrent(snapshot, readCurrent()) ? language : null;
}

// A slow extraction for the old target must not overwrite the fast result for
// a newer target, even when both PDFs have the same page count.
const oldTarget = {};
const newTarget = {};
let currentTarget = { source: oldTarget, generation: 1, pageCount: 2 };
const oldTargetResult = resolveDetection(
  { ...currentTarget },
  () => currentTarget,
  "英語",
  25,
);
await wait(1);
currentTarget = { source: newTarget, generation: 2, pageCount: 2 };
const newTargetResult = resolveDetection(
  { ...currentTarget },
  () => currentTarget,
  "日本語",
  1,
);
assert.equal(await newTargetResult, "日本語");
assert.equal(await oldTargetResult, null);

// Removing a reference document changes both the array identity and the
// dedicated generation; its in-flight result must be discarded.
const oldReferences = [{}];
let currentReferences = { source: oldReferences, generation: 7 };
const removedReferenceResult = resolveDetection(
  { ...currentReferences },
  () => currentReferences,
  "英語",
  20,
);
await wait(1);
currentReferences = { source: [], generation: 8 };
assert.equal(await removedReferenceResult, null);

assert.equal(
  languageDetectionSnapshotIsCurrent(
    { source: oldTarget, generation: 1, pageCount: 2 },
    { source: oldTarget, generation: 1, pageCount: 3 },
  ),
  false,
);

console.log("Test-LanguageDetection: PASS");
