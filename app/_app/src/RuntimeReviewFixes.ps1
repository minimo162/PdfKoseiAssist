# =====================================================================
# RuntimeReviewFixes.ps1 — Copilot回答取得と中止後終了の実行時修正
#
# Paths.ps1 から CopilotClient / ReviewJob / Server より先に読み込まれる。
# PowerShell の Alias が Function より優先されることを利用し、巨大な既存ファイルを
# 複製せず、狭い修正だけを全 runspace へ適用する。
# =====================================================================

function Get-KoseiRuntimeStateValue {
    param($State, [Parameter(Mandatory=$true)][string]$Name)
    if ($null -eq $State) { return $null }
    if ($State -is [System.Collections.IDictionary]) { return $State[$Name] }
    $property = $State.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Set-KoseiRuntimeStateValue {
    param($State, [Parameter(Mandatory=$true)][string]$Name, $Value)
    if ($null -eq $State) { return }
    if ($State -is [System.Collections.IDictionary]) {
        $State[$Name] = $Value
        return
    }
    $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Test-KoseiRuntimeCheckpointReady {
    param($State)
    if ($null -eq $State) { return $false }
    $hasMarker = $false
    if ($State -is [System.Collections.IDictionary]) {
        $hasMarker = $State.Contains('recovery_checkpoint_ready')
    } else {
        $hasMarker = $null -ne $State.PSObject.Properties['recovery_checkpoint_ready']
    }
    if ($hasMarker) { return [bool](Get-KoseiRuntimeStateValue -State $State -Name 'recovery_checkpoint_ready') }
    return [bool](Get-KoseiRuntimeStateValue -State $State -Name 'result_retained')
}

function Get-KoseiRuntimeChainId {
    param($State)
    $value = [string](Get-KoseiRuntimeStateValue -State $State -Name 'recovery_chain_id')
    if ($value -notmatch '^[0-9a-fA-F]{32}$') { return '' }
    return $value.ToLowerInvariant()
}

function Get-KoseiLatestResponseTextRuntime {
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

  // セレクターごとに「最初に見つかったもの」を返すと、旧DOMに残った前回答が
  // 新しい回答より優先される。全セレクターを一度に検索してDOM順に並べ、
  // 後ろから最初の中身付き要素を採用する。
  const allNodes = [...document.querySelectorAll(selectors.join(','))];
  // 同じ回答の外側コンテナと内側要素が両方selectorへ一致する場合、内側の断片を
  // 「より新しい回答」と誤認しない。包含関係の最外側だけを候補にする。
  const rootNodes = allNodes.filter(node =>
    !allNodes.some(other => other !== node && typeof other.contains === 'function' && other.contains(node))
  );
  const nodes = rootNodes.length ? rootNodes : allNodes;
  let skippedEmpty = 0;
  for (let k = nodes.length - 1; k >= 0; k--) {
    const node = nodes[k];
    const rendered = (node.innerText || '').trim();
    const text = rendered || (node.textContent || '').trim();
    if (!text) {
      skippedEmpty++;
      continue;
    }

    let selectorIndex = 0;
    for (let i = 0; i < selectors.length; i++) {
      try {
        if (node.matches(selectors[i])) {
          selectorIndex = i + 1;
          break;
        }
      } catch (_) {}
    }
    const domKey =
      node.getAttribute('data-message-id') ||
      node.getAttribute('id') ||
      node.getAttribute('data-testid') ||
      '';

    return JSON.stringify({
      text,
      selectorIndex,
      fallback: rendered ? '' : 'textContent',
      skippedEmpty,
      candidateCount: nodes.length,
      rawCandidateCount: allNodes.length,
      assistantDomKey: domKey
    });
  }

  return JSON.stringify({
    text: '',
    selectorIndex: 0,
    fallback: '',
    skippedEmpty,
    candidateCount: nodes.length,
    rawCandidateCount: allNodes.length,
    assistantDomKey: ''
  });
})()
'@
    $result = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    if ($null -eq $result) {
        return [pscustomobject]@{ text=''; selectorIndex=0; fallback=''; skippedEmpty=0; candidateCount=0; assistantDomKey='' }
    }
    try {
        return ($result | ConvertFrom-Json)
    } catch {
        Write-KoseiLog ('最新応答snapshotのJSON解析に失敗しました: ' + $_.Exception.Message) 'WARN'
        return [pscustomobject]@{ text=''; selectorIndex=0; fallback=''; skippedEmpty=0; candidateCount=0; assistantDomKey='' }
    }
}

function Stop-KoseiJobRuntime {
    param([Parameter(Mandatory=$true)][string]$JobId, [string]$JobsRoot = '')
    $state = $script:KoseiJobs[$JobId]
    if ($null -eq $state) { throw "ジョブが見つかりません: $JobId" }

    Set-KoseiRuntimeStateValue -State $state -Name 'cancel_requested' -Value $true
    Set-KoseiRuntimeStateValue -State $state -Name 'cancel_discard_requested' -Value $true
    Set-KoseiRuntimeStateValue -State $state -Name 'shutdown_discard_approved' -Value $false
    Set-KoseiRuntimeStateValue -State $state -Name 'phase' -Value 'cancelling'
    Set-KoseiRuntimeStateValue -State $state -Name 'updated_at' -Value (Get-Date).ToString('s')

    foreach ($packet in @((Get-KoseiRuntimeStateValue -State $state -Name 'per_packet'))) {
        $status = [string](Get-KoseiRuntimeStateValue -State $packet -Name 'status')
        if (@('queued','running','paused','needs_user_visibility') -contains $status) {
            Set-KoseiRuntimeStateValue -State $packet -Name 'detail' -Value '校正を中止しています。停止後は未取り込み結果を破棄して終了できます。'
        }
    }

    Write-KoseiJobJournal -State $state -JobsRoot $JobsRoot
    Write-KoseiLog ("ジョブ中止要求（結果は保持しない） job=" + $JobId) 'INFO'
    return $true
}

function Complete-KoseiCancelledResultDiscardRuntime {
    param([Parameter(Mandatory=$true)]$State)

    $mode = [string](Get-KoseiRuntimeStateValue -State $State -Name 'mode')
    $cancelRequested = [bool](Get-KoseiRuntimeStateValue -State $State -Name 'cancel_requested')
    $alreadyApproved = [bool](Get-KoseiRuntimeStateValue -State $State -Name 'shutdown_discard_approved')
    $retained = [bool](Get-KoseiRuntimeStateValue -State $State -Name 'result_retained')
    if ($alreadyApproved -and -not $retained) { return $true }
    if ($mode -ne 'cancelled' -or -not $cancelRequested -or -not (Test-KoseiRuntimeCheckpointReady -State $State)) {
        return $false
    }

    $stateId = [string](Get-KoseiRuntimeStateValue -State $State -Name 'id')
    $chainId = Get-KoseiRuntimeChainId -State $State
    $members = @($State)
    if ($chainId) {
        $members = @($script:KoseiJobs.Values | Where-Object {
            (Get-KoseiRuntimeChainId -State $_) -eq $chainId
        })
        if (-not @($members | Where-Object { [string](Get-KoseiRuntimeStateValue -State $_ -Name 'id') -eq $stateId }).Count) {
            $members += $State
        }
    }

    # 同じretry chainに別の実行中ジョブがある間は破棄しない。
    $otherActive = @($members | Where-Object {
        [string](Get-KoseiRuntimeStateValue -State $_ -Name 'id') -ne $stateId -and
        @('queued','running') -contains [string](Get-KoseiRuntimeStateValue -State $_ -Name 'mode')
    })
    if ($otherActive.Count) { return $false }

    foreach ($member in @($members)) {
        $memberId = [string](Get-KoseiRuntimeStateValue -State $member -Name 'id')
        $memberMode = [string](Get-KoseiRuntimeStateValue -State $member -Name 'mode')
        if (@('done','error','cancelled','needs_user_visibility') -notcontains $memberMode) { continue }

        $wasRetained = [bool](Get-KoseiRuntimeStateValue -State $member -Name 'result_retained')
        Set-KoseiRuntimeStateValue -State $member -Name 'recovery_acknowledged' -Value $true
        Set-KoseiRuntimeStateValue -State $member -Name 'result_retained' -Value $false
        Set-KoseiRuntimeStateValue -State $member -Name 'recovery_checkpoint_ready' -Value $true
        Set-KoseiRuntimeStateValue -State $member -Name 'recovery_expires_at' -Value ''
        Set-KoseiRuntimeStateValue -State $member -Name 'updated_at' -Value (Get-Date).ToString('s')
        if ($memberId -eq $stateId) {
            Set-KoseiRuntimeStateValue -State $member -Name 'shutdown_discard_approved' -Value $true
        }

        try { Write-KoseiJobJournal -State $member } catch {}
        if ($wasRetained -and (Get-Command Remove-KoseiRetainedJobArtifacts -ErrorAction SilentlyContinue)) {
            try { Remove-KoseiRetainedJobArtifacts -State $member -Settings $null } catch {
                try { Write-KoseiLog ("中止済み結果の破棄に失敗 job=" + $memberId + ': ' + $_.Exception.Message) 'WARN' } catch {}
            }
        }
        foreach ($packet in @((Get-KoseiRuntimeStateValue -State $member -Name 'per_packet'))) {
            Set-KoseiRuntimeStateValue -State $packet -Name 'raw_answer' -Value ''
            Set-KoseiRuntimeStateValue -State $packet -Name 'passes' -Value @()
            Set-KoseiRuntimeStateValue -State $packet -Name 'result_path' -Value ''
            Set-KoseiRuntimeStateValue -State $packet -Name 'result_sha256' -Value ''
            Set-KoseiRuntimeStateValue -State $packet -Name 'findings_count' -Value 0
        }

        # 終了要求の本人確認に使う最新の中止状態だけはメモリに残す。
        if ($memberId -ne $stateId) {
            try { $script:KoseiJobs.Remove($memberId) } catch {}
        }
    }

    if ([string]$script:KoseiActiveJobId -eq $stateId) { $script:KoseiActiveJobId = $null }
    if ($chainId) {
        $recoverable = $script:KoseiRecoverableJobId
        if ($recoverable) {
            $recoverableState = $script:KoseiJobs[[string]$recoverable]
            if ($null -eq $recoverableState -or (Get-KoseiRuntimeChainId -State $recoverableState) -eq $chainId) {
                $script:KoseiRecoverableJobId = $null
            }
        }
        if ($script:KoseiPendingRecovery -and (Get-KoseiRuntimeChainId -State $script:KoseiPendingRecovery) -eq $chainId) {
            $script:KoseiPendingRecovery = $null
        }
    } else {
        if ([string]$script:KoseiRecoverableJobId -eq $stateId) { $script:KoseiRecoverableJobId = $null }
        if ($script:KoseiPendingRecovery -and [string](Get-KoseiRuntimeStateValue -State $script:KoseiPendingRecovery -Name 'id') -eq $stateId) {
            $script:KoseiPendingRecovery = $null
        }
    }

    Write-KoseiLog ("中止済みジョブの再接続用結果を破棄しました job=" + $stateId) 'INFO'
    return $true
}

function Get-KoseiJobStateRuntime {
    param([Parameter(Mandatory=$true)][string]$JobId)
    # Lookup is pure; cleanup runs only at explicit acknowledgement/recovery boundaries.
    return $script:KoseiJobs[$JobId]
}

function Get-KoseiRecoverableJobStateRuntime {
    # 中止結果は利用者が明示的に捨てたものなので、正常終了・エラー結果の
    # 再接続候補に混ぜない。checkpoint確立後ならここで安全に破棄する。
    foreach ($state in @($script:KoseiJobs.Values)) {
        $mode = [string](Get-KoseiRuntimeStateValue -State $state -Name 'mode')
        $cancelRequested = [bool](Get-KoseiRuntimeStateValue -State $state -Name 'cancel_requested')
        if ($mode -eq 'cancelled' -or $cancelRequested) {
            $null = Complete-KoseiCancelledResultDiscardRuntime -State $state
        }
    }
    if ($script:KoseiPendingRecovery) {
        $pendingMode = [string](Get-KoseiRuntimeStateValue -State $script:KoseiPendingRecovery -Name 'mode')
        $pendingCancelled = [bool](Get-KoseiRuntimeStateValue -State $script:KoseiPendingRecovery -Name 'cancel_requested')
        if ($pendingMode -eq 'cancelled' -or $pendingCancelled) {
            $null = Complete-KoseiCancelledResultDiscardRuntime -State $script:KoseiPendingRecovery
        }
    }

    # ReviewJob.ps1 が定義した基準関数を、Aliasを経由せず Function provider から呼ぶ。
    # 正常終了・エラー時の既存のchain選択／保持期限契約はそのまま利用する。
    $original = Get-Command -Name Get-KoseiRecoverableJobState -CommandType Function -ErrorAction SilentlyContinue
    if ($null -eq $original) { return $null }
    $originalResult = & $original.ScriptBlock
    return $originalResult
}

function Acknowledge-KoseiCancelledShutdownCheckpointRuntime {
    param([Parameter(Mandatory=$true)][string]$JobId, [string]$ChainId = '')

    # cancel API は即時応答する一方、worker の停止と最終checkpoint確立には少し時間が
    # かかる。従来はここが一度409になると、終了時に保持結果だけが残った。
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $state = $script:KoseiJobs[$JobId]
        if ($null -eq $state) { return $false }

        $approved = [bool](Get-KoseiRuntimeStateValue -State $state -Name 'shutdown_discard_approved')
        $retained = [bool](Get-KoseiRuntimeStateValue -State $state -Name 'result_retained')
        if ($approved -and -not $retained) { return $true }

        if (-not [bool](Get-KoseiRuntimeStateValue -State $state -Name 'cancel_requested')) { return $false }
        $mode = [string](Get-KoseiRuntimeStateValue -State $state -Name 'mode')
        if ($mode -eq 'cancelled' -and (Test-KoseiRuntimeCheckpointReady -State $state)) {
            $stateChain = Get-KoseiRuntimeChainId -State $state
            $provided = [string]$ChainId
            if ($stateChain) {
                if ([string]::IsNullOrWhiteSpace($provided) -or $provided.ToLowerInvariant() -ne $stateChain) { return $false }
            } elseif (-not [string]::IsNullOrWhiteSpace($provided)) {
                return $false
            }
            return (Complete-KoseiCancelledResultDiscardRuntime -State $state)
        }
        if (@('done','error','needs_user_visibility') -contains $mode) { return $false }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Add-KoseiCancelUxScriptRuntime {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Html)
    if ([string]::IsNullOrEmpty($Html)) { return $Html }
    $sourceMarker = 'const { PDFDocument, rgb, degrees } = PDFLib;'
    $scriptPath = '/js/cancel-review-ux.js?v=77'
    if ($Html.IndexOf($sourceMarker, [System.StringComparison]::Ordinal) -lt 0 -or
        $Html.IndexOf($scriptPath, [System.StringComparison]::Ordinal) -ge 0) {
        return $Html
    }

    $tag = '<script src="' + $scriptPath + '"></script>'
    $bodyIndex = $Html.LastIndexOf('</body>', [System.StringComparison]::OrdinalIgnoreCase)
    if ($bodyIndex -ge 0) {
        return $Html.Insert($bodyIndex, $tag)
    }
    return $Html + $tag
}

function Send-KoseiReviewRuntimeBytes {
    param($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Body)

    if ($null -eq $Body) { $Body = New-Object byte[] 0 }
    $isHtml = (-not [string]::IsNullOrWhiteSpace($ContentType)) -and
        $ContentType.StartsWith('text/html', [System.StringComparison]::OrdinalIgnoreCase)
    if ($Body.Length -gt 0 -and $isHtml) {
        try {
            $html = [System.Text.Encoding]::UTF8.GetString($Body)
            $patched = Add-KoseiCancelUxScriptRuntime -Html $html
            if (-not [string]::Equals($patched, $html, [System.StringComparison]::Ordinal)) {
                $Body = [System.Text.Encoding]::UTF8.GetBytes($patched)
            }
        } catch {
            try { Write-KoseiLog ('中止UIスクリプトの注入に失敗しました: ' + $_.Exception.Message) 'WARN' } catch {}
        }
    }

    $runtimeSender = Get-Command -Name Send-KoseiRuntimeBytes -CommandType Function -ErrorAction SilentlyContinue
    if ($null -ne $runtimeSender) {
        Send-KoseiRuntimeBytes -Response $Response -StatusCode $StatusCode -ContentType $ContentType -Body $Body
        return
    }

    # RuntimeHtmlPolicyを単体で読み込まない検査環境向けの安全なフォールバック。
    try {
        $Response.StatusCode = $StatusCode
        $Response.ContentType = $ContentType
        $Response.Headers['Cache-Control'] = 'no-store'
        $Response.Headers['X-Content-Type-Options'] = 'nosniff'
        $Response.ContentLength64 = $Body.Length
        if ($Body.Length -gt 0) { $Response.OutputStream.Write($Body, 0, $Body.Length) }
    } finally {
        try { $Response.OutputStream.Close() } catch {}
    }
}

# 基準関数はこの後に定義されるが、AliasはFunctionより優先される。
Set-Alias -Name Get-KoseiLatestResponseText -Value Get-KoseiLatestResponseTextRuntime -Scope Script -Force
Set-Alias -Name Stop-KoseiJob -Value Stop-KoseiJobRuntime -Scope Script -Force
Set-Alias -Name Get-KoseiJobState -Value Get-KoseiJobStateRuntime -Scope Script -Force
Set-Alias -Name Get-KoseiRecoverableJobState -Value Get-KoseiRecoverableJobStateRuntime -Scope Script -Force
Set-Alias -Name Acknowledge-KoseiCancelledShutdownCheckpoint -Value Acknowledge-KoseiCancelledShutdownCheckpointRuntime -Scope Script -Force
Set-Alias -Name Send-KoseiBytes -Value Send-KoseiReviewRuntimeBytes -Scope Script -Force
