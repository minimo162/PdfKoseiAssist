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
        # --- 校正エンジン feature flag（既定は v94 相当。multipass は将来フェーズで有効化） ---
        review_engine        = 'legacy'    # 'legacy' | 'multipass'
        review_prompt_version = 'v94'      # プロンプト版の独立比較用
        review_profile_batch = 'quick'     # 一括実行時の既定プロファイル
        review_profile_single = 'standard' # 個別実行時の既定プロファイル
        review_profile_consistency = 'consistency' # 整合性セクションの既定プロファイル（§7.2 の分担）
        review_gap_pass      = $true
        review_page_checks   = $true
        review_cross_document_context = $false
        coverage_threshold   = 0.95        # 新形式 page_checks 用
        coverage_threshold_legacy = 0.70   # 旧形式回答のフォールバック用
        review_max_passes    = 8
        response_stall_seconds = 180       # 本文が伸びないまま生成中を名乗り続ける状態の打ち切り
        response_stable_accept_seconds = 45 # 完成JSONが変化しない状態が続いたら生成中でも受理
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

# settings.json の読み込みに失敗した理由（成功していれば空）。UI へ出して黙って劣化させない。
$script:KoseiSettingsError = ''
function Get-KoseiSettingsError { return [string]$script:KoseiSettingsError }

function Get-KoseiSettings {
    # 既定値の上に settings.json を上書きマージして返す（PSCustomObject）。
    $defaults = Get-KoseiDefaultSettings
    $path = Get-KoseiSettingsPath
    $loaded = $null
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try {
            $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
            $loaded = $raw | ConvertFrom-Json
            $script:KoseiSettingsError = ''
        } catch {
            # ここで既定値へ黙って戻ると、review_engine=legacy などで実行され続け、
            # 画面上は正常に見えるまま機能の一部が落ちる（実測でベンチマーク3回分を無駄にした）。
            # UI から見えるように理由を保持する。
            $script:KoseiSettingsError = ('settings.json を読み込めないため既定値で動作しています。JSONの書式を確認してください: ' + $_.Exception.Message)
            Write-KoseiLog $script:KoseiSettingsError 'WARN'
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

function Get-KoseiValidatedReviewFlags {
    # 校正エンジン系 flag を allowlist で検証し、未知値は警告して安全な既定値へ戻す（計画書 §4.2）。
    # 戻り値は検証済みの [pscustomobject]。既定 legacy/v94/quick/standard は v94 相当の挙動。
    param([Parameter(Mandatory=$true)]$Settings)
    $allow = @{
        review_engine         = @('legacy', 'multipass')
        review_prompt_version = @('v94', 'v95-reduced')
        review_profile_batch  = @('quick', 'standard', 'thorough', 'consistency')
        review_profile_single = @('quick', 'standard', 'thorough', 'consistency')
        review_profile_consistency = @('quick', 'standard', 'thorough', 'consistency')
    }
    $defaults = Get-KoseiDefaultSettings
    $resolve = {
        param($name)
        $val = [string]$Settings.$name
        if ($allow[$name] -contains $val) { return $val }
        $fallback = [string]$defaults[$name]
        if (Get-Command Write-KoseiLog -ErrorAction SilentlyContinue) {
            Write-KoseiLog ("設定 {0}='{1}' は未知値のため既定 '{2}' を使用します。" -f $name, $val, $fallback) 'WARN'
        }
        return $fallback
    }
    $asBool = {
        param($name)
        $v = $Settings.$name
        if ($v -is [bool]) { return $v }
        return [bool]([string]$v -match '^(?i:true|1|yes)$')
    }
    return [pscustomobject]@{
        review_engine                 = & $resolve 'review_engine'
        review_prompt_version         = & $resolve 'review_prompt_version'
        review_profile_batch          = & $resolve 'review_profile_batch'
        review_profile_single         = & $resolve 'review_profile_single'
        review_profile_consistency    = & $resolve 'review_profile_consistency'
        review_gap_pass               = & $asBool 'review_gap_pass'
        review_page_checks            = & $asBool 'review_page_checks'
        review_cross_document_context = & $asBool 'review_cross_document_context'
    }
}
