@echo off
chcp 65001 >nul
if not exist "%~dp0_app\Launch-KoseiAssist.ps1" (
  echo セットアップに必要なファイルが見つかりません。
  echo 共有フォルダーにある「PDF校正アシスト_初回セットアップ.cmd」を、そのままダブルクリックしてください。
  echo 共有フォルダーの場所が分からないときは、管理者に確認してください。
  pause
  exit /b 1
)
pushd "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0_app\Launch-KoseiAssist.ps1" -Entry Setup
popd
exit /b
