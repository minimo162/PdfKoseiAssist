# =====================================================================
# CopilotClient.ps1 — M365 Copilot CDP自動操作（自己完結）
#
# Phase 0（Test-CopilotAttach.ps1、2026-07-03 全判定PASS）で実証したCDPコアを
# 基盤に、依頼文入力・送信・応答待機・JSON抽出を実装する。
#
# PS 5.1 実装規約（仕様書 §8）:
#  1. 非同期の .GetAwaiter().GetResult() は必ず $null = または変数代入で受ける
#     （実行時型 Task<VoidTaskResult> が戻り値をパイプライン汚染するため）
#  2. Invoke-RestMethod のJSON配列応答は必ず平坦化してから使う
#  3. CDPの nodeId はセッションスコープ。DOM操作列は同一WebSocket上で実行する
#  4. サインイン中は login.microsoftonline.com へ遷移するため、ターゲット選択は
#     Copilot URL一致 → 通常http(s)ページ の順でフォールバックする
# =====================================================================

$script:KoseiCdpNextId = 41000
$script:KoseiPageCheckFieldPriority = @('pages_checked','checked_pages','checked_page_summaries')
$script:KoseiWindowStateResetDone = $false
# 添付が進まなくなった窓（WebSocket URL）。次に使うときページごと入れ直すための印。
$script:KoseiAttachStalledWs = @{}

# PowerShell 5.1 でも例外の文字列を壊さずに、worker/ReviewJob 間で
# 再試行可能な失敗種別を渡すための小さな typed-failure helper。
function New-KoseiFailureException {
    param(
        [Parameter(Mandatory=$true)][string]$Message,
        [Parameter(Mandatory=$true)][string]$Kind
    )
    $exception = New-Object System.Exception($Message)
    $exception.Data['KoseiFailureKind'] = $Kind
    return $exception
}

# ConvertTo-Json は PS5.1 で単一要素の配列を扱うときに意図せず
# 二重配列化しやすいため、要素ごとに JSON 文字列化して平坦な配列を作る。
function ConvertTo-KoseiJsonStringArray {
    param([AllowEmptyCollection()][string[]]$Values)
    $parts = @(
        foreach ($value in @($Values)) {
            ConvertTo-Json -InputObject ([string]$value) -Compress
        }
    )
    return '[' + ($parts -join ',') + ']'
}

# ---------------------------------------------------------------------
# Edge / DevTools
# ---------------------------------------------------------------------
function Get-KoseiEdgePath {
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($root in $roots) {
        $p = Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $cmd = Get-Command 'msedge.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'Microsoft Edge が見つかりません。Edge をインストールするか、PATH に msedge.exe を追加してください。'
}

function Test-KoseiDevTools {
    param([int]$Port)
    try {
        $null = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return $true
    } catch { return $false }
}

function Wait-KoseiDevTools {
    param([int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-KoseiDevTools -Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Set-KoseiEdgeWindowMinimized {
    param([Parameter(Mandatory=$true)]$Settings, [AllowNull()]$Page=$null,[string]$Reason='job-start')
    $display='minimized';try{$display=[string]$Settings.browser_display_mode}catch{}
    if($display -eq 'foreground'){return $false}
    $port=[int]$Settings.cdp_port;$ws=$null
    try{
        if($null -eq $Page){$Page=Get-KoseiCopilotPage -Settings $Settings}
        $version=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
        $browserWs=[string]$version.webSocketDebuggerUrl
        if([string]::IsNullOrWhiteSpace($browserWs)){throw 'browser WebSocket URLなし'}
        $targetId=[string]$Page.id;if([string]::IsNullOrWhiteSpace($targetId)){throw 'targetIdなし'}
        $ws=Connect-KoseiWebSocket -WebSocketUrl $browserWs
        $got=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowForTarget' -Params @{targetId=$targetId} -TimeoutSeconds 10
        if($got.error){throw ($got.error|ConvertTo-Json -Compress)}
        $windowId=[int]$got.result.windowId
        $bounds=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowBounds' -Params @{windowId=$windowId} -TimeoutSeconds 10
        if($bounds.error){throw ($bounds.error|ConvertTo-Json -Compress)}
        $state=[string]$bounds.result.bounds.windowState
        if($state -eq 'minimized'){Write-KoseiLog "Edge最小化スキップ state=minimized reason=$Reason" 'DEBUG';return $true}
        $visibleFlag=Join-Path (Get-KoseiSubDir 'runtime') 'copilot-user-visible.flag'
        if($Reason -ne 'startup' -and (Test-Path -LiteralPath $visibleFlag)){
            Write-KoseiLog "Edge最小化スキップ state=$state reason=user-visible" 'DEBUG';return $false
        }
        # 座標には一切触れず、状態だけを直接最小化する。normal化による画面フラッシュを防ぐ。
        $set=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='minimized'}} -TimeoutSeconds 10
        if($set.error){throw ($set.error|ConvertTo-Json -Compress)}
        Write-KoseiLog "Edgeウィンドウ最小化($state→minimized) windowId=$windowId reason=$Reason" 'INFO';return $true
    }catch{Write-KoseiLog ("Edgeウィンドウ最小化に失敗（処理は継続）: "+$_.Exception.Message) 'WARN';return $false}
    finally{if($ws){try{$ws.Dispose()}catch{}}}
}

function Show-KoseiCopilotEdgeWindow {
    param([Parameter(Mandatory=$true)]$Settings)
    $port=[int]$Settings.cdp_port;$ws=$null
    if(-not (Test-KoseiDevTools -Port $port)){Start-KoseiCopilotEdge -Settings $Settings}
    try{
        $page=Get-KoseiCopilotPage -Settings $Settings
        $version=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
        $ws=Connect-KoseiWebSocket -WebSocketUrl ([string]$version.webSocketDebuggerUrl)
        $got=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowForTarget' -Params @{targetId=[string]$page.id} -TimeoutSeconds 10
        if($got.error){throw ($got.error|ConvertTo-Json -Compress)}
        $windowId=[int]$got.result.windowId
        # 状態変更と座標変更は別呼び出しにし、CDP実装差を回避する。
        $normal=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='normal'}} -TimeoutSeconds 10
        if($normal.error){throw ($normal.error|ConvertTo-Json -Compress)}
        $position=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{left=120;top=120;width=1280;height=900}} -TimeoutSeconds 10
        if($position.error){throw ($position.error|ConvertTo-Json -Compress)}
        [System.IO.File]::WriteAllText((Join-Path (Get-KoseiSubDir 'runtime') 'copilot-user-visible.flag'),(Get-Date).ToString('s'),(New-Object System.Text.UTF8Encoding($false)))
        Write-KoseiLog "Copilot画面を表示 windowId=$windowId bounds=120,120,1280,900" 'INFO'
        return $true
    }finally{if($ws){try{$ws.Dispose()}catch{}}}
}

function Reset-KoseiEdgeWindowStateForDetection {
    param([Parameter(Mandatory=$true)]$Settings)
    if ($script:KoseiWindowStateResetDone) { return $false }
    $script:KoseiWindowStateResetDone = $true
    if ([string]$Settings.browser_display_mode -eq 'foreground') { return $false }
    $ws=$null
    try {
        $page=Get-KoseiCopilotPage -Settings $Settings
        $version=Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f [int]$Settings.cdp_port) -TimeoutSec 5
        $ws=Connect-KoseiWebSocket -WebSocketUrl ([string]$version.webSocketDebuggerUrl)
        $got=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowForTarget' -Params @{targetId=[string]$page.id} -TimeoutSeconds 10
        if($got.error){throw ($got.error|ConvertTo-Json -Compress)}
        $windowId=[int]$got.result.windowId
        $r=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='normal'}} -TimeoutSeconds 10
        if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
        $r=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{left=120;top=120;width=1280;height=900}} -TimeoutSeconds 10
        if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
        $r=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='minimized'}} -TimeoutSeconds 10
        if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
        Write-KoseiLog 'ウィンドウ状態リセット実施' 'INFO'
        return $true
    } catch { Write-KoseiLog ('ウィンドウ状態リセット失敗（処理は継続）: '+$_.Exception.Message) 'WARN'; return $false }
    finally { if($ws){try{$ws.Dispose()}catch{}} }
}

function Get-KoseiEdgeProfileDir {
    return (Get-KoseiSubDir 'edge-profile')
}

function Get-KoseiCopilotSessionPath {
    return (Join-Path (Get-KoseiSubDir 'runtime') 'copilot-session.json')
}

function Get-KoseiCopilotLaunchContext {
    $raw = [Environment]::GetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID')
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ present = $false; valid = $false; id = '' }
    }
    $valid = $raw -match '^[A-Fa-f0-9]{32}$'
    return [pscustomobject]@{
        present = $true
        valid = $valid
        id = if ($valid) { $raw.ToLowerInvariant() } else { '' }
    }
}

function Test-KoseiLocalPageUrl {
    param([AllowNull()][string]$Url)
    $value = [string]$Url
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    try {
        $uri = [Uri]$value
        $hostName = [string]$uri.Host
        return @('127.0.0.1', 'localhost', '::1') -contains $hostName.ToLowerInvariant()
    } catch {
        return ($value -like '*://127.0.0.1*' -or $value -like '*://localhost*' -or $value -like '*://[::1]*')
    }
}

function Test-KoseiCopilotTargetPage {
    param(
        [AllowNull()]$Target,
        [Parameter(Mandatory=$true)]$Settings,
        [switch]$AllowBlankUrl
    )
    if ($null -eq $Target -or [string]$Target.type -ne 'page') { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Target.webSocketDebuggerUrl)) { return $false }
    $url = [string]$Target.url
    if (Test-KoseiLocalPageUrl -Url $url) { return $false }
    if ([string]::IsNullOrWhiteSpace($url)) { return $false }
    if ($url -eq 'about:blank') { return [bool]$AllowBlankUrl }
    return ($url -match '^https?://')
}

function Test-KoseiCopilotSessionDescriptor {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [AllowNull()]$Descriptor
    )
    if ($null -eq $Descriptor -or [string]$Descriptor.schema -ne 'kosei-copilot-session-v1') { return $false }
    $port = 0
    if (-not [int]::TryParse([string]$Descriptor.cdp_port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { return $false }
    if ($port -ne [int]$Settings.cdp_port) { return $false }
    $targetId = [string]$Descriptor.target_id
    $launchId = [string]$Descriptor.launch_id
    if ([string]::IsNullOrWhiteSpace($targetId) -or $targetId -notmatch '^[A-Za-z0-9._:-]{1,200}$') { return $false }
    if ([string]::IsNullOrWhiteSpace($launchId) -or $launchId -notmatch '^[A-Fa-f0-9]{32}$') { return $false }
    $createdAt = [DateTime]::MinValue
    try { $createdAt = [DateTime]::Parse([string]$Descriptor.created_at_utc).ToUniversalTime() } catch { return $false }
    $age = [DateTime]::UtcNow - $createdAt
    # A descriptor is only a launch hint.  Old/corrupt state must never be
    # allowed to select a target by itself; callers use safe Copilot discovery.
    if ($age.TotalMinutes -gt 24 * 60 -or $age.TotalMinutes -lt -5) { return $false }
    return $true
}

function Get-KoseiCopilotSessionDescriptor {
    param([Parameter(Mandatory=$true)]$Settings)
    $path = Get-KoseiCopilotSessionPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not (Test-KoseiCopilotSessionDescriptor -Settings $Settings -Descriptor $raw)) { return $null }
        $port = [int]$raw.cdp_port
        $targetId = [string]$raw.target_id
        $launchId = [string]$raw.launch_id
        $createdAt = [DateTime]::MinValue
        try { $createdAt = [DateTime]::Parse([string]$raw.created_at_utc).ToUniversalTime() } catch { return $null }
        return [pscustomobject]@{
            schema = 'kosei-copilot-session-v1'
            launch_id = $launchId
            target_id = $targetId
            cdp_port = $port
            created_at_utc = $createdAt.ToString('o')
        }
    } catch {
        return $null
    }
}

function Write-KoseiCopilotSessionDescriptor {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$TargetId,
        [Parameter(Mandatory=$true)][string]$LaunchId
    )
    if ($TargetId -notmatch '^[A-Za-z0-9._:-]{1,200}$') { throw 'Copilot target ID が不正です。' }
    if ($LaunchId -notmatch '^[A-Fa-f0-9]{32}$') { throw 'Copilot launch ID が不正です。' }
    $path = Get-KoseiCopilotSessionPath
    $dir = Split-Path -Parent $path
    $temp = Join-Path $dir ('.copilot-session.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $descriptor = [ordered]@{
        schema = 'kosei-copilot-session-v1'
        launch_id = $LaunchId
        target_id = $TargetId
        cdp_port = [int]$Settings.cdp_port
        created_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($temp, ($descriptor | ConvertTo-Json -Depth 6 -Compress), $utf8)
        if ([System.IO.File]::Exists($path)) {
            try { [System.IO.File]::Replace($temp, $path, $null) }
            catch { Move-Item -LiteralPath $temp -Destination $path -Force }
        } else {
            [System.IO.File]::Move($temp, $path)
        }
    } finally {
        if ([System.IO.File]::Exists($temp)) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
    return $descriptor
}

# 冷間起動時に msedge.exe のコマンドラインURLで開いた窓を「起動所有ターゲット」として
# 吸収する。続く Target.createTarget(newWindow=true) との二重窓を防ぐため。
# 吸収対象が見つからない場合は $null を返し、呼び出し元が新規作成へフォールバックする。
function Register-KoseiExistingCopilotTarget {
    param([Parameter(Mandatory=$true)]$Settings)
    $launchContext = Get-KoseiCopilotLaunchContext
    if (-not $launchContext.present -or -not $launchContext.valid) { return $null }
    $mutex = New-Object System.Threading.Mutex($false, 'Local\PdfKoseiAssist.CopilotSession')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Copilotセッションの作成ロックを取得できませんでした。' }
        $url = [string]$Settings.copilot_url
        $host1 = ''
        try { $host1 = ([Uri]$url).Host } catch {}
        # コマンドラインURLのタブは起動直後は about:blank として現れ、実URLへの
        # 遷移が遅れることがある。New-KoseiCopilotLaunchTarget と同じ要領で
        # 上限付きでポーリングしてから諦める。mutex保持時間を約5秒に収める。
        $candidates = @()
        $adoptDeadline = [DateTime]::UtcNow.AddSeconds(5)
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $candidates = @(Get-KoseiCdpTargets -Port ([int]$Settings.cdp_port) | Where-Object {
                $_ -and (Test-KoseiCopilotTargetPage -Target $_ -Settings $Settings) -and
                (($host1 -and ([string]$_.url) -like ("*" + $host1 + "*")) -or ([string]$_.url) -like '*copilot*')
            })
            if ($candidates.Count -gt 0) { break }
            if ([DateTime]::UtcNow -ge $adoptDeadline) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($candidates.Count -eq 0) { return $null }
        $exact = @($candidates | Where-Object { [string]$_.url -eq $url })
        $target = $(if ($exact.Count -gt 0) { $exact[0] } else { $candidates[0] })
        $targetId = [string]$target.id
        if ([string]::IsNullOrWhiteSpace($targetId)) { return $null }
        $null = Write-KoseiCopilotSessionDescriptor -Settings $Settings -TargetId $targetId -LaunchId $launchContext.id
        Write-KoseiLog ("起動コマンドライン由来のCopilotタブを起動所有ターゲットとして登録 targetId=$targetId") 'INFO'
        return $target
    } finally {
        if ($held) { try { $null = $mutex.ReleaseMutex() } catch {} }
        try { $mutex.Dispose() } catch {}
    }
}

function Select-KoseiCopilotTarget {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [AllowEmptyCollection()][object[]]$Targets,
        $SessionDescriptor = $null
    )
    $all = @($Targets | Where-Object { $null -ne $_ })
    $descriptor = if ($null -ne $SessionDescriptor) { $SessionDescriptor } else { Get-KoseiCopilotSessionDescriptor -Settings $Settings }
    $descriptorValid = $descriptor -and (Test-KoseiCopilotSessionDescriptor -Settings $Settings -Descriptor $descriptor)
    $launchContext = Get-KoseiCopilotLaunchContext
    if ($launchContext.present) {
        # An ordinary app launch is strict: only the descriptor written by
        # this process launch may authorize a target.  Missing, corrupt,
        # stale, mismatched, or vanished state returns no page; Get-Page then
        # creates one replacement instead of falling back to an old tab.
        if ($launchContext.valid -and $descriptorValid -and
            ([string]$descriptor.launch_id -ieq [string]$launchContext.id)) {
            $owned = @($all | Where-Object { [string]$_.id -eq [string]$descriptor.target_id })
            if ($owned.Count -gt 0 -and (Test-KoseiCopilotTargetPage -Target $owned[0] -Settings $Settings -AllowBlankUrl)) {
                return $owned[0]
            }
            if (Get-Command Write-KoseiLog -ErrorAction SilentlyContinue) {
                Write-KoseiLog ("現在の起動用Copilotターゲットを利用できないため再作成 targetId=$([string]$descriptor.target_id)") 'WARN'
            }
        } elseif (Get-Command Write-KoseiLog -ErrorAction SilentlyContinue) {
            Write-KoseiLog '現在の起動IDに一致するCopilotセッション記述子がないため再作成' 'WARN'
        }
        return $null
    }
    $url = [string]$Settings.copilot_url
    $host1 = ''
    try { $host1 = ([Uri]$url).Host } catch {}
    # Callers without a launch identity are legacy/tool callers.  Preserve
    # their historical Copilot-first discovery: a persisted descriptor must
    # never make about:blank or an unrelated HTTPS page outrank a real
    # Copilot/configured-host target.
    $pages = @($all | Where-Object {
        $_ -and (Test-KoseiCopilotTargetPage -Target $_ -Settings $Settings) -and
        (($host1 -and ([string]$_.url) -like ("*" + $host1 + "*")) -or ([string]$_.url) -like '*copilot*')
    })
    if ($pages.Count -gt 0) { return $pages[0] }

    # A descriptor may still be useful to a benchmark/tool caller when its
    # target is itself a safe Copilot/configured-host page.  Do not use the
    # descriptor's target merely because the descriptor schema is valid:
    # about:blank is only acceptable in the strict current-launch branch
    # above, and unrelated HTTPS pages are not Copilot authorization.
    if ($descriptorValid) {
        $owned = @($all | Where-Object { [string]$_.id -eq [string]$descriptor.target_id })
        if ($owned.Count -gt 0 -and (Test-KoseiCopilotTargetPage -Target $owned[0] -Settings $Settings)) {
            $ownedUrl = [string]$owned[0].url
            $ownedIsSafe = ($host1 -and $ownedUrl -like ("*" + $host1 + "*")) -or ($ownedUrl -like '*copilot*')
            if ($ownedIsSafe) { return $owned[0] }
        }
        if (Get-Command Write-KoseiLog -ErrorAction SilentlyContinue) {
            Write-KoseiLog ("記録済みCopilotターゲットを利用できないため安全な探索へ移行 targetId=$([string]$descriptor.target_id)") 'WARN'
        }
    } elseif ($descriptor -and (Get-Command Write-KoseiLog -ErrorAction SilentlyContinue)) {
        Write-KoseiLog 'Copilotセッション記述子が不正または期限切れのため安全な探索へ移行' 'WARN'
    }

    # Sign-in redirects can temporarily leave the configured host.  Preserve
    # the existing fallback, but never allow the app's localhost page.
    $pages = @($all | Where-Object {
        $_ -and (Test-KoseiCopilotTargetPage -Target $_ -Settings $Settings) -and
        ([string]$_.url -match '^https?://') -and
        ([string]$_.url -notlike '*://127.0.0.1*') -and
        ([string]$_.url -notlike '*://localhost*')
    })
    if ($pages.Count -gt 0) { return $pages[0] }
    return $null
}

function New-KoseiCopilotLaunchTarget {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [switch]$Force
    )
    $mutex = New-Object System.Threading.Mutex($false, 'Local\PdfKoseiAssist.CopilotSession')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Copilotセッションの作成ロックを取得できませんでした。' }

        $launchContext = Get-KoseiCopilotLaunchContext
        if ($launchContext.present -and -not $launchContext.valid) {
            throw '現在のCopilot起動IDが不正です。'
        }
        if (-not $Force -and $launchContext.present -and $launchContext.valid) {
            $existingDescriptor = Get-KoseiCopilotSessionDescriptor -Settings $Settings
            if ($existingDescriptor -and [string]$existingDescriptor.launch_id -ieq [string]$launchContext.id) {
                $existing = @(Get-KoseiCdpTargets -Port ([int]$Settings.cdp_port) | Where-Object {
                    [string]$_.id -eq [string]$existingDescriptor.target_id -and
                    (Test-KoseiCopilotTargetPage -Target $_ -Settings $Settings -AllowBlankUrl)
                }) | Select-Object -First 1
                if ($existing) { return $existing }
            }
        }

        $port = [int]$Settings.cdp_port
        if (-not (Test-KoseiDevTools -Port $port)) { throw 'Copilot用EdgeのCDPが起動していません。' }
        $version = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f $port) -TimeoutSec 5
        $browserWs = [string]$version.webSocketDebuggerUrl
        if ([string]::IsNullOrWhiteSpace($browserWs)) { throw 'ブラウザのWebSocketを取得できません。' }
        $background = $false
        try { $background = ([string]$Settings.browser_display_mode -ne 'foreground') } catch {}
        $created = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.createTarget' -Params @{
            url = [string]$Settings.copilot_url
            newWindow = $true
            background = $background
        } -TimeoutSeconds 30
        if ($created.error) { throw ('起動用Copilotターゲットを作れませんでした: ' + ($created.error | ConvertTo-Json -Compress)) }
        $targetId = [string]$created.result.targetId
        if ([string]::IsNullOrWhiteSpace($targetId)) { throw '起動用CopilotターゲットIDを取得できませんでした。' }
        $target = $null
        for ($i = 0; $i -lt 60; $i++) {
            $target = @(Get-KoseiCdpTargets -Port $port | Where-Object { [string]$_.id -eq $targetId -and (Test-KoseiCopilotTargetPage -Target $_ -Settings $Settings -AllowBlankUrl) }) | Select-Object -First 1
            if ($target) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($null -eq $target) { throw ('起動用Copilotターゲットが見つかりません: ' + $targetId) }
        $launchId = if ($launchContext.present) { $launchContext.id } else { [guid]::NewGuid().ToString('N') }
        $null = Write-KoseiCopilotSessionDescriptor -Settings $Settings -TargetId $targetId -LaunchId $launchId
        Write-KoseiLog ("起動用Copilotターゲットを登録 targetId=$targetId launchId=$launchId") 'INFO'
        return $target
    } finally {
        if ($held) { try { $null = $mutex.ReleaseMutex() } catch {} }
        try { $mutex.Dispose() } catch {}
    }
}

function Start-KoseiCopilotEdge {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [switch]$FreshLaunchTarget
    )
    $port = [int]$Settings.cdp_port
    $url = [string]$Settings.copilot_url
    if (Test-KoseiDevTools -Port $port) {
        if ($FreshLaunchTarget) {
            $page = New-KoseiCopilotLaunchTarget -Settings $Settings -Force
            try { $null = Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'startup' } catch {}
        }
        return
    }
    $edge = Get-KoseiEdgePath
    $userData = Get-KoseiEdgeProfileDir
    $args = @(
        "--remote-debugging-port=$port",
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        "--user-data-dir=$userData",
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate'
    )
    $display = 'minimized'; try { $display = [string]$Settings.browser_display_mode } catch {}
    if ($display -ne 'foreground') { $display = 'minimized' }
    if ($display -eq 'minimized') { $args += '--window-position=-32000,-32000'; $args += '--window-size=1280,900' }
    $args += $url
    Write-KoseiLog "Edge起動$(if($display -eq 'minimized'){'(画面外)'}else{''}): port=$port profile=$userData display=$display" 'INFO'
    try {
        if ($display -eq 'minimized') { Start-Process -FilePath $edge -ArgumentList $args -WindowStyle Minimized | Out-Null }
        else { Start-Process -FilePath $edge -ArgumentList $args | Out-Null }
    } catch {
        if($display -ne 'minimized'){throw}
        Write-KoseiLog ("Edge画面外起動に失敗。引数なし最小化へフォールバック: "+$_.Exception.Message) 'WARN'
        $fallbackArgs=@($args|Where-Object{$_ -notlike '--window-position=*' -and $_ -notlike '--window-size=*'})
        Start-Process -FilePath $edge -ArgumentList $fallbackArgs -WindowStyle Minimized | Out-Null
    }
    if (!(Wait-KoseiDevTools -Port $port -TimeoutSeconds 30)) {
        throw "Edge DevTools Protocol が起動しませんでした。Port=$port。この専用プロファイルの既存Edgeウィンドウをすべて閉じてから再実行してください。"
    }
    if ($FreshLaunchTarget) {
        $page = $null
        try { $page = Register-KoseiExistingCopilotTarget -Settings $Settings } catch {
            Write-KoseiLog ("既存Copilotタブの吸収に失敗しました: " + $_.Exception.Message) 'WARN'
        }
        if ($null -eq $page) { $page = New-KoseiCopilotLaunchTarget -Settings $Settings -Force }
        try { $null = Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'startup' } catch {}
        return
    }
    # -FreshLaunchTarget 以外の冷間起動経路(-NoWarmup後の初回ジョブ等)でも
    # コマンドラインURL窓とcreateTarget窓の二重化が起きるため、こちらでも先に吸収する。
    try { $null = Register-KoseiExistingCopilotTarget -Settings $Settings } catch {
        Write-KoseiLog ("既存Copilotタブの吸収に失敗しました: " + $_.Exception.Message) 'WARN'
    }
    try{$page=Get-KoseiCopilotPage -Settings $Settings;$null=Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'startup'}catch{}
}

# ---------------------------------------------------------------------
# CDPターゲット選択（規約2・4）
# ---------------------------------------------------------------------
function Get-KoseiCdpTargets {
    param([int]$Port)
    $raw = $null
    try { $raw = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5 } catch { return @() }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($item in @($raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Array]) {
            foreach ($inner in $item) { if ($null -ne $inner) { $out.Add($inner) } }
        } else {
            $out.Add($item)
        }
    }
    return $out.ToArray()
}

function Get-KoseiCopilotPage {
    param([Parameter(Mandatory=$true)]$Settings)
    $port = [int]$Settings.cdp_port
    $url = [string]$Settings.copilot_url
    $host1 = ([Uri]$url).Host
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $targets = @(Get-KoseiCdpTargets -Port $port)
        $selected = Select-KoseiCopilotTarget -Settings $Settings -Targets $targets
        if ($null -ne $selected) { return $selected }
        $launchContext = Get-KoseiCopilotLaunchContext
        if ($launchContext.present) {
            try {
                $replacement = New-KoseiCopilotLaunchTarget -Settings $Settings
                if ($null -ne $replacement) { return $replacement }
            } catch {
                Write-KoseiLog ("現在の起動用Copilotターゲットを再作成できないため安全に停止: " + $_.Exception.Message) 'ERROR'
                throw '現在の起動用Copilotターゲットを取得できませんでした。Edge/CDPを確認して再実行してください。'
            }
        }
        $created = $false
        foreach ($method in @('Put', 'Get')) {
            try {
                $null = Invoke-WebRequest -UseBasicParsing -Method $method -Uri ("http://127.0.0.1:$port/json/new?" + [Uri]::EscapeUriString($url)) -TimeoutSec 5
                $created = $true; break
            } catch {}
        }
        Write-KoseiLog "Copilotタブが無いため作成を試行 attempt=$attempt created=$created" 'WARN'
        Start-Sleep -Seconds 2
    }
    throw 'Copilotページ（CDPターゲット）を取得できませんでした。'
}

# 特定のターゲットIDのページを引き直す。
#
# ⚠️ Get-KoseiCopilotPage は「条件に合う最初のページ」を返す。1ウィンドウなら
#    それでよいが、ワーカーごとに別ウィンドウを持たせると**他のワーカーの窓を掴む**。
#    復旧経路（回答取得のCDPエラーが続いたときの再取得）でこれが起きると、
#    2つのワーカーが同じチャットへ書き込み、どちらの回答も壊れる。
#    自分のターゲットを id で引き直せるようにしておく。
function Get-KoseiCopilotPageById {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$TargetId
    )
    $port = [int]$Settings.cdp_port
    foreach ($target in @(Get-KoseiCdpTargets -Port $port)) {
        if (([string]$target.id) -eq $TargetId -and (Test-KoseiCopilotTargetPage -Target $target -Settings $Settings -AllowBlankUrl)) {
            return $target
        }
    }
    throw ("CDPターゲット " + $TargetId + " が見つかりません（ウィンドウが閉じられた可能性があります）。")
}

# ワーカー数ぶんの Copilot ページを用意する（引き継ぎ書 §6.4 #1）。
#
# 先頭は既存のページを使い回す（ウォームアップ済みのため）。2つ目以降は
# **必ず別ウィンドウ**として作る。
#
# ⚠️ 同じウィンドウにタブを並べてはいけない。裏のタブは visibilityState=hidden になり、
#    getBoundingClientRect が 0、innerText が空になる。実測で「画面には見えているのに
#    1文字も取れない」に陥った。占有判定は Start-KoseiEdge の
#    --disable-features=CalculateNativeWinOcclusion 等で無効化してある。
function New-KoseiCopilotWorkerPages {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][int]$Count,
        [int]$ReadyTimeoutSeconds = 180
    )
    if ($Count -lt 1) { throw 'ワーカー数は1以上にしてください。' }
    Start-KoseiCopilotEdge -Settings $Settings
    $port = [int]$Settings.cdp_port
    $pages = @()
    $pages += ,(Get-KoseiCopilotPage -Settings $Settings)
    if ($Count -eq 1) { return $pages }

    $version = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f $port) -TimeoutSec 5
    $browserWs = [string]$version.webSocketDebuggerUrl
    if ([string]::IsNullOrWhiteSpace($browserWs)) { throw 'ブラウザのWebSocketを取得できません。' }

    # ⚠️ ここで作った窓は、呼び出し側が Close-KoseiCopilotWorkerPages で**必ず閉じること**。
    #    途中で失敗した場合は、自分が作った分をここで閉じてから投げ直す（作りかけを残さない）。
    $createdIds = New-Object System.Collections.Generic.List[string]
    try {
        for ($w = 1; $w -lt $Count; $w++) {
            $created = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.createTarget' -Params @{ url = [string]$Settings.copilot_url; newWindow = $true; background = $true } -TimeoutSeconds 30
            if ($created.error) { throw ('ワーカー用ウィンドウを作れませんでした: ' + ($created.error | ConvertTo-Json -Compress)) }
            $newId = [string]$created.result.targetId
            $createdIds.Add($newId)
            $page = $null
            for ($i = 0; $i -lt 60; $i++) {
                Start-Sleep -Milliseconds 500
                try { $page = Get-KoseiCopilotPageById -Settings $Settings -TargetId $newId; break } catch {}
            }
            if ($null -eq $page) { throw ('作ったターゲットが見つかりません: ' + $newId) }
            $ok = Wait-KoseiCopilotInputReady -WsUrl ([string]$page.webSocketDebuggerUrl) -Settings $Settings -TimeoutSeconds $ReadyTimeoutSeconds
            if (-not $ok) { throw ('worker' + $w + ' の Copilot が準備できませんでした（サインインが必要かもしれません）。') }
            $pages += ,$page
        }
    } catch {
        foreach ($leftover in $createdIds) {
            try { $null = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/close/{1}" -f $port, $leftover) -TimeoutSec 5 } catch {}
        }
        throw
    }

    # ⚠️ **窓を重ねてはいけない。完全に覆われた窓は hidden になり、そこに割り当てた
    #    パケットは添付チップすら出ない。**
    #
    #    実測 2026-08-07（10秒ごとに14回サンプル）:
    #      w727298500（元からある窓） visible 2 / hidden 12 / チップ 0
    #      w727299676（ワーカー）     visible 12 / hidden 0
    #      w727299681（ワーカー）     visible 12 / hidden 0
    #      w727299686（ワーカー）     visible 12 / hidden 0 / チップ 2
    #    後から作った窓が元の窓の真上に来て、元の窓だけが完全に隠れていた。
    #    その窓の添付は80秒待っても `chips:0`・アップロード要求ゼロで落ちる。
    #
    #    ⚠️ 起動オプションでは防げない。--disable-backgrounding-occluded-windows も
    #       --disable-features=CalculateNativeWinOcclusion も**入っている**のに hidden になる。
    #       Edge 151 では占有された窓の visibilityState は hidden のままである。
    #       → 位置をずらして「完全に覆われた窓」を作らない、が確実。
    $step = 48
    for ($w = 0; $w -lt $pages.Count; $w++) {
        try {
            $got = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Browser.getWindowForTarget' -Params @{ targetId = [string]$pages[$w].id } -TimeoutSeconds 10
            if ($got.error) { continue }
            $windowId = [int]$got.result.windowId
            $b = $got.result.bounds
            # 最小化されている窓は触らない（利用者が意図して畳んでいることがある）
            if ([string]$b.windowState -eq 'minimized') { continue }
            $null = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Browser.setWindowBounds' -Params @{
                windowId = $windowId
                bounds = @{ left = ([int]$b.left + $step * $w); top = ([int]$b.top + $step * $w); windowState = 'normal' }
            } -TimeoutSeconds 10
        } catch { Write-KoseiLog ("ワーカー窓の位置をずらせませんでした worker=$w : " + $_.Exception.Message) 'WARN' }
    }

    # 可視性を必ず記録する。1つでも hidden なら回答本体を読めず、静かに全滅する。
    for ($w = 0; $w -lt $pages.Count; $w++) {
        $vis = ''
        try {
            $js = "(() => JSON.stringify({ state: document.visibilityState, w: innerWidth, h: innerHeight }))()"
            $vis = [string](Invoke-KoseiCdpEval -WebSocketUrl ([string]$pages[$w].webSocketDebuggerUrl) -Expression $js -TimeoutSeconds 15)
        } catch { $vis = 'eval失敗: ' + $_.Exception.Message }
        $level = if ($vis -like '*hidden*') { 'WARN' } else { 'INFO' }
        Write-KoseiLog ("ワーカーページ worker=$w target=$([string]$pages[$w].id) 可視性=$vis") $level
    }
    return $pages
}

# ワーカー用ウィンドウの後始末。New-KoseiCopilotWorkerPages と必ず対で呼ぶ。
#
# ⚠️ 閉じないと、レビュー1回ごとに（ワーカー数−1）個のEdgeウィンドウが残り続ける。
#    実測（2026-08-05）: ベンチマークを6本回した時点で専用プロファイルのウィンドウが**32個**、
#    msedge.exe が**62プロセス**になっていた。CDPの /json では「ページ」に見えるが、
#    newWindow=$true で作っているので実体は別ウィンドウで、利用者からは
#    「アプリを使うほどEdgeの画面が際限なく増える」という形で出る。
#
# 閉じてはいけないもの:
#   - $Pages[0] … 既存のウォームアップ済み画面。アプリが次のジョブでも使い回す
#   - アプリ画面(127.0.0.1 / localhost) … 閉じると beforeunload が /__page-closed を送り、
#     サーバーが2秒後に停止する（§Reset-App と同じ理由）。ここへ来ることは無いはずだが、
#     掴み間違い（Get-KoseiCopilotPage のフォールバック）を考えて念のため弾く
function Close-KoseiCopilotWorkerPages {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        $Pages
    )
    $list = @($Pages)
    if ($list.Count -le 1) { return }
    $port = [int]$Settings.cdp_port
    $closed = 0
    for ($w = 1; $w -lt $list.Count; $w++) {
        $page = $list[$w]
        if ($null -eq $page) { continue }
        $id = [string]$page.id
        if ([string]::IsNullOrWhiteSpace($id)) { continue }
        $url = [string]$page.url
        if ($url -like '*://127.0.0.1*' -or $url -like '*://localhost*') {
            Write-KoseiLog ("ワーカーページの後始末: アプリ画面なので閉じません target=$id url=$url") 'WARN'
            continue
        }
        try {
            $null = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/close/{1}" -f $port, $id) -TimeoutSec 5
            $closed++
        } catch {
            Write-KoseiLog ("ワーカーページを閉じられませんでした target=$id : " + $_.Exception.Message) 'WARN'
        }
    }
    Write-KoseiLog ("ワーカーページを後始末しました closed=$closed/$($list.Count - 1)") 'INFO'
}

# ---------------------------------------------------------------------
# WebSocket / CDPメソッド
# ---------------------------------------------------------------------
function Receive-KoseiWsMessage {
    param([Parameter(Mandatory=$true)]$WebSocket, [int]$TimeoutSeconds = 30)
    $buffer = New-Object byte[] 65536
    $ms = New-Object System.IO.MemoryStream
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter([TimeSpan]::FromSeconds([Math]::Max(1, $TimeoutSeconds)))
    try {
        do {
            $seg = [ArraySegment[byte]]::new($buffer)
            $res = $WebSocket.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
            if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'CDP WebSocketが閉じられました。' }
            if ($res.Count -gt 0) { $ms.Write($buffer, 0, $res.Count) }
        } while (-not $res.EndOfMessage)
        return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    } catch {
        if ($cts.IsCancellationRequested) { return $null }
        throw ("CDP WebSocket受信失敗: " + $_.Exception.Message)
    } finally {
        try { $cts.Dispose() } catch {}
        try { $ms.Dispose() } catch {}
    }
}

function Connect-KoseiWebSocket {
    param([Parameter(Mandatory=$true)][string]$WebSocketUrl, [int]$TimeoutSeconds = 15)
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    try { $null = $ws.ConnectAsync([Uri]$WebSocketUrl, $cts.Token).GetAwaiter().GetResult() } finally { $cts.Dispose() }
    return $ws
}

function Invoke-KoseiCdpOnSocket {
    param(
        [Parameter(Mandatory=$true)]$WebSocket,
        [Parameter(Mandatory=$true)][string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSeconds = 30
    )
    $reqId = $script:KoseiCdpNextId
    $script:KoseiCdpNextId = $script:KoseiCdpNextId + 1
    $payload = @{ id = $reqId; method = $Method; params = $Params } | ConvertTo-Json -Depth 30 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $seg = [ArraySegment[byte]]::new($bytes)
    $sendCts = [System.Threading.CancellationTokenSource]::new()
    $sendCts.CancelAfter([TimeSpan]::FromSeconds(15))
    try { $null = $WebSocket.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $sendCts.Token).GetAwaiter().GetResult() } finally { $sendCts.Dispose() }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $remaining = [int][Math]::Max(1, [Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
        $message = Receive-KoseiWsMessage -WebSocket $WebSocket -TimeoutSeconds $remaining
        if ([string]::IsNullOrWhiteSpace($message)) { continue }
        $obj = $null
        try { $obj = $message | ConvertFrom-Json } catch { continue }
        if ($obj -and ($obj.PSObject.Properties.Name -contains 'id') -and $obj.id -eq $reqId) { return $obj }
    }
    throw "CDP応答タイムアウト: $Method"
}

function Invoke-KoseiCdpMethod {
    # 単発CDPメソッド（接続使い捨て。DOM操作の連続には使わないこと=規約3）
    param(
        [Parameter(Mandatory=$true)][string]$WebSocketUrl,
        [Parameter(Mandatory=$true)][string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSeconds = 30
    )
    $ws = Connect-KoseiWebSocket -WebSocketUrl $WebSocketUrl
    try {
        return (Invoke-KoseiCdpOnSocket -WebSocket $ws -Method $Method -Params $Params -TimeoutSeconds $TimeoutSeconds)
    } finally {
        try { $ws.Dispose() } catch {}
    }
}

function Invoke-KoseiCdpEval {
    param(
        [Parameter(Mandatory=$true)][string]$WebSocketUrl,
        [Parameter(Mandatory=$true)][string]$Expression,
        [int]$TimeoutSeconds = 30
    )
    $resp = Invoke-KoseiCdpMethod -WebSocketUrl $WebSocketUrl -Method 'Runtime.evaluate' -Params @{
        expression    = $Expression
        awaitPromise  = $true
        returnByValue = $true
        userGesture   = $true
    } -TimeoutSeconds $TimeoutSeconds
    if ($resp.error) { throw ($resp.error | ConvertTo-Json -Compress) }
    if ($resp.result.exceptionDetails) {
        throw ('JavaScript evaluation failed: ' + ($resp.result.exceptionDetails | ConvertTo-Json -Depth 20 -Compress))
    }
    return $resp.result.result.value
}

function Get-KoseiCanonicalHttpsOrigin {
    param([Parameter(Mandatory=$true)][string]$Url)
    $uri = $null
    try { $uri = [Uri]$Url } catch { throw ("URLが不正です: " + $Url) }
    if (-not $uri.IsAbsoluteUri -or [string]::IsNullOrWhiteSpace([string]$uri.Host)) {
        throw ("絶対URLではありません: " + $Url)
    }
    if ([string]$uri.Scheme -ne 'https') {
        throw ("HTTPSではありません: " + $Url)
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$uri.UserInfo)) {
        throw ("ユーザー情報を含むURLは許可されません: " + $Url)
    }
    $hostName = ([string]$uri.IdnHost).ToLowerInvariant()
    return ('https://{0}:{1}' -f $hostName, [int]$uri.Port)
}

function Test-KoseiTrustedCopilotOrigin {
    param(
        [Parameter(Mandatory=$true)][string]$ConfiguredUrl,
        [Parameter(Mandatory=$true)][string]$ActualOrigin
    )
    try {
        return (Get-KoseiCanonicalHttpsOrigin -Url $ConfiguredUrl) -eq (Get-KoseiCanonicalHttpsOrigin -Url $ActualOrigin)
    } catch {
        return $false
    }
}

function Assert-KoseiTrustedCopilotOrigin {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings
    )
    $actualOrigin = [string](Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression '(() => location.origin)()' -TimeoutSeconds 15)
    $configuredUrl = [string]$Settings.copilot_url
    if (-not (Test-KoseiTrustedCopilotOrigin -ConfiguredUrl $configuredUrl -ActualOrigin $actualOrigin)) {
        throw ("添付を中止しました。Copilotの送信先が設定と一致しません（expected={0}, actual={1}）。" -f $configuredUrl, $actualOrigin)
    }
    return $actualOrigin
}

function Assert-KoseiTrustedCopilotOriginOnSocket {
    param(
        [Parameter(Mandatory=$true)]$WebSocket,
        [Parameter(Mandatory=$true)]$Settings
    )
    $response = Invoke-KoseiCdpOnSocket -WebSocket $WebSocket -Method 'Runtime.evaluate' -Params @{
        expression = '(() => location.origin)()'
        returnByValue = $true
    } -TimeoutSeconds 15
    if ($response.error -or $response.result.exceptionDetails) {
        throw '添付直前の送信先確認に失敗しました。'
    }
    $actualOrigin = [string]$response.result.result.value
    $configuredUrl = [string]$Settings.copilot_url
    if (-not (Test-KoseiTrustedCopilotOrigin -ConfiguredUrl $configuredUrl -ActualOrigin $actualOrigin)) {
        throw ("添付を中止しました。Copilotの送信先が添付直前に変わりました（expected={0}, actual={1}）。" -f $configuredUrl, $actualOrigin)
    }
    return $actualOrigin
}

# ---------------------------------------------------------------------
# ページ側JavaScript
# ---------------------------------------------------------------------
function ConvertTo-KoseiJsString {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    return (ConvertTo-Json ([string]$Value))
}

function Get-KoseiChatInputSelectorsJson {
    param([Parameter(Mandatory=$true)]$Settings)
    $sels = @([string[]](Get-KoseiSelector -Settings $Settings -Name 'chat_input_any'))
    return (ConvertTo-Json $sels -Compress)
}

function Wait-KoseiCopilotInputReady {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [int]$TimeoutSeconds = 120,
        [scriptblock]$OnWaiting = $null
    )
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document]; for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument);}catch(e){}}
  for (const d of docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (visible(el)) return JSON.stringify({ ready: true, sel: s, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href, title: document.title });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings))
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
        $state = $null
        try { $state = (Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15) | ConvertFrom-Json } catch {}
        if ($state -and $state.ready -eq $true) { return $true }
        if ($OnWaiting) {
            $u = ''
            if ($state) { $u = [string]$state.url }
            try { & $OnWaiting $u } catch {}
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

$script:KoseiCopilotPacketReadyTimeoutSeconds = 60
$script:KoseiCopilotWarmupWaitTimeoutSeconds = 120

function Get-KoseiCopilotScreenState {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings
    )
    $fileSels=@([string](Get-KoseiSelector -Settings $Settings -Name 'file_input'),[string](Get-KoseiSelector -Settings $Settings -Name 'file_input_fallback'))|Where-Object{$_}
    $fileSelsJson=ConvertTo-Json -InputObject @($fileSels) -Compress
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const fileSels = __FILE_SELS__;
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document], frameInfo=[]; for(const f of document.querySelectorAll('iframe')){let same=false;try{if(f.contentDocument){docs.push(f.contentDocument);same=true;}}catch(e){}frameInfo.push({src:String(f.src||'').slice(0,60),sameOrigin:same});}
  let input=null; for(const d of docs){input=sels.map(s=>({s,el:d.querySelector(s)})).find(x=>visible(x.el));if(input)break;}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button,a,[role="button"],[tabindex]'))).filter(visible);
  const sendButton=buttons.find(el=>/^(送信|send)$|送信|send/i.test((el.getAttribute('aria-label')||el.title||el.textContent||'').trim())&&!el.disabled&&el.getAttribute('aria-disabled')!=='true');
  let attachElement=null;for(const d of docs){for(const s of fileSels){const e=d.querySelector(s);if(e){attachElement=e;break;}}if(attachElement)break;}
  let modelSwitcher=null;for(const d of docs){modelSwitcher=d.querySelector('#gptModeSwitcher');if(modelSwitcher)break;}
  const attachButton=buttons.find(el=>/添付|attach|ファイルを追加|add file/i.test((el.getAttribute('aria-label')||el.title||el.textContent||'').trim()));
  const signIn = buttons.find(el => /sign\s*in|log\s*in|サインイン|ログイン/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
  const url = String(location.href || '');
  const title = String(document.title || '');
  const surface=(/\/conversation\//i.test(url)||/チャット|chat/i.test(title))?'chat':(/copilot/i.test(title)?'home':'unknown');
  const bodyPreview = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const signinRequired = /(?:login|signin|sign-in|auth)/i.test(url) || (!input && !!signIn);
  const editor=document.querySelector('#m365-chat-editor-target-element'), er=editor?editor.getBoundingClientRect():null;
  let shadowHosts=0; for(const el of Array.from(document.querySelectorAll('*')).slice(0,5000)){if(el.shadowRoot)shadowHosts++;}
  const composerReady=!!input&&!!(sendButton||attachElement||attachButton)&&surface==='chat';
  return JSON.stringify({ ready: composerReady, inputVisible:!!input, sendExists:!!sendButton, attachExists:!!attachElement, attachButtonExists:!!attachButton, modelSwitcherExists:!!modelSwitcher, surface,
    selector: input ? input.s : '', signin_required: signinRequired, url, title, bodyPreview,
    buttons:document.querySelectorAll('button').length, editorExists:!!editor, editorRect:er?{w:Math.round(er.width),h:Math.round(er.height)}:null,
    iframes:frameInfo.length, iframeInfo:frameInfo, shadowHosts:shadowHosts });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings)).Replace('__FILE_SELS__',$fileSelsJson)
    try {
        $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
        return ($raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ ready=$false; selector=''; signin_required=$false; url=''; title=''; bodyPreview=('診断取得失敗: ' + $_.Exception.Message) }
    }
}

function Format-KoseiCopilotScreenDiagnostic {
    param($State)
    if ($null -eq $State) { return 'url= title= bodyPreview=' }
    $preview = ([string]$State.bodyPreview -replace '[\r\n]+',' ')
    if ($preview.Length -gt 200) { $preview = $preview.Substring(0, 200) }
    $frames='';try{$frames=($State.iframeInfo|ConvertTo-Json -Compress -Depth 4)}catch{}
    return ('surface={0} url={1} title={2} bodyPreview={3} buttons={4} inputVisible={5} sendExists={6} attachExists={7} attachButtonExists={8} modelSwitcherExists={9} editorExists={10} editorRect={11} iframes={12} iframeInfo={13} shadowHosts={14}' -f [string]$State.surface,[string]$State.url,[string]$State.title,$preview,[string]$State.buttons,[string]$State.inputVisible,[string]$State.sendExists,[string]$State.attachExists,[string]$State.attachButtonExists,[string]$State.modelSwitcherExists,[string]$State.editorExists,($State.editorRect|ConvertTo-Json -Compress),[string]$State.iframes,$frames,[string]$State.shadowHosts)
}

function Wait-KoseiCopilotScreenReady {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [int]$TimeoutSeconds = 60,
        [scriptblock]$ShouldCancel = $null
    )
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
    $last = $null; $sw=[System.Diagnostics.Stopwatch]::StartNew(); $allDeadCount=0; $homeTransitionAttempted=$false
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) {
            return [pscustomobject]@{ ok=$false; cancelled=$true; signin_required=$false; state=$last; message='処理を中止しました。' }
        }
        $last = Get-KoseiCopilotScreenState -WsUrl $WsUrl -Settings $Settings
        if ($last.ready -eq $true) {
            Write-KoseiLog ("準備ゲート通過 elapsedMs="+[int]$sw.ElapsedMilliseconds) 'INFO'
            return [pscustomobject]@{ ok=$true; cancelled=$false; signin_required=$false; state=$last; message='' }
        }
        if ($last.signin_required -eq $true) {
            $diag = Format-KoseiCopilotScreenDiagnostic -State $last
            Write-KoseiLog ('準備ゲート不通過 reason=signin-required elapsedMs=' + [int]$sw.ElapsedMilliseconds + ' ' + $diag) 'ERROR'
            return [pscustomobject]@{ ok=$false; cancelled=$false; signin_required=$true; state=$last; message='Copilotへのサインインが必要です。[Copilot画面を表示]からサインインして、再実行してください。' }
        }
        if([string]$last.surface -eq 'home' -and -not $homeTransitionAttempted){
            $homeTransitionAttempted=$true
            Write-KoseiLog '準備ゲート: surface=home のため新しいチャットへ遷移' 'INFO'
            try{$null=Invoke-KoseiFreshChat -WsUrl $WsUrl -Settings $Settings}catch{Write-KoseiLog ('ホームからチャットへの遷移に失敗（ゲート内で再待機）: '+$_.Exception.Message) 'WARN'}
        }
        if($last.editorExists -ne $true -and $last.ready -ne $true){$allDeadCount++}else{$allDeadCount=0}
        if($allDeadCount -ge 2){$null=Reset-KoseiEdgeWindowStateForDetection -Settings $Settings;$allDeadCount=0}
        Start-Sleep -Milliseconds 500
    }
    if ($null -eq $last) { $last = Get-KoseiCopilotScreenState -WsUrl $WsUrl -Settings $Settings }
    $diag = Format-KoseiCopilotScreenDiagnostic -State $last
    Write-KoseiLog ('準備ゲート不通過 reason=ui-not-ready elapsedMs=' + [int]$sw.ElapsedMilliseconds + ' ' + $diag) 'ERROR'
    return [pscustomobject]@{ ok=$false; cancelled=$false; signin_required=$false; state=$last; message=('Copilot画面が準備できませんでした（URL={0} Title={1}）。[Copilot画面を表示]で状態を確認して、再実行してください。' -f [string]$last.url, [string]$last.title) }
}

function Get-KoseiMainText {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    # innerText はレイアウト結果を読む。タブが非アクティブ（別タブが手前）や最小化中は
    # レイアウトが更新されず空になることがあるため、textContent へ落とす。
    $js = "(() => { const e = document.querySelector('main') || document.body; return (e && (e.innerText || e.textContent)) || ''; })()"
    $text = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    if ($null -eq $text) { return '' }
    return [string]$text
}

# ---------------------------------------------------------------------
# 新規チャット
# ---------------------------------------------------------------------
# ⚠️ 既定の「新しいチャット」はボタンを押すだけなので、**SPA のまま**でページのJSは動き続ける。
#    添付が進まなくなった窓では、チャットを変えても同じ壊れたJSが担当するので直らない。
#    実測 2026-08-07: 同じパケットを3回取り直して3回とも同じ80秒タイムアウトになった。
#    -HardReset を付けると Page.navigate でページごと入れ直す（JSの状態が消える）。
function Invoke-KoseiFreshChat {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings, [switch]$HardReset)
    if ($HardReset) {
        Write-KoseiLog '新規チャット(HardReset): Page.navigate でページごと入れ直します' 'WARN'
        $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Page.navigate' -Params @{ url = [string]$Settings.copilot_url } -TimeoutSeconds 30
        Start-Sleep -Seconds 3
        $null = Wait-KoseiCopilotInputReady -WsUrl $WsUrl -Settings $Settings -TimeoutSeconds $script:KoseiCopilotWarmupWaitTimeoutSeconds
        return [pscustomobject]@{ clicked = $true; label = 'HardReset(Page.navigate)'; hardReset = $true }
    }
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument);}catch(e){}}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button, [role="button"], a, [tabindex]')));
  const candidates=[];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    let score = 0;
    if (/^(新しいチャット|New chat)$/i.test(label)) score += 1000;
    else if (/新しいチャット|New chat/i.test(label)) score += 400;
    else if (/チャット|chat/i.test(label)) score += 80;
    if (/その他|履歴|検索|ライブラリ|削除|共有|delete|remove|share|more|history|search|library/i.test(label)) score -= 1200;
    if (score <= 0) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!visible(b)) continue;
    const r=b.getBoundingClientRect();candidates.push({el:b,label,score,rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
  }
  candidates.sort((a,b)=>b.score-a.score);const best=candidates[0];
  if (best) { best.el.click(); return JSON.stringify({ clicked: true, label: best.label.slice(0,80), score:best.score, rect:best.rect, candidates:candidates.slice(0,6).map(x=>({label:x.label.slice(0,80),score:x.score,rect:x.rect})) }); }
  return JSON.stringify({ clicked: false, candidates:[] });
})()
'@
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $result = $raw | ConvertFrom-Json
    if (-not $result.clicked) {
        # ボタンが見つからない場合はCopilot URLへ再ナビゲート
        Write-KoseiLog '新規チャットボタン未検出のためPage.navigateで初期化' 'WARN'
        $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Page.navigate' -Params @{ url = [string]$Settings.copilot_url } -TimeoutSeconds 20
    }
    Start-Sleep -Milliseconds 800
    return $result
}

# ---------------------------------------------------------------------
# モデルセレクター優先度選択
# ---------------------------------------------------------------------
function Set-KoseiCopilotModel {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $rawSetting = ''
    try { $rawSetting = [string]$Settings.copilot_model } catch {}
    $priority = @($rawSetting -split '[,、\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($priority.Count -eq 0) { return $null }
    $switcherSel = [string](Get-KoseiSelector -Settings $Settings -Name 'model_switcher')
    if ([string]::IsNullOrWhiteSpace($switcherSel)) { $switcherSel = '#gptModeSwitcher' }
    $candidatesJson = if ($priority.Count -eq 1) { '[' + (ConvertTo-KoseiJsString $priority[0]) + ']' } else { ConvertTo-Json -InputObject @($priority) -Compress }
    $jsTpl = @'
(async () => {
  const candidates = __CANDIDATES__;
  const switcherSelector = __SWITCHER__;
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const stripTail = s => norm(s).replace(/[…‥]|\.{3}$/g, '');
  const eq = (a,b) => a.toLowerCase() === b.toLowerCase();
  const has = (a,b) => a.toLowerCase().indexOf(b.toLowerCase()) !== -1;
  const matchesModel = (shown,cand,picked) => {
    const a = stripTail(shown); if (!a) return false;
    if (eq(a,cand) || has(a,cand)) return true;
    if (picked && (eq(a,picked) || has(a,picked))) return true;
    return a.length >= 6 && (has(cand,a) || (picked && has(picked,a)));
  };
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const primaryLabel = el => { const p=el.querySelector('.fai-CapabilityPickerMenuItem__primaryContentWrapper'); if(p)return norm(p.innerText); const c=el.querySelector('.fui-MenuItem__content > span:first-child'); if(c)return norm(c.innerText); return norm((el.innerText||'').split('\n')[0]); };
  const subTextOf = el => { const s=el.querySelector('.fai-CapabilityPickerMenuItem__subText'); return s?norm(s.innerText):''; };
  const itemSelector='[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]';
  const menuRoot=()=>{for(const d of docs){const r=d.querySelector('.fui-MenuPopover')||d.querySelector('[data-portal-node] [role="menu"]');if(r)return r;}return null;};
  const collectItems=()=>{const r=menuRoot();return r?Array.from(r.querySelectorAll(itemSelector)).filter(visible):[];};
  const collectItemsAll=()=>{const roots=docs.flatMap(d=>Array.from(d.querySelectorAll('.fui-MenuPopover, [data-portal-node] [role="menu"]'))).filter(visible);return Array.from(new Set(roots.flatMap(r=>Array.from(r.querySelectorAll(itemSelector)).filter(visible))));};
  const pressEscape=()=>{try{const o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};const t=document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));}catch(e){}};
  const fireEnter=el=>{try{el.focus();const o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keyup',o));return true;}catch(e){return false;}};
  const fireMenuClick=async el=>{try{const r=el.getBoundingClientRect(),cx=r.x+r.width/2,cy=r.y+r.height/2,base={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy};el.dispatchEvent(new PointerEvent('pointerover',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mouseover',base));el.dispatchEvent(new PointerEvent('pointermove',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mousemove',base));try{el.focus();}catch(e){}await sleep(60);el.dispatchEvent(new PointerEvent('pointerdown',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mousedown',{...base,button:0}));el.dispatchEvent(new PointerEvent('pointerup',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mouseup',{...base,button:0}));el.dispatchEvent(new MouseEvent('click',{...base,button:0}));try{el.click();}catch(e){}return true;}catch(e){return false;}};
  const findSwitcher=()=>{for(const d of docs){let b=d.querySelector(switcherSelector);if(b&&visible(b))return b;b=Array.from(d.querySelectorAll('button[aria-haspopup="menu"]')).find(x=>visible(x)&&(/モデル/.test(x.getAttribute('aria-label')||'')||/model/i.test(x.getAttribute('aria-label')||'')));if(b)return b;}return null;};
  const labelItems=xs=>xs.map(el=>({el,label:primaryLabel(el),submenu:el.getAttribute('aria-haspopup')==='menu',testId:el.getAttribute('data-test-id')||'',checked:el.getAttribute('aria-checked')==='true'})).filter(x=>x.label);
  const diagnostics=xs=>xs.slice(0,16).map(x=>({label:x.label,testId:x.testId,submenu:x.submenu,checked:x.checked,raw:norm(x.el.innerText).slice(0,60)}));
  const isGptTrigger=x=>/^gptSubMenuModelTrigger/i.test(x.testId)||(x.submenu&&/^gpt/i.test(x.label))||(x.submenu&&has(subTextOf(x.el),'OpenAI'));
  const findHit=(xs,c)=>xs.find(x=>eq(x.label,c))||xs.find(x=>has(x.label,c))||(/^gpt/i.test(c)?xs.find(isGptTrigger):null);
  const btn=findSwitcher();
  if(!btn)return JSON.stringify({ok:true,changed:false,reason:'switcher_not_found',menuItems:[],subMenuItems:[],skipped:[],clickMethod:null,confirmSamples:[]});
  const current=norm(btn.innerText);
  if(candidates.length&&matchesModel(current,candidates[0],''))return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:candidates[0],priorityIndex:0,menuItems:[],subMenuItems:[],skipped:[],clickMethod:null,confirmSamples:[]});
  await fireMenuClick(btn);
  let items=[];for(let i=0;i<30;i++){items=collectItems();if(items.length)break;await sleep(100);}if(items.length){await sleep(150);const a=collectItems();if(a.length)items=a;}
  if(!items.length){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'menu_not_found',current,menuItems:[],subMenuItems:[],skipped:[],clickMethod:null,confirmSamples:[]});}
  let labeled=labelItems(items),menuItems=diagnostics(labeled),skipped=[],observedSubMenuItems=[];
  const clickAndConfirm=async(hit,cand)=>{
    const before=new Set(collectItemsAll());await fireMenuClick(hit.el);let picked=hit.label,clicked=hit.el,subMenuItems=[],clickMethod='pointer';
    if(hit.submenu){let fresh=[];for(let i=0;i<20;i++){fresh=collectItemsAll().filter(x=>!before.has(x));if(fresh.length)break;await sleep(100);}if(fresh.length){const sub=fresh.map(el=>({el,label:primaryLabel(el)})).filter(x=>x.label);subMenuItems=sub.map(x=>x.label).slice(0,16);const suffix=cand.replace(/^GPT[\s-]*[\d.]*\s*/i,'');const h=sub.find(x=>eq(x.label,cand))||sub.find(x=>has(x.label,cand))||sub.find(x=>eq(x.label,suffix))||sub.find(x=>suffix&&has(x.label,suffix))||sub.find(x=>has(cand,x.label)&&x.label.length>=4);if(!h)return{applied:false,reason:'submenu_no_match',picked,subMenuItems,confirmSamples:[],menuStillOpen:menuRoot()!==null,clickMethod};picked=h.label;clicked=h.el;await fireMenuClick(clicked);}}
    const timeout=hit.submenu?5000:2000,t0=Date.now(),confirmSamples=[];let keyboard=false,menuStillOpen=false,first=true,after='';
    while(Date.now()-t0<timeout){await sleep(first?50:100);first=false;after=norm((findSwitcher()||{innerText:''}).innerText);const t=Date.now()-t0;if(confirmSamples.length<10)confirmSamples.push({t,text:after});if(matchesModel(after,cand,picked))return{applied:true,after,picked,waitedMs:t,subMenuItems,confirmSamples,menuStillOpen:false,clickMethod};menuStillOpen=menuRoot()!==null;if(hit.submenu&&menuStillOpen&&!keyboard&&t>=800){keyboard=true;clickMethod='keyboard';fireEnter(clicked);}}
    return{applied:false,reason:'confirm_failed',after,picked,waitedMs:Date.now()-t0,subMenuItems,confirmSamples,menuStillOpen:menuRoot()!==null,clickMethod};
  };
  for(let pi=0;pi<candidates.length;pi++){const cand=candidates[pi],hit=findHit(labeled,cand);if(!hit){skipped.push({cand,reason:'not_matched'});continue;}if(hit.checked){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:hit.label,priorityIndex:pi,menuItems,subMenuItems:observedSubMenuItems,skipped});}const r=await clickAndConfirm(hit,cand);if(r.subMenuItems&&r.subMenuItems.length)observedSubMenuItems=r.subMenuItems;if(r.applied)return JSON.stringify({ok:true,changed:true,reason:'selected',before:current,after:r.after,picked:r.picked,priorityIndex:pi,waitedMs:r.waitedMs,menuItems,subMenuItems:observedSubMenuItems,skipped,confirmSamples:r.confirmSamples,menuStillOpen:r.menuStillOpen,clickMethod:r.clickMethod});pressEscape();await sleep(150);pressEscape();await sleep(700);const after2=norm((findSwitcher()||{innerText:''}).innerText);if(matchesModel(after2,cand,r.picked||''))return JSON.stringify({ok:true,changed:true,reason:'selected_late',before:current,after:after2,picked:r.picked,priorityIndex:pi,waitedMs:r.waitedMs+700,menuItems,subMenuItems:observedSubMenuItems,skipped,confirmSamples:r.confirmSamples,menuStillOpen:r.menuStillOpen,clickMethod:r.clickMethod});skipped.push({cand,reason:r.reason||'confirm_failed',confirmSamples:r.confirmSamples||[],menuStillOpen:r.menuStillOpen===true,clickMethod:r.clickMethod||'pointer'});const b=findSwitcher();if(!b)break;await fireMenuClick(b);await sleep(300);items=collectItems();if(!items.length)break;labeled=labelItems(items);menuItems=diagnostics(labeled);}
  pressEscape();return JSON.stringify({ok:true,changed:false,reason:'model_not_in_menu',current,tried:candidates,menuItems,subMenuItems:observedSubMenuItems,skipped,clickMethod:null,confirmSamples:[]});
})()
'@
    try {
        $js = $jsTpl.Replace('__CANDIDATES__', $candidatesJson).Replace('__SWITCHER__', (ConvertTo-KoseiJsString $switcherSel))
        $raw = [string](Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20)
        $result = $raw | ConvertFrom-Json
        Write-KoseiLog ("モデル選択結果: " + $raw) 'INFO'
        if ([string]$result.reason -in @('switcher_not_found','menu_not_found','model_not_in_menu')) { Write-KoseiLog ("モデル切替未実施（処理は継続）: " + [string]$result.reason) 'WARN' }
        return $result
    } catch {
        Write-KoseiLog ("モデル切替エラー（処理は継続）: " + $_.Exception.Message) 'WARN'
        return $null
    }
}

# ---------------------------------------------------------------------
# ファイル添付（Phase 0 実証ロジック）
# ---------------------------------------------------------------------
function Get-KoseiAttachmentSnapshot {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [string[]]$ExpectedNames = @(),
        [switch]$IncludeHtml
    )
    $selectors = $Settings.selectors
    $itemSels = New-Object System.Collections.Generic.List[string]
    $nameSels = New-Object System.Collections.Generic.List[string]
    $listSels = New-Object System.Collections.Generic.List[string]
    try { if (-not [string]::IsNullOrWhiteSpace([string]$selectors.attachment_item)) { $itemSels.Add([string]$selectors.attachment_item) } } catch {}
    try { foreach ($s in @($selectors.attachment_item_any)) { if ($s -and -not $itemSels.Contains([string]$s)) { $itemSels.Add([string]$s) } } } catch {}
    try { if (-not [string]::IsNullOrWhiteSpace([string]$selectors.attachment_name)) { $nameSels.Add([string]$selectors.attachment_name) } } catch {}
    try { foreach ($s in @($selectors.attachment_name_any)) { if ($s -and -not $nameSels.Contains([string]$s)) { $nameSels.Add([string]$s) } } } catch {}
    try { if (-not [string]::IsNullOrWhiteSpace([string]$selectors.attachment_list)) { $listSels.Add([string]$selectors.attachment_list) } } catch {}
    try { foreach ($s in @($selectors.attachment_list_any)) { if ($s -and -not $listSels.Contains([string]$s)) { $listSels.Add([string]$s) } } } catch {}
    $toJsonArray = { param($list) if ($list.Count -eq 1) { '[' + (ConvertTo-KoseiJsString $list[0]) + ']' } else { ConvertTo-Json -InputObject @($list.ToArray()) -Compress } }
    $expectedJson = if (@($ExpectedNames).Count -gt 0) { ConvertTo-Json -InputObject @($ExpectedNames) -Compress } else { '[]' }
    $tpl = @'
(() => {
  const itemSels = __ITEM_SELS__, nameSels = __NAME_SELS__, listSels = __LIST_SELS__, expectedNames = __EXPECTED_NAMES__;
  const semanticListSels = [
    '[focusgroup^="toolbar"][aria-label="添付ファイル"]',
    '[focusgroup^="toolbar"][aria-label*="attach" i]'
  ];
  const semanticItemSel = '[data-overflow-item="true"][aria-label]';
  const fallbackItemSels = [
    semanticItemSel,
    '[data-filename]', '[data-file-name]', '[data-attachment-file-name]',
    '.fai-BebopAttachment', '.fai-Attachment', '[class*="Attachment" i]',
    '[role="listitem"]'
  ];
  const fileSuffix = /\.(?:pdf|txt|md|docx?|xlsx?|csv|pptx?|zip)(?:[…‥]|\.)?$/iu;
  const statusOnly = /(?:upload|アップロード|processing|処理中|pending|準備中|loading|読み込み|添付中|進行中|progress|spinner|完了|complete|failed|失敗|error|エラー)/iu;
  const fileTokenRe = /[^\s"'<>()[\]{}、。,:：;；!?！？|]+?\.(?:pdf|txt|md|docx?|xlsx?|csv|pptx?|zip)(?:[…‥])?(?![A-Za-z0-9._-])/igu;
  const knownPrefixRe = /^(?:添付ファイル|ファイル名|filename|file\s*name|attachment|attached|file|name)\s*[:：]?\s*/iu;
  const knownSuffixRe = /(?:\s*(?:[-–—:：|]\s*)?\(?\s*(?:アップロード(?:完了|済み|中)?|uploaded?|uploading|complete(?:d)?|processing|pending|準備中|処理中|完了|失敗|failed|error)\s*\)?\s*)$/iu;
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalize = value => {
    const text = clean(value);
    try { return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' '); }
    catch { return text.toLocaleLowerCase().replace(/\s+/g, ' '); }
  };
  const expected = expectedNames.map(raw => ({ raw: clean(raw), norm: normalize(raw) })).filter(x => x.raw && x.norm);
  const stripDecorations = value => clean(value)
    .replace(/[.…‥]+$/g, '')
    .replace(knownPrefixRe, '')
    .replace(knownSuffixRe, '')
    .replace(/[.…‥]+$/g, '')
    .trim();
  const extractFileTokens = value => {
    const text = clean(value);
    const tokenMatches = text.match(fileTokenRe) || [];
    return [...new Set(tokenMatches.map(stripDecorations).filter(token => fileSuffix.test(token)))];
  };
  const extractNames = value => {
    const text = clean(value);
    if (!text) return [];
    const tokens = extractFileTokens(text);
    if (!expected.length) return tokens;
    const decorated = stripDecorations(text);
    const decoratedNorm = normalize(decorated);
    if (!decoratedNorm || !fileSuffix.test(decorated)) return [];
    return expected.filter(entry => entry.norm === decoratedNorm).map(entry => entry.raw);
  };
  const addNodeValues = (node, values) => {
    if (!node) return;
    values.push(node.textContent);
    try {
      for (const attr of node.getAttributeNames()) {
        if (attr === 'title' || attr.startsWith('aria-') || attr.startsWith('data-')) {
          values.push(node.getAttribute(attr));
        }
      }
    } catch {}
  };
  const nameCandidates = el => {
    if (!el) return [];
    const values = [];
    for (const selector of nameSels) {
      if (!selector) continue;
      try { for (const node of el.querySelectorAll(selector)) addNodeValues(node, values); } catch {}
    }
    addNodeValues(el, values);
    try { for (const node of el.querySelectorAll('*')) addNodeValues(node, values); } catch {}
    return [...new Set(values.flatMap(extractNames).filter(Boolean))];
  };
  const styleOk = x => {
    if (!x) return false;
    const s = x.ownerDocument.defaultView.getComputedStyle(x);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const strict = x => {
    if (!x || !styleOk(x)) return false;
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const loose = x => {
    if (!x || !styleOk(x)) return false;
    try { if (typeof x.checkVisibility === 'function') return x.checkVisibility({ visibilityProperty: true }); } catch {}
    for (let e = x; e && e.nodeType === 1; e = e.parentElement) if (!styleOk(e)) return false;
    return true;
  };
  // 現行M365の .fai-BebopLiteChatInput__attachments は複数チップを包むだけの
  // aggregate wrapper。これを1アイテムとして数えると一対一照合がタイムアウトするため、
  // semantic item の子を持つ wrapper は候補から除外する。
  const isAggregateWrapper = x => {
    if (!x || !x.matches) return false;
    try { if (x.matches(semanticItemSel)) return false; } catch {}
    try { return !!x.querySelector(semanticItemSel); } catch { return false; }
  };
  const isItemCandidate = x => !!x && !isAggregateWrapper(x);
  let laxUsed = false;
  const pick = (root, selectors, itemCandidates = false) => {
    for (const selector of selectors) {
      if (!selector) continue;
      let found = [];
      try { found = Array.from(root.querySelectorAll(selector)).filter(x => strict(x) && (!itemCandidates || isItemCandidate(x))); } catch {}
      if (found.length) return { found, sel: selector };
    }
    for (const selector of selectors) {
      if (!selector) continue;
      let found = [];
      try { found = Array.from(root.querySelectorAll(selector)).filter(x => loose(x) && (!itemCandidates || isItemCandidate(x))); } catch {}
      if (found.length) { laxUsed = true; return { found, sel: selector }; }
    }
    return { found: [], sel: '' };
  };
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  let list = null, usedListSelector = '';
  for (const doc of docs) {
    const result = pick(doc, [...new Set([...listSels, ...semanticListSels])]);
    if (result.found.length) { list = result.found[result.found.length - 1]; usedListSelector = result.sel; break; }
  }
  const scope = list || document;
  let els = [], usedItemSelector = '';
  { const result = pick(scope, itemSels, true); els = result.found; usedItemSelector = result.sel; }
  const appendVisibleNodes = (selector, seen) => {
    if (!selector) return 0;
    let found = [];
    try { found = Array.from(scope.querySelectorAll(selector)).filter(x => strict(x) && isItemCandidate(x)); } catch {}
    if (!found.length) {
      try {
        found = Array.from(scope.querySelectorAll(selector)).filter(x => loose(x) && isItemCandidate(x));
        if (found.length) laxUsed = true;
      } catch {}
    }
    let added = 0;
    for (const el of found) {
      if (seen.has(el)) continue;
      seen.add(el);
      els.push(el);
      added++;
    }
    return added;
  };
  if (expected.length) {
    const seen = new Set(els);
    const expectedCovered = () => expected.every(entry =>
      els.some(el => nameCandidates(el).some(name => normalize(name) === entry.norm)));
    const fallbackUsed = [];
    for (const selector of fallbackItemSels) {
      if (expectedCovered()) break;
      if (appendVisibleNodes(selector, seen) > 0) fallbackUsed.push(selector);
    }
    if (fallbackUsed.length) {
      const primaryLabel = usedItemSelector ? 'primary:' + usedItemSelector : 'fallback';
      usedItemSelector = primaryLabel + ' + ' + fallbackUsed.map(selector => 'fallback:' + selector).join(' + ');
    }
  } else if (!els.some(el => nameCandidates(el).length)) {
    for (const selector of fallbackItemSels) {
      let found = [];
      try { found = Array.from(scope.querySelectorAll(selector)).filter(el => isItemCandidate(el) && nameCandidates(el).length && (strict(el) || loose(el))); } catch {}
      if (found.length) { els = found; usedItemSelector = 'fallback:' + selector; break; }
    }
  }
  const items = els.map(el => {
    const names = nameCandidates(el);
    const liveEl = (el.matches && el.matches('[aria-live]')) ? el : el.querySelector('[aria-live]');
    const busy = !!((el.matches && el.matches('[role="progressbar"],progress,[aria-busy="true"],[class*="progress" i],[class*="spinner" i]'))
      || el.querySelector('[role="progressbar"],progress,[aria-busy="true"],[class*="progress" i],[class*="spinner" i]'));
    return { name: names[0] || '', names, live: liveEl ? clean(liveEl.textContent) : '', busy };
  });
  return JSON.stringify({ count: items.length, items, usedItemSelector, usedListSelector, laxUsed, listHtml: list ? list.outerHTML.slice(0, 4000) : '' });
})()
'@
    $js = $tpl.
        Replace('__ITEM_SELS__', (& $toJsonArray $itemSels)).
        Replace('__NAME_SELS__', (& $toJsonArray $nameSels)).
        Replace('__LIST_SELS__', (& $toJsonArray $listSels)).
        Replace('__EXPECTED_NAMES__', $expectedJson)
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $snap = $raw | ConvertFrom-Json
    if (-not $IncludeHtml) { $snap.listHtml = '' }
    return $snap
}

function Test-KoseiAttachmentNameMatch {
    param([AllowNull()][string]$Actual, [AllowNull()][string]$Expected)
    $norm = {
        param($s)
        $v = ([string]$s).Trim()
        try { $v = $v.Normalize([System.Text.NormalizationForm]::FormKC) } catch {}
        $v = [regex]::Replace($v, '\s+', ' ').ToLowerInvariant()
        return $v
    }
    $a = & $norm $Actual
    $e = & $norm $Expected
    $a = [regex]::Replace($a, '[.…‥]+$', '')
    $e = [regex]::Replace($e, '[.…‥]+$', '')
    if ($a -eq $e) { return $true }
    if ([IO.Path]::GetExtension($a) -ne [IO.Path]::GetExtension($e)) { return $false }
    return ([IO.Path]::GetFileName($a) -eq [IO.Path]::GetFileName($e))
}

function Test-KoseiAttachmentSnapshotHasName {
    param(
        [AllowNull()]$Snapshot,
        [Parameter(Mandatory=$true)][string]$Expected
    )
    foreach ($item in @($Snapshot.items)) {
        $candidates = @([string]$item.name)
        try { $candidates += @($item.names | ForEach-Object { [string]$_ }) } catch {}
        foreach ($candidate in $candidates) {
            if (Test-KoseiAttachmentNameMatch -Actual $candidate -Expected $Expected) { return $true }
        }
    }
    return $false
}

function Invoke-KoseiSetFileInputFile {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$File
    )
    $selector = [string](Get-KoseiSelector -Settings $Settings -Name 'file_input')
    $fallback = [string](Get-KoseiSelector -Settings $Settings -Name 'file_input_fallback')
    $ws = $null
    try {
        $ws = Connect-KoseiWebSocket -WebSocketUrl $WsUrl
        $null = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.enable'
        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.getDocument' -Params @{ depth = 1 }
        if ($r.error) { throw ('DOM.getDocument failed: ' + ($r.error | ConvertTo-Json -Compress)) }
        $rootId = [int]$r.result.root.nodeId
        $nodeId = 0
        foreach ($sel in @($selector, $fallback)) {
            if ([string]::IsNullOrWhiteSpace([string]$sel)) { continue }
            $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.querySelector' -Params @{ nodeId = $rootId; selector = [string]$sel }
            $found = 0
            if (-not $r.error -and $r.result -and $r.result.nodeId) { $found = [int]$r.result.nodeId }
            if ($found -gt 0) { $nodeId = $found; break }
        }
        if ($nodeId -le 0) {
            # same-origin iframe 内へ移動した file input を Runtime から取得する。
            $selsJson = ConvertTo-Json -InputObject @($selector, $fallback) -Compress
            $expr = "(() => { const sels=$selsJson,docs=[document]; for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}} for(const d of docs)for(const s of sels){const e=d.querySelector(s);if(e)return e;} return null; })()"
            $ev = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Runtime.evaluate' -Params @{ expression=$expr; returnByValue=$false; userGesture=$true } -TimeoutSeconds 15
            $objectId = ''
            if (-not $ev.error -and $ev.result -and $ev.result.result) { $objectId = [string]$ev.result.result.objectId }
            if (-not [string]::IsNullOrWhiteSpace($objectId)) {
                $rq = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.requestNode' -Params @{ objectId=$objectId } -TimeoutSeconds 15
                if (-not $rq.error) { $nodeId = [int]$rq.result.nodeId }
            }
        }
        if ($nodeId -le 0) {
            $screen = Get-KoseiCopilotScreenState -WsUrl $WsUrl -Settings $Settings
            $diag = Format-KoseiCopilotScreenDiagnostic -State $screen
            throw ("添付入力を検出できませんでした。selector=$selector / fallback=$fallback / " + $diag)
        }
        # ノードを毎回取り直した直後、同じCDP socketで送信先を再確認する。
        $null = Assert-KoseiTrustedCopilotOriginOnSocket -WebSocket $ws -Settings $Settings
        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.setFileInputFiles' -Params @{
            nodeId = $nodeId
            files = @([string]$File)
        }
        if ($r.error) { throw ('DOM.setFileInputFiles failed: ' + ($r.error | ConvertTo-Json -Compress)) }
        return [pscustomobject]@{ ok=$true; file=[string]$File; nodeId=$nodeId }
    } finally {
        if ($null -ne $ws) { try { $ws.Dispose() } catch {} }
    }
}

function Wait-KoseiAttachmentChip {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$Expected,
        [int]$TimeoutSeconds = 60,
        [scriptblock]$ShouldCancel = $null
    )
    $deadline = (Get-Date).AddSeconds([Math]::Max(15, $TimeoutSeconds))
    $lastError = ''
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) {
            try { $null = Invoke-KoseiClickStop -WsUrl $WsUrl } catch {}
            return [pscustomobject]@{ ok=$false; cancelled=$true; expected=$Expected }
        }
        try {
            $snap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -ExpectedNames @($Expected)
            if (Test-KoseiAttachmentSnapshotHasName -Snapshot $snap -Expected $Expected) {
                return [pscustomobject]@{ ok=$true; cancelled=$false; expected=$Expected; snapshot=$snap }
            }
        } catch {
            $lastError = [string]$_.Exception.Message
        }
        Start-Sleep -Milliseconds 250
    }
    return [pscustomobject]@{ ok=$false; cancelled=$false; expected=$Expected; error=$lastError }
}

function Invoke-KoseiAttachmentSequence {
    param(
        [Parameter(Mandatory=$true)][string[]]$Files,
        [Parameter(Mandatory=$true)][scriptblock]$SetFile,
        [Parameter(Mandatory=$true)][scriptblock]$WaitForChip,
        [scriptblock]$ShouldCancel = $null,
        [scriptblock]$OnCancel = $null
    )
    foreach ($file in $Files) {
        if ($ShouldCancel -and (& $ShouldCancel)) {
            if ($OnCancel) { try { & $OnCancel } catch {} }
            return [pscustomobject]@{ ok=$false; cancelled=$true; file=$file }
        }
        & $SetFile $file
        $wait = & $WaitForChip $file
        if ($wait.cancelled -eq $true) {
            return [pscustomobject]@{ ok=$false; cancelled=$true; file=$file }
        }
        if ($wait.ok -ne $true) {
            throw ("添付チップが確認できませんでした: " + $file + " / " + [string]$wait.error)
        }
    }
    return [pscustomobject]@{ ok=$true; cancelled=$false; count=$Files.Count }
}

function Clear-KoseiResidualAttachments {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [string]$Reason = 'start',
        [string[]]$ExpectedNames = @()
    )
    $snap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -ExpectedNames $ExpectedNames
    if ([int]$snap.count -le 0) { return $snap }
    # 設定が旧版のままでも、現行M365の focusgroup リストを安全側の組み込み候補として見る。
    $listSels=@('[focusgroup^="toolbar"][aria-label="添付ファイル"]','[focusgroup^="toolbar"][aria-label*="attach" i]')
    try { foreach ($s in @($Settings.selectors.attachment_list_any)) { if ($s -and -not $listSels.Contains([string]$s)) { $listSels += [string]$s } } } catch {}
    try { if ($Settings.selectors.attachment_list) { $listSels=@([string]$Settings.selectors.attachment_list)+$listSels } } catch {}
    $itemSels=@('[data-overflow-item="true"][aria-label]')
    try { foreach ($s in @($Settings.selectors.attachment_item_any)) { if ($s -and -not $itemSels.Contains([string]$s)) { $itemSels += [string]$s } } } catch {}
    try { if ($Settings.selectors.attachment_item) { $itemSels=@([string]$Settings.selectors.attachment_item)+$itemSels } } catch {}
    $listJson=ConvertTo-Json -InputObject @($listSels) -Compress
    $itemJson=ConvertTo-Json -InputObject @($itemSels) -Compress
    $tpl=@'
(() => {
  const sels=__LIST_SELS__, itemSels=__ITEM_SELS__;
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const semanticItemSel='[data-overflow-item="true"][aria-label]';
  const isItem=e=>{if(!e||!e.matches)return false;try{if(e.matches(semanticItemSel))return true;return !e.querySelector(semanticItemSel);}catch(x){return false;}};
  let list=null;
  for(const s of sels){let a=[];try{a=Array.from(document.querySelectorAll(s)).filter(visible);}catch(x){}if(a.length){list=a[a.length-1];break;}}
  if(!list)return JSON.stringify({clicked:0});
  const items=[],seenItems=new Set();
  for(const s of itemSels){if(!s)continue;let found=[];try{found=Array.from(list.querySelectorAll(s)).filter(e=>isItem(e)&&visible(e));}catch(x){}for(const e of found){if(seenItems.has(e))continue;seenItems.add(e);items.push(e);}}
  const buttons=[],seenButtons=new Set();
  for(const item of items){let found=[];try{found=Array.from(item.querySelectorAll('.fai-BebopAttachment__dismissButton,button[aria-label*="削除"],button[aria-label*="remove" i],button[aria-label*="dismiss" i]')).filter(visible);}catch(x){}for(const b of found){if(seenButtons.has(b))continue;seenButtons.add(b);buttons.push(b);}}
  buttons.forEach(b=>b.click());
  return JSON.stringify({clicked:buttons.length,items:items.length});
})()
'@
    $null=Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression ($tpl.Replace('__LIST_SELS__',$listJson).Replace('__ITEM_SELS__',$itemJson)) -TimeoutSeconds 20
    $names=@($snap.items|ForEach-Object{$_.name}) -join ','
    Write-KoseiLog "残留添付を削除 count=$($snap.count) names=$names reason=$Reason" 'WARN'
    Start-Sleep -Seconds 1
    $after=Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings
    if ([int]$after.count -gt 0) { Write-KoseiLog "残留添付が削除後も残っています count=$($after.count)" 'WARN' }
    return $after
}

function Invoke-KoseiCopilotAttachFiles {
    # DOM.setFileInputFiles（同一セッション=規約3）→ チップ出現 → 完了文言待機
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string[]]$Files,
        [scriptblock]$ShouldCancel = $null
    )
    foreach ($f in $Files) {
        if (!(Test-Path -LiteralPath $f -PathType Leaf)) { throw "添付対象ファイルが見つかりません: $f" }
    }
    # CDPターゲットの選択やリダイレクトが誤っていても、機密ファイルを別Originへ渡さない。
    # file inputの探索・残留添付の操作より前に、設定したHTTPS Originとの完全一致を確認する。
    $trustedOrigin = Assert-KoseiTrustedCopilotOrigin -WsUrl $WsUrl -Settings $Settings
    Write-KoseiLog ("添付先Origin確認: " + $trustedOrigin) 'INFO'
    # 自動校正中は Edge を前面へ奪わない。visibilityState は環境差で
    # hidden になることがあるため、事前拒否せず警告だけ記録して添付を試す。
    # 実際の CDP/DOM 操作結果を packet 単位のエラーとして扱い、他 worker を止めない。
    $initialVisibility = ''
    try {
        $visibility = [string](Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression '(() => document.visibilityState)()' -TimeoutSeconds 10)
        $initialVisibility = $visibility
        if ($visibility -ne 'visible') {
            Write-KoseiLog 'Copilot画面が非表示ですが、添付を試行します（自動前面化はしません）。' 'WARN'
        }
    } catch {
        # visibility の診断自体が失敗しても、添付の実処理を試行する。
    }
    $expected = @($Files | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    $duplicateNames = @($expected | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { [string]$_.Name })
    if ($duplicateNames.Count) {
        throw ('同名の添付ファイルは識別できません。ファイル名を一意にしてください: ' + ($duplicateNames -join ', '))
    }
    $null = Clear-KoseiResidualAttachments -WsUrl $WsUrl -Settings $Settings -ExpectedNames $expected -Reason 'packet-start'
    $uploadBaselineMs = $null
    $uploadBaselineAvailable = $false
    try {
        $baselineText = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression '(() => performance.now())()' -TimeoutSeconds 15
        if ($null -ne $baselineText -and [string]$baselineText -match '^-?\d+(?:\.\d+)?$') {
            $uploadBaselineMs = [double]$baselineText
            $uploadBaselineAvailable = $true
        }
    } catch { Write-KoseiLog ("添付resource baseline取得に失敗（進展判定は保守的に扱います）: " + $_.Exception.Message) 'WARN' }

    $totalBytes = 0
    foreach ($f in $Files) { try { $totalBytes += [int64](Get-Item -LiteralPath $f).Length } catch {} }
    $totalMb = [Math]::Ceiling($totalBytes / 1MB)
    $perMb = 20
    try { if ([int]$Settings.attach_wait_seconds_per_mb -gt 0) { $perMb = [int]$Settings.attach_wait_seconds_per_mb } } catch {}
    $waitSec = [int]$Settings.attach_wait_seconds + ($totalMb * $perMb)
    $appearanceWaitSec = [Math]::Max(15, [int]$Settings.attach_wait_seconds)

    $sequence = Invoke-KoseiAttachmentSequence -Files $Files -SetFile {
        param($file)
        Invoke-KoseiSetFileInputFile -WsUrl $WsUrl -Settings $Settings -File ([string]$file)
    } -WaitForChip {
        param($file)
        Wait-KoseiAttachmentChip -WsUrl $WsUrl -Settings $Settings -Expected ([string]([System.IO.Path]::GetFileName($file))) -TimeoutSeconds $appearanceWaitSec -ShouldCancel $ShouldCancel
    } -ShouldCancel $ShouldCancel -OnCancel {
        try { $null = Invoke-KoseiClickStop -WsUrl $WsUrl } catch {}
    }
    if ($sequence.cancelled -eq $true) {
        return [pscustomobject]@{ ok=$false; completedBy='cancelled'; elapsedMs=0 }
    }

    # チップ出現→完了文言（フォールバックなし。失敗時は例外停止）
    $doneRe = [regex]::new([string](Get-KoseiSelector -Settings $Settings -Name 'upload_done_pattern'), 'IgnoreCase')
    $failRe = [regex]::new([string](Get-KoseiSelector -Settings $Settings -Name 'upload_fail_pattern'), 'IgnoreCase')
    # 添付の待ち時間は中身の大きさで決める。60秒固定だと、25ページのパケット（0.3MB程度）と
    # 100ページのパケット（1MB超）を同じ物差しで測ることになり、
    # 「大きくて時間がかかっている」のか「検出できていない」のか区別できない。
    # 実測で幅100が60秒で失敗したが、それが限界なのか単に遅いのかを分けられなかった。
    $totalBytes = 0
    foreach ($f in $Files) { try { $totalBytes += [int64](Get-Item -LiteralPath $f).Length } catch {} }
    $totalMb = [Math]::Ceiling($totalBytes / 1MB)
    $perMb = 20
    try { if ([int]$Settings.attach_wait_seconds_per_mb -gt 0) { $perMb = [int]$Settings.attach_wait_seconds_per_mb } } catch {}
    $waitSec = [int]$Settings.attach_wait_seconds + ($totalMb * $perMb)
    $deadline = (Get-Date).AddSeconds([Math]::Max(15, $waitSec))
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $stableCounts=@{}; $lastLogSecond=-10; $zeroHtmlLogged=$false; $lastSnap=$null; $lastMatches=@()
    $initialSnap=Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -ExpectedNames $expected
    Write-KoseiLog ("添付完了待機開始 files="+($expected-join ',')+" totalMB=$totalMb waitSec=$waitSec usedItemSelector='"+[string]$initialSnap.usedItemSelector+"'") 'INFO'
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) { $null=Invoke-KoseiClickStop -WsUrl $WsUrl; return [pscustomobject]@{ok=$false;completedBy='cancelled';elapsedMs=[int]$sw.ElapsedMilliseconds} }
        Start-Sleep -Milliseconds 500
        $snap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -ExpectedNames $expected
        $lastSnap=$snap
        $items = @($snap.items)
        $mine = @()
        foreach ($itemIndex in 0..([Math]::Max(0, $items.Count - 1))) {
            if ($items.Count -eq 0) { break }
            $item = $items[$itemIndex]
            $actualNames = @([string]$item.name)
            try { $actualNames += @($item.names | ForEach-Object { [string]$_ }) } catch {}
            if (@($actualNames | Where-Object {
                $candidate = $_
                @($expected | Where-Object { Test-KoseiAttachmentNameMatch -Actual $candidate -Expected $_ }).Count -gt 0
            }).Count -gt 0) { $mine += $item }
        }
        $lastMatches=$mine
        $failed = @($mine | Where-Object { $_.live -and $failRe.IsMatch([string]$_.live) })
        if ($failed.Count -gt 0) {
            throw ("添付アップロード失敗: " + (($failed | ForEach-Object { $_.name + ' => ' + $_.live }) -join ' | '))
        }
        $doneNames=@(); $doneBy='live-pattern'; $usedItemIndexes=New-Object System.Collections.Generic.HashSet[int]
        for ($expectedIndex = 0; $expectedIndex -lt $expected.Count; $expectedIndex++) {
            $n = [string]$expected[$expectedIndex]
            $candidateIndex = -1
            for ($itemIndex = 0; $itemIndex -lt $items.Count; $itemIndex++) {
                if ($usedItemIndexes.Contains($itemIndex)) { continue }
                $xNames = @([string]$items[$itemIndex].name)
                try { $xNames += @($items[$itemIndex].names | ForEach-Object { [string]$_ }) } catch {}
                if (@($xNames | Where-Object { Test-KoseiAttachmentNameMatch -Actual $_ -Expected $n }).Count -gt 0) {
                    $candidateIndex = $itemIndex
                    break
                }
            }
            if ($candidateIndex -lt 0) { continue }
            $null = $usedItemIndexes.Add($candidateIndex)
            $x = $items[$candidateIndex]
            if ($x.live -and $doneRe.IsMatch([string]$x.live)) {
                $doneNames += $n; $stableCounts[$n]=0; $doneBy='live-pattern'
            } elseif (-not $x.busy -and -not ($x.live -and $failRe.IsMatch([string]$x.live)) -and
                -not ($x.live -and [regex]::IsMatch([string]$x.live, 'upload|アップロード|processing|処理中|pending|準備中|loading|読み込み|添付中|進行中', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase))) {
                $stableCounts[$n]=1+[int]$stableCounts[$n]
                if ([int]$stableCounts[$n] -ge 2) { $doneNames+=$n; $doneBy='stable-chip' }
            } else { $stableCounts[$n]=0 }
        }
        $allDone = ($usedItemIndexes.Count -eq $expected.Count) -and ($doneNames.Count -eq $expected.Count)
        # 期待ファイルが一対一で割り当てられ、安定確認を終えた時点で直ちに成功を返す。
        # 成功済みなのにdeadlineまで待ち続けると、添付は完了していてもタイムアウト扱いになる。
        if ($allDone) {
            return [pscustomobject]@{
                ok = $true
                completedBy = $doneBy
                elapsedMs = [int]$sw.ElapsedMilliseconds
            }
        }
        $sec=[int][Math]::Floor($sw.Elapsed.TotalSeconds)
        if($sec -eq 0 -or $sec-$lastLogSecond -ge 10){$lastLogSecond=$sec;$names=@($snap.items|ForEach-Object{$_.name})-join '|';$lives=@($snap.items|ForEach-Object{$_.live})-join '|';Write-KoseiLog "添付待機中 elapsedSec=$sec count=$($snap.count) names=$names lives=$lives usedItemSelector='$($snap.usedItemSelector)' laxUsed=$([bool]$snap.laxUsed)" 'INFO'}
        if(-not $zeroHtmlLogged -and $sec -ge 10 -and [int]$snap.count -eq 0){$evidence=Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -ExpectedNames $expected -IncludeHtml;Write-KoseiLog ("添付チップ未検出10秒 listHtml="+[string]$evidence.listHtml) 'WARN';$zeroHtmlLogged=$true}
    }
    $htmlSnap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -ExpectedNames $expected -IncludeHtml
    $names=@($htmlSnap.items|ForEach-Object{$_.name})-join '|';$lives=@($htmlSnap.items|ForEach-Object{$_.live})-join '|'
    Write-KoseiLog ("添付完了待機タイムアウト usedItemSelector='"+[string]$htmlSnap.usedItemSelector+"' names=$names lives=$lives matched=$(@($lastMatches).Count) listHtml=" + [string]$htmlSnap.listHtml) 'ERROR'
    # ⚠️ **失敗の切り分けはここでしかできない。** 実測 2026-08-07: 添付が80秒まったく進まない
    #    （成功時は平均12秒・最大17秒なので、遅いのではなく**進んでいない**）事象が午後から
    #    増えた（15時4% → 17時22%）。だが、そもそもアップロード要求が飛んでいるのかどうかが
    #    ログから分からず、原因を絞り込めなかった。
    #      要求が無い       → 画面側（要求を出せていない／出す前に止まっている）
    #      要求はあるが未完 → 通信かサーバー側
    #    次に起きたときに分かるよう、要求の有無と窓の状態を必ず残す。
    $timeoutVisibility = ''
    $timeoutUploadCount = 0
    $timeoutChipCount = [int]$htmlSnap.count
    $baselineLiteral = 'Number.POSITIVE_INFINITY'
    if ($uploadBaselineAvailable) { $baselineLiteral = $uploadBaselineMs.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
    $uploadTokens = @($expected | ForEach-Object { [string]$_ })
    $uploadTokensJson = ConvertTo-KoseiJsonStringArray -Values $uploadTokens
    $baselineAvailableLiteral = if ($uploadBaselineAvailable) { 'true' } else { 'false' }
    $timeoutProbeSucceeded = $false
    try {
        $probe = @'
(() => {
  const baseline=__UPLOAD_BASELINE__,tokens=__UPLOAD_TOKENS__;
  const tokenHit=u=>tokens.some(t=>t&&String(u||'').toLowerCase().includes(String(t).toLowerCase()));
  const up = performance.getEntriesByType('resource')
    .filter(r => Number(r.startTime) >= baseline - 50)
    .filter(r => !r.initiatorType || /fetch|xhr|xmlhttprequest|beacon|other/i.test(String(r.initiatorType)))
    .filter(r => /upload|attachment|file|blob|drive|graph/i.test(r.name) || tokenHit(r.name))
    .slice(-6)
    .map(r => ({ n: String(r.name).slice(0, 110), ms: Math.round(r.duration), size: r.transferSize || 0 }));
  return JSON.stringify({
    vis: document.visibilityState,
    baselineAvailable: __BASELINE_AVAILABLE__,
    pageAgeSec: Math.round(performance.now() / 1000),
    chips: document.querySelectorAll('.fai-BebopAttachment').length,
    uploads: up,
  });
})()
'@
        $probe = $probe.Replace('__UPLOAD_BASELINE__', $baselineLiteral).Replace('__UPLOAD_TOKENS__', $uploadTokensJson).Replace('__BASELINE_AVAILABLE__', $baselineAvailableLiteral)
        $d = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $probe -TimeoutSeconds 15
        try {
            $probeState = [string]$d | ConvertFrom-Json
            $hasProbeFields = ($null -ne $probeState -and
                $null -ne $probeState.PSObject.Properties['vis'] -and
                $null -ne $probeState.PSObject.Properties['baselineAvailable'] -and
                $null -ne $probeState.PSObject.Properties['chips'] -and
                $null -ne $probeState.PSObject.Properties['uploads'])
            if ($hasProbeFields) {
                $timeoutVisibility = [string]$probeState.vis
                $timeoutUploadCount = @($probeState.uploads | Where-Object { $null -ne $_ }).Count
                $timeoutChipCount = [int]$probeState.chips
                if ($probeState.baselineAvailable -eq $false) { $uploadBaselineAvailable = $false }
                $timeoutProbeSucceeded = $true
            }
        } catch { Write-KoseiLog ("添付タイムアウトprobeのJSON解析に失敗: " + $_.Exception.Message) 'WARN' }
        Write-KoseiLog ("添付タイムアウトの内訳 " + [string]$d) 'ERROR'
    } catch { Write-KoseiLog ("添付タイムアウトの内訳を取れませんでした: " + $_.Exception.Message) 'WARN' }
    try { $null=Clear-KoseiResidualAttachments -WsUrl $WsUrl -Settings $Settings -ExpectedNames $expected -Reason 'packet-timeout' } catch { Write-KoseiLog ("タイムアウト後の残留添付削除に失敗: "+$_.Exception.Message) 'WARN' }
    # この窓は次に使うときページごと入れ直す。チャットを変えるだけでは同じJSが担当する。
    if ($null -eq $script:KoseiAttachStalledWs) { $script:KoseiAttachStalledWs = @{} }
    $script:KoseiAttachStalledWs[$WsUrl] = $true
    $noAttachProgress = ($uploadBaselineAvailable -and $timeoutProbeSucceeded -and @($lastMatches).Count -eq 0 -and $timeoutChipCount -le 0 -and $timeoutUploadCount -le 0)
    if (($initialVisibility -eq 'hidden' -or $timeoutVisibility -eq 'hidden') -and $noAttachProgress) {
        $message = "Copilot画面が非表示のまま添付の進展（チップ/アップロード）を確認できませんでした。画面を表示して同じパケットを再試行してください。"
        throw (New-KoseiFailureException -Message $message -Kind 'needs_user_visibility')
    }
    throw ("添付完了を {0} 秒以内に確認できませんでした。" -f $waitSec)
}

# ---------------------------------------------------------------------
# 依頼文入力（Input.insertText 単一経路）
# ---------------------------------------------------------------------
function Invoke-KoseiFocusChatInput {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  for (const d of docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (visible(el)) { el.focus(); return JSON.stringify({ ok: true, sel: s }); }
  }
  return JSON.stringify({ ok: false });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings))
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
    $r = $raw | ConvertFrom-Json
    if (-not $r.ok) { throw 'チャット入力欄へフォーカスできませんでした。' }
    return $r
}

function Get-KoseiChatInputTextLength {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  for (const d of docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (visible(el)) return JSON.stringify({ len: (el.innerText || el.value || '').length });
  }
  return JSON.stringify({ len: -1 });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings))
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
    return ([int](($raw | ConvertFrom-Json).len))
}

function Invoke-KoseiKeyEvent {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)][string]$Type,
        [Parameter(Mandatory=$true)][string]$Key,
        [Parameter(Mandatory=$true)][string]$Code,
        [Parameter(Mandatory=$true)][int]$KeyCode,
        [int]$Modifiers = 0
    )
    $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Input.dispatchKeyEvent' -Params @{
        type = $Type; key = $Key; code = $Code
        windowsVirtualKeyCode = $KeyCode; nativeVirtualKeyCode = $KeyCode
        modifiers = $Modifiers
    } -TimeoutSeconds 15
}

function Clear-KoseiChatInput {
    # Ctrl+A → Backspace で入力欄を空にする（クリップボード不使用）
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $len = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
    if ($len -le 0) { return }
    $null = Invoke-KoseiFocusChatInput -WsUrl $WsUrl -Settings $Settings
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'rawKeyDown' -Key 'a' -Code 'KeyA' -KeyCode 65 -Modifiers 2
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'keyUp' -Key 'a' -Code 'KeyA' -KeyCode 65 -Modifiers 2
    Start-Sleep -Milliseconds 120
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'rawKeyDown' -Key 'Backspace' -Code 'Backspace' -KeyCode 8
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'keyUp' -Key 'Backspace' -Code 'Backspace' -KeyCode 8
    Start-Sleep -Milliseconds 200
    Write-KoseiLog ("入力欄クリア beforeLen=" + $len + " afterLen=" + (Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings)) 'INFO'
}

function Invoke-KoseiInsertPrompt {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$Prompt
    )
    $maxChars = [int]$Settings.max_prompt_chars
    if ($Prompt.Length -gt $maxChars) {
        throw ("依頼文が上限 {0} 文字を超えています（{1} 文字）。パケットのページ数を減らしてください。" -f $maxChars, $Prompt.Length)
    }
    # 残留テキストがあれば消してから入力する
    Clear-KoseiChatInput -WsUrl $WsUrl -Settings $Settings
    $null = Invoke-KoseiFocusChatInput -WsUrl $WsUrl -Settings $Settings

    # クリップボードは使わない（Input.insertText 単一経路）。
    # 添付後の再レンダリング等でフォーカスが失われチャンクが落ちることがある
    # ため、チャンクごとに「入力欄の文字数が増えたか」を検証し、必要なら
    # 再フォーカスしてリトライする。
    $chunkSize = 3000
    for ($i = 0; $i -lt $Prompt.Length; $i += $chunkSize) {
        $len = [Math]::Min($chunkSize, $Prompt.Length - $i)
        $chunk = $Prompt.Substring($i, $len)
        $expectedGrowth = [int][Math]::Floor($chunk.Length * 0.9)
        $before = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
        if ($before -lt 0) { $before = 0 }
        $null = Invoke-KoseiFocusChatInput -WsUrl $WsUrl -Settings $Settings
        $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Input.insertText' -Params @{ text = $chunk } -TimeoutSeconds 30
        Start-Sleep -Milliseconds 300
        $after = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
        if (($after - $before) -lt $expectedGrowth) {
            throw ("依頼文の入力をチャンク位置 {0} で確認できませんでした（before {1} / after {2}）。重複防止のため同じチャンクは再挿入しません。" -f $i, $before, $after)
        }
    }
    Start-Sleep -Milliseconds 300
    $inputLen = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
    if ($inputLen -lt [int]($Prompt.Length * 0.9) -or $inputLen -gt [int]($Prompt.Length * 1.1)) {
        throw ("依頼文の入力長が許容範囲外です（期待 {0} 文字 / 実際 {1} 文字）。重複または欠落の可能性があります。" -f $Prompt.Length, $inputLen)
    }
    Write-KoseiLog ("依頼文入力完了 chars=" + $Prompt.Length + " editorLen=" + $inputLen) 'INFO'
}

# ---------------------------------------------------------------------
# 送信（有効な送信ボタンのみクリック）
# ---------------------------------------------------------------------
function Invoke-KoseiClickSend {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button, [role="button"]')));
  const candidates = [];
  const clickable = [];
  const exclude = /stop|cancel|停止|キャンセル|regenerate|再生成|attach|添付|microphone|voice|ボイス|音声|マイク|new chat|新しいチャット|clear|クリア|close|閉じる|search|検索|library|ライブラリ|file|ファイル|mail|メール|contact|連絡先|meeting|会議|delete|削除/;
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    let score = 0;
    if (/^(送信|send)$/i.test(label)) score += 1000;
    else if (/送信|send/i.test(lower)) score += 400;
    if (score <= 0) continue;
    const reasons = [];
    if (exclude.test(lower)) reasons.push('non-send-control');
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') reasons.push('disabled');
    if (!visible(b)) reasons.push('hidden');
    candidates.push({ label: label.slice(0, 80), score: score, reasons: reasons });
    if (reasons.length === 0) clickable.push({ el: b, label: label.slice(0, 80), score: score });
  }
  clickable.sort((a, c) => c.score - a.score);
  if (clickable.length > 0) {
    clickable[0].el.click();
    return JSON.stringify({ clicked: true, label: clickable[0].label, candidates: candidates.slice(0, 6) });
  }
  return JSON.stringify({ clicked: false, candidates: candidates.slice(0, 6) });
})()
'@
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $r = $raw | ConvertFrom-Json
    Write-KoseiLog ("送信クリック clicked=" + $r.clicked + " detail=" + ($raw.ToString().Substring(0, [Math]::Min(300, $raw.ToString().Length)))) 'INFO'
    if (-not $r.clicked) { throw ('有効な送信ボタンが見つかりませんでした。candidates=' + ($r.candidates | ConvertTo-Json -Compress)) }
    return $r
}

function Invoke-KoseiClickStop {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button, [role="button"]')));
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    if (!/停止|stop/i.test(label)) continue;
    if (b.disabled || !visible(b)) continue;
    b.click();
    return JSON.stringify({ clicked: true, label: label.slice(0, 80) });
  }
  return JSON.stringify({ clicked: false });
})()
'@
    try {
        $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

# ---------------------------------------------------------------------
# 回答JSON抽出（波括弧スキャン。文字列・エスケープを考慮）
# ---------------------------------------------------------------------
function Get-KoseiJsonObjectCandidates {
    param([AllowNull()][string]$Text)
    $out = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrEmpty($Text)) { return $out.ToArray() }
    $len = $Text.Length
    $i = 0
    while ($i -lt $len) {
        if ($Text[$i] -ne '{') { $i++; continue }
        $depth = 0
        $inStr = $false
        $esc = $false
        $start = $i
        $j = $i
        while ($j -lt $len) {
            $c = $Text[$j]
            if ($inStr) {
                if ($esc) { $esc = $false }
                elseif ($c -eq '\') { $esc = $true }
                elseif ($c -eq '"') { $inStr = $false }
            } else {
                if ($c -eq '"') { $inStr = $true }
                elseif ($c -eq '{') { $depth++ }
                elseif ($c -eq '}') {
                    $depth--
                    if ($depth -eq 0) {
                        $out.Add($Text.Substring($start, $j - $start + 1))
                        break
                    }
                }
            }
            $j++
        }
        if ($depth -eq 0 -and $j -lt $len) { $i = $j + 1 } else { $i = $start + 1 }
    }
    return $out.ToArray()
}

# DOM側で長い応答が後端ごと切り詰められた場合の保険。文字列・括弧の走査状態から
# 安全な切断点を求め、未閉鎖の文字列・配列・オブジェクトを閉じまで補う。
# 切り詰められていない（括弧が釣り合う）入力は変更せず $null を返す。
function Repair-KoseiTruncatedJsonTail {
    param([AllowNull()][string]$Text)
    $s = [string]$Text
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }
    $inString = $false; $escape = $false
    $stack = New-Object System.Collections.Generic.List[char]
    $lastSafe = -1
    $len = $s.Length
    for ($i = 0; $i -lt $len; $i++) {
        $c = $s[$i]
        if ($inString) {
            if ($escape) { $escape = $false }
            elseif ($c -eq '\') { $escape = $true }
            elseif ($c -eq '"') { $inString = $false; $lastSafe = $i }
        } else {
            if ($c -eq '"') { $inString = $true }
            elseif ($c -eq '{' -or $c -eq '[') { $stack.Add($c) }
            elseif ($c -eq '}' -or $c -eq ']') { if ($stack.Count -gt 0) { $stack.RemoveAt($stack.Count - 1) }; $lastSafe = $i }
            elseif ($c -eq ',') { $lastSafe = $i }
        }
    }
    if (-not $inString -and $stack.Count -eq 0) { return $null }
    if ($inString) {
        # 値やキーの文字列の途中で切れた場合は、その文字列を閉じてから残りを閉じる。
        # 文字列中に生の改行が含まれる場合はパースに失敗するが、従来の全滅より良い。
        $body = if ($escape) { $s.Substring(0, $len - 1) } else { $s }
        $cut = $body + '"'
    } else {
        if ($lastSafe -lt 0) { return $null }
        $cut = $s.Substring(0, $lastSafe + 1)
    }
    for ($k = $stack.Count - 1; $k -ge 0; $k--) {
        $cut += $(if ($stack[$k] -eq '{') { '}' } else { ']' })
    }
    return [pscustomobject]@{ text = $cut }
}

function Repair-KoseiJsonText {
    param([AllowNull()][string]$Text)
    $source = [string]$Text
    $fixed = $source
    $fixes = New-Object System.Collections.Generic.List[string]
    $closure = Repair-KoseiTruncatedJsonTail -Text $fixed
    if ($null -ne $closure) { $fixed = [string]$closure.text; $fixes.Add('truncated-tail-closure') }
    # LLMが日本語括弧で始まる文字列値の開始ダブルクォートだけを落とす既知パターンに限定する。
    $keys = 'issue_summary|reason|note|suggestion|quote|reference_quote|no_findings_reason'
    $missingQuotePattern = '((?:"(?:' + $keys + ')"\s*:\s*))([「｢『【])'
    $next = [regex]::Replace($fixed, $missingQuotePattern, '$1"$2')
    if ($next -ne $fixed) { $fixed=$next; $fixes.Add('missing-open-quote') }
    $next = [regex]::Replace($fixed, ',\s*([}\]])', '$1')
    if ($next -ne $fixed) { $fixed=$next; $fixes.Add('trailing-comma') }
    # JSONに無いエスケープを落とす。**\* は JSON では不正**である
    # （許されるのは \" \\ \/ \b \f \n \r \t \uXXXX だけ）。
    #
    # ⚠️ これは**こちらが撒いた種**である。依頼文に「* や _ の直前に \ を付けて」と書いた。
    #    Markdown が星印を食う（*2 が消える）のを避けるためだったが、載せ物は JSON なので、
    #    モデルが素直に従うと \*3 と書かれ、**応答まるごとパースできなくなる**。
    #    実測 2026-08-08: SEC_001_STRUCTURE_R2 の1応答に14箇所。脚注記号を扱う
    #    STRUCTURE 観点だけが落ち続けていたのは、これが理由だった。
    #    しかも Markdown はエスケープを解いていなかった（\*3 のまま届いていた）ので、
    #    \ を落とせば *3 に戻る。**記号は失われない。**
    #
    # ⚠️ `\\*`（エスケープ済みの円記号＋星）を壊さないこと。左から2文字ずつ食う書き方にする。
    #    1文字ずつ見る書き方だと、`\\*` の後ろ半分が `\*` に見えて潰れる。
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
        param($m)
        if ($m.Groups[1].Value -match '["\\/bfnrtu]') { $m.Value } else { $m.Groups[1].Value }
    }
    $next = [regex]::Replace($fixed, '\\(.)', $evaluator)
    if ($next -ne $fixed) { $fixed=$next; $fixes.Add('invalid-escape') }
    return [pscustomobject]@{ text=$fixed; changed=($fixed -ne $source); fixes=@($fixes) }
}

function Get-KoseiReviewCandidateScore {
    param([Parameter(Mandatory=$true)][string]$Candidate)
    $score=0
    if($Candidate -match '"findings"'){ $score+=20 }
    if($Candidate -match '"packet_id"'){ $score+=8 }
    if($Candidate -match '"(?:pages_checked|checked_pages|checked_page_summaries)"'){ $score+=8 }
    if($Candidate -match '"read_error"'){ $score+=4 }
    return $score
}

function Test-KoseiReviewAnswerSchema {
    param(
        [Parameter(Mandatory=$true)]$Object,
        [string]$ExpectedPacketId = '',
        [int[]]$ExpectedPages = @(),
        $Reason = $null
    )
    $fail = {
        param([string]$Message)
        if ($Reason) { $Reason.Value = $Message }
        return $false
    }
    if ($null -eq $Object -or $null -eq $Object.PSObject) { return & $fail 'top-level objectではありません' }
    $names = @($Object.PSObject.Properties.Name)
    if ($names -notcontains 'findings') { return & $fail 'findingsがありません' }
    if ($Object.findings -isnot [System.Array]) { return & $fail 'findingsが配列ではありません' }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedPacketId)) {
        if ($names -notcontains 'packet_id' -or [string]$Object.packet_id -cne $ExpectedPacketId) {
            return & $fail ("packet_idが一致しません expected={0} actual={1}" -f $ExpectedPacketId, [string]$Object.packet_id)
        }
    } elseif ($names -contains 'packet_id' -and $Object.packet_id -isnot [string]) {
        return & $fail 'packet_idが文字列ではありません'
    }
    if ($names -contains 'read_error' -and $Object.read_error -isnot [string]) { return & $fail 'read_errorが文字列ではありません' }

    $expected = @($ExpectedPages | Sort-Object -Unique)
    $checkedFields = @('pages_checked','checked_pages','checked_page_summaries')
    foreach ($field in $checkedFields) {
        if ($names -notcontains $field) { continue }
        $raw = $Object.$field
        if ($raw -isnot [System.Array]) { return & $fail ("{0}が配列ではありません" -f $field) }
        $values = if ($field -eq 'checked_page_summaries') { @($raw | ForEach-Object { $_.page }) } else { @($raw) }
        foreach ($value in $values) {
            $page = 0
            if (-not [int]::TryParse([string]$value, [ref]$page) -or [string]$value -notmatch '^\d+$' -or $page -lt 1) {
                return & $fail ("{0}に不正なpageがあります" -f $field)
            }
            if ($expected.Count -and $expected -notcontains $page) { return & $fail ("{0}に対象外page {1}があります" -f $field, $page) }
        }
    }
    foreach ($finding in @($Object.findings)) {
        if ($null -eq $finding -or $null -eq $finding.PSObject -or $finding -is [string]) { return & $fail 'findingがobjectではありません' }
        $findingNames = @($finding.PSObject.Properties.Name)
        if ($findingNames -notcontains 'page') {
            if ($expected.Count) { return & $fail 'finding.pageがありません' }
            continue
        }
        $page = 0
        if (-not [int]::TryParse([string]$finding.page, [ref]$page) -or [string]$finding.page -notmatch '^\d+$' -or $page -lt 1) {
            return & $fail 'finding.pageが正の整数ではありません'
        }
        if ($expected.Count -and $expected -notcontains $page) { return & $fail ("finding.page {0}が対象外です" -f $page) }
    }
    if ($Reason) { $Reason.Value = '' }
    return $true
}

function Get-KoseiReviewAnswerJson {
    # テキストから校正回答らしい最後の有効JSON（findings または read_error を持つ）を抽出
    param([AllowNull()][string]$Text, $Metadata=$null, [string]$ExpectedPacketId='', [int[]]$ExpectedPages=@())
    if($Metadata){$Metadata.Value=[pscustomobject]@{repaired=$false;fixes=@();rawText=[string]$Text;parseErrors=@();candidateHeads=@()}}
    $clean = [string]$Text
    $clean = $clean -replace '```json', '' -replace '```', ''
    $parseErrors=New-Object System.Collections.Generic.List[string]
    # 外側応答を直接パースして、破損時の位置・メッセージを診断用に保持する。
    $probe=$clean
    $markerProbe=$probe.LastIndexOf('KOSEI_END')
    if($markerProbe -ge 0){$probe=$probe.Substring(0,$markerProbe)}
    $probe=$probe.Trim()
    if($probe.StartsWith('{')){try{$null=$probe|ConvertFrom-Json}catch{$parseErrors.Add($_.Exception.Message)}}
    $tryTexts=New-Object System.Collections.Generic.List[object]
    $tryTexts.Add([pscustomobject]@{text=$clean;repaired=$false;fixes=@()})
    $repair=Repair-KoseiJsonText -Text $clean
    if($repair.changed){$tryTexts.Add([pscustomobject]@{text=$repair.text;repaired=$true;fixes=$repair.fixes})}
    $wideBase=if($repair.changed){[string]$repair.text}else{$clean}
    $wide=$wideBase -replace '[“”＂]','"'
    if($wide -ne $wideBase){$tryTexts.Add([pscustomobject]@{text=$wide;repaired=$true;fixes=@(@($repair.fixes)+'fullwidth-quote')})}
    $validCandidates = New-Object System.Collections.Generic.List[object]
    foreach($tryText in $tryTexts){
      $candidateIndex = 0
      $ranked=@(Get-KoseiJsonObjectCandidates -Text ([string]$tryText.text) | ForEach-Object {
        $candidateText = [string]$_
        $item = [pscustomobject]@{text=$candidateText;score=(Get-KoseiReviewCandidateScore -Candidate $candidateText);position=([string]$tryText.text).LastIndexOf($candidateText);order=$candidateIndex}
        $candidateIndex++
        $item
      })
      foreach($candidateInfo in $ranked){
        $c=[string]$candidateInfo.text
        if ($c -notmatch '"findings"' -and $c -notmatch '"read_error"') { continue }
        try {
          $obj=$c|ConvertFrom-Json
           $schemaReason=''
           if(Test-KoseiReviewAnswerSchema -Object $obj -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages -Reason ([ref]$schemaReason)){
             $validCandidates.Add([pscustomobject]@{text=$c;position=[int]$candidateInfo.position;order=[int]$candidateInfo.order;repaired=[bool]$tryText.repaired;fixes=@($tryText.fixes)})
           } elseif($schemaReason) { $parseErrors.Add('schema: ' + $schemaReason) }
        }catch{$parseErrors.Add($_.Exception.Message)}
      }
    }
    if($validCandidates.Count -gt 0){
      # 草稿の撤回・訂正を尊重し、schema-validな候補のうち元回答で最後に現れるものを採用する。
      # 同じ位置に未修復版と修復版がある場合だけ、未修復版を優先する。
      $ordered=@($validCandidates | Sort-Object -Property @{Expression={$_.repaired};Descending=$false},@{Expression={$_.position};Descending=$true},@{Expression={$_.order};Descending=$true})
      $selected=$ordered[0]
      if($Metadata){$Metadata.Value=[pscustomobject]@{repaired=[bool]$selected.repaired;fixes=@($selected.fixes);rawText=$clean;parseErrors=@($parseErrors);candidateHeads=@($ordered|Select-Object -First 3|ForEach-Object{$h=$_.text -replace '[\r\n]+',' ';if($h.Length -gt 40){$h=$h.Substring(0,40)};$h})}}
      return [string]$selected.text
    }
    # 外側の開き波括弧がDOM切り出しで欠けた場合の保険。最後の主要キーを起点に外側オブジェクトを復元する。
    foreach ($key in @('"findings"', '"read_error"')) {
        $keyPos = $clean.LastIndexOf($key)
        if ($keyPos -lt 0) { continue }
        $searchStart = [Math]::Max(0, $keyPos - 500)
        $openPos = $clean.LastIndexOf('{', $keyPos, $keyPos - $searchStart + 1)
        $keyTexts = New-Object System.Collections.Generic.List[string]
        if ($openPos -ge $searchStart) { $keyTexts.Add($clean.Substring($openPos)) }
        $keyTexts.Add('{' + $clean.Substring($keyPos))
        foreach ($keyText in $keyTexts) {
            foreach ($candidate in @(Get-KoseiJsonObjectCandidates -Text $keyText)) {
                try {
                    $obj = $candidate | ConvertFrom-Json
                    if (Test-KoseiReviewAnswerSchema -Object $obj -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages) { return $candidate }
                } catch {}
            }
        }
    }
    if($Metadata){$Metadata.Value=[pscustomobject]@{repaired=$false;fixes=@();rawText=$clean;parseErrors=@($parseErrors);candidateHeads=@()}}
    return $null
}

function Get-KoseiReviewJsonDiagnostics {
    param([AllowNull()][string]$Text)
    $clean = ([string]$Text) -replace '```json', '' -replace '```', ''
    $candidates = @(Get-KoseiJsonObjectCandidates -Text $clean)
    $reasons = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $candidates.Count; $i++) {
        $candidate = [string]$candidates[$i]
        $preview = ($candidate -replace '[\r\n]+', ' ')
        if ($preview.Length -gt 40) { $preview = $preview.Substring(0, 40) }
        if ($candidate -notmatch '"findings"' -and $candidate -notmatch '"read_error"') {
            $reasons.Add("candidate[$i]: findings/read_error キー無し head=$preview")
            continue
        }
        try {
            $obj = $candidate | ConvertFrom-Json
            if (-not $obj -or (($obj.PSObject.Properties.Name -notcontains 'findings') -and ($obj.PSObject.Properties.Name -notcontains 'read_error'))) {
                $reasons.Add("candidate[$i]: パース後に findings/read_error キー無し head=$preview")
            }
        } catch {
            $reasons.Add("candidate[$i]: パース例外 head=$preview " + $_.Exception.Message)
        }
    }
    return [pscustomobject]@{ count = $candidates.Count; reasons = @($reasons) }
}

function Get-KoseiLatestResponseText {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const selectors = [
    '[data-testid="markdown-reply"]',
    '[data-content="ai-message"]',
    '[class*="ai-message" i]',
    '[role="article"][data-author="assistant"], [role="article"][aria-label*="Copilot" i]',
    '[data-message-author-role="assistant"]'
  ];
  // ⚠️ 回答は Markdown をレンダリングした後の DOM である。地の文で返された JSON は
  //    Markdown として解釈され、*1 … *1 のように対になった星印が強調記号として
  //    **消えてしまう**（引き継ぎ書 §8）。引用が本文と食い違うのでハイライトが当たらない。
  //
  //    ⚠️ **コードフェンスで囲ませる案は駄目だった（実測 2026-08-07）。**
  //       Copilot はコードブロックに**行番号を差し込み、長いものを折りたたむ**。
  //         JSON
  //         1
  //         { "packet_id": "SEC_001",
  //         2
  //           "checked_pages": [ …
  //         …
  //         その他の行を表示する          ← ここから先はDOMに無い
  //       行番号が本文に混ざるので JSON として読めず、3パケットが no-json-idle で落ちた。
  //       全文が DOM に無いので、行番号を剥がしても直らない。
  //
  //    → 依頼文の側で `\*2` のように**エスケープさせる**。Markdown はエスケープを
  //      解いて `*2` を出すので、ここで読むテキストがそのまま正しくなる。
  //      読み取り側は素直に innerText のままでよい。
  //
  // innerText はレイアウト結果を読むので、タブが非アクティブ（アプリ画面など別タブが
  // 手前にある）ときや最小化中は空になることがある。実測で回答が画面に見えているのに
  // 1文字も取れず、$responseSeen が立たないまま待ち続けた。textContent へ落とす。
  // ⚠️ **「最後の要素」を採ってはいけない。空の返信要素が後ろに付く。**
  //    実測 2026-08-08: markdown-reply が2個あり
  //      [0] len=5100  {"packet_id":"SEC_001_STRUCTURE_R2b", … } KOSEI_END
  //      [1] len=0
  //    最後を採ると空が返り、回答は完成しているのに main 領域へ落ちる。
  //    そこから JSON は取れないので、180秒待って「生成停滞」として捨てていた。
  //    **後ろから見て、中身のある最初の要素**を採ること。
  const pickLatest = (nodes) => {
    for (let k = nodes.length - 1; k >= 0; k--) {
      const rendered = (nodes[k].innerText || '').trim();
      const text = rendered || (nodes[k].textContent || '').trim();
      if (text) return { text, fallback: rendered ? '' : 'textContent', skipped: nodes.length - 1 - k };
    }
    return null;
  };
  for (let i = 0; i < selectors.length; i++) {
    const nodes = document.querySelectorAll(selectors[i]);
    if (!nodes.length) continue;
    const got = pickLatest(nodes);
    if (got) return JSON.stringify({ text: got.text, selectorIndex: i + 1, fallback: got.fallback, skippedEmpty: got.skipped });
  }
  return JSON.stringify({ text: '', selectorIndex: 0, fallback: '' });
})()
'@
    $t = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    if ($null -eq $t) { return [pscustomobject]@{ text=''; selectorIndex=0 } }
    try { return ($t | ConvertFrom-Json) } catch { return [pscustomobject]@{ text=[string]$t; selectorIndex=0 } }
}

function Get-KoseiAssistantTailHash {
    # latest_text を正規化し、末尾256文字の SHA-256 を小文字hexで返す（§7.3 / 計画書 G）。
    # CDP注入JSではなくPS側で計算する（Web Crypto の非同期を避け、決定性を単体テスト可能にする）。
    param([string]$Text)
    $s = [string]$Text
    if ([string]::IsNullOrEmpty($s)) { return '' }
    $s = $s -replace "`r`n", "`n" -replace "`r", "`n"
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $s.ToCharArray()) {
        $c = [int]$ch
        if (($c -lt 32 -and $c -ne 9 -and $c -ne 10) -or $c -eq 127) { continue }
        [void]$sb.Append($ch)
    }
    $clean = $sb.ToString()
    if ($clean.Length -gt 256) { $clean = $clean.Substring($clean.Length - 256) }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($clean)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $out = New-Object System.Text.StringBuilder
    foreach ($b in $hash) { [void]$out.Append($b.ToString('x2')) }
    return $out.ToString()
}

function Get-KoseiAssistantSnapshot {
    # §1.2 の全selectorについて {selector_index, element_count, latest_text, tail_hash, assistant_dom_key}
    # を返す（§7.3）。単一selectorだけを返す Get-KoseiLatestResponseText と異なり、空のstreaming要素や
    # selector重複を観測できる。tail_hash は PS 側で導出する。
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const selectors = [
    '[data-testid="markdown-reply"]',
    '[data-content="ai-message"]',
    '[class*="ai-message" i]',
    '[role="article"][data-author="assistant"], [role="article"][aria-label*="Copilot" i]',
    '[data-message-author-role="assistant"]'
  ];
  const matches = [];
  let anyElement = false, anyText = false;
  for (let i = 0; i < selectors.length; i++) {
    const nodes = document.querySelectorAll(selectors[i]);
    const count = nodes.length;
    let latest = '', domKey = '';
    if (count > 0) {
      anyElement = true;
      // ⚠️ **「最後の要素」を採ってはいけない。空の返信要素が後ろに付く。**
      //    Get-KoseiLatestResponseText と同じ理由（同関数の注記を参照）。
      //    ここが空を返すと responseLen=0 になり、回答が完成していても
      //    「生成停滞」として180秒待ってから捨てることになる。
      let last = nodes[count - 1];
      for (let k = count - 1; k >= 0; k--) {
        const t = ((nodes[k].innerText || '').trim()) || ((nodes[k].textContent || '').trim());
        if (t) { last = nodes[k]; latest = t; break; }
      }
      // ⚠️ ここでコードブロックを優先してはいけない。Copilot は行番号を差し込んで
      //    折りたたむので、Get-KoseiLatestResponseText が読む本文とずれる。
      //    星印は依頼文の側でエスケープさせて守る（同関数の注記を参照）。
      if (latest) anyText = true;
      domKey = last.getAttribute('data-message-id') || last.getAttribute('id') || last.getAttribute('data-testid') || '';
    }
    matches.push({ selector_index: i + 1, element_count: count, latest_text: latest, assistant_dom_key: domKey });
  }
  const state = anyText ? 'ready' : (anyElement ? 'pending' : 'empty');
  return JSON.stringify({ state, matches });
})()
'@
    try {
        $t = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
        if ($null -eq $t) { return [pscustomobject]@{ state='cdp-error'; matches=@() } }
        $obj = $t | ConvertFrom-Json
        $mm = @()
        foreach ($m in @($obj.matches)) {
            $mm += [pscustomobject]@{
                selector_index    = [int]$m.selector_index
                element_count     = [int]$m.element_count
                latest_text       = [string]$m.latest_text
                tail_hash         = Get-KoseiAssistantTailHash -Text ([string]$m.latest_text)
                assistant_dom_key = [string]$m.assistant_dom_key
            }
        }
        return [pscustomobject]@{ state=[string]$obj.state; matches=$mm }
    } catch {
        Write-KoseiLog ("assistant snapshot取得に失敗（cdp-error）: " + $_.Exception.Message) 'WARN'
        return [pscustomobject]@{ state='cdp-error'; matches=@() }
    }
}

function Get-KoseiMainResponseRegion {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $text = Get-KoseiMainText -WsUrl $WsUrl
    # 最後のユーザー依頼の末尾固定句以降に限定し、プロンプトecho内のKOSEI_ENDを除外する。
    $anchor = 'その後には何も出力しないでください。'
    $anchorPos = $text.LastIndexOf($anchor)
    if ($anchorPos -ge 0) { return $text.Substring($anchorPos + $anchor.Length).TrimStart() }
    return ''
}

function Test-KoseiCopilotGenerating {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const stop = buttons.some(el => /^(stop|停止|応答を停止|生成を停止)$/i.test((el.innerText || el.getAttribute('aria-label') || el.title || '').trim()));
  const streaming = [...document.querySelectorAll('[aria-busy="true"],[data-state="streaming"],[data-status="streaming"],[class*="streaming" i]')].some(visible);
  return JSON.stringify({ generating: stop || streaming, stop, streaming });
})()
'@
    try {
        $result = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
        if ($null -eq $result) { return $true }
        return [bool](($result | ConvertFrom-Json).generating)
    } catch {
        Write-KoseiLog ("生成状態の取得に失敗。安全側で生成中として扱います: " + $_.Exception.Message) 'WARN'
        return $true
    }
}

function Get-KoseiReviewCompleteness {
    param([Parameter(Mandatory=$true)][string]$Json, [int[]]$ExpectedPages = @(), [string]$ExpectedPacketId='', [switch]$Repaired)
    $findingsCount = 0; $checked = @(); $hasRequired = $false; $readError = $false; $checkedAll = $false
    try {
        $obj = $Json | ConvertFrom-Json
        $schemaReason = ''
        if (-not (Test-KoseiReviewAnswerSchema -Object $obj -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages -Reason ([ref]$schemaReason))) {
            return [pscustomobject]@{
                complete=$false; legacy_complete=$false; transport_complete=$false; page_complete=$false
                semantic_coverage='unknown'; verification_state='invalid'; repaired=[bool]$Repaired
                findingsCount=0; pagesChecked=@(); coverage=0; warning=('回答schemaが不正です: '+$schemaReason)
            }
        }
        $names = @($obj.PSObject.Properties.Name)
        $hasRequired = ($names -contains 'findings') -or ($names -contains 'read_error')
        $readError = ($names -contains 'read_error') -and -not [string]::IsNullOrWhiteSpace([string]$obj.read_error)
        if ($names -contains 'findings') { $findingsCount = @($obj.findings).Count }
        # 回答形式の揺れを吸収する優先順位。最初に存在して値を持つ形式を採用する。
        $rawChecked = @()
        foreach($field in $script:KoseiPageCheckFieldPriority){
            if($names -notcontains $field){continue}
            $values=$(if($field -eq 'checked_page_summaries'){@($obj.$field | ForEach-Object{$_.page})}else{@($obj.$field)})
            if(@($values).Count){$rawChecked=@($values);break}
        }
        $checked = @($rawChecked | ForEach-Object { try { [int]$_ } catch {} } | Sort-Object -Unique)
        # 全ページ確認の明示フラグは、read_errorがない場合だけ展開する。
        $checkedAll = ($names -contains 'checked_pages_all') -and ($obj.checked_pages_all -eq $true) -and -not $readError
    } catch {}
    $expected = @($ExpectedPages | Sort-Object -Unique)
    if ($checkedAll) { $checked = $expected }
    $covered = if ($expected.Count) { @($expected | Where-Object { $checked -contains $_ }).Count } else { $checked.Count }
    $coverage = if ($expected.Count) { $covered / [double]$expected.Count } else { 1.0 }
    # transport_complete はschemaを満たす回答を受信したこと、page_completeは
    # read_errorなしで対象ページを100%確認したことを表す。legacy_completeは
    # 回復データの読み取り互換用に残し、通常の完了表示では使わない。
    $transportComplete = $hasRequired
    $pageComplete = $hasRequired -and (-not $readError) -and ($coverage -ge 1.0)
    $verificationState = if (-not $hasRequired) { 'invalid' }
        elseif ($readError) { 'needs_review' }
        elseif ($coverage -lt 1.0) { 'incomplete' }
        else { 'page_complete' }
    $warning = ''
    if (-not $hasRequired) { $warning = 'findings または read_error がありません。' }
    elseif ($readError) { $warning = 'Copilotが確認できない範囲を read_error として返しました。要確認です。' }
    elseif ($coverage -lt 1.0) { $warning = ('確認済みページが対象の {0:P0} です（必要: 100%）。' -f $coverage) }
    if ($Repaired -and $transportComplete) {
        if ($verificationState -eq 'page_complete') { $verificationState = 'needs_review' }
        $repairWarning = '回答JSONを自動修復して取り込みました。原文と監査ログを確認してください。'
        $warning = if ([string]::IsNullOrWhiteSpace($warning)) { $repairWarning } else { $warning + ' ' + $repairWarning }
    }
    return [pscustomobject]@{
        complete=$pageComplete; legacy_complete=($hasRequired -and ($readError -or $coverage -ge 0.70))
        transport_complete=$transportComplete; page_complete=$pageComplete; semantic_coverage='unknown'
        verification_state=$verificationState; repaired=[bool]$Repaired
        findingsCount=$findingsCount; pagesChecked=@($checked); coverage=$coverage; warning=$warning
    }
}
# ⚠️ 「問題が発生しました」を落としてはいけない。Copilot が処理そのものに失敗したときの
#    文言で、拒否とは別物だが**こちらから見れば同じく回答が得られない**。
#    実測 2026-08-08: 実物173ページ（テキスト571KB/パケット）を投げると画面に
#      「申し訳ございません。問題が発生しました。もう一度お試しいただけますか?」
#    が出るのに、この関数が拾わないため**ログに何も残らなかった**。
#    その結果 Show-CopilotHealth は「ふつう」と出し、利用者が画面で見ている不調を
#    こちらの道具が一切捉えられていなかった。
function Test-KoseiCopilotRefusalText {
    param([AllowNull()][string]$Text)
    $value = ([string]$Text).Trim()
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    if ($value -match '"(?:findings|read_error)"\s*:' -or $value.Length -gt 1200) { return $false }
    return ($value -match '^(?:申し訳ございません[\s\S]{0,500}(?:応答|回答)できません|それに応答できません|(?:sorry|unable|can(?:not|''t))\s+(?:to\s+)?(?:respond|complete|help)[\s\S]{0,500})$' `
        -or $value -match '^(?:申し訳ございません[。\s]*)?(?:問題が発生しました|エラーが発生しました|something\s+went\s+wrong)[\s\S]{0,500}$')
}

# ---------------------------------------------------------------------
# 応答待機
# ---------------------------------------------------------------------
function Test-KoseiTurnMarkerBoundary {
    # marker が「末尾トークン」として現れるかを判定する（§7.3 / fix F）。
    # 実 Copilot は marker を JSON と同じ行の末尾（スペース区切り）に付けることがあるため、
    # 「独立した最終行」ではなく「末尾の空白を除いた文字列が marker で終わり、直前が
    # 行頭/空白/'}' である」で検知する。JSON文字列値内部の部分一致（末尾が '"}' 等）は弾く。
    # js/turn-complete.mjs の detection と同じ規則（Test-TurnComplete.mjs / Test-ReviewPrimitives.ps1 で検証）。
    param([string]$Text, [string]$Marker)
    if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrEmpty($Marker)) { return $false }
    $trimmed = ([string]$Text) -replace '[\s　]+$', ''
    if (-not $trimmed.EndsWith([string]$Marker)) { return $false }
    $beforeIdx = $trimmed.Length - ([string]$Marker).Length
    if ($beforeIdx -eq 0) { return $true }
    $prev = $trimmed[$beforeIdx - 1]
    return ([char]::IsWhiteSpace($prev) -or ([string]$prev -eq '}'))
}

function Wait-KoseiCopilotReviewResponse {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][int]$BaselineLength,
        [string]$Marker = '',
        [int]$TimeoutSeconds = 600,
        [scriptblock]$ShouldCancel = $null,
        [scriptblock]$OnProgress = $null,
        [int[]]$ExpectedPages = @(),
        [string]$ExpectedPacketId = '',
        # 復旧時にどのターゲットを引き直すか。空なら従来どおり「条件に合う最初のページ」。
        # 並列時は必ず渡すこと（他ワーカーの窓を掴まないため）。
        [string]$TargetId = ''
    )
    # turnごとの一意マーカーが渡された場合はそれを使い、前ターンのマーカーに誤ヒットしない（§7.3）。
    $marker = if ([string]::IsNullOrWhiteSpace($Marker)) { [string]$Settings.response_end_marker } else { [string]$Marker }
    $deadline = (Get-Date).AddSeconds([Math]::Max(30, $TimeoutSeconds))
    # 本文がまったく伸びない状態がこの秒数続いたら停滞とみなす（generating の申告に関わらず）。
    $stallSec = [int]$Settings.response_stall_seconds
    if ($stallSec -lt 30) { $stallSec = 180 }
    # 完成した回答JSONが一定時間まったく変化しなければ、UIが生成中を名乗っていても受理する。
    # 「詳細を収集しています…」の状態では停止ボタンが出たままで generating=false にならず、
    # json-stable の条件（生成停止を2回連続で確認）が永久に満たされないため。
    $stableAcceptSec = [int]$Settings.response_stable_accept_seconds
    if ($stableAcceptSec -lt 10) { $stableAcceptSec = 45 }
    $lastLen = -1
    $stableSince = Get-Date
    # 回答本体だけの停滞クロック（画面の付随表示に影響されない）
    $lastObservedResponse = $null
    $responseStableSince = Get-Date
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastProgressSec = -10
    $fetchErrors = 0
    $fallbackLookbackChars = 30000
    $lastResponseSnapshot = ''
    $lastResponseSource = ''
    $snapshotMissingWarned = $false
    $notGeneratingPolls = 0
    $lastIncompleteAnswer = $null
    $lastIncompleteInfo = $null
    $lastIncompleteRaw = ''
    $lastIncompleteMeta = $null
    $lastIncompleteLogAt = (Get-Date).AddSeconds(-20)
    $lastIncompleteLogLength = -1
    $responseSeen=$false
    $lastObservedText=''
    $longestResponseSnapshot=''
    $baselineAssistantText = ''
    try { $baselineAssistantText = [string](Get-KoseiLatestResponseText -WsUrl $WsUrl).text } catch {}
    Write-KoseiLog "回答待機開始 baselineLen=$BaselineLength baselineAssistantLen=$($baselineAssistantText.Length) timeoutSec=$TimeoutSeconds marker=$marker" 'INFO'
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) {
            $null=Invoke-KoseiClickStop -WsUrl $WsUrl
            Write-KoseiLog "回答待機を中止 elapsedMs=$($sw.ElapsedMilliseconds)" 'INFO'
            return [pscustomobject]@{ok=$false;completedBy='cancelled';json=$null;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=''}
        }
        Start-Sleep -Milliseconds 1000
        $text = ''
        $latestResponse = ''
        try {
            $latest = Get-KoseiLatestResponseText -WsUrl $WsUrl
            $latestResponse = [string]$latest.text
            if (-not [string]::IsNullOrWhiteSpace($baselineAssistantText) -and [string]::Equals($latestResponse, $baselineAssistantText, [StringComparison]::Ordinal)) { $latestResponse = '' }
            if (-not [string]::IsNullOrWhiteSpace($latestResponse)) {
                $responseSeen=$true
                $lastResponseSnapshot = $latestResponse
                if($latestResponse.Length -gt $longestResponseSnapshot.Length){$longestResponseSnapshot=$latestResponse}
                $lastResponseSource = 'latest-response:' + [string]$latest.selectorIndex
                $snapshotMissingWarned = $false
            } else {
                # 今turnの新規領域だけに限定する（Reuse turn で前turn=broadの回答を拾わないため, §7.4）。
                # BaselineLength は送信直前の main-text 長。これ以降が今回のプロンプトecho＋回答。
                # 固定anchorの Get-KoseiMainResponseRegion は multipass で前turnまで含むため使わない。
                $fullMain = Get-KoseiMainText -WsUrl $WsUrl
                if ($BaselineLength -gt 0 -and $fullMain.Length -gt $BaselineLength) {
                    $text = $fullMain.Substring($BaselineLength)
                } else {
                    $text = Get-KoseiMainResponseRegion -WsUrl $WsUrl
                }
            }
            $fetchErrors=0
        } catch {
            $fetchErrors++
            # ⚠️ TargetId が分かっているときは **自分のターゲット**を引き直す。
            #    条件一致の先頭を取ると、並列時に他ワーカーの窓へ乗り移り、
            #    2つのジョブが同じチャットを読み書きして両方壊れる。
            if($fetchErrors -ge 10){Write-KoseiLog "回答取得CDPエラーが10回以上連続。ターゲットを再取得します。 targetId=$TargetId" 'WARN';try{$page=$(if([string]::IsNullOrWhiteSpace($TargetId)){Get-KoseiCopilotPage -Settings $Settings}else{Get-KoseiCopilotPageById -Settings $Settings -TargetId $TargetId});$WsUrl=[string]$page.webSocketDebuggerUrl;$fetchErrors=0}catch{} }
            continue
        }
        $newText = ''
        $source = 'latest-response:' + [string]$latest.selectorIndex
        if (-not [string]::IsNullOrWhiteSpace($latestResponse)) {
            $newText = $latestResponse
        } elseif (-not [string]::IsNullOrWhiteSpace($lastResponseSnapshot)) {
            $source = 'snapshot:' + $lastResponseSource
            $newText = $lastResponseSnapshot
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                $newText = $lastResponseSnapshot + "`n" + $text
                $source += '+main-region'
            }
            if (-not $snapshotMissingWarned) {
                Write-KoseiLog "応答要素が消失。スナップショット(len=$($lastResponseSnapshot.Length))を使用" 'WARN'
                $snapshotMissingWarned = $true
            }
        } else {
            $source = 'main-diff'
            # textは最後のユーザー依頼以降に限定済み。プロンプトecho内マーカーを完了判定に使わない。
            $fullMarkerIdx = $text.LastIndexOf($marker)
            if ($fullMarkerIdx -ge 0) {
                $start = [Math]::Max(0, $fullMarkerIdx - $fallbackLookbackChars)
                $newText = $text.Substring($start, $fullMarkerIdx + $marker.Length - $start)
            } elseif ($text.Length -gt 0) {
                # マーカー出現前も固定オフセットは使わず、末尾側の十分な範囲を抽出候補にする。
                $start = [Math]::Max(0, $text.Length - $fallbackLookbackChars)
                $newText = $text.Substring($start)
            }
        }
        # 同じ文字数で拒否文へ置換された場合も変化として扱う。再伸長時はstable判定が必ずリセットされる。
        if ($newText -ne $lastObservedText) { $lastObservedText=$newText;$lastLen = $newText.Length; $stableSince = Get-Date }
        $stableSec = ((Get-Date) - $stableSince).TotalSeconds
        # 回答要素そのものの停滞時間を別に測る。$newText は応答要素が取れないときに
        # スナップショット＋main-region や main-diff へ切り替わるため、画面の付随表示が
        # 動くだけで $stableSec が戻ることがある。どちらかのクロックが止まれば停滞とみなす。
        # 応答要素が取れない周回ではこのクロックを進めない（代替経路で本文が伸びている
        # 最中に打ち切らないため）。
        if ([string]::IsNullOrWhiteSpace($latestResponse)) {
            $lastObservedResponse=$null; $responseStableSince = Get-Date
        } elseif ($latestResponse -ne $lastObservedResponse) {
            $lastObservedResponse=$latestResponse; $responseStableSince = Get-Date
        }
        $responseStableSec = ((Get-Date) - $responseStableSince).TotalSeconds
        $elapsedSec=[int][Math]::Floor($sw.Elapsed.TotalSeconds)
        # 完了検知は部分一致ではなく「独立した最終非空行の marker」で行う（§7.3 / fix F）。
        # 成功分類（valid JSON + complete）は後段の Get-KoseiReviewAnswerJson / Get-KoseiReviewCompleteness
        # が担い、marker検知済みで JSON が厳密でない場合は従来どおり incomplete-json へ脱出する。
        $markerFound = Test-KoseiTurnMarkerBoundary -Text $newText -Marker $marker
        $markerIdx = if ($markerFound) { 0 } else { -1 }
        $jsonCandidates = -1
        if ($markerFound) { $jsonCandidates = @(Get-KoseiJsonObjectCandidates -Text $newText).Count }
        if($elapsedSec-$lastProgressSec -ge 10){$lastProgressSec=$elapsedSec;Write-KoseiLog "回答待機中 elapsedSec=$elapsedSec newTextLen=$($newText.Length) stableSec=$([Math]::Round($stableSec,1)) responseStableSec=$([Math]::Round($responseStableSec,1)) responseSeen=$($responseSeen.ToString().ToLower()) markerFound=$($markerFound.ToString().ToLower()) jsonCandidates=$jsonCandidates source=$source fetchErrors=$fetchErrors" 'INFO';if($OnProgress){try{& $OnProgress ([pscustomobject]@{elapsedSec=$elapsedSec;newTextLen=$newText.Length;stableSec=$stableSec;fetchErrors=$fetchErrors})}catch{}}}

        $generating=$true
        if($responseSeen -and $stableSec -ge 5){$generating=Test-KoseiCopilotGenerating -WsUrl $WsUrl}
        if($responseSeen -and $stableSec -ge 5 -and -not $generating -and -not $markerFound -and (Test-KoseiCopilotRefusalText -Text $newText)){
            Write-KoseiLog "Copilot拒否応答を検出 completedBy=copilot-refusal stableSec=$([Math]::Round($stableSec,1)) len=$($newText.Length)" 'WARN'
            return [pscustomobject]@{ok=$false;completedBy='copilot-refusal';json=$null;rawJson=$newText;salvageText=$longestResponseSnapshot;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=($newText.Substring(0,[Math]::Min(200,$newText.Length)))}
        }
        # 「詳細を収集しています…」等の状態では停止ボタンが出たままになり generating=true が続く。
        # そのため下の no-json-idle（generating=false が条件）は永久に発火せず、
        # 本文が1文字も伸びないままタイムアウト(既定600秒)まで待ち続けてしまう（実測: 496文字で351秒停止）。
        # generating を名乗っていても一定時間まったく伸びなければ停滞とみなし、
        # 停止させて上位のリトライ（新規チャット再試行／分割再試行）へ回す。
        # 応答要素を一度も観測できていない間（$responseSeen=false）は、従来この節を丸ごと
        # 素通りしていた。実測: 受信46文字のまま300秒以上まったく動かないのに停滞検知が
        # 一度も発火せず、既定600秒のタイムアウトまで無言で待ち続けた。
        # ただし応答要素が出る前は長いthinkingの可能性があるので、閾値を倍にして誤打ち切りを避ける。
        $stalledSec = if($responseSeen){[Math]::Max($stableSec,$responseStableSec)}else{$stableSec}
        $stallLimit = if($responseSeen){$stallSec}else{$stallSec*2}
        if($stalledSec -ge $stallLimit){
            # 打ち切る前に、すでに完成した回答が来ていないか確認する。
            # 停滞の正体が「回答は出たがUIが生成中のまま」の場合、捨てると取り直しになる。
            $stallMeta=$null;$stallAnswer=Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$stallMeta) -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages
            if($stallAnswer){
                $stallInfo=Get-KoseiReviewCompleteness -Json $stallAnswer -ExpectedPages $ExpectedPages -ExpectedPacketId $ExpectedPacketId
                if($stallInfo.transport_complete){
                    $null=Invoke-KoseiClickStop -WsUrl $WsUrl
                    Write-KoseiLog ("停滞中に完成回答を検出 completedBy=json-stable accept=stalled stableSec=$([Math]::Round($stableSec,1)) findings=$($stallInfo.findingsCount) coverage=$([Math]::Round($stallInfo.coverage,3))") 'WARN'
                    return [pscustomobject]@{ok=$true;completedBy='json-stable';json=$stallAnswer;rawJson=$newText;repaired=[bool]$stallMeta.repaired;fixes=@($stallMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$stallInfo.findingsCount;pagesChecked=$stallInfo.pagesChecked;coverage=$stallInfo.coverage;warning=$stallInfo.warning}
                }
            }
            $null=Invoke-KoseiClickStop -WsUrl $WsUrl
            Write-KoseiLog "生成停滞を検出 completedBy=generation-stalled stalledSec=$([Math]::Round($stalledSec,1))/$stallLimit stableSec=$([Math]::Round($stableSec,1)) responseStableSec=$([Math]::Round($responseStableSec,1)) responseSeen=$($responseSeen.ToString().ToLower()) source=$source len=$($newText.Length) responseLen=$($latestResponse.Length) generating=$generating" 'WARN'
            return [pscustomobject]@{ok=$false;completedBy='generation-stalled';json=$null;rawJson=$newText;salvageText=$longestResponseSnapshot;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=($newText.Substring([Math]::Max(0,$newText.Length-200)))}
        }
        # 応答要素が一度出現した後だけ適用し、長いthinking中は打ち切らない。
        if($responseSeen -and $stableSec -ge 90 -and -not $generating){
            $idleMeta=$null;$idleAnswer=Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$idleMeta) -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages
            if(-not $idleAnswer){
                Write-KoseiLog "JSONなし停滞を検出 completedBy=no-json-idle stableSec=$([Math]::Round($stableSec,1)) len=$($newText.Length)" 'WARN'
                return [pscustomobject]@{ok=$false;completedBy='no-json-idle';json=$null;rawJson=$newText;salvageText=$longestResponseSnapshot;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=($newText.Substring([Math]::Max(0,$newText.Length-200)))}
            }
        }

        if ($markerIdx -ge 0) {
            $answerMeta=$null
            $answer = Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$answerMeta) -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages
            if ($answer) {
                $info = Get-KoseiReviewCompleteness -Json $answer -ExpectedPages $ExpectedPages -ExpectedPacketId $ExpectedPacketId
                if ($info.transport_complete) {
                    if (Test-KoseiCopilotGenerating -WsUrl $WsUrl) { $null = Invoke-KoseiClickStop -WsUrl $WsUrl }
                    $parseSummary=@($answerMeta.parseErrors)-join ' | ';if($parseSummary.Length -gt 200){$parseSummary=$parseSummary.Substring(0,200)+'…'}
                    Write-KoseiLog ("回答取得 completedBy=marker source=$source elapsedMs=$($sw.ElapsedMilliseconds) jsonLen=$($answer.Length) repaired=$($answerMeta.repaired) fixes=$(@($answerMeta.fixes)-join ',') parseErrors=$parseSummary candidateHeads=$(@($answerMeta.candidateHeads)-join ' | ') findings=$($info.findingsCount) pagesChecked=$(@($info.pagesChecked) -join ',') coverage=$([Math]::Round($info.coverage,3))") 'INFO'
                    return [pscustomobject]@{ ok=$true; completedBy='marker'; json=$answer; rawJson=$newText; diagnostics=$answerMeta; repaired=[bool]$answerMeta.repaired; fixes=@($answerMeta.fixes); elapsedMs=[int]$sw.ElapsedMilliseconds; findingsCount=$info.findingsCount; pagesChecked=$info.pagesChecked; coverage=$info.coverage; warning=$info.warning }
                }
                $lastIncompleteAnswer=$answer; $lastIncompleteInfo=$info; $lastIncompleteRaw=$newText; $lastIncompleteMeta=$answerMeta
                if($answer.Length -ne $lastIncompleteLogLength -or ((Get-Date)-$lastIncompleteLogAt).TotalSeconds -ge 10){
                    $lastIncompleteLogLength=$answer.Length;$lastIncompleteLogAt=Get-Date
                    Write-KoseiLog ("不完全回答を保留 source=marker jsonLen=$($answer.Length) repaired=$($answerMeta.repaired) fixes=$(@($answerMeta.fixes)-join ',') findings=$($info.findingsCount) pagesChecked=$(@($info.pagesChecked) -join ',') coverage=$([Math]::Round($info.coverage,3)) reason=$($info.warning)") 'WARN'
                }
            }
            # マーカー後に30秒変化せず生成も停止したら、最終修復結果を返して上位層の自動再試行へ渡す。
            if ($stableSec -ge 30 -and -not (Test-KoseiCopilotGenerating -WsUrl $WsUrl)) {
                $finalMeta=$null;$finalAnswer=Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$finalMeta) -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages
                $finalInfo=if($finalAnswer){Get-KoseiReviewCompleteness -Json $finalAnswer -ExpectedPages $ExpectedPages -ExpectedPacketId $ExpectedPacketId}else{$null}
                if($finalAnswer -and $finalInfo.transport_complete){
                    return [pscustomobject]@{ok=$true;completedBy='marker';json=$finalAnswer;rawJson=$newText;repaired=[bool]$finalMeta.repaired;fixes=@($finalMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$finalInfo.findingsCount;pagesChecked=$finalInfo.pagesChecked;coverage=$finalInfo.coverage;warning=$finalInfo.warning}
                }
                $diag=Get-KoseiReviewJsonDiagnostics -Text $newText
                $parseSummary=@($finalMeta.parseErrors)-join ' | ';if($parseSummary.Length -gt 200){$parseSummary=$parseSummary.Substring(0,200)+'…'}
                Write-KoseiLog ("不完全JSONから脱出 completedBy=incomplete-json stableSec=$([Math]::Round($stableSec,1)) repaired=$($finalMeta.repaired) fixes=$(@($finalMeta.fixes)-join ',') candidates=$($diag.count) parseErrors=$parseSummary candidateHeads=$(@($finalMeta.candidateHeads)-join ' | ')") 'WARN'
                return [pscustomobject]@{ok=$false;completedBy='incomplete-json';json=$finalAnswer;rawJson=$newText;repaired=[bool]$finalMeta.repaired;fixes=@($finalMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$(if($finalInfo){$finalInfo.findingsCount}else{0});pagesChecked=$(if($finalInfo){$finalInfo.pagesChecked}else{@()});coverage=$(if($finalInfo){$finalInfo.coverage}else{0});warning=$(if($finalInfo){$finalInfo.warning}else{'有効な回答JSONを復元できませんでした。'})}
            }
        }
        # マーカーが出ない場合の保険: 20秒安定し、生成停止を2回連続で確認する。
        if ($stableSec -ge 20) {
            $answerMeta=$null;$answer = Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$answerMeta) -ExpectedPacketId $ExpectedPacketId -ExpectedPages $ExpectedPages
            if ($answer) {
                if (Test-KoseiCopilotGenerating -WsUrl $WsUrl) { $notGeneratingPolls=0 } else { $notGeneratingPolls++ }
                $info = Get-KoseiReviewCompleteness -Json $answer -ExpectedPages $ExpectedPages -ExpectedPacketId $ExpectedPacketId
                # 生成停止を2回確認できるのが本来の経路。確認できなくても、完成JSONが
                # $stableAcceptSec 秒まったく変化しなければ受理する（UIが生成中を名乗り続ける事象への対処）。
                $acceptReason = if ($notGeneratingPolls -ge 2) { 'not-generating' } elseif ($stableSec -ge $stableAcceptSec) { 'stable-timeout' } else { '' }
                if ($info.transport_complete -and $acceptReason) {
                    Write-KoseiLog ("回答取得 completedBy=json-stable accept=$acceptReason stableSec=$([Math]::Round($stableSec,1)) elapsedMs=$($sw.ElapsedMilliseconds) jsonLen=$($answer.Length) findings=$($info.findingsCount) pagesChecked=$(@($info.pagesChecked) -join ',') coverage=$([Math]::Round($info.coverage,3))") 'WARN'
                    return [pscustomobject]@{ok=$true;completedBy='json-stable';json=$answer;rawJson=$newText;repaired=[bool]$answerMeta.repaired;fixes=@($answerMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$info.findingsCount;pagesChecked=$info.pagesChecked;coverage=$info.coverage;warning=$info.warning}
                }
                if (-not $info.transport_complete) { $lastIncompleteAnswer=$answer; $lastIncompleteInfo=$info;$lastIncompleteRaw=$newText;$lastIncompleteMeta=$answerMeta }
            }
        } else { $notGeneratingPolls=0 }
    }
    $tail = ''
    # 打ち切り時こそ本文を残す。ここで捨てると answers に何も出ず、
    # 「なぜ取れなかったのか」を後から調べる手段が無くなる（実測で踏んだ）。
    $timeoutRaw = ''
    try {
        $text = Get-KoseiMainText -WsUrl $WsUrl
        if ($text.Length -gt $BaselineLength) { $timeoutRaw = $text.Substring($BaselineLength) }
        $tail = $timeoutRaw
        if ($tail.Length -gt 200) { $tail = $tail.Substring($tail.Length - 200) }
    } catch {}
    $null = Invoke-KoseiClickStop -WsUrl $WsUrl
    if ($lastIncompleteAnswer) {
        Write-KoseiLog ("回答待機タイムアウト。不完全JSONを返却 jsonLen=$($lastIncompleteAnswer.Length) findings=$($lastIncompleteInfo.findingsCount) pagesChecked=$(@($lastIncompleteInfo.pagesChecked) -join ',') coverage=$([Math]::Round($lastIncompleteInfo.coverage,3))") 'WARN'
        return [pscustomobject]@{ok=$false;completedBy='incomplete-json';json=$lastIncompleteAnswer;rawJson=$lastIncompleteRaw;repaired=[bool]$lastIncompleteMeta.repaired;fixes=@($lastIncompleteMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$lastIncompleteInfo.findingsCount;pagesChecked=$lastIncompleteInfo.pagesChecked;coverage=$lastIncompleteInfo.coverage;warning=('応答が不完全なままタイムアウトしました。'+$lastIncompleteInfo.warning)}
    }
    Write-KoseiLog ("回答待機タイムアウト elapsedMs=$($sw.ElapsedMilliseconds) lastLen=$lastLen stableSec=$([Math]::Round(((Get-Date)-$stableSince).TotalSeconds,1)) fetchErrors=$fetchErrors tail=" + $tail) 'ERROR'
    return [pscustomobject]@{ ok = $false; completedBy = 'timeout'; json = $null; rawJson = $timeoutRaw; salvageText = $longestResponseSnapshot; elapsedMs = [int]$sw.ElapsedMilliseconds; tail = $tail }
}

# ---------------------------------------------------------------------
# ウォームアップ状態
# ---------------------------------------------------------------------
function Get-KoseiWarmupStatusPath {
    return (Join-Path (Get-KoseiSubDir 'runtime') 'copilot-warmup.json')
}

function Write-KoseiWarmupStatus {
    param([Parameter(Mandatory=$true)][string]$State, [string]$Detail = '')
    # pid を残す。この状態は **今のプロセスのCopilot** についてのものなので、
    # 別プロセス（前回起動・落ちた起動）が書いた ready を引き継いではいけない。
    $obj = @{ state = $State; detail = $Detail; updated_at = (Get-Date).ToString('s'); pid = $PID }
    try {
        $json = $obj | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText((Get-KoseiWarmupStatusPath), $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

function Read-KoseiWarmupStatus {
    # ⚠️ このファイルは runtime\ に残り続ける。**前回起動の ready をそのまま返してはいけない。**
    #    実測: -NoWarmup で起動したセッションが、前のセッションが書いた
    #    {"state":"ready","updated_at":"06:55:27"} をそのまま返し、
    #    Edge も Copilot も無いのに /api/ready-state が ready を報告した。
    #    さらに /api/review/jobs のゲート（Server.ps1）は preparing の間だけ待つので、
    #    古い ready は素通りし、ジョブが「準備できていないCopilot」に対して走り出す。
    $path = Get-KoseiWarmupStatusPath
    $unknown = [pscustomobject]@{ state = 'unknown'; detail = ''; updated_at = ''; pid = 0 }
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { return $unknown }
    try {
        $obj = ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
    } catch {
        return $unknown
    }
    # 書いたのが自分のプロセスでなければ、前回起動の残骸とみなす。
    # 唯一の書き手はこのプロセス（起動時の本体と、ウォームアップ用 runspace）である。
    $ownerPid = 0
    if ($obj -and ($obj.PSObject.Properties.Name -contains 'pid')) { $ownerPid = [int]$obj.pid }
    if ($ownerPid -ne $PID) {
        return [pscustomobject]@{ state = 'unknown'; detail = '前回起動の状態のため無視しました'; updated_at = [string]$obj.updated_at; pid = $ownerPid }
    }
    return $obj
}

function Invoke-KoseiSameChatRetry {
    param([Parameter(Mandatory=$true)][string]$WsUrl,[Parameter(Mandatory=$true)]$Settings)
    $js=@'
(() => {
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;/* 最小化中はレイアウトが止まり実寸が0になる。ウィンドウが隠れているときだけサイズ要件を外す */if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const b=buttons.reverse().find(e=>/(再試行|再生成|retry|regenerate|try again)/i.test((e.innerText||e.getAttribute('aria-label')||e.title||'').trim()));
  if(!b)return false;b.click();return true;
})()
'@
    try{$retryRaw=Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15;$clicked=([string]$retryRaw).ToLowerInvariant() -eq 'true'}catch{$clicked=$false}
    if($clicked){Write-KoseiLog '同一チャットの再試行ボタンをクリック' 'WARN';return $true}
    try{
        Invoke-KoseiInsertPrompt -WsUrl $WsUrl -Settings $Settings -Prompt '直前の処理を再試行し、添付指示書どおりの厳密なJSONだけを最後まで出力してください。'
        $null=Invoke-KoseiClickSend -WsUrl $WsUrl
        Write-KoseiLog '同一チャットへ再依頼文を送信' 'WARN';return $true
    }catch{Write-KoseiLog ("同一チャット再試行に失敗: "+$_.Exception.Message) 'WARN';return $false}
}

function Write-KoseiRefusalStat {
    param([string]$CompletedBy,[int]$ElapsedMs)
    try{
        $path=Join-Path (Get-KoseiSubDir 'runtime') 'refusal-stats.csv'
        if(-not (Test-Path -LiteralPath $path)){Add-Content -LiteralPath $path -Value 'timestamp,completed_by,elapsed_ms' -Encoding UTF8}
        Add-Content -LiteralPath $path -Value ((Get-Date).ToString('s')+','+$CompletedBy+','+$ElapsedMs) -Encoding UTF8
    }catch{}
}

# ---------------------------------------------------------------------
# オーケストレーション: 1パケットの校正依頼
# ---------------------------------------------------------------------
function Invoke-KoseiCopilotReviewRequest {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$Prompt,
        [string[]]$AttachPaths = @(),
        # ChatMode（計画書 §7.1）: New=新規チャット+モデル選択+添付 /
        #   Reuse=現チャット維持（添付・モデル選択を省略） / RestartWithContext=新規+再添付
        [ValidateSet('New','Reuse','RestartWithContext')][string]$ChatMode = 'New',
        # 空なら $Settings.response_end_marker。turnごとに一意のマーカーを渡す（§7.3）
        [string]$Marker = '',
        [scriptblock]$OnPhase = $null,
        [scriptblock]$ShouldCancel = $null,
        [scriptblock]$OnWaitProgress = $null,
        [int[]]$ExpectedPages = @(),
        [string]$ExpectedPacketId = '',
        # ワーカーごとに別ウィンドウを持たせるための継ぎ目（引き継ぎ書 §6.4 #1）。
        # 省略時はこれまでどおり自分で「条件に合う最初のページ」を解決する。
        # 並列時は、呼び出し側が Target.createTarget で作ったページを渡すこと。
        $Page = $null
    )
    $report = {
        param([string]$Phase)
        if ($OnPhase) { try { & $OnPhase $Phase } catch {} }
    }

    $totalWatch=[System.Diagnostics.Stopwatch]::StartNew();$phaseTimes=[ordered]@{model_select_ms=0;attach_ms=0;input_send_ms=0;response_wait_ms=0};$phaseWatch=[System.Diagnostics.Stopwatch]::StartNew()
    if ($ChatMode -eq 'Reuse' -and $AttachPaths.Count -gt 0) { throw 'ChatMode=Reuse では新規添付を渡せません（§7.1）。' }
    & $report 'preparing'
    Start-KoseiCopilotEdge -Settings $Settings
    # 呼び出し側がページを指定していればそれを使う（並列時はワーカー専用の窓）。
    $page = if ($null -ne $Page) { $Page } else { Get-KoseiCopilotPage -Settings $Settings }
    $wsUrl = [string]$page.webSocketDebuggerUrl
    $targetId = [string]$page.id
    if ([string]::IsNullOrWhiteSpace($wsUrl)) { throw '指定されたCopilotページに webSocketDebuggerUrl がありません。' }

    $readyTimeout = [int]$script:KoseiCopilotPacketReadyTimeoutSeconds
    $gate = Wait-KoseiCopilotScreenReady -WsUrl $WsUrl -Settings $Settings -TimeoutSeconds $readyTimeout -ShouldCancel $ShouldCancel
    if ($gate.cancelled) { return [pscustomobject]@{ ok=$false; completedBy='cancelled'; elapsedMs=0 } }
    if (-not $gate.ok) { throw ([string]$gate.message) }

    # Reuse は現在のチャットを維持し、新規チャット遷移・2回目ゲート・モデル選択・添付を省略する（§7.1）。
    # New / RestartWithContext は従来どおり全て実行する（既定 New は v94 と同一挙動）。
    if ($ChatMode -ne 'Reuse') {
        # 前回この窓で添付が進まなかったなら、チャットを変えるだけでは足りない。
        # ページごと入れ直してから始める（Invoke-KoseiFreshChat の注記を参照）。
        $hard = $false
        try { $hard = [bool]$script:KoseiAttachStalledWs[$wsUrl] } catch {}
        if ($hard) { try { $script:KoseiAttachStalledWs.Remove($wsUrl) } catch {} }
        & $report 'new_chat'
        $fresh = Invoke-KoseiFreshChat -WsUrl $wsUrl -Settings $Settings -HardReset:$hard
        # 新規チャットボタンのクリック時も、Page.navigateによる初期化時も、
        # 読み込み完了を推測せず同じ60秒ゲートを必ず通す。
        $gate = Wait-KoseiCopilotScreenReady -WsUrl $wsUrl -Settings $Settings -TimeoutSeconds ([int]$script:KoseiCopilotPacketReadyTimeoutSeconds) -ShouldCancel $ShouldCancel
        if ($gate.cancelled) { return [pscustomobject]@{ ok=$false; completedBy='cancelled'; elapsedMs=0 } }
        if (-not $gate.ok) { throw ([string]$gate.message) }

        # モデルセレクターを優先度リスト（既定: GPT 5.6 Think deeper → Opus → Think Deeper）へ切替。全滅時は変更せず続行。
        & $report 'model_select'
        $phaseWatch.Restart();$null = Set-KoseiCopilotModel -WsUrl $wsUrl -Settings $Settings;$phaseTimes.model_select_ms=[int]$phaseWatch.ElapsedMilliseconds

        if ($AttachPaths.Count -gt 0) {
            & $report 'attaching'
            $phaseWatch.Restart();$attachResult = Invoke-KoseiCopilotAttachFiles -WsUrl $wsUrl -Settings $Settings -Files $AttachPaths -ShouldCancel $ShouldCancel;$phaseTimes.attach_ms=[int]$phaseWatch.ElapsedMilliseconds
            if ($attachResult.completedBy -eq 'cancelled') { return $attachResult }
        }
    }

    & $report 'sending'
    $phaseWatch.Restart()
    $baseline = (Get-KoseiMainText -WsUrl $wsUrl).Length
    Invoke-KoseiInsertPrompt -WsUrl $wsUrl -Settings $Settings -Prompt $Prompt
    # 添付の後処理中は送信ボタンが一時的に無効なことがあるためリトライする
    $sendDeadline = (Get-Date).AddSeconds(20)
    $sent = $false
    $lastSendError = ''
    while ((Get-Date) -lt $sendDeadline) {
        try { $null = Invoke-KoseiClickSend -WsUrl $wsUrl; $sent = $true; break }
        catch { $lastSendError = $_.Exception.Message; Start-Sleep -Milliseconds 1000 }
    }
    if (-not $sent) { throw ("送信ボタンをクリックできませんでした: " + $lastSendError) }
    $phaseTimes.input_send_ms=[int]$phaseWatch.ElapsedMilliseconds

    & $report 'waiting'
    $phaseWatch.Restart();$wait = Wait-KoseiCopilotReviewResponse -WsUrl $wsUrl -Settings $Settings -BaselineLength $baseline -Marker $Marker -TimeoutSeconds ([int]$Settings.request_timeout) -ShouldCancel $ShouldCancel -OnProgress $OnWaitProgress -ExpectedPages $ExpectedPages -ExpectedPacketId $ExpectedPacketId -TargetId $targetId;$phaseTimes.response_wait_ms=[int]$phaseWatch.ElapsedMilliseconds
    if(@('copilot-refusal','no-json-idle') -contains [string]$wait.completedBy){
        Write-KoseiRefusalStat -CompletedBy ([string]$wait.completedBy) -ElapsedMs ([int]$wait.elapsedMs)
        $salvage=[string]$wait.salvageText
        if(Invoke-KoseiSameChatRetry -WsUrl $wsUrl -Settings $Settings){
            $retryBaseline=(Get-KoseiMainText -WsUrl $wsUrl).Length
            $retry=Wait-KoseiCopilotReviewResponse -WsUrl $wsUrl -Settings $Settings -BaselineLength $retryBaseline -Marker $Marker -TimeoutSeconds ([Math]::Min(300,[int]$Settings.request_timeout)) -ShouldCancel $ShouldCancel -OnProgress $OnWaitProgress -ExpectedPages $ExpectedPages -ExpectedPacketId $ExpectedPacketId -TargetId $targetId
            if([string]::IsNullOrWhiteSpace([string]$retry.salvageText) -and -not [string]::IsNullOrWhiteSpace($salvage)){$retry|Add-Member -NotePropertyName salvageText -NotePropertyValue $salvage -Force}
            $wait=$retry
        }
    }
    if ($wait.completedBy -eq 'cancelled') { return $wait }
    # 構造化された結果はそのまま返す。throw にすると呼び出し側は例外しか受け取れず、
    # ReviewJob の $recoverable（新規チャット再試行・分割再試行）が一切効かないうえ、
    # rawJson / salvageText / diagnostics も失われて原因が追えなくなる。
    # 実測: generation-stalled がこの一覧に無かったため例外へ化け、
    #       画面には原因に関わらず「（timeout）」と出て、answers に何も残らなかった。
    # 想定外の completedBy だけは throw して気づけるようにする。
    $structured = @('incomplete-json','copilot-refusal','no-json-idle','generation-stalled','timeout')
    if (-not $wait.ok -and $structured -notcontains [string]$wait.completedBy) {
        throw ("Copilot回答を取得できませんでした（" + [string]$wait.completedBy + "）。末尾: " + [string]$wait.tail)
    }
    $wait | Add-Member -NotePropertyName phaseTimings -NotePropertyValue ([pscustomobject]$phaseTimes) -Force
    $wait | Add-Member -NotePropertyName totalElapsedMs -NotePropertyValue ([int]$totalWatch.ElapsedMilliseconds) -Force
    # -NoWarmup 起動などで warmup 状態が unknown のままでも、ジョブが実際に
    # Copilot と往復できたなら接続済みである。バッジ（/api/ready-state）へ反映する。
    # ワーカー runspace も同一プロセスなので pid ガードは通る。
    if ($wait.ok) { Write-KoseiWarmupStatus -State 'ready' -Detail '校正ジョブでCopilot応答を確認しました' }
    Write-KoseiLog ("パケット所要時間 totalMs=$($wait.totalElapsedMs) modelMs=$($phaseTimes.model_select_ms) attachMs=$($phaseTimes.attach_ms) sendMs=$($phaseTimes.input_send_ms) responseMs=$($phaseTimes.response_wait_ms)") 'INFO'
    return $wait
}
