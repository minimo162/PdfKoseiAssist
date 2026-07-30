# =====================================================================
# ReviewJob.ps1 — 校正ジョブ（runspace非同期・直列パケット処理）
#
# 1ジョブ = 1〜Nパケット。同時実行は1ジョブのみ。
# 進捗は [hashtable]::Synchronized の共有stateでUIポーリングへ返す。
# 失敗パケットはフォールバックせず原因付きで記録する（v92/v93方針）。
# =====================================================================

if (-not $script:KoseiJobs) { $script:KoseiJobs = [hashtable]::Synchronized(@{}) }
$script:KoseiActiveJobId = $null
$script:KoseiJobHandles = @{}

# 観点定義（§7.1/§9.1）。追撃プロンプトの label/detail に使う。index.html の REVIEW_LENSES と対応。
$script:KoseiReviewLenses = @{
    broad       = @{ label = '全体走査';       detail = '各観点の代表的な誤りを浅く広く確認します。' }
    spelling    = @{ label = '綴り・タイポ';   detail = 'typo、大文字小文字、重複語、欠落語、記号の誤用。' }
    grammar     = @{ label = '文法';           detail = '冠詞、時制、単複、前置詞、主述一致、句読点。' }
    numbers     = @{ label = '数値・日付';     detail = '金額、単位、通貨、%、桁区切り、符号、年月日、年度表記。' }
    names       = @{ label = '固有名詞';       detail = '社名、製品名、部門名、人名、略語、役職名の不整合。' }
    translation = @{ label = '訳抜け・誤訳';   detail = 'REFとの意味・否定・条件・範囲のずれ（REFがある場合のみ）。' }
    structure   = @{ label = '表・注記・構造'; detail = '表、注記、見出し、脚注、図表ラベル、相互参照、目次整合。' }
    gap         = @{ label = '見落とし探し';   detail = '既出一覧に無い指摘だけを探します。' }
}

function New-KoseiTurnMarker {
    # turnごとに一意なマーカー（§7.3）: KOSEI_END_<job短縮>_<packet>_<turn>_<random8>
    param([string]$JobId, [int]$PacketIndex, [int]$TurnIndex, [string]$BaseMarker = 'KOSEI_END')
    $job8 = if ([string]$JobId -and $JobId.Length -ge 8) { $JobId.Substring(0, 8) } else { [string]$JobId }
    $rand = [guid]::NewGuid().ToString('N').Substring(0, 8)
    return ('{0}_{1}_{2}_{3}_{4}' -f $BaseMarker, $job8, $PacketIndex, $TurnIndex, $rand)
}

function Get-KoseiPassSchedule {
    # js/pass-schedule.mjs と同一規則（Test-PassSchedule.mjs で検証済み）。
    param([string]$Profile = 'standard', [bool]$HasRef = $false, [bool]$GapPass = $true, [int]$MaxPasses = 8)
    $profiles = @{
        quick    = @('broad')
        standard = @('broad', 'numbers', 'names', 'gap')
        thorough = @('broad', 'spelling', 'grammar', 'numbers', 'names', 'translation', 'structure', 'gap')
    }
    $warnings = @(); $skipped = @()
    $base = $profiles[$Profile]
    if (-not $base) { $warnings += ("未知の profile '{0}' のため quick を使用" -f $Profile); $base = $profiles['quick'] }
    $lenses = @()
    foreach ($x in $base) {
        if ($x -eq 'gap') { continue }
        if ($x -eq 'translation' -and -not $HasRef) { $skipped += [pscustomobject]@{ lens = 'translation'; reason = 'no-ref' }; continue }
        $lenses += $x
    }
    if ($GapPass) { $lenses += 'gap' }
    $cap = if ($MaxPasses -gt 0) { $MaxPasses } else { $lenses.Count }
    $kept = $lenses
    if ($lenses.Count -gt $cap) {
        $kept = @($lenses[0..($cap - 1)])
        foreach ($x in @($lenses[$cap..($lenses.Count - 1)])) { $skipped += [pscustomobject]@{ lens = $x; reason = 'max-passes-exceeded' } }
        $warnings += ("pass数 {0} が上限 {1} を超過。{2} 件を skip" -f $lenses.Count, $cap, ($lenses.Count - $cap))
    }
    $passes = @()
    for ($i = 0; $i -lt $kept.Count; $i++) {
        $x = [string]$kept[$i]
        $kind = if ($i -eq 0) { 'broad' } elseif ($x -eq 'gap') { 'gap' } else { 'lens' }
        $passes += [pscustomobject]@{
            pass_index = $i
            kind       = $kind
            lens       = if ($kind -eq 'lens') { $x } else { $kind }
            chat_mode  = if ($i -eq 0) { 'New' } else { 'Reuse' }
            attach     = ($i -eq 0)
        }
    }
    return [pscustomobject]@{ passes = $passes; skipped = $skipped; warnings = $warnings }
}

function New-KoseiLensFollowupPrompt {
    # 観点1つに絞った追撃文（§7.2）。添付なし・Reuse turn で送る。
    param([Parameter(Mandatory=$true)][string]$Lens, [string]$PageRange = '', [Parameter(Mandatory=$true)][string]$Marker)
    $info = $script:KoseiReviewLenses[$Lens]
    $label = if ($info) { [string]$info.label } else { $Lens }
    $detail = if ($info) { [string]$info.detail } else { '' }
    return @"
同じ添付資料のまま、観点「$label」だけに絞って TARGET_CHECK 全ページ（P.$PageRange）を
もう一度、先頭ページから順に走査してください。

この観点で見るもの:
$detail

- 既出の指摘と重複して構いません。重複はアプリ側で除去します。
- 対象ページは全ページです。1ページも飛ばさないでください。
- 回答は指示書と同じJSON形式で出力してください。
- 回答JSONの直後の行に $Marker とだけ出力してください。
"@
}

function Get-KoseiActiveJobState {
    if ([string]::IsNullOrWhiteSpace([string]$script:KoseiActiveJobId)) { return $null }
    return $script:KoseiJobs[$script:KoseiActiveJobId]
}

function Test-KoseiJobRunning {
    param($State)
    if ($null -eq $State) { return $false }
    return (@('queued','running') -contains [string]$State.mode)
}

function Get-KoseiJobState {
    param([Parameter(Mandatory=$true)][string]$JobId)
    return $script:KoseiJobs[$JobId]
}

function Update-KoseiJobHandles {
    # 完了したrunspaceの後始末
    $done = @()
    foreach ($id in @($script:KoseiJobHandles.Keys)) {
        $h = $script:KoseiJobHandles[$id]
        if ($h -and $h.Async -and $h.Async.IsCompleted) {
            try { $null = $h.PowerShell.EndInvoke($h.Async) } catch {
                Write-KoseiLog ("ジョブrunspace終了時エラー job=" + $id + ": " + $_.Exception.Message) 'WARN'
            }
            try { $h.PowerShell.Dispose() } catch {}
            $done += $id
        }
    }
    foreach ($id in $done) { $script:KoseiJobHandles.Remove($id) }
}

function Stop-KoseiJob {
    param([Parameter(Mandatory=$true)][string]$JobId)
    $state = $script:KoseiJobs[$JobId]
    if ($null -eq $state) { throw "ジョブが見つかりません: $JobId" }
    $state.cancel_requested = $true
    $state.updated_at = (Get-Date).ToString('s')
    Write-KoseiLog ("ジョブ中止要求 job=" + $JobId) 'INFO'
    return $true
}

function ConvertTo-KoseiJobStatusObject {
    param([Parameter(Mandatory=$true)]$State)
    # 同期ハッシュをスナップショット化してJSON化可能なオブジェクトへ
    $perPacket = @()
    foreach ($p in @($State.per_packet)) {
        $perPacket += [ordered]@{
            packet_id      = [string]$p.packet_id
            status         = [string]$p.status
            phase          = [string]$p.phase
            detail         = [string]$p.detail
            error          = [string]$p.error
            completed_by   = [string]$p.completed_by
            elapsed_ms     = [int]$p.elapsed_ms
            total_elapsed_ms = [int]$p.total_elapsed_ms
            phase_timings  = $p.phase_timings
            started_at     = [string]$p.started_at
            completed_at   = [string]$p.completed_at
            findings_count = [int]$p.findings_count
            pages_checked  = @($p.pages_checked)
            coverage       = [double]$p.coverage
            warning        = [string]$p.warning
        }
    }
    return [ordered]@{
        id               = [string]$State.id
        mode             = [string]$State.mode
        phase            = [string]$State.phase
        attach_mode      = [string]$State.attach_mode
        packets_total    = [int]$State.packets_total
        packets_done     = [int]$State.packets_done
        current_packet   = [string]$State.current_packet
        error            = [string]$State.error
        cancel_requested = [bool]$State.cancel_requested
        created_at       = [string]$State.created_at
        updated_at       = [string]$State.updated_at
        per_packet       = $perPacket
    }
}

function Get-KoseiJobResultObject {
    param([Parameter(Mandatory=$true)]$State)
    $packets = @()
    foreach ($p in @($State.per_packet)) {
        $packets += [ordered]@{
            packet_id    = [string]$p.packet_id
            status       = [string]$p.status
            raw_answer   = [string]$p.raw_answer
            completed_by = [string]$p.completed_by
            error        = [string]$p.error
            total_elapsed_ms = [int]$p.total_elapsed_ms
            phase_timings = $p.phase_timings
            findings_count = [int]$p.findings_count
            pages_checked = @($p.pages_checked)
            coverage = [double]$p.coverage
            warning = [string]$p.warning
        }
    }
    return [ordered]@{ id = [string]$State.id; mode = [string]$State.mode; packets = $packets }
}

function Start-KoseiReviewJob {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        # Packets: @(@{ packet_id; prompt_path; pdf_path; text_path }) ファイルパスで受ける
        [Parameter(Mandatory=$true)][object[]]$Packets,
        [string]$AttachMode = ''
    )
    Update-KoseiJobHandles
    $active = Get-KoseiActiveJobState
    if (Test-KoseiJobRunning -State $active) { throw '別の校正ジョブが実行中です。完了または中止してから再実行してください。' }
    if (@($Packets).Count -eq 0) { throw 'パケットがありません。' }

    $mode = [string]$Settings.copilot_attach_mode
    if (-not [string]::IsNullOrWhiteSpace($AttachMode)) { $mode = $AttachMode }
    if (@('pdf','text') -notcontains $mode) { throw "attach_mode が不正です: $mode" }

    $jobId = ([guid]::NewGuid().ToString('N'))
    $perPacket = New-Object System.Collections.ArrayList
    foreach ($p in $Packets) {
        $null = $perPacket.Add([hashtable]::Synchronized(@{
            packet_id    = [string]$p.packet_id
            prompt_path  = [string]$p.prompt_path
            pdf_path     = [string]$p.pdf_path
            text_path    = [string]$p.text_path
            target_pages = @($p.target_pages)
            status       = 'queued'   # queued|running|done|error|cancelled
            phase        = ''
            error        = ''
            raw_answer   = ''
            completed_by = ''
            detail       = ''
            elapsed_ms   = 0
            total_elapsed_ms = 0
            phase_timings = $null
            started_at   = ''
            completed_at = ''
            findings_count = 0
            pages_checked = @()
            coverage = 0.0
            warning = ''
        }))
    }
    $state = [hashtable]::Synchronized(@{
        id               = $jobId
        mode             = 'queued'   # queued|running|done|error|cancelled
        phase            = ''
        attach_mode      = $mode
        packets_total    = @($Packets).Count
        packets_done     = 0
        current_packet   = ''
        error            = ''
        cancel_requested = $false
        created_at       = (Get-Date).ToString('s')
        updated_at       = (Get-Date).ToString('s')
        per_packet       = $perPacket
    })
    $script:KoseiJobs[$jobId] = $state
    $script:KoseiActiveJobId = $jobId

    $root = Get-KoseiRoot
    $worker = {
        param([string]$Root, $State)
        $ErrorActionPreference = 'Stop'
        try {
            . (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
            Set-KoseiRoot -Root $Root
            . (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
            . (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')
            $settings = Get-KoseiSettings
            $answersDir = Join-Path (Get-KoseiSubDir 'runtime') 'answers'
            New-Item -ItemType Directory -Path $answersDir -Force | Out-Null
            Get-ChildItem -LiteralPath $answersDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue

            $touch = { $State.updated_at = (Get-Date).ToString('s') }
            $State.mode = 'running'
            & $touch
            Write-KoseiLog ("ジョブ開始 job=" + $State.id + " packets=" + $State.packets_total + " mode=" + $State.attach_mode) 'INFO'

            $index = 0
            $fatalScreenFailure = $false
            foreach ($p in @($State.per_packet)) {
                if ($State.cancel_requested) {
                    $p.status = 'cancelled'
                    continue
                }
                $State.current_packet = [string]$p.packet_id
                $p.status = 'running'
                $p.started_at = (Get-Date).ToString('s')
                & $touch
                try {
                    $prompt = [System.IO.File]::ReadAllText([string]$p.prompt_path, [System.Text.Encoding]::UTF8)
                    $attach = @()
                    $message = $prompt
                    if ($State.attach_mode -eq 'pdf') {
                        # 手動フローと同じく、依頼文(PROMPT)はファイルとして添付し、
                        # チャットには短い定型指示だけを入力する。
                        # 長文insertの脆弱性とCopilot入力欄の文字数上限を回避する。
                        $attach = @([string]$p.pdf_path, [string]$p.prompt_path, [string]$p.text_path) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) }
                        $pdfName = [System.IO.Path]::GetFileName([string]$p.pdf_path)
                        $promptName = [System.IO.Path]::GetFileName([string]$p.prompt_path)
                        $textName = ''
                        if (-not [string]::IsNullOrWhiteSpace([string]$p.text_path)) { $textName = [System.IO.Path]::GetFileName([string]$p.text_path) }
                        $marker = [string]$settings.response_end_marker
                        $lines = @()
                        $lines += ("添付の「{0}」が校正指示書です。この指示書のルールに厳密に従って校正してください。" -f $promptName)
                        if (-not [string]::IsNullOrWhiteSpace($textName)) {
                            $lines += ("先に「{0}」の PAGE_MAP と TARGET_CHECK抽出テキストを読み、次に「{1}」のPDF表示と突き合わせて判定してください。" -f $textName, $pdfName)
                        } else {
                            $lines += ("「{0}」のPDF表示と突き合わせて判定してください。" -f $pdfName)
                        }
                        $lines += "回答は指示書で指定された厳密なvalid JSONのみとし、全キーと文字列を半角ダブルクォートで囲み、末尾カンマ・スマートクォート・説明文・Markdownコードフェンスは付けないでください。"
                        $lines += ("回答JSONの直後の行に {0} とだけ出力し、その後には何も出力しないでください。" -f $marker)
                        $message = ($lines -join "`n")
                    } else {
                        # TEXTのみモード: TEXT内容を依頼文へ連結（添付なし）
                        if (-not [string]::IsNullOrWhiteSpace([string]$p.text_path)) {
                            $textBody = [System.IO.File]::ReadAllText([string]$p.text_path, [System.Text.Encoding]::UTF8)
                            $message = $prompt + "`n`n===TEXT_SIDECAR===`n" + $textBody
                        }
                    }
                    $onPhase = {
                        param([string]$Phase)
                        $p.phase = $Phase
                        $State.phase = $Phase
                        $State.updated_at = (Get-Date).ToString('s')
                    }.GetNewClosure()
                    $shouldCancel = { return [bool]$State.cancel_requested }.GetNewClosure()
                    $onWaitProgress = { param($info) $p.detail=("回答待機中 {0}秒 / 受信 {1}文字" -f $info.elapsedSec,$info.newTextLen);$State.updated_at=(Get-Date).ToString('s') }.GetNewClosure()
                    $wait=$null
                    $recoverable=@('incomplete-json','copilot-refusal','no-json-idle')
                    for($attempt=1;$attempt -le 2;$attempt++){
                        $wait = Invoke-KoseiCopilotReviewRequest -Settings $settings -Prompt $message -AttachPaths $attach -ChatMode 'New' -OnPhase $onPhase -ShouldCancel $shouldCancel -OnWaitProgress $onWaitProgress -ExpectedPages @($p.target_pages)
                        if($recoverable -notcontains [string]$wait.completedBy -or $attempt -ge 2){break}
                        $p.detail='応答中断を検出しました。30秒後に新規チャットで再試行します。'
                        Write-KoseiLog ("新規チャット自動再試行 job=$($State.id) packet=$($p.packet_id) reason=$($wait.completedBy) backoffSec=30") 'WARN'
                        for($backoff=0;$backoff -lt 30;$backoff++){if($State.cancel_requested){break};Start-Sleep -Seconds 1}
                    }
                    # 通常回復に2回失敗した場合、対象ページを半分ずつ1回だけ再依頼して部分結果をマージする。
                    if($recoverable -contains [string]$wait.completedBy -and @($p.target_pages).Count -gt 1 -and -not $State.cancel_requested){
                        $pages=@($p.target_pages);$mid=[int][Math]::Ceiling($pages.Count/2.0)
                        $splitResults=@();$suffixes=@('a','b')
                        for($splitIndex=0;$splitIndex -lt 2;$splitIndex++){
                            $splitId=[string]$p.packet_id+$suffixes[$splitIndex]
                            $splitPages=$(if($splitIndex -eq 0){@($pages[0..($mid-1)])}else{@($pages[$mid..($pages.Count-1)])})
                            $splitPrompt=$message+"`n分割再試行です。packet_id は $splitId、確認対象ページは $(@($splitPages)-join ',') のみに限定してください。"
                            Write-KoseiLog ("分割再試行 packet=$splitId pages=$(@($splitPages)-join ',')") 'WARN'
                            # split再試行は新規チャットで行う（§7.7）。raw結果は別passとして扱い、PS側でfindingsを再構築しない方針は後続PRで撤去する。
                            $splitResults+=Invoke-KoseiCopilotReviewRequest -Settings $settings -Prompt $splitPrompt -AttachPaths $attach -ChatMode 'New' -OnPhase $onPhase -ShouldCancel $shouldCancel -OnWaitProgress $onWaitProgress -ExpectedPages @($splitPages)
                        }
                        $good=@($splitResults|Where-Object{$_.ok -and -not [string]::IsNullOrWhiteSpace([string]$_.json)})
                        if($good.Count){
                            $mergedFindings=@();$mergedPages=@();$mergedSummaries=@()
                            foreach($part in $good){$o=$part.json|ConvertFrom-Json;$mergedFindings+=@($o.findings);$mergedPages+=@($part.pagesChecked);$mergedSummaries+=@($o.checked_page_summaries)}
                            $merged=[ordered]@{packet_id=[string]$p.packet_id;pages_checked=@($mergedPages|Sort-Object -Unique);findings=@($mergedFindings);checked_page_summaries=@($mergedSummaries);read_error='';no_findings_reason=''}
                            $mergedJson=$merged|ConvertTo-Json -Depth 20
                            $elapsedTotal=[int](($splitResults|Measure-Object -Property elapsedMs -Sum).Sum);$overallTotal=[int](($splitResults|Measure-Object -Property totalElapsedMs -Sum).Sum)
                            $wait=[pscustomobject]@{ok=$true;completedBy=$(if($good.Count -eq 2){'split-merged'}else{'split-partial'});json=$mergedJson;rawJson=(@($splitResults|ForEach-Object{$_.rawJson})-join "`n---SPLIT---`n");repaired=$false;fixes=@();elapsedMs=$elapsedTotal;totalElapsedMs=$overallTotal;phaseTimings=$null;findingsCount=$mergedFindings.Count;pagesChecked=@($mergedPages|Sort-Object -Unique);coverage=($mergedPages.Count/[double]$pages.Count);warning=$(if($good.Count -eq 2){''}else{'分割再試行の一部だけをサルベージしました。'})}
                        }
                    }
                    $p.raw_answer = [string]$wait.json
                    $p.completed_by = [string]$wait.completedBy
                    $p.elapsed_ms = [int]$wait.elapsedMs
                    $p.total_elapsed_ms=[int]$wait.totalElapsedMs
                    $p.phase_timings=$wait.phaseTimings
                    $p.findings_count=[int]$wait.findingsCount
                    $p.pages_checked=@($wait.pagesChecked)
                    $p.coverage=[double]$wait.coverage
                    $p.warning=[string]$wait.warning
                    if (-not [string]::IsNullOrWhiteSpace($p.raw_answer)) {
                        $safePacket = ([string]$p.packet_id -replace '[^A-Za-z0-9_.-]', '_')
                        $answerPath = Join-Path $answersDir (([string]$State.id) + '_' + $safePacket + '.json')
                        [System.IO.File]::WriteAllText($answerPath, $p.raw_answer, (New-Object System.Text.UTF8Encoding($false)))
                        Write-KoseiLog ("回答保存 packet=$($p.packet_id) repaired=$($wait.repaired) fixes=$(@($wait.fixes)-join ',')") 'INFO'
                    }
                    if(-not [string]::IsNullOrWhiteSpace([string]$wait.rawJson)){
                        $safePacket = ([string]$p.packet_id -replace '[^A-Za-z0-9_.-]', '_')
                        $rawPath=Join-Path $answersDir (([string]$State.id) + '_' + $safePacket + '.raw.txt')
                        [System.IO.File]::WriteAllText($rawPath,[string]$wait.rawJson,(New-Object System.Text.UTF8Encoding($false)))
                    }
                    if($wait.diagnostics){
                        $safePacket = ([string]$p.packet_id -replace '[^A-Za-z0-9_.-]', '_')
                        $diagPath=Join-Path $answersDir (([string]$State.id) + '_' + $safePacket + '.diagnostics.json')
                        [System.IO.File]::WriteAllText($diagPath,($wait.diagnostics|ConvertTo-Json -Depth 8),(New-Object System.Text.UTF8Encoding($false)))
                    }
                    if(-not [string]::IsNullOrWhiteSpace([string]$wait.salvageText)){
                        $safePacket = ([string]$p.packet_id -replace '[^A-Za-z0-9_.-]', '_')
                        $salvagePath=Join-Path $answersDir (([string]$State.id) + '_' + $safePacket + '.salvage.txt')
                        [System.IO.File]::WriteAllText($salvagePath,[string]$wait.salvageText,(New-Object System.Text.UTF8Encoding($false)))
                    }
                    if ($wait.completedBy -eq 'cancelled') {
                        $p.status='cancelled';$State.cancel_requested=$true
                    } elseif (-not $wait.ok) {
                        $p.status = 'error'
                        $p.error = if ($wait.completedBy -eq 'marker-without-json') { 'Copilot回答に完了マーカーはありますが、有効な回答JSONを抽出できませんでした。診断ログを確認してください。' } else { '回答取得に失敗しました: ' + [string]$wait.completedBy }
                    } elseif ($wait.completedBy -eq 'timeout-incomplete' -or -not [string]::IsNullOrWhiteSpace([string]$wait.warning)) {
                        $p.status = 'warning'
                    } else {
                        $p.status = 'done'
                    }
                } catch {
                    $p.status = 'error'
                    $detail=[string]$_.Exception.Message
                    if ($detail -match 'Copilotへのサインインが必要|Copilot画面が準備できません') {
                        $fatalScreenFailure = $true
                        $State.error = $detail
                    }
                    if($detail.Length -gt 200){$detail=$detail.Substring(0,200)+'…'}
                    $p.error = $detail+'（詳細はログ/runtime\answersを参照）'
                    Write-KoseiLog ("パケット失敗 job=" + $State.id + " packet=" + $p.packet_id + ": " + $detail) 'ERROR'
                } finally {
                    $p.completed_at = (Get-Date).ToString('s')
                    $State.packets_done = [int]$State.packets_done + 1
                    & $touch
                }
                $index++
                if ($State.cancel_requested -or $fatalScreenFailure) { break }
            }
            if ($State.cancel_requested) {
                foreach ($remainingPacket in @($State.per_packet)) { if ([string]$remainingPacket.status -eq 'queued') { $remainingPacket.status='cancelled' } }
                $State.mode = 'cancelled'
            }
            elseif ($fatalScreenFailure) {
                foreach ($remainingPacket in @($State.per_packet)) { if ([string]$remainingPacket.status -eq 'queued') { $remainingPacket.status='cancelled'; $remainingPacket.error='Copilot画面の準備が必要なため未実行です。' } }
                $State.mode = 'error'
            }
            else {
                $hasError = $false
                foreach ($p in @($State.per_packet)) { if ([string]$p.status -eq 'error') { $hasError = $true } }
                if ($hasError) { $State.mode = 'error'; $State.error = '一部のパケットが失敗しました。' }
                else { $State.mode = 'done' }
            }
            $State.phase = ''
            & $touch
            Write-KoseiLog ("ジョブ終了 job=" + $State.id + " mode=" + $State.mode) 'INFO'
        } catch {
            $State.mode = 'error'
            $State.error = $_.Exception.Message
            $State.updated_at = (Get-Date).ToString('s')
            try { Write-KoseiLog ("ジョブ致命エラー job=" + $State.id + ": " + $_.Exception.Message) 'ERROR' } catch {}
        }
    }

    $ps = [powershell]::Create()
    $null = $ps.AddScript($worker).AddArgument($root).AddArgument($state)
    $async = $ps.BeginInvoke()
    $script:KoseiJobHandles[$jobId] = @{ PowerShell = $ps; Async = $async }
    Write-KoseiLog ("ジョブ受付 job=" + $jobId) 'INFO'
    return $jobId
}
