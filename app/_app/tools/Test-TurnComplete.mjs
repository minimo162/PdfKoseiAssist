// Test-TurnComplete.mjs — turn-complete.mjs の検証（node tools/Test-TurnComplete.mjs）
import { findTurnCompletion, stripCodeFence } from "../js/turn-complete.mjs";

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

const MK = "KOSEI_END_ab12_3_1_9f8e7d6c";

// 有効JSONの直後に独立最終行marker → success
{
  const r = findTurnCompletion(`{"findings":[],"no_findings_reason":"ok"}\n${MK}\n`, MK);
  t("valid JSON + marker行 → success", r.success === true && r.detected === true && r.jsonValid === true);
}

// 実Copilot挙動: JSONと同じ行にスペース区切りで marker → success
{
  const r = findTurnCompletion(`{"packet_id":"smoke","findings":[]} ${MK}`, MK);
  t("同一行 '} MARKER' → success", r.success === true && r.detected === true);
}

// marker の直前が英字（長い識別子の一部）→ 検知しない
{
  const r = findTurnCompletion(`{"findings":[]}\nX${MK}`, MK);
  t("英字直後のmarkerは境界不成立 → detected=false", r.detected === false);
}

// code fence 付き → success（fence除去して parse）
{
  const r = findTurnCompletion("```json\n{\"findings\":[]}\n```\n" + MK, MK);
  t("code fence 除去して success", r.success === true);
}

// marker が JSON文字列値の中にあるだけ（独立行でない）→ 完了扱いしない
{
  const r = findTurnCompletion(`{"reason":"末尾に ${MK} と書く"}`, MK);
  t("JSON内部の marker 部分一致は detected=false", r.detected === false && r.success === false);
}

// marker 行の後ろに非空テキスト → 完了扱いしない（condition 4）
{
  const r = findTurnCompletion(`{"findings":[]}\n${MK}\n余計な後書き`, MK);
  t("marker後に非空 → detected=false", r.detected === false);
}

// marker 行はあるが直前JSONが壊れている（末尾カンマ）→ detected=true, success=false
{
  const r = findTurnCompletion(`{"findings":[],}\n${MK}`, MK);
  t("壊れたJSON+marker → detected=true", r.detected === true);
  t("壊れたJSON+marker → success=false（incomplete-json へ委譲）", r.success === false && r.jsonValid === false);
}

// 別turnのマーカーには反応しない（turnごと一意）
{
  const other = "KOSEI_END_ab12_3_2_00112233";
  const r = findTurnCompletion(`{"findings":[]}\n${other}`, MK);
  t("別turnマーカーには detected=false", r.detected === false);
}

// stripCodeFence 単体
t("stripCodeFence 除去", stripCodeFence("```json\n{\"a\":1}\n```") === '{"a":1}');
t("stripCodeFence 非fenceは素通し", stripCodeFence('{"a":1}') === '{"a":1}');

if (failures > 0) { console.error(`\nTest-TurnComplete: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-TurnComplete: PASS");
