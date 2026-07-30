# legacy — 未使用の旧実装

ここにあるファイルは**現在の起動経路から参照されていない**。配布ZIPにも含まれない
（`tools/Package-Release.ps1` は `app/` のみを対象にする）。

Git管理に移行する前は `_app/` 直下に残っていたため、履歴として一旦ここへ移した。
内容を参照する必要がなくなった時点でフォルダごと削除して構わない。

| ファイル | 内容 | 置き換え先 |
|----------|------|-----------|
| `server.ps1` | 静的配信のみのローカルHTTPサーバー（PowerShell / TcpListener） | `app/_app/src/Server.ps1` |
| `server.js` | Node.js 版のローカルサーバー | 同上 |

## 参照されていないことの根拠

- 起動エントリは `app/_app/Start-KoseiAssist.ps1` で、`src/Paths.ps1` → `Settings.ps1` →
  `CopilotClient.ps1` → `ReviewJob.ps1` → `Server.ps1` を dot-source する。
  `server.ps1` / `server.js` を呼ぶ処理はない。
- `app/_app/src/Server.ps1` の冒頭コメントに「旧 server.ps1（静的配信のみ）の置換」と
  明記されている。
- `src/Server.ps1` は `/api/review/jobs` などのAPIを持つが、`server.ps1` は
  「no server-side POST API is required」と書かれた静的配信専用で、
  v94 の自動校正機能に対応していない。
