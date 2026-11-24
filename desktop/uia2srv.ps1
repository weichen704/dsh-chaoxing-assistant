# 常驻入口：启动一次（Add-Type / OCR 引擎 / 窗口解析只做一次），循环处理 ServerDir 里的请求。
# 请求：<ServerDir>/req-<id>.json = {"actions":[...]}（UTF-8 带 BOM 也可）
# 响应：<ServerDir>/res-<id>.json = 与一次性入口相同的 payload（UTF-8 无 BOM）
# 就绪：<ServerDir>/ready.txt 写入进程 PID；退出时删除。
# 空闲 IdleMinutes 分钟没有任何请求就退出，避免 Node 侧异常退出后留下孤儿进程。
param(
  [int]$AppPid = 0,
  [string]$ServerDir = '',
  [int]$IdleMinutes = 30,
  [string]$CorePs1 = ''
)
$ErrorActionPreference = 'Stop'
if (-not $ServerDir) { Write-Output '{"ok":false,"err":"ServerDir 必填"}'; exit 2 }
$core = if ($CorePs1) { $CorePs1 } else { Join-Path $PSScriptRoot 'uia2core.ps1' }
. $core

$dir = [IO.Path]::GetFullPath($ServerDir)
if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$ready = Join-Path $dir 'ready.txt'
[IO.File]::WriteAllText($ready, [string]$PID, $utf8)
$idleUntil = (Get-Date).AddMinutes($IdleMinutes)
try {
  while ($true) {
    $files = [IO.Directory]::GetFiles($dir, 'req-*.json')
    if ($files.Length -eq 0) {
      if ((Get-Date) -gt $idleUntil) { break }
      Start-Sleep -Milliseconds 15
      continue
    }
    $idleUntil = (Get-Date).AddMinutes($IdleMinutes)
    # 文件名以时间戳开头，按序处理最早的请求
    [Array]::Sort($files, [System.StringComparer]::Ordinal)
    $file = $files[0]
    $id2 = [IO.Path]::GetFileNameWithoutExtension($file).Substring(4)
    $resPath = Join-Path $dir ("res-$id2.json")
    $payload = $null
    try {
      $msg = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json
      try { [IO.File]::Delete($file) } catch {}
      $st = ResolveWin -AppPid $AppPid -Reuse
      if ($st -ne 'ok') {
        $payload = Build-ErrPayload $st
      } else {
        $payload = Build-Payload (Invoke-Actions @($msg.actions))
      }
    } catch {
      try { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } } catch {}
      $payload = @{ ok = $false; err = ('server: ' + $_.Exception.Message) }
    }
    try {
      [IO.File]::WriteAllText($resPath, ($payload | ConvertTo-Json -Depth 8 -Compress), $utf8)
    } catch {
      # 响应写不出去（Node 已经放弃这个请求）就丢弃，服务器继续处理下一个
    }
  }
} finally {
  try { [IO.File]::Delete($ready) } catch {}
}
