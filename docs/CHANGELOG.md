# 変更履歴（索引）

v94 の開発中に作成した個別の変更メモは `docs/changelog/` に原文のまま保管している。
以前は `_app/` 直下に置いていたが、利用者に配布する必要がないためリポジトリ側へ移した。

日付は各ファイルの最終更新日。

## 2026-08-20

### v95.2 — 添付入力の逐次化とログ詳細の安定化

- Copilotの単一ファイル入力を前提に、PROMPT・TEXTなどを1件ずつ別々の入力ノードへ設定し、固有の添付チップが確認できてから次へ進むようにした。入力ノードがSPAで置換されても毎回再取得し、最後に全ファイルのチップと非ビジー状態を安定確認する。
- Copilot画面が非表示・最小化中でも、Origin確認、キャンセル、残留添付の削除、チップの一対一対応を維持する。利用者が「依頼別の詳細」を開閉した状態は、定期的な進捗再描画で保持する。
- needs_user_visibility の paused 遷移で空のエラー文字列を受け取っても、ジョブを致命終了させない。

### v95 — バックグラウンド再接続と自動言語判定

- `recovery_ancestor_job_ids` の null・空配列・入れ子配列をサーバーで正規化し、有効なIDだけを検証するようにした。
- 再試行のブラウザ送信でも不正なancestor値を除外し、空のancestorフィールドを送らないようにした。
- 校正対象・比較資料の言語設定を削除し、PDF.jsが先頭5ページの抽出テキストから自動判定するようにした。
- 判定不能な画像PDFや混在文書は「その他」として扱い、PDF読み込みを妨げない。

### v95.1 — 添付検出・起動描画・安全な終了

- Copilotの添付チップから `aria-label`・`title`・`data-*`属性・表示文字も候補として読み取り、
  期待する各ファイルを別々に確認してから添付完了と判定するようにした。
- アップロード中・処理中の表示が消えた状態を2回連続で確認し、4/7で待ち続ける判定を避けるようにした。
- 起動中の描画を準備ゲートで隠し、準備失敗時はタイムアウト後に明示的なエラー画面を出すようにした。
- 画面右上の終了ボタンと `POST /__shutdown` を追加した。loopback・Origin・HTTPメソッドを検証し、
  実行中または復旧待ちのジョブがある場合は409で終了を拒否する。
- キャンセルを確認したジョブだけを job ID・chain ID 付きで ACK して終了時に破棄し、完了・エラー・中断中の保持結果や、欠落・null・別Originの終了要求は拒否する。

## 2026-07-14

| ファイル | 内容 |
|----------|------|
| `CHANGELOG_v94-chat-ui-detection-gate.txt` | チャットUI全要素未検出対策 |
| `CHANGELOG_v94-copilot-screen-ready-gate.txt` | Copilot画面準備ゲート |
| `CHANGELOG_v94-offsetParent-ecm-port.txt` | offsetParent排除・ECM方式移植 |

## 2026-07-13

| ファイル | 内容 |
|----------|------|
| `CHANGELOG_model_priority.txt` | モデル優先度選択対応（GPT 5.6 Think deeper → Opus → Think Deeper）。添付完了検出Rev.2、待機可視化、応答取得堅牢化、指摘品質検証、ビューアUI刷新までを含む最も分量の多いメモ |
| `CHANGELOG_v94-copilot-flash-elimination.txt` | Copilot画面フラッシュ根絶 |
| `CHANGELOG_v94-interruption-recovery-log.txt` | 応答中断対策・ログ簡潔化 |
| `CHANGELOG_v94-json-repair-edge-offscreen.txt` | 壊れたJSON修復・不完全ループ脱出・Edge背面起動 |
| `CHANGELOG_v94-packet-completeness-font.txt` | パケット応答完全性・文字サイズ修正 |
| `CHANGELOG_v94-startup-auto-multiref.txt` | 起動堅牢化・全自動UI・複数参考PDF |
| `CHANGELOG_v94-startup-syntax-fix.txt` | 起動不能・構文エラー修正 |
| `CHANGELOG_v94-viewer-font-scale.txt` | ビューアフォント拡大 |
| `CHANGELOG_v94-viewer-uiux-rev2.txt` | 指摘ビューア UI/UX Rev.2 |
| `CHANGELOG_v94-viewer-uiux-rev4.txt` | 指摘ビューア UI/UX Rev.4 |
| `CHANGELOG_v94-ws-only-default-exclusion.txt` | 空白のみ差分（体裁指摘）の既定除外 |

## 2026-07-03

| ファイル | 内容 |
|----------|------|
| `CHANGELOG_v94-phase1.txt` | Phase 1 — Copilot自動化基盤（サーバー側） |
| `CHANGELOG_v94-phase2.txt` | Phase 2 — 自動校正のUI配線 |
| `CHANGELOG_v94-phase2_fix1.txt` | Phase 2 fix1 — 長文依頼文の送信失敗対策 |
| `CHANGELOG_v94-phase2_fix2.txt` | Phase 2 fix2 — 安定待ちの既定廃止・モデル選択 |
| `CHANGELOG_v94-phase3.txt` | Phase 3 — UI/UX再設計（Apple白基調 × Linearミニマル）＋リトライ |

---

## これ以降の運用

Git管理に移行したため、今後の変更はコミットメッセージと Pull Request で追う。
個別のテキストメモを新規に作る必要はない。まとまった改修を行った場合のみ、
このファイルの先頭に節を追加する形で要点を残す。

### v95（網羅性改善の継続項目）

`docs/plans/PDF校正アシスト_網羅性改善_修正計画書_V1.md` の Phase 0〜7 に沿った
指摘網羅性の改善。着手時にここへ追記する。
