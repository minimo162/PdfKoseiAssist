# 同梱している第三者ライブラリ

社内共有フォルダに置くだけで動作させるため、依存ライブラリは全て同梱している
（オフライン完結／CDN参照なし）。

| ライブラリ | バージョン | ライセンス | 配置 | 用途 |
|------------|-----------|-----------|------|------|
| PDF.js | 5.6.205 | Apache License 2.0 | `app/_app/pdfjs/` | PDFの表示・ページ画像化・テキストレイヤー抽出 |
| pdf-lib | 同梱版（`pdf-lib.esm.min.js`） | MIT | `app/_app/pdflib/` | 確認用パケットPDFの生成・ページ結合 |

ライセンス原文の所在:

- PDF.js: `app/_app/pdfjs/LICENSE`
- PDF.js の WASM 依存（JBIG2 / OpenJPEG / QCMS）: `app/_app/pdfjs/wasm/LICENSE_*`
- pdf-lib: `app/_app/pdflib/LICENSE.md`

## `index.html` への埋め込みについて

`app/_app/index.html` には、HTMLビューアを単体ファイルとして書き出す機能のために
PDF.js 本体・worker・cmaps を base64 で埋め込んでいる（758 / 759 / 808 行目）。
`app/_app/pdfjs/` 配下と同じバージョンの複製であり、PDF.js を更新する際は
**両方を同時に差し替える**必要がある。

更新手順:

1. `app/_app/pdfjs/` を新バージョンで置き換える
2. `index.html` の `REPORT_PDFJS_LIB_B64_CHUNKS` / `REPORT_PDFJS_WORKER_B64_CHUNKS` /
   `REPORT_CMAP_B64_FILES` を再生成して差し替える
3. `tools\Verify-Repo.ps1` を実行
4. 実機で「PDF読み込み → パケットZIP作成 → HTMLビューア書き出し」を通して確認する
