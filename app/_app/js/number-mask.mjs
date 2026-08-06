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
const NUM_SRC = String.raw`\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?`;

// 実量は BigInt のマイクロ単位（1 = 1e-6）で持つ。浮動小数点は使わない。
// 実測で 32.8×10⁹ が 32799999999.999996 になり、別の記号が振られた。
const MICRO = 6;

/** "1,285.7" → BigInt(1285700000)（マイクロ単位） */
function toMicro(numStr) {
  const s = String(numStr).replace(/,/g, "");
  const [int, frac = ""] = s.split(".");
  const f = (frac + "0".repeat(MICRO)).slice(0, MICRO);
  return BigInt(int + f);
}

/** マイクロ単位の BigInt に 10^exp を掛ける */
function shift(micro, exp) {
  return exp >= 0 ? micro * 10n ** BigInt(exp) : micro / 10n ** BigInt(-exp);
}

// --- スケール語 ---------------------------------------------------------
// 日本語は長いものから見る（「百万」を「万」より先に）。
const JA_SCALES = [["兆", 12], ["億", 8], ["百万", 6], ["万", 4], ["千", 3]];
const EN_SCALES = [["trillion", 12], ["billion", 9], ["million", 6], ["thousand", 3]];

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
  /第\s*\d{1,3}\s*(?:四半期|[期章条項号回])/g,   // 第160期 / 第2四半期 / 第24条
  // 見出し番号「(1)」。⚠️ **括弧付きの数字を無条件に許すと表の負値が丸ごと平文で残る。**
  //   実測（実物の短信）: `Allowance for doubtful receivables (603) (643)` の 603/643、
  //   `Total (926)`、`Other ⟦#PLF⟧ ⟦#WXM⟧ (9)` が伏せられずに出ていた（英文表は負値を括弧で書く）。
  //   見出し番号は **行頭（または「:」直後）にあって、直後が文字** という形をしている。
  //   表の値は行の途中にあり、直後は別の数値・記号・行末になる。ここで切り分ける。
  /^[ \t　]*[(（]\s*\d{1,2}\s*[)）](?=\s*[^\s\d(（)）⟦\-–—~〜△▲])/gm,
  /[:：]\s*[(（]\s*\d{1,2}\s*[)）](?=\s*[^\s\d(（)）⟦\-–—~〜△▲])/g,
  // 注番号・脚注番号。数値の頭だけを食っても spanCovers が弾く（`注 1,234` の 1,234 は伏せられる）
  /注\s*\d{1,2}/g,                    // 注1
  /[Nn]ote\s*\d{1,2}/g,
  /No\.\s*\d{1,3}/g,                    // Act No.19 / Guidance No.26
  // ページ番号。⚠️ **直前が英字なら別の語の末尾**。実測（実物の短信）で `up 1.2%` の "p 1" を
  //    ページ番号と読んでしまい、1.2 が平文で残った（"Group 5" "top 10" も同じ形）。
  /(?<![A-Za-z])[PpＰ]\s*\.?\s*\d{1,4}\s*[-–—~〜]\s*\d{1,4}/g,  // P.1-25（範囲。単体より先に見る）
  /(?<![A-Za-z])[PpＰ]\s*\.?\s*\d{1,4}/g,         // P.48 / p12
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
  [/[(（]\s*(?:in\s+)?trillions?\s+of\s+yen\s*[)）]/i, 12],
  [/[(（]\s*(?:in\s+)?billions?\s+of\s+yen\s*[)）]/i, 9],
  [/[(（]\s*(?:in\s+)?millions?\s+of\s+yen\s*[)）]/i, 6],
  [/[(（]\s*(?:in\s+)?thousands?\s+of\s+(?:yen|shares)\s*[)）]/i, 3],
  [/[(（]\s*兆円\s*[)）]/, 12],
  [/[(（]\s*億円\s*[)）]/, 8],
  [/[(（]\s*百\s*万円\s*[)）]/, 6],
  [/[(（]\s*千(?:円|株)\s*[)）]/, 3],
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
  [/\bmillions\s+of\s+yen\b(?=\s*[\d(（△▲-])/i, 6],
  [/\bthousands\s+of\s+(?:yen|shares)\b(?=\s*[\d(（△▲-])/i, 3],
  // もうひとつの形: **行が単位だけ**（財務諸表本体 p84 / p86）。数字はラベルを挟んだ次の行以降に来るので、
  // 「直後に数字」では拾えない。行に他の語が無いことを条件にすれば散文と区別できる。
  [/^\s*(?:in\s+)?trillions\s+of\s+yen\s*$/i, 12],
  [/^\s*(?:in\s+)?billions\s+of\s+yen\s*$/i, 9],
  [/^\s*(?:in\s+)?millions\s+of\s+yen\s*$/i, 6],
  [/^\s*(?:in\s+)?thousands\s+of\s+(?:yen|shares)\s*$/i, 3],
];
/**
 * その数値が**自分の単位を持っている**なら継承しない。
 * 「Net sales (Millions of yen) 458,921 (up 7.2%)」の 7.2 まで百万倍にすると、
 * 他ページの 7.2% と別記号になり、直そうとしていた幻の不一致を別の形で作ってしまう。
 */
const OWN_UNIT_RE = /^\s*(?:%|％|ポイント|points?\b|pt\b|[人名件社株台個本回]|persons?\b|shares?\b|employees\b|units?\b|times\b|years?\b|hours?\b)/i;

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
  const nums = s.match(/\d[\d,]*(?:\.\d+)?/g) || [];
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
 */
const LINE_OWN_UNIT_BARE_RE = /(?:(?<!\bof\s)\b(?:yen|persons?|employees|shares?|times)\b|[%％])/i;

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
const HEADER_HEAD_RE = /^\s*of\s+(?:yen|shares)\b/i;
// 「of Yen」は行頭とは限らない（上の16行目は行末にある）。
const OF_UNIT_RE = /\bof\s+(?:yen|shares)\b/i;
const DANGLING_SCALE = [["trillion", 12], ["billion", 9], ["million", 6], ["thousand", 3]];

const scaleOf = (text) => {
  for (const [re, e] of LINE_UNIT_PATTERNS) { re.lastIndex = 0; if (re.test(text)) return e; }
  return 0;
};

function lineScaleExponents(src) {
  const exps = new Int8Array(src.length);
  const lines = src.split("\n");
  const blockScale = [];      // 各行が属するブロックのスケール

  // 1回目: ブロックを切り、ブロックごとのスケールを決める。
  let start = 0, scale = 0;
  let dangling = 0, sawOfUnit = false;     // 行で割れた見出しの断片
  const settle = () => { if (!scale && dangling && sawOfUnit) scale = dangling; };
  const flush = (end) => { settle(); for (let i = start; i < end; i++) blockScale[i] = scale; };
  for (let idx = 0; idx < lines.length; idx++) {
    if (/^===== PDF P\.\d+ \//.test(lines[idx])) {
      flush(idx); start = idx; scale = 0; dangling = 0; sawOfUnit = false; continue;
    }
    const line = lines[idx];
    if (!scale) {
      let own = scaleOf(line);
      if (!own && idx + 1 < lines.length) own = scaleOf(line + " " + lines[idx + 1]);
      if (own) scale = own;
    }
    // 断片。行末のスケール語と、どこかにある「of Yen / of Shares」が揃えば宣言とみなす。
    if (!dangling) {
      const m = HEADER_TAIL_RE.exec(line);
      if (m) {
        const w = m[1].toLowerCase().replace(/s$/, "");
        dangling = (DANGLING_SCALE.find(([x]) => x === w) || [null, 0])[1];
      }
    }
    if (!sawOfUnit && OF_UNIT_RE.test(line)) sawOfUnit = true;
  }
  flush(lines.length);

  // 2回目: 行ごとの歯止めを見ながら流し込む。
  let pos = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const exp = blockScale[idx] || 0;
    // その行が単位見出しの一部か（`Millions` / `of Yen 297,177 …` の下側もここに入る）。
    // 見出しの一部なら、そこに出てくる `Yen` を「自分の単位」と読んではいけない。
    // ⚠️ 前の行と単純に繋いで判定してはいけない。それだと
    //      Net sales (Millions of yen) 3,214
    //      Number of employees (Persons) 3,214
    //    の2行目まで「見出しの一部」になり、**（人）の行が百万倍になる**（実測で踏んだ）。
    //    見出しが割れる形（前の行がスケール語で終わり、この行が `of yen` で始まる）だけを見る。
    const declares = !!scaleOf(line);
    const isHeaderTail = idx > 0 && HEADER_TAIL_RE.test(lines[idx - 1]) && HEADER_HEAD_RE.test(line);
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
    pos += line.length + 1;
  }
  return exps;
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
export function tokenizeJa(text, allow = DEFAULT_ALLOW) {
  const src = String(text);
  const skip = skipSpans(src, allow);
  const lineExp = lineScaleExponents(src);
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
    let micro = 0n, any = false;
    const exps = [12, 8, 6, 4, 3];
    for (let k = 0; k < 5; k++) if (m[k + 1]) { micro += shift(toMicro(m[k + 1]), exps[k]); any = true; }
    if (m[6]) { micro += toMicro(m[6]); any = true; }
    if (!any) { i++; continue; }
    // 単位語が付いていない数字は、同じ行の見出しにある単位（（百万円）等）を継承する。
    // ただし自分の単位（%・人・件…）を持っているものは継承しない。
    const bareJa = !m[1] && !m[2] && !m[3] && !m[4] && !m[5];
    const inherited = bareJa && !OWN_UNIT_RE.test(src.slice(end, end + 12))
      && !isBracketed(src, i, end) ? lineExp[i] : 0;
    if (inherited) micro = shift(micro, inherited);
    // 符号は数値の直前にある △▲ を見る（範囲には含めない。符号は平文で残すため）
    const before = src.slice(Math.max(0, i - 2), i);
    const sm = before.match(JA_SIGN_RE);
    // 単位を継承したものは金額であって西暦ではない（bare 扱いを外す）
    const only = !m[1] && !m[2] && !m[3] && !m[4] && !m[5] && m[6] && !inherited;
    if (keep(src.slice(i, end), micro, only, allow)) { i = end; continue; }
    out.push({ start: i, end, micro, sign: sm ? sm[0] : "", raw: src.slice(i, end) });
    i = end;
  }
  return out;
}

/** 英語の数値トークン。`( 1,234 ) billion` のように閉じ括弧を挟んでもスケール語を拾う。 */
export function tokenizeEn(text, allow = DEFAULT_ALLOW) {
  const src = String(text);
  const skip = skipSpans(src, allow);
  const lineExp = lineScaleExponents(src);
  const scaleAlt = EN_SCALES.map(([w]) => w + "s?").join("|");
  const re = new RegExp(`(${NUM_SRC})\\s*\\)?\\s*(${scaleAlt})?`, "giy");
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
    const inherited = word || OWN_UNIT_RE.test(src.slice(i + m[1].length, i + m[1].length + 12))
      || isBracketed(src, i, i + m[1].length)
      ? 0 : lineExp[i];
    const exp = word ? (EN_SCALES.find(([w]) => w === word) || [null, 0])[1] : inherited;
    const micro = shift(toMicro(m[1]), exp);
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
    out.push({ start: i, end, micro, sign, raw: src.slice(i, end) });
    i = end;
  }
  return out;
}

/** 許可リストに当たるか（true なら伏せない） */
function keep(raw, micro, bare, allow) {
  const plain = raw.replace(/[,\s]/g, "");
  if (allow.years && bare && YEAR_RE.test(plain)) return true;
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
  if (allow.years && !bare && !/[,\s]/.test(raw) && YEAR_RE.test(plain)) return true;
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
    this.occurrences = [];       // 出現ごとの記録。**本文の復元はこちらを使う**（下記）
    this.surfaces = new Map();   // `${lang}\u0000${記号}` → 最初に見た表記。断片の復元用
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
  symbolFor(micro) {
    const key = (micro < 0n ? -micro : micro).toString();
    let s = this.byKey.get(key);
    if (!s) { s = this._nextSymbol(); this.byKey.set(key, s); }
    return s;
  }
  /**
   * @returns {{text:string, used:Array}} used は復元用。**外へ出さないこと。**
   */
  mask(text, lang, allow = DEFAULT_ALLOW) {
    const src = String(text);
    const toks = lang === "ja" ? tokenizeJa(src, allow) : tokenizeEn(src, allow);
    const parts = [];
    const used = [];
    let last = 0;
    for (const t of toks) {
      const sym = this.symbolFor(t.micro);
      parts.push(src.slice(last, t.start), sym);
      const rec = { symbol: sym, raw: t.raw, sign: t.sign, lang };
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
  const PARTIAL = /\d⟦#[A-Z]{3}⟧|\d[,、]⟦#[A-Z]{3}⟧|⟦#[A-Z]{3}⟧\d|⟦#[A-Z]{3}⟧[,、]\d{1,3}/g;
  for (const m of s.matchAll(PARTIAL)) {
    leaks.push({ index: m.index, why: "partial-mask", detail: "記号に数字が隣接しています" });
  }
  // (2) 許可リスト外の数字が残っていないか
  for (const m of s.matchAll(new RegExp(NUM_SRC, "g"))) {
    if (spanCovers(skip, m.index, m.index + m[0].length)) continue;
    const plain = m[0].replace(/,/g, "");
    if (allow.years && YEAR_RE.test(plain)) continue;
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
  const out = [maskPreamble(src.slice(0, marks[0].index), masker, langOf)];
  for (let i = 0; i < marks.length; i++) {
    const blockEnd = i + 1 < marks.length ? marks[i + 1].index : src.length;
    out.push(src.slice(marks[i].index, marks[i].end));           // 見出しはそのまま
    out.push(masker.mask(src.slice(marks[i].end, blockEnd), langOf(marks[i].role)).text);
  }
  return out.join("");
}
