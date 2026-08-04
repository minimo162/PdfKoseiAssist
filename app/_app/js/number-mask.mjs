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
const NUM_SRC = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

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
    // 符号は数値の直前にある △▲ を見る（範囲には含めない。符号は平文で残すため）
    const before = src.slice(Math.max(0, i - 2), i);
    const sm = before.match(JA_SIGN_RE);
    const only = !m[1] && !m[2] && !m[3] && !m[4] && !m[5] && m[6];
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
    const exp = (EN_SCALES.find(([w]) => w === word) || [null, 0])[1];
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
    if (keep(src.slice(i, end), micro, !word, allow)) { i = end; continue; }
    out.push({ start: i, end, micro, sign, raw: src.slice(i, end) });
    i = end;
  }
  return out;
}

/** 許可リストに当たるか（true なら伏せない） */
function keep(raw, micro, bare, allow) {
  const plain = raw.replace(/[,\s]/g, "");
  if (allow.years && bare && YEAR_RE.test(plain)) return true;
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
  const PARTIAL = /\d⟦#[A-Z]{3}⟧|\d,⟦#[A-Z]{3}⟧|⟦#[A-Z]{3}⟧\d|⟦#[A-Z]{3}⟧,\d{3}/g;
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
