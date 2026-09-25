# PDF校正アシスト

PDFの校正（英語単体校正・日本語版との翻訳整合性チェック）を、Microsoft 365 Copilot の
ブラウザ自動化（CDP）で半自動化するローカルツール。

- 実行環境: Windows / PowerShell 5.1 / Microsoft Edge（管理者権限なし）
- 現行バージョン: v95.5
- 配布形態: ZIPを展開し、初回セットアップで「送る」に登録。毎回はPDFを選んで右クリック →「送る」→「PDF校正アシストで校正」

---

## 「送る」で校正する

1. ZIPをすべて展開し、`PDF校正アシスト_初回セットアップ.cmd`を実行します。必要ならEdgeでサインインします。
2. 英文PDFと日本語原稿PDFを同じフォルダに置き、2つを選んで右クリック →「送る」→「PDF校正アシストで校正」を選びます。英文だけなら1つ選びます。
3. 進捗はタスクトレイで確認できます。中止やCopilot画面の表示もトレイのメニューから行います。
4. 元PDFの隣に`<対象名>_校正結果`が保存され、Edgeでレポートが開きます。既存の結果があれば` (2)`などの連番で保存します。

Windows 11では「その他のオプションを確認」（またはShift＋右クリック）の中に「送る」があります。
あとで開くときや他の人へ渡すときは、結果フォルダの`指摘レポートを開く.cmd`を使います。HTMLを共有フォルダから直接開くとIEモードになる場合があります。確認済みの印は`_data/確認状況.json`に保存されます。共有にはフォルダ一式を使い、メール用にZIP化した場合は受け手に「すべて展開」してもらってください。

画面で確認しながら作業する場合は、従来の`PDF校正アシスト起動.cmd`を使います。画面からのレポート保存もフォルダ保存になり、対応していないブラウザーではZIPに切り替わります。起動CMDへPDFをドロップする入口もありますが、`& % ^`を含むパスは「送る」を使ってください。

更新時は起動中のアプリを「アプリを終了」で閉じ、同じフォルダへ新版ZIPを上書き展開します。別フォルダへ展開した場合は、新版を一度起動するか初回セットアップを実行してから旧フォルダを削除してください。登録済みの「送る」は新版へ修復され、旧版を起動しても戻りません。削除は初回セットアップを再実行して選べます。

`drop_open_report=false`にすると、完了時にレポートの代わりに結果フォルダがエクスプローラーで開きます。

## リポジトリ構成

```
.
├─ app/                        ← 配布物そのもの。ZIPの中身はこのディレクトリの内容
│  ├─ PDF校正アシスト_初回セットアップ.cmd  「送る」の登録・削除とサインイン確認
│  ├─ PDF校正アシスト起動.cmd   画面での校正。PDF引数があれば非表示の校正
│  └─ _app/
│     ├─ Start-DropReview.ps1   「送る」からの校正・結果フォルダの保存
│     ├─ Setup-KoseiAssist.ps1  初回セットアップ
│     ├─ VERSION               アプリ版の唯一の情報源
│     ├─ Start-KoseiAssist.ps1  起動エントリ。src/*.ps1 を構文検査してから dot-source
│     ├─ index.html             UI本体（単一ファイル。約4MB）
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

## GitHub への初回登録

GitHub上で **Private** リポジトリを作成してから、ローカルで以下を実行する。

```powershell
cd <このフォルダ>
git init
git branch -M main
git add -A
git commit -m "Initial commit: PDF校正アシスト v94"
git remote add origin https://github.com/<account>/PdfKoseiAssist.git
git push -u origin main
```

**コミット前に必ず確認すること**: `git status` に `local-app.url` / `startup-log.txt` /
`config/settings.json` が出ていないこと。出ている場合は `.gitignore` が効いていない。

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
powershell -NoProfile -ExecutionPolicy Bypass -File tools\Package-Release.ps1 -Version v95.4
  ↓
dist\ のZIPを共有フォルダへ配布
```

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
3. **`index.html` は約4MBの単一ファイル。** うち約3.8MBは758/759/808行目の base64
   埋め込み（PDF.js本体・worker・cmaps。HTMLビューア単体出力のため）。PDF.jsを
   更新しない限り差分に出ないので、通常の編集は問題なく差分が読める。将来的に
   別ファイル化＋ビルド手順の導入を検討する余地はあるが、現状は単一ファイルで
   完結する利点（共有フォルダに置くだけで動く）を優先している。
4. **`legacy/` は消しても動作に影響しない。** 参照が無いことを確認済み
   （`src/Server.ps1` の冒頭コメントに「旧 server.ps1 の置換」と明記されている）。

---

## 関連ドキュメント

- `docs/plans/PDF校正アシスト_網羅性改善_修正計画書_V1.md` — Copilotの指摘網羅性を上げる改修計画（Phase 0〜7）
- `docs/CHANGELOG.md` — v95.3 の変更履歴索引
- `docs/THIRD_PARTY.md` — 同梱ライブラリとライセンス
