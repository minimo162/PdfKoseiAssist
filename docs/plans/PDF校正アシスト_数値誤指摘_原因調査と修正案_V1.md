# PDF校正アシスト 数値誤指摘 原因調査と修正案 V1

- 作成日: 2026-08-24
- 対象: v95.3 / `app/_app/js/number-mask.mjs`, `app/_app/js/review-merge-core.mjs`, `app/_app/index.html`
- 入力: 実行結果14件（P.1〜P.15、英文デック × 日本語版の整合性校正）
- 状態: **調査と修正案のみ。コード変更は未実施**
- 検証: すべて手元の Node で再現・確認済み（再現手順は §2）

---

## 1. 結論サマリ

14件のうち **8件が誤指摘**、2件が要確認、4件が妥当である。

| # | P | カテゴリ | 判定 | 根拠 |
|---|---|----------|------|------|
| 1 | 1 | omission | 要確認 | 数値 `12,857oku` と `1兆2,857億円` は**同値**（マスカーで確認済み）。欠落の主張自体は引用文が原文どおりか未確認 |
| 2 | 1 | mistranslation | 要確認 | 2つの箇条書きが1行に連結された形。抽出側の行結合が原因の可能性が高い |
| 3 | 2 | grammar | 妥当 | `taxable income profitable` は動詞欠落 |
| 4 | 4 | number_mismatch | **誤指摘** | `(20) oku` = `▲20億円`。同値 |
| 5 | 4 | number_mismatch | **誤指摘** | `(8) oku` = `▲8億円`。同値 |
| 6 | 4 | number_mismatch | **誤指摘** | `(54) k yen` = `▲54千円`。同値。しかも修正案 `(54,000) k yen` は値を10³倍する改竄 |
| 7 | 4 | number_mismatch | **誤指摘** | `(72) k yen` = `▲72千円`。同値。修正案 `(72千) k yen` は日本語混入で英文として成立しない |
| 8 | 9 | number_mismatch | **誤指摘** | `(419) oku` = `(419)億円`。同値。**修正案が対象原文と1文字も違わない** |
| 9 | 10 | number_mismatch | **誤指摘** | `(108) oku` = `(108)億円`。同値。**修正案が対象原文と1文字も違わない** |
| 10 | 11 | name_mismatch | **誤指摘** | 車種名は両側とも `CX-50`。指摘文自身が「「CX-50」または「CX-50」の正しい車種名に統一する」と自己矛盾 |
| 11 | 14 | grammar | 妥当 | `Account Receivables` → `Accounts Receivable` |
| 12 | 14 | mistranslation | 妥当 | `Transaction` → `Translation`（為替換算調整勘定） |
| 13 | 14 | grammar | 妥当 | `Receive` → `Received` |
| 14 | 15 | number_mismatch | **誤指摘** | `(508) oku yen` = `(508)億円`。同値 |

誤指摘8件は**すべて同じ根に行き着く**。「日本語側と英語側で同じ金額に別の保護記号が付く（または片側だけ平文で残る）」ため、Copilot からは値が食い違って見え、かつコード側の決定的フィルタも同値だと証明できない。

---

## 2. 再現手順

```bash
cd app/_app
node -e '
import("./js/number-mask.mjs").then(({Masker}) => {
  const m = new Masker();
  console.log(m.mask("Japan (108) oku.", "en").text);      // Japan (⟦#AAA⟧) oku.
  console.log(m.mask("日本 (108)億円。", "ja").text);        // 日本 (⟦#AKB⟧)億円。   ← 別記号
  console.log(m.mask("costs (20) oku", "en").text);        // costs (20) oku        ← 伏せられない
  console.log(m.mask("費用 ▲20億円", "ja").text);           // 費用 ▲⟦#QUZ⟧円        ← 片側だけ記号
});'
```

`Masker` の内部辞書（`byKey`）を見ると実量そのものが食い違っている。

| 表記 | 正規化された実量キー | 備考 |
|------|----------------------|------|
| EN `(108) oku` | `10800000000000000` | 正しい（108×10⁸） |
| JA `▲108億円` | `10800000000000000` | 正しい。ENと一致する |
| JA `(108)億円` | `108000000` | **10⁸倍小さい**。`億` を取り込めていない |
| EN `(20) oku` | （記号なし） | トークン化されず平文のまま |
| JA `(54)千円` | （記号なし） | 同上 |

---

## 3. 原因

### 原因A: `tokenizeJa` が閉じ括弧越しのスケール語を拾えない

`js/number-mask.mjs:1015` の複合数詞パターンは `(数字)\s*(兆|億|百万|万|千)` の連鎖であり、数字とスケール語の間に閉じ括弧が入る形を想定していない。

```js
const compound = new RegExp(
  `(?:(${NUM_SRC})\\s*${sc[0]})?\\s*(?:(${NUM_SRC})\\s*${sc[1]})?…`, "y");
```

英語側は同じ問題を既に修正済みで、`js/number-mask.mjs:1087` に閉じ括弧の吸収が入っている（関数コメントにも「`( 1,234 ) billion` のように閉じ括弧を挟んでもスケール語を拾う」と明記されている）。**日本語側だけ取り残されている。**

結果、`(419)億円` は「419」という裸の数値として読まれ、`▲419億円` とも英語の `(419) oku` とも別の実量になる。決算資料の日本語版は負値を `▲` でも `( )` でも書くため、同じページ内で同じ金額に2種類の記号が付く状態になっている。

該当: #8（419）、#9（108）、#14（508）

補足: `js/number-mask.mjs:1000` の `JA_SIGN_RE = /[△▲]/` も括弧負号を見ていないため、`(419)億円` は符号も失う（英語側は `sign = "("` を立てる）。実量キーに符号は含まれないので記号割れの直接原因ではないが、同じ取り残しである。

### 原因B: 項番判定が1〜2桁の括弧付き金額を項番と誤認する

`js/number-mask.mjs:132`：

```js
// 項番は**1～2桁**で**直後が語**という形をしている。表の負値は直後が
// 数値・記号・行末になる。直後の1文字で切り分ける。
/[(（]\s*\d{1,2}\s*[)）](?=\s*[ぁ-んァ-ヶ一-鿿A-Za-z])/g,
```

この切り分けは**表のセル**を前提にしている。ところが本件のような**本文・箇条書きの金額**は「(54) k yen」「(20) oku」「(54)千円」のように、括弧の直後に**単位語**が来る。単位語は「語」なので、この項番パターンに丸ごと一致してしまう。

- EN `(20) oku` `(8) oku` `(54) k yen` `(72) k yen` → 項番扱い、平文のまま
- JA `▲20億円` `▲54千円` → 括弧が無いので正常にマスク

片側だけ記号、もう片側は生数字という状態になり、Copilot からは確実に食い違って見える。閾値のように見える挙動（`(99) oku` は素通り、`(100) oku` は伏せる）はこの `\d{1,2}` が正体である。

同じ問題は行頭項番 `js/number-mask.mjs:120` と コロン直後 `:121` にもある。

該当: #4（20）、#5（8）、#6（54）、#7（72）

### 原因C: 決定的フィルタが「保護記号の一致」より先に source 必須ゲートで落ちる

`js/review-merge-core.mjs:5122` `isConclusiveNumericFalsePositive` は、`oku` / `億円` の綴り差を含む候補（`signedOkuEquivalenceCandidate`）を**最初に**処理し、`requiresSource`（言語をまたぐ換算）の場合は

```js
if (crossLanguageOku
    && !(context?.targetRowUnique && context?.referenceRowUnique
      && sourceContextIdentityCompatible(context, f))) return false;   // :5201
```

で必ず KEEP に倒す。プレゼン資料の本文は表の行ではないので `targetRowUnique` は立たず、この経路は**構造的に通らない**。

一方、両側に**同じ保護記号**が付いていれば、マスカーが同一実量であることを既に保証している。この証明は単位語の綴りに依存しないので source 行の一意性を要求する必要がない。ところが同値証明（`allPairsProveFalsePositive` → `canDropSinglePrimaryPair` の記号一致経路、`identicalProtectedSymbolPairwise`）は **:5201 より後ろ**にあり、到達しない。

原因A/Bを直して記号が揃っても、`(419)億円` のように日本語側に `億円` が残る形では、この順序のせいで依然 KEEP になる（§5 の実測参照）。

該当: #8、#9（記号を揃えた後も残る）

### 原因D: 記号照合が語順違い・部分引用に対応していない

同値証明はいずれも `left[i]` と `right[i]` を**添字で**突き合わせる（`allPairsProveFalsePositive` は `left.length !== right.length` で即 false）。

- #8: EN `Down (⟦#AAA⟧) oku vs. FY⟦#AKB⟧/⟦#QUZ⟧ Q⟦#BTF⟧.` / JA `FY⟦#AKB⟧/⟦#QUZ⟧ ⟦#BTF⟧Q比で(⟦#AAA⟧)億円。`
  → 記号の**多重集合は完全一致**だが、金額が英語では先頭・日本語では末尾に来るため添字がずれる。日英の語順差そのものが原因であり、表の列入れ替えとは性質が違う。
- #14: EN は1件（508）、JA の引用文は2件（508 と 692）を含む。`signedOkuCandidate.memberMismatch`（`:5150`）で即 KEEP。英語側が日本語文の一部だけを引用した**部分引用**であり、値の不一致ではない。

### 原因E: 日英のラベルが常に「別の行」と判定される（二次要因）

`js/review-merge-core.mjs:1379` `unknownIdentityLabelMismatch` は行ラベル文字列を素で比較する。

```
raw material costs  vs  原材料費      → 不一致 → 同値証明を拒否
japan               vs  日本          → 不一致 → 同値証明を拒否
```

例外は `MEASURE_PATTERNS`（`:494`）の日英対訳辞書に載っている勘定科目のみで、これは有価証券報告書・短信の科目名に特化している。決算説明会デックの「原材料費」「車種・グレードミックス」「在庫増加による悪化」などは載っていない。**翻訳整合性の校正では日英でラベルが違うのは当たり前**なので、この判定は原理的に常に「別行」を返す。

原因A〜Cを直せば記号一致が先に成立してこの経路には入らない（記号一致には `sameProtectedSymbol` 例外がある）。ただし記号が付かない値では今後も同じ形の誤指摘が出る。

### 原因F: UIの「決定的検査 alignment候補 / alignment 0.00」が実体を伴っていない

`index.html:7206-7212`（および `:7260-7266`）：

```js
const alignment = Number(finding?.alignment_score ?? finding?.alignmentScore);
if (deterministic || Number.isFinite(alignment)) parts.push(`…決定的検査…${deterministic || "alignment候補"} / alignment ${alignment.toFixed(2)}`);
```

`alignment_score` は取り込み時（`index.html:5828-5829`）に、値が無ければ `null` に正規化される。`Number(null)` は **0** なので `Number.isFinite` を通り、**未取得が「alignment 0.00」という測定値として表示される**。`deterministic_check` を実際に立てるのは `js/structural-checks.mjs:52` の主語述語一致だけなので、それ以外は必ず「alignment候補」という無意味なラベルになる。

つまり14件すべてに付いている「決定的検査 alignment候補 / alignment 0.00」は、**何も検査していないことを、検査して0点だったかのように見せている**。誤指摘の直接原因ではないが、レビュー担当が根拠の強さを誤読する。

なお `js/reference-alignment.mjs` の `similarity()` は語彙の重なりだけを見るため、日英ページ対では原理的に `minScore`（0.28 / 0.55）を超えない。仮に値を入れても 0 付近にしかならない。

### 原因G: 「原文と同じ修正案」「自己矛盾した指摘」を落とす関門が無い

- #8 の修正案 `Down (419) oku vs. FY26/3 Q4.` は対象原文と完全一致。#9 も同様。**置き換えても何も変わらない指摘**である。
- #10 は「「CX-50」または「CX-50」の正しい車種名に統一する」と、同じ名前を2回並べている。

`isConclusiveNumericFalsePositive` は `NUMERIC_CATEGORIES`（number_mismatch / value_inconsistency / accounting_inconsistency / numbers）にしか適用されないため `name_mismatch` は素通りする。`suggestionChangesNumericOrDateTokens`（`js/finding-quality.mjs:676`）は数値カテゴリを対象外にしており、no-op 修正案も検出しない。カテゴリに依らない「無変更・自己矛盾」の関門が存在しない。

---

## 4. 修正案

優先度は「誤指摘の削減量 ÷ 回帰リスク」で並べている。

### 修正1（最優先・小）: 項番パターンに単位語の否定先読みを足す

対象: `js/number-mask.mjs:120, 121, 132`

括弧の直後が**単位語・スケール語**なら項番ではなく金額とみなす。

```js
// 単位語が直後に来るものは金額。項番ではない。
const NOT_A_UNIT = String.raw`(?!\s*(?:(?:oku|k\s*yen|k|thousand|million|billion|trillion|yen)(?![A-Za-z])|[兆億万千円]|百\s*万))`;
/[(（]\s*\d{1,2}\s*[)）](?!\s*(?:(?:oku|k\s*yen|k|thousand|million|billion|trillion|yen)(?![A-Za-z])|[兆億万千円]|百\s*万))(?=\s*[ぁ-んァ-ヶ一-鿿A-Za-z])/gu,
```

- 守るもの: `(1) 監視` `(2) 予防` `(1) 連結経営成績` は「監視」「連結」が単位語でないので従来どおり項番のまま。
- 直るもの: `(20) oku` `(54) k yen` `(54)千円` が金額として伏せられる。
- リスク: 低。既存テスト `Test-NumberMask.mjs` の「文中の項番を伏せない」「表の負値は伏せる」は通過する（§5 で確認済み）。

### 修正2（最優先・小）: `tokenizeJa` で閉じ括弧越しのスケール語を換算に使う

対象: `js/number-mask.mjs:1015` 付近

**マスク範囲は広げず、値だけ換算する。** `compound` の正規表現に `[)）]?` を足す素朴な直し方は、`end` が `m[0]` 基準なので閉じ括弧を飲み込み、`(⟦#AAA⟧円。` のように括弧が壊れる（モジュール冒頭の警告そのもの）。後処理として足すのが安全である。

```js
// 括弧の負値 `(419)億円` は閉じ括弧が間に入るため compound では 億 を拾えない。
// span は数字のままにして、実量だけ換算する。
let bracketExp = 0;
if (m[6] && !m[1] && !m[2] && !m[3] && !m[4] && !m[5]) {
  const bm = src.slice(end, end + 8).match(/^[)）]\s*(兆|億|百\s*万|万|千)/);
  if (bm) {
    const w = bm[1].replace(/\s+/g, "");
    bracketExp = (JA_SCALES.find(([x]) => x === w) || [null, 0])[1];
    if (bracketExp) { micro = shift(micro, bracketExp); quantum = shift(quantum, bracketExp); }
  }
}
```

あわせて `bareJa` と `only` の判定から `bracketExp` を除外する（スケールが確定した値を「単位継承なしの裸の数字＝西暦候補」に落とさないため）。

- 直るもの: `(419)億円` `(108)億円` `(508)億円` が `▲419億円` および EN `(419) oku` と同じ記号になる。
- リスク: 低。既存テスト全通過（§5）。
- 併せ技（任意）: `JA_SIGN_RE` に括弧負号の判定を足し、日英で符号の読み方を揃える。

### 修正3（中）: 保護記号の一致を source 必須ゲートより先に評価する

対象: `js/review-merge-core.mjs:5130` 付近（`signedOkuCandidate` ブロックの直前）

不正な符号形の門番（`hasUnsupportedFullwidthDashOkuEvidence` / `hasMismatchedNumericParenthesisEvidence` / `hasAmbiguousCombinedSignEvidence`）は現状どおり先に効かせたうえで、その直後に記号一致証明を置く。

```js
// 両側の保護記号が対応していれば、マスカーが同一実量を保証済みである。
// 単位語の綴り（oku / 億円）を根拠に source 行の一意性まで求める必要はない。
const l = extractNumericEvidence(f.quote, masker);
const r = extractNumericEvidence(f.referenceQuote ?? f.reference_quote, masker);
if (l.length && l.length === r.length && l.every((t, i) => symbolsProveSameAmount(t, r[i], masker))) return true;
```

`symbolsProveSameAmount` は両側に記号があり、符号が同じで、記号が同一または `masker.areSymbolsCompatible` が真であることを見る（既存の `identicalProtectedSymbolPairwise` / `maskerCompatibleSymbolPairwise` の中身をカテゴリ非依存に切り出す形）。

- 直るもの: #9。修正1・2と合わせて #4〜#7 も確定 drop になる。
- リスク: 中。現在この2関数は `issueScope` が translation_consistency / mistranslation のときだけ有効。カテゴリ非依存に広げる変更なので、`Test-DeterministicFilters.mjs` と `Test-ReviewMerge.mjs` に「記号一致だけでは落とさないケース」がないかの確認が要る（§6 のテスト追加とセット）。

### 修正4（中）: 語順違いと部分引用への対応

対象: `js/review-merge-core.mjs`（修正3の記号照合部）

1. **語順非依存**: 添字一致が取れないとき、記号の**多重集合**（記号＋符号のペア）が完全一致するなら同値とみなす。ただし表の行（同じ記号が複数回出る、列区切り `;`／`|` を含む）では従来どおり添字一致を要求し、`hasColumnIdentityPermutation` の列入れ替え検出を残す。→ #8 が落ちる。
2. **部分引用**: 引用側の記号多重集合が比較資料側の**部分集合**で、対応する記号がすべて同符号のとき、`memberMismatch` で即 KEEP にせず **`needs_human_review`（要確認）へ降格**する。値は一致しているので high の number_mismatch として出す根拠はないが、日本語側の残りの金額が英語側で欠落している可能性は残るため drop はしない。→ #14 が high から要確認へ落ちる。

### 修正5（小）: UIの根拠表示を実態に合わせる

対象: `index.html:7206-7212`, `:7260-7266`

```js
const rawAlignment = finding?.alignment_score ?? finding?.alignmentScore;
const alignment = rawAlignment === null || rawAlignment === undefined ? NaN : Number(rawAlignment);
if (deterministic || Number.isFinite(alignment)) { … }
```

- `alignment` 未取得なら箱そのものを出さない（`deterministic` も無ければ何も表示しない）。
- `deterministic` が無いのに箱を出すときのラベル「alignment候補」は、実測値がある場合にだけ意味を持つ。無い場合は「決定的検査なし」と明示するか、非表示にする。
- 併せて、日英ページの `alignment` は `js/reference-alignment.mjs` の語彙類似度では原理的に立たない。数値・固有名詞の一致など言語非依存の signal を足すか、翻訳整合性モードでは alignment を根拠欄から外す判断が要る（本修正の範囲外・別途）。

### 修正6（小）: 無変更・自己矛盾の関門を追加する

対象: 取り込み時の正規化（`index.html` の findings 取り込み）または `js/finding-quality.mjs`

カテゴリに依らず、次のいずれかに当たる指摘は drop または要確認へ降格する。

1. `suggestion_kind === "replacement"` かつ `normalizeQuote(quote) === normalizeQuote(suggestion)` → **drop**（置き換えても何も変わらない）。→ #8、#9 が二重に止まる。
2. 指摘文（`reason` / `issue_summary` / `suggestion`）の中で、`「A」または「B」` / `AまたはB` の A と B が同一文字列 → **drop**（自己矛盾）。→ #10。
3. `name_mismatch` / `terminology` で、`quote` から抽出した固有名詞トークンが `referenceQuote` にそのまま含まれている → **要確認へ降格**。

---

## 5. 検証結果（プロトタイプ）

スクラッチにコピーしたツリーで修正1・2・3を適用し、マスク後テキストに対して `isConclusiveNumericFalsePositive` を通した結果:

| # | 現行 | 修正1+2 | 修正1+2+3 |
|---|------|---------|-----------|
| 4 | KEEP | **DROP** | **DROP** |
| 5 | KEEP | **DROP** | **DROP** |
| 6 | KEEP | **DROP** | **DROP** |
| 7 | KEEP | **DROP** | **DROP** |
| 8 | KEEP | KEEP | KEEP（修正4で対応） |
| 9 | KEEP | KEEP | **DROP** |
| 14 | KEEP | KEEP | KEEP（修正4で要確認へ降格） |

回帰確認: 修正1・2を当てた状態で `app/_app/tools/Test-*.mjs` を全件実行し、**未適用時と結果が完全に一致**することを確認した（`Test-NumberMask` の「文中の項番を伏せない」「表の負値は伏せる」「日英の百万円・％・EPS列で同じ値に同じ記号が付く」を含む）。素の状態で失敗する4件（`Test-FixtureTextLayer` / `Test-PdfTextReconstruct` / `Test-ReportLauncher` / `Test-ResponseReader`）は実行環境依存で、変更前後とも同じ。

---

## 6. 追加すべきテスト

`tools/Test-NumberMask.mjs`

- `(419)億円` と `▲419億円` と EN `(419) oku` が同じ記号になる
- `(419)億円` をマスクしても閉じ括弧が残る（`(⟦#XXX⟧)億円`）
- `(20) oku` `(54) k yen` `(54)千円` が伏せられる
- 既存の `(1) 監視` `(1) 連結経営成績` `貸倒引当金 (603) (643)` は変わらない

`tools/Test-DeterministicFilters.mjs`

- 両側同一記号・同符号の number_mismatch は source 文脈が空でも drop
- 記号が違う（`areSymbolsCompatible` も偽）ときは drop しない
- 語順違いの多重集合一致は drop、表の列入れ替えは drop しない
- 引用が比較資料の部分集合のとき drop せず要確認へ降格

`tools/Test-FindingQuality.mjs`

- 修正案が原文と同一の replacement は drop
- 「「X」または「X」」形の自己矛盾指摘は drop

`tools/Test-ReportRender.mjs` / UI テスト

- `alignment_score` 未取得の指摘に「alignment 0.00」を表示しない

---

## 7. 本修正案でやらないこと

- **#1・#2 の判定**: 引用文（`Revenue was 12,857oku, Q1 ever.` / `・Publicity draft of FY27/3 financial forecast subordinated loan`）が英語PDFの原文どおりかを実物で確認していない。#2 は箇条書き2行が1行に連結された形で、`js/pdf-text-reconstruct.mjs` の行結合が原因の可能性があるが、対象PDFなしには断定できない。実物の抽出テキストで確認したうえで別途扱う。
- **`unknownIdentityLabelMismatch`（原因E）の日英対応**: 修正1〜4で記号一致が先に成立するため、本件の8件には効かない。日英ラベルの対応表を広げる／ラベル不一致を「証拠なし」として扱うといった変更は影響範囲が広く、別の計画で扱う。
- **`reference-alignment.mjs` の日英対応**: 語彙類似度が言語をまたげない件は根が深い。修正5は「無い値を0として見せない」ところまでに留める。
- **Copilot 側の出力品質**: `(54) k yen` を `(54,000) k yen` に直そうとする、`(72千) k yen` と日本語を混ぜる、`「20億円」` を `「20円」` と書くといった誤りはモデル側の生成品質の問題である。ただし入力（マスク済みテキスト）が日英で食い違っていたことが誤りの引き金なので、修正1〜2でこの種の指摘自体が出にくくなる見込みである。
