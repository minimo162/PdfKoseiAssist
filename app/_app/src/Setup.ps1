function Get-KoseiSetupServer {
    param($Settings=(Get-KoseiSettings))
    $version=Get-KoseiAppVersion
    foreach($port in $Settings.server_ports){
        try{$health=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/__health" -TimeoutSec 1}catch{continue}
        if($health.ok){
            if([string]$health.version -ne $version){throw ('別の版のアプリが起動中です（起動中: v'+$(if($health.version){$health.version}else{'不明'})+' / この操作: v'+$version+'）。アプリ画面の「アプリを終了」で終了してから、もう一度セットアップを実行してください。アプリの画面が見当たらないときは、少し待ってからやり直すか、パソコンを再起動してください。')}
            return "http://127.0.0.1:$port/"
        }
    }
    return ''
}

function Invoke-KoseiSetup {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    try {
        $root=Get-KoseiRoot;$settings=Get-KoseiSettings
        $existing=Get-KoseiSetupServer -Settings $settings
        $choice='Register'
        if(Test-Path -LiteralPath (Get-KoseiSendToPath $SendToFolder)){$choice=Show-KoseiSetupChoice}
        if($choice -eq 'Cancel'){Write-KoseiLog 'setup cancelled';return 0}
        if($choice -eq 'Remove'){
            $result=Remove-KoseiSendToShortcut -SendToFolder $SendToFolder
            if(!$result.ok){throw $result.error}
            $null=Show-KoseiDesktopDialog '「送る」から削除しました。'
            Write-KoseiLog 'setup removed';return 0
        }
        $result=Set-KoseiSendToShortcut -Root $root -SendToFolder $SendToFolder
        if(!$result.ok){throw $result.error}
        Write-KoseiLog ('setup registered version='+(Get-KoseiAppVersion))
        $shared=[hashtable]::Synchronized(@{Status='Copilotの準備を確認しています。';Error='';ExitCode=1;Finished=$false;CancelRequested=$false;SignInShown=$false})
        $worker={
            param($Root,$Shared,$Reuse)
            $ErrorActionPreference='Stop'
            . (Join-Path $Root 'src/Paths.ps1');Set-KoseiRoot $Root
            . (Join-Path $Root 'src/Settings.ps1');. (Join-Path $Root 'src/CopilotClient.ps1')
            $settings=Get-KoseiSettings
            try {
                $result=Invoke-KoseiCopilotWarmup -Settings $settings -TimeoutSeconds 600 -ReuseExisting:$Reuse -PublishStatus:$false -PromptOnMissingInput -ShouldCancel {$Shared.CancelRequested} -OnState {
                    param($State,$Detail)
                    if($State -eq 'signin_required'){
                        $Shared.Status='このアプリ専用の Edge が開きます。会社のアカウントで Microsoft 365 にサインインしてください。サインインが済むと、この画面は自動で閉じます。'
                        if(!$Shared.SignInShown){$Shared.SignInShown=$true;$null=Show-KoseiCopilotEdgeWindow -Settings $settings}
                    }elseif($State -eq 'preparing'){$Shared.Status=$Detail}
                }
                if($Shared.CancelRequested){$Shared.Error='セットアップを中止しました。「送る」の登録は残しています。サインインがまだのときは、あとでもう一度「PDF校正アシスト_初回セットアップ.cmd」を実行してください。'}
                elseif($result.state -eq 'ready'){$Shared.ExitCode=0}
                else{Write-KoseiLog ('setup warmup '+[string]$result.state+': '+[string]$result.detail) 'WARN';$Shared.Error='サインインを確認できませんでした。もう一度「PDF校正アシスト_初回セットアップ.cmd」をダブルクリックし、「登録し直す」を選んで、開いた Edge でサインインしてください。「送る」の登録は残しています。'}
            }finally{
                try{$page=Get-KoseiCopilotPage -Settings $settings;$null=Set-KoseiEdgeWindowMinimized -Settings $settings -Page $page -Reason 'setup-complete'}catch{}
            }
        }
        Invoke-KoseiDesktopWorker -Shared $shared -Worker $worker -WorkerArguments @($root,$shared,[bool]$existing) -ProgressTitle 'PDF校正アシスト：初回セットアップ'
        if($shared.ExitCode -ne 0){Write-KoseiLog ('setup incomplete: '+$shared.Error) 'WARN';return 1}
        $null=Show-KoseiDesktopDialog '準備ができました。英文PDFと日本語の原稿PDFを同じフォルダに置き、2つを選んで右クリック →「送る」→「PDF校正アシストで校正」を選んでください。Windows 11 では、右クリック →「その他のオプションを確認」の中に「送る」があります。'
        Write-KoseiLog 'setup ready';return 0
    }catch{
        Write-KoseiLog ('setup error: '+$_.Exception.Message) 'ERROR'
        $null=Show-KoseiDesktopDialog $_.Exception.Message 'OK' 'Error'
        return 1
    }
}
