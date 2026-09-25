@echo off
chcp 65001 >nul
pushd "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0_app\Setup-KoseiAssist.ps1"
popd
exit /b
