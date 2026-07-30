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
        $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'), $Level, $safeMessage
        Add-Content -LiteralPath $path -Value $line -Encoding UTF8
    } catch {}
}
