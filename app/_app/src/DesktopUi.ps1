function Initialize-KoseiDesktopUi {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
}

# 完了通知（トレイの吹き出し）の差出人を「Windows PowerShell」ではなく「PDF校正アシスト」にする。
# 通知の差出人はプロセスの AppUserModelID で決まる。利用者ごとのレジストリに表示名を登録し、このプロセスをその ID にする。
# 窓を1つも作る前に呼ぶこと。失敗しても校正は続ける（差出人が PowerShell に戻るだけ）。
$script:KoseiNotificationAppId='PdfKoseiAssist.Proofreader'
function Set-KoseiNotificationIdentity {
    param([string]$AppId=$script:KoseiNotificationAppId,[string]$DisplayName='PDF校正アシスト')
    try {
        $key='HKCU:\Software\Classes\AppUserModelId\'+$AppId
        if(!(Test-Path -LiteralPath $key)){$null=New-Item -Path $key -Force}
        $null=New-ItemProperty -LiteralPath $key -Name DisplayName -Value $DisplayName -PropertyType String -Force
        if(!('Kosei.AppUserModel' -as [type])){Add-Type -Namespace Kosei -Name AppUserModel -MemberDefinition '[DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string appID);'}
        return ([Kosei.AppUserModel]::SetCurrentProcessExplicitAppUserModelID($AppId) -eq 0)
    } catch { return $false }
}

# 完了の知らせを、通知センターに残るトーストで出す。トレイの吹き出しは、アイコンを片付けると通知センターからも消える
# （実機で確認: 完了の通知を見落とすと、あとから確かめられなかった）。出せなかったら $false を返す（呼び出し側が吹き出しに戻す）。
function Show-KoseiToastNotification {
    param([Parameter(Mandatory=$true)][string]$AppId,[string]$Title='PDF校正アシスト',[Parameter(Mandatory=$true)][string]$Message)
    try {
        $null=[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
        $null=[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
        $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
        # 本文は行ごとに分けて並べる（トーストの文は3つまで：見出し＋2行）。
        $lines=@($Message -split "`r?`n" | Where-Object { $_ })
        if($lines.Count -gt 2){$lines=@($lines[0],(($lines[1..($lines.Count-1)]) -join ' '))}
        $body=($lines | ForEach-Object { '<text>'+[Security.SecurityElement]::Escape($_)+'</text>' }) -join ''
        $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>'+[Security.SecurityElement]::Escape($Title)+'</text>'+$body+'</binding></visual></toast>')
        $toast=New-Object Windows.UI.Notifications.ToastNotification $xml
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
        return $true
    } catch { return $false }
}

# 入口（Launch-KoseiAssist.ps1）が出した「起動しています…」の小さい窓を、次の画面を出すときに閉じる。
# 窓は入口が別スレッドで動かしているので、閉じる合図を送るだけでよい。
function Close-KoseiPendingLauncherSplash {
    $splash=$global:KoseiLauncherSplash
    if($splash){try{$splash.State.Close=$true}catch{};$global:KoseiLauncherSplash=$null}
}

function Show-KoseiDesktopDialog {
    param([string]$Message, [string]$Buttons='OK', [string]$Icon='Information')
    Initialize-KoseiDesktopUi
    Close-KoseiPendingLauncherSplash
    $owner=New-Object Windows.Forms.Form
    try {
        $owner.ShowInTaskbar=$false; $owner.TopMost=$true; $owner.Opacity=0
        $owner.StartPosition='CenterScreen'; $owner.Show()
        return [Windows.Forms.MessageBox]::Show($owner,$Message,'PDF校正アシスト',
            [Windows.Forms.MessageBoxButtons]$Buttons,[Windows.Forms.MessageBoxIcon]$Icon).ToString()
    } finally { $owner.Dispose() }
}

# 中止を押す前に、中止すると何が残らないかを伝える（押したあとに知っても遅い）。
$script:KoseiCancelConfirm='校正を中止しますか？'+"`n"+'途中までの結果は保存されません。元のPDFは変更されません。'

# どちらが英文か決められなかったとき、「はい／いいえ」ではなく、組み合わせそのものを選んでもらう。
# 返す値: 英文にするファイルの番号（0 か 1）。やめるときは -1。
function Show-KoseiDropRoleChoice {
    param([string[]]$Names)
    Initialize-KoseiDesktopUi
    Close-KoseiPendingLauncherSplash
    $short={param($n) $n=[string]$n;if($n.Length -gt 44){$n.Substring(0,43)+'…'}else{$n}}
    $form=New-Object Windows.Forms.Form
    $choice=@{Value=-1}
    try {
        $form.Text='PDF校正アシスト：どちらが英文ですか';$form.TopMost=$true;$form.StartPosition='CenterScreen'
        $form.ClientSize=New-Object Drawing.Size(560,250);$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
        $label=New-Object Windows.Forms.Label;$label.Text='どちらが校正する英文PDFか、自動で判定できませんでした。正しい組み合わせを選んでください。';$label.SetBounds(20,14,520,36);$form.Controls.Add($label)
        for($i=0;$i -lt 2;$i++){
            $button=New-Object Windows.Forms.Button
            $button.Text='校正する英文PDF：'+(& $short $Names[$i])+"`n"+'比較する日本語原稿：'+(& $short $Names[1-$i])
            $button.TextAlign='MiddleLeft';$button.SetBounds(20,(58+$i*70),520,60)
            $value=$i
            $button.Add_Click({$choice.Value=$value;$form.Close()}.GetNewClosure());$form.Controls.Add($button)
        }
        $cancel=New-Object Windows.Forms.Button;$cancel.Text='校正をやめる';$cancel.SetBounds(400,205,140,30)
        $cancel.Add_Click({$choice.Value=-1;$form.Close()}.GetNewClosure());$form.Controls.Add($cancel);$form.CancelButton=$cancel
        $null=$form.ShowDialog();return [int]$choice.Value
    } finally { $form.Dispose() }
}

# 「送る」の進み具合を見せる小さな画面。トレイのアイコンを探さなくても、始まったこと・待てばよいこと・止め方が分かるようにする。
# 閉じても校正は続く（隠すだけ）。トレイのアイコンの「進み具合を表示」かダブルクリックで、もう一度出せる。
function New-KoseiDropStatusForm {
    param([hashtable]$Shared)
    Initialize-KoseiDesktopUi
    $form=New-Object Windows.Forms.Form
    $form.Text='PDF校正アシスト';$form.ShowInTaskbar=$true
    $form.ClientSize=New-Object Drawing.Size(460,200);$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
    # 画面の中央に出すと、サインイン用に開く Edge に重なる。右下の隅に置く。
    $area=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.StartPosition='Manual';$form.Location=New-Object Drawing.Point([Math]::Max([int]$area.Left,[int]($area.Right-$form.Width-16)),[Math]::Max([int]$area.Top,[int]($area.Bottom-$form.Height-16)))
    $heading=New-Object Windows.Forms.Label;$heading.Text='英文PDFを校正しています';$heading.Font=New-Object Drawing.Font($form.Font.FontFamily,11,[Drawing.FontStyle]::Bold);$heading.SetBounds(16,12,428,24)
    $target=New-Object Windows.Forms.Label;$target.Text='対象：確認しています';$target.AutoEllipsis=$true;$target.SetBounds(16,42,428,20)
    $current=New-Object Windows.Forms.Label;$current.Text='現在：準備中';$current.AutoEllipsis=$true;$current.SetBounds(16,64,428,20)
    $hint=New-Object Windows.Forms.Label;$hint.Text='この画面を閉じても校正は続きます。終わると結果が開きます。'+"`n"+'もう一度見るときは、画面右下のアイコンを右クリック →「進み具合を表示」。';$hint.ForeColor=[Drawing.SystemColors]::GrayText;$hint.SetBounds(16,92,428,44)
    $close=New-Object Windows.Forms.Button;$close.Text='画面を閉じて続ける';$close.SetBounds(16,152,200,32)
    $cancel=New-Object Windows.Forms.Button;$cancel.Text='校正を中止';$cancel.SetBounds(324,152,120,32)
    $close.Add_Click({$form.Hide()}.GetNewClosure())
    $form.Add_FormClosing({param($sender,$event) if(!$Shared.Finished){$event.Cancel=$true;$sender.Hide()}}.GetNewClosure())
    $form.Controls.AddRange(@($heading,$target,$current,$hint,$close,$cancel));$form.AcceptButton=$close
    return @{Form=$form;Target=$target;Current=$current;Cancel=$cancel;Close=$close}
}

function ConvertTo-KoseiTrayText {
    param([string]$Text)
    $text='PDF校正アシスト：'+($Text -replace '\s+',' ').Trim()
    if($text.Length -gt 63){$text=$text.Substring(0,62)+'…'}
    return $text
}

function New-KoseiTrayContext {
    param([hashtable]$Shared)
    Initialize-KoseiDesktopUi
    $context=New-Object Windows.Forms.ApplicationContext
    $menu=New-Object Windows.Forms.ContextMenuStrip
    $status=$menu.Items.Add('状況：準備中');$status.Enabled=$false
    $progressItem=$menu.Items.Add('進み具合を表示')
    $show=$menu.Items.Add('Copilot画面を表示')
    $cancel=$menu.Items.Add('中止')
    # GetNewClosure の中からは、グローバル以外の関数を名前で呼べない（入口が & で入れ子に呼ばれるため）。参照を取っておく。
    $dialog=${function:Show-KoseiDesktopDialog};$confirm=$script:KoseiCancelConfirm
    $progressItem.Add_Click({$Shared.ShowStatusWindow=$true}.GetNewClosure())
    $show.Add_Click({$Shared.ShowCopilot=$true}.GetNewClosure())
    $cancel.Add_Click({
        if((& $dialog $confirm 'YesNo' 'Question') -eq 'Yes'){
            $Shared.CancelRequested=$true
            $cancel.Enabled=$false
            $Shared.Status='中止しています'
        }
    }.GetNewClosure())
    $tray=New-Object Windows.Forms.NotifyIcon
    $tray.Icon=[Drawing.SystemIcons]::Application
    $tray.ContextMenuStrip=$menu;$tray.Text=ConvertTo-KoseiTrayText '準備中';$tray.Visible=$true
    $tray.Add_DoubleClick({$Shared.ShowStatusWindow=$true}.GetNewClosure())
    return @{Context=$context;Menu=$menu;StatusItem=$status;ProgressItem=$progressItem;ShowItem=$show;CancelItem=$cancel;Tray=$tray}
}

function Invoke-KoseiDesktopWorker {
    param([hashtable]$Shared,[scriptblock]$Worker,[object[]]$WorkerArguments=@(),[string]$ProgressTitle='',[switch]$StatusWindow,[switch]$ShowStatusAtStart)
    Initialize-KoseiDesktopUi
    Close-KoseiPendingLauncherSplash
    $ui=New-KoseiTrayContext $Shared
    $statusUi=$null
    if($StatusWindow){
        $statusUi=New-KoseiDropStatusForm $Shared;$ui.StatusForm=$statusUi.Form
        # 画面の「校正を中止」は、トレイの「中止」と同じ確認・同じ動きにする。
        $trayCancel=$ui.CancelItem;$statusUi.Cancel.Add_Click({$trayCancel.PerformClick()}.GetNewClosure())
        if($ShowStatusAtStart){$Shared.ShowStatusWindow=$true}
    }else{$ui.ProgressItem.Visible=$false}
    $progress=$null;$progressLabel=$null
    if($ProgressTitle){
        $ui.Tray.Visible=$false
        $progress=New-Object Windows.Forms.Form
        $progress.Text=$ProgressTitle;$progress.TopMost=$true
        $progress.ClientSize=New-Object Drawing.Size(500,155);$progress.FormBorderStyle='FixedDialog';$progress.MaximizeBox=$false;$progress.MinimizeBox=$false
        # 画面の中央に出すと、サインイン用に開く Edge の入力欄に重なる。右下の隅に置く。
        $area=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $left=[Math]::Max([int]$area.Left,[int]($area.Right-$progress.Width-16));$top=[Math]::Max([int]$area.Top,[int]($area.Bottom-$progress.Height-16))
        $progress.StartPosition='Manual';$progress.Location=New-Object Drawing.Point($left,$top)
        $progressLabel=New-Object Windows.Forms.Label;$progressLabel.SetBounds(20,20,460,80)
        $progressCancel=New-Object Windows.Forms.Button;$progressCancel.Text='キャンセル';$progressCancel.SetBounds(360,110,120,28)
        $progressCancel.Add_Click({$Shared.CancelRequested=$true;$progressCancel.Enabled=$false}.GetNewClosure())
        $progress.Add_FormClosing({param($sender,$event) if(!$Shared.Finished){$event.Cancel=$true;$Shared.CancelRequested=$true}}.GetNewClosure())
        $progress.Controls.AddRange(@($progressLabel,$progressCancel));$progress.Show()
    }
    # Tick は GetNewClosure で作るので、使う関数は参照で渡す（New-KoseiTrayContext と同じ理由）。
    $trayText=${function:ConvertTo-KoseiTrayText};$dialog=${function:Show-KoseiDesktopDialog};$toast=${function:Show-KoseiToastNotification};$roleChoice=${function:Show-KoseiDropRoleChoice}
    $workerShell=[powershell]::Create()
    $timer=New-Object Windows.Forms.Timer
    # 通知（トレイの吹き出し）は、アイコンを片付けると Windows に届く前に取り下げられる（差出人を「PDF校正アシスト」に
    # してから、完了の通知だけが出なくなった）。最後の通知を出したら、少し待ってからアイコンを片付ける。
    $state=@{Busy=$false;Notification='';Ended=$false;NotifiedAt=[DateTime]::MinValue;ExitAt=[DateTime]::MinValue}
    try {
        $null=$workerShell.AddScript($Worker.ToString())
        foreach($argument in $WorkerArguments){$null=$workerShell.AddArgument($argument)}
        $async=$workerShell.BeginInvoke()
        $timer.Interval=100
        $timer.Add_Tick({
            if($state.Busy){return}
            if($state.Ended){
                if([DateTime]::UtcNow -ge $state.ExitAt){$timer.Stop();$ui.Context.ExitThread()}
                return
            }
            $state.Busy=$true
            try {
                $ui.Tray.Text=& $trayText ([string]$Shared.Status)
                $ui.StatusItem.Text='状況：'+[string]$Shared.Status
                if($progressLabel){$progressLabel.Text=[string]$Shared.Status}
                if($statusUi){
                    $statusUi.Current.Text='現在：'+[string]$Shared.Status
                    if($Shared.TargetName){$statusUi.Target.Text='対象：'+[string]$Shared.TargetName}
                    if($Shared.CancelRequested){$statusUi.Cancel.Enabled=$false}
                    if($Shared.ShowStatusWindow){$Shared.ShowStatusWindow=$false;$statusUi.Form.Show();$statusUi.Form.WindowState='Normal';$statusUi.Form.Activate()}
                }
                if($Shared.Notification -and $Shared.Notification -ne $state.Notification){
                    $state.Notification=[string]$Shared.Notification
                    $ui.Tray.ShowBalloonTip(5000,'PDF校正アシスト',$state.Notification,[Windows.Forms.ToolTipIcon]::Info)
                    $state.NotifiedAt=[DateTime]::UtcNow
                }
                if($Shared.RoleChoice){
                    $names=@($Shared.RoleChoice);$Shared.RoleChoice=$null
                    $Shared.Answer=& $roleChoice $names
                }
                if($async.IsCompleted){
                    $state.Ended=$true
                    try{$null=$workerShell.EndInvoke($async)}catch{$Shared.Error=$_.Exception.Message;$Shared.ExitCode=1}
                    if($workerShell.HadErrors -and !$Shared.Error){$Shared.Error=[string]$workerShell.Streams.Error[0];$Shared.ExitCode=1}
                    $Shared.Finished=$true
                    if($statusUi){$statusUi.Form.Hide()}
                    if($Shared.CompletionNotice -and !$Shared.Error){
                        $shown=$false;$title=if($Shared.CompletionTitle){[string]$Shared.CompletionTitle}else{'PDF校正アシスト'}
                        if($Shared.NotificationAppId){$shown=& $toast -AppId ([string]$Shared.NotificationAppId) -Title $title -Message ([string]$Shared.CompletionNotice)}
                        if(!$shown){$ui.Tray.ShowBalloonTip(5000,$title,[string]$Shared.CompletionNotice,[Windows.Forms.ToolTipIcon]::Info);$state.NotifiedAt=[DateTime]::UtcNow}
                    }
                    if($Shared.Error){$null=& $dialog ([string]$Shared.Error) 'OK' 'Error'}
                    elseif($Shared.FinalNotice){$null=& $dialog ([string]$Shared.FinalNotice) 'OK' 'Information'}
                    $linger=$state.NotifiedAt.AddSeconds(8)
                    $state.ExitAt=$(if($linger -gt [DateTime]::UtcNow){$linger}else{[DateTime]::UtcNow})
                }
            } catch {
                $Shared.Error=$_.Exception.Message;$Shared.ExitCode=1;$Shared.CancelRequested=$true
                $timer.Stop();$ui.Context.ExitThread()
            } finally {$state.Busy=$false}
        }.GetNewClosure())
        $timer.Start()
        [Windows.Forms.Application]::Run($ui.Context)
    } finally {
        $timer.Stop();$timer.Dispose()
        $ui.Tray.Visible=$false;$ui.Tray.Dispose();$ui.Menu.Dispose();$ui.Context.Dispose()
        if($progress){$Shared.Finished=$true;$progress.Close();$progress.Dispose()}
        if($statusUi){$Shared.Finished=$true;$statusUi.Form.Close();$statusUi.Form.Dispose()}
        if(!$state.Ended){$Shared.CancelRequested=$true;$workerShell.Stop()}
        $workerShell.Dispose()
    }
}

function Show-KoseiSetupChoice {
    Initialize-KoseiDesktopUi
    Close-KoseiPendingLauncherSplash
    $form=New-Object Windows.Forms.Form
    $choice=@{Value='Cancel'}
    try {
        $form.Text='PDF校正アシスト：「送る」への登録';$form.TopMost=$true;$form.StartPosition='CenterScreen'
        $form.ClientSize=New-Object Drawing.Size(510,130);$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
        $label=New-Object Windows.Forms.Label;$label.Text='「送る」には登録済みです。サインインをやり直すときや、共有フォルダの場所が変わったときは「登録し直す」を押してください。';$label.SetBounds(20,14,470,48);$form.Controls.Add($label)
        $options=@(@('登録し直す','Register'),@('「送る」から削除する','Remove'),@('キャンセル','Cancel'))
        for($i=0;$i -lt $options.Count;$i++){
            $button=New-Object Windows.Forms.Button;$button.Text=$options[$i][0];$button.SetBounds((20+$i*160),80,150,30)
            $value=$options[$i][1]
            $button.Add_Click({$choice.Value=$value;$form.Close()}.GetNewClosure());$form.Controls.Add($button)
        }
        $null=$form.ShowDialog();return $choice.Value
    }finally{$form.Dispose()}
}
