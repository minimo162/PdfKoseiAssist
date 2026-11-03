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
    # 1本目の接続: ページがふさがっていて応答が来ない（受信の時間切れ = $null）。2本目: 応答が返る。
    function Receive-KoseiWsMessage {
        param($WebSocket, $TimeoutSeconds)
        if ($WebSocket.Attempt -eq 1) { return $null }
        $origin = ([Uri]$settings.copilot_url).GetLeftPart([UriPartial]::Authority)
        return (@{ id = ($script:KoseiCdpNextId - 1); result = @{ result = @{ value = $origin } } } | ConvertTo-Json -Depth 5 -Compress)
    }
    $actual = Assert-KoseiTrustedCopilotOrigin -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($script:connects -eq 2 -and -not [string]::IsNullOrWhiteSpace([string]$actual)) 'origin check survives one Runtime.evaluate response timeout on a fresh connection'
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
    $allowed = @('Assert-KoseiTrustedCopilotOrigin', 'Get-KoseiAttachmentSnapshot', 'Get-KoseiChatInputTextLength', 'Get-KoseiMainText')
    Assert-Case (($users -join ',') -eq (($allowed | Sort-Object) -join ',')) ("read retry is used only by read-only functions: " + ($users -join ','))
    foreach ($name in @('Invoke-KoseiClickSend', 'Invoke-KoseiClickStop', 'Invoke-KoseiFreshChat', 'Clear-KoseiResidualAttachments', 'Invoke-KoseiFocusChatInput', 'Set-KoseiCopilotModel')) {
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

Write-Host "Test-CdpEvalTimeout: $script:checks checks passed"
