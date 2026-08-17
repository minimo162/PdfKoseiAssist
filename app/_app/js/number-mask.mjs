// number-mask.mjs — 外部送信前に数値をプレースホルダーへ置き換える（仕様: docs/plan/NUMBER_MASKING_SPEC.md）
//
// 設計の芯は1つだけ:
//   **同じ実量には同じ記号**。数値そのものではなく、単位のスケール（百万・億・兆 /
//   thousand・million・billion）まで掛けた実際の量が同じなら、日英を通じて同じ記号になる。
//   これで「値を知らないまま数値の食い違いを指摘する」ことができる。
//
// ⚠️ このファイルで一番重要なのは「部分的にマスクしない」こと。
//    実測（docs/benchmarks/README.md）で、`-4,500` の先頭桁が伏せられず `-4,⟦#NCH⟧` になり、
//    **モデルが漏れた桁から記号の値を逆算しました**（⟦#RAY⟧=9 等）。
//    一部だけ漏れるのは全部漏れるのと同じです。原因は2つとも正規表現でした:
//      1. 負号の直後で照合を止める後読みを入れていた → 先頭桁が取り残された
//      2. `\d{1,3}(?:,\d{3})*` は "4500" に対して "450" だけ食う（カンマが無いので繰り返し0回）
//    どちらも下の NUM で塞いである。触るときは tools/Test-NumberMask.mjs を必ず通すこと。
//
// 純関数＋小さなクラス。ブラウザ／Node の両方から import できる。

// --- 数値リテラル -------------------------------------------------------
// カンマ区切り形を先に試す。後に回すと "4,500" が "4" で切れる。
// 逆にカンマ形を `*`（0回以上）にすると "4500" が "450" で切れる。どちらも部分マスクの原因。
//
// ⚠️ 桁区切りの最後のグループの**直後に数字が続いてはいけない**（`(?!\d)`）。
//    桁区切りは必ず3桁ずつなので、4桁続くならそれは桁区切りではない。
//    実測（実物の有報 p126）: 抽出テキストにカンマ後の空白が無い日付があった。
//      Ordinary shares 24,357 85.00 September 30,2024 December 2, 2024
//    ここで `\d{1,3}(?:,\d{3})+` が `30,2024` から **`30,202` を食い**、`4` が平文で残った
//    （`September ⟦#UUR⟧4`）。日付の許可スパンは "September 30" までなので、
//    トークン全体が収まらず許可されない。`(?!\d)` を足すと "30" と "2024" に割れ、
//    それぞれ月日・西暦として許可される。
const NUM_SRC = String.raw`\d{1,3}(?:[,，]\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?`;

// 実量は BigInt のマイクロ単位（1 = 1e-6）で持つ。浮動小数点は使わない。
// 実測で 32.8×10⁹ が 32799999999.999996 になり、別の記号が振られた。
const MICRO = 6;

/** "1,285.7" → BigInt(1285700000)（マイクロ単位） */
function toMicro(numStr) {
  const s = String(numStr).replace(/[,，]/g, "");
  const [int, frac = ""] = s.split(".");
  const f = (frac + "0".repeat(MICRO)).slice(0, MICRO);
  return BigInt(int + f);
}

/** マイクロ単位の BigInt に 10^exp を掛ける */
function shift(micro, exp) {
  return exp >= 0 ? micro * 10n ** BigInt(exp) : micro / 10n ** BigInt(-exp);
}

/** 表示された最小桁が表す量（マイクロ単位）。丸め表記の同値判定に使う。 */
function quantumMicro(numStr, exp = 0) {
  const s = String(numStr).replace(/[,，]/g, "");
  const frac = (s.split(".")[1] || "").slice(0, MICRO);
  return shift(10n ** BigInt(MICRO - frac.length), exp);
}

// --- スケール語 ---------------------------------------------------------
// 日本語は長いものから見る（「百万」を「万」より先に）。
const JA_SCALES = [["兆", 12], ["億", 8], ["百万", 6], ["万", 4], ["千", 3]];
// ⚠️ 英文の社内資料には**ローマ字の規模語**が出る。
//    `100 oku yen` / `100oku yen` / `100 Oku yen` / `100 OKU` … 書き方も空白も揃わない。
//    読めないと日本語の「100億円」と別の記号になり、
//    **正しい訳がすべて誤検出として報告される**（実測で 5通りともずれた）。
//    大文小文字と空白の有無は正規表現側で吸収する。
//    ⚠️ 実態（利用者からの訂正・2026-08-08）:
//       **`cho`（兆）は使わない**。一兆円は `10,000 oku yen` と書く。
//       **`man`（万）も使わない**。万円は `10k yen` のように `k` で書く。
//       使われていない語を入れるのは、衝突の危険を拾うだけで得が無い。
const EN_SCALES = [["trillion", 12], ["billion", 9], ["oku", 8], ["million", 6], ["thousand", 3]];

/**
 * スケール語の**途中に改行が入っていても**読めるようにする（「百万」→「百\s*万」）。
 *
 * ⚠️ 実測（26ページのフィクスチャをアプリの実経路で流した結果）:
 *    段組みの都合で `その他事業68,921百\n万円` と割れており、「百万」が繋がっていないため
 *    68,921 を **裸の数値**として読んでいました。英文側は `68,921 million yen` なので
 *    10⁶ 倍ずれた別の実量になり、**別の記号**が振られます。
 *    その結果モデルが「その他事業だけ記号が違う」と正しく振る舞い、
 *    **正しい訳を誤りとして報告しました**（マスカー由来の誤検知）。
 *    PDFの抽出テキストで単位が行またぎになるのは普通に起きるので、ここで吸収する。
 */
const spacedScale = (word) => word.split("").join("\\s*");

// --- 許可リスト（マスクしないもの） -------------------------------------
// §4.2。**構造番号を外すと出力が丸ごと無価値になる**（実測: ページ見出しを伏せたら
// モデルが page に記号を返し、指摘が1件も使えなくなった）。
export const DEFAULT_ALLOW = {
  years: true,      // 西暦（1900-2099）
  structure: true,  // 見出し番号・注番号・ページ番号（**書式で判定する。桁数では判定しない**）
};

// ⚠️ 「1〜2桁なら構造番号」という規則にしてはいけない。
//    実測（実物の有報）で `Scope 1 (direct emissions) 97 97 ⟦#LYQ⟧` のように、
//    **表の中の2桁の実データが平文のまま残りました**。桁数は構造番号の目印になりません。
//    そこで、構造番号と**書式で分かる**ものだけを残す。当たらなければ伏せる（フェイルクローズ）。
// 年月日は残す（利用者の判断）。大半は公知で、伏せると時系列の推論ができなくなる。
const DATE_PATTERNS = [
  /\d{1,2}\s*月/g,
  /\d{1,2}\s*日/g,
  /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/gi,
];

const STRUCTURE_PATTERNS = [
  // TEXTサイドカーのブロック見出し。こちらが生成した構造情報なので伏せない
  // （伏せると REF1_CANDIDATE が REF⟦#XSP⟧_CANDIDATE になり、役割が読めなくなる）。
  /^===== PDF P\.\d+ \/ .*=====$/gm,
  /\bCode\s+No\.?\s*[:：]?\s*\d{4,6}\b/gi,                // 上場会社の証券コード
  /コ\s*ー\s*ド\s*番\s*号\s*[:：]?\s*\d{4,6}/g,          // PDF抽出で字間が分かれる日本語コード欄
  /[(（]\s*\d{4,6}\s*[)）](?=\s*20\d{2}年)/g,            // `マツダ㈱(7261) 2027年…`
  /\b100(?=\s+millions?\s+of\s+(?:yen|shares|units)\b)/gi, // 「100 millions」は単位名の一部
  /1(?=\s*株当たり)/g,                    // 1株当たり利益の「1」は量ではなく指標名
  /第\s*\d{1,3}\s*(?:四半期|[期章条項号回])/g,   // 第160期 / 第2四半期 / 第24条
  // 見出し番号「(1)」。⚠️ **括弧付きの数字を無条件に許すと表の負値が丸ごと平文で残る。**
  //   実測（実物の短信）: `Allowance for doubtful receivables (603) (643)` の 603/643、
  //   `Total (926)`、`Other ⟦#PLF⟧ ⟦#WXM⟧ (9)` が伏せられずに出ていた（英文表は負値を括弧で書く）。
  //   見出し番号は **行頭（または「:」直後）にあって、直後が文字** という形をしている。
  //   表の値は行の途中にあり、直後は別の数値・記号・行末になる。ここで切り分ける。
  /^[ \t　]*[(（]\s*\d{1,2}\s*[)）](?=\s*[^\s\d(（)）⟦\-–—~〜△▲])/gm,
  /[:：]\s*[(（]\s*\d{1,2}\s*[)）](?=\s*[^\s\d(（)）⟦\-–—~〜△▲])/g,
  // 文中の項番「(1) 監視、(2) 予防」。**行頭だけでは足りない。**
  // 実測 2026-08-08: 比較資料の引用欄に、日本語原稿に存在しない
  //   「(001) 監視」が出ていた（実物は「(1) 監視」）。証拠として出している引用が
  //   改竤されているのは、誤検出より重い。
  //   伏せると `(3)` と「3段階」が同じ記号になり、復元で取り違える。
  //
  // ⚠️ 括弧付きの数字を無条件に許してはいけない（英文表は負値を括弧で書く）。
  //    `貸倒引当金 (603) (643)` を平文で残してはならない。
  //    項番は**1～2桁**で**直後が語**という形をしている。表の負値は直後が
  //    数値・記号・行末になる。直後の1文字で切り分ける。
  /[(（]\s*\d{1,2}\s*[)）](?=\s*[ぁ-んァ-ヶ一-鿿A-Za-z])/g,

  // 注番号・脚注番号。数値の頭だけを食っても spanCovers が弾く（`注 1,234` の 1,234 は伏せられる）
  // ⚠️ `注記` を忘れないこと。英語の `Note 12` は保護されているのに
  //    日本語の `注記12` が入っておらず、**日英で伏せ方が逆**になっていた。
  //    実測 2026-08-08（素材200p）: EN `Note N` 5件は残るが JA `注記N` 5件は全部伏せられる。
  //    校正モード（REF添付）で日英を突き合わせると当然「一致しない」となる（※29）。
  /注記?\s*\d{1,2}/g,                  // 注1 / 注記12
  /[Nn]ote\s*\d{1,2}/g,
  /No\.\s*\d{1,3}/g,                    // Act No.19 / Guidance No.26
  // 表番号・図番号。**依頼文が「並べて書き出せ」と言っている番号を伏せてはいけない。**
  //    実測 2026-08-08: 構造レンズの手順に
  //      「項番 (1)(2)(3)…、注記番号 Note N、**表番号 Table N**、図番号、脚注記号 *N」
  //    とあるのに、EN 8件・JA 10件とも伏せられていた。gold にも表番号の項目が4件ある
  //    （sl04 / s070 / sl05 / s053）。番号が見えなければこの観点は成立しない。
  //    ⚠️ 直後が桁区切り・小数なら金額なので除く（`表 1,234` は番号ではない）。
  /[Tt]able\s*\d{1,2}(?![\d,.])/g,      // Table 24
  /[Ff]igure\s*\d{1,2}(?![\d,.])/g,     // Figure 3
  /[表図]\s*\d{1,2}(?![\d,.円人件社])/g,   // 衸24 / 図3
  // ページ番号。⚠️ **直前が英字なら別の語の末尾**。実測（実物の短信）で `up 1.2%` の "p 1" を
  //    ページ番号と読んでしまい、1.2 が平文で残った（"Group 5" "top 10" も同じ形）。
  /(?<![A-Za-z])[PpＰ]\s*\.?\s*\d{1,4}\s*[-–—~〜]\s*\d{1,4}/g,  // P.1-25（範囲。単体より先に見る）
  /(?<![A-Za-z])[PpＰ]\s*\.?\s*\d{1,4}/g,         // P.48 / p12
  // 目次のページ番号。**量ではなくページ番号**なので伏せない。
  //
  //   3. Business Summary ....................................................... 10
  //
  // 実測 2026-08-07（東映 p3）: 目次の `143` と本文の `143` に別の記号が付き、
  // 記号の割れ154件のかなりを占めていた。割れていること自体は正しいが
  // （目次の番号と本文の量は別物）、そもそも伏せる対象ではない。
  // 相手側ハイライトでノンブルを拾ったのを直したのと同じ筋である。
  //
  // ⚠️ 当てるのは**点リーダがある行の行末**だけに限る。
  //    「行末の数字」だけで判定すると、表の行末の金額が丸ごと平文で残る。
  //    点が3つ以上続くのは目次の組版に固有である。
  /\.{3,}\s*\d{1,4}\s*$/gm,
  // 行頭の項番「1.」「２、」。⚠️ 直後が数字なら小数（"1.2 billion"）なので項番ではない
  /^\s*\d{1,2}\s*[.．、](?!\d)/gm,
  /※\s*\d{1,2}/g,
  /\*\s*\d{1,2}/g,
  // 英語の序数（期・回を指す）。⚠️ 金額に序数語尾は付かないので、書式で安全に切り分けられる。
  // 実測（2026-08-06・実物の有報 p4）: `156th 157th 158th 159th 160th`（期数）が
  // 金額表のページにあるためスケールが掛かり、他ページの同じ期数と記号が割れていた。
  // ⚠️ 末尾に `\b` を付けてはいけない。抽出テキストは `(The 160thTerm)` のように
  //    語が繋がることがあり、`th` の直後が英字だと語境界にならず当たらない。
  /\d{1,3}(?:st|nd|rd|th)(?!\d)/gi,
  // --- 注記参照の「番号列」（NUMBER_MASKING_SPEC §4.2c 規則1・2） ---
  //
  // ⚠️ 実物の有報167ページで整合性レビューが**送信中止**になった原因がこれ。
  //    伏せ損ね42件のうち41件が同じ型で、注記参照の番号列を**途中で割っていた**。
  //      (Notes 4,5)              → (Notes ⟦#FTS⟧,5)
  //      *2,6                     → ⟦#RVN⟧ *2,6
  //      Finance income 16,17     → Finance income ⟦#JTC⟧,17
  //    上の `Note\s*\d{1,2}` は**単体**しか見ないので、列になると先頭だけ食って
  //    残りが平文で出る。塊は丸ごと残す（注番号は構造番号であり、依頼文が参照する）。
  /(?:[Nn]otes?|注記?)\s*\d{1,2}(?:\s*[,、]\s*\d{1,2})+/g,
  /[*＊※]\s*\d{1,2}(?:\s*[,、]\s*\d{1,2})+/g,
  // 表の注記参照列（`Finance income 16,17 <金額> <金額>` の 16,17）。
  // **カンマの後ろが3桁でない数字の並びは、桁区切りではありえない**（金額の桁区切りは
  // 必ず3桁ずつ）。したがって `16,17` は金額ではなく注記参照である。
  // 前後を `[\d,.]` で塞いでいるので `1,234` `16,178` `12,345,678` には当たらない。
  // 代償は「カンマで並んだ1〜2桁の実データ」だけに限定される（§4.2c 規則2）。
  /(?<![\d,.])\d{1,2}(?:\s*[,、]\s*\d{1,2})+(?![\d,.])/g,
];

const YEAR_RE = /^(?:19|20)\d\d$/;
// 「(25.4～25.6)」のような年月範囲。数値ではなく期間の表記なので丸ごと除外する。
const PERIOD_RANGE_RE = /\(\s*\d{2}\.\d\s*[～~ｰ\-­]\s*\d{2}\.\d\s*\)/g;

function skipSpans(text, allow = DEFAULT_ALLOW) {
  const spans = [];
  for (const m of text.matchAll(PERIOD_RANGE_RE)) spans.push([m.index, m.index + m[0].length]);
  if (allow.years) {
    for (const re of DATE_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
    }
  }
  if (allow.structure) {
    for (const re of STRUCTURE_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}
/**
 * トークン **全体** が許可スパンに収まっているか。
 *
 * ⚠️ 「開始位置がスパン内なら許可」にしてはいけない。許可パターンが数値の頭だけを
 *    食った場合、残りごと平文で通ってしまう。例: 脚注記号として `* 1` を許可していると
 *    `* 1,234` の 1,234 が丸ごと素通りする。全体が収まっているときだけ許可する。
 */
const spanCovers = (spans, start, end) => spans.some(([a, b]) => a <= start && end <= b);

/**
 * 位置 i がすでに数値トークンの途中か。ここから照合を始めると部分マスクになる。
 * ⚠️ カンマは **数字と数字の間** にあるときだけトークン内部。
 *    単に「直前がカンマなら飛ばす」にすると、住所の `AVENUE DES ARTS,35` の 35 が
 *    伏せられずに残る（実測・実物の有報）。
 */
function isInsideToken(src, i) {
  if (i === 0) return false;
  const prev = src[i - 1];
  if (/\d/.test(prev)) return true;
  // 「.」「,」は **数字に挟まれている** ときだけトークン内部。
  // そうしないと `P.48` の 48 や `ARTS,35` の 35 が「途中」と誤認されて伏せられずに残る。
  if ((prev === "." || prev === ",") && i >= 2 && /\d/.test(src[i - 2])) return true;
  return false;
}

// --- 行に効く単位（表の見出しにある「（百万円）」） -----------------------
/**
 * 財務諸表の表は**単位を行や列の見出しに書き、セルは裸の数字**にする。
 *
 *   売上高（百万円） 361,400 388,250 … 458,921
 *   Net sales (Millions of yen) 361,400 388,250 … 458,921
 *
 * 素直に読むと、この 458,921 は「458,921」、本文の `458,921 million yen` は
 * 「458,921×10⁶」で、**同じ金額に別の記号**が付く。
 *
 * ⚠️ 実測（200ページ版・幅25・masked-text の整合性レビュー）: これで
 *    Copilot が「P.6 の売上高と P.22 の売上高が一致しない」と**6件**報告した。
 *    記号しか見えないモデル側では見抜けない型の誤検知で、
 *    §2.3 の `百\n万`・前書きの言語取り違えと同じ系統である。
 *    しかも整合性レビューは**離れた2箇所の突き合わせが仕事**なので、
 *    表と本文が別記号だと仕事そのものが成立しない。
 *
 * そこで、単位が書かれている**同じ行**の裸の数字だけ、その単位を継承する。
 * 行をまたいで効かせてはいけない。同じ表の中に
 * 「従業員数（人）3,214」のような別単位の行が普通にあるためである。
 */
const LINE_UNIT_PATTERNS = [
  // 「100 millions of yen」は 1億円単位。単なる millions として扱うと100分の1になる。
  [/[(（]\s*(?:in\s+)?100\s+millions?\s+of\s+yen\s*[)）]/i, 8],
  [/[(（]\s*(?:in\s+)?trillions?\s+of\s+yen\s*[)）]/i, 12],
  [/[(（]\s*(?:in\s+)?billions?\s+of\s+yen\s*[)）]/i, 9],
  [/[(（]\s*(?:in\s+)?millions?\s+of\s+yen\s*[)）]/i, 6],
  [/[(（]\s*(?:in\s+)?thousands?\s+of\s+(?:yen|shares|units)\s*[)）]/i, 3],
  [/[(（]\s*単位\s*[:：]\s*兆円\s*[)）]/, 12],
  [/[(（]\s*単位\s*[:：]\s*億円\s*[)）]/, 8],
  [/[(（]\s*単位\s*[:：]\s*千台\s*[／/]\s*億円\s*[)）]/, 8],
  [/[(（]\s*単位\s*[:：]\s*百\s*万円\s*[)）]/, 6],
  [/[(（]\s*単位\s*[:：]\s*千(?:円|株|台)\s*[)）]/, 3],
  [/[(（]\s*兆円\s*[)）]/, 12],
  [/[(（]\s*億円\s*[)）]/, 8],
  [/[(（]\s*百\s*万円\s*[)）]/, 6],
  [/[(（]\s*千(?:円|株|台)\s*[)）]/, 3],
  // 決算短信の表頭は括弧なしで「百万円 ％ 百万円 ％」と並ぶ。
  [/^(?=.*百\s*万円)\s*(?:百\s*万円|[%％])(?:\s+(?:百\s*万円|[%％]))+\s*$/i, 6],
  [/^(?=.*millions\s+of\s+yen)\s*(?:millions\s+of\s+yen|[%％])(?:\s+(?:millions\s+of\s+yen|[%％]))+\s*$/i, 6],
  // --- 括弧の無い列見出し（実物の表） ---
  //
  // ⚠️ 実測（2026-08-06・実物の有報 p4）: 5期比較表の単位が括弧なしで、しかも**2行に割れて**いた。
  //      19| Revenue Millions          ← ラベルの後ろに単位が来る形
  //      20| of Yen 297,177 335,138 …
  //      23| Millions                  ← 単位だけの行になる形
  //      24| of Yen 297,177 335,138 …
  //    **同じページに両方の形が混在する。**
  //
  // ⚠️ 見分けるのは**位置ではなく「直後に数字が続くか」**。
  //    最初「行頭に限る」で書いたら 19行目の形が読めず、24行目だけ単位が付いて、
  //    **同じ 297,177 が同一ページ内で割れた**（記号の割れが 34件 → 83件に増えた）。
  //    表の見出しは数字が続く。散文（`amounts are stated in millions of yen.`）は続かない。
  //    複数形に限るのも歯止め。本文の単位語は `255 million yen` のように単数形で数値に付く。
  [/\btrillions\s+of\s+yen\b(?=\s*[\d(（△▲-])/i, 12],
  [/\bbillions\s+of\s+yen\b(?=\s*[\d(（△▲-])/i, 9],
  [/\b100\s+millions?\s+of\s+yen\b(?=\s*[\d(（△▲-])/i, 8],
  [/\bmillions\s+of\s+yen\b(?=\s*[\d(（△▲-])/i, 6],
  [/\bthousands\s+of\s+(?:yen|shares|units)\b(?=\s*[\d(（△▲-])/i, 3],
  // もうひとつの形: **行が単位だけ**（財務諸表本体 p84 / p86）。数字はラベルを挟んだ次の行以降に来るので、
  // 「直後に数字」では拾えない。行に他の語が無いことを条件にすれば散文と区別できる。
  [/^\s*(?:in\s+)?trillions\s+of\s+yen\s*$/i, 12],
  [/^\s*(?:in\s+)?billions\s+of\s+yen\s*$/i, 9],
  [/^\s*(?:in\s+)?millions\s+of\s+yen\s*$/i, 6],
  [/^\s*(?:in\s+)?100\s+millions?\s+of\s+yen\s*$/i, 8],
  [/^\s*(?:in\s+)?thousands\s+of\s+(?:yen|shares|units)\s*$/i, 3],
];
/**
 * その数値が**自分の単位を持っている**なら継承しない。
 * 「Net sales (Millions of yen) 458,921 (up 7.2%)」の 7.2 まで百万倍にすると、
 * 他ページの 7.2% と別記号になり、直そうとしていた幻の不一致を別の形で作ってしまう。
 */
// ⚠️ **行をまたいで見てはいけない。** 先頭の空白を \s で取ると改行を跨ぐ。実物 p110 で踏んだ:
//      Profit for the year used for calculating diluted earnings per   ← ラベルの上半分
//      162,030 170,435                                                 ← データ行が間に入る
//      share (millions of yen)                                         ← ラベルの続き
//    数値の直後が改行＋share なので「この数値は株数だ」と読み、(millions of yen) の
//    継承を止めていた。結果、同じ 170,435 が同じページの他の3箇所と**別の記号**になり、
//    突き合わせが成立しない。単位が数値に付くのは同じ行にあるときだけである。
//    （見出しが行で割れて間にデータ行が挟まるのは、この文書では普通の組版である。
//      lineScaleExponents の注記も同じ現象を扱っている。）
const OWN_UNIT_RE = /^[ 	 ]*(?:%|％|ポイント|points?\b|pt\b|[人名件社株台個本回]|persons?\b|shares?\b|employees\b|units?\b|times\b|years?\b|hours?\b)/i;

/**
 * 各文字位置に効く継承指数（0 なら継承なし）。
 *
 * 単位が**同じ行**にあるとは限らない（NUMBER_MASKING_SPEC §4.2c 規則5）。
 * 実物の有報167ページで数えたところ、単位の置き方は
 *   同じ行に数字もある（行だけで足りる）        : 8
 *   単位だけの行で、数字は次行以降（届かない） : 8
 * と**半々**だった。仕様 §3.5 の「見出しに単位があるのはまれ」はこの文書では成り立たない。
 *
 * ```
 * Name of business segment Amount (Millions of yen) Year-on-year change
 * Pharmaceutical Business 119,870 (30.6)      ← ここに継承が要る
 * ```
 *
 * そこで単位行から**下へ**継承する。ただし散文へ漏らすと、本文の 1,234 が百万倍になって
 * 他ページと別記号になり、§2.3 で6件の幻の不一致を作ったのと同じ壊れ方をする。
 * **打ち切り条件とセットでなければ入れてはいけない。**
 */
/**
 * その行が「表の行」に見えるか。**継承を入れてよい行かどうか**をこれで決める。
 *
 * ⚠️ 「文として終わる長い行なら散文」では足りなかった。実測（フィクスチャ）:
 *      The number of product units shipped in the current consolidated fiscal year was 12,480.
 *    は15語なので「20語以上」の条件に掛からず、台数の 12,480 が百万倍になった。
 *    日本語側は `12,480台` で単位を持つため継承されず、**同じ量に別の記号**が付いて
 *    §2.3 の「幻の不一致」を作る手前まで行った（Test-FixtureTextLayer が止めた）。
 *
 * 表の行は「ラベル＋数値が複数」か「短い」。散文は「語が多くて数値は1つ」。
 * この違いのほうが、文末の句点よりずっと安定している。
 */
function looksLikeTableRow(line) {
  const s = line.trim();
  // 文として終わる行は表の行ではない。**この判定を最初に置く**。
  // 実測（フィクスチャ）: `当連結会計年度の水使用量は512,400立方メートルである。` は
  // 27文字・空白なしなので「短い行」にも当たってしまい、文字数では散文と分けられなかった。
  // 数値が2つある散文（「…は512,400で、前年は498,000であった。」）もあるので、
  // 「数値が複数なら表の行」より**前**に置かないと素通りする。
  if (/[。．.]$/.test(s)) return false;
  const nums = s.match(/\d[\d,，]*(?:\.\d+)?/g) || [];
  if (nums.length >= 2) return true;                  // ラベル＋複数の数値＝表の行
  // ⚠️ 語数だけで測ってはいけない。**日本語の行には空白が無い**ので、
  //    どんなに長い散文でも「1語」になり、短い行として素通りする。実測（フィクスチャ）:
  //      生産拠点の総面積248,500平方メートルには、賃借している土地を含んでいる。
  //    が表の行と見なされ、面積が百万倍になった（英訳側は語数で弾かれるので、
  //    日英で同じ量に別の記号が付く＝§2.3 の幻の不一致の作り方そのもの）。
  // 文字数の上限は言語で変える。英語の表の行はラベルが長い
  // （`Property, plant and equipment 123,456` で37文字）。日本語は空白が無いぶん、
  // 短めで切らないと散文が紛れ込む。
  const cjk = /[ぁ-んァ-ヶ一-龥]/.test(s);
  return s.split(/\s+/).filter(Boolean).length <= 6 && s.length <= (cjk ? 30 : 60);
}

/**
 * 行の見出しに**自分の単位**が書いてある行（`Number of employees (Persons) 3,214`）。
 *
 * ⚠️ OWN_UNIT_RE は数値の**直後**を見るので、単位が数値より前にある表では効かない。
 *    実際、下方向の継承を入れた時点で `（人）` の行が百万倍になり、
 *    同じ 3,214 が売上高と同じ記号になった（Test-NumberMask の実測）。
 *    こういう行は継承の対象から外す。**継承そのものは止めない**（次の行以降は表が続く）。
 */
const LINE_OWN_UNIT_RE = /[(（]\s*(?:%|％|人|名|件|社|株|台|個|本|回|円|倍|ポイント|persons?|employees|shares?|times|units?|points?|yen|numbers?)\s*[)）]/i;

/**
 * 括弧が無い単位列（実物 p4 の5期比較表）。
 *
 *   Basic earnings per share Yen 186.17 200.36 …    ← 1株当たりの円。百万倍してはいけない
 *   Number of employees Persons 4,955 …             ← 人数
 *   Total number of issued shares Shares 307,386,165
 *
 * ⚠️ `of` の直後の `Yen` は除く。`Millions of Yen` の一部なので、これを単位列と見ると
 *    単位見出しの行そのものが継承から外れ、**その表の数字が全部スケール無しになる**。
 *
 * ⚠️ **単位語が行のどこかにあればよい、ではない。** 実物 p5 で踏んだ:
 *
 *   Share capital 21,279 21,279 21,279 21,279 21,279
 *
 *   ラベルの Share が単位の shares と見なされ、Millions of Yen の継承が止まっていた。
 *   その結果、p88 の同じ資本金 21,279 と**別の記号**になる。
 *   単位列はラベルと数値の間にあるのだから、**最初の数値の直前**に限る。
 *   （% は数値の後ろに付くので別扱い。行のどこにあっても率の行とみなす。）
 */
const LINE_OWN_UNIT_BARE_RE = /\b(?<!\bof\s)(?:yen|persons?|employees|shares?|times)\s+(?=[\d(（△▲-])/i;

/**
 * その数値が**角括弧に直接くるまれている**か（`[1,016]` / `〔1,016〕`）。
 *
 * 有価証券報告書では 〔 〕 や [ ] は**補足の数値**（平均臨時雇用人員など）に使う慣行がある。
 * 金額表のページに載っていても金額ではないので、ページの単位を継承させてはいけない。
 *
 * ⚠️ 実測（2026-08-06・実物 p4/p5）: `[1,016] [748] [525] [134] [137]` が臨時従業員数なのに
 *    ページ単位のスケールで百万倍され、他ページの同じ人数と記号が割れていた。
 */
function isBracketed(src, start, end) {
  let a = start - 1;
  while (a >= 0 && /\s/.test(src[a])) a--;
  let b = end;
  while (b < src.length && /\s/.test(src[b])) b++;
  return (src[a] === "[" && src[b] === "]") || (src[a] === "〔" && src[b] === "〕");
}

/**
 * 数値列の先頭にある連番ID（決算参考資料の1..42など）。値と同じnamespaceへ入れると、
 * 行ID 34 と 34千台が同じ記号になり、Copilotに偽の一致根拠を与える。
 * 6行以上連続して+1となる先頭セルだけをIDとみなし、通常の地域別実績値は触らない。
 */
function tableRowInfo(src) {
  const lines = String(src).split("\n");
  const candidates = [];
  let pos = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (!lines[lineIndex].trim() || /^===== PDF P\./.test(lines[lineIndex]) || scaleOf(lines[lineIndex])) {
      candidates.push({ boundary: true });
      pos += lines[lineIndex].length + 1;
      continue;
    }
    const matches = [...lines[lineIndex].matchAll(/\d[\d,，]*(?:\.\d+)?/g)];
    if (matches.length >= 3) {
      const raw = matches[0][0].replace(/[,，]/g, "");
      if (/^\d{1,3}$/.test(raw)) {
        candidates.push({ lineIndex, value: Number(raw), start: pos + matches[0].index,
          numericCount: matches.length, line: lines[lineIndex] });
      }
    }
    pos += lines[lineIndex].length + 1;
  }
  const starts = new Set(), rows = [];
  let run = [];
  const flush = () => {
    if (run.length >= 6) {
      // PDF抽出では行IDだけが前行へ落ちることがあり、同じ表でも開始行が日英でずれる。
      // 終端IDは安定しているため、共有キーは終端IDを正本にする。
      const runKey = `end-${run.at(-1).value}`;
      for (const item of run) {
        starts.add(item.start);
        rows.push({ ...item, runKey, rowKey: `${runKey}:${item.value}` });
      }
    }
    run = [];
  };
  for (const item of candidates) {
    if (item.boundary) { flush(); continue; }
    const prev = run.at(-1);
    if (!prev || (item.value === prev.value + 1 && item.lineIndex - prev.lineIndex <= 6)) run.push(item);
    else { flush(); run.push(item); }
  }
  flush();
  return { starts, rows };
}

const tableRowIdStarts = (src) => tableRowInfo(src).starts;

/**
 * 単位は**ページ（ブロック）ごとの性質**として扱う。
 *
 * ⚠️ 2026-08-06 に「単位行から下へ伝播させ、空行・無数字行で打ち切る」設計を試して**失敗した**。
 *    実物の財務諸表はラベルが複数行に折り返し、単位の書き方もページ内で混在する:
 *      19| Revenue Millions        ← ラベルの後ろに単位
 *      20| of Yen 297,177 …
 *      23| Millions                ← 単位だけの行
 *      24| of Yen 297,177 …
 *    打ち切り条件をどう調整しても、**表の途中で単位が切れて同じ金額が割れる**。
 *    実測（記号の割れ / `Audit-DocumentMask.mjs`）: 打ち切り 2行 → 85件、6行 → 70件、
 *    行頭限定 → 83件。**触るたびに上下するだけで 0 に近づかなかった。**
 *
 * 財務諸表では**スケールは表（＝たいていページ）ごとに一度だけ宣言される**。
 * 一般的な作法もそうなっている（不明なら1、ページ・見出しの文脈から推定する）。
 * そこで伝播をやめ、**ブロック内で一度でも宣言されたらブロック全体に効かせる**。
 * 打ち切り条件が要らなくなるので、表の途中で切れることが原理的に起きない。
 *
 * 行ごとの歯止めは残す（ここは実測で効いている）:
 *   - 自分の単位を見出しに持つ行（`Number of employees (Persons) 3,214`・`(Yen) 97.74`）
 *   - 表の行に見えない行（散文。`… was 12,480.`）
 * 散文の `195,460 million yen` は数値側が単位語を持つので、そもそも継承の対象にならない。
 */
// 単位見出しが行で割れる形。
//
// ⚠️ **隣り合うとは限らない。** 実物 p4 を製品と同じ再構成（座標で視覚的な行を組む）で読むと:
//      14| Revenue Millions                              ← 単位セルの上半分
//      15| 297,177 335,138 426,684 435,081 438,268       ← データ行が**間に入る**
//      16| (including profit from license transfer) of Yen ← 単位セルの下半分
//    2行セルの間にデータ行が挟まるので、隣接を条件にすると永久に繋がらない。
//    スケールはページ（ブロック）ごとの性質なので、**断片がページ内に揃っていれば宣言とみなす**。
const HEADER_TAIL_RE = /\b(trillions?|billions?|millions?|thousands?)\s*$/i;
const HEADER_HEAD_RE = /^\s*of\s+(?:yen|shares|units)\b/i;
const DANGLING_SCALE = [["trillion", 12], ["billion", 9], ["million", 6], ["thousand", 3]];

const recognizedScaleOf = (text) => {
  for (const [re, e] of LINE_UNIT_PATTERNS) { re.lastIndex = 0; if (re.test(text)) return e; }
  return 0;
};

/**
 * 1つの表に複数の単位が宣言される場合の、単位系ごとのスケール。
 *
 * 決算短信のサマリー表には、たとえば
 *
 *   (In 100 millions of yen)
 *   (In thousands of units)
 *
 * が同居する。従来の `scaleOf` は先に見つけた億円だけをページ全体へ
 * 適用していたため、`Global sales volume ... 304` が 304千台ではなく
 * 304億円としてマスクされ、別ページの `304 thousand units` と記号が割れた。
 * 宣言と認める厳しさは `scaleOf` に任せ、認められた行の中だけを単位系別に分解する。
 */
function scaleDeclarations(text) {
  const recognized = recognizedScaleOf(text);
  if (!recognized) return [];
  const found = [];
  const add = (family, exp) => {
    if (!found.some(x => x.family === family && x.exp === exp)) found.push({ family, exp });
  };

  const en = /\b(100\s+millions?|trillions?|billions?|millions?|thousands?)\s+of\s+(yen|shares|units)\b/gi;
  for (const m of text.matchAll(en)) {
    const scale = m[1].toLowerCase().replace(/s$/, "");
    const unit = m[2].toLowerCase();
    const exp = scale.startsWith("100 million") ? 8
      : ({ trillion: 12, billion: 9, million: 6, thousand: 3 }[scale] || 0);
    add(unit === "yen" ? "money" : unit, exp);
  }

  if (/兆円/.test(text)) add("money", 12);
  if (/億円/.test(text)) add("money", 8);
  if (/百\s*万円/.test(text)) add("money", 6);
  if (/千円/.test(text)) add("money", 3);
  if (/千株/.test(text)) add("shares", 3);
  if (/千台/.test(text)) add("units", 3);

  // 新しい表記を scaleOf が認識しても、単位系をまだ分類できない場合は
  // 従来どおりページの既定スケールとして使う。
  if (!found.length) add("generic", recognized);
  return found;
}

// 単位宣言の解析結果を正本とし、従来の単一指数APIはその先頭値として提供する。
const scaleOf = (text) => scaleDeclarations(text)[0]?.exp || 0;

const SCALE_FAMILY_PATTERNS = [
  {
    family: "units", confidence: "strong", reason: "vehicle-volume-label",
    re: /\b(?:global|domestic|overseas|retail|wholesale|sales|production)\s+(?:sales\s+)?volume\b|\b(?:vehicle|unit)\s+sales\b|\b(?:deliveries|shipments|vehicles\s+sold|retail\s+sales)\b|(?:売上|販売|生産|出荷|卸売|小売|世界|グローバル).*(?:台数|数量)|(?:台数|数量).*(?:売上|販売|生産|出荷|卸売|小売)/i,
  },
  {
    family: "shares", confidence: "strong", reason: "share-count-label",
    re: /\b(?:number|total number)\s+of\s+(?:issued\s+)?shares\b|\bshares\s+(?:issued|outstanding)\b|発行済.*株式|株式数/i,
  },
  {
    family: "count", confidence: "strong", reason: "non-monetary-count-label",
    re: /\b(?:number\s+of\s+employees|employees|headcount|persons?|patents?)\b|従業員数|人員数|件数|社数|特許/i,
  },
  {
    family: "rate", confidence: "strong", reason: "exchange-rate-label",
    re: /\b(?:exchange|average)\s+rates?\b|為替レート|(?:米|US|ＵＳ)ドル|ユーロ/i,
  },
  {
    family: "money", confidence: "strong", reason: "monetary-label",
    re: /\b(?:net sales|revenue|operating income|ordinary income|income before|net income|profit|assets|liabilities|debt|cash flow|capital expenditures?|depreciation|r&d cost|shareholders?'? equity|stockholders?'? equity|equity|fixed costs?|raw materials?|logistics costs?|growth investment|cost improvements?)\b|売上(?!台数)|収益|利益|資産|負債|有利子負債|株主資本|自己資本|キャッシュ.?フロー|設備投資|減価償却|研究開発|固定費|原材料|物流費|成長投資|コスト改善/i,
  },
];

function classifyScaleFamily(line) {
  const text = String(line || "");
  for (const rule of SCALE_FAMILY_PATTERNS) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) return { family: rule.family, confidence: rule.confidence, reason: rule.reason };
  }
  return { family: "", confidence: "none", reason: "unclassified" };
}

const scaleFamilyForLine = (line) => classifyScaleFamily(line).family;

function declarationForLine(declarations, family, lineIndex) {
  const exact = declarations.filter(x => x.family === family);
  const matching = exact.length ? exact : declarations.filter(x => x.family === "generic");
  if (!matching.length) return null;
  const before = matching.filter(x => x.lineIndex <= lineIndex);
  return before.at(-1) || null;
}

function collectRowFamilyEvidence(src) {
  const info = tableRowInfo(src);
  const evidence = new Map();
  const lines = String(src).split("\n");
  // Some Japanese PDFs encode a vertical table heading as one horizontal glyph
  // per line and place that block after the table in content order.  Keep it as
  // an uncertain layout block, but use the app-owned block boundary to recover
  // the row family's unit semantics without joining it into the table text.
  const layoutMarks=appLayoutBlockMarks(src);
  const verticalHints=[];
  for(let index=0;index<layoutMarks.length;index++)if(layoutMarks[index].role==="ORDER-UNCERTAIN"){
    const start=String(src).indexOf("\n",layoutMarks[index].index)+1;
    const end=index+1<layoutMarks.length?layoutMarks[index+1].index:String(src).length;
    verticalHints.push(String(src).slice(start,end).replace(/\s+/g,""));
  }
  const hasVerticalShipmentHint=verticalHints.some(text=>/(?:連結)?(?:出荷|販売|生産)台数/.test(text));
  const hasVerticalSalesHint=verticalHints.some(text=>/売上高/.test(text));
  const rowFamily = row => {
    const direct = classifyScaleFamily(row.line).family;
    if (direct) return direct;
    if (row.value >= 29 && hasVerticalShipmentHint) return "units";
    if (row.value <= 3 && hasVerticalSalesHint) return "money";
    const context = lines.slice(Math.max(0, row.lineIndex - 8), row.lineIndex + 1).join(" ");
    // PDF.jsで縦見出しが1文字ずつ別行になった実抽出形。
    if (row.value >= 29 && /連.*結.*出.*荷.*台.*数/.test(context)) return "units";
    if (row.value <= 3 && /売\s*国.*上.*海\s*外.*高.*計/.test(context)) return "money";
    return "";
  };
  const signature = scaleDeclarations(String(src)).map(x => `${x.family}:${x.exp}`).sort().join("|");
  const sharedKey = value => signature ? `sig:${signature}:id:${value}` : "";
  const byRun = new Map();
  for (const row of info.rows) {
    if (!byRun.has(row.runKey)) byRun.set(row.runKey, []);
    byRun.get(row.runKey).push(row);
  }
  for (const rows of byRun.values()) {
    const anchors = rows.map(row => ({ row, family: rowFamily(row) })).filter(x => x.family);
    for (const row of rows) {
      const direct = rowFamily(row);
      if (direct) {
        const value = { family: direct, source: "row-label" };
        evidence.set(row.rowKey, value);
        if (sharedKey(row.value)) evidence.set(sharedKey(row.value), value);
        continue;
      }
      const compatible = anchors.filter(x => x.row.numericCount === row.numericCount);
      if (!compatible.length) continue;
      const distance = Math.min(...compatible.map(x => Math.abs(x.row.value - row.value)));
      if (distance > 10) continue;
      const nearestFamilies = new Set(compatible.filter(x => Math.abs(x.row.value - row.value) === distance).map(x => x.family));
      if (nearestFamilies.size === 1) {
        const value = { family: [...nearestFamilies][0], source: "row-cluster" };
        evidence.set(row.rowKey, value);
        if (sharedKey(row.value)) evidence.set(sharedKey(row.value), value);
      }
    }
  }
  return evidence;
}

function isPureNumericMatrixLine(line) {
  const values = String(line).match(/[-+＋△▲]?\s*\(?\s*\d[\d,，.]*\s*[%％]?\s*\)?/g) || [];
  if (!values.length) return false;
  const residue = String(line)
    .replace(/[-+＋△▲]?\s*\(?\s*\d[\d,，.]*\s*[%％]?\s*\)?/g, "")
    .replace(/[\s|｜/／,，.．:：;；\[\]（）()－—–]/g, "");
  return !residue;
}

function isGeographicTableRow(line) {
  return /^\s*(?:Japan|North\s+America|Europe|China|USA|Other(?:\s+areas)?|Domestic|Overseas|Total|日\s*本|北\s*米|欧\s*州|中\s*国|そ\s*の\s*他|国\s*内|海\s*外|計|合\s*計)(?=\s|[-+＋△▲(]|\d|$)/i.test(String(line));
}

function hasNearbyUnitsSectionAnchor(lines, index) {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 6); cursor--) {
    const line = String(lines[cursor] || "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/^===== (?:PDF P\.|APP LAYOUT BLOCK)/.test(line)) return false;
    if (/(?:global\s+sales|sales|production)\s+volume|(?:グローバル)?販売台数|生産台数|出荷台数/i.test(line)) return true;
    // A nearer semantic heading starts a new section.  Do not let a volume
    // anchor leak through `Net sales`, share/count/rate headings, or another
    // explicit unit declaration into a later geographic table.
    const family = classifyScaleFamily(line).family;
    if (family && family !== "units") return false;
    if (scaleOf(line)) return false;
  }
  return false;
}

function inferNumericRegionFamilies(lines) {
  const result = new Map();
  let region = [];
  const flush = () => {
    const anchors = region.map(item => ({ ...item, family: classifyScaleFamily(item.line).family })).filter(x => x.family);
    const pureRows = region.filter(item => isPureNumericMatrixLine(item.line));
    for (const item of region) {
      if (classifyScaleFamily(item.line).family) continue;
      // Region inference is only safe for a detached value matrix.  A labelled
      // row such as `Temperature 300 400` is an independent semantic row, even
      // when its numeric column count happens to match a nearby money row.
      if (!isPureNumericMatrixLine(item.line)) continue;
      if (pureRows.filter(row => row.numericCount === item.numericCount).length < 3) continue;
      const compatible = anchors.filter(x => x.index < item.index && x.numericCount === item.numericCount);
      if (compatible.length < 3) continue;
      const families = new Set(compatible.map(x => x.family));
      if (families.size === 1) result.set(item.index, [...families][0]);
    }
    region = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const numericCount = (line.match(/\d[\d,，]*(?:\.\d+)?/g) || []).length;
    if (!numericCount || /^===== PDF P\./.test(line) || scaleOf(line)) { flush(); continue; }
    region.push({ index, line, numericCount });
  }
  flush();
  return result;
}

function lineScaleContext(src, sharedRowFamilyEvidence = null) {
  const exps = new Int8Array(src.length);
  const lines = src.split("\n");
  const lineStarts = [];
  let charPos = 0;
  for (const line of lines) { lineStarts.push(charPos); charPos += line.length + 1; }
  const blockDeclarations = []; // 各行が属するブロックの単位系別スケール
  const rowInfo = tableRowInfo(src);
  const rowByLine = new Map(rowInfo.rows.map(row => [row.lineIndex, row]));
  const localRowEvidence = collectRowFamilyEvidence(src);
  const numericRegionFamilies = inferNumericRegionFamilies(lines);

  // 1回目: 宣言を位置付きで集める。同じfamily・異指数を捨てない。
  let start = 0, declarations = [];
  let danglingScales = [], danglingUnits = [];
  const addDeclarations = (items, lineIndex) => {
    for (const item of items) {
      if (!declarations.some(x => x.family === item.family && x.exp === item.exp && x.lineIndex === lineIndex)) {
        declarations.push({ ...item, lineIndex, evidence: item.evidence || "declaration" });
      }
    }
  };
  const settle = () => {
    const usedUnits = new Set();
    for (const scale of danglingScales) {
      const candidates = danglingUnits.filter(x => !usedUnits.has(x) && Math.abs(x.lineIndex - scale.lineIndex) <= 12
        && (!scale.familyHint || x.family === scale.familyHint));
      if (!scale.familyHint && new Set(candidates.map(x => x.family)).size > 1) continue;
      const unit = candidates.sort((a, b) => Math.abs(a.lineIndex - scale.lineIndex) - Math.abs(b.lineIndex - scale.lineIndex))[0];
      if (!unit) continue;
      usedUnits.add(unit);
      addDeclarations([{ family: unit.family, exp: scale.exp, evidence: "split-declaration" }], Math.min(scale.lineIndex, unit.lineIndex));
    }
    declarations.sort((a, b) => a.lineIndex - b.lineIndex);
  };
  const flush = (end) => {
    settle();
    for (let i = start; i < end; i++) blockDeclarations[i] = declarations;
  };
  for (let idx = 0; idx < lines.length; idx++) {
    if (/^===== (?:PDF P\.\d+|APP LAYOUT BLOCK) \//.test(lines[idx])) {
      flush(idx); start = idx; declarations = []; danglingScales = []; danglingUnits = []; continue;
    }
    const line = lines[idx];
    let own = scaleDeclarations(line);
    if (!own.length && idx + 1 < lines.length && HEADER_TAIL_RE.test(line) && HEADER_HEAD_RE.test(lines[idx + 1])) {
      own = scaleDeclarations(line + " " + lines[idx + 1]);
    }
    addDeclarations(own, idx);
    const tail = HEADER_TAIL_RE.exec(line);
    if (tail) {
      const word = tail[1].toLowerCase().replace(/s$/, "");
      const exp = (DANGLING_SCALE.find(([x]) => x === word) || [null, 0])[1];
      const familyHint = classifyScaleFamily(line).family
        || (/\bproduction\b|生産/i.test(line) ? "units" : "");
      if (exp) danglingScales.push({ exp, lineIndex: idx, familyHint });
    }
    for (const match of line.matchAll(/\bof\s+(yen|shares|units)\b/gi)) {
      const unit = match[1].toLowerCase();
      danglingUnits.push({ family: unit === "yen" ? "money" : unit, lineIndex: idx });
    }
  }
  flush(lines.length);

  // 2回目: 状態は連続した表領域内だけで継承する。空行・散文・短い別見出しで切る。
  const lineMeta = [];
  let pos = 0, activeBlockDeclarations = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const pageBoundary = /^===== (?:PDF P\.\d+|APP LAYOUT BLOCK) \//.test(line);
    const declarations = blockDeclarations[idx] || [];
    activeBlockDeclarations = declarations;
    const declares = !!scaleOf(line);
    const ownClass = classifyScaleFamily(line);
    const numericCount = (line.match(/\d[\d,，]*(?:\.\d+)?/g) || []).length;
    const prose = /[。．.]$/.test(trimmed);
    const isHeaderTail = idx > 0 && HEADER_TAIL_RE.test(lines[idx - 1]) && HEADER_HEAD_RE.test(line);
    const row = rowByLine.get(idx);
    const declarationSignature = [...new Set(declarations.map(x => `${x.family}:${x.exp}`))].sort().join("|");
    const signatureKey = row && declarationSignature ? `sig:${declarationSignature}:id:${row.value}` : "";
    const rowEvidence = row && (sharedRowFamilyEvidence?.get(row.rowKey)
      || (signatureKey && sharedRowFamilyEvidence?.get(signatureKey))
      || localRowEvidence.get(row.rowKey) || (signatureKey && localRowEvidence.get(signatureKey)));
    const regionFamily = numericRegionFamilies.get(idx) || "";
    const currentFamilies = new Set(declarations.filter(x => x.lineIndex === idx).map(x => x.family).filter(Boolean));
    let family = ownClass.family || regionFamily;
    let familySource = ownClass.family ? "label" : regionFamily ? "table-region" : "";
    if (!family && currentFamilies.size === 1) {
      family = [...currentFamilies][0];
      familySource = "label";
    } else if (!family) {
      const precedingFamilies = new Set(declarations.filter(x => x.lineIndex <= idx).map(x => x.family));
      if (precedingFamilies.size === 1) { family = [...precedingFamilies][0] || ""; familySource = "fallback"; }
      else if (rowEvidence?.family) { family = rowEvidence.family; familySource = rowEvidence.source; }
      else if ((isGeographicTableRow(line) && hasNearbyUnitsSectionAnchor(lines, idx))
          || (isPureNumericMatrixLine(line) && idx > 0
            && /(?:thousand|million|billion)s?|千台|百万円|億円/i.test(lines[idx - 1])
            && (classifyScaleFamily(lines[idx - 1]).family || /\b(?:production|sales)\b/i.test(lines[idx - 1])))) {
        const preceding = declarations.filter(x => x.lineIndex <= idx);
        const latestLine = preceding.length ? Math.max(...preceding.map(x => x.lineIndex)) : -1;
        const latestFamilies = new Set(preceding.filter(x => x.lineIndex === latestLine).map(x => x.family));
        if (latestFamilies.size === 1) { family = [...latestFamilies][0] || ""; familySource = "fallback"; }
      }
    }
    // familyが明確なのに対応宣言が無ければ、異種単位へフォールバックしない。
    const selected = family ? declarationForLine(declarations, family, idx) : null;
    const exp = selected?.exp || 0;
    // その行が単位見出しの一部か（`Millions` / `of Yen 297,177 …` の下側もここに入る）。
    // 見出しの一部なら、そこに出てくる `Yen` を「自分の単位」と読んではいけない。
    // ⚠️ 前の行と単純に繋いで判定してはいけない。それだと
    //      Net sales (Millions of yen) 3,214
    //      Number of employees (Persons) 3,214
    //    の2行目まで「見出しの一部」になり、**（人）の行が百万倍になる**（実測で踏んだ）。
    //    見出しが割れる形（前の行がスケール語で終わり、この行が `of yen` で始まる）だけを見る。
    const partOfHeader = declares || isHeaderTail;
    // ⚠️ 「単位語が前の行のラベル側にある」ケース（実物 p4 の `[1,016] [1,024] …` は
    //    直前の行に `temporary employees` がある）に合わせて前の行も見る案を試したが、
    //    記号の割れは 35件 → 36件で改善しなかったので入れていない。
    //    金額の行まで巻き添えで抑止してしまうためと思われる。
    const ownUnit = !partOfHeader && (LINE_OWN_UNIT_RE.test(line) || LINE_OWN_UNIT_BARE_RE.test(line));
    // ⚠️ 単位を**自分の行で宣言している**行は、表の行らしさを問わずに適用する。
    //    実測（フィクスチャ p157）: `Buildings and structures (Millions of yen) 12,300` は
    //    数値が1つで語数7なので `looksLikeTableRow` に落ち、**単位が書いてあるのに効かなかった**。
    //    その結果 p6 の同じ 12,300 と記号が割れた。
    if (exp && (declares || isHeaderTail || (looksLikeTableRow(line) && !ownUnit))) {
      exps.fill(exp, pos, pos + line.length);
    }
    lineMeta[idx] = {
      exp: exps[pos] || 0,
      family,
      source: selected ? (familySource || "fallback") : "none",
      candidates: [...new Set(declarations.filter(x => x.family === family || x.family === "generic")
        .filter(x => x.lineIndex <= idx).map(x => x.exp).filter(Boolean))],
    };
    pos += line.length + 1;
  }
  const at = (position) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid] <= position) lo = mid; else hi = mid - 1;
    }
    return lineMeta[lo] || { exp: 0, family: "", source: "none", candidates: [] };
  };
  return { exps, at };
}

/**
 * 表頭の % / Yen はセルの前行に置かれる。小数セルだけは列固有単位とみなし、
 * ページ既定の「百万円 / millions of yen」を継承させない。
 */
function decimalHasNearbyOwnUnitHeader(src, start, raw, rowIds = null) {
  const isDecimal = String(raw).includes(".");
  const lineStart = src.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = src.indexOf("\n", start);
  const lineEnd = nextNewline >= 0 ? nextNewline : src.length;
  const currentLine = src.slice(lineStart, lineEnd);
  const numericCells = [...currentLine.matchAll(/\(?[△▲+−-]?\d[\d,，]*(?:\.\d+)?\)?/g)];
  const numericCellCount = numericCells.length;
  const relativeStart = start - lineStart;
  const cellIndex = numericCells.findIndex(m => relativeStart >= m.index && relativeStart < m.index + m[0].length);
  const ratioLabelOnLine = /\b(?:margin|rate|ratio|return on sales)\b|利益率|増減率/i.test(currentLine);
  let cursor = Math.max(0, lineStart - 1);
  const previous = [];
  for (let i = 0; i < 4 && cursor >= 0; i++) {
    const prevStart = src.lastIndexOf("\n", cursor - 1) + 1;
    const line = src.slice(prevStart, cursor + 1).trim();
    if (/^===== PDF P\./.test(line)) break;
    if (!line || scaleOf(line)) break;
    previous.unshift(line);
    if (prevStart === 0) break;
    cursor = prevStart - 1;
  }
  const previousText = previous.join(" ");
  if (isDecimal && /円\s*銭/i.test(previousText)) return true;
  if (isDecimal && /\byen\b/i.test(previousText) && !/(?:trillions?|billions?|millions?|thousands?)\s+of\s+yen/i.test(previousText)) return true;
  if (/[%％]/.test(previousText) && (numericCellCount >= 2 || ratioLabelOnLine)) {
    if (isDecimal) return true;
  }
  if (!isDecimal && /\brate\s*\(\s*%\s*\)|増減率/i.test(previousText)
      && cellIndex === numericCellCount - 1) return true;

  // 比率列の見出しは、値のすぐ上にあるとは限らない。実物の決算参考資料では
  // 見出し「% % % %」の40行以上あとまで同じ列が続き、通常の短信でも
  // Rate (%) から Other / Total / USA まで5行以上離れる。この距離で打ち切ると、
  // 英文の括弧表記 (14.0) だけがページ既定の「千台」「億円」を継承する一方、
  // 日本語の △14.0% は % を自分で持つため継承せず、同じ比率に別記号が付く。
  //
  // 現在のPDFブロック内に明示的な比率列見出しがある場合、単位語を直後に持たない
  // 小数は比率/EPS等の列固有値として扱う。金額の小数は通常、billion/million等を
  // 数値の直後に明示するため、そちらは tokenizeEn の word 判定が先に処理する。
  let scanCursor = Math.max(0, lineStart - 1), hasRatioHeader = false, namedRatioHeader = false;
  while (scanCursor >= 0) {
    const prevStart = src.lastIndexOf("\n", scanCursor - 1) + 1;
    const line = src.slice(prevStart, scanCursor + 1).trim();
    if (/^===== PDF P\./.test(line) || !line) break;
    const named = /\brate\s*\(\s*%\s*\)|return\s+on\s+sales|増減率/i.test(line);
    if (named || /(?:^|\s)[%％](?:\s|$)/.test(line)) hasRatioHeader = true;
    if (named) namedRatioHeader = true;
    if (hasRatioHeader || scaleOf(line)) break;
    if (prevStart === 0) break;
    scanCursor = prevStart - 1;
  }
  if (!hasRatioHeader || !(numericCellCount >= 2 || ratioLabelOnLine)) return false;
  if (isDecimal) return true;
  // `Volume Rate (%)` / `増減率` のように列名が明示された単一率列だけ末尾セルを採る。
  // 単なる `%` 見出しでは、率セルが `-` の行の末尾金額を率と誤認するため推測しない。
  return namedRatioHeader && cellIndex === numericCellCount - 1;
}

function resolveEvidenceExponent(raw, defaultExp, candidates, evidenceAmounts, family, source) {
  const familyEvidence = evidenceAmounts?.get?.(family);
  if (!familyEvidence?.size || !candidates?.length || source === "label" || source === "table-region"
      || source === "row-label" || source === "row-cluster") return { exp: defaultExp, source: "" };
  const base = toMicro(raw);
  const matched = [...new Set(candidates)]
    .filter(exp => familyEvidence.has((shift(base, exp) < 0n ? -shift(base, exp) : shift(base, exp)).toString()));
  return matched.length === 1 ? { exp: matched[0], source: "evidence" } : { exp: defaultExp, source: "" };
}

function mergeEvidenceAmounts(...sources) {
  const merged=new Map();
  for(const source of sources)for(const [family,amounts] of source||[]){
    if(!merged.has(family))merged.set(family,new Set());
    for(const amount of amounts||[])merged.get(family).add(amount);
  }
  return merged;
}

function appLayoutBlockMarks(src) {
  return [...String(src).matchAll(/^===== APP LAYOUT BLOCK \/ ([A-Z-]+) =====$/gm)]
    .map(match=>({index:match.index,role:match[1]}));
}

function appLayoutRoleAt(marks, offset) {
  for(let i=marks.length-1;i>=0;i--)if(marks[i].index<offset)return marks[i].role;
  return "";
}

function explicitFamily(src, start, tokenEnd, scaleMeta) {
  const nearby = src.slice(Math.max(0, start - 4), Math.min(src.length, tokenEnd + 32));
  if (/\b(?:units?|vehicles?)\b|台/i.test(nearby)) return "units";
  if (/\bshares?\b|株/i.test(nearby)) return "shares";
  if (/[¥$€£]|\b(?:yen|dollars?|euros?)\b|円/i.test(nearby)) return "money";
  return scaleMeta?.family || "";
}

// --- 符号 ---------------------------------------------------------------
// 実測の教訓（README）: 「数値の前の ( や - は負号」と単純化すると符号が一斉に逆になる。
//   - 括弧は **開いて閉じている** ときだけ負号
//   - ハイフン類（- ­ —）は負号として扱わない。ダッシュ・「該当なし」と区別がつかない
const JA_SIGN_RE = /[△▲]/;

/**
 * 日本語の数値トークン。複合数詞（1兆2,857億円）を **1つの値** として読む。
 * これを割ると `¥1,285.7 billion` と合わなくなる（実測で踏んだ）。
 */
export function tokenizeJa(text, allow = DEFAULT_ALLOW, evidenceAmounts = null, rowFamilyEvidence = null, localEvidenceAmounts = null) {
  const src = String(text);
  const layoutMarks=appLayoutBlockMarks(src);
  const skip = skipSpans(src, allow);
  const scaleContext = lineScaleContext(src, rowFamilyEvidence);
  const lineExp = scaleContext.exps;
  const rowIds = tableRowIdStarts(src);
  const out = [];
  const sc = JA_SCALES.map(([w]) => spacedScale(w));   // 兆 億 百\s*万 万 千
  const compound = new RegExp(
    `(?:(${NUM_SRC})\\s*${sc[0]})?\\s*(?:(${NUM_SRC})\\s*${sc[1]})?\\s*(?:(${NUM_SRC})\\s*${sc[2]})?` +
    `\\s*(?:(${NUM_SRC})\\s*${sc[3]})?\\s*(?:(${NUM_SRC})\\s*${sc[4]})?\\s*(${NUM_SRC})?`, "y");
  let i = 0;
  while (i < src.length) {
    if (!/\d/.test(src[i])) { i++; continue; }
    // 直前が数字・カンマ・小数点なら、トークンの途中。ここから始めてはいけない（部分マスクの元）。
    if (isInsideToken(src, i)) { i++; continue; }
    compound.lastIndex = i;
    const m = compound.exec(src);
    if (!m || m[0] === "") { i++; continue; }
    const end = i + m[0].replace(/\s+$/, "").length;
    if (spanCovers(skip, i, end)) { i = end; continue; }
    let micro = 0n, quantum = 0n, any = false;
    const exps = [12, 8, 6, 4, 3];
    for (let k = 0; k < 5; k++) if (m[k + 1]) {
      micro += shift(toMicro(m[k + 1]), exps[k]);
      quantum = quantumMicro(m[k + 1], exps[k]);
      any = true;
    }
    if (m[6]) { micro += toMicro(m[6]); quantum = quantumMicro(m[6], 0); any = true; }
    if (!any) { i++; continue; }
    // 単位語が付いていない数字は、同じ行の見出しにある単位（（百万円）等）を継承する。
    // ただし自分の単位（%・人・件…）を持っているものは継承しない。
    const bareJa = !m[1] && !m[2] && !m[3] && !m[4] && !m[5];
    const rowId = bareJa && rowIds.has(i);
    const scaleMeta = scaleContext.at(i);
    let inherited = bareJa && !rowId && !OWN_UNIT_RE.test(src.slice(end, end + 12))
      && !decimalHasNearbyOwnUnitHeader(src, i, m[6] || "", rowIds)
      && !isBracketed(src, i, end) ? lineExp[i] : 0;
    let resolvedFamily = scaleMeta.family;
    let evidence = bareJa && inherited
      ? resolveEvidenceExponent(m[6] || "", inherited, scaleMeta.candidates, evidenceAmounts,
        scaleMeta.family, scaleMeta.source)
      : { exp: inherited, source: "" };
    const layoutRole=appLayoutRoleAt(layoutMarks,i);
    // Never infer a unit from numeric equality alone.  Untyped table cells need
    // a line label, a row-family proof, or an app-validated APP_TABLE_CONTEXT.
    inherited = evidence.exp;
    if (inherited) { micro = shift(micro, inherited); quantum = shift(quantum, inherited); }
    // 符号は数値の直前にある △▲ を見る（範囲には含めない。符号は平文で残すため）
    const before = src.slice(Math.max(0, i - 2), i);
    const sm = before.match(JA_SIGN_RE);
    // 単位を継承したものは金額であって西暦ではない（bare 扱いを外す）
    const only = !m[1] && !m[2] && !m[3] && !m[4] && !m[5] && m[6] && !inherited;
    if (keep(src.slice(i, end), micro, only, allow)) { i = end; continue; }
    out.push({ start: i, end, micro, quantum, sign: sm ? sm[0] : "", raw: src.slice(i, end),
      chosenExp: bareJa ? inherited : null,
      family: bareJa ? resolvedFamily : explicitFamily(src, i, end, scaleMeta),
      source: rowId ? "row-id" : bareJa ? (evidence.source || scaleMeta.source || "bare") : "explicit",
      explicitScale: !bareJa, unambiguousScale: bareJa && !!inherited && new Set(scaleMeta.candidates).size === 1,
      namespace: rowId ? "row-id" : "amount", layoutRole });
    i = end;
  }
  return out;
}

/** 英語の数値トークン。`( 1,234 ) billion` のように閉じ括弧を挟んでもスケール語を拾う。 */
export function tokenizeEn(text, allow = DEFAULT_ALLOW, evidenceAmounts = null, rowFamilyEvidence = null, localEvidenceAmounts = null) {
  const src = String(text);
  const layoutMarks=appLayoutBlockMarks(src);
  const skip = skipSpans(src, allow);
  const scaleContext = lineScaleContext(src, rowFamilyEvidence);
  const lineExp = scaleContext.exps;
  const rowIds = tableRowIdStarts(src);
  // ⚠️ `k`（千）は**数字に直に付く**ので別に見る（`10k yen`）。
  //    衝突を避けるため条件を厳しくする:
  //      直後が英字なら別の語（`10km` `10kg` `10kW`）なので取らない。
  //      直前がハイフンなら書式名（米国の `Form 10-K`）なので取らない。
  const scaleAlt = EN_SCALES.map(([w]) => w + "s?").join("|");
  // 空白は無くてもよい（`100oku`）。`gi` なので大文小文字は問わない。
  const re = new RegExp(`(${NUM_SRC})\\s*\\)?\\s*(${scaleAlt}|k(?![A-Za-z]))?`, "giy");
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (!/\d/.test(src[i])) { i++; continue; }
    if (isInsideToken(src, i)) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { i++; continue; }
    if (spanCovers(skip, i, i + m[1].length)) { i += m[1].length; continue; }
    const word = (m[2] || "").toLowerCase().replace(/s$/, "");
    // 単位語が付いていない数字は、同じ行の見出しにある単位（(Millions of yen) 等）を継承する。
    // ただし自分の単位（% / persons / shares …）を持っているものは継承しない。
    const scaleMeta = scaleContext.at(i);
    const rowId = !word && rowIds.has(i);
    let inherited = word || rowId || OWN_UNIT_RE.test(src.slice(i + m[1].length, i + m[1].length + 12))
      || decimalHasNearbyOwnUnitHeader(src, i, m[1], rowIds)
      || isBracketed(src, i, i + m[1].length)
      ? 0 : lineExp[i];
    let resolvedFamily = scaleMeta.family;
    let evidence = !word && inherited
      ? resolveEvidenceExponent(m[1], inherited, scaleMeta.candidates, evidenceAmounts,
        scaleMeta.family, scaleMeta.source)
      : { exp: inherited, source: "" };
    const layoutRole=appLayoutRoleAt(layoutMarks,i);
    // Numeric equality is not structural evidence.  Keep an untyped table cell
    // at exponent zero unless a verified label/context establishes its family.
    inherited = evidence.exp;
    // `k` は EN_SCALES に入れていない（`s?` を付けると `ks` まで拾ってしまう）。ここで数える。
    const exp = word === "k" ? 3 : (word ? (EN_SCALES.find(([w]) => w === word) || [null, 0])[1] : inherited);
    const micro = shift(toMicro(m[1]), exp);
    const quantum = quantumMicro(m[1], exp);
    // ⚠️ 伏せる範囲は **数字そのものだけ**。スケール語や閉じ括弧まで飲み込むと
    //    `(9.8) billion yen` が `(⟦#X⟧ yen` になり、括弧が壊れる。
    //    スケール語は実量の計算にだけ使い、本文には平文で残す
    //    （桁の大きさは分かるが、値は分からない。値が分かることとは危険度が違う）。
    const end = i + m[1].length;
    // 「( 1,234 )」の開き括弧が直前にあり、範囲内に閉じ括弧があるときだけ負号
    const openIdx = src.lastIndexOf("(", i);
    const closeIdx = src.indexOf(")", i + m[1].length);
    const between = closeIdx >= 0 ? src.slice(i + m[1].length, closeIdx) : null;
    const sign = (openIdx >= 0 && !src.slice(openIdx + 1, i).trim() &&
                  between !== null && !between.trim()) ? "(" : "";
    if (keep(src.slice(i, end), micro, !word && !inherited, allow)) { i = end; continue; }
    out.push({ start: i, end, micro, quantum, sign, raw: src.slice(i, end), chosenExp: exp,
      family: word ? explicitFamily(src, i, re.lastIndex, scaleMeta) : resolvedFamily,
      source: rowId ? "row-id" : word ? "explicit" : (evidence.source || scaleMeta.source || "bare"),
      explicitScale: !!word, unambiguousScale: !word && !!inherited && new Set(scaleMeta.candidates).size === 1,
      namespace: rowId ? "row-id" : "amount", layoutRole });
    i = end;
  }
  return out;
}

/** 許可リストに当たるか（true なら伏せない） */
function keep(raw, micro, bare, allow) {
  const plain = raw.replace(/[,，\s]/g, "");
  if (allow.years && bare && !/[,，\s]/.test(raw) && YEAR_RE.test(plain)) return true;
  // ⚠️ **桁区切りの無い4桁は、単位を継承していても西暦として残す。**
  //    実測（2026-08-06・実物の有報 p4）: 主要な経営指標のページは
  //      Year end March / 2021 2022 2023 2024 2025
  //    という年の行を持つ。このページは金額表でもあるのでページ単位のスケールが立ち、
  //    年が「継承あり＝bare でない」と判定されて**伏せられていた**。
  //    他ページの同じ年（伏せない）と別物になり、記号の割れ＝幻の不一致の元になる。
  //
  //    金額と年を分けるのは**桁区切りの有無**である。金額は表の中では 2,026 のように
  //    3桁ごとに区切って書く。年は 2026 と区切らない。
  //    （区切りのある `2,026` は金額として伏せる。Test-NumberMask の
  //      「継承した4桁は西暦として素通りしない」がその側を守っている。）
  if (allow.years && !bare && !/[,，\s]/.test(raw) && YEAR_RE.test(plain)) return true;
  // 構造番号は skipSpans が書式で拾う。ここで桁数を見てはいけない（表の2桁データが漏れる）。
  return false;
}

// --- 記号 ---------------------------------------------------------------
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // I / O は 1 / 0 と紛らわしいので外す
export const SYMBOL_RE = /⟦#[A-Z]{3}⟧/g;

/** ジョブ単位。実量 → 記号 の辞書を日英で共有する。 */
export class Masker {
  /** @param {number} seed 採番の再現用。実運用ではジョブごとに変える。 */
  constructor(seed = 1) {
    this.byKey = new Map();      // 実量(string) → 記号
    this.byNamespace = new Map();// 行IDなど、実量とは比較してはいけない数値 → 記号
    this.ranges = [];            // 丸め幅の共通部分 → 記号
    this.occurrences = [];       // 出現ごとの記録。**本文の復元はこちらを使う**（下記）
    this.surfaces = new Map();   // `${lang}\u0000${記号}` → 最初に見た表記。断片の復元用
    this.explicitAmounts = new Map(); // family → 明示スケール付き実量。異なる単位系を証拠にしない
    this.rowFamilyEvidence = new Map(); // 同じ連番表の行ID → family（日英で共有）
    this.rowFamilyConflicts = new Set();
    this._seed = seed >>> 0 || 1;
    this._pool = null;
  }
  _rand() { // xorshift。出現順に振らないための撹拌なので、暗号強度は要らない
    let x = this._seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._seed = x >>> 0;
    return this._seed / 0x100000000;
  }
  _nextSymbol() {
    if (!this._pool) {
      this._pool = [];
      for (const a of LETTERS) for (const b of LETTERS) for (const c of LETTERS) this._pool.push(a + b + c);
      for (let i = this._pool.length - 1; i > 0; i--) {   // 出現順に振ると大小関係を推測されうる
        const j = Math.floor(this._rand() * (i + 1));
        [this._pool[i], this._pool[j]] = [this._pool[j], this._pool[i]];
      }
    }
    if (!this._pool.length) throw new Error("記号を使い切りました");
    return `⟦#${this._pool.pop()}⟧`;
  }
  /** 実量（絶対値）に対応する記号。符号は外に残すので絶対値で振る。 */
  symbolFor(micro, quantum = 1n, namespace = "amount") {
    const amount = micro < 0n ? -micro : micro;
    if (namespace !== "amount") {
      const namespacedKey = `${namespace}:${amount}`;
      let namespaced = this.byNamespace.get(namespacedKey);
      if (!namespaced) {
        namespaced = this._nextSymbol();
        this.byNamespace.set(namespacedKey, namespaced);
      }
      return namespaced;
    }
    const key = amount.toString();
    let s = this.byKey.get(key);
    if (s) return s;
    // 1,285.7 billion と 1,285,706 million のような、表示桁で丸めた同じ量。
    // 半開区間にすることで 1.2 と 1.3 の境界だけが触れるケースは同一視しない。
    const q = quantum > 0n ? quantum : 1n;
    const half = q / 2n;
    const low = amount - half;
    const high = amount + (q - half);
    const match = this.ranges.find(r => low < r.high && r.low < high);
    if (match) {
      match.low = match.low > low ? match.low : low;
      match.high = match.high < high ? match.high : high;
      this.byKey.set(key, match.symbol);
      return match.symbol;
    }
    s = this._nextSymbol();
    this.byKey.set(key, s);
    this.ranges.push({ low, high, symbol: s });
    return s;
  }
  /** 2記号の元表記が、丸め幅を考慮すると同じ実量を表しうるか。 */
  areSymbolsCompatible(symbolA, symbolB) {
    if (!symbolA || !symbolB) return false;
    if (symbolA === symbolB) return true;
    const interval = rec => {
      const amount = rec.micro < 0n ? -rec.micro : rec.micro;
      const q = rec.quantum > 0n ? rec.quantum : 1n;
      const half = q / 2n;
      return { low: amount - half, high: amount + (q - half) };
    };
    const a = this.occurrences.filter(rec => rec.symbol === symbolA && typeof rec.micro === "bigint");
    const b = this.occurrences.filter(rec => rec.symbol === symbolB && typeof rec.micro === "bigint");
    return a.some(x => b.some(y => (x.namespace || "amount") === (y.namespace || "amount")
      && interval(x).low < interval(y).high && interval(y).low < interval(x).high));
  }
  /**
   * 記号に結び付いた単位familyの証拠だけを返す（実量は返さない）。
   *
   * 同じ実量の金額と台数が同じ記号になることがあるため、記号一致だけを
   * 比較根拠にしてはいけない。familyが1種類かつ全出現にfamilyが付いている
   * 場合だけ known とし、未型・混在・衝突は fail-closed で ambiguous にする。
   */
  getSymbolFamilyEvidence(symbol) {
    const records = this.occurrences.filter(rec => rec.symbol === symbol);
    if (!records.length) return { status: "unknown", family: "", families: [] };
    const families = [...new Set(records.map(rec => String(rec.family || "")).filter(Boolean))];
    const hasUnknown = records.some(rec => !String(rec.family || ""));
    if (families.length === 1 && !hasUnknown) {
      return { status: "known", family: families[0], families };
    }
    return {
      status: families.length ? "ambiguous" : "unknown",
      family: "",
      families,
    };
  }
  /**
   * 2記号の単位familyを比較する。実量や数値辞書は外へ出さない。
   * status は same / disjoint / unknown のいずれかで、unknown は
   * 未型・混在・衝突をまとめて表す。
   */
  compareSymbolUnitFamilies(symbolA, symbolB) {
    const a = this.getSymbolFamilyEvidence(symbolA);
    const b = this.getSymbolFamilyEvidence(symbolB);
    if (a.status !== "known" || b.status !== "known") {
      return { status: "unknown", left: a.status, right: b.status };
    }
    return a.family === b.family
      ? { status: "same", family: a.family }
      : { status: "disjoint", leftFamily: a.family, rightFamily: b.family };
  }
  /**
   * @returns {{text:string, used:Array}} used は復元用。**外へ出さないこと。**
   */
  indexExplicitEvidence(text, lang, allow = DEFAULT_ALLOW) {
    const collected=this.collectExplicitEvidence(text,lang,allow,false);
    for(const [family,amounts] of collected){
      if(!this.explicitAmounts.has(family))this.explicitAmounts.set(family,new Set());
      for(const amount of amounts)this.explicitAmounts.get(family).add(amount);
    }
  }

  indexInlineTableEvidence(text,lang,allow=DEFAULT_ALLOW){
    const src=String(text),marks=appLayoutBlockMarks(src);
    for(let i=0;i<marks.length;i++){
      if(marks[i].role!=="TABLE")continue;
      const end=i+1<marks.length?marks[i+1].index:src.length;
      const headerEnd=src.indexOf("\n",marks[i].index);
      const body=src.slice(headerEnd<0?marks[i].index:headerEnd+1,end);
      // A table block with one unambiguous scale declaration is a safe unit of
      // evidence even when the value is on a different row from its caption.
      // Mixed-scale tables stay on the conservative line-by-line path below.
      const declarations=scaleDeclarations(body).filter(d=>d.family&&d.family!=="generic");
      const scaleKeys=new Set(declarations.map(d=>`${d.family}:${d.exp}`));
      if(scaleKeys.size===1){
        const collected=this.collectExplicitEvidence(body,lang,allow,true);
        for(const [family,amounts] of collected){
          if(!this.explicitAmounts.has(family))this.explicitAmounts.set(family,new Set());
          for(const amount of amounts)this.explicitAmounts.get(family).add(amount);
        }
        continue;
      }
      // 1行ずつ読む。複数表の単位宣言を同じ状態機械へ入れると、後表の
      // thousandsを前表のmillionsで上書きし得るため、inlineで確定する行だけを証拠にする。
      for(const line of body.split(/\r?\n/)){
        const collected=this.collectExplicitEvidence(line,lang,allow,true);
        for(const [family,amounts] of collected){
          if(!this.explicitAmounts.has(family))this.explicitAmounts.set(family,new Set());
          for(const amount of amounts)this.explicitAmounts.get(family).add(amount);
        }
      }
    }
  }

  collectExplicitEvidence(text, lang, allow = DEFAULT_ALLOW, includeUnambiguous = true) {
    const toks = lang === "ja"
      ? tokenizeJa(String(text), allow, null, this.rowFamilyEvidence, null)
      : tokenizeEn(String(text), allow, null, this.rowFamilyEvidence, null);
    const collected=new Map();
    for (const t of toks) {
      // 裸セルから得た値を再び裸セル解決の証拠にすると、同じ表記の別指数が
      // 最初に選ばれた指数へ自己強化される。証拠は数値自身にスケール語がある場合だけ。
      if (!t.explicitScale && !(includeUnambiguous && t.unambiguousScale && t.family)) continue;
      if (!t.family || !["money", "units", "shares", "count"].includes(t.family)) continue;
      const amount = t.micro < 0n ? -t.micro : t.micro;
      if (!collected.has(t.family)) collected.set(t.family, new Set());
      collected.get(t.family).add(amount.toString());
    }
    return collected;
  }

  indexRowFamilyEvidence(text) {
    const incoming = collectRowFamilyEvidence(String(text));
    for (const [key, value] of incoming) {
      if (this.rowFamilyConflicts.has(key)) continue;
      const current = this.rowFamilyEvidence.get(key);
      if (current && current.family !== value.family) {
        this.rowFamilyEvidence.delete(key);
        this.rowFamilyConflicts.add(key);
        continue;
      }
      if (!current || value.source === "row-label") this.rowFamilyEvidence.set(key, value);
    }
  }

  mask(text, lang, allow = DEFAULT_ALLOW) {
    const src = String(text);
    this.indexRowFamilyEvidence(src);
    const pageMarkers=(src.match(/^===== PDF P\.\d+ \//gm)||[]).length;
    const localEvidence=pageMarkers===0?this.collectExplicitEvidence(src,lang,allow,true):null;
    this.indexExplicitEvidence(src, lang, allow);
    const tableEvidence=mergeEvidenceAmounts(this.explicitAmounts,localEvidence);
    const toks = lang === "ja"
      ? tokenizeJa(src, allow, this.explicitAmounts, this.rowFamilyEvidence, tableEvidence)
      : tokenizeEn(src, allow, this.explicitAmounts, this.rowFamilyEvidence, tableEvidence);
    const parts = [];
    const used = [];
    let last = 0;
    for (const t of toks) {
      const sym = this.symbolFor(t.micro, t.quantum, t.namespace || "amount");
      parts.push(src.slice(last, t.start), sym);
      const rec = { symbol: sym, raw: t.raw, sign: t.sign, lang, micro: t.micro, quantum: t.quantum,
        chosenExp: t.chosenExp, family: t.family || "", source: t.source || "", layoutRole:t.layoutRole || "" };
      rec.namespace = t.namespace || "amount";
      used.push(rec); this.occurrences.push(rec);
      const sk = `${lang}\u0000${sym}`;
      if (!this.surfaces.has(sk)) this.surfaces.set(sk, t.raw);
      last = t.end;
    }
    parts.push(src.slice(last));
    return { text: parts.join(""), used };
  }
}

/**
 * 復元。**記号→値の辞書ではできない。**
 * 同じ記号が `1兆2,857億円` と `¥1,285.7 billion` の両方に対応するので、
 * 値から引くと日本語の本文に英語表記が戻る。出現順の記録で戻すこと。
 */
export function unmask(maskedText, used) {
  const s = String(maskedText);
  let i = 0, out = "", last = 0;
  SYMBOL_RE.lastIndex = 0;
  for (const m of s.matchAll(SYMBOL_RE)) {
    const rec = used[i++];
    if (!rec) throw new Error("復元記録が足りません（記号の数と一致しません）");
    out += s.slice(last, m.index) + rec.raw;
    last = m.index + m[0].length;
  }
  if (i !== used.length) throw new Error("復元記録が余っています（記号の数と一致しません）");
  return out + s.slice(last);
}

/**
 * 抜粋のために切り詰める。**数値トークンの途中では切らない。**
 *
 * ⚠️ 実測（長尺フィクスチャ・PACKET_008）: FAST_REVIEW_INDEX の抜粋が
 *    `12,650` を `12,6…` の位置で切っていた。マスカーは `12` だけを数値として読み、
 *    残った `,6` が平文で通って verify() が送信を中止した。
 *    割れた数値はマスカー側では直しようがない（`12,6` は正当な数値に見える）。
 *    **切る側が数値を跨がない**のが唯一の直し方である。
 *
 * 桁が欠けた数値をそのまま伏せるのも危険で、実量が変わるため
 * 同じ値に別の記号が付く。だから末尾の数字は「短く伏せる」のではなく落とす。
 */
export function truncateWithoutSplittingNumber(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  // 末尾から始まる数字の連なり（区切り文字を含む）を丸ごと落とす。
  const cut = s.slice(0, max - 1).replace(/\d[\d.,]*$/, "").replace(/[ \t　]+$/, "");
  return cut + "…";
}

// --- 送信前検証 ---------------------------------------------------------
/**
 * §4.5。**警告ではなく中止のための検査**。
 * 値そのものは返さない（画面に出すと本末転倒なので、位置と理由だけ）。
 */
export function verify(maskedText, allow = DEFAULT_ALLOW) {
  const s = String(maskedText);
  const leaks = [];
  const skip = skipSpans(s, allow);

  // (1) 記号に数字が隣接していないか。**部分マスクの検出はこれが本命**。
  //     残った桁が1〜2桁だと (2) の許可リストを素通りしてしまい、そこから値を逆算される。
  // カンマは桁区切りのときだけ危ない。文の読点・並列の「,」は誤検知になるので、
  // **数字に接したカンマ**だけを見る（`-4,⟦…⟧` や `⟦…⟧,500`）。
  // 空白を挟むものは別の数値。**密着しているものだけ**が部分マスク。
  // 実測で `⟦#X⟧\n1.` のような目次項番を大量に誤検知した。
  // カンマは **数字に挟まれている** ときだけ桁区切り。住所の `ARTS,⟦#X⟧` は単なる句読点。
  // ⚠️ カンマの後ろは3桁だけでなく**1〜2桁も見る**（§4.2c 規則3）。
  //    実測: `⟦#JTC⟧,17`（注記参照 16,17 の片割れ）が 41件あったのに、`,\d{3}` しか
  //    見ていなかったため全部「許可リスト外の数字」に分類され、**型が見えなかった**。
  //    止まりはするが、42件のうち partial-mask と報告されたのは1件だけで、
  //    原因が「注記参照を割っている」ことだと気づくまで遠回りした。
  const PARTIAL = /\d⟦#[A-Z]{3}⟧|\d[,，、]⟦#[A-Z]{3}⟧|⟦#[A-Z]{3}⟧\d|⟦#[A-Z]{3}⟧[,，、]\d{1,3}/g;
  for (const m of s.matchAll(PARTIAL)) {
    leaks.push({ index: m.index, why: "partial-mask", detail: "記号に数字が隣接しています" });
  }
  // (2) 許可リスト外の数字が残っていないか
  for (const m of s.matchAll(new RegExp(NUM_SRC, "g"))) {
    if (spanCovers(skip, m.index, m.index + m[0].length)) continue;
    const plain = m[0].replace(/[,，]/g, "");
    if (allow.years && !/[,，\s]/.test(m[0]) && YEAR_RE.test(plain)) continue;
    leaks.push({ index: m.index, why: "unmasked-number", detail: "許可リスト外の数字が残っています" });
  }
  // (3) 記号の形が壊れていないか（壊れた記号は復元できず、辞書との対応も崩れる）
  const stray = s.replace(SYMBOL_RE, "").match(/[⟦⟧]/g);
  if (stray) leaks.push({ index: -1, why: "broken-symbol", detail: "壊れたプレースホルダーがあります" });

  return { ok: leaks.length === 0, leaks };
}

/**
 * 断片（findings の quote / suggestion など）を読める形に戻す。
 *
 * ⚠️ 本文の復元（unmask）とは別物。断片は出現順が分からないので、
 *    記号ごとに **その言語で最初に見た表記** を当てる。
 *    同じ実量でも `1兆2,857億円` と `¥1,285.7 billion` の2つの表記があるため、
 *    言語を取り違えると日本語の指摘に英語表記が混ざる。
 *    人が読むための復元であって、原文との完全一致は保証しない（保証したいなら unmask を使う）。
 */
export function unmaskFragment(text, masker, lang) {
  return String(text || "").replace(SYMBOL_RE, (sym) =>
    masker.surfaces.get(`${lang}\u0000${sym}`) ?? masker.surfaces.get(`en\u0000${sym}`)
      ?? masker.surfaces.get(`ja\u0000${sym}`) ?? sym);
}

/**
 * 断片を、記号ごとの**別表記でも**戻した候補一覧。先頭は unmaskFragment と同じもの。
 *
 * ⚠️ なぜ要るか（実測 2026-08-07・校正20パケット）: 同じ実量なら `15` と `15.0` は
 *    同じ記号になる。断片の復元は「最初に見た表記」を当てるので、本文が
 *    `15 Supplementary Schedules` でも quote は `15.0 Supplementary Schedules` になりうる。
 *    **文書に無い引用がレポートに出て、ハイライトも当たらない**（88件中8件がこれだった）。
 *    表記は occurrences に全部残っているので、照合側で試せるよう候補として渡す。
 *
 * @param {number} limit 候補の上限。記号が増えると組み合わせが積になるので抑える。
 */
export function unmaskFragmentVariants(text, masker, lang, limit = 8) {
  const src = String(text || "");
  SYMBOL_RE.lastIndex = 0;
  const hits = [...src.matchAll(SYMBOL_RE)];
  if (!hits.length) return [];
  const surfacesFor = (sym) => {
    const key = (l) => `${l}\u0000${sym}`;
    const first = masker.surfaces.get(key(lang)) ?? masker.surfaces.get(key("en"))
      ?? masker.surfaces.get(key("ja")) ?? sym;
    const out = [first];
    for (const rec of masker.occurrences) {
      if (rec.symbol !== sym || rec.lang !== lang) continue;
      if (!out.includes(rec.raw)) out.push(rec.raw);
    }
    return out;
  };
  let built = [""];
  let cursor = 0;
  for (const hit of hits) {
    const literal = src.slice(cursor, hit.index);
    cursor = hit.index + hit[0].length;
    const options = surfacesFor(hit[0]);
    const next = [];
    for (const prefix of built) {
      for (const option of options) {
        if (next.length >= limit) break;
        next.push(prefix + literal + option);
      }
      if (next.length >= limit) break;
    }
    built = next;
  }
  const tail = src.slice(cursor);
  return built.map(s => s + tail);
}

/**
 * TEXT サイドカーは TARGET(英) と REF(日) が **1つのファイルに同居** している。
 * まとめて1言語として扱ってはいけない。
 *
 * ⚠️ 実測: 日本語→英語の順に通しがけしたところ、日本語パスが英文の `1,285.7` を
 *    裸の数値として先に伏せてしまい、`billion` が効かなかった。結果
 *    `¥1,285.7 billion` と `1兆2,857億円` に **別の記号** が振られ、
 *    日英の突き合わせ（この設計の根幹）が成立しなかった。
 *
 * ブロック見出し（`===== PDF P.1 / TARGET_CHECK / ... =====`）は
 * こちらが生成した構造情報なので **マスクしない**。伏せると `REF1_CANDIDATE` が
 * `REF⟦#XSP⟧_CANDIDATE` になり、どのページのどの役割か分からなくなる。
 *
 * @param {(role:string)=>("ja"|"en")} langOf 役割名から言語を決める
 */
// 役割ブロックより前（前書き）には TARGET_CHECK_FAST_REVIEW_INDEX があり、
// その各行に **TARGET本文の冒頭抜粋** が入っている。つまり前書きは日本語ではない。
//
// ⚠️ 実測: 前書きを丸ごと "ja" で伏せると、英文の `68,921 million yen` が
//    index行では 68,921、本文（"en"）では 68,921×10⁶ と読まれ、**同じ文に別の記号**が付いた。
//    モデルは設計どおり「記号が違えば別の値」と信じるので、正しい訳を誤りとして報告する。
//    §2.3 の `百\n万` と同じ型の、モデル側では見抜けない誤りである。
const FAST_REVIEW_INDEX_MARKER = "TARGET_CHECK_FAST_REVIEW_INDEX:";
function maskPreamble(preamble, masker, langOf) {
  const i = preamble.indexOf(FAST_REVIEW_INDEX_MARKER);
  if (i < 0) return masker.mask(preamble, "ja").text;
  return masker.mask(preamble.slice(0, i), "ja").text
    + masker.mask(preamble.slice(i), langOf("TARGET_CHECK")).text;
}
export function maskSidecarByRole(text, masker, langOf = (role) => (/^REF/.test(role) ? "ja" : "en")) {
  const HEADER = /^===== PDF P\.\d+ \/ (\S+) \/.*=====$/gm;
  const src = String(text);
  const marks = [];
  for (const m of src.matchAll(HEADER)) marks.push({ index: m.index, end: m.index + m[0].length, role: m[1] });
  if (!marks.length) return maskPreamble(src, masker, langOf);
  // 同じ連番表のfamilyを全言語から先に集める。英語側で見える横書き見出しを、
  // 日本語側でテキスト層から消えた縦見出しの代わりに使えるようにする。
  for (let i = 0; i < marks.length; i++) {
    const blockEnd = i + 1 < marks.length ? marks[i + 1].index : src.length;
    masker.indexRowFamilyEvidence(src.slice(marks[i].end, blockEnd));
  }
  // 出現順に依存させない。全ページ・全言語の明示単位付き数値を先に索引化してから、
  // 混在単位表の裸セルをマスクする（日本語P.14の縦見出し欠落などを補う）。
  for (let i = 0; i < marks.length; i++) {
    const blockEnd = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body=src.slice(marks[i].end, blockEnd),lang=langOf(marks[i].role);
    masker.indexExplicitEvidence(body,lang);
    masker.indexInlineTableEvidence(body,lang);
  }
  const out = [maskPreamble(src.slice(0, marks[0].index), masker, langOf)];
  for (let i = 0; i < marks.length; i++) {
    const blockEnd = i + 1 < marks.length ? marks[i + 1].index : src.length;
    out.push(src.slice(marks[i].index, marks[i].end));           // 見出しはそのまま
    out.push(masker.mask(src.slice(marks[i].end, blockEnd), langOf(marks[i].role)).text);
  }
  return out.join("");
}
