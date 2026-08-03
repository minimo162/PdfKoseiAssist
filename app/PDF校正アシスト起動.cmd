@echo off
rem PDF校正アシスト 起動スクリプト（CMD版）
rem VBScript は将来の Windows で廃止予定のため、こちらを既定の起動方法とする。
rem このファイルは UTF-8（BOMなし）。日本語メッセージのため chcp 65001 を先に実行する。
rem 日本語を含む固定パスは書かない（文字コードに依存させない）。
chcp 65001 >nul
setlocal

set "PS1=%~dp0_app\Start-KoseiAssist.ps1"
if not exist "%PS1%" (
  echo _app\Start-KoseiAssist.ps1 が見つかりません。
  echo   %PS1%
  echo ZIPを展開したフォルダーごと、このファイルと _app フォルダーを同じ場所に置いてください。
  pause
  exit /b 1
)

rem UNCパス（\\server\share\...）でも動くよう、pushd で一時ドライブに割り当てる。
pushd "%~dp0" 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"
popd 2>nul

if not "%RC%"=="0" (
  echo.
  echo 起動に失敗しました。終了コード: %RC%
  pause
)
exit /b %RC%
