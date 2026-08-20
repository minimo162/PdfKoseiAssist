# Test-AttachmentInputSequence.ps1
#
# PowerShell 5.1 のモックCDPで、Copilotが単一ファイル入力を置換しても
# PROMPT → チップ確認 → TEXT の順で別々の入力へ設定する契約を検証する。
# 実CDPには接続しないが、DOM.setFileInputFiles の呼び出しを実行して確認する。

$ErrorActionPreference = 'Stop'
$srcDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
. (Join-Path $srcDir 'Paths.ps1')
. (Join-Path $srcDir 'Settings.ps1')
. (Join-Path $srcDir 'CopilotClient.ps1')
. (Join-Path $srcDir 'ReviewJob.ps1')

$script:fail = 0
function Assert-True {
    param([string]$Name, [bool]$Condition)
    if ($Condition) { Write-Host "  ok   $Name" -ForegroundColor Green }
    else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:fail++ }
}
function Assert-Eq {
    param([string]$Name, $Expected, $Actual)
    Assert-True $Name ([string]$Expected -eq [string]$Actual)
    if ([string]$Expected -ne [string]$Actual) {
        Write-Host "        expected=$Expected actual=$Actual" -ForegroundColor DarkYellow
    }
}
function Assert-Throws {
    param([string]$Name, [scriptblock]$Block)
    $threw = $false
    try { & $Block } catch { $threw = $true }
    Assert-True $Name $threw
}

# 関数を差し替えたモックCDP。接続ごとに別nodeIdを返し、SPAがinputを
# 置き換える現実の状況を再現する。
$script:MockConnection = 0
$script:MockCalls = @()
$script:MockFailSet = $false
function Get-KoseiSelector {
    param($Settings, [string]$Name)
    if ($Name -eq 'file_input') { return '.mock-primary-file-input' }
    if ($Name -eq 'file_input_fallback') { return '.mock-fallback-file-input' }
    return ''
}
function Connect-KoseiWebSocket {
    param([string]$WebSocketUrl)
    $script:MockConnection++
    return [pscustomobject]@{ Connection = $script:MockConnection }
}
function Assert-KoseiTrustedCopilotOriginOnSocket {
    param($WebSocket, $Settings)
    return 'https://m365.cloud.microsoft'
}
function Invoke-KoseiCdpOnSocket {
    param($WebSocket, [string]$Method, $Params, [int]$TimeoutSeconds = 30)
    switch ($Method) {
        'DOM.enable' {
            return [pscustomobject]@{ result = [pscustomobject]@{} }
        }
        'DOM.getDocument' {
            return [pscustomobject]@{
                result = [pscustomobject]@{
                    root = [pscustomobject]@{ nodeId = 1 }
                }
            }
        }
        'DOM.querySelector' {
            return [pscustomobject]@{
                result = [pscustomobject]@{ nodeId = 100 + [int]$WebSocket.Connection }
            }
        }
        'DOM.setFileInputFiles' {
            $files = @($Params.files | ForEach-Object { [string]$_ })
            $script:MockCalls += [pscustomobject]@{
                method = $Method
                nodeId = [int]$Params.nodeId
                files = $files
            }
            if ($script:MockFailSet) {
                return [pscustomobject]@{
                    error = [pscustomobject]@{ message = 'mock set failure' }
                }
            }
            return [pscustomobject]@{ result = [pscustomobject]@{} }
        }
        default { throw "unexpected mock CDP method: $Method" }
    }
}

$settings = [pscustomobject]@{}
$prompt = 'C:\kosei\PROMPT_sample.txt'
$text = 'C:\kosei\TEXT_sample.txt'
$first = Invoke-KoseiSetFileInputFile -WsUrl 'ws://mock' -Settings $settings -File $prompt
$second = Invoke-KoseiSetFileInputFile -WsUrl 'ws://mock' -Settings $settings -File $text
$calls = @($script:MockCalls)
Assert-Eq 'PROMPT設定は成功' $true $first.ok
Assert-Eq 'TEXT設定は成功' $true $second.ok
Assert-Eq '入力ノードをファイルごとに再取得' $true ($calls.Count -eq 2 -and $first.nodeId -ne $second.nodeId)
$firstFile = if ((@($calls[0].files)).Count -eq 1) { $calls[0].files[0] } else { '' }
$secondFile = if ((@($calls[1].files)).Count -eq 1) { $calls[1].files[0] } else { '' }
Assert-Eq '最初のDOM.setFileInputFilesはPROMPTだけ' $prompt $firstFile
Assert-Eq '次のDOM.setFileInputFilesはTEXTだけ' $text $secondFile
$script:MockFailSet = $true
Assert-Throws 'DOM.setFileInputFiles失敗は伝播' {
    Invoke-KoseiSetFileInputFile -WsUrl 'ws://mock' -Settings $settings -File 'C:\kosei\FAIL.txt'
}
$script:MockFailSet = $false

# 1件ずつ設定して固有チップを確認してから次へ進み、途中キャンセルで
# 2件目を送らないことを実行確認する。
$script:sequenceEvents = New-Object 'System.Collections.Generic.List[string]'
$setFile = {
    param($File)
    $script:sequenceEvents.Add("set:$File") | Out-Null
    $script:cancelAfterFirst = $true
}
$waitChip = {
    param($Expected)
    $script:sequenceEvents.Add("chip:$Expected") | Out-Null
    return [pscustomobject]@{ ok = $true; cancelled = $false }
}
$script:cancelAfterFirst = $false
$sequence = Invoke-KoseiAttachmentSequence -Files @('PROMPT_sample.txt', 'TEXT_sample.txt') -SetFile $setFile -WaitForChip $waitChip -ShouldCancel { return [bool]$script:cancelAfterFirst } -OnCancel { $script:sequenceEvents.Add('stop') | Out-Null }
Assert-Eq '逐次処理は途中キャンセルを返す' $true $sequence.cancelled
Assert-Eq 'キャンセル後に2件目を設定しない' 'set:PROMPT_sample.txt|chip:PROMPT_sample.txt|stop' ($script:sequenceEvents -join '|')

# needs_user_visibility のpaused遷移は空のErrorでも致命例外にしない。
$state = [hashtable]::Synchronized(@{
    per_packet = @([hashtable]::Synchronized(@{
        status = 'needs_user_visibility'
        packet_id = 'packet-1'
    }))
    packets_done = 0
})
$paused = Set-KoseiPacketTerminalStatus -State $state -Index 0 -Status 'paused'
Assert-Eq '空Errorのpaused遷移が成功' $true $paused
Assert-Eq 'paused状態を保持' 'paused' $state.per_packet[0].status
Assert-Eq '空Errorを保持' '' $state.per_packet[0].error


# 本番 Invoke-KoseiCopilotAttachFiles の最終完了ループを実行する。
# 初回は busy、続く2回は安定した別名チップにして、deadlineへ進まず成功することを確認する。
$script:finalSnapshotMode = 'success'
$script:finalSnapshotCalls = 0
$script:finalStopCount = 0
$script:finalSetFiles = @()
$script:finalLogs = New-Object 'System.Collections.Generic.List[string]'

function Get-KoseiSelector {
    param($Settings, [string]$Name)
    switch ($Name) {
        'file_input' { return '.mock-primary-file-input' }
        'file_input_fallback' { return '.mock-fallback-file-input' }
        'upload_done_pattern' { return '(?!x)x' }
        'upload_fail_pattern' { return '(?!x)x' }
        default { return '' }
    }
}
function Assert-KoseiTrustedCopilotOrigin {
    param([string]$WsUrl, $Settings)
    return 'https://m365.cloud.microsoft'
}
function Clear-KoseiResidualAttachments {
    param($WsUrl, $Settings, [string]$Reason = '', [string[]]$ExpectedNames = @())
    return [pscustomobject]@{ count = 0; items = @() }
}
function Write-KoseiLog {
    param([string]$Message, [string]$Level = 'INFO')
    $script:finalLogs.Add(('{0}: {1}' -f $Level, $Message)) | Out-Null
}
function Invoke-KoseiCdpEval {
    param([string]$WsUrl, [string]$Expression, [int]$TimeoutSeconds = 30)
    if ($Expression -match 'document\.visibilityState') { return 'visible' }
    if ($Expression -match 'performance\.now') { return '0' }
    return '{"vis":"visible","baselineAvailable":true,"chips":0,"uploads":[]}'
}
function Invoke-KoseiClickStop {
    param([string]$WsUrl)
    $script:finalStopCount++
    return $true
}
# 最終ループの前段は、既存の単一入力・チップ順序テストと重複しないように
# 無出力のモックへ差し替える。最終ループ自体は本番関数をそのまま実行する。
function Invoke-KoseiSetFileInputFile {
    param([string]$WsUrl, $Settings, [string]$File)
    $script:finalSetFiles += [System.IO.Path]::GetFileName($File)
}
function Wait-KoseiAttachmentChip {
    param([string]$WsUrl, $Settings, [string]$Expected, [int]$TimeoutSeconds = 60, [scriptblock]$ShouldCancel = $null)
    return [pscustomobject]@{ ok = $true; cancelled = $false; expected = $Expected }
}
function Get-KoseiAttachmentSnapshot {
    param([string]$WsUrl, $Settings, [string[]]$ExpectedNames = @(), [switch]$IncludeHtml)
    $script:finalSnapshotCalls++
    $items = @()
    if ($script:finalSnapshotMode -eq 'success') {
        $busy = ($script:finalSnapshotCalls -eq 1)
        $items = @(
            [pscustomobject]@{ name = 'PROMPT_sample.txt'; names = @('PROMPT_sample.txt'); live = ''; busy = $busy },
            [pscustomobject]@{ name = 'TEXT_sample.txt'; names = @('TEXT_sample.txt'); live = ''; busy = $busy }
        )
    } elseif ($script:finalSnapshotMode -eq 'incomplete') {
        # PROMPTだけ残し、TEXTが欠けたままなのでallDoneにはならない。
        $items = @(
            [pscustomobject]@{ name = 'PROMPT_sample.txt'; names = @('PROMPT_sample.txt'); live = ''; busy = $false }
        )
    }
    return [pscustomobject]@{
        count = $items.Count
        items = $items
        usedItemSelector = 'mock'
        usedListSelector = 'mock'
        laxUsed = $false
        listHtml = '<div class="mock-attachments"></div>'
    }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-attach-final-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$promptPath = Join-Path $testRoot 'PROMPT_sample.txt'
$textPath = Join-Path $testRoot 'TEXT_sample.txt'
[IO.File]::WriteAllText($promptPath, 'prompt')
[IO.File]::WriteAllText($textPath, 'text')
$finalSettings = [pscustomobject]@{
    attach_wait_seconds = 0
    attach_wait_seconds_per_mb = 0
}
try {
    $script:finalSnapshotMode = 'success'
    $script:finalSnapshotCalls = 0
    $successClock = [Diagnostics.Stopwatch]::StartNew()
    $success = Invoke-KoseiCopilotAttachFiles -WsUrl 'ws://mock' -Settings $finalSettings -Files @($promptPath, $textPath)
    $successClock.Stop()
    Assert-True '本番完了ループが成功を返す' ($null -ne $success -and [bool]$success.ok)
    Assert-Eq '成功理由は安定チップ' 'stable-chip' $success.completedBy
    Assert-True '成功結果にelapsedMsがある' (@($success.PSObject.Properties.Name) -contains 'elapsedMs')
    Assert-True '成功結果はdeadlineを待たない' ($successClock.Elapsed.TotalSeconds -lt 8)
    Assert-Eq 'busy後に安定pollを2回だけ実行' 3 $script:finalSnapshotCalls

    # キャンセルは最終ループへ進まず、従来どおり停止操作とcancelled結果を返す。
    $script:finalSnapshotMode = 'success'
    $script:finalSnapshotCalls = 0
    $script:finalStopCount = 0
    $cancelled = Invoke-KoseiCopilotAttachFiles -WsUrl 'ws://mock' -Settings $finalSettings -Files @($promptPath, $textPath) -ShouldCancel { return $true }
    Assert-Eq '本番添付キャンセル結果' 'cancelled' $cancelled.completedBy
    Assert-Eq 'キャンセル時は成功にしない' $false $cancelled.ok
    Assert-Eq 'キャンセル時に停止操作を行う' 1 $script:finalStopCount
    Assert-Eq 'キャンセル時は最終pollを行わない' 0 $script:finalSnapshotCalls

    # 期待ファイルが欠けたままの不完全状態は、成功扱いにせずタイムアウトする。
    $script:finalSnapshotMode = 'incomplete'
    $script:finalSnapshotCalls = 0
    $timeoutMessage = ''
    $timeoutThrew = $false
    $timeoutClock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $null = Invoke-KoseiCopilotAttachFiles -WsUrl 'ws://mock' -Settings $finalSettings -Files @($promptPath, $textPath)
    } catch {
        $timeoutThrew = $true
        $timeoutMessage = [string]$_.Exception.Message
    }
    $timeoutClock.Stop()
    Assert-True '不完全なチップは失敗する' $timeoutThrew
    Assert-True '不完全なチップは添付完了エラーになる' ($timeoutMessage -match '添付完了')
    Assert-True '不完全なチップは複数回確認してから失敗する' ($script:finalSnapshotCalls -gt 3)
    Assert-True '不完全なチップはdeadlineまで待つ' ($timeoutClock.Elapsed.TotalSeconds -ge 10)
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($script:fail -gt 0) { throw "Test-AttachmentInputSequence failed: $script:fail" }
Write-Host 'Test-AttachmentInputSequence: PASS' -ForegroundColor Cyan
