PDF校正アシスト v95.2 — 起動トラブル時の確認

通常は「PDF校正アシスト起動.cmd」を実行します。
（「PDF校正アシスト起動.vbs」も同梱していますが、VBScript は Windows で廃止予定のため .cmd を使ってください。）
起動しない場合は、_app\startup-log.txt を確認してください。
詳細を画面で確認するには、_app\debug-start-visible-console.cmd を実行します。
手動パケット作成・JSON貼り戻しなどの復旧UIは、起動URLの末尾に ?advanced=1 を付けた場合だけ表示されます。
自動校正カードの「依頼別の詳細」は、ログ更新中も開閉状態を保持します。閉じた場合も、次の更新で勝手に開きません。

Copilot専用Edgeは既定で画面外起動後に最小化されます。サインインや動作確認で表示したい場合は、PDF校正アシスト上部の「Copilot画面を表示」ボタンを使用してください。タスクバーから直接復元すると画面外座標に戻る場合があるため非推奨です。ボタンで表示した後は、校正ジョブのパケット間で勝手に再最小化しません。

解決しない場合は、症状（ブラウザが開かない／白画面／Copilot準備中のまま／エラーダイアログ）と、startup-log.txt および %USERPROFILE%\.pdf-kosei-ps\logs\pdf-kosei.log の先頭20行を共有してください。

配布前のPowerShell構文検査:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\Syntax-Check.ps1
