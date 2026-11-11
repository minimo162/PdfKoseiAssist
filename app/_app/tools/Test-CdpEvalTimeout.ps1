$ErrorActionPreference = 'Stop'
# 「CDP応答タイムアウト：Runtime.evaluate」対策（読み取りの1回やり直し・モデル選択の持ち時間）。
# 実際の Edge は起動しない。WebSocket の境目だけを差し替え、製品の CopilotClient.ps1 の関数をそのまま通す。
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'src'
$script:checks = 0
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $script:checks++; Write-Host "PASS $Name"
}

# --- 1. 応答タイムアウトの判定 -------------------------------------------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    $record = { param($e) try { throw $e } catch { $_ } }
    Assert-Case (Test-KoseiCdpResponseTimeout -ErrorRecord (& $record 'CDP応答タイムアウト: Runtime.evaluate')) 'plain timeout text is a response timeout'
    # PR #233 の形（種別付き・秒数入り・さらに段階付きで包み直し）でも判定できる。
    $inner = New-Object System.Exception('CDP応答タイムアウト（20秒）: Runtime.evaluate')
    $wrapped = New-Object System.Exception('Copilot（Edge）との接続でエラーが発生しました（段階: sending）', $inner)
    Assert-Case (Test-KoseiCdpResponseTimeout -ErrorRecord (& $record $wrapped)) 'wrapped timeout is found through InnerException'
    Assert-Case (-not (Test-KoseiCdpResponseTimeout -ErrorRecord (& $record 'CDP WebSocket受信失敗: closed'))) 'socket failure is not a response timeout'
    Assert-Case (-not (Test-KoseiCdpResponseTimeout -ErrorRecord (& $record 'JavaScript evaluation failed: {}'))) 'page-side JS exception is not a response timeout'
    Assert-Case (-not (Test-KoseiCdpResponseTimeout -ErrorRecord $null)) 'null is not a response timeout'
}

# --- 2. 読み取り専用の評価は、応答タイムアウトのときだけ1回やり直す ------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    function Start-Sleep {}

    $script:calls = 0
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) $script:calls++; if ($script:calls -eq 1) { throw 'CDP応答タイムアウト: Runtime.evaluate' }; 'ok' }
    $value = Invoke-KoseiCdpReadEval -WebSocketUrl 'ws://t/p' -Expression '1' -TimeoutSeconds 5 -Label 'probe'
    Assert-Case ($value -eq 'ok' -and $script:calls -eq 2) 'one response timeout is retried and the read succeeds'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*CDP応答タイムアウト（読み取り）*label=probe*' }).Count -eq 1) 'retry is logged as WARN with the label'

    $script:calls = 0
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) $script:calls++; throw 'CDP応答タイムアウト: Runtime.evaluate' }
    $message = ''
    try { $null = Invoke-KoseiCdpReadEval -WebSocketUrl 'ws://t/p' -Expression '1' -TimeoutSeconds 5 } catch { $message = $_.Exception.Message }
    Assert-Case ($script:calls -eq 2 -and $message -like 'CDP応答タイムアウト*') 'persistent timeout gives up after one retry and keeps the original error'

    $script:calls = 0
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) $script:calls++; throw 'JavaScript evaluation failed: {"text":"boom"}' }
    $message = ''
    try { $null = Invoke-KoseiCdpReadEval -WebSocketUrl 'ws://t/p' -Expression '1' -TimeoutSeconds 5 } catch { $message = $_.Exception.Message }
    Assert-Case ($script:calls -eq 1 -and $message -like 'JavaScript evaluation failed*') 'other failures are not retried'

    # 種別付きの例外（PR #233 の cdp_transport）も、やり直した末にそのまま上へ渡す（種別を失わない）。
    $script:calls = 0
    function Invoke-KoseiCdpEval {
        param($WebSocketUrl, $Expression, $TimeoutSeconds)
        $script:calls++
        throw (New-KoseiFailureException -Kind 'cdp_transport' -Message 'CDP応答タイムアウト（5秒）: Runtime.evaluate')
    }
    $kind = ''
    try { $null = Invoke-KoseiCdpReadEval -WebSocketUrl 'ws://t/p' -Expression '1' -TimeoutSeconds 5 } catch { $kind = [string]$_.Exception.Data['KoseiFailureKind'] }
    Assert-Case ($script:calls -eq 2 -and $kind -eq 'cdp_transport') 'typed timeout keeps its failure kind after the retry'
}

# --- 3. 実際の送受信経路: 1回目の接続で応答が来なくても、送信先の確認が通る ----------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    function Write-KoseiLog {}
    function Start-Sleep {}
    $script:connects = 0
    function Connect-KoseiWebSocket {
        param($WebSocketUrl, $TimeoutSeconds)
        $script:connects++
        $ws = [pscustomobject]@{ State = 'Open'; Attempt = $script:connects }
        $ws | Add-Member -MemberType ScriptMethod -Name SendAsync -Value { [System.Threading.Tasks.Task]::CompletedTask }
        $ws | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        return $ws
    }
    # 1本目の接続: ページがふさがっていて応答が来ない（受信の時間切れ = $null）。
    # 2本目: 止まり方の診断・解除（Invoke-KoseiCdpPageUnblock）。3本目: やり直しの読み取り。
    function Receive-KoseiWsMessage {
        param($WebSocket, $TimeoutSeconds)
        if ($WebSocket.Attempt -eq 1) { return $null }
        $origin = ([Uri]$settings.copilot_url).GetLeftPart([UriPartial]::Authority)
        return (@{ id = ($script:KoseiCdpNextId - 1); result = @{ result = @{ value = $origin } } } | ConvertTo-Json -Depth 5 -Compress)
    }
    $actual = Assert-KoseiTrustedCopilotOrigin -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($script:connects -eq 3 -and -not [string]::IsNullOrWhiteSpace([string]$actual)) 'origin check survives one Runtime.evaluate response timeout on a fresh connection'
}

# --- 4. やり直すのは読み取りの式だけ（クリック・入力・送信はやり直さない） -------------
& {
    $text = Get-Content -LiteralPath (Join-Path $src 'CopilotClient.ps1') -Raw -Encoding UTF8
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    $functions = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    $users = @($functions | Where-Object {
        $_.Name -ne 'Invoke-KoseiCdpReadEval' -and
        @($_.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-KoseiCdpReadEval' }, $true)).Count -gt 0
    } | ForEach-Object { $_.Name } | Sort-Object -Unique)
    # フォーカスは何度当てても同じなので、読み取りと同じく扱う。
    $allowed = @('Assert-KoseiTrustedCopilotOrigin', 'Get-KoseiAttachmentSnapshot', 'Get-KoseiChatInputTextLength', 'Get-KoseiMainText', 'Invoke-KoseiFocusChatInput')
    Assert-Case (($users -join ',') -eq (($allowed | Sort-Object) -join ',')) ("read retry is used only by read-only functions: " + ($users -join ','))
    foreach ($name in @('Invoke-KoseiClickSend', 'Invoke-KoseiClickStop', 'Invoke-KoseiFreshChat', 'Clear-KoseiResidualAttachments', 'Set-KoseiCopilotModel', 'Invoke-KoseiSameChatRetry')) {
        Assert-Case (-not ($users -contains $name)) "$name is never retried"
    }
}

# --- 5. モデル選択: ページ内の持ち時間を埋め、CDP の待ちはそれより長くとる ---------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    $settings | Add-Member -NotePropertyName copilot_model -NotePropertyValue 'GPT 最新, Model B, Model C' -Force
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    $script:seen = $null
    function Invoke-KoseiCdpEval {
        param($WebSocketUrl, $Expression, $TimeoutSeconds)
        $script:seen = [pscustomobject]@{ expression = $Expression; timeout = $TimeoutSeconds }
        return '{"ok":true,"changed":false,"reason":"deadline_exceeded","current":"自動"}'
    }
    $result = Set-KoseiCopilotModel -WsUrl 'ws://t/p' -Settings $settings
    $budgetSec = [Math]::Ceiling($script:KoseiModelSelectBudgetMs / 1000)
    Assert-Case ($script:seen.expression -notlike '*__BUDGET_MS__*' -and $script:seen.expression -like ('*Date.now() + ' + $script:KoseiModelSelectBudgetMs + ';*')) 'budget is substituted into the page script'
    Assert-Case ([int]$script:seen.timeout -ge ($budgetSec + 10)) "CDP wait ($($script:seen.timeout)s) is longer than the in-page budget ($($budgetSec)s)"
    Assert-Case ([string]$result.reason -eq 'deadline_exceeded') 'deadline result is returned to the caller'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*deadline_exceeded*' }).Count -eq 1) 'deadline is logged as WARN and the request continues'
}

# --- 6. モデル選択は無効（v4）: 呼び出し元がなく、既定・ひな型とも空 ----------------------
& {
    # どの製品コードも Set-KoseiCopilotModel を呼ばない（関数定義は将来戻せるよう残す）。
    $callers = New-Object System.Collections.Generic.List[string]
    foreach ($file in Get-ChildItem -LiteralPath $src -Filter '*.ps1' -Recurse) {
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        foreach ($cmd in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Set-KoseiCopilotModel' }, $true)) {
            $callers.Add($file.Name + ':' + $cmd.Extent.StartLineNumber)
        }
        foreach ($str in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -eq 'model_select' -and $n.Parent -is [System.Management.Automation.Language.CommandAst] }, $true)) {
            $callers.Add($file.Name + ':' + $str.Extent.StartLineNumber + ' (phase model_select)')
        }
    }
    Assert-Case ($callers.Count -eq 0) ("Set-KoseiCopilotModel has no callers: " + ($callers -join ', '))

    . (Join-Path $src 'Settings.ps1')
    Assert-Case ([string]::IsNullOrEmpty([string](Get-KoseiDefaultSettings).copilot_model)) 'default copilot_model is empty'
    $template = [System.IO.File]::ReadAllText((Join-Path $root 'config\settings.template.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Case ([string]::IsNullOrEmpty([string]$template.copilot_model)) 'settings.template.json copilot_model is empty'

    # 以前の既定値が残っている settings.json は空へ読み替える。利用者が書いた値はそのまま（使われはしない）。
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('kosei-v4-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $tmp 'config') -Force | Out-Null
    try {
        function Get-KoseiRoot { $tmp }
        foreach ($case in @(
            @{ value = 'GPT 最新,Opus,Think Deeper'; expect = '' },
            @{ value = 'GPT 5.6 Think deeper,Opus,Think Deeper'; expect = '' },
            @{ value = 'Opus'; expect = 'Opus' })) {
            $json = '{"copilot_model": ' + (ConvertTo-Json -InputObject $case.value) + '}'
            [System.IO.File]::WriteAllText((Join-Path $tmp 'config\settings.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
            $loaded = [string](Get-KoseiSettings).copilot_model
            Assert-Case ($loaded -eq $case.expect) ("settings.json copilot_model '" + $case.value + "' loads as '" + $case.expect + "'")
        }
    } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "Test-CdpEvalTimeout: $script:checks checks passed"
