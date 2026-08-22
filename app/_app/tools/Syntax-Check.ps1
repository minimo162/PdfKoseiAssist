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
# K15: dead parameter だった SkipFreshChatWait の再導入を全 .ps1 で禁止（ChatMode を使う）。
# このチェッカ自身は語を含むため除外する。
$bannedToken = 'SkipFreshChat' + 'Wait'
foreach ($file in $files) {
    if ($file.Name -eq 'Syntax-Check.ps1') { continue }
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    if ($content -match $bannedToken) {
        $failures.Add(($file.FullName + (' : {0} の参照を検出しました。ChatMode(New/Reuse/RestartWithContext) を使用してください。' -f $bannedToken)))
    }
}
if ($failures.Count -eq 0) {
    $runtimePolicyTest = Join-Path (Join-Path $Root 'tools') 'Test-RuntimeHtmlPolicy.ps1'
    if (Test-Path -LiteralPath $runtimePolicyTest -PathType Leaf) {
        try { & $runtimePolicyTest }
        catch { $failures.Add(($runtimePolicyTest + ': ' + $_.Exception.Message)) }
    }
}
if ($failures.Count -gt 0) {
    Write-Host ('PowerShell syntax check: FAIL ({0} errors)' -f $failures.Count) -ForegroundColor Red
    $failures | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    exit 1
}
Write-Host ('PowerShell syntax check: PASS ({0} files)' -f $files.Count) -ForegroundColor Green
exit 0
