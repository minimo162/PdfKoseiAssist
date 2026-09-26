# 「送る」のトレイ（ツールチップと右クリックメニューの「状況：」）に出す短い文（issue #182）。
# status().progress（カードを描く元の状態）から作る。画面の文字（card/detail）はログにだけ残す。
# ツールチップは接頭辞「PDF校正アシスト：」（10文字）込みで63文字までなので、本文は53文字に収める。
function ConvertTo-KoseiDropStatusText {
    param($Progress,[int]$MaxLength=53)
    if(!$Progress){return '準備中'}
    switch([string]$Progress.phase){
        'running' {break}
        'needs_user_visibility' {return 'Copilot画面の確認待ち'}
        'importing' {return '結果を取り込んでいます'}
        'done' {return '結果をまとめています'}
        default {return '準備中'}
    }
    $label=([string]$Progress.stage_label -replace '\s+',' ').Trim()
    if(!$label){$label='校正中'}
    $tail=''
    $done=0;$total=0
    [void][int]::TryParse([string]$Progress.done,[ref]$done);[void][int]::TryParse([string]$Progress.total,[ref]$total)
    if($total -gt 0){$tail=' '+$done+'/'+$total}
    $remaining=([string]$Progress.remaining_label -replace '\s+','')
    if($remaining){$tail+='・残り'+$remaining}
    if($tail.Length -gt $MaxLength-2){$tail=$tail.Substring(0,$MaxLength-2)}
    $room=$MaxLength-$tail.Length
    if($label.Length -gt $room){$label=$label.Substring(0,$room-1)+'…'}
    return $label+$tail
}

function Invoke-KoseiDropReview {
    param([string[]]$Paths, [hashtable]$Shared, [int]$TimeoutMinutes=180)
    $root = Get-KoseiRoot
    $settings = Get-KoseiSettings
    $version = Get-KoseiAppVersion
    $id = [guid]::NewGuid().ToString('N')
    $session = $null; $ownedServer=$false; $url=''; $targetId=''; $browserWs=''; $pageWs=''; $success=$false; $ownJobId=''
    $signin = 'Copilot にサインインしていません。「PDF校正アシスト_初回セットアップ.cmd」を実行してサインインしてから、もう一度「送る」を実行してください。'
    function Invoke-DropHttp([string]$Path,[string]$Method='GET',[string]$Body='{}') {
        $params=@{Uri=($url.TrimEnd('/')+$Path);Method=$Method;TimeoutSec=10;UseBasicParsing=$true}
        if ($Method -eq 'POST') { $params.Body=$Body;$params.ContentType='application/json';$params.Headers=@{Origin=$url.TrimEnd('/')} }
        Invoke-RestMethod @params
    }
    function Invoke-DropApp([string]$Expression,[int]$Timeout=120) { Invoke-KoseiCdpEval -WebSocketUrl $pageWs -Expression $Expression -TimeoutSeconds $Timeout }
    function Assert-DropContinue {
        if ($Shared.CancelRequested) { throw '校正を中止しました。途中までの結果は保存していません。' }
    }
    function Wait-Drop([int]$Milliseconds) {
        $until=(Get-Date).AddMilliseconds($Milliseconds)
        while ((Get-Date) -lt $until) { Assert-DropContinue; Start-Sleep -Milliseconds 100 }
    }
    try {
        if (Get-Command Repair-KoseiSendToShortcut -ErrorAction SilentlyContinue) {
            $repair=Repair-KoseiSendToShortcut
            if(!$repair.ok){Write-KoseiLog ('sendto repair warning: '+$repair.error) 'WARN'}
        }
        $inputs = @(Resolve-KoseiDropInputs $Paths)
        $session = Join-Path (Get-KoseiSubDir 'drop') $id
        $null = New-Item -ItemType Directory -Path $session
        $Shared.Session=$session
        $names=@($inputs | ForEach-Object { [IO.Path]::GetFileName($_) })
        for ($i=0;$i -lt $inputs.Count;$i++) { [IO.File]::Copy($inputs[$i],(Join-Path $session ('input'+($i+1)+'.pdf'))) }
        [IO.File]::WriteAllText((Join-Path $session 'session.json'),(@{id=$id;names=$names;version=$version} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        Write-KoseiLog "drop start version=$version app=$root id=$id files=$($names -join ',')"
        foreach ($port in $settings.server_ports) {
            try { $health=Invoke-RestMethod -Uri "http://127.0.0.1:$port/__health" -TimeoutSec 1 -UseBasicParsing } catch { continue }
            if ($health.ok) {
                if ([string]$health.version -ne $version) { throw ('別の版のアプリが起動中です（起動中: v'+$(if($health.version){[string]$health.version}else{'不明'})+' / この操作: v'+$version+'）。アプリ画面の「アプリを終了」で終了してから、もう一度「送る」を実行してください。アプリの画面が見当たらないときは、少し待ってからやり直すか、パソコンを再起動してください。') }
                $url="http://127.0.0.1:$port/";break
            }
        }
        if (!$url) {
            $start=Get-Date
            $process=Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $root 'Start-KoseiAssist.ps1')+'"'),'-NoBrowser','-DropMode')
            $ownedServer=$true
            $urlFile=Get-KoseiLocalAppUrlPath
            while ((Get-Date)-lt $start.AddSeconds(60)) {
                Assert-DropContinue
                if ((Test-Path -LiteralPath $urlFile) -and (Get-Item -LiteralPath $urlFile).LastWriteTime -ge $start) {
                    $candidate=[IO.File]::ReadAllText($urlFile).Trim()
                    try { $health=Invoke-RestMethod -Uri ($candidate+'__health') -TimeoutSec 1 -UseBasicParsing; if($health.ok -and $health.version -eq $version){$url=$candidate;break} } catch {}
                }
                if ($process.HasExited) { throw ('アプリを起動できませんでした。もう一度「送る」を実行してください。直らないときは、'+(Get-KoseiStartupLogPath)+' を管理者に渡してください。') }
                Wait-Drop 250
            }
            if (!$url) { throw 'アプリが60秒以内に起動しませんでした。もう一度「送る」を実行してください。直らないときは「PDF校正アシスト起動.cmd」をダブルクリックして、画面で校正してください。' }
        }
        $Shared.Url=$url
        $ready=Invoke-DropHttp '/api/ready-state'
        if ($ready.job_running) { throw '別の校正を実行中です。終わってから、もう一度「送る」を実行してください。' }
        $deadline=(Get-Date).AddSeconds(120)
        while ($ready.state -in @('preparing','signin_required') -and (Get-Date)-lt $deadline) { $Shared.Status='Copilotの準備を待っています';Wait-Drop 500;$ready=Invoke-DropHttp '/api/ready-state' }
        if ($ready.state -eq 'signin_required') { throw $signin }
        if ($ready.state -ne 'ready') { Write-KoseiLog ("drop id=$id ready-state="+[string]$ready.state+' detail='+[string]$ready.detail) 'WARN'; throw 'Copilot の画面が時間内に準備できませんでした。少し待ってから、もう一度「送る」を実行してください。' }
        $browser=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$settings.cdp_port+'/json/version') -UseBasicParsing
        $browserWs=[string]$browser.webSocketDebuggerUrl
        $created=Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.createTarget' -Params @{url='about:blank';newWindow=$true;background=$false;left=-32000;top=0;width=1200;height=900} -TimeoutSeconds 20
        if ($created.error) { throw '校正の準備に失敗しました。PDF校正アシスト用の Edge の画面をすべて閉じてから、もう一度「送る」を実行してください。' }
        $targetId=[string]$created.result.targetId
        $window=Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Browser.getWindowForTarget' -Params @{targetId=$targetId}
        $null=Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Browser.setWindowBounds' -Params @{windowId=[int]$window.result.windowId;bounds=@{left=-32000;top=0;width=1200;height=900}}
        for($i=0;$i -lt 30;$i++) {
            $target=@(Get-KoseiCdpTargets -Port ([int]$settings.cdp_port) | Where-Object { $_.id -eq $targetId }) | Select-Object -First 1
            if($target.webSocketDebuggerUrl){$pageWs=[string]$target.webSocketDebuggerUrl;break};Wait-Drop 200
        }
        if(!$pageWs){throw '校正の準備に失敗しました。PDF校正アシスト用の Edge の画面をすべて閉じてから、もう一度「送る」を実行してください。'}
        $null=Invoke-KoseiCdpMethod -WebSocketUrl $pageWs -Method 'Page.navigate' -Params @{url=($url+'?drop='+$id)}
        $hookVersion='';$deadline=(Get-Date).AddSeconds(60)
        while((Get-Date)-lt $deadline){try{$hookVersion=[string](Invoke-DropApp 'window.__koseiAutomation && window.__koseiAutomation.version' 5)}catch{};if($hookVersion){break};Wait-Drop 250}
        if(!$hookVersion){throw 'アプリの画面が時間内に開きませんでした。もう一度「送る」を実行してください。'}
        if($hookVersion -ne $version){throw ('別の版のアプリ画面です（画面: v'+$hookVersion+' / この操作: v'+$version+'）。アプリを終了してやり直してください。')}
        $visibility=Invoke-DropApp 'document.visibilityState' 5
        if($visibility -ne 'visible'){throw '校正用の画面を表示できませんでした。もう一度「送る」を実行してください。直らないときは「PDF校正アシスト起動.cmd」をダブルクリックして、画面で校正してください。'}
        $languages=@()
        if($inputs.Count -eq 2){for($i=1;$i -le 2;$i++){$detected=Invoke-DropApp ("window.__koseiAutomation.detectLanguage('/api/drop/$id/input/$i')");$languages += [string]$detected.language}}
        if($inputs.Count -eq 1){
            # 1つだけ送られたときも、日本語の原稿だけを選んでいないかを見る（英文として校正してしまわないように）。
            $single='';try{$single=[string](Invoke-DropApp ("window.__koseiAutomation.detectLanguage('/api/drop/$id/input/1')")).language}catch{Write-KoseiLog "drop id=$id language check skipped: $($_.Exception.Message)" 'WARN'}
            if($single -eq '日本語'){throw ('「'+$names[0]+'」は日本語のPDFのようです。このアプリは英文のPDFを校正します。英文のPDFを選んで（日本語の原稿と2つ選んでも構いません）、もう一度「送る」を実行してください。')}
        }
        $assignment=Get-KoseiDropAssignment -Names $names -Languages $languages
        if($assignment.needs_prompt){
            if($Shared.NoTray){throw '英文を判定できません。ファイル名に _en または _ja を付けてください。'}
            $Shared.Answer=$null;$Shared.Prompt='どちらが英文のPDFか判定できませんでした。'+"`n"+'英文は「'+$names[0]+'」ですか？'+"`n`n"+'はい：「'+$names[0]+'」が英文です'+"`n"+'いいえ：「'+$names[1]+'」が英文です'+"`n"+'キャンセル：校正をやめます'
            while($null -eq $Shared.Answer){Wait-Drop 100}
            if($Shared.Answer -eq 'Cancel'){throw '校正を中止しました。'}
            $assignment.target=if($Shared.Answer -eq 'Yes'){0}else{1};$assignment.reference=1-$assignment.target
        }
        $targetIndex=[int]$assignment.target;$refIndex=[int]$assignment.reference
        $Shared.Notification='校正を始めました：'+$names[$targetIndex]+$(if($refIndex -ge 0){'（比較資料：'+$names[$refIndex]+'）'}else{'（比較資料なし）'})
        $display=$names[$targetIndex] | ConvertTo-Json -Compress
        try {
            $null=Invoke-DropApp ("window.__koseiAutomation.loadTarget('/api/drop/$id/input/"+($targetIndex+1)+"',"+$display+")")
            if($refIndex -ge 0){$display=$names[$refIndex]|ConvertTo-Json -Compress;$null=Invoke-DropApp ("window.__koseiAutomation.loadReference('/api/drop/$id/input/"+($refIndex+1)+"',"+$display+")")}
        } catch {
            # 読めないPDF（パスワード付き・壊れている）の技術的なエラー文は利用者に見せず、ログにだけ残す。
            Write-KoseiLog "drop id=$id load failed: $($_.Exception.Message)" 'WARN'
            $loadNames=[string]$names[$targetIndex];if($refIndex -ge 0){$loadNames+='、'+[string]$names[$refIndex]}
            throw ('PDFを読み込めませんでした（'+$loadNames+'）。パスワード付きのPDFや、壊れているPDFは校正できません。PDFを開けるか確かめてから、もう一度「送る」を実行してください。')
        }
        $null=Invoke-DropApp 'window.__koseiAutomation.selectAllPages()'
        if($refIndex -ge 0){$null=Invoke-DropApp 'window.__koseiAutomation.autoReferenceRange()'}
        Assert-DropContinue
        $ready=Invoke-DropHttp '/api/ready-state';if($ready.job_running){throw '別の校正を実行中です。終わってから、もう一度「送る」を実行してください。'}
        $Shared.Status='準備中'
        $null=Invoke-DropApp 'window.__koseiAutomation.startFull()'
        $started=Get-Date;$seenRunning=$false;$lastStatus='';$visibilityShown=$false
        while($true){
            if(((Get-Date)-$started).TotalMinutes -ge $TimeoutMinutes){throw '時間切れのため校正を中止しました。途中までの結果は保存していません。ページ数の多いPDFは、「PDF校正アシスト起動.cmd」から範囲を分けて校正してください。'}
            Assert-DropContinue
            $status=Invoke-DropApp 'window.__koseiAutomation.status()' 15
            if($status.job_id){$ownJobId=[string]$status.job_id}
            if($status.running){$seenRunning=$true}
            $description=([string]$status.card+' '+[string]$status.detail).Trim()
            if($description -ne $lastStatus){Write-KoseiLog "drop id=$id $description";$lastStatus=$description}
            if(!$Shared.CancelRequested){$Shared.Status=ConvertTo-KoseiDropStatusText $status.progress}
            if($Shared.ShowCopilot -or (!$visibilityShown -and $description -match 'needs_user_visibility|クリックしてください|表示操作')){
                $null=Show-KoseiCopilotEdgeWindow -Settings $settings;$Shared.ShowCopilot=$false;$visibilityShown=$true
                $Shared.Notification='Edge の Copilot 画面を一度クリックしてください。クリックすると校正が続きます。'
            }
            if($status.needs_user_visibility){
                if(!$visibilityShown){$null=Show-KoseiCopilotEdgeWindow -Settings $settings;$visibilityShown=$true;$Shared.Notification='Edge の Copilot 画面を一度クリックしてください。クリックすると校正が続きます。'}
                Wait-Drop 5000;continue
            }
            if(!$status.running){
                if($seenRunning){break}
                if($status.last_error){if($status.last_error -match '428|signin|サインイン'){throw $signin};Write-KoseiLog ("drop id=$id last_error="+[string]$status.last_error) 'WARN';throw '校正を開始できませんでした。もう一度「送る」を実行してください。直らないときは「PDF校正アシスト起動.cmd」をダブルクリックして、画面で校正してください。'}
                if(((Get-Date)-$started).TotalSeconds -ge 10){throw '校正を開始できませんでした。もう一度「送る」を実行してください。直らないときは「PDF校正アシスト起動.cmd」をダブルクリックして、画面で校正してください。'}
            }
            if(((Get-Date)-$started).TotalMinutes -ge $TimeoutMinutes){throw '時間切れのため校正を中止しました。途中までの結果は保存していません。ページ数の多いPDFは、「PDF校正アシスト起動.cmd」から範囲を分けて校正してください。'}
            Wait-Drop 5000
        }
        $Shared.Status='レポートを作成しています'
        $packets=Invoke-DropApp 'window.__koseiAutomation.packets()'
        $failed=@($packets|Where-Object{$_.status -ne 'done' -and $_.status -ne 'completed' -and $_.status -ne 'success' -and $_.status -ne 'warning'}).Count
        $report=Invoke-DropApp ("window.__koseiAutomation.exportReportZip('/api/drop/$id/report')") 300
        $result=Expand-KoseiDropReport -ZipPath (Join-Path $session 'report.zip') -TargetPath $inputs[$targetIndex] -Incomplete:($failed -gt 0)
        $Shared.Result=$result.path
        if($settings.drop_open_report -ne $false){
            $null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',('"'+(Join-Path $result.path '_data/report-server.ps1')+'"'))
        }else{$null=Start-Process explorer.exe -ArgumentList ('"'+$result.path+'"')}
        # 完了の知らせは組み立ててから1回で渡す（途中の文を通知にしない）。通知センターに残る形で出す（DesktopUi）。
        $done='校正が終わりました：指摘 '+$report.findings+'件（一覧から外したもの '+$report.excluded+'件）。'
        if($failed){$done+='一部の範囲を確認できませんでした（'+$failed+'件）。レポートで確認してください。'}
        if($result.fallback){$done+='元のフォルダに保存できなかったため、ドキュメント\PDF校正アシスト結果 に保存しました。'}
        $Shared.CompletionNotice=$done
        # 通知はすぐ消えることがあるので、見落とすと困る知らせ（一部未完了・保存先の変更）は画面でも出す。
        if($failed -or $result.fallback){$Shared.FinalNotice=$done}
        $Shared.ExitCode=if($failed){2}else{0};$success=$true
    } catch {
        $Shared.Error=[string]$_.Exception.Message
        # 技術的なエラー文（ブラウザー操作・通信の詳細）は利用者に見せず、ログにだけ残して分かる文に置き換える。
        if($Shared.Error -match 'JavaScript evaluation failed|Uncaught|exceptionId|WebSocket|webSocketDebuggerUrl|/api/drop/|Unable to connect|The operation has timed out|操作はタイムアウト'){
            Write-KoseiLog "drop id=$id technical error: $($Shared.Error)" 'ERROR'
            $Shared.Error='校正を続けられませんでした。もう一度「送る」を実行してください。直らないときは、はじめにお読みください.txt の「どれにも当てはまらない」の手順で管理者に連絡してください。'
        }
        foreach($inputPath in $Paths){if($inputPath){$Shared.Error=$Shared.Error.Replace($inputPath,[IO.Path]::GetFileName($inputPath))}}
        $Shared.ExitCode=1
        Write-KoseiLog "drop id=$id error=$($Shared.Error)" 'ERROR'
    } finally {
        $shutdownBody='{}'
        if(!$success -and $pageWs){
            try {
                $status=Invoke-DropApp 'window.__koseiAutomation.status()' 5
                if($status.job_id){$ownJobId=[string]$status.job_id}
                if($status.running -or $status.needs_user_visibility){$null=Invoke-DropApp 'window.__koseiAutomation.cancel()' 10}
                if($ownJobId){
                    $deadline=(Get-Date).AddSeconds(30)
                    do{
                        $job=Invoke-DropHttp ('/api/review/jobs/'+$ownJobId)
                        $checkpointPending=$job.mode -eq 'cancelled' -and !$job.recovery_checkpoint_ready -and !$job.recovery_acknowledged
                        if($job.mode -notin @('queued','running') -and !$checkpointPending){break}
                        Start-Sleep -Milliseconds 200
                    }while((Get-Date)-lt $deadline)
                    if($ownedServer -and $job.mode -eq 'cancelled' -and $job.result_retained -and $job.recovery_checkpoint_ready){
                        $stateJson=$job|ConvertTo-Json -Depth 30 -Compress
                        $ack=Invoke-DropApp ('window.__koseiAutomation.acknowledgeCancelled('+$stateJson+')') 15
                        $shutdownBody=@{shutdown_intent_job_id=$ack.job_id;shutdown_intent_chain_id=$ack.chain_id}|ConvertTo-Json -Compress
                    }
                }
            } catch { Write-KoseiLog "drop id=$id cancellation cleanup could not be confirmed: $($_.Exception.Message)" 'WARN' }
        }
        if($targetId){try{$null=Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.closeTarget' -Params @{targetId=$targetId} -TimeoutSeconds 10}catch{}}
        if($ownedServer -and $url){try{$null=Invoke-DropHttp '/__shutdown' 'POST' $shutdownBody}catch{Write-KoseiLog "drop id=$id server retained (shutdown rejected)" 'WARN'}}
        if($ownedServer -and !$url -and $process -and !$process.HasExited){try{Stop-Process -Id $process.Id -ErrorAction Stop}catch{}}
        if($success -and $session){
            $expected=Join-Path (Get-KoseiSubDir 'drop') $id
            if([IO.Path]::GetFullPath($session) -eq [IO.Path]::GetFullPath($expected) -and $id -match '^[0-9a-f]{32}$'){Remove-Item -LiteralPath $session -Recurse -Force}
        }
        $Shared.Finished=$true
    }
}
