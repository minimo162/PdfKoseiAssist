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
    wording     = @{ label = '訳語の揺れ';     detail = @'
同じ日本語（用語・見出し・定型句）に対する英訳が資料内でばらついていないか。
会計・IR用語の訳し分けを特に見る（例: 売上高を net sales と revenue で混用、自己資本を
shareholders' equity と net assets で混用、連結子会社を consolidated subsidiary と
affiliated company で混用、持分法適用関連会社を subsidiary と訳す）。
REFがある場合は、REFで同じ語なら英訳も揃えるよう提案する。
'@ }
    ellipsis    = @{ label = '日本語の省略';   detail = @'
日本語は主語・目的語・所有者・助詞を文脈で省く。それを逐語的に英訳した結果、
英語として意味が通らない／曖昧になっている箇所（REFがある場合のみ）。
例: 「改善した」→ 主語の無い Improved...、「取り組んでまいります」→ 主語も目的語も無い
Will continue to work on it、「当該影響は軽微」→ 何の影響か消えた The effect is minor。
REFを読んで省略された要素を特定し、英語で明示する案を出す。
'@ }
    terms       = @{ label = '表記の統一';     detail = @'
固有名詞・制度名・規程名・部署名・製品名が、資料内で**同じ表記に揃っているか**。
原文を見なくても、英文だけを読んで「同じものを指しているのに書き分けている」と分かるものを探す。
例: the AOI Quality Standard と the AOI Quality Standards、Aoi Advanced Materials Co., Ltd. と
Aoi Advanced Material Co., Ltd.、the Nagoya Branch と the Nagoya Branch Office、
the Whistleblowing Regulations と the Whistle-blowing Regulations、& と and の混用。
単数複数・ハイフン・記号・語尾の違いも対象。**訳が正しいかどうかは問わない**。
離れたページどうしを突き合わせること。近くの2箇所だけを見ても揃っているように見える。
'@ }
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
        quick       = @('broad')
        standard    = @('broad', 'numbers', 'names', 'gap')
        thorough    = @('broad', 'translation', 'numbers', 'names', 'wording', 'ellipsis', 'spelling', 'grammar', 'structure', 'gap')
        consistency = @('broad', 'wording', 'ellipsis', 'gap')
        complement  = @('broad')
        # 整合性を1ターンに畳む構成。観点はプロンプト側（combined）へ織り込む。
        consistency1 = @('broad')
        # 観点を別ターンに分ける構成。1ターンに詰め込むと出力の枠を数値の照合が食い切り、
        # 表記の揺れが出てこない（実測: 幅100/200 で term 1/17・2/24。幅25/50 なら 6/6・8/9）。
        consistency2 = @('broad', 'terms', 'numbers')
    }
    $refRequired = @('translation', 'ellipsis')
    # gap を付けないプロファイル。review_gap_pass は全プロファイル共通なので、これが無いと
    # 「パケット側の無駄な gap を切る」つもりで整合性側の gap まで消える（注記の回収passなので消してはいけない）。
    $noGapProfiles = @('complement', 'consistency1', 'consistency2')
    $warnings = @(); $skipped = @()
    $base = $profiles[$Profile]
    if (-not $base) { $warnings += ("未知の profile '{0}' のため quick を使用" -f $Profile); $base = $profiles['quick'] }
    $lenses = @()
    foreach ($x in $base) {
        if ($x -eq 'gap') { continue }
        if ($refRequired -contains $x -and -not $HasRef) { $skipped += [pscustomobject]@{ lens = $x; reason = 'no-ref' }; continue }
        $lenses += $x
    }
    # プロファイル自体が gap を持たない場合はフラグに関わらず付けない。
    $wantGap = $GapPass -and ($noGapProfiles -notcontains $Profile)
    # 上限。gap は既出以外を探す歩留まりが高いので、有効なら1枠を予約して必ず残す。
    $cap = if ($MaxPasses -gt 0) { $MaxPasses } else { $lenses.Count + 1 }
    $lensCap = if ($wantGap) { [Math]::Max(1, $cap - 1) } else { $cap }
    $kept = $lenses
    if ($lenses.Count -gt $lensCap) {
        $kept = @($lenses[0..($lensCap - 1)])
        foreach ($x in @($lenses[$lensCap..($lenses.Count - 1)])) { $skipped += [pscustomobject]@{ lens = $x; reason = 'max-passes-exceeded' } }
        $totalWanted = $lenses.Count + $(if ($wantGap) { 1 } else { 0 })
        $warnings += ("pass数 {0} が上限 {1} を超過。{2} 件を skip" -f $totalWanted, $cap, ($lenses.Count - $lensCap))
    }
    $kept = @($kept)
    if ($wantGap) { $kept += 'gap' }
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
    # HasRef が真なら、同じ会話に添付済みの比較資料(REF)と突き合わせるよう明示する。
    param([Parameter(Mandatory=$true)][string]$Lens, [string]$PageRange = '', [Parameter(Mandatory=$true)][string]$Marker, [bool]$HasRef = $false)
    $info = $script:KoseiReviewLenses[$Lens]
    $label = if ($info) { [string]$info.label } else { $Lens }
    $detail = if ($info) { [string]$info.detail } else { '' }
    $refLine = if ($HasRef) {
        "同じ会話に添付済みの REFERENCE（日本語原文）を正として突き合わせてください。REFは正しい前提です。`n"
    } else { '' }
    return @"
同じ添付資料のまま、観点「$label」だけに絞って TARGET_CHECK 全ページ（P.$PageRange）を
もう一度、先頭ページから順に走査してください。
$refLine
この観点で見るもの:
$detail

- 既出の指摘と重複して構いません。重複はアプリ側で除去します。
- 対象ページは全ページです。1ページも飛ばさないでください。
- この観点に当てはまらない指摘は出さないでください。該当なしなら findings を空配列にしてください。
- 回答は指示書と同じJSON形式で出力してください。
- 回答JSONの直後の行に $Marker とだけ出力してください。
"@
}

function Get-KoseiPriorFindingsDigest {
    # §8.2: 既出passのraw_answerから page/quote/category を最小抽出（try/catch、最大Max件）。
    # PS側でのJSON構築はしない。抽出値は追撃文のプレーンテキストとしてのみ使う（R6）。
    param([object[]]$Passes, [int]$Max = 50)
    $items = @()
    foreach ($pass in @($Passes)) {
        if ($items.Count -ge $Max) { break }
        $raw = [string]$pass.raw_answer
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        try {
            $obj = $raw | ConvertFrom-Json
            foreach ($f in @($obj.findings)) {
                if ($items.Count -ge $Max) { break }
                $q = [string]$f.quote
                if ($q.Length -gt 40) { $q = $q.Substring(0, 40) }
                $items += ('P.{0} [{1}] {2}' -f [string]$f.page, [string]$f.category, $q)
            }
        } catch {
            Write-KoseiLog ('gap digest parse失敗（skip）: ' + $_.Exception.Message) 'WARN'
        }
    }
    return @($items)
}

function New-KoseiGapFollowupPrompt {
    # §8.1: 見落とし探し。既出一覧に無い指摘だけを求める。添付なし・Reuse turn。
    param([string[]]$Digest, [string]$PageRange = '', [Parameter(Mandatory=$true)][string]$Marker)
    $list = if (@($Digest).Count) { (@($Digest) -join "`n") } else { '(既出なし)' }
    # 実測（3回）で gap が既出の再掲ばかりを返し、新規の歩留まりが 3件→0件→0件 と落ちた。
    # 「一覧に無いものだけ」という指示だけでは効かないため、除外リストとして明示し、
    # 出力前の自己点検を求める。あわせて、既存passが手薄な箇所（注記・脚注・但し書き）を名指しする。
    return @"
次は、この資料に対して**すでに報告済み**の指摘です（最大50件）。これらは**報告禁止**です。

$list

上のどれとも違う、新しい指摘だけを挙げてください。
- 出力する前に、各指摘の page と quote が上の一覧と重ならないか1件ずつ確認してください。
  同じ箇所を別の言い方・別の観点で言い直したものは、新しい指摘ではありません。
- 上の一覧に出てこないページ、出てきていても1件しか無いページを重点的に見てください。
- 本文や表の数値はすでに見終わっています。**注記・脚注・(注)行・表の但し書き・単位の説明**など、
  読み飛ばされやすい小さな文字の箇所をREFと突き合わせてください（訳抜け・訳語のずれが残りやすい）。
- 対象は TARGET_CHECK 全ページ（P.$PageRange）です。1ページも飛ばさないでください。
- 該当がなければ findings を空配列にし、no_findings_reason に確認範囲を書いてください。
  無理に絞り出す必要はありません。0件は正しい答えになりえます。
- 回答は指示書と同じJSON形式で、回答JSONの直後の行に $Marker とだけ出力してください。
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
            response_wait_ms = [int]$p.response_wait_ms
            passes         = @(@($p.passes) | ForEach-Object { [ordered]@{ pass_id=[string]$_.pass_id; kind=[string]$_.kind; lens=[string]$_.lens; completed_by=[string]$_.completed_by; findings_count=[int]$_.findings_count; elapsed_ms=[int]$_.elapsed_ms } })
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
        current_packets  = @($State.current_packets)
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
            response_wait_ms = [int]$p.response_wait_ms
            passes = @(@($p.passes) | ForEach-Object { [ordered]@{ pass_id=[string]$_.pass_id; kind=[string]$_.kind; lens=[string]$_.lens; marker=[string]$_.marker; raw_answer=[string]$_.raw_answer; completed_by=[string]$_.completed_by; findings_count=[int]$_.findings_count; elapsed_ms=[int]$_.elapsed_ms; response_wait_ms=[int]$_.response_wait_ms } })
        }
    }
    return [ordered]@{ id = [string]$State.id; mode = [string]$State.mode; packets = $packets }
}

# パケット1件を Copilot へ投げ、結果を $Packet へ書き戻す。
#
# ループから切り出してあるのは、並列化（引き継ぎ書 §6.4）でワーカーごとに
# 呼べるようにするため。ここが関数になっていないと、2ワーカーの実測すら
# 製品と別経路のコードを書くことになり、測ったものが製品とずれる。
#
# -Page を渡すと、そのパケットの往復（pass1・分割再試行・追撃pass のすべて）が
# そのページで行われる。省略すると従来どおり「条件に合う最初のページ」を使う。
#
# ⚠️ まだ逐次でしか呼んでいない。並列に呼ぶ前に、テナント側の同時実行制限
#    （引き継ぎ書 §6.1）を測ること。そこが塞がっていれば RunspacePool 化は無駄になる。
#
# 戻り値: Copilot画面の準備失敗（サインイン要求など）で、残りを続けても
#         全部失敗すると分かった場合に $true。呼び出し側はループを打ち切る。
function Invoke-KoseiPacket {
    param(
        [Parameter(Mandatory=$true)]$Packet,
        [Parameter(Mandatory=$true)]$State,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)]$ReviewFlags,
        [Parameter(Mandatory=$true)][string]$AnswersDir,
        # ターンマーカーの採番に使う。並列時もパケットごとに一意でなければならない。
        [Parameter(Mandatory=$true)][int]$PacketIndex,
        [scriptblock]$Touch = {},
        # このパケットを投げる Copilot ページ（CDPターゲット）。
        # 省略時は Invoke-KoseiCopilotReviewRequest が自分で解決する＝従来どおり。
        # 並列時はワーカー専用の窓を渡すこと。
        $Page = $null
    )
    $fatalScreenFailure = $false
    try {
        $prompt = [System.IO.File]::ReadAllText([string]$Packet.prompt_path, [System.Text.Encoding]::UTF8)
        $attach = @()
        $message = $prompt
        if ($State.attach_mode -eq 'pdf') {
            # 手動フローと同じく、依頼文(PROMPT)はファイルとして添付し、
            # チャットには短い定型指示だけを入力する。
            # 長文insertの脆弱性とCopilot入力欄の文字数上限を回避する。
            $attach = @([string]$Packet.pdf_path, [string]$Packet.prompt_path, [string]$Packet.text_path) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) }
            $pdfName = [System.IO.Path]::GetFileName([string]$Packet.pdf_path)
            $promptName = [System.IO.Path]::GetFileName([string]$Packet.prompt_path)
            $textName = ''
            if (-not [string]::IsNullOrWhiteSpace([string]$Packet.text_path)) { $textName = [System.IO.Path]::GetFileName([string]$Packet.text_path) }
            $marker = [string]$Settings.response_end_marker
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
        } elseif ($State.attach_mode -eq 'masked-text') {
            # 数値マスキング（docs/plan/NUMBER_MASKING_SPEC.md）。
            # ⚠️ **PDFは絶対に添付しない**。PDFを送ると紙面に数値が写っているので、
            #    テキストをどれだけマスクしても意味がない。
            $attach = @([string]$Packet.prompt_path, [string]$Packet.text_path) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) }
            if (-not [string]::IsNullOrWhiteSpace([string]$Packet.pdf_path)) {
                Write-KoseiLog ("masked-text なのに pdf_path があります。添付しません: " + [string]$Packet.pdf_path) 'WARN'
            }
            $promptName = [System.IO.Path]::GetFileName([string]$Packet.prompt_path)
            $textName = ''
            if (-not [string]::IsNullOrWhiteSpace([string]$Packet.text_path)) { $textName = [System.IO.Path]::GetFileName([string]$Packet.text_path) }
            $marker = [string]$Settings.response_end_marker
            $lines = @()
            $lines += ("添付の「{0}」が校正指示書です。この指示書のルールに厳密に従って校正してください。" -f $promptName)
            if (-not [string]::IsNullOrWhiteSpace($textName)) {
                $lines += ("「{0}」が本文です。数値は ⟦#XXX⟧ の形に伏せてあります。" -f $textName)
            }
            $lines += "回答は指示書で指定された厳密なvalid JSONのみとし、全キーと文字列を半角ダブルクォートで囲み、末尾カンマ・スマートクォート・説明文・Markdownコードフェンスは付けないでください。"
            $lines += ("回答JSONの直後の行に {0} とだけ出力し、その後には何も出力しないでください。" -f $marker)
            $message = ($lines -join "`n")
        } else {
            # TEXTのみモード: TEXT内容を依頼文へ連結（添付なし）
            if (-not [string]::IsNullOrWhiteSpace([string]$Packet.text_path)) {
                $textBody = [System.IO.File]::ReadAllText([string]$Packet.text_path, [System.Text.Encoding]::UTF8)
                $message = $prompt + "`n`n===TEXT_SIDECAR===`n" + $textBody
            }
        }
        $onPhase = {
            param([string]$Phase)
            $Packet.phase = $Phase
            $State.phase = $Phase
            $State.updated_at = (Get-Date).ToString('s')
        }.GetNewClosure()
        $shouldCancel = { return [bool]$State.cancel_requested }.GetNewClosure()
        $onWaitProgress = { param($info) $Packet.detail=("回答待機中 {0}秒 / 受信 {1}文字" -f $info.elapsedSec,$info.newTextLen);$State.updated_at=(Get-Date).ToString('s') }.GetNewClosure()
        $wait=$null
        $recoverable=@('incomplete-json','copilot-refusal','no-json-idle','generation-stalled')
        for($attempt=1;$attempt -le 2;$attempt++){
            $wait = Invoke-KoseiCopilotReviewRequest -Settings $Settings -Prompt $message -AttachPaths $attach -ChatMode 'New' -OnPhase $onPhase -ShouldCancel $shouldCancel -OnWaitProgress $onWaitProgress -ExpectedPages @($Packet.target_pages) -Page $Page
            if($recoverable -notcontains [string]$wait.completedBy -or $attempt -ge 2){break}
            $Packet.detail='応答中断を検出しました。30秒後に新規チャットで再試行します。'
            Write-KoseiLog ("新規チャット自動再試行 job=$($State.id) packet=$($Packet.packet_id) reason=$($wait.completedBy) backoffSec=30") 'WARN'
            for($backoff=0;$backoff -lt 30;$backoff++){if($State.cancel_requested){break};Start-Sleep -Seconds 1}
        }
        # 通常回復に2回失敗した場合、対象ページを半分ずつ1回だけ再依頼して部分結果をマージする。
        if($recoverable -contains [string]$wait.completedBy -and @($Packet.target_pages).Count -gt 1 -and -not $State.cancel_requested){
            $pages=@($Packet.target_pages);$mid=[int][Math]::Ceiling($pages.Count/2.0)
            $splitResults=@();$suffixes=@('a','b')
            for($splitIndex=0;$splitIndex -lt 2;$splitIndex++){
                $splitId=[string]$Packet.packet_id+$suffixes[$splitIndex]
                $splitPages=$(if($splitIndex -eq 0){@($pages[0..($mid-1)])}else{@($pages[$mid..($pages.Count-1)])})
                $splitPrompt=$message+"`n分割再試行です。packet_id は $splitId、確認対象ページは $(@($splitPages)-join ',') のみに限定してください。"
                Write-KoseiLog ("分割再試行 packet=$splitId pages=$(@($splitPages)-join ',')") 'WARN'
                # split再試行は新規チャットで行う（§7.7）。raw結果は別passとして扱い、PS側でfindingsを再構築しない方針は後続PRで撤去する。
                $splitResults+=Invoke-KoseiCopilotReviewRequest -Settings $Settings -Prompt $splitPrompt -AttachPaths $attach -ChatMode 'New' -OnPhase $onPhase -ShouldCancel $shouldCancel -OnWaitProgress $onWaitProgress -ExpectedPages @($splitPages) -Page $Page
            }
            $good=@($splitResults|Where-Object{$_.ok -and -not [string]::IsNullOrWhiteSpace([string]$_.json)})
            if($good.Count){
                $mergedFindings=@();$mergedPages=@();$mergedSummaries=@()
                foreach($part in $good){$o=$part.json|ConvertFrom-Json;$mergedFindings+=@($o.findings);$mergedPages+=@($part.pagesChecked);$mergedSummaries+=@($o.checked_page_summaries)}
                $merged=[ordered]@{packet_id=[string]$Packet.packet_id;pages_checked=@($mergedPages|Sort-Object -Unique);findings=@($mergedFindings);checked_page_summaries=@($mergedSummaries);read_error='';no_findings_reason=''}
                $mergedJson=$merged|ConvertTo-Json -Depth 20
                $elapsedTotal=[int](($splitResults|Measure-Object -Property elapsedMs -Sum).Sum);$overallTotal=[int](($splitResults|Measure-Object -Property totalElapsedMs -Sum).Sum)
                $wait=[pscustomobject]@{ok=$true;completedBy=$(if($good.Count -eq 2){'split-merged'}else{'split-partial'});json=$mergedJson;rawJson=(@($splitResults|ForEach-Object{$_.rawJson})-join "`n---SPLIT---`n");repaired=$false;fixes=@();elapsedMs=$elapsedTotal;totalElapsedMs=$overallTotal;phaseTimings=$null;findingsCount=$mergedFindings.Count;pagesChecked=@($mergedPages|Sort-Object -Unique);coverage=($mergedPages.Count/[double]$pages.Count);warning=$(if($good.Count -eq 2){''}else{'分割再試行の一部だけをサルベージしました。'})}
            }
        }
        $Packet.raw_answer = [string]$wait.json
        $Packet.completed_by = [string]$wait.completedBy
        $Packet.elapsed_ms = [int]$wait.elapsedMs
        $Packet.total_elapsed_ms=[int]$wait.totalElapsedMs
        $Packet.phase_timings=$wait.phaseTimings
        $Packet.response_wait_ms=[int]$(if($wait.phaseTimings){$wait.phaseTimings.response_wait_ms}else{0})
        $Packet.findings_count=[int]$wait.findingsCount
        $Packet.pages_checked=@($wait.pagesChecked)
        $Packet.coverage=[double]$wait.coverage
        $Packet.warning=[string]$wait.warning
        if (-not [string]::IsNullOrWhiteSpace($Packet.raw_answer)) {
            $safePacket = ([string]$Packet.packet_id -replace '[^A-Za-z0-9_.-]', '_')
            $answerPath = Join-Path $AnswersDir (([string]$State.id) + '_' + $safePacket + '.json')
            [System.IO.File]::WriteAllText($answerPath, $Packet.raw_answer, (New-Object System.Text.UTF8Encoding($false)))
            Write-KoseiLog ("回答保存 packet=$($Packet.packet_id) repaired=$($wait.repaired) fixes=$(@($wait.fixes)-join ',')") 'INFO'
        }
        if(-not [string]::IsNullOrWhiteSpace([string]$wait.rawJson)){
            $safePacket = ([string]$Packet.packet_id -replace '[^A-Za-z0-9_.-]', '_')
            $rawPath=Join-Path $AnswersDir (([string]$State.id) + '_' + $safePacket + '.raw.txt')
            [System.IO.File]::WriteAllText($rawPath,[string]$wait.rawJson,(New-Object System.Text.UTF8Encoding($false)))
        }
        if($wait.diagnostics){
            $safePacket = ([string]$Packet.packet_id -replace '[^A-Za-z0-9_.-]', '_')
            $diagPath=Join-Path $AnswersDir (([string]$State.id) + '_' + $safePacket + '.diagnostics.json')
            [System.IO.File]::WriteAllText($diagPath,($wait.diagnostics|ConvertTo-Json -Depth 8),(New-Object System.Text.UTF8Encoding($false)))
        }
        if(-not [string]::IsNullOrWhiteSpace([string]$wait.salvageText)){
            $safePacket = ([string]$Packet.packet_id -replace '[^A-Za-z0-9_.-]', '_')
            $salvagePath=Join-Path $AnswersDir (([string]$State.id) + '_' + $safePacket + '.salvage.txt')
            [System.IO.File]::WriteAllText($salvagePath,[string]$wait.salvageText,(New-Object System.Text.UTF8Encoding($false)))
        }
        # 失敗時は診断を必ず残す。成功パスの $wait.diagnostics しか書いていなかったため、
        # 一番知りたい「なぜ受理されなかったか」がどこにも残っていなかった。
        if(-not $wait.ok -and -not [string]::IsNullOrWhiteSpace([string]$wait.rawJson)){
            try{
                $safePacket = ([string]$Packet.packet_id -replace '[^A-Za-z0-9_.-]', '_')
                $failDiag=Get-KoseiReviewJsonDiagnostics -Text ([string]$wait.rawJson)
                $failPath=Join-Path $AnswersDir (([string]$State.id) + '_' + $safePacket + '.failure.json')
                $payload=[ordered]@{completed_by=[string]$wait.completedBy;raw_length=([string]$wait.rawJson).Length;diagnostics=$failDiag}
                [System.IO.File]::WriteAllText($failPath,($payload|ConvertTo-Json -Depth 10),(New-Object System.Text.UTF8Encoding($false)))
                Write-KoseiLog ("失敗診断を保存 packet=$($Packet.packet_id) completedBy=$($wait.completedBy) rawLen=$(([string]$wait.rawJson).Length) candidates=$($failDiag.count)") 'WARN'
            }catch{ Write-KoseiLog ("失敗診断の保存に失敗: " + $_.Exception.Message) 'WARN' }
        }
        # pass1 の最終status。multipass の追撃を積み終えるまで $Packet.status は 'running' のままにし、
        # UIポーラーが gap 追撃の前に「done」を見て早取り込みするのを防ぐ（全pass完了後に確定）。
        $pass1Status = 'done'
        if ($wait.completedBy -eq 'cancelled') {
            $Packet.status='cancelled';$State.cancel_requested=$true;$pass1Status='cancelled'
        } elseif (-not $wait.ok) {
            $pass1Status = 'error'
            $Packet.error = if ($wait.completedBy -eq 'marker-without-json') { 'Copilot回答に完了マーカーはありますが、有効な回答JSONを抽出できませんでした。診断ログを確認してください。' } else { '回答取得に失敗しました: ' + [string]$wait.completedBy }
        } elseif ($wait.completedBy -eq 'timeout-incomplete' -or -not [string]::IsNullOrWhiteSpace([string]$wait.warning)) {
            $pass1Status = 'warning'
        } else {
            $pass1Status = 'done'
        }

        # --- 多パス（review_engine=multipass）---------------------------------
        # pass1(broad)成功後、同一チャットへ Reuse で観点/gap 追撃を積む。各passのrawは
        # $Packet.passes に保持し、統合(dedupe/group)は取り込み側(JS)で行う（PS側で再構築しない）。
        # legacy 既定ではこのブロックを丸ごとスキップし、従来挙動と完全に同一。
        # 整合性レビュー(kind=consistency)は観点passの追撃を前提に設計した新機能で、
        # broad 1passだけでは成立しない。review_engine の既定は legacy なので、
        # 設定を変え忘れると黙って機能の半分が落ちる。ここは kind で強制する。
        # 校正パケット(proofread)は従来どおり flag に従う（既定 legacy = v94 と同一挙動, K34）。
        $packetEngine = if ([string]$Packet.kind -eq 'consistency') { 'multipass' } else { [string]$ReviewFlags.review_engine }
        if ($packetEngine -eq 'multipass' -and @('done','warning') -contains $pass1Status -and -not $State.cancel_requested) {
            # 分担（§7.2）: 整合性セクションは consistency プロファイル（訳語の揺れ・省略を Reuse で追撃）、
            # 校正パケットは従来どおり batch/single プロファイル。
            # パケットが profile を指定していればそれを最優先する。
            # 構成を変えて実測するとき、settings を書き換えずに1回だけ変えられるようにするため。
            $reviewProfile = if (-not [string]::IsNullOrWhiteSpace([string]$Packet.profile)) {
                [string]$Packet.profile
            } elseif ([string]$Packet.kind -eq 'consistency') {
                [string]$ReviewFlags.review_profile_consistency
            } elseif (@($State.per_packet).Count -gt 1) {
                [string]$ReviewFlags.review_profile_batch
            } else {
                [string]$ReviewFlags.review_profile_single
            }
            $sched = Get-KoseiPassSchedule -Profile $reviewProfile -HasRef ([bool]$Packet.has_ref) -GapPass ([bool]$ReviewFlags.review_gap_pass) -MaxPasses ([int]$Settings.review_max_passes)
            $pageRange = (@($Packet.target_pages) -join ',')
            # pass0(broad) = 既存 pass1 結果を passes[0] として記録
            $Packet.passes = @([pscustomobject]@{ pass_id='0'; kind='broad'; lens='broad'; marker=[string]$Settings.response_end_marker; raw_answer=[string]$Packet.raw_answer; completed_by=[string]$Packet.completed_by; findings_count=[int]$Packet.findings_count; elapsed_ms=[int]$Packet.total_elapsed_ms; response_wait_ms=[int]$Packet.response_wait_ms })
            Write-KoseiLog ("multipass開始 profile=$reviewProfile kind=$($Packet.kind) hasRef=$($Packet.has_ref) passes=$(@($sched.passes).Count) lenses=$(@($sched.passes | ForEach-Object { $_.lens }) -join ',') job=$($State.id) packet=$($Packet.packet_id)") 'INFO'
            foreach ($sk in @($sched.skipped)) { Write-KoseiLog ("multipass skip lens=$($sk.lens) reason=$($sk.reason)") 'INFO' }
            foreach ($sp in @($sched.passes)) {
                if ([int]$sp.pass_index -lt 1) { continue }   # pass0(broad)は上で記録済み
                if ($State.cancel_requested) { break }
                $turnMarker = New-KoseiTurnMarker -JobId ([string]$State.id) -PacketIndex ([int]$PacketIndex) -TurnIndex ([int]$sp.pass_index)
                $fprompt = if ([string]$sp.kind -eq 'gap') {
                    $digest = Get-KoseiPriorFindingsDigest -Passes $Packet.passes -Max 50
                    New-KoseiGapFollowupPrompt -Digest $digest -PageRange $pageRange -Marker $turnMarker
                } else {
                    New-KoseiLensFollowupPrompt -Lens ([string]$sp.lens) -PageRange $pageRange -Marker $turnMarker -HasRef ([bool]$Packet.has_ref)
                }
                $Packet.detail = ("pass {0} / {1}" -f ([int]$sp.pass_index + 1), [string]$sp.lens); $State.updated_at=(Get-Date).ToString('s'); & $Touch
                $pr = $null
                try {
                    $pr = Invoke-KoseiCopilotReviewRequest -Settings $Settings -Prompt $fprompt -AttachPaths @() -ChatMode 'Reuse' -Marker $turnMarker -OnPhase $onPhase -ShouldCancel $shouldCancel -OnWaitProgress $onWaitProgress -ExpectedPages @($Packet.target_pages) -Page $Page
                } catch {
                    Write-KoseiLog ("multipass pass失敗 lens=$($sp.lens): " + $_.Exception.Message) 'WARN'
                    $Packet.passes += [pscustomobject]@{ pass_id=[string]$sp.pass_index; kind=[string]$sp.kind; lens=[string]$sp.lens; marker=$turnMarker; raw_answer=''; completed_by='error'; findings_count=0; elapsed_ms=0; response_wait_ms=0 }
                    continue
                }
                # 追撃passの所要時間はこれまでパケット合計に入っておらず、
                # 画面の「合計 N 秒」が pass1 の分だけを表示していた（30ターン走っても
                # 3ターン分しか出ない）。ここで加算する。
                $passElapsed = [int]$pr.totalElapsedMs
                $passWait = [int]$(if($pr.phaseTimings){$pr.phaseTimings.response_wait_ms}else{0})
                $Packet.total_elapsed_ms = [int]$Packet.total_elapsed_ms + $passElapsed
                $Packet.response_wait_ms = [int]$Packet.response_wait_ms + $passWait
                $Packet.passes += [pscustomobject]@{ pass_id=[string]$sp.pass_index; kind=[string]$sp.kind; lens=[string]$sp.lens; marker=$turnMarker; raw_answer=[string]$pr.json; completed_by=[string]$pr.completedBy; findings_count=[int]$pr.findingsCount; elapsed_ms=$passElapsed; response_wait_ms=$passWait }
                if (-not [string]::IsNullOrWhiteSpace([string]$pr.json)) {
                    $safePacket = ([string]$Packet.packet_id -replace '[^A-Za-z0-9_.-]', '_')
                    $passPath = Join-Path $AnswersDir (([string]$State.id) + '_' + $safePacket + '.pass' + [string]$sp.pass_index + '.json')
                    [System.IO.File]::WriteAllText($passPath, [string]$pr.json, (New-Object System.Text.UTF8Encoding($false)))
                }
                Write-KoseiLog ("multipass pass完了 lens=$($sp.lens) completedBy=$($pr.completedBy) findings=$($pr.findingsCount)") 'INFO'
                & $Touch
            }
            # カードの指摘件数を全pass合算に更新（broadだけの値だと過少表示になる）。
            # 取り込み側(JS)で重複除去されるため、実際のUI件数はこれ以下になり得る（生の上限値）。
            $Packet.findings_count = [int]((@($Packet.passes) | Measure-Object -Property findings_count -Sum).Sum)
        }
        # 全pass完了後に最終statusを確定（cancelled は上で設定済みのため除外。done/warning/error を反映）。
        # これで UI ポーラーは passes[] が揃った状態でのみ 'done'/'warning' を見て取り込む。
        if ([string]$Packet.status -ne 'cancelled') { $Packet.status = $pass1Status }
    } catch {
        $Packet.status = 'error'
        $detail=[string]$_.Exception.Message
        if ($detail -match 'Copilotへのサインインが必要|Copilot画面が準備できません') {
            $fatalScreenFailure = $true
            $State.error = $detail
        }
        if($detail.Length -gt 200){$detail=$detail.Substring(0,200)+'…'}
        $Packet.error = $detail+'（詳細はログ/runtime\answersを参照）'
        Write-KoseiLog ("パケット失敗 job=" + $State.id + " packet=" + $Packet.packet_id + ": " + $detail) 'ERROR'
    } finally {
        $Packet.completed_at = (Get-Date).ToString('s')
        $State.packets_done = [int]$State.packets_done + 1
        & $Touch
    }
    return $fatalScreenFailure
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
    if (@('pdf','text','masked-text') -notcontains $mode) { throw "attach_mode が不正です: $mode" }

    $jobId = ([guid]::NewGuid().ToString('N'))
    $perPacket = New-Object System.Collections.ArrayList
    foreach ($p in $Packets) {
        $null = $perPacket.Add([hashtable]::Synchronized(@{
            packet_id    = [string]$p.packet_id
            prompt_path  = [string]$p.prompt_path
            pdf_path     = [string]$p.pdf_path
            text_path    = [string]$p.text_path
            target_pages = @($p.target_pages)
            kind         = $(if (@('proofread','consistency') -contains [string]$p.kind) { [string]$p.kind } else { 'proofread' })
            has_ref      = [bool]$p.has_ref
            profile      = [string]$p.profile   # 空なら settings の既定に従う
            status       = 'queued'   # queued|running|done|error|cancelled
            phase        = ''
            error        = ''
            raw_answer   = ''
            completed_by = ''
            detail       = ''
            elapsed_ms   = 0
            total_elapsed_ms = 0
            response_wait_ms = 0   # 全pass合計の生成待ち時間（phase_timings は pass1 の内訳のみ）
            phase_timings = $null
            started_at   = ''
            completed_at = ''
            findings_count = 0
            pages_checked = @()
            coverage = 0.0
            warning = ''
            passes = @()   # multipass: 各passの結果（raw_answer含む）。legacy では空のまま。
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
        # 並列時は同時に複数が走る。単数の current_packet は「, 区切りの表示用」として残し、
        # 機械的に読む側はこちらを見る（§6.4 #4）。
        current_packets  = @()
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
            # multipass のスケジューラ/追撃プロンプト/marker 生成は ReviewJob.ps1 に定義されるため、
            # worker runspace でも本ファイルを dot-source して関数を利用可能にする（top-level は副作用なし）。
            . (Join-Path (Join-Path $Root 'src') 'ReviewJob.ps1')
            $settings = Get-KoseiSettings
            $answersDir = Join-Path (Get-KoseiSubDir 'runtime') 'answers'
            New-Item -ItemType Directory -Path $answersDir -Force | Out-Null
            Get-ChildItem -LiteralPath $answersDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue

            $touch = { $State.updated_at = (Get-Date).ToString('s') }
            $State.mode = 'running'
            & $touch
            Write-KoseiLog ("ジョブ開始 job=" + $State.id + " packets=" + $State.packets_total + " mode=" + $State.attach_mode) 'INFO'
            $reviewFlags = Get-KoseiValidatedReviewFlags -Settings $settings
            Write-KoseiLog ("reviewエンジン engine=$($reviewFlags.review_engine) gap=$($reviewFlags.review_gap_pass) profile_batch=$($reviewFlags.review_profile_batch) profile_single=$($reviewFlags.review_profile_single)") 'INFO'

            # 並列ワーカー数。既定 1 のときは**従来と完全に同じ逐次経路**を通す。
            # 実測は docs/benchmarks/README.md（2ワーカー 1.90x / 4ワーカー 3.55x）。
            $maxWorkers = [Math]::Min([int]$reviewFlags.review_max_workers, @($State.per_packet).Count)
            if ($maxWorkers -lt 1) { $maxWorkers = 1 }
            $fatalScreenFailure = $false

            if ($maxWorkers -le 1) {
                $index = 0
                foreach ($p in @($State.per_packet)) {
                    if ($State.cancel_requested) {
                        $p.status = 'cancelled'
                        continue
                    }
                    $State.current_packet = [string]$p.packet_id
                    $State.current_packets = @([string]$p.packet_id)
                    $p.status = 'running'
                    $p.started_at = (Get-Date).ToString('s')
                    & $touch
                    if (Invoke-KoseiPacket -Packet $p -State $State -Settings $settings -ReviewFlags $reviewFlags -AnswersDir $answersDir -PacketIndex $index -Touch $touch) {
                        $fatalScreenFailure = $true
                    }
                    $index++
                    if ($State.cancel_requested -or $fatalScreenFailure) { break }
                }
            } else {
                Write-KoseiLog ("並列実行 workers=$maxWorkers packets=$(@($State.per_packet).Count)") 'INFO'
                # ワーカーごとに別ウィンドウの Copilot を用意する（§6.4 #1）。
                # ここで失敗したら逐次へ落とす。並列にできないことは、走らない理由にはならない。
                $workerPages = $null
                try {
                    $workerPages = New-KoseiCopilotWorkerPages -Settings $settings -Count $maxWorkers
                } catch {
                    Write-KoseiLog ("ワーカー用ウィンドウを用意できないため逐次で実行します: " + $_.Exception.Message) 'WARN'
                    $workerPages = $null
                }
                if ($null -eq $workerPages -or @($workerPages).Count -lt $maxWorkers) {
                    $maxWorkers = 1
                }

                if ($maxWorkers -le 1) {
                    $index = 0
                    foreach ($p in @($State.per_packet)) {
                        if ($State.cancel_requested) { $p.status = 'cancelled'; continue }
                        $State.current_packet = [string]$p.packet_id
                        $State.current_packets = @([string]$p.packet_id)
                        $p.status = 'running'
                        $p.started_at = (Get-Date).ToString('s')
                        & $touch
                        if (Invoke-KoseiPacket -Packet $p -State $State -Settings $settings -ReviewFlags $reviewFlags -AnswersDir $answersDir -PacketIndex $index -Touch $touch) { $fatalScreenFailure = $true }
                        $index++
                        if ($State.cancel_requested -or $fatalScreenFailure) { break }
                    }
                } else {
                    # パケットをワーカーへ配る（round-robin）。各ワーカーは**自分の分だけ**を触る。
                    $assign = @{}
                    for ($i = 0; $i -lt @($State.per_packet).Count; $i++) {
                        $w = $i % $maxWorkers
                        if (-not $assign.ContainsKey($w)) { $assign[$w] = New-Object System.Collections.ArrayList }
                        $null = $assign[$w].Add($i)
                    }
                    # 致命的失敗は共有フラグで伝える。1つのワーカーが「Copilot画面が準備できない」を
                    # 踏んだら、残りが同じ失敗を繰り返しても意味がないので全員が止まる。
                    $shared = [hashtable]::Synchronized(@{ fatal = $false })
                    $packetWorker = {
                        param($Root, $State, $Settings, $ReviewFlags, $AnswersDir, $Page, $Indices, $WorkerIndex, $Shared)
                        . (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
                        Set-KoseiRoot -Root $Root
                        Set-KoseiWorkerIndex -Index $WorkerIndex
                        . (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
                        . (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')
                        . (Join-Path (Join-Path $Root 'src') 'ReviewJob.ps1')
                        $touch = { $State.updated_at = (Get-Date).ToString('s') }
                        foreach ($i in @($Indices)) {
                            if ($State.cancel_requested -or $Shared.fatal) { break }
                            $p = $State.per_packet[$i]
                            $p.status = 'running'
                            $p.started_at = (Get-Date).ToString('s')
                            $State.current_packets = @(@($State.per_packet) | Where-Object { [string]$_.status -eq 'running' } | ForEach-Object { [string]$_.packet_id })
                            $State.current_packet = (@($State.current_packets) -join ', ')
                            & $touch
                            try {
                                if (Invoke-KoseiPacket -Packet $p -State $State -Settings $Settings -ReviewFlags $ReviewFlags -AnswersDir $AnswersDir -PacketIndex $i -Touch $touch -Page $Page) {
                                    $Shared.fatal = $true
                                }
                            } catch {
                                $p.status = 'error'
                                $p.error = [string]$_.Exception.Message
                                Write-KoseiLog ("パケット失敗 job=" + $State.id + " packet=" + $p.packet_id + ": " + $_.Exception.Message) 'ERROR'
                            }
                        }
                    }
                    $handles = @()
                    foreach ($w in 0..($maxWorkers - 1)) {
                        if (-not $assign.ContainsKey($w)) { continue }
                        $wps = [powershell]::Create()
                        $null = $wps.AddScript($packetWorker).
                            AddArgument($Root).AddArgument($State).AddArgument($settings).AddArgument($reviewFlags).
                            AddArgument($answersDir).AddArgument($workerPages[$w]).AddArgument(@($assign[$w])).AddArgument($w).AddArgument($shared)
                        $handles += @{ PowerShell = $wps; Async = $wps.BeginInvoke(); Worker = $w }
                    }
                    foreach ($h in $handles) {
                        try { $null = $h.PowerShell.EndInvoke($h.Async) }
                        catch { Write-KoseiLog ("worker" + $h.Worker + " が例外で終了: " + $_.Exception.Message) 'ERROR' }
                        finally { $h.PowerShell.Dispose() }
                    }
                    $fatalScreenFailure = [bool]$shared.fatal
                    $State.current_packets = @()
                    $State.current_packet = ''
                }
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
