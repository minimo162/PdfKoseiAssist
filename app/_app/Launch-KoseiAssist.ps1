[CmdletBinding(PositionalBinding=$false)]
param(
    [ValidateSet('App','Drop','Setup')][string]$Entry='App',
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths
)

# =====================================================================
# Launch-KoseiAssist.ps1 — 共有フォルダ配布の入口
#
# 共有フォルダ（配布元）の _app をその場では動かさず、利用者ごとの
# %LOCALAPPDATA%\PdfKoseiAssist\versions\<版> へ写してから起動する。
#  - 管理者は利用中でも共有フォルダを上書きしてよい（動いている版は手元にある）
#  - 上書きの途中で読んだときは release-manifest.json のハッシュが合わないので、
#    切り替えずに前の版で起動する
#  - 共有フォルダにつながらないときも、手元の版で起動する
#  - 手元でアプリ（サーバー）が動いている間は、その版を使い続ける
#    （新しい版へは、次にアプリを起動したときに切り替わる）
# release-manifest.json の無いフォルダ（開発用の作業コピー）では、その場で起動する。
#
# 「送る」のショートカットは %LOCALAPPDATA%\PdfKoseiAssist\Launch-KoseiAssist.ps1 を指す。
# この場所の写しは、起動のたびに最新の版のものへ置き換える。
# =====================================================================

$script:KoseiEntryScripts = @{ App = 'Start-KoseiAssist.ps1'; Drop = 'Start-DropReview.ps1'; Setup = 'Setup-KoseiAssist.ps1' }
$script:KoseiManifestName = 'release-manifest.json'
$script:KoseiLauncherName = 'Launch-KoseiAssist.ps1'
$script:KoseiDefaultPorts = @(8098, 8099, 8100, 8101, 8102)

function Get-KoseiInstallBase {
    $override = [Environment]::GetEnvironmentVariable('PDF_KOSEI_INSTALL_DIR')
    if (-not [string]::IsNullOrWhiteSpace($override)) { return [IO.Path]::GetFullPath($override) }
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($local)) { $local = Join-Path (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData') 'Local' }
    return (Join-Path $local 'PdfKoseiAssist')
}

function Write-KoseiLauncherLog {
    param([string]$Message)
    try {
        # Paths.ps1 の Get-KoseiDataDir と同じ場所（この時点ではまだ読み込めないため、ここでも求める）。
        $dataDir = [Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')
        if ([string]::IsNullOrWhiteSpace($dataDir)) { $dataDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pdf-kosei-ps' }
        $logs = Join-Path ([IO.Path]::GetFullPath($dataDir)) 'logs'
        $null = [IO.Directory]::CreateDirectory($logs)
        $path = Join-Path $logs 'launcher.log'
        if ([IO.File]::Exists($path) -and (New-Object IO.FileInfo($path)).Length -gt 1MB) { [IO.File]::Delete($path) }
        $line = '[' + (Get-Date).ToString('s') + '] ' + ([string]$Message -replace '[\r\n]+', ' ')
        [IO.File]::AppendAllText($path, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    } catch {}
}

function Test-KoseiPathUnder {
    param([string]$Path, [string]$Parent)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return ($full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase))
}

function Get-KoseiFileSha256 {
    param([string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-KoseiReleaseBuildId {
    # 版の識別子。ファイル一覧とハッシュだけから決まるので、同じ中身なら同じ値になる。
    param([Parameter(Mandatory=$true)]$Files)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($file in @($Files)) { $lines.Add(([string]$file.path) + "`t" + ([string]$file.sha256)) }
    $sorted = $lines.ToArray(); [Array]::Sort($sorted, [StringComparer]::Ordinal)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($sorted -join "`n") + "`n")))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function New-KoseiReleaseManifest {
    # tools\Package-Release.ps1 から呼ぶ。_app 配下の配布ファイルの一覧とハッシュを書き出す。
    # config\settings.json は管理者が共有フォルダで直接書き換えるので、一覧に入れない（起動のたびに写す）。
    param([Parameter(Mandatory=$true)][string]$AppRoot)
    $version = [IO.File]::ReadAllText((Join-Path $AppRoot 'VERSION'), [Text.Encoding]::UTF8).Trim()
    $rootFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\', '/')
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force)) {
        $relative = $item.FullName.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
        if ($relative -eq $script:KoseiManifestName -or $relative -eq 'config/settings.json') { continue }
        $files.Add([ordered]@{ path = $relative; size = [long]$item.Length; sha256 = (Get-KoseiFileSha256 $item.FullName) })
    }
    $sortedFiles = @($files.ToArray() | Sort-Object -Property @{ Expression = { [string]$_.path } } -CaseSensitive)
    $manifest = [ordered]@{ schema = 1; version = $version; build = (Get-KoseiReleaseBuildId $sortedFiles); files = $sortedFiles }
    $json = $manifest | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $rootFull $script:KoseiManifestName), $json, (New-Object Text.UTF8Encoding($false)))
    return $manifest
}

function ConvertFrom-KoseiReleaseManifest {
    param([Parameter(Mandatory=$true)][string]$Text)
    $manifest = $Text | ConvertFrom-Json
    if ([string]$manifest.version -notmatch '^\d+\.\d+(?:\.\d+)?$') { throw 'release-manifest.json の版が不正です。' }
    if ([string]$manifest.build -notmatch '^[0-9a-f]{64}$') { throw 'release-manifest.json の build が不正です。' }
    $files = @($manifest.files)
    if ($files.Count -eq 0) { throw 'release-manifest.json にファイルがありません。' }
    foreach ($file in $files) {
        $p = [string]$file.path
        if ([string]::IsNullOrWhiteSpace($p) -or $p.Contains('\') -or $p.StartsWith('/') -or $p.Contains(':') -or ($p.Split('/') -contains '..') -or ($p.Split('/') -contains '.')) { throw ('release-manifest.json のパスが不正です: ' + $p) }
        if ([string]$file.sha256 -notmatch '^[0-9a-f]{64}$') { throw ('release-manifest.json のハッシュが不正です: ' + $p) }
    }
    # 一覧とbuildが食い違う（書きかけ・手で編集した）manifest は使わない。
    if ((Get-KoseiReleaseBuildId $files) -ne [string]$manifest.build) { throw 'release-manifest.json の一覧と build が一致しません。' }
    return $manifest
}

function Read-KoseiReleaseManifest {
    # 共有フォルダにつながらないとき、UNC パスの確認は数十秒止まることがある。待つのは一定時間まで。
    param([Parameter(Mandatory=$true)][string]$Source, [int]$TimeoutMilliseconds = 8000)
    $path = Join-Path $Source $script:KoseiManifestName
    $ps = [powershell]::Create()
    $null = $ps.AddScript({ param($Path) if (-not [IO.File]::Exists($Path)) { return '' }; return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }).AddArgument($path)
    $async = $ps.BeginInvoke()
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) {
        try { $null = $ps.BeginStop($null, $null) } catch {}
        throw ('KOSEI_SOURCE_OFFLINE: 配布フォルダに時間内に接続できませんでした: ' + $Source)
    }
    try { $text = [string](@($ps.EndInvoke($async)) -join '') }
    catch { throw ('KOSEI_SOURCE_OFFLINE: 配布フォルダを読めませんでした: ' + $Source + ' ' + $_.Exception.Message) }
    finally { $ps.Dispose() }
    # 接続できないUNCパスは「ファイルが無い」と同じに見える。
    if ([string]::IsNullOrWhiteSpace($text)) { throw ('KOSEI_SOURCE_OFFLINE: 配布フォルダに release-manifest.json が見つかりません: ' + $Source) }
    # 読めたのに壊れている manifest は、管理者が書き込んでいる途中とみなす。
    try { return (ConvertFrom-KoseiReleaseManifest $text) } catch { throw ('KOSEI_SOURCE_CHANGING: ' + $_.Exception.Message) }
}

function Get-KoseiInstallName {
    param([Parameter(Mandatory=$true)]$Manifest)
    return ([string]$Manifest.version + '-' + ([string]$Manifest.build).Substring(0, 12))
}

function Test-KoseiInstallComplete {
    param([string]$Directory)
    return ([IO.File]::Exists((Join-Path $Directory '.complete')))
}

function Remove-KoseiInstallDirectory {
    param([string]$Directory)
    # 途中で消せなかったときに「完成した版」と誤認しないよう、目印を先に消す。
    $marker = Join-Path $Directory '.complete'
    if ([IO.File]::Exists($marker)) { [IO.File]::Delete($marker) }
    Remove-Item -LiteralPath $Directory -Recurse -Force -ErrorAction Stop
}

function Install-KoseiRelease {
    param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string]$Base)
    $versions = Join-Path $Base 'versions'
    $target = Join-Path $versions (Get-KoseiInstallName $Manifest)
    if (Test-KoseiInstallComplete $target) { return $target }
    $null = [IO.Directory]::CreateDirectory($versions)
    $stage = Join-Path $versions ('.staging-' + [guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($stage)
    try {
        foreach ($file in @($Manifest.files)) {
            $from = Join-Path $Source ([string]$file.path)
            $to = Join-Path $stage ([string]$file.path)
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
            try { [IO.File]::Copy($from, $to, $true) }
            catch { throw ('KOSEI_SOURCE_CHANGING: 配布フォルダのファイルを読めませんでした（' + [string]$file.path + '）: ' + $_.Exception.Message) }
            if ((Get-KoseiFileSha256 $to) -ne [string]$file.sha256) { throw ('KOSEI_SOURCE_CHANGING: 配布フォルダのファイルが一覧と一致しません（' + [string]$file.path + '）。更新中の可能性があります。') }
        }
        $manifestJson = [ordered]@{ schema = 1; version = [string]$Manifest.version; build = [string]$Manifest.build; files = @($Manifest.files) } | ConvertTo-Json -Depth 5
        [IO.File]::WriteAllText((Join-Path $stage $script:KoseiManifestName), $manifestJson, (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $stage '.complete'), (Get-Date).ToString('o'))
        if ([IO.Directory]::Exists($target)) { Remove-KoseiInstallDirectory $target }
        # 書いた直後のファイルはウイルス対策の検査で一瞬つかまれていることがある。少し待って数回やり直す。
        for ($attempt = 1; ; $attempt++) {
            try { [IO.Directory]::Move($stage, $target); break }
            catch { if ($attempt -ge 10) { throw }; Start-Sleep -Milliseconds 300 }
        }
        $stage = $null
        Write-KoseiLauncherLog ('installed ' + $target + ' from ' + $Source)
    } finally {
        if ($stage) { try { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop } catch {} }
    }
    return $target
}

function Get-KoseiCompleteInstalls {
    param([Parameter(Mandatory=$true)][string]$Base)
    $versions = Join-Path $Base 'versions'
    if (-not [IO.Directory]::Exists($versions)) { return @() }
    $items = @()
    foreach ($dir in @([IO.Directory]::GetDirectories($versions))) {
        if ([IO.Path]::GetFileName($dir).StartsWith('.')) { continue }
        $marker = Join-Path $dir '.complete'
        if (-not [IO.File]::Exists($marker)) { continue }
        $items += [pscustomobject]@{ Path = $dir; Completed = [IO.File]::GetLastWriteTimeUtc($marker) }
    }
    return @($items | Sort-Object -Property Completed -Descending | ForEach-Object { $_.Path })
}

function Get-KoseiCurrentInstall {
    param([Parameter(Mandatory=$true)][string]$Base)
    $pointer = Join-Path $Base 'current.txt'
    if ([IO.File]::Exists($pointer)) {
        $name = [IO.File]::ReadAllText($pointer, [Text.Encoding]::UTF8).Trim()
        if ($name -and $name -notmatch '[\\/]' -and -not $name.StartsWith('.')) {
            $dir = Join-Path (Join-Path $Base 'versions') $name
            if (Test-KoseiInstallComplete $dir) { return $dir }
        }
    }
    return (@(Get-KoseiCompleteInstalls $Base) | Select-Object -First 1)
}

function Get-KoseiInstallVersion {
    param([string]$Directory)
    try { return [IO.File]::ReadAllText((Join-Path $Directory 'VERSION'), [Text.Encoding]::UTF8).Trim() } catch { return '' }
}

function Get-KoseiServerPorts {
    param([string]$Directory)
    try {
        $settings = [IO.File]::ReadAllText((Join-Path (Join-Path $Directory 'config') 'settings.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $ports = @($settings.server_ports | ForEach-Object { [int]$_ } | Where-Object { $_ -gt 0 })
        if ($ports.Count) { return $ports }
    } catch {}
    return $script:KoseiDefaultPorts
}

function Get-KoseiRunningServerVersion {
    # 手元で動いているアプリの版。待ち受けていないポートへは問い合わせない（Windows は接続拒否の応答が遅い）。
    param([int[]]$Ports)
    $listening = @()
    try { $listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port }) } catch { $listening = $Ports }
    foreach ($port in @($Ports)) {
        if ($listening -notcontains $port) { continue }
        try { $health = Invoke-RestMethod -UseBasicParsing -Uri ('http://127.0.0.1:' + $port + '/__health') -TimeoutSec 2 } catch { continue }
        if ($health.ok) { return [string]$health.version }
    }
    return ''
}

function Sync-KoseiSettings {
    # 設定は管理者が共有フォルダの config\settings.json で一括管理する。つながったときに毎回写す。
    param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Target)
    $from = Join-Path (Join-Path $Source 'config') 'settings.json'
    $to = Join-Path (Join-Path $Target 'config') 'settings.json'
    if ([IO.File]::Exists($from)) {
        $bytes = [IO.File]::ReadAllBytes($from)
        if ([IO.File]::Exists($to) -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($to)) -eq [Convert]::ToBase64String($bytes)) { return }
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
        $temp = $to + '.new'
        [IO.File]::WriteAllBytes($temp, $bytes)
        if ([IO.File]::Exists($to)) { [IO.File]::Delete($to) }
        [IO.File]::Move($temp, $to)
    } elseif ([IO.File]::Exists($to)) {
        [IO.File]::Delete($to)
    }
}

function Update-KoseiStableLauncher {
    # 「送る」が指す手元の入口を、使う版のものへそろえる。読みかけの別プロセスに半端な中身を見せないよう、別名で書いてから置き換える。
    param([Parameter(Mandatory=$true)][string]$Base, [Parameter(Mandatory=$true)][string]$Target)
    $from = Join-Path $Target $script:KoseiLauncherName
    $to = Join-Path $Base $script:KoseiLauncherName
    if (-not [IO.File]::Exists($from)) { return }
    $bytes = [IO.File]::ReadAllBytes($from)
    if ([IO.File]::Exists($to) -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($to)) -eq [Convert]::ToBase64String($bytes)) { return }
    $temp = $to + '.new'
    [IO.File]::WriteAllBytes($temp, $bytes)
    # PowerShell は文字列引数の $null を空文字にする（File.Replace が失敗する）ので、NullString で「控えなし」を渡す。
    if ([IO.File]::Exists($to)) { [IO.File]::Replace($temp, $to, [NullString]::Value) } else { [IO.File]::Move($temp, $to) }
}

function Remove-KoseiOldInstalls {
    # 使う版・動いている版・直前の版は残す。消せないもの（使用中）はそのままにして次の機会に回す。
    param([Parameter(Mandatory=$true)][string]$Base, [string[]]$Keep = @())
    $installs = @(Get-KoseiCompleteInstalls $Base)
    $keepSet = @($Keep | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\', '/') })
    $keepSet += @($installs | Select-Object -First 2 | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\', '/') })
    foreach ($dir in $installs) {
        $full = [IO.Path]::GetFullPath($dir).TrimEnd('\', '/')
        if (@($keepSet | Where-Object { $_.Equals($full, [StringComparison]::OrdinalIgnoreCase) }).Count) { continue }
        try { Remove-KoseiInstallDirectory $dir; Write-KoseiLauncherLog ('removed old version ' + $dir) } catch { Write-KoseiLauncherLog ('old version cleanup skipped: ' + $dir + ' ' + $_.Exception.Message) }
    }
    $versions = Join-Path $Base 'versions'
    if ([IO.Directory]::Exists($versions)) {
        foreach ($dir in @([IO.Directory]::GetDirectories($versions))) {
            $name = [IO.Path]::GetFileName($dir)
            $isLeftover = $name.StartsWith('.staging-') -or -not (Test-KoseiInstallComplete $dir)
            if ($isLeftover -and [IO.Directory]::GetLastWriteTimeUtc($dir) -lt [DateTime]::UtcNow.AddDays(-1)) {
                try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop } catch {}
            }
        }
    }
}

function Resolve-KoseiLaunchRoot {
    # 起動に使う _app のフォルダを決める。戻り値: @{ Root; Installed; Base }
    param([Parameter(Mandatory=$true)][string]$Here, [Parameter(Mandatory=$true)][string]$Base)
    $isInstalledCopy = Test-KoseiPathUnder $Here $Base
    if (-not $isInstalledCopy -and -not [IO.File]::Exists((Join-Path $Here $script:KoseiManifestName))) {
        return @{ Root = $Here; Installed = $false; Base = $Base }
    }
    $null = [IO.Directory]::CreateDirectory($Base)
    $sourceFile = Join-Path $Base 'source.txt'
    $mutex = New-Object Threading.Mutex($false, 'Local\PdfKoseiAssistInstall')
    $held = $false
    try {
        try { $held = $mutex.WaitOne([TimeSpan]::FromMinutes(5)) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw '別の起動がアプリを準備しています。少し待ってから、もう一度実行してください。' }
        $source = ''
        if ($isInstalledCopy) {
            if ([IO.File]::Exists($sourceFile)) { $source = [IO.File]::ReadAllText($sourceFile, [Text.Encoding]::UTF8).Trim() }
        } else {
            $source = [IO.Path]::GetFullPath($Here).TrimEnd('\', '/')
            [IO.File]::WriteAllText($sourceFile, $source, (New-Object Text.UTF8Encoding($false)))
        }
        $target = $null; $online = $false; $problem = ''
        if ($source) {
            try {
                $manifest = Read-KoseiReleaseManifest -Source $source
                $online = $true
                $target = Install-KoseiRelease -Source $source -Manifest $manifest -Base $Base
                [IO.File]::WriteAllText((Join-Path $Base 'current.txt'), [IO.Path]::GetFileName($target), (New-Object Text.UTF8Encoding($false)))
            } catch {
                $reason = [string]$_.Exception.Message
                $problem = $(if ($reason.StartsWith('KOSEI_SOURCE_OFFLINE')) { 'offline' } elseif ($reason.StartsWith('KOSEI_SOURCE_CHANGING')) { 'changing' } else { 'error' })
                Write-KoseiLauncherLog ('sync skipped (' + $problem + '): ' + $_.Exception.Message)
                $target = $null
            }
        } else {
            $problem = 'nosource'
        }
        if (-not $target) { $target = Get-KoseiCurrentInstall $Base }
        if (-not $target) {
            switch ($problem) {
                'nosource' { throw 'アプリの配布元が分かりません。共有フォルダの「PDF校正アシスト_初回セットアップ.cmd」をダブルクリックしてください。' }
                'changing' { throw 'アプリの配布フォルダが更新中のため、準備できませんでした。数分待ってから、もう一度実行してください。' }
                'offline' { throw ('アプリの配布フォルダ（' + $source + '）に接続できませんでした。社内ネットワークにつながっているか確かめてから、もう一度実行してください。') }
                default { throw ('アプリを準備できませんでした。もう一度実行してください。直らないときは、' + (Join-Path (Join-Path (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pdf-kosei-ps') 'logs') 'launcher.log') + ' を管理者に渡してください。') }
            }
        }
        # 手元でアプリが動いている間は、その版を使い続ける（入れ替えは次にアプリを起動したとき）。
        $keep = @($target)
        $running = Get-KoseiRunningServerVersion -Ports (Get-KoseiServerPorts $target)
        if ($running -and $running -ne (Get-KoseiInstallVersion $target)) {
            $same = @(Get-KoseiCompleteInstalls $Base | Where-Object { (Get-KoseiInstallVersion $_) -eq $running }) | Select-Object -First 1
            if ($same) { Write-KoseiLauncherLog ('running version ' + $running + ' is kept; update applies next time'); $target = $same; $keep += $same }
        }
        if ($online) { try { Sync-KoseiSettings -Source $source -Target $target } catch { Write-KoseiLauncherLog ('settings sync skipped: ' + $_.Exception.Message) } }
        try { Update-KoseiStableLauncher -Base $Base -Target $target } catch { Write-KoseiLauncherLog ('launcher update skipped: ' + $_.Exception.Message) }
        Remove-KoseiOldInstalls -Base $Base -Keep $keep
        return @{ Root = $target; Installed = $true; Base = $Base }
    } finally {
        if ($held) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        $resolved = Resolve-KoseiLaunchRoot -Here $PSScriptRoot -Base (Get-KoseiInstallBase)
        # 「送る」のショートカットに登録する入口。手元に写した版では、版をまたいで変わらない場所を指す。
        $stable = Join-Path $resolved.Base $script:KoseiLauncherName
        if (-not $resolved.Installed) { $stable = $PSCommandPath }
        elseif (-not [IO.File]::Exists($stable)) { $stable = Join-Path $resolved.Root $script:KoseiLauncherName }
        $env:PDF_KOSEI_LAUNCHER = $stable
    } catch {
        $message = $_.Exception.Message
        Write-KoseiLauncherLog ('launch failed: ' + $message)
        try { [Console]::Error.WriteLine($message) } catch {}
        try { Add-Type -AssemblyName PresentationFramework -ErrorAction Stop; [void][System.Windows.MessageBox]::Show($message, 'PDF校正アシスト') } catch {}
        exit 1
    }
    $entryScript = Join-Path $resolved.Root $script:KoseiEntryScripts[$Entry]
    if ($Entry -eq 'Drop') { & $entryScript -Paths $Paths } else { & $entryScript }
    exit $LASTEXITCODE
}
