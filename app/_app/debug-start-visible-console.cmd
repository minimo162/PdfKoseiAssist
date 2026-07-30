@echo off
setlocal
cd /d "%~dp0"
echo PDF Kosei Assist debug start
echo 起動しない場合は、このコンソールと startup-log.txt を確認してください。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-KoseiAssist.ps1" -NoBrowser -NoWarmup
echo.
echo If the app did not open, check startup-log.txt and powershell-output.txt.
pause
