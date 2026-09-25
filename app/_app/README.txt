PDF校正アシスト 起動トラブル時の確認

初回は「PDF校正アシスト_初回セットアップ.cmd」を実行し、毎回はPDFを選んで「送る」から校正します。
画面で作業するときは「PDF校正アシスト起動.cmd」を実行します。
起動しない場合は、%USERPROFILE%\.pdf-kosei-ps\logs\startup-log.txt を確認してください。
共有フォルダの版を手元（%LOCALAPPDATA%\PdfKoseiAssist）へ写す段階の記録は、同じフォルダの launcher.log にあります。
詳細を画面で確認するには、_app\debug-start-visible-console.cmd を実行します。
手動パケット作成・JSON貼り戻しなどの復旧UIは、起動URLの末尾に ?advanced=1 を付けた場合だけ表示されます。

Copilot画面が必要なときは、トレイの「Copilot画面を表示」、またはアプリ画面の同名ボタンを使います。
「送る」での校正は画面外で進み、結果のレポートだけが自動で開きます。

画面での校正で、添付中の「4/7」などから進まない場合:
  Copilot側の添付チップに、期待するファイル名が表示されているかを確認してください。
  添付はファイルを1件ずつ渡し、対応するファイル名チップを確認してから次へ進みます。
  揃っていなければ、画面を再読み込みしてからもう一度試してください。
  添付完了は表示名・ラベルなど複数の表示方法で検出しますが、
  同名ファイルを複数添付した処理は区別できません。

送信内容（copilot_attach_mode）:
  既定は masked-text です。本文テキストだけを送り、PDFは添付しません。
  金額・数値は ⟦#ABC⟧ 形式に伏せ、復元と対応表の保持はこのPC内だけで行います。

解決しない場合は、症状（ブラウザが開かない／白画面／Copilot準備中のまま／エラーダイアログ）と、%USERPROFILE%\.pdf-kosei-ps\logs の startup-log.txt・launcher.log・pdf-kosei.log の末尾20行を共有してください。

配布前のPowerShell構文検査:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\Syntax-Check.ps1
