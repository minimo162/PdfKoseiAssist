@echo off
chcp 65001 >nul
if not exist "%~dp0_app\Setup-KoseiAssist.ps1" (
  echo セットアップに必要なファイルが見つかりません。
  echo ZIPファイルを右クリックして「すべて展開」を選び、展開したフォルダーの中の
  echo 「PDF校正アシスト_初回セットアップ.cmd」をダブルクリックしてください。
  pause
  exit /b 1
)
pushd "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0_app\Setup-KoseiAssist.ps1"
popd
exit /b
