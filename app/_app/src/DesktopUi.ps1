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
    $show.Add_Click({$Shared.ShowCopilot=$true}.GetNewClosure())
    $cancel.Add_Click({
        if((Show-KoseiDesktopDialog '校正を中止しますか？' 'YesNo' 'Question') -eq 'Yes'){
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
    param([hashtable]$Shared,[scriptblock]$Worker,[object[]]$WorkerArguments=@())
    Initialize-KoseiDesktopUi
    $ui=New-KoseiTrayContext $Shared
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
                $ui.Tray.Text=ConvertTo-KoseiTrayText ([string]$Shared.Status)
                $ui.StatusItem.Text='状況：'+[string]$Shared.Status
                if($Shared.Notification -and $Shared.Notification -ne $state.Notification){
                    $state.Notification=[string]$Shared.Notification
                    $ui.Tray.ShowBalloonTip(5000,'PDF校正アシスト',$state.Notification,[Windows.Forms.ToolTipIcon]::Info)
                }
                if($Shared.Prompt){
                    $prompt=[string]$Shared.Prompt;$Shared.Prompt=''
                    $Shared.Answer=Show-KoseiDesktopDialog $prompt 'YesNoCancel' 'Question'
                }
                if($async.IsCompleted){
                    $state.Ended=$true
                    try{$null=$workerShell.EndInvoke($async)}catch{$Shared.Error=$_.Exception.Message;$Shared.ExitCode=1}
                    if($workerShell.HadErrors -and !$Shared.Error){$Shared.Error=[string]$workerShell.Streams.Error[0];$Shared.ExitCode=1}
                    if($Shared.Error){$null=Show-KoseiDesktopDialog ([string]$Shared.Error) 'OK' 'Error'}
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
        if(!$state.Ended){$Shared.CancelRequested=$true;$workerShell.Stop()}
        $workerShell.Dispose()
    }
}
