// Check-FootnoteMarkers.mjs — 脚注記号が回答から消えていないかを、実 run の結果で確かめる。
//
//   node tools/Check-FootnoteMarkers.mjs docs/benchmarks/runs/raw/<file>.json
//   node tools/Check-FootnoteMarkers.mjs docs/benchmarks/runs/raw          （まとめて）
//
// なぜ要るか（引き継ぎ書 §8）:
//   Copilot の回答は Markdown をレンダリングした後の DOM から読む。地の文で返された
//   JSON は Markdown として解釈され、*1 … *1 のように対になった星印が強調記号として
//   **消える**。引用が本文と食い違うのでハイライトが当たらず、利用者が飛べない。
//
//   実測 2026-08-07（修正前・6本424件）:
//     引用または理由に * を含む         7件
//     脚注を論じているのに * が無い     12件
//
//   依頼文で `\*2` のようにエスケープさせる形に直したが、**実 run での確認は
//   まだ取れていない**。次に成功した run でこれを走らせること。
//
// 読み方:
//   「脚注を論じているのに星印が無い」が 0 なら直っている。
//   1件でも残るなら、依頼文が効いていないか、別の経路で消えている。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (!args.length) { console.error("run の JSON かディレクトリを渡してください"); process.exit(2); }

const files = [];
for (const a of args) {
  let st = null;
  try { st = statSync(a); } catch { console.error(`見つかりません: ${a}`); process.exit(2); }
  if (st.isDirectory()) {
    for (const f of readdirSync(a)) if (f.endsWith(".json")) files.push(join(a, f));
  } else files.push(a);
}

// 脚注を論じている理由文。星印が生きていれば必ず * が付く。
// ⚠️ 「注記」「Note」を入れてはいけない。**注記番号は星印を持たないのが正常**である。
//    実測 2026-08-08:「主要株主の一覧はP.53にあり、Note 21 への参照とは整合しない」を
//    星印が落ちたと誤検知した。**狼少年になる検査は無いより悪い。**
const TALKS_FOOTNOTE = /脚注|footnote/i;
// 「*」が落ちた跡: 脚注の話をしているのに、裸の1〜2桁が参照として出てくる。
//   例「本文には3の参照があるが、同ページに3の脚注欄が無い」
// 番号の前に Note / P. / ( が付くものは、注記番号・ページ番号・項番なので除く。
const BARE_REF = /(?:^|[^\d*＊※(（.])(?<!Note\s)(?<!P\.)[1-9](?![\d年月日%．.,])/;

let total = 0, withStar = 0, suspicious = 0;
const examples = [];

for (const f of files) {
  let j = null;
  try { j = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
  for (const x of (j.findings || [])) {
    const text = `${x.quote || ""} ${x.model_reason || x.reason || ""}`;
    total++;
    if (/[*＊]/.test(text)) { withStar++; continue; }
    if (TALKS_FOOTNOTE.test(text) && BARE_REF.test(text)) {
      suspicious++;
      if (examples.length < 5) examples.push(`${f.split(/[\\/]/).pop()}: ${String(x.model_reason || x.reason || "").slice(0, 90)}`);
    }
  }
}

console.log(`指摘 ${total}件 / 星印を含む ${withStar}件 / 脚注を論じつつ星印が無い ${suspicious}件`);
for (const e of examples) console.log(`  ${e}`);
console.log("");
if (suspicious === 0) {
  console.log("Check-FootnoteMarkers: PASS（星印が落ちた形跡なし）");
  process.exit(0);
}
console.log("Check-FootnoteMarkers: FAIL — 星印が落ちています。");
console.log("  依頼文（index.html の出力形式）でエスケープを指示できているか、");
console.log("  読み取り（CopilotClient.ps1）がコードブロックを拾っていないかを見てください。");
process.exit(1);
