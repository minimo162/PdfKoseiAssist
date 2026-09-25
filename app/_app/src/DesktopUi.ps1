function Initialize-KoseiDesktopUi {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
}

function Show-KoseiDesktopDialog {
    param([string]$Message, [string]$Buttons='OK', [string]$Icon='Information')
    Initialize-KoseiDesktopUi
    $owner=New-Object Windows.Forms.Form
    try {
        $owner.ShowInTaskbar=$false; $owner.TopMost=$true; $owner.Opacity=0
        $owner.StartPosition='CenterScreen'; $owner.Show()
        return [Windows.Forms.MessageBox]::Show($owner,$Message,'PDF校正アシスト',
            [Windows.Forms.MessageBoxButtons]$Buttons,[Windows.Forms.MessageBoxIcon]$Icon).ToString()
    } finally { $owner.Dispose() }
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
    $show=$menu.Items.Add('Copilot画面を表示')
    $cancel=$menu.Items.Add('中止')
    # GetNewClosure の中からは、グローバル以外の関数を名前で呼べない（入口が & で入れ子に呼ばれるため）。参照を取っておく。
    $dialog=${function:Show-KoseiDesktopDialog}
    $show.Add_Click({$Shared.ShowCopilot=$true}.GetNewClosure())
    $cancel.Add_Click({
        if((& $dialog '校正を中止しますか？' 'YesNo' 'Question') -eq 'Yes'){
            $Shared.CancelRequested=$true
            $cancel.Enabled=$false
            $Shared.Status='中止しています'
        }
    }.GetNewClosure())
    $tray=New-Object Windows.Forms.NotifyIcon
    $tray.Icon=[Drawing.SystemIcons]::Application
    $tray.ContextMenuStrip=$menu;$tray.Text=ConvertTo-KoseiTrayText '準備中';$tray.Visible=$true
    return @{Context=$context;Menu=$menu;StatusItem=$status;ShowItem=$show;CancelItem=$cancel;Tray=$tray}
}

function Invoke-KoseiDesktopWorker {
    param([hashtable]$Shared,[scriptblock]$Worker,[object[]]$WorkerArguments=@(),[string]$ProgressTitle='')
    Initialize-KoseiDesktopUi
    $ui=New-KoseiTrayContext $Shared
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
    $trayText=${function:ConvertTo-KoseiTrayText};$dialog=${function:Show-KoseiDesktopDialog}
    $workerShell=[powershell]::Create()
    $timer=New-Object Windows.Forms.Timer
    $state=@{Busy=$false;Notification='';Ended=$false}
    try {
        $null=$workerShell.AddScript($Worker.ToString())
        foreach($argument in $WorkerArguments){$null=$workerShell.AddArgument($argument)}
        $async=$workerShell.BeginInvoke()
        $timer.Interval=100
        $timer.Add_Tick({
            if($state.Busy){return}
            $state.Busy=$true
            try {
                $ui.Tray.Text=& $trayText ([string]$Shared.Status)
                $ui.StatusItem.Text='状況：'+[string]$Shared.Status
                if($progressLabel){$progressLabel.Text=[string]$Shared.Status}
                if($Shared.Notification -and $Shared.Notification -ne $state.Notification){
                    $state.Notification=[string]$Shared.Notification
                    $ui.Tray.ShowBalloonTip(5000,'PDF校正アシスト',$state.Notification,[Windows.Forms.ToolTipIcon]::Info)
                }
                if($Shared.Prompt){
                    $prompt=[string]$Shared.Prompt;$Shared.Prompt=''
                    $Shared.Answer=& $dialog $prompt 'YesNoCancel' 'Question'
                }
                if($async.IsCompleted){
                    $state.Ended=$true
                    try{$null=$workerShell.EndInvoke($async)}catch{$Shared.Error=$_.Exception.Message;$Shared.ExitCode=1}
                    if($workerShell.HadErrors -and !$Shared.Error){$Shared.Error=[string]$workerShell.Streams.Error[0];$Shared.ExitCode=1}
                    if($Shared.Error){$null=& $dialog ([string]$Shared.Error) 'OK' 'Error'}
                    elseif($Shared.FinalNotice){$null=& $dialog ([string]$Shared.FinalNotice) 'OK' 'Information'}
                    $Shared.Finished=$true
                    $timer.Stop();$ui.Context.ExitThread()
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
        if(!$state.Ended){$Shared.CancelRequested=$true;$workerShell.Stop()}
        $workerShell.Dispose()
    }
}

function Show-KoseiSetupChoice {
    Initialize-KoseiDesktopUi
    $form=New-Object Windows.Forms.Form
    $choice=@{Value='Cancel'}
    try {
        $form.Text='PDF校正アシスト：「送る」への登録';$form.TopMost=$true;$form.StartPosition='CenterScreen'
        $form.ClientSize=New-Object Drawing.Size(510,130);$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
        $label=New-Object Windows.Forms.Label;$label.Text='「送る」には登録済みです。サインインをやり直すときや、アプリのフォルダを移動・更新したときは「登録し直す」を押してください。';$label.SetBounds(20,14,470,48);$form.Controls.Add($label)
        $options=@(@('登録し直す','Register'),@('「送る」から削除する','Remove'),@('キャンセル','Cancel'))
        for($i=0;$i -lt $options.Count;$i++){
            $button=New-Object Windows.Forms.Button;$button.Text=$options[$i][0];$button.SetBounds((20+$i*160),80,150,30)
            $value=$options[$i][1]
            $button.Add_Click({$choice.Value=$value;$form.Close()}.GetNewClosure());$form.Controls.Add($button)
        }
        $null=$form.ShowDialog();return $choice.Value
    }finally{$form.Dispose()}
}
