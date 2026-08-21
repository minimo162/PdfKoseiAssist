param()

# Test-CopilotSession.ps1 — launch-owned CDP target selection regression
#
# This test does not launch Edge.  It feeds the actual selector two mocked
# Copilot targets (old first, launch-owned second) plus the local app target and
# verifies descriptor validation/fallback behavior.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$originalDataDir = [Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')
$originalLaunchId = [Environment]::GetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID')
$testDataDir = Join-Path ([System.IO.Path]::GetTempPath()) ('kosei-session-' + [guid]::NewGuid().ToString('N'))
$srcDir = Join-Path $root 'src'
$script:fail = 0

function Assert-True {
    param([string]$Name, [bool]$Condition)
    if ($Condition) { Write-Host "  ok   $Name" -ForegroundColor Green }
    else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:fail++ }
}

try {
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR', $testDataDir)
    $currentLaunchId = ('a' * 32)
    $otherLaunchId = ('b' * 32)
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID', $currentLaunchId)
    . (Join-Path $srcDir 'Paths.ps1')
    Set-KoseiRoot -Root $root
    . (Join-Path $srcDir 'Settings.ps1')
    . (Join-Path $srcDir 'CopilotClient.ps1')

    $settings = [pscustomobject]@{
        cdp_port = 9444
        copilot_url = 'https://m365.cloud.microsoft/chat/'
        browser_display_mode = 'foreground'
    }
    $old = [pscustomobject]@{
        id = 'old-dedicated-target'; type = 'page';
        url = 'https://m365.cloud.microsoft/chat/';
        webSocketDebuggerUrl = 'ws://127.0.0.1:9444/devtools/page/old'
    }
    $owned = [pscustomobject]@{
        id = 'launch-owned-target'; type = 'page';
        url = 'https://m365.cloud.microsoft/chat/';
        webSocketDebuggerUrl = 'ws://127.0.0.1:9444/devtools/page/owned'
    }
    $local = [pscustomobject]@{
        id = 'local-app-target'; type = 'page';
        url = 'http://127.0.0.1:8098/';
        webSocketDebuggerUrl = 'ws://127.0.0.1:9444/devtools/page/local'
    }
    $targets = @($old, $owned, $local)

    $descriptor = [pscustomobject]@{
        schema = 'kosei-copilot-session-v1'; launch_id = $currentLaunchId
        target_id = 'launch-owned-target'; cdp_port = 9444
        created_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    for ($i = 0; $i -lt 10; $i++) {
        $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets -SessionDescriptor $descriptor
        Assert-True "old first / launch-owned second selects launch target ($i)" ([string]$picked.id -eq 'launch-owned-target')
    }

    $null = Write-KoseiCopilotSessionDescriptor -Settings $settings -TargetId 'launch-owned-target' -LaunchId $currentLaunchId
    $read = Get-KoseiCopilotSessionDescriptor -Settings $settings
    Assert-True 'persisted descriptor is readable and points to target' ($null -ne $read -and [string]$read.target_id -eq 'launch-owned-target')
    Assert-True 'descriptor is nonsecret launch metadata only' ((Get-Content -Raw -LiteralPath (Get-KoseiCopilotSessionPath)) -notmatch 'password|token|cookie|secret')
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets
    Assert-True 'persisted descriptor selects exact launch target' ([string]$picked.id -eq 'launch-owned-target')

    $sessionPath = Get-KoseiCopilotSessionPath
    [System.IO.File]::WriteAllText($sessionPath, '{not-json', (New-Object System.Text.UTF8Encoding($false)))
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets
    Assert-True 'current launch with corrupt descriptor selects no target' ($null -eq $picked)

    [System.IO.File]::WriteAllText($sessionPath, (@{
        schema='kosei-copilot-session-v1'; launch_id=$currentLaunchId; target_id='launch-owned-target'; cdp_port=9444
        created_at_utc = (Get-Date).ToUniversalTime().AddDays(-2).ToString('o')
    } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets
    Assert-True 'current launch with stale descriptor selects no target' ($null -eq $picked)

    [System.IO.File]::WriteAllText($sessionPath, (@{
        schema='kosei-copilot-session-v1'; launch_id=$otherLaunchId; target_id='launch-owned-target'; cdp_port=9444
        created_at_utc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets
    Assert-True 'current launch with mismatched descriptor selects no target' ($null -eq $picked)

    Remove-Item -LiteralPath $sessionPath -Force
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets @($old, $local)
    Assert-True 'current launch with missing descriptor selects no old or local target' ($null -eq $picked)

    [System.IO.File]::WriteAllText($sessionPath, (@{
        schema='kosei-copilot-session-v1'; launch_id=$currentLaunchId; target_id='missing-target'; cdp_port=9444
        created_at_utc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets @($old, $local)
    Assert-True 'current launch with vanished target selects no old or local target' ($null -eq $picked)

    # Simulate the factored repair path: replacement creation writes a fresh
    # descriptor with the current launch ID, after which exact selection works.
    $null = Write-KoseiCopilotSessionDescriptor -Settings $settings -TargetId 'launch-owned-target' -LaunchId $currentLaunchId
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets
    Assert-True 'current launch replacement descriptor selects the owned target' ([string]$picked.id -eq 'launch-owned-target')

    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets @($local)
    Assert-True 'current launch local-only target set has no selectable page' ($null -eq $picked)

    # Callers without a current launch ID retain the safe legacy discovery
    # behavior: a valid Copilot target may be selected, never the local app.
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID', $null)
    $blank = [pscustomobject]@{
        id = 'descriptor-blank-target'; type = 'page';
        url = 'about:blank';
        webSocketDebuggerUrl = 'ws://127.0.0.1:9444/devtools/page/blank'
    }
    $unrelated = [pscustomobject]@{
        id = 'descriptor-unrelated-target'; type = 'page';
        url = 'https://example.com/';
        webSocketDebuggerUrl = 'ws://127.0.0.1:9444/devtools/page/unrelated'
    }
    $legacyDescriptor = [pscustomobject]@{
        schema = 'kosei-copilot-session-v1'; launch_id = $otherLaunchId
        target_id = 'descriptor-blank-target'; cdp_port = 9444
        created_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets @($blank, $old, $local) -SessionDescriptor $legacyDescriptor
    Assert-True 'legacy valid descriptor for about:blank does not outrank Copilot' ([string]$picked.id -eq 'old-dedicated-target')

    $legacyDescriptor.target_id = 'descriptor-unrelated-target'
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets @($unrelated, $old, $local) -SessionDescriptor $legacyDescriptor
    Assert-True 'legacy valid descriptor for unrelated HTTPS does not outrank Copilot' ([string]$picked.id -eq 'old-dedicated-target')

    [System.IO.File]::WriteAllText($sessionPath, '{not-json', (New-Object System.Text.UTF8Encoding($false)))
    $picked = Select-KoseiCopilotTarget -Settings $settings -Targets $targets
    Assert-True 'legacy caller safely falls back to old Copilot, never local app' ([string]$picked.id -eq 'old-dedicated-target')

    $startText = [System.IO.File]::ReadAllText((Join-Path $root 'Start-KoseiAssist.ps1'), [Text.Encoding]::UTF8)
    $noWarmupBlock = [regex]::Match($startText, '(?s)if \(\$NoWarmup\) \{(.*?)\n\}')
    Assert-True '-NoWarmup block does not launch a fresh Copilot target' ($noWarmupBlock.Success -and $noWarmupBlock.Groups[1].Value -notmatch 'FreshLaunchTarget')
} finally {
    if (Test-Path -LiteralPath $testDataDir) { Remove-Item -LiteralPath $testDataDir -Recurse -Force -ErrorAction SilentlyContinue }
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR', $originalDataDir)
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID', $originalLaunchId)
}

if ($script:fail -gt 0) { Write-Host "Test-CopilotSession: FAIL ($script:fail)" -ForegroundColor Red; exit 1 }
Write-Host 'Test-CopilotSession: PASS' -ForegroundColor Green
exit 0
