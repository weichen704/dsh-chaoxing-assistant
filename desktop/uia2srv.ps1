# 常驻入口：启动一次（Add-Type / OCR 引擎 / 窗口解析只做一次），循环处理 ServerDir 里的请求。
# 请求：<ServerDir>/req-<id>.json = {"actions":[...]}（UTF-8 带 BOM 也可）
# 响应：<ServerDir>/res-<id>.json = 与一次性入口相同的 payload（UTF-8 无 BOM）
# 就绪：<ServerDir>/ready.txt 写入进程 PID；退出时删除。
# 空闲 IdleMinutes 分钟没有任何请求就退出，避免 Node 侧异常退出后留下孤儿进程。
param(
  [int]$AppPid = 0,
  [string]$ServerDir = '',
  [int]$IdleMinutes = 30,
  [string]$CorePs1 = '',
  [string]$Token = '',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
if (-not $ServerDir) { Write-Output '{"ok":false,"err":"ServerDir 必填"}'; exit 2 }
# 会话 token：由 Node 每次启动时随机生成，经命令行传入，只存在于本进程里（不落盘）。
# 请求文件名和 JSON 内容都必须带上它，否则丢弃——避免共享/可写目录里的其它进程投放
# req 文件让常驻 PowerShell 执行动作，或抢先写 res 文件伪造「执行成功」。
if (-not $Token) { Write-Output '{"ok":false,"err":"Token 必填"}'; exit 2 }
$core = if ($CorePs1) { $CorePs1 } else { Join-Path $PSScriptRoot 'uia2core.ps1' }
. $core

$dir = [IO.Path]::GetFullPath($ServerDir)
if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
# 截图只能落到这个目录（文件名由 core 里的 ResolveShotPath 强制成纯文件名）
$script:OutDir = [IO.Path]::GetFullPath($(if ($OutDir) { $OutDir } else { $dir }))
if (-not [IO.Directory]::Exists($script:OutDir)) { [void][IO.Directory]::CreateDirectory($script:OutDir) }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$ready = Join-Path $dir 'ready.txt'
[IO.File]::WriteAllText($ready, [string]$PID, $utf8)
$idleUntil = (Get-Date).AddMinutes($IdleMinutes)
$rx = '^req-(.+?)\.([0-9a-f]{32})\.json$'
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
    $m = [regex]::Match([IO.Path]::GetFileName($file), $rx)
    if (-not $m.Success -or $m.Groups[2].Value -ne $Token) {
      # 不是本次会话发的（或名字被伪造）：直接丢弃
      try { [IO.File]::Delete($file) } catch {}
      continue
    }
    $id2 = $m.Groups[1].Value
    $resPath = Join-Path $dir ("res-$id2.$Token.json")
    $payload = $null
    try {
      $fi = New-Object IO.FileInfo($file)
      if ($fi.Length -gt 4194304) { throw 'req-too-large' }
      $msg = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json
      if ([string]$msg.token -ne $Token) { throw 'bad-token' }
      if ($null -eq $msg.actions -or @($msg.actions).Length -gt 200) { throw 'bad-actions' }
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
      try { $payload.t = $Token } catch {}
      [IO.File]::WriteAllText($resPath, ($payload | ConvertTo-Json -Depth 8 -Compress), $utf8)
    } catch {
      # 响应写不出去（Node 已经放弃这个请求）就丢弃，服务器继续处理下一个
    }
  }
} finally {
  try { [IO.File]::Delete($ready) } catch {}
}
