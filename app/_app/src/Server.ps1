# =====================================================================
# Server.ps1 — HttpListener APIサーバー
#
# 旧 server.ps1（静的配信のみ）の置換。既存 index.html はそのまま配信しつつ、
# 校正ジョブAPIを追加する。旧サーバーのハートビート/自動終了も踏襲。
#
# API:
#   GET  /api/ready-state                 Copilot準備状態（warmupバッジ用）
#   POST /api/review/jobs                 ジョブ投入（JSON: packets[].{packet_id,prompt,text,pdf_base64,pdf_name,text_name}）
#   GET  /api/review/jobs/{id}            ジョブ状態
#   GET  /api/review/jobs/{id}/result     パケット別の回答JSON
#   POST /api/review/cancel               実行中ジョブの中止
#   POST /api/open-copilot                Copilot画面を開く（サインイン用）
#   GET  /__health  /__heartbeat  /__page-closed  /__shutdown
# =====================================================================

function Get-KoseiContentType {
    param([string]$Path)
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    switch ($ext) {
        '.html'  { return 'text/html; charset=utf-8' }
        '.htm'   { return 'text/html; charset=utf-8' }
        '.js'    { return 'text/javascript; charset=utf-8' }
        '.mjs'   { return 'text/javascript; charset=utf-8' }
        '.json'  { return 'application/json; charset=utf-8' }
        '.css'   { return 'text/css; charset=utf-8' }
        '.txt'   { return 'text/plain; charset=utf-8' }
        '.md'    { return 'text/markdown; charset=utf-8' }
        '.wasm'  { return 'application/wasm' }
        '.bcmap' { return 'application/octet-stream' }
        '.png'   { return 'image/png' }
        '.jpg'   { return 'image/jpeg' }
        '.jpeg'  { return 'image/jpeg' }
        '.svg'   { return 'image/svg+xml' }
        '.pdf'   { return 'application/pdf' }
        default  { return 'application/octet-stream' }
    }
}

function Send-KoseiBytes {
    param($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Body)
    try {
        if ($null -eq $Body) { $Body = New-Object byte[] 0 }
        $Response.StatusCode = $StatusCode
        $Response.ContentType = $ContentType
        $Response.Headers['Cache-Control'] = 'no-store'
        $Response.Headers['X-Content-Type-Options'] = 'nosniff'
        $Response.ContentLength64 = $Body.Length
        if ($Body.Length -gt 0) { $Response.OutputStream.Write($Body, 0, $Body.Length) }
    } catch {
        Write-KoseiLog ("応答送信エラー: " + $_.Exception.Message) 'WARN'
    } finally {
        try { $Response.OutputStream.Close() } catch {}
    }
}

function Send-KoseiText {
    param($Response, [int]$StatusCode, [string]$Text, [string]$ContentType = 'text/plain; charset=utf-8')
    Send-KoseiBytes -Response $Response -StatusCode $StatusCode -ContentType $ContentType -Body ([System.Text.Encoding]::UTF8.GetBytes([string]$Text))
}

function Send-KoseiJson {
    param($Response, [int]$StatusCode, $Object)
    $json = $Object | ConvertTo-Json -Depth 20
    Send-KoseiText -Response $Response -StatusCode $StatusCode -Text $json -ContentType 'application/json; charset=utf-8'
}

function Read-KoseiRequestBodyText {
    param($Request, [int]$MaxBytes = 209715200)  # 200MB（base64込みのパケットPDFを許容）
    if ($Request.ContentLength64 -gt $MaxBytes) { throw ("リクエストが大きすぎます（上限 {0} bytes）。" -f $MaxBytes) }
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Resolve-KoseiStaticPath {
    param([Parameter(Mandatory=$true)][string]$UrlPath)
    $root = Get-KoseiRoot
    $decoded = $UrlPath
    try { $decoded = [System.Uri]::UnescapeDataString($UrlPath.Split('?')[0]) } catch { return $null }
    if ([string]::IsNullOrWhiteSpace($decoded) -or $decoded -eq '/') { $decoded = '/index.html' }
    $relative = $decoded.TrimStart('/', '\')
    if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
    # src/ config/ tools/ は配信しない
    $firstSeg = ($relative -split '[\\/]')[0].ToLowerInvariant()
    if (@('src','config','tools') -contains $firstSeg) { return $null }
    $candidate = $null
    try { $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $relative)) } catch { return $null }
    $rootFull = [System.IO.Path]::GetFullPath($root)
    if (-not $rootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $rootFull += [System.IO.Path]::DirectorySeparatorChar }
    if ($candidate.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $candidate }
    return $null
}

# ---------------------------------------------------------------------
# ジョブ投入: JSONボディの受理とファイル保存
# ---------------------------------------------------------------------
function Save-KoseiIncomingJob {
    param([Parameter(Mandatory=$true)]$Body, [Parameter(Mandatory=$true)]$Settings)
    if ($null -eq $Body.packets) { throw 'packets がありません。' }
    $packets = @($Body.packets)
    if ($packets.Count -eq 0) { throw 'packets が空です。' }
    $jobDirName = 'job-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $jobDir = Join-Path (Get-KoseiSubDir 'uploads') $jobDirName
    New-Item -ItemType Directory -Path $jobDir -Force | Out-Null

    $saved = @()
    $idx = 0
    foreach ($p in $packets) {
        $idx++
        $packetId = [string]$p.packet_id
        if ([string]::IsNullOrWhiteSpace($packetId)) { $packetId = ('PACKET_{0:d3}' -f $idx) }
        $safeId = New-KoseiSafeFileName -FileName $packetId
        $prompt = [string]$p.prompt
        if ([string]::IsNullOrWhiteSpace($prompt)) { throw ("packet {0}: prompt がありません。" -f $packetId) }
        if ($prompt.Length -gt [int]$Settings.max_prompt_chars) {
            throw ("packet {0}: 依頼文が上限 {1} 文字を超えています。" -f $packetId, [int]$Settings.max_prompt_chars)
        }
        $promptName = [string]$p.prompt_name
        if ([string]::IsNullOrWhiteSpace($promptName)) { $promptName = 'PROMPT_' + $safeId + '.txt' }
        $promptPath = Join-Path $jobDir (New-KoseiSafeFileName -FileName $promptName)
        [System.IO.File]::WriteAllText($promptPath, $prompt, (New-Object System.Text.UTF8Encoding($true)))

        $textPath = ''
        if (-not [string]::IsNullOrWhiteSpace([string]$p.text)) {
            $textName = [string]$p.text_name
            if ([string]::IsNullOrWhiteSpace($textName)) { $textName = $safeId + '_TEXT.txt' }
            $textPath = Join-Path $jobDir (New-KoseiSafeFileName -FileName $textName)
            [System.IO.File]::WriteAllText($textPath, [string]$p.text, (New-Object System.Text.UTF8Encoding($true)))
        }

        $pdfPath = ''
        if (-not [string]::IsNullOrWhiteSpace([string]$p.pdf_base64)) {
            $pdfName = [string]$p.pdf_name
            if ([string]::IsNullOrWhiteSpace($pdfName)) { $pdfName = $safeId + '.pdf' }
            $pdfPath = Join-Path $jobDir (New-KoseiSafeFileName -FileName $pdfName)
            $bytes = [Convert]::FromBase64String([string]$p.pdf_base64)
            [System.IO.File]::WriteAllBytes($pdfPath, $bytes)
        }

        $saved += @{ packet_id = $packetId; prompt_path = $promptPath; pdf_path = $pdfPath; text_path = $textPath; target_pages = @($p.target_pages | ForEach-Object { [int]$_ }) }
    }
    return $saved
}

# ---------------------------------------------------------------------
# ルーティング
# ---------------------------------------------------------------------
function Invoke-KoseiRoute {
    param($Context, $Settings, $ServerState)
    $request = $Context.Request
    $response = $Context.Response
    $method = $request.HttpMethod.ToUpperInvariant()
    $path = $request.Url.AbsolutePath

    # --- ライフサイクル（旧サーバー互換） ---
    if ($path -eq '/__health') { Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true }; return }
    if ($path -eq '/__heartbeat') {
        $ServerState.HasBrowserHeartbeat = $true
        $ServerState.LastHeartbeat = Get-Date
        $ServerState.CloseAt = $null
        Send-KoseiBytes -Response $response -StatusCode 204 -ContentType 'text/plain' -Body $null
        return
    }
    if ($path -eq '/__page-closed') {
        $ServerState.CloseAt = (Get-Date).AddSeconds(2)
        Send-KoseiBytes -Response $response -StatusCode 204 -ContentType 'text/plain' -Body $null
        return
    }
    if ($path -eq '/__shutdown') {
        $ServerState.ShouldStop = $true
        Send-KoseiText -Response $response -StatusCode 200 -Text 'サーバーを停止します。このタブは閉じて構いません。'
        return
    }

    # --- API ---
    try {
        if ($method -eq 'GET' -and $path -eq '/api/ready-state') {
            $warmup = Read-KoseiWarmupStatus
            Send-KoseiJson -Response $response -StatusCode 200 -Object $warmup
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/open-copilot') {
            $null=Show-KoseiCopilotEdgeWindow -Settings $Settings
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true }
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/show-copilot') {
            $null=Show-KoseiCopilotEdgeWindow -Settings $Settings
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true }
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/review/jobs') {
            Update-KoseiJobHandles
            $active = Get-KoseiActiveJobState
            if (Test-KoseiJobRunning -State $active) {
                Send-KoseiJson -Response $response -StatusCode 409 -Object @{ error = '別の校正ジョブが実行中です。' }
                return
            }
            # 起動直後のウォームアップが進行中なら、ジョブを投入する前に最大120秒待つ。
            # signin_required/error は全パケットを無駄に失敗させず、ここで原因を返す。
            $warmupDeadline = (Get-Date).AddSeconds(120)
            $warmup = Read-KoseiWarmupStatus
            while ([string]$warmup.state -eq 'preparing' -and (Get-Date) -lt $warmupDeadline) {
                Start-Sleep -Milliseconds 500
                $warmup = Read-KoseiWarmupStatus
            }
            if ([string]$warmup.state -eq 'signin_required') {
                Send-KoseiJson -Response $response -StatusCode 428 -Object @{ error = 'Copilotへのサインインが必要です。[Copilot画面を表示]からサインインして、再実行してください。'; code = 'copilot_signin_required' }
                return
            }
            if ([string]$warmup.state -eq 'error') {
                Send-KoseiJson -Response $response -StatusCode 503 -Object @{ error = 'Copilot画面が準備できませんでした。[Copilot画面を表示]で状態を確認して、再実行してください。'; code = 'copilot_not_ready' }
                return
            }
            if ([string]$warmup.state -eq 'preparing') {
                Send-KoseiJson -Response $response -StatusCode 503 -Object @{ error = 'Copilot画面の準備が120秒以内に完了しませんでした。[Copilot画面を表示]で状態を確認してください。'; code = 'copilot_warmup_timeout' }
                return
            }
            $bodyText = Read-KoseiRequestBodyText -Request $request
            $body = $bodyText | ConvertFrom-Json
            $packets = Save-KoseiIncomingJob -Body $body -Settings $Settings
            $attachMode = ''
            if ($body.PSObject.Properties.Name -contains 'attach_mode') { $attachMode = [string]$body.attach_mode }
            $jobId = Start-KoseiReviewJob -Settings $Settings -Packets $packets -AttachMode $attachMode
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ job_id = $jobId }
            return
        }
        if ($method -eq 'GET' -and $path -match '^/api/review/jobs/([0-9a-f]{32})$') {
            $state = Get-KoseiJobState -JobId $Matches[1]
            if ($null -eq $state) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = 'ジョブが見つかりません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object (ConvertTo-KoseiJobStatusObject -State $state)
            return
        }
        if ($method -eq 'GET' -and $path -match '^/api/review/jobs/([0-9a-f]{32})/result$') {
            $state = Get-KoseiJobState -JobId $Matches[1]
            if ($null -eq $state) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = 'ジョブが見つかりません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object (Get-KoseiJobResultObject -State $state)
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/review/cancel') {
            $active = Get-KoseiActiveJobState
            if ($null -eq $active) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = '実行中のジョブがありません。' }; return }
            $null = Stop-KoseiJob -JobId ([string]$active.id)
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true }
            return
        }
    } catch {
        Write-KoseiLog ("APIエラー " + $method + ' ' + $path + ': ' + $_.Exception.Message) 'ERROR'
        Send-KoseiJson -Response $response -StatusCode 400 -Object @{ error = $_.Exception.Message }
        return
    }

    # --- 静的配信 ---
    if ($method -ne 'GET' -and $method -ne 'HEAD') {
        Send-KoseiText -Response $response -StatusCode 405 -Text 'Method Not Allowed'
        return
    }
    $filePath = Resolve-KoseiStaticPath -UrlPath $path
    if ($null -eq $filePath) { Send-KoseiText -Response $response -StatusCode 403 -Text 'Forbidden'; return }
    if (Test-Path -LiteralPath $filePath -PathType Container) { $filePath = Join-Path $filePath 'index.html' }
    if (!(Test-Path -LiteralPath $filePath -PathType Leaf)) { Send-KoseiText -Response $response -StatusCode 404 -Text 'Not found'; return }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    if ($method -eq 'HEAD') { $bytes = New-Object byte[] 0 }
    Send-KoseiBytes -Response $response -StatusCode 200 -ContentType (Get-KoseiContentType -Path $filePath) -Body $bytes
}

# ---------------------------------------------------------------------
# サーバー本体
# ---------------------------------------------------------------------
function Start-KoseiServer {
    param([Parameter(Mandatory=$true)]$Settings, [switch]$NoAutoShutdown)
    $listener = $null
    $boundUrl = ''
    foreach ($port in @($Settings.server_ports)) {
        try {
            $l = [System.Net.HttpListener]::new()
            $prefix = 'http://127.0.0.1:' + [int]$port + '/'
            $l.Prefixes.Add($prefix)
            $l.Start()
            $listener = $l
            $boundUrl = $prefix
            break
        } catch {
            try { if ($l) { $l.Close() } } catch {}
        }
    }
    if ($null -eq $listener) { throw ('サーバーポートを確保できませんでした: ' + (@($Settings.server_ports) -join ',')) }

    $root = Get-KoseiRoot
    $urlFile = Join-Path $root 'local-app.url'
    $pidFile = Join-Path $root 'local-app.pid'
    try { Set-Content -LiteralPath $urlFile -Encoding ASCII -Value $boundUrl } catch {}
    try { Add-Content -LiteralPath (Join-Path $root 'startup-log.txt') -Encoding UTF8 -Value ('[' + (Get-Date).ToString('s') + '] server ready: ' + $boundUrl) } catch {}
    try { Set-Content -LiteralPath $pidFile -Encoding ASCII -Value $PID } catch {}
    Write-KoseiLog ("サーバー起動 " + $boundUrl) 'INFO'
    Write-Host ("PDF校正アシスト サーバー起動: " + $boundUrl)
    Write-Host '停止するには Ctrl+C を押してください。'

    $serverState = @{
        HasBrowserHeartbeat = $false
        LastHeartbeat       = Get-Date
        CloseAt             = $null
        ShouldStop          = $false
        StartedAt           = Get-Date
        Url                 = $boundUrl
    }
    $heartbeatTimeoutSec = 3600
    $noBrowserTimeoutSec = 600

    try {
        while (-not $serverState.ShouldStop) {
            $task = $listener.GetContextAsync()
            while (-not $task.Wait(200)) {
                if ($serverState.ShouldStop) { break }
                if (-not $NoAutoShutdown) {
                    $now = Get-Date
                    if (-not $serverState.HasBrowserHeartbeat -and (($now - $serverState.StartedAt).TotalSeconds -gt $noBrowserTimeoutSec)) {
                        Write-KoseiLog 'ブラウザ未接続タイムアウトのため停止' 'INFO'; $serverState.ShouldStop = $true; break
                    }
                    if ($serverState.HasBrowserHeartbeat -and (($now - $serverState.LastHeartbeat).TotalSeconds -gt $heartbeatTimeoutSec)) {
                        Write-KoseiLog 'ハートビート断のため停止' 'INFO'; $serverState.ShouldStop = $true; break
                    }
                    if ($null -ne $serverState.CloseAt -and $now -ge $serverState.CloseAt) {
                        Write-KoseiLog 'タブ閉鎖検知のため停止' 'INFO'; $serverState.ShouldStop = $true; break
                    }
                }
            }
            if ($serverState.ShouldStop) { break }
            $context = $task.GetAwaiter().GetResult()
            try {
                Invoke-KoseiRoute -Context $context -Settings $Settings -ServerState $serverState
            } catch {
                Write-KoseiLog ("リクエスト処理エラー: " + $_.Exception.Message) 'ERROR'
                try { Send-KoseiText -Response $context.Response -StatusCode 500 -Text $_.Exception.Message } catch {}
            }
        }
    } finally {
        try { $listener.Stop(); $listener.Close() } catch {}
        try { Remove-Item -LiteralPath $urlFile -Force -ErrorAction SilentlyContinue } catch {}
        try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue } catch {}
        Write-KoseiLog 'サーバー停止' 'INFO'
    }
}
