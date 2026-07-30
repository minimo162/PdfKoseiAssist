function Get-KoseiDefaultSettings {
    return [ordered]@{
        copilot_attach_mode  = 'pdf'          # 'pdf' | 'text'
        copilot_url          = 'https://m365.cloud.microsoft/chat/'
        cdp_port             = 9444
        request_timeout      = 600             # Copilot回答待機（秒/パケット）
        max_prompt_chars     = 60000
        attach_wait_seconds  = 60
        attach_settle_ms     = 0        # 添付完了後の追加安定待ち（既定なし）
        copilot_model        = 'GPT 5.6 Think deeper,Opus,Think Deeper'   # モデル優先度（カンマ区切り・上から順に試行、空欄で無効）
        browser_display_mode = 'minimized'   # 'minimized' | 'foreground'
        poll_interval_ms     = 2000
        response_end_marker  = 'KOSEI_END'
        server_ports         = @(8098, 8099, 8100, 8101, 8102)
        selectors            = [ordered]@{
            file_input          = '#upload-file-button'
            file_input_fallback = 'input[type="file"][accept*="pdf"]'
            attachment_list_any = @('div[role="toolbar"][aria-label="添付ファイル"]', '[role="toolbar"][aria-label*="attach" i]', '.fai-AttachmentList')
            attachment_item_any = @('.fai-BebopAttachment', '.fai-Attachment', '[class*="Attachment"][data-overflow-item]')
            attachment_name_any = @('.fai-BebopAttachment__content > span:first-child', '.fai-Attachment__content span')
            upload_done_pattern = '完了しました|upload(ed)?\s*(complete|finished)'
            upload_fail_pattern = '失敗|エラー|failed|error'
            model_switcher      = '#gptModeSwitcher'
            chat_input_any      = @('#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]')
        }
    }
}

function Get-KoseiSettingsPath {
    $root = Get-KoseiRoot
    return (Join-Path (Join-Path $root 'config') 'settings.json')
}

function Get-KoseiSettings {
    # 既定値の上に settings.json を上書きマージして返す（PSCustomObject）。
    $defaults = Get-KoseiDefaultSettings
    $path = Get-KoseiSettingsPath
    $loaded = $null
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try {
            $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
            $loaded = $raw | ConvertFrom-Json
        } catch {
            Write-KoseiLog ("settings.json の読み込みに失敗（既定値を使用）: " + $_.Exception.Message) 'WARN'
        }
    }
    if ($loaded) {
        foreach ($p in $loaded.PSObject.Properties) {
            if ($p.Name -eq 'selectors' -and $p.Value) {
                foreach ($sp in $p.Value.PSObject.Properties) {
                    $defaults.selectors[$sp.Name] = $sp.Value
                }
            } else {
                $defaults[$p.Name] = $p.Value
            }
        }
    }
    return [pscustomobject]$defaults
}

function Get-KoseiSelector {
    param([Parameter(Mandatory=$true)]$Settings, [Parameter(Mandatory=$true)][string]$Name)
    $sel = $Settings.selectors
    if ($sel -is [System.Collections.IDictionary]) { return $sel[$Name] }
    return $sel.PSObject.Properties[$Name].Value
}
