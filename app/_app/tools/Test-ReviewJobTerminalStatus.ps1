# Test-ReviewJobTerminalStatus.ps1
# Regression for the visibility-wait finalizer: an empty error is valid
# metadata for a paused packet and must not trigger PS5.1 parameter binding.

$ErrorActionPreference = 'Stop'
$reviewPath = Join-Path $PSScriptRoot '..\src\ReviewJob.ps1'
. ([IO.Path]::GetFullPath($reviewPath))

$packet = [hashtable]::Synchronized(@{
    status = 'needs_user_visibility'
    error = ''
    packet_id = 'terminal-empty-error'
})
$state = [hashtable]::Synchronized(@{
    per_packet = @($packet)
    packets_done = 0
})
$ok = Set-KoseiPacketTerminalStatus -State $state -Index 0 -Status 'paused' -Error ''
if (-not $ok) { throw 'Set-KoseiPacketTerminalStatus がpausedを確定できませんでした。' }
if ([string]$state.per_packet[0].status -ne 'paused') { throw 'paused statusが保存されていません。' }
if ([string]$state.per_packet[0].error -ne '') { throw '空のerrorメタデータが保持されていません。' }
if ([int]$state.packets_done -ne 0) { throw 'paused packetを完了件数へ加算しています。' }

Write-Host 'Test-ReviewJobTerminalStatus: PASS'
