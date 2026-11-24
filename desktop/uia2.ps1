# 一次性入口（保持原有 -AppPid/-Actions/-Out 语义，供 deskv2.mjs 回退与人工排错）。
# 真正的实现见 uia2core.ps1；常驻入口见 uia2srv.ps1（每批动作省掉 ~1.5 秒 PowerShell 启动）。
param(
  [int]$AppPid = 0,
  [string]$Actions = '',
  [string]$Out = '',
  [string]$CorePs1 = ''
)
$ErrorActionPreference = 'Stop'
$core = if ($CorePs1) { $CorePs1 } else { Join-Path $PSScriptRoot 'uia2core.ps1' }
. $core

$st = ResolveWin $AppPid
if ($st -ne 'ok') {
  Write-Payload (Build-ErrPayload $st) $Out
  exit 0
}

$acts = @()
if ($Actions) { $acts = Get-Content -Raw -Encoding UTF8 -Path $Actions | ConvertFrom-Json }
$results = Invoke-Actions $acts
Write-Payload (Build-Payload $results) $Out
