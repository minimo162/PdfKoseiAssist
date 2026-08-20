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
#   POST /api/review/pass-stats           pass単位統計のCSV追記（localhost限定・§7.1）
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
function Get-KoseiPacketStageMetadata {
    param([Parameter(Mandatory=$true)]$Packet)
    $names = @($Packet.PSObject.Properties.Name)
    $nested = if ($names -contains 'stage' -and $null -ne $Packet.stage) { $Packet.stage } else { $null }
    $hasMetadata = ($names -contains 'stage_index' -or $names -contains 'stage_order' -or
        $names -contains 'stage_total' -or $names -contains 'stage_id' -or $names -contains 'stage_label' -or $null -ne $nested)
    $hasIndex = $names -contains 'stage_index'
    $hasOrder = $names -contains 'stage_order'
    $hasTotal = $names -contains 'stage_total'
    $rawIndex = if ($hasIndex) { $Packet.stage_index } else { $null }
    $rawOrder = if ($hasOrder) { $Packet.stage_order } else { $null }
    $rawTotal = if ($names -contains 'stage_total') { $Packet.stage_total } else { $null }
    $rawId = if ($names -contains 'stage_id') { $Packet.stage_id } else { $null }
    $rawLabel = if ($names -contains 'stage_label') { $Packet.stage_label } else { $null }
    if ($nested) {
        $nestedNames = @($nested.PSObject.Properties.Name)
        if ($null -eq $rawIndex -and $nestedNames -contains 'index') { $rawIndex = $nested.index; $hasIndex = $true }
        if ($null -eq $rawOrder -and $nestedNames -contains 'order') { $rawOrder = $nested.order; $hasOrder = $true }
        if ($null -eq $rawTotal -and $nestedNames -contains 'total') { $rawTotal = $nested.total; $hasTotal = $true }
        if ($null -eq $rawId -and $nestedNames -contains 'id') { $rawId = $nested.id }
        if ($null -eq $rawLabel -and $nestedNames -contains 'label') { $rawLabel = $nested.label }
    }
    $index = 1
    $order = 1
    $total = 1
    if ($hasMetadata) {
        if (-not ($hasIndex -or $hasOrder)) { throw 'staged packetにstage_index/stage_orderがありません。' }
        if (-not $hasTotal) { throw 'staged packetにstage_totalがありません。' }
        if ($hasIndex -and -not [int]::TryParse([string]$rawIndex, [ref]$index)) { throw 'stage_index が不正です。' }
        if ($hasOrder -and -not [int]::TryParse([string]$rawOrder, [ref]$order)) { throw 'stage_order が不正です。' }
        if ($hasIndex -and $hasOrder -and $index -ne $order) { throw 'stage_indexとstage_orderが一致しません。' }
        if (-not $hasIndex -and $hasOrder) { $index = $order }
        if ($hasTotal -and -not [int]::TryParse([string]$rawTotal, [ref]$total)) { throw 'stage_total が不正です。' }
        if ($index -lt 1 -or $index -gt 1000) { throw 'stage_index/stage_order は1以上1000以下で指定してください。' }
        if ($total -lt 1 -or $total -gt 1000 -or $total -lt $index) { throw 'stage_total が不正です。' }
    }
    $id = [string]$rawId
    if ($id.Length -gt 120) { $id = $id.Substring(0, 120) }
    $label = [string]$rawLabel
    if ($label.Length -gt 200) { $label = $label.Substring(0, 200) }
    return [ordered]@{
        has_metadata = $hasMetadata
        stage_metadata_present = $hasMetadata
        stage_index_present = $hasIndex
        stage_order_present = $hasOrder
        stage_total_present = $hasTotal
        stage_index  = $index
        stage_order  = $index
        stage_total  = $total
        stage_id     = $id
        stage_label  = $label
    }
}

function Save-KoseiIncomingJob {
    param([Parameter(Mandatory=$true)]$Body, [Parameter(Mandatory=$true)]$Settings)
    if ($null -eq $Body.packets) { throw 'packets がありません。' }
    # 数値マスキングのときは PDF を **受け取っても保存しない**（多層防御）。
    # クライアント側で送らない作りにしてあるが、片方だけ直された状態で
    # 「テキストは伏せたのにPDFは素通り」になるのが一番まずい。
    $maskedMode = $false
    if ($Body.PSObject.Properties.Name -contains 'attach_mode') {
        $maskedMode = ([string]$Body.attach_mode -eq 'masked-text')
    }
    $packets = @($Body.packets)
    if ($packets.Count -eq 0) { throw 'packets が空です。' }
    $jobDirName = 'job-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $uploadsRoot = Get-KoseiSubDir 'uploads'
    $jobDir = Join-Path $uploadsRoot $jobDirName

    $saved = @()
    $cleanupPackets = @()
    $idx = 0
    try {
        New-Item -ItemType Directory -Path $jobDir -Force | Out-Null
        foreach ($p in $packets) {
        $idx++
        $packetId = [string]$p.packet_id
        if ([string]::IsNullOrWhiteSpace($packetId)) { $packetId = ('PACKET_{0:d3}' -f $idx) }
        $safeId = New-KoseiSafeFileName -FileName $packetId
        $cleanupPacket = [pscustomobject]@{ prompt_path=''; text_path=''; pdf_path='' }
        $cleanupPackets += $cleanupPacket
        $prompt = [string]$p.prompt
        if ([string]::IsNullOrWhiteSpace($prompt)) { throw ("packet {0}: prompt がありません。" -f $packetId) }
        if ($prompt.Length -gt [int]$Settings.max_prompt_chars) {
            throw ("packet {0}: 依頼文が上限 {1} 文字を超えています。" -f $packetId, [int]$Settings.max_prompt_chars)
        }
        $promptName = [string]$p.prompt_name
        if ([string]::IsNullOrWhiteSpace($promptName)) { $promptName = 'PROMPT_' + $safeId + '.txt' }
        $promptPath = Join-Path $jobDir (New-KoseiSafeFileName -FileName $promptName)
        $cleanupPacket.prompt_path = $promptPath
        [System.IO.File]::WriteAllText($promptPath, $prompt, (New-Object System.Text.UTF8Encoding($true)))

        $textPath = ''
        if (-not [string]::IsNullOrWhiteSpace([string]$p.text)) {
            $textName = [string]$p.text_name
            if ([string]::IsNullOrWhiteSpace($textName)) { $textName = $safeId + '_TEXT.txt' }
            $textPath = Join-Path $jobDir (New-KoseiSafeFileName -FileName $textName)
            $cleanupPacket.text_path = $textPath
            [System.IO.File]::WriteAllText($textPath, [string]$p.text, (New-Object System.Text.UTF8Encoding($true)))
        }

        $pdfPath = ''
        if ($maskedMode -and -not [string]::IsNullOrWhiteSpace([string]$p.pdf_base64)) {
            Write-KoseiLog ("masked-text なので PDF を破棄しました packet=" + $packetId) 'WARN'
        }
        if (-not $maskedMode -and -not [string]::IsNullOrWhiteSpace([string]$p.pdf_base64)) {
            $pdfName = [string]$p.pdf_name
            if ([string]::IsNullOrWhiteSpace($pdfName)) { $pdfName = $safeId + '.pdf' }
            $pdfPath = Join-Path $jobDir (New-KoseiSafeFileName -FileName $pdfName)
            $cleanupPacket.pdf_path = $pdfPath
            $bytes = [Convert]::FromBase64String([string]$p.pdf_base64)
            [System.IO.File]::WriteAllBytes($pdfPath, $bytes)
        }

        # kind: 'proofread'(既定) | 'consistency'。has_ref: 比較資料(REF)を同梱したか。
        # どちらも pass スケジュールの決定に使う（§7.2 の分担）。未知値は既定へ寄せる。
        $kind = [string]$p.kind
        if (@('proofread', 'consistency') -notcontains $kind) { $kind = 'proofread' }
        # profile: 実行ごとに pass 構成を変えて測るための上書き。空なら settings の既定に従う。
        # 未知の値は握りつぶさず空にする（黙って別の構成で走ると測定が無意味になる）。
        $profile = [string]$p.profile
        if ($profile -and @('quick','standard','thorough','consistency','complement','consistency1','consistency2') -notcontains $profile) {
            Write-KoseiLog ("未知の profile '$profile' を無視します packet=$packetId") 'WARN'
            $profile = ''
        }
        $stage = Get-KoseiPacketStageMetadata -Packet $p
        $saved += @{
            packet_id    = $packetId
            prompt_path  = $promptPath
            pdf_path     = $pdfPath
            text_path    = $textPath
            target_pages = @($p.target_pages | ForEach-Object { [int]$_ })
            kind         = $kind
            has_ref      = [bool]$p.has_ref
            profile      = $profile
            stage_metadata_present = [bool]$stage.stage_metadata_present
            stage_index  = [int]$stage.stage_index
            stage_order  = [int]$stage.stage_order
            stage_total  = [int]$stage.stage_total
            stage_id     = [string]$stage.stage_id
            stage_label  = [string]$stage.stage_label
        }
        }
    # Save-KoseiIncomingJob has already stripped untrusted fields and copied the
    # normalized metadata.  Validate the complete submitted contract before the
    # caller starts any worker; a trailing/internal gap must never become an
    # implicit success barrier.
        $null = Test-KoseiSubmittedStageContract -Packets @($saved)
        return $saved
    } catch {
        try { Remove-KoseiUnregisteredJobInputs -Packets @($cleanupPackets) -UploadsRoot $uploadsRoot -UploadDirs @($jobDir) } catch {}
        throw
    }
}

# ---------------------------------------------------------------------
# pass統計CSV追記（計画書 §7.1 / §13.2）
#   固定schema・allowlist・数値範囲検証・CSVエスケープ・書込みlock・localhost限定。
# ---------------------------------------------------------------------
$script:KoseiPassStatLock = New-Object object

function Format-KoseiCsvField {
    param([string]$Value)
    $v = [string]$Value
    if ($v -match '[",\r\n]') { return '"' + ($v -replace '"', '""') + '"' }
    return $v
}

function Write-KoseiPassStat {
    param([Parameter(Mandatory=$true)]$Record)
    $lensAllow   = @('', 'broad', 'spelling', 'grammar', 'numbers', 'names', 'translation', 'structure', 'gap')
    $statusAllow = @('done', 'warning', 'error', 'skipped', 'restarted')
    $lens = [string]$Record.lens
    if ($lensAllow -notcontains $lens) { throw ("lens が不正です: {0}" -f $lens) }
    $status = [string]$Record.status
    if ($statusAllow -notcontains $status) { throw ("status が不正です: {0}" -f $status) }

    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $asInt = {
        param($v)
        $n = 0
        if (-not [int]::TryParse([string]$v, [ref]$n)) { throw ("数値フィールドが不正です: {0}" -f $v) }
        if ($n -lt 0 -or $n -gt 100000) { throw ("数値が範囲外です: {0}" -f $n) }
        return $n
    }
    $findingsNew  = & $asInt $Record.findings_new
    $findingsDup  = & $asInt $Record.findings_exact_dup
    $findingGroups = & $asInt $Record.finding_groups
    $pagesChecked = & $asInt $Record.pages_checked
    $elapsedMs    = & $asInt $Record.elapsed_ms
    $coverage = 0.0
    if (-not [double]::TryParse([string]$Record.coverage, [System.Globalization.NumberStyles]::Float, $inv, [ref]$coverage)) { $coverage = 0.0 }
    if ($coverage -lt 0) { $coverage = 0.0 }; if ($coverage -gt 1) { $coverage = 1.0 }

    $line = @(
        (Get-Date).ToString('s'),
        (Format-KoseiCsvField ([string]$Record.job_id)),
        (Format-KoseiCsvField ([string]$Record.packet_id)),
        (Format-KoseiCsvField ([string]$Record.pass_id)),
        $lens,
        $status,
        $findingsNew,
        $findingsDup,
        $findingGroups,
        $pagesChecked,
        $coverage.ToString($inv),
        $elapsedMs
    ) -join ','

    $path = Join-Path (Get-KoseiSubDir 'runtime') 'pass-stats.csv'
    # ⚠️ $script: の Monitor では**並列時に同期にならない**。ワーカーは runspace ごとに
    #    Server.ps1 を dot-source するので $script:KoseiPassStatLock は別インスタンスになる。
    #    ログと同じく名前付き Mutex で直列化する（Get-KoseiLogMutex と同型）。
    $mutex = New-Object System.Threading.Mutex($false, 'Local\PdfKoseiAssist.PassStat')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        if (-not (Test-Path -LiteralPath $path)) {
            Add-Content -LiteralPath $path -Encoding UTF8 -Value 'timestamp,job_id,packet_id,pass_id,lens,status,findings_new,findings_exact_dup,finding_groups,pages_checked,coverage,elapsed_ms'
        }
        Add-Content -LiteralPath $path -Encoding UTF8 -Value $line
    } finally {
        if ($held) { try { $null = $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
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
        $ServerState.CloseRequested = $false
        $ServerState.DeferredClose = $false
        $ServerState.DeferredCloseAt = $null
        Send-KoseiBytes -Response $response -StatusCode 204 -ContentType 'text/plain' -Body $null
        return
    }
    if ($path -eq '/__page-closed') {
        # 猶予はハートビート間隔(6秒)より長くする。2秒だと、タブを2つ開いていて片方を閉じただけで
        # 残ったタブのハートビートが届く前に停止してしまう（生きているタブごとアプリが落ちる）。
        # ハートビートを1回受ければ CloseAt は解除されるので、本当に全部閉じたときだけ止まる。
        $ServerState.CloseRequested = $true
        $ServerState.CloseAt = (Get-Date).AddSeconds(10)
        # A running review owns the process until it reaches a terminal state.
        # The browser may disappear, but it must not become the stage scheduler.
        # A terminal result whose import failed still owns a finite recovery
        # lease; an acknowledged result deliberately falls back to 10 seconds.
        $activeJob = if (Get-Command Get-KoseiActiveJobState -ErrorAction SilentlyContinue) { Get-KoseiActiveJobState } else { $null }
        $jobRunning = if (Get-Command Test-KoseiJobRunning -ErrorAction SilentlyContinue) { Test-KoseiJobRunning -State $activeJob } else { $false }
        $recoverable = if (Get-Command Get-KoseiRecoverableJobState -ErrorAction SilentlyContinue) { Get-KoseiRecoverableJobState } else { $null }
        $ServerState.DeferredClose = $jobRunning -or ($null -ne $recoverable)
        if ($ServerState.DeferredClose) { $ServerState.CloseAt = $null; $ServerState.DeferredCloseAt = $null }
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
            # settings.json が壊れていると既定値で動き続けてしまう。画面に出せるよう同梱する。
            $settingsError = ''
            if (Get-Command Get-KoseiSettingsError -ErrorAction SilentlyContinue) { $settingsError = [string](Get-KoseiSettingsError) }
            $payload = @{}
            foreach ($prop in $warmup.PSObject.Properties) { $payload[$prop.Name] = $prop.Value }
            $payload['settings_error'] = $settingsError
            Send-KoseiJson -Response $response -StatusCode 200 -Object $payload
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
            $chainId = if ($body.PSObject.Properties.Name -contains 'recovery_chain_id') { [string]$body.recovery_chain_id } else { '' }
            $parentJobId = if ($body.PSObject.Properties.Name -contains 'recovery_parent_job_id') { [string]$body.recovery_parent_job_id } else { '' }
            $ancestorJobIds = if ($body.PSObject.Properties.Name -contains 'recovery_ancestor_job_ids') { @(ConvertTo-KoseiRecoveryAncestorIdList -Value $body.recovery_ancestor_job_ids) } else { @() }
            $chainRequest = Get-KoseiRecoveryChainRequest -ChainId $chainId -ParentJobId $parentJobId -AncestorJobIds $ancestorJobIds
            if (-not $parentJobId -and @($chainRequest.ancestor_job_ids).Count) { throw '元ジョブのないretryにancestor metadataを指定できません。' }
            if (-not $parentJobId -and $chainId -and @($script:KoseiJobs.Values | Where-Object { (Get-KoseiStateRecoveryChainId -State $_) -eq $chainId.ToLowerInvariant() }).Count) { throw 'recovery_chain_id が既存ジョブと衝突しています。' }
            if ($parentJobId) {
                $parentState = Get-KoseiJobState -JobId $parentJobId
                $parentChainId = if ($parentState) { Get-KoseiStateRecoveryChainId -State $parentState } else { '' }
                if ($null -eq $parentState -or -not $parentChainId -or ($chainId -and $chainId.ToLowerInvariant() -ne $parentChainId) -or -not (Test-KoseiTerminalJobMode -State $parentState) -or -not [bool]$parentState.result_retained) {
                    throw 'retry元ジョブの結果保持が確認できません。'
                }
                $null = Assert-KoseiRecoveryParentCanSpawn -ParentState $parentState -ParentJobId $parentJobId -ChainId $chainId
            }
            $targetFileName = if ($body.PSObject.Properties.Name -contains 'target_file_name') { [string]$body.target_file_name } else { '' }
            $targetPageCount = 0
            if ($body.PSObject.Properties.Name -contains 'target_page_count') { [void][int]::TryParse([string]$body.target_page_count, [ref]$targetPageCount) }
            $targetPdfSha256 = if ($body.PSObject.Properties.Name -contains 'target_pdf_sha256') { [string]$body.target_pdf_sha256 } else { '' }
            $recoveryMetadata = if ($body.PSObject.Properties.Name -contains 'recovery_metadata') { $body.recovery_metadata } else { $null }
            # Verify source lineage before accepting any packet payload.  A retry
            # cannot use recovery_metadata to replace the parent hash/page count,
            # filename, or masking seed after uploads have been written.
            $null = Resolve-KoseiRecoverySourceBinding -TargetFileName $targetFileName -TargetPageCount $targetPageCount -TargetPdfSha256 $targetPdfSha256 -RecoveryMetadata $recoveryMetadata -ParentState $parentState
            $packets = Save-KoseiIncomingJob -Body $body -Settings $Settings
            $attachMode = ''
            if ($body.PSObject.Properties.Name -contains 'attach_mode') { $attachMode = [string]$body.attach_mode }
            try {
                $jobId = Start-KoseiReviewJob -Settings $Settings -Packets $packets -AttachMode $attachMode -TargetFileName $targetFileName -TargetPageCount $targetPageCount -TargetPdfSha256 $targetPdfSha256 -RecoveryMetadata $recoveryMetadata -RecoveryChainId $chainId -RecoveryParentJobId $parentJobId -RecoveryAncestorJobIds $ancestorJobIds
            } catch {
                # A concurrent retry can pass the route preflight and still be
                # rejected at Start-KoseiReviewJob's registration lock.  Do
                # not retain the just-saved sensitive input for a rejected job.
                try { Remove-KoseiUnregisteredJobInputs -Packets $packets -UploadsRoot (Get-KoseiSubDir 'uploads') } catch {}
                throw
            }
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ job_id = $jobId }
            return
        }
        if ($method -eq 'GET' -and $path -match '^/api/review/jobs/([0-9a-f]{32})$') {
            $state = Get-KoseiJobState -JobId $Matches[1]
            if ($null -eq $state -and $script:KoseiPendingRecovery -and [string]$script:KoseiPendingRecovery.id -eq $Matches[1]) { $state = $script:KoseiPendingRecovery }
            if ($null -eq $state) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = 'ジョブが見つかりません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object (ConvertTo-KoseiJobStatusObject -State $state)
            return
        }
        if ($method -eq 'GET' -and $path -match '^/api/review/jobs/([0-9a-f]{32})/result$') {
            $state = Get-KoseiJobState -JobId $Matches[1]
            if ($null -eq $state -and $script:KoseiPendingRecovery -and [string]$script:KoseiPendingRecovery.id -eq $Matches[1]) { $state = $script:KoseiPendingRecovery }
            if ($null -eq $state) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = 'ジョブが見つかりません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object (Get-KoseiJobResultObject -State $state)
            return
        }
        if ($method -eq 'GET' -and $path -eq '/api/review/recoverable/result') {
            $state = Get-KoseiRecoverableJobState
            if ($null -eq $state) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = '保持中の結果が見つかりません。' }; return }
            $result = Get-KoseiRecoveryChainResultObject -State $state
            if ($null -eq $result) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = '保持中の結果が検証できません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object $result
            return
        }
        if ($method -eq 'GET' -and $path -eq '/api/review/recoverable') {
            $state = Get-KoseiRecoverableJobState
            if ($null -eq $state) {
                Send-KoseiJson -Response $response -StatusCode 200 -Object @{ recoverable = $false }
                return
            }
            $payload = Get-KoseiRecoveryChainStatusObject -State $state
            if ($null -eq $payload) { Send-KoseiJson -Response $response -StatusCode 200 -Object @{ recoverable = $false }; return }
            $payload['recoverable'] = $true
            $payload['result_url'] = '/api/review/recoverable/result'
            Send-KoseiJson -Response $response -StatusCode 200 -Object $payload
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/review/recoverable/ack') {
            $ackBody = $null
            if ($request.ContentLength64 -gt 0) { $ackBody = (Read-KoseiRequestBodyText -Request $request -MaxBytes 65536) | ConvertFrom-Json }
            $ackRecoverable = if (-not ($ackBody -and $ackBody.PSObject.Properties.Name -contains 'job_id')) { Get-KoseiRecoverableJobState } else { $null }
            $ackJobId = if ($ackBody -and $ackBody.PSObject.Properties.Name -contains 'job_id') { [string]$ackBody.job_id } elseif ($ackRecoverable) { [string]$ackRecoverable.id } else { '' }
            $ackChainId = if ($ackBody -and $ackBody.PSObject.Properties.Name -contains 'chain_id') { [string]$ackBody.chain_id } else { '' }
            try { $ok = Acknowledge-KoseiJobResult -JobId $ackJobId -ChainId $ackChainId } catch {
                if ($_.Exception.Message -like '*保持確立*') { Send-KoseiJson -Response $response -StatusCode 409 -Object @{ error = $_.Exception.Message; code = 'recovery_not_ready' }; return }
                throw
            }
            if (-not $ok) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = '保持中の結果が見つかりません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true; acknowledged = $true }
            return
        }
        if ($method -eq 'POST' -and $path -match '^/api/review/jobs/([0-9a-f]{32})/ack$') {
            $ackBody = $null
            if ($request.ContentLength64 -gt 0) { $ackBody = (Read-KoseiRequestBodyText -Request $request -MaxBytes 65536) | ConvertFrom-Json }
            $ackChainId = if ($ackBody -and $ackBody.PSObject.Properties.Name -contains 'chain_id') { [string]$ackBody.chain_id } else { '' }
            try { $ok = Acknowledge-KoseiJobResult -JobId $Matches[1] -ChainId $ackChainId } catch {
                if ($_.Exception.Message -like '*保持確立*') { Send-KoseiJson -Response $response -StatusCode 409 -Object @{ error = $_.Exception.Message; code = 'recovery_not_ready' }; return }
                throw
            }
            if (-not $ok) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = '保持中の結果が見つかりません。' }; return }
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true; acknowledged = $true }
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/review/cancel') {
            $active = Get-KoseiActiveJobState
            if ($null -eq $active) { Send-KoseiJson -Response $response -StatusCode 404 -Object @{ error = '実行中のジョブがありません。' }; return }
            $null = Stop-KoseiJob -JobId ([string]$active.id)
            Send-KoseiJson -Response $response -StatusCode 200 -Object @{ ok = $true }
            return
        }
        if ($method -eq 'POST' -and $path -eq '/api/review/pass-stats') {
            if (-not $request.IsLocal) { Send-KoseiJson -Response $response -StatusCode 403 -Object @{ error = 'localhost限定です。' }; return }
            $bodyText = Read-KoseiRequestBodyText -Request $request -MaxBytes 65536
            $rec = $bodyText | ConvertFrom-Json
            Write-KoseiPassStat -Record $rec
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
        CloseRequested      = $false
        DeferredClose       = $false
        DeferredCloseAt     = $null
        ShouldStop          = $false
        StartedAt           = Get-Date
        Url                 = $boundUrl
    }
    $heartbeatTimeoutSec = 3600
    $noBrowserTimeoutSec = 600
    $terminalRecoveryGraceSec = 1800

    try {
        while (-not $serverState.ShouldStop) {
            $task = $listener.GetContextAsync()
            while (-not $task.Wait(200)) {
                if ($serverState.ShouldStop) { break }
                if (Get-Command Try-KoseiResumeInterruptedJob -ErrorAction SilentlyContinue) { $null = Try-KoseiResumeInterruptedJob -Settings $Settings }
                if (Get-Command Invoke-KoseiRetainedRecoverySweep -ErrorAction SilentlyContinue) { $null = Invoke-KoseiRetainedRecoverySweep -Settings $Settings }
                if (-not $NoAutoShutdown) {
                    $now = Get-Date
                    # Automatic shutdown is never allowed to interrupt the
                    # server-owned review worker, including heartbeat and
                    # no-browser timeout paths.  Evaluate this before each
                    # stop condition so a tab may disappear safely.
                    $activeJob = if (Get-Command Get-KoseiActiveJobState -ErrorAction SilentlyContinue) { Get-KoseiActiveJobState } else { $null }
                    $jobRunning = if (Get-Command Test-KoseiJobRunning -ErrorAction SilentlyContinue) { Test-KoseiJobRunning -State $activeJob } else { $false }
                    $recoverable = if (Get-Command Get-KoseiRecoverableJobState -ErrorAction SilentlyContinue) { Get-KoseiRecoverableJobState } else { $null }
                    $jobNeedsRecoveryLease = $jobRunning -or ($null -ne $recoverable)
                    if (-not $jobNeedsRecoveryLease -and -not $serverState.HasBrowserHeartbeat -and (($now - $serverState.StartedAt).TotalSeconds -gt $noBrowserTimeoutSec)) {
                        Write-KoseiLog 'ブラウザ未接続タイムアウトのため停止' 'INFO'; $serverState.ShouldStop = $true; break
                    }
                    if (-not $jobNeedsRecoveryLease -and $serverState.HasBrowserHeartbeat -and (($now - $serverState.LastHeartbeat).TotalSeconds -gt $heartbeatTimeoutSec)) {
                        Write-KoseiLog 'ハートビート断のため停止' 'INFO'; $serverState.ShouldStop = $true; break
                    }
                    if ($serverState.CloseRequested -and $null -ne $serverState.CloseAt -and $now -ge $serverState.CloseAt) {
                        $activeJob = if (Get-Command Get-KoseiActiveJobState -ErrorAction SilentlyContinue) { Get-KoseiActiveJobState } else { $null }
                        $jobRunning = if (Get-Command Test-KoseiJobRunning -ErrorAction SilentlyContinue) { Test-KoseiJobRunning -State $activeJob } else { $false }
                        $recoverable = if (Get-Command Get-KoseiRecoverableJobState -ErrorAction SilentlyContinue) { Get-KoseiRecoverableJobState } else { $null }
                        if ($jobRunning -or ($null -ne $recoverable)) {
                            # Keep polling the server-owned worker.  There is no
                            # 10-second close grace while a job/recovery lease is active.
                            $serverState.DeferredClose = $true
                            $serverState.CloseAt = $null
                            $serverState.DeferredCloseAt = $null
                            Write-KoseiLog (if ($jobRunning) { 'タブ閉鎖後も実行中ジョブを継続します' } else { 'タブ閉鎖後も結果保持のため復元猶予を継続します' }) 'INFO'
                        } else {
                            Write-KoseiLog 'タブ閉鎖検知のため停止' 'INFO'; $serverState.ShouldStop = $true; break
                        }
                    }
                    if ($serverState.DeferredClose) {
                        $activeJob = if (Get-Command Get-KoseiActiveJobState -ErrorAction SilentlyContinue) { Get-KoseiActiveJobState } else { $null }
                        $jobRunning = if (Get-Command Test-KoseiJobRunning -ErrorAction SilentlyContinue) { Test-KoseiJobRunning -State $activeJob } else { $false }
                        if (-not $jobRunning) {
                            if ($null -eq $serverState.DeferredCloseAt) {
                                $serverState.DeferredCloseAt = $now.AddSeconds($terminalRecoveryGraceSec)
                                Write-KoseiLog 'タブ閉鎖後のジョブ結果を保持します' 'INFO'
                            } elseif ($now -ge $serverState.DeferredCloseAt) {
                                Write-KoseiLog 'タブ閉鎖後の結果保持期限を過ぎたため停止' 'INFO'; $serverState.ShouldStop = $true; break
                            }
                        }
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
