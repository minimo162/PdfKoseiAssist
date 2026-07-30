param([string]$Root = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]
$files = @(Get-ChildItem -LiteralPath $Root -Filter '*.ps1' -File -Recurse | Sort-Object FullName)
foreach ($file in $files) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    foreach ($parseError in @($errors)) {
        $failures.Add(('{0}:{1}: {2}' -f $file.FullName, $parseError.Extent.StartLineNumber, $parseError.Message))
    }
}
$copilotClientPath = Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1'
if (Test-Path -LiteralPath $copilotClientPath) {
    $copilotClient = [System.IO.File]::ReadAllText($copilotClientPath, [System.Text.Encoding]::UTF8)
    if ($copilotClient -match 'offsetParent') {
        $failures.Add(($copilotClientPath + ': offsetParent の再導入を検出しました。rect + computedStyle 判定を使用してください。'))
    }
}
if ($failures.Count -gt 0) {
    Write-Host ('PowerShell syntax check: FAIL ({0} errors)' -f $failures.Count) -ForegroundColor Red
    $failures | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    exit 1
}
Write-Host ('PowerShell syntax check: PASS ({0} files)' -f $files.Count) -ForegroundColor Green
exit 0
