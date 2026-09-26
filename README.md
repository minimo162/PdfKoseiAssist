# PDF校正アシスト

PDFの校正（英語単体校正・日本語版との翻訳整合性チェック）を、Microsoft 365 Copilot の
ブラウザ自動化（CDP）で半自動化するローカルツール。

- 実行環境: Windows / PowerShell 5.1 / Microsoft Edge（管理者権限なし）
- 現行バージョン: v95.5
- 配布形態:
  - 管理者が共有フォルダに展開済みの版を置く
  - 利用者は共有フォルダの初回セットアップで「送る」に登録する
  - 毎回はPDFを選んで右クリック →「送る」→「PDF校正アシストで校正」
  - アプリは利用者ごとの `%LOCALAPPDATA%\PdfKoseiAssist` に写してから動く

## どこから読むか

| 立場 | 読むところ |
|------|------------|
| 使う人（利用者） | `app/はじめにお読みください.txt`（共有フォルダにも同じものがあります）。要点はこの下の「「送る」で校正する」 |
| 配る人（管理者） | 「[共有フォルダでの配布と更新](#共有フォルダでの配布と更新)」 |
| 開発する人 | 「[開発の流れ](#開発の流れ)」「[検査コマンド](#検査コマンド)」「[この構成を扱うときの注意](#この構成を扱うときの注意)」 |

---

## 「送る」で校正する

1. 共有フォルダの`PDF校正アシスト_初回セットアップ.cmd`を実行します（自分のパソコンへコピーしない）。Copilot へは Windows にサインインしている会社のアカウントで自動的につながります（Microsoft Entra ID に参加・登録したPC）。自動でつながらないときだけ、専用のEdgeでサインインします。
2. 英文PDFと日本語原稿PDFを同じフォルダに置き、2つを選んで右クリック →「送る」→「PDF校正アシストで校正」を選びます。英文だけなら1つ選びます。
3. 進捗はタスクトレイで確認できます。中止やCopilot画面の表示もトレイのメニューから行います。
4. 元PDFの隣に`<対象名>_校正結果`が保存され、Edgeでレポートが開きます。既存の結果があれば` (2)`などの連番で保存します。

Windows 11では「その他のオプションを確認」（またはShift＋右クリック）の中に「送る」があります。
あとで開くときや他の人へ渡すときは、結果フォルダの`指摘レポートを開く.cmd`を使います。HTMLを共有フォルダから直接開くとIEモードになる場合があります。確認済みの印は`_data/確認状況.json`に保存されます。共有にはフォルダ一式を使い、メール用にZIP化した場合は受け手に「すべて展開」してもらってください。

画面で確認しながら作業する場合は、従来の`PDF校正アシスト起動.cmd`を使います。画面からのレポート保存もフォルダ保存になり、対応していないブラウザーではZIPに切り替わります。起動CMDへPDFをドロップする入口もありますが、`& % ^`を含むパスは「送る」を使ってください。

更新は管理者が共有フォルダへ上書きするだけで、利用者の作業はありません（下の「共有フォルダでの配布と更新」）。「送る」からの削除は初回セットアップを再実行して選べます。

`drop_open_report=false`にすると、完了時にレポートの代わりに結果フォルダがエクスプローラーで開きます。

## 共有フォルダでの配布と更新

管理者が共有フォルダに展開済みの版を置き、利用者はそこから使います。利用者のパソコンへ配る必要はありません。

- 入口（初回セットアップ・起動CMD・「送る」）はすべて`_app/Launch-KoseiAssist.ps1`を通ります。入口は共有フォルダの版を`_app/release-manifest.json`（ファイル一覧とSHA-256）と照合しながら、利用者ごとの`%LOCALAPPDATA%\PdfKoseiAssist\versions\<版>`へ写し、その写しで起動します。共有フォルダ上のファイルを直接実行・配信することはありません。
- 更新は共有フォルダへ上書きするだけです。利用中でも構いません。利用者は次に起動したときに新しい版へ切り替わります。アプリ（ローカルサーバー）が動いている間は、その版を使い続けます。上書きの途中に起動した人は、照合が合わないので前の版のまま動きます。
- 共有フォルダにつながらないときは、手元の最後の版で動きます。手元には新しい2つの版と、動作中の版だけを残します。
- 設定は共有フォルダの`_app/config/settings.json`を、つながるたびに手元へ写します（一覧には入れないので、管理者が直接書き換えられます）。
- 共有フォルダには書き込みません。URL・PID・起動ログは`%USERPROFILE%\.pdf-kosei-ps`の`runtime`・`logs`に書きます。利用者は共有フォルダの読み取り権限だけで使えます。
- 「送る」は`%LOCALAPPDATA%\PdfKoseiAssist\Launch-KoseiAssist.ps1 -Entry Drop`を指します。以前の版の登録（`Start-DropReview.ps1`を直接指すもの）は、次に使ったときに自動でこちらへ向け直します。
- 配置は`tools\Package-Release.ps1 -DeployTo \\fileserver\共有\PDF校正アシスト`で行えます（`release-manifest.json`を最後に書き、`config\settings.json`には触れません）。作ったZIPを共有フォルダへ上書き展開しても同じです。
- `release-manifest.json`の無い作業コピー（このリポジトリ）では、入口は写さずにその場で起動します。

## リポジトリ構成

```
.
├─ app/                        ← 配布物そのもの。ZIPの中身はこのディレクトリの内容
│  ├─ PDF校正アシスト_初回セットアップ.cmd  「送る」の登録・削除とサインイン確認
│  ├─ PDF校正アシスト起動.cmd   画面での校正。PDF引数があれば非表示の校正
│  └─ _app/
│     ├─ Launch-KoseiAssist.ps1 すべての入口。共有フォルダの版を手元へ写してから起動
│     ├─ Start-DropReview.ps1   「送る」からの校正・結果フォルダの保存
│     ├─ Setup-KoseiAssist.ps1  初回セットアップ
│     ├─ VERSION               アプリ版の唯一の情報源
│     ├─ Start-KoseiAssist.ps1  起動エントリ。src/*.ps1 を構文検査してから dot-source
│     ├─ index.html             UI本体（単一ファイル。4MB超）
│     ├─ README.txt             利用者向けの起動トラブル対応
│     ├─ debug-start-visible-console.cmd
│     ├─ config/
│     │  └─ settings.template.json
│     ├─ src/
│     │  ├─ Paths.ps1           ルート解決・ログ
│     │  ├─ Settings.ps1        既定値 + settings.json のマージ
│     │  ├─ CopilotClient.ps1   Edge起動・CDP・添付・モデル選択・応答待機・JSON抽出
│     │  ├─ ReviewJob.ps1       校正ジョブ（runspace非同期・パケット直列処理）
│     │  └─ Server.ps1          ローカルHTTPサーバー + /api/review/*
│     ├─ tools/                 構文検査・単体テスト
│     ├─ pdfjs/                 PDF.js 5.6.205（同梱）
│     └─ pdflib/                pdf-lib（同梱）
│
├─ docs/
│  ├─ CHANGELOG.md              変更履歴の索引
│  ├─ changelog/                v94 の個別変更メモ（元は _app 直下にあったもの）
│  ├─ THIRD_PARTY.md            同梱ライブラリとライセンス
│  └─ plans/                    改修計画書・仕様書
│
├─ legacy/                      未使用の旧実装と旧起動スクリプト（.vbs）
├─ tools/
│  ├─ Verify-Repo.ps1           構文検査・必須/禁止ファイル検査・BOM検査
│  └─ Package-Release.ps1       配布ZIPの生成（UTF-8ファイル名フラグ付き）
├─ .gitattributes               改行・エンコーディングの自動変換を全面禁止
└─ .gitignore
```

### 前バージョンのZIPから除いたもの

| 除いたファイル | 理由 |
|----------------|------|
| `_app/local-app.pid` / `local-app.url` | 起動時に生成される実行時ファイル |
| `_app/startup-log.txt` / `powershell-output.txt` | 実行時ログ |
| `_app/CHANGELOG_*.txt`（20件） | `docs/changelog/` へ移動。利用者に配る必要がない |
| `_app/server.ps1` / `_app/server.js` | 旧実装。`src/Server.ps1` が置換済みで起動経路から参照されていない。`legacy/` に保管 |

`legacy/` と `docs/` は配布ZIPには含まれない（`tools/Package-Release.ps1` が `app/` のみを対象にする）。

---

## 開発の流れ

```
git pull
  ↓
編集（app/_app/ 配下）
  ↓
app\PDF校正アシスト起動.cmd で実機動作確認   ← Windows + Edge が必要
  ↓
powershell -NoProfile -ExecutionPolicy Bypass -File tools\Verify-Repo.ps1
  ↓
git commit / push
  ↓
powershell -NoProfile -ExecutionPolicy Bypass -File tools\Package-Release.ps1
  ↓
共有フォルダへ配置（-DeployTo \\fileserver\共有\PDF校正アシスト。dist\ のZIPを上書き展開しても可）
```

コミット前に、`git status` に `config/settings.json` や `release-manifest.json` が出ていないことを
確認する。出ている場合は `.gitignore` が効いていない。

### 初回セットアップ（クローン直後）

`config/settings.json` は利用者ごとの設定で、リポジトリには入っていない。既定値のままで
動くため通常は不要だが、設定を変える場合はテンプレートをコピーして作る。

```powershell
Copy-Item app\_app\config\settings.template.json app\_app\config\settings.json
```

### 言語判定とバックグラウンド校正

校正対象と比較資料の言語は設定ファイルで指定しません。PDF.js が各PDFの先頭5ページから
抽出したテキストをローカルで判定し、判定結果をCopilotへの依頼文に反映します。画像だけの
PDFや判定が拮抗する文書は「その他」として扱い、読み込みや校正開始を止めません。

校正開始後は、画面を閉じたり別のアプリへ移ったりしても、ローカルのPowerShellサーバーが
ジョブを保持します。画面を戻すと同じ対象PDFのジョブを再接続して結果を取り込みます。
再試行時の `recovery_ancestor_job_ids` はサーバー側でも空配列・null・入れ子配列を正規化し、
有効なジョブIDだけをリカバリーチェーンに引き継ぎます。

添付の完了待ちは、Copilotの添付チップに表示されるファイル名を、設定済みの要素だけでなく
`aria-label`・`title`・`data-*`属性・表示文字からも読み取ります。現行M365の `focusgroup="toolbar …"`
添付リストと `data-overflow-item="true"` の各チップも認識し、外側の集約ラッパーを1件として数えません。
期待するファイルを1件ずつ入力へ渡し、各ファイル固有のチップが現れてから次のファイルへ進みます。最後に期待するファイルをすべて別々のチップとして
確認し、アップロード中の表示が消えて2回連続で安定してから次へ進みます。同名ファイルを複数添付すると
チップを区別できないため、ファイル名を変えてください。

「依頼別の詳細」は校正中の進捗更新で開閉状態を保ちます。内容を読みたいときに開いたままにでき、
閉じた後に自動で開き直すこともありません。新しいジョブを開始すると、前のジョブの開閉状態はリセットされます。

起動直後は準備が完了するまで画面を表示せず、途中の描画が点滅しないようにしています。準備に
時間がかかりすぎた場合はエラー画面を表示するので、真っ白な画面のままにはなりません。画面右上の
「アプリを終了」は確認後に利用できます。校正中は先にジョブを停止し、実行中または復旧待ちのジョブが
残っている場合はサーバーを終了せず理由を画面に表示します。

### 実行時に生成されるもの（リポジトリ外）

| パス | 内容 |
|------|------|
| `%USERPROFILE%\.pdf-kosei-ps\logs\pdf-kosei.log` | アプリログ |
| `%USERPROFILE%\.pdf-kosei-ps\runtime\answers\` | Copilot回答JSON・raw・診断（7日で自動削除） |
| `%USERPROFILE%\.pdf-kosei-ps\runtime\copilot-warmup.json` | ウォームアップ状態 |
| `%USERPROFILE%\.pdf-kosei-ps\runtime\refusal-stats.csv` | 応答拒否の統計 |
| `%LOCALAPPDATA%` 配下のEdgeプロファイル | Copilot専用Edgeのプロファイル |

---

## 検査コマンド

```powershell
# リポジトリ全体の検査（構文・必須ファイル・禁止ファイル・BOM）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\Verify-Repo.ps1

# PowerShell構文検査のみ（従来どおり）
powershell -NoProfile -ExecutionPolicy Bypass -File app\_app\tools\Syntax-Check.ps1

# 空白のみ差分判定の単体テスト（Node.js がある場合）
node app\_app\tools\Test-WsOnlyFinding.mjs

# Copilot添付の完了検出（Node.js がある場合）
node app\_app\tools\Test-AttachmentVisibility.mjs

# 起動ゲート・終了UI・終了APIの安全条件（Node.js がある場合）
node app\_app\tools\Test-ShutdownEndpoint.mjs
```

---

## この構成を扱うときの注意

1. **`.gitattributes` の `* -text` を外さない。** `.ps1` は UTF-8 BOM 付きで、
   PowerShell 5.1 は BOM の有無で日本語の扱いが変わる。Git に改行変換をさせると
   配布物が壊れる。
2. **配布ZIPは必ず `tools/Package-Release.ps1` で作る。** エクスプローラーの
   「送る > 圧縮フォルダー」や自作のzip処理では、ファイル名を UTF-8 で書いても
   汎用目的ビット11（言語エンコーディングフラグ）が立たず、日本語Windowsが
   CP932と誤解して `PDF校正アシスト起動.cmd` が文字化け展開される（＝起動不能）。
   このスクリプトは `ZipFile.Open(..., [Text.Encoding]::UTF8)` を使ってフラグを立てる。
3. **`index.html` は4MBを超える単一ファイル。** うち約3.5MBは、数十万〜百数十万文字の
   長大な base64 の行3本（`REPORT_PDFJS_LIB_B64_CHUNKS`・`REPORT_PDFJS_WORKER_B64_CHUNKS`・
   `REPORT_CMAP_B64_FILES`。PDF.js本体・worker・cmaps。HTMLビューア単体出力のため）。
   行番号は編集のたびに変わるので、探すときは変数名で検索する。PDF.jsを
   更新しない限り差分に出ないので、通常の編集は問題なく差分が読める。将来的に
   別ファイル化＋ビルド手順の導入を検討する余地はあるが、現状は単一ファイルで
   完結する利点（共有フォルダに置くだけで動く）を優先している。
4. **`legacy/` は消しても動作に影響しない。** 参照が無いことを確認済み
   （`src/Server.ps1` の冒頭コメントに「旧 server.ps1 の置換」と明記されている）。

---

## 関連ドキュメント

- `docs/plans/PDF校正アシスト_網羅性改善_修正計画書_V1.md` — Copilotの指摘網羅性を上げる改修計画（Phase 0〜7）
- `docs/CHANGELOG.md` — 変更履歴の索引（v95 以降の版ごとの要約と、`docs/changelog/` に保管した v94 の個別変更メモの一覧）
- `docs/THIRD_PARTY.md` — 同梱ライブラリとライセンス
