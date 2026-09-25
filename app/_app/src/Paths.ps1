function Get-KoseiRoot {
    if ($script:KoseiRoot) { return $script:KoseiRoot }
    $src = Split-Path -Parent $MyInvocation.MyCommand.Path
    return (Split-Path -Parent $src)
}

function Set-KoseiRoot {
    param([Parameter(Mandatory=$true)][string]$Root)
    $script:KoseiRoot = $Root
}

function Get-KoseiDataDir {
    $override = [Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        $dir = [System.IO.Path]::GetFullPath($override)
        if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        return $dir
    }
    $homeDir = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($homeDir)) { $homeDir = [Environment]::GetEnvironmentVariable('USERPROFILE') }
    if ([string]::IsNullOrWhiteSpace($homeDir)) { $homeDir = [System.IO.Path]::GetTempPath() }
    $dir = Join-Path $homeDir '.pdf-kosei-ps'
    if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

function Get-KoseiSubDir {
    param([Parameter(Mandatory=$true)][string]$Name)
    $dir = Join-Path (Get-KoseiDataDir) $Name
    if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

# 起動のたびに書く実行時ファイル（URL・起動ログ）は、アプリのフォルダではなく利用者ごとの場所に置く。
# アプリのフォルダは共有フォルダから写したもので、人ごと・版ごとに別の場所になりうる（「送る」側と起動側で食い違わないよう、ここで一か所に決める）。
function Get-KoseiLocalAppUrlPath { return (Join-Path (Get-KoseiSubDir 'runtime') 'local-app.url') }
function Get-KoseiStartupLogPath { return (Join-Path (Get-KoseiSubDir 'logs') 'startup-log.txt') }

function New-KoseiSafeFileName {
    param([Parameter(Mandatory=$true)][string]$FileName)
    $name = [System.IO.Path]::GetFileName($FileName)
    foreach ($ch in [System.IO.Path]::GetInvalidFileNameChars()) {
        $name = $name.Replace([string]$ch, '_')
    }
    if ([string]::IsNullOrWhiteSpace($name)) { $name = 'file' }
    return $name
}

# ワーカー番号。並列実行時、どのワーカーの行かが分からないとログは読めない。
# runspace ごとに Paths.ps1 を dot-source するので、これは runspace ローカルになる。
$script:KoseiWorkerIndex = -1
function Set-KoseiWorkerIndex { param([int]$Index) $script:KoseiWorkerIndex = $Index }
function Get-KoseiWorkerIndex { return [int]$script:KoseiWorkerIndex }

# ⚠️ **`$script:` のロックでは同期にならない。**
#    ワーカーは runspace ごとに Paths.ps1 を dot-source するので、`$script:` の
#    ロックオブジェクトは runspace ごとに別インスタンスになり、Monitor は素通りする。
#    プロセス内の複数 runspace をまたぐには**名前付き Mutex** が要る。
#    ログの取りこぼしは静かに起きる（Add-Content の例外は下の catch に飲まれる）ので、
#    「並列にしたら肝心の行だけ消えていた」を防ぐためにここは必ず直列化する。
$script:KoseiLogMutex = $null
function Get-KoseiLogMutex {
    if ($null -eq $script:KoseiLogMutex) {
        # Local\ はセッション内で一意。Global\ は権限が要るので使わない。
        $script:KoseiLogMutex = New-Object System.Threading.Mutex($false, 'Local\PdfKoseiAssist.Log')
    }
    return $script:KoseiLogMutex
}

function Write-KoseiLog {
    param(
        [Parameter(Mandatory=$true)][string]$Message,
        [string]$Level = 'INFO'
    )
    if (@('DEBUG','INFO','WARN','ERROR') -notcontains $Level) { $Level = 'INFO' }
    try {
        $dir = Get-KoseiSubDir 'logs'
        $path = Join-Path $dir 'pdf-kosei.log'
        $safeMessage=([string]$Message -replace '[\r\n]+',' ')
        if($safeMessage.Length -gt 460){$safeMessage=$safeMessage.Substring(0,460)+'…（詳細は runtime\answers を参照）'}
        $worker = ''
        if ($script:KoseiWorkerIndex -ge 0) { $worker = ('worker=' + [string]$script:KoseiWorkerIndex + ' ') }
        $line = '{0} [{1}] {2}{3}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'), $Level, $worker, $safeMessage
        $mutex = Get-KoseiLogMutex
        $held = $false
        try {
            # 取れなくても捨てない。待って書く（ログの欠落のほうが困る）。
            try { $held = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
            Add-Content -LiteralPath $path -Value $line -Encoding UTF8
        } finally {
            if ($held) { try { $null = $mutex.ReleaseMutex() } catch {} }
        }
    } catch {}
}

# Server.ps1 はこの後に読み込まれる。実行時HTMLポリシーは同名コマンドの
# script-scope alias を登録し、配信直前の index.html だけを安全に調整する。
. (Join-Path $PSScriptRoot 'RuntimeHtmlPolicy.ps1')

# Copilot回答取得と中止済み結果の破棄契約も、全worker runspaceへ同じように適用する。
. (Join-Path $PSScriptRoot 'RuntimeReviewFixes.ps1')


function Get-KoseiAppVersion {
    param([string]$Root = (Get-KoseiRoot))
    try {
        $value = [IO.File]::ReadAllText((Join-Path $Root 'VERSION'), [Text.Encoding]::UTF8).Trim()
        if ($value -notmatch '^\d+\.\d+(?:\.\d+)?$') { throw 'Invalid VERSION' }
        return $value
    } catch {
        Write-KoseiLog 'VERSION could not be read; using 0.0' 'WARN'
        return '0.0'
    }
}

function Get-KoseiLifecycleLogHeading {
    param([Parameter(Mandatory=$true)][string]$Phase, [string]$Root = (Get-KoseiRoot))
    # 起動/終了の見出しはアプリの版(VERSION)を出す。プロンプトの版とは別物。
    return ('=== PDF校正アシスト v' + (Get-KoseiAppVersion -Root $Root) + ' ' + $Phase + ' ===')
}
