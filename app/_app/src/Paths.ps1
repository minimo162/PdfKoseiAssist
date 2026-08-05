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
    $homeDir = [Environment]::GetFolderPath('UserProfile')
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
