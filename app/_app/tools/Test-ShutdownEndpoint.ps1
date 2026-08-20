# Test-ShutdownEndpoint.ps1 — /__shutdown の実動作をPS5.1で検証する。
#
# 文字列の存在確認ではなく、Server.ps1/ReviewJob.ps1を読み込み、stubした
# HttpListener request/responseをInvoke-KoseiRouteへ渡して状態遷移を確認する。

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$testDataRoot = Join-Path ([IO.Path]::GetTempPath()) ('pdf-kosei-shutdown-test-' + [guid]::NewGuid().ToString('N'))
$previousDataRoot = [Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')

function Assert-TestCondition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function New-TestResponse {
    $stream = New-Object PSObject -Property @{ Text = ''; Closed = $false }
    $stream | Add-Member ScriptMethod Write {
        param([byte[]]$Buffer, [int]$Offset, [int]$Count)
        $this.Text = [Text.Encoding]::UTF8.GetString($Buffer, $Offset, $Count)
    }
    $stream | Add-Member ScriptMethod Close { $this.Closed = $true }
    return [pscustomobject]@{
        StatusCode = 0
        Headers = @{}
        ContentType = ''
        ContentLength64 = 0L
        OutputStream = $stream
    }
}

function New-TestRequest {
    param(
        [Parameter(Mandatory=$true)][string]$Method,
        [AllowNull()][string]$Origin,
        [Parameter(Mandatory=$true)][string]$Path,
        [string]$Body = ''
    )
    $headers = @{}
    if ($null -ne $Origin) { $headers['Origin'] = $Origin }
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Body)
    $input = New-Object IO.MemoryStream
    if ($bytes.Length -gt 0) { $input.Write($bytes, 0, $bytes.Length); $input.Position = 0 }
    return [pscustomobject]@{
        HttpMethod = $Method
        Headers = $headers
        RemoteEndPoint = [Net.IPEndPoint]::new([Net.IPAddress]::Parse('127.0.0.1'), 8098)
        Url = [Uri]('http://127.0.0.1:8098' + $Path)
        ContentLength64 = [int64]$bytes.Length
        InputStream = $input
        IsLocal = $true
    }
}

function Invoke-TestRoute {
    param(
        [Parameter(Mandatory=$true)][string]$Method,
        [AllowNull()][string]$Origin,
        [Parameter(Mandatory=$true)][string]$Path,
        [string]$Body = ''
    )
    $response = New-TestResponse
    $request = New-TestRequest -Method $Method -Origin $Origin -Path $Path -Body $Body
    $context = [pscustomobject]@{ Request = $request; Response = $response }
    Invoke-KoseiRoute -Context $context -Settings ([pscustomobject]@{}) -ServerState $script:TestServerState
    return [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Headers = $response.Headers
        Body = [string]$response.OutputStream.Text
    }
}

function New-TestJobState {
    param(
        [Parameter(Mandatory=$true)][string]$Id,
        [Parameter(Mandatory=$true)][string]$Mode,
        [bool]$Retained = $false,
        [bool]$Cancelled = $false
    )
    return [hashtable]::Synchronized(@{
        id = $Id
        mode = $Mode
        cancel_requested = $Cancelled
        result_retained = $Retained
        recovery_checkpoint_ready = $Retained
        recovery_acknowledged = $false
        shutdown_discard_approved = $false
        recovery_expires_at = (Get-Date).AddHours(1).ToString('o')
        recovery_chain_id = ''
        recovery_parent_job_id = ''
        recovery_ancestor_job_ids = @()
        upload_dir = ''
        per_packet = @()
        target_file_name = 'target.pdf'
        target_page_count = 1
        target_pdf_sha256 = ''
        mask_seed = 0
        recovery_metadata = [ordered]@{ packets = @() }
    })
}

$sameOrigin = 'http://127.0.0.1:8098'
$testId = '0123456789abcdef0123456789abcdef'
$activeId = 'abcdef0123456789abcdef0123456789'
$parentId = 'fedcba9876543210fedcba9876543210'

try {
    New-Item -ItemType Directory -Path $testDataRoot -Force | Out-Null
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR', $testDataRoot)

    . (Join-Path $appRoot 'src\Paths.ps1')
    Set-KoseiRoot -Root $appRoot
    . (Join-Path $appRoot 'src\Settings.ps1')
    . (Join-Path $appRoot 'src\ReviewJob.ps1')
    . (Join-Path $appRoot 'src\Server.ps1')

    $script:KoseiJobs = [hashtable]::Synchronized(@{})
    $script:KoseiJobHandles = @{}
    $script:KoseiActiveJobId = $null
    $script:KoseiPendingRecovery = $null
    $script:KoseiRecoverableJobId = $null
    $script:TestServerState = [pscustomobject]@{ Url = $sameOrigin + '/'; ShouldStop = $false; HasBrowserHeartbeat = $true }

    # GET must not be a shutdown method, even with the right Origin.
    $result = Invoke-TestRoute -Method 'GET' -Origin $sameOrigin -Path '/__shutdown'
    Assert-TestCondition ($result.StatusCode -eq 405 -and $result.Headers['Allow'] -eq 'POST') 'GET shutdown was not rejected with 405/Allow: POST.'

    # Loopback is not sufficient: missing, blank, null, foreign scheme/host/port
    # must all fail before any state transition.
    foreach ($originCase in @($null, '', 'null', 'https://127.0.0.1:8098', 'http://localhost:8098', 'http://127.0.0.1:8099')) {
        $script:TestServerState.ShouldStop = $false
        $result = Invoke-TestRoute -Method 'POST' -Origin $originCase -Path '/__shutdown' -Body '{}'
        Assert-TestCondition ($result.StatusCode -eq 403 -and -not $script:TestServerState.ShouldStop) ('Origin case was accepted: ' + [string]$originCase)
    }

    # A running job fences shutdown.
    $active = New-TestJobState -Id $activeId -Mode 'running'
    $script:KoseiJobs[$activeId] = $active
    $script:KoseiActiveJobId = $activeId
    $script:TestServerState.ShouldStop = $false
    $result = Invoke-TestRoute -Method 'POST' -Origin $sameOrigin -Path '/__shutdown' -Body '{}'
    Assert-TestCondition ($result.StatusCode -eq 409 -and $result.Body -match 'active_job' -and -not $script:TestServerState.ShouldStop) 'Running job did not fence shutdown.'
    $script:KoseiJobs.Remove($activeId)
    $script:KoseiActiveJobId = $null

    # A retained result also fences an ordinary shutdown.
    $retained = New-TestJobState -Id $parentId -Mode 'done' -Retained $true
    $script:KoseiJobs[$parentId] = $retained
    $script:TestServerState.ShouldStop = $false
    $result = Invoke-TestRoute -Method 'POST' -Origin $sameOrigin -Path '/__shutdown' -Body '{}'
    Assert-TestCondition ($result.StatusCode -eq 409 -and $result.Body -match 'recoverable_job' -and -not $script:TestServerState.ShouldStop) 'Retained result did not fence shutdown.'


    # Completed, error, and interrupted retained jobs are never valid shutdown intents.
    foreach ($blocked in @(
        @{ id = '11111111111111111111111111111111'; mode = 'done' },
        @{ id = '22222222222222222222222222222222'; mode = 'error' },
        @{ id = '33333333333333333333333333333333'; mode = 'interrupted' }
    )) {
        $blockedState = New-TestJobState -Id $blocked.id -Mode $blocked.mode -Retained $true
        $script:KoseiJobs[$blocked.id] = $blockedState
        $script:TestServerState.ShouldStop = $false
        $blockedBody = '{"shutdown_intent_job_id":"' + $blocked.id + '","shutdown_intent_chain_id":""}'
        $result = Invoke-TestRoute -Method 'POST' -Origin $sameOrigin -Path '/__shutdown' -Body $blockedBody
        Assert-TestCondition ($result.StatusCode -eq 409 -and -not $script:TestServerState.ShouldStop -and $blockedState.result_retained) ('Non-cancelled retained job was accepted: ' + $blocked.mode)
        $script:KoseiJobs.Remove($blocked.id)
    }

    # Explicit cancellation -> terminal -> discard-only ack -> shutdown. The
    # unrelated retained result remains in the registry and is reported as
    # preserved; the cancelled checkpoint alone is purged/marked approved.
    $cancelled = New-TestJobState -Id $testId -Mode 'cancelled' -Retained $true -Cancelled $true
    $script:KoseiJobs[$testId] = $cancelled
    $script:KoseiActiveJobId = $testId
    $mismatchAckBody = '{"job_id":"' + $testId + '","chain_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","discard_cancelled_only":true}'
    $result = Invoke-TestRoute -Method 'POST' -Origin $sameOrigin -Path ('/api/review/jobs/' + $testId + '/ack') -Body $mismatchAckBody
    Assert-TestCondition ($result.StatusCode -eq 409 -and -not $cancelled.shutdown_discard_approved -and $cancelled.result_retained) 'Mismatched cancellation chain metadata was accepted.'
    $ackBody = '{"job_id":"' + $testId + '","chain_id":"","discard_cancelled_only":true}'
    $result = Invoke-TestRoute -Method 'POST' -Origin $sameOrigin -Path ('/api/review/jobs/' + $testId + '/ack') -Body $ackBody
    Assert-TestCondition ($result.StatusCode -eq 200 -and $cancelled.shutdown_discard_approved -and -not $cancelled.result_retained) 'Cancelled job discard-only ack did not complete.'
    $script:TestServerState.ShouldStop = $false
    $shutdownBody = '{"shutdown_intent_job_id":"' + $testId + '","shutdown_intent_chain_id":""}'
    $result = Invoke-TestRoute -Method 'POST' -Origin $sameOrigin -Path '/__shutdown' -Body $shutdownBody
    Assert-TestCondition ($result.StatusCode -eq 200 -and $script:TestServerState.ShouldStop -and $result.Body -match 'preserved_recovery') 'Acked cancellation did not permit shutdown while preserving recovery.'
    Assert-TestCondition ($script:KoseiJobs.ContainsKey($parentId) -and $script:KoseiJobs[$parentId].result_retained) 'Unrelated retained recovery was discarded.'

    Write-Output 'Test-ShutdownEndpoint: PASS'
    exit 0
} catch {
    Write-Error ('Test-ShutdownEndpoint: FAIL — ' + $_.Exception.Message)
    exit 1
} finally {
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR', $previousDataRoot)
    if (Test-Path -LiteralPath $testDataRoot) { Remove-Item -LiteralPath $testDataRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
