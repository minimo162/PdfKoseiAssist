PDF校正アシスト 起動トラブル時の確認

初回は「PDF校正アシスト_初回セットアップ.cmd」を実行し、毎回はPDFを選んで「送る」から校正します。
画面で作業するときは「PDF校正アシスト起動.cmd」を実行します。
起動しない場合は、_app\startup-log.txt を確認してください。
詳細を画面で確認するには、_app\debug-start-visible-console.cmd を実行します。
手動パケット作成・JSON貼り戻しなどの復旧UIは、起動URLの末尾に ?advanced=1 を付けた場合だけ表示されます。

Copilot画面が必要なときは、トレイの「Copilot画面を表示」、またはアプリ画面の同名ボタンを使います。
「送る」での校正は画面外で進み、結果のレポートだけが自動で開きます。

解決しない場合は、症状（ブラウザが開かない／白画面／Copilot準備中のまま／エラーダイアログ）と、startup-log.txt および %USERPROFILE%\.pdf-kosei-ps\logs\pdf-kosei.log の先頭20行を共有してください。

配布前のPowerShell構文検査:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\Syntax-Check.ps1
