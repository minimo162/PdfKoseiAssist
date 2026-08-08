// Test-ElapsedEstimate.mjs — 経過と「残りおよそ」の出し方を固定する。
//
// なぜ要るか（独立レビュー 2026-08-08）:
//   実行に数十分かかるのに、画面には「3/20」しか出ていなかった。
//   あと何分か分からなければ、利用者は席を離れられないし、途中で止めてしまう。
//
// ⚠️ 残りは **完了数と実経過だけ** から出す。1件あたりの所要を足し上げてはいけない。
//    パケットは並列に走るので、足し上げた値は実際の数倍になる。
// ⚠️ 完了1件では出さない。最初の並列分はほぼ同時に終わるので、そこで割ると
//    「残り19倍」のような値になる。この検査はその線引きを見ている。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");

const grab = (re, label) => {
  const m = html.match(re);
  if (!m) { console.error(`index.html から ${label} を取り出せません`); process.exit(1); }
  return m[0];
};
const src = grab(/function formatDuration\(ms, coarse\) \{[\s\S]*?\n    \}/, "formatDuration")
          + "\n" + grab(/function autoElapsedLine\(st\) \{[\s\S]*?\n    \}/, "autoElapsedLine");
// 実際の開始時刻は画面側が Date.now() で持つ（autoRunStartedAt）。
// created_at を読む道は、それが取れなかったときの控えである。
const { formatDuration, autoElapsedLine, setStart } =
  eval("(function(){let autoRunStartedAt=0;" + src
     + "; return { formatDuration, autoElapsedLine, setStart:(v)=>{autoRunStartedAt=v} }})()");

const results = [];
const t = (name, ok, detail) => results.push({ ok: !!ok, name, detail });
const eq = (name, got, want) => t(name, got === want, `期待「${want}」/ 実際「${got}」`);

// --- 長さの書き方 ---
eq("秒",            formatDuration(45_000), "45秒");
eq("分",            formatDuration(9 * 60_000), "9分");
eq("時間と分",      formatDuration(95 * 60_000), "1時間35分");
eq("ちょうど1時間",  formatDuration(60 * 60_000), "1時間");
// 見込みは丸める。分単位で出すと外れが目立ってかえって信用を失う。
eq("見込み・1分未満", formatDuration(20_000, true), "1分未満");
eq("見込み・10分未満はそのまま", formatDuration(7 * 60_000, true), "7分");
eq("見込み・5分単位に丸める", formatDuration(23 * 60_000, true), "25分");

// --- 残りの見込み ---
const line = (minAgo, done, total) => {
  setStart(Date.now() - minAgo * 60_000);
  return autoElapsedLine({ packets_done: done, packets_total: total }).replace(/<[^>]*>/g, "");
};

t("経過を出す", line(10, 0, 20).includes("経過 10分"), line(10, 0, 20));
// ⚠️ 控えの created_at は「時差表記の無い地方時」である。UTC と読むと時差の分ずれる
//    （実測でこの検査が9時間ずれて落ちた）。だから画面側の時刻を先に見る。
{
  setStart(0);
  const local = new Date(Date.now() - 10 * 60_000);
  const pad = (v) => String(v).padStart(2, "0");
  const s = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
          + `T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
  const got = autoElapsedLine({ created_at: s, packets_done: 0, packets_total: 20 }).replace(/<[^>]*>/g, "");
  t("控えの created_at も地方時として読める", got.includes("経過 10分"), got);
}
t("完了0件では見込みを出さない", line(10, 0, 20).includes("あと1件終わると出ます"), line(10, 0, 20));
t("完了1件でも見込みを出さない", line(10, 1, 20).includes("あと1件終わると出ます"), line(10, 1, 20));
// 20分で4件 → 1件5分 → 残り16件で80分。並列でも実経過から割るので比例で正しい。
t("完了2件以上で見込みを出す", line(20, 4, 20).includes("1時間20分"), line(20, 4, 20));
t("全件終わったら残りを出さない", !line(20, 20, 20).includes("残り"), line(20, 20, 20));
setStart(0);
t("日時が無ければ何も出さない", autoElapsedLine({ created_at: "" }) === "", "");

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ElapsedEstimate: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
