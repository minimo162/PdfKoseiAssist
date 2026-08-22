# =====================================================================
# RuntimeHtmlPolicy.ps1 — 配信する index.html へ狭い実行時ポリシーを適用する
#
# index.html は大きな単一ファイルで、確認用PDFの検証ロジックも同居している。
# 配信直前に、config/runtime-html-policy.json で明示した完全一致箇所だけを
# all-or-nothing で置換する。元ファイルとポリシーがずれた場合は部分適用せず、
# 元のHTMLをそのまま返してログへ理由を残す。
# =====================================================================

# StrictMode 下でも初回参照できるよう明示的に初期化する。$PSScriptRoot は
# dot-source された時点のこのファイルを指すため、関数実行時に再評価しない。
$script:KoseiRuntimeHtmlPolicy = $null
$script:KoseiRuntimeHtmlPolicyPath = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'config') 'runtime-html-policy.json'

function Write-KoseiRuntimePolicyLog {
    param([Parameter(Mandatory=$true)][string]$Message, [string]$Level = 'WARN')
    $logger = Get-Command -Name Write-KoseiLog -ErrorAction SilentlyContinue
    if ($null -ne $logger) {
        Write-KoseiLog $Message $Level
        return
    }
    try { [Console]::Error.WriteLine($Message) } catch {}
}

function Get-KoseiRuntimeHtmlPolicy {
    if ($null -ne $script:KoseiRuntimeHtmlPolicy) { return $script:KoseiRuntimeHtmlPolicy }

    $policyPath = $script:KoseiRuntimeHtmlPolicyPath
    if (!(Test-Path -LiteralPath $policyPath -PathType Leaf)) {
        throw ('実行時HTMLポリシーが見つかりません: ' + $policyPath)
    }

    $raw = [System.IO.File]::ReadAllText($policyPath, [System.Text.Encoding]::UTF8)
    $policy = $raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$policy.source_marker)) {
        throw '実行時HTMLポリシーに source_marker がありません。'
    }
    if (@($policy.replacements).Count -eq 0) {
        throw '実行時HTMLポリシーに replacements がありません。'
    }

    $script:KoseiRuntimeHtmlPolicy = $policy
    return $script:KoseiRuntimeHtmlPolicy
}

function Get-KoseiLiteralMatchCount {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Needle
    )
    if ([string]::IsNullOrEmpty($Needle) -or $Text.Length -lt $Needle.Length) { return 0 }

    $count = 0
    $offset = 0
    while ($offset -le ($Text.Length - $Needle.Length)) {
        $index = $Text.IndexOf($Needle, $offset, [System.StringComparison]::Ordinal)
        if ($index -lt 0) { break }
        $count++
        $offset = $index + $Needle.Length
    }
    return $count
}

function Convert-KoseiIndexHtmlForRuntime {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Html,
        [switch]$Silent
    )
    if ([string]::IsNullOrEmpty($Html)) { return $Html }

    try {
        $policy = Get-KoseiRuntimeHtmlPolicy
    } catch {
        if (-not $Silent) { Write-KoseiRuntimePolicyLog ('実行時HTMLポリシーを読み込めません: ' + $_.Exception.Message) 'ERROR' }
        return $Html
    }

    $marker = [string]$policy.source_marker
    if ($Html.IndexOf($marker, [System.StringComparison]::Ordinal) -lt 0) {
        # レポート等、index.html 以外のHTMLは無変更で返す。
        return $Html
    }

    $normalized = $Html.Replace("`r`n", "`n").Replace("`r", "`n")
    $replacements = @($policy.replacements)
    foreach ($replacement in $replacements) {
        $name = [string]$replacement.name
        $oldText = [string]$replacement.old
        $count = Get-KoseiLiteralMatchCount -Text $normalized -Needle $oldText
        if ([string]::IsNullOrEmpty($oldText) -or $count -ne 1) {
            if (-not $Silent) {
                Write-KoseiRuntimePolicyLog ("実行時HTMLポリシーを適用しませんでした: {0} の一致数が {1} です（期待値1）。" -f $name, $count) 'ERROR'
            }
            return $Html
        }
    }

    $patched = $normalized
    foreach ($replacement in $replacements) {
        $patched = $patched.Replace([string]$replacement.old, [string]$replacement.new)
    }
    return $patched
}

function Send-KoseiRuntimeBytes {
    param($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Body)
    try {
        if ($null -eq $Body) { $Body = New-Object byte[] 0 }

        $isHtml = (-not [string]::IsNullOrWhiteSpace($ContentType)) -and $ContentType.StartsWith('text/html', [System.StringComparison]::OrdinalIgnoreCase)
        if ($Body.Length -gt 0 -and $isHtml) {
            try {
                $html = [System.Text.Encoding]::UTF8.GetString($Body)
                $patched = Convert-KoseiIndexHtmlForRuntime -Html $html
                if (-not [string]::Equals($patched, $html, [System.StringComparison]::Ordinal)) {
                    $Body = [System.Text.Encoding]::UTF8.GetBytes($patched)
                }
            } catch {
                # ポリシー適用の失敗で静的配信まで壊さない。元バイト列を返す。
                Write-KoseiRuntimePolicyLog ('実行時HTMLポリシーの適用に失敗しました: ' + $_.Exception.Message) 'ERROR'
            }
        }

        $Response.StatusCode = $StatusCode
        $Response.ContentType = $ContentType
        $Response.Headers['Cache-Control'] = 'no-store'
        $Response.Headers['X-Content-Type-Options'] = 'nosniff'
        $Response.ContentLength64 = $Body.Length
        if ($Body.Length -gt 0) { $Response.OutputStream.Write($Body, 0, $Body.Length) }
    } catch {
        Write-KoseiRuntimePolicyLog ('応答送信エラー: ' + $_.Exception.Message) 'WARN'
    } finally {
        try { $Response.OutputStream.Close() } catch {}
    }
}

# Server.ps1 は後から同名の基準関数を定義する。PowerShellでは Alias が Function
# より優先されるため、同じスクリプトスコープのAliasで実行時ポリシー版へ固定する。
Set-Alias -Name Send-KoseiBytes -Value Send-KoseiRuntimeBytes -Scope Script -Force
