# 共享核心：桌面客户端（Electron/UIA）动作实现与脚本级状态。
# 只放函数与类型定义，不做顶层执行；由 uia2.ps1（一次性入口，保持原有 -AppPid/-Actions/-Out 语义）
# 和 uia2srv.ps1（常驻入口，循环处理请求目录）dot-source。
# 背景：每次 -File 启动 PowerShell 固定花 1.5 秒（实测 noop 也 1.5s），桌面自动化每一步都要
# 调十几次，几乎全部时间耗在进程启动上。常驻入口只启动一次，单次请求回落到百毫秒级。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$sig = @"
using System;
using System.Runtime.InteropServices;
public class W4 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rc);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x, int y) { X = x; Y = y; } }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'W4').Type) { Add-Type -TypeDefinition $sig | Out-Null }

$sig5 = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W6 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rc);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> ForPids(uint[] pids) {
    var res = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); foreach (var p in pids) { if (p == pid) { res.Add(h); break; } } return true; }, IntPtr.Zero);
    return res;
  }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'W6').Type) { Add-Type -TypeDefinition $sig5 -ErrorAction SilentlyContinue }

# UIA 在窗口最小化/隐藏时会把 BoundingRectangle 返回成 ±8.98E+307 之类的空值，
# 直接 [int] 强转会抛「无法将值转换为 System.Int32」，所以统一走 SafeInt。
function SafeInt([object]$v) {
  try {
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 0 }
    if ($d -gt 100000) { return 100000 }
    if ($d -lt -100000) { return -100000 }
    return [int][math]::Round($d)
  } catch { return 0 }
}
function ValidRect($r) {
  if ($null -eq $r) { return $false }
  $w = SafeInt $r.Width; $h = SafeInt $r.Height
  return ($w -ge 200 -and $h -ge 200 -and $w -le 20000 -and $h -le 20000)
}
# 单个控件（文字/按钮/列表项）的矩形校验：窗口用的是 ValidRect（≥200px），
# 文本节点通常只有几十像素宽，套用窗口标准会把整棵树都过滤成空。
function ValidItemRect($r) {
  if ($null -eq $r) { return $false }
  $x = SafeInt $r.X; $y = SafeInt $r.Y
  $w = SafeInt $r.Width; $h = SafeInt $r.Height
  if ($w -lt 4 -or $h -lt 4) { return $false }
  if ($w -gt 4000 -or $h -gt 3000) { return $false }
  if ([math]::Abs($x) -ge 100000 -or [math]::Abs($y) -ge 100000) { return $false }
  return $true
}

$script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, $type) {
  $asTask = $script:asTaskGeneric.MakeGenericMethod($type)
  $netTask = $asTask.Invoke($null, @($op))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

# 脚本级状态（每个请求由 ResolveWin 刷新）
$script:win = $null
$script:WX = 0; $script:WY = 0; $script:WW = 0; $script:WH = 0
$script:hWnd = [IntPtr]::Zero
$script:tops = @()
$script:appPids = @()

# 解析目标窗口。返回 'ok' / 'window-not-found' / 'window-rect-invalid'。
# -Reuse：常驻模式下窗口没变就直接复用缓存（不重启进程、不 sleep 350ms）；
#         客户端重启/窗口被销毁时会自动走完整解析。
function ResolveWin([int]$AppPid = 0, [switch]$Reuse) {
  if ($Reuse -and $null -ne $script:win) {
    try {
      $null = Get-Process -Id $script:win.Current.ProcessId -ErrorAction Stop
      $rc0 = $script:win.Current.BoundingRectangle
      if (ValidRect $rc0) {
        $script:WX = SafeInt $rc0.X; $script:WY = SafeInt $rc0.Y
        $script:WW = SafeInt $rc0.Width; $script:WH = SafeInt $rc0.Height
        $script:hWnd = [IntPtr]$script:win.Current.NativeWindowHandle
        # 用户把窗口还原成小窗时补一次最大化，OCR 分区坐标是按最大化标定的
        if ($script:WW -lt 2400 -and $script:hWnd -ne [IntPtr]::Zero) {
          [W6]::ShowWindow($script:hWnd, 3) | Out-Null
          Start-Sleep -Milliseconds 900
          $wr = $script:win.Current.BoundingRectangle
          $script:WX = SafeInt $wr.X; $script:WY = SafeInt $wr.Y
          $script:WW = SafeInt $wr.Width; $script:WH = SafeInt $wr.Height
        }
        if ($script:WW -lt 200 -or $script:WH -lt 200) { return 'window-rect-invalid' }
        return 'ok'
      }
    } catch {}
  }

  $appPids = @()
  try { $appPids = @(Get-Process cxstudy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) } catch {}
  if ($AppPid -gt 0) { $appPids = @(@($appPids) + @($AppPid) | Select-Object -Unique) }
  $script:appPids = $appPids

  # 客户端可能「最小化到托盘 / 上次关窗口」→ 启动后窗口不可见（UIA 也看不到）。先用 EnumWindows 把隐藏窗口恢复出来。
  if ($appPids.Count -gt 0) {
    try {
      $u32 = [uint32[]]($appPids | ForEach-Object { [uint32]$_ })
      foreach ($hw in [W6]::ForPids($u32)) {
        # 最小化窗口的 GetWindowRect 返回 -32000 与图标尺寸，不能做尺寸过滤；
        # 可见 + 最小化即视为真实主窗口，恢复到最小化前的状态（最大化就仍是最大化）。
        if ([W6]::IsWindowVisible($hw) -and [W6]::IsIconic($hw)) {
          [W6]::ShowWindow($hw, 9) | Out-Null
        }
      }
    } catch {}
    Start-Sleep -Milliseconds 350
  }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $script:tops = $tops
  $win = $null
  $best = $null; $bestArea = 0;
  $appPids2 = @()
  try { $appPids2 = @(Get-Process cxstudy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) } catch {}
  if ($AppPid -gt 0) { $appPids2 = @(@($appPids2) + @($AppPid) | Select-Object -Unique) }
  foreach ($w in $tops) {
    $nm = $w.Current.Name; $rc = $w.Current.BoundingRectangle;
    if (-not (ValidRect $rc)) { continue }
    $area = [double](SafeInt $rc.Width) * [double](SafeInt $rc.Height)
    if ($appPids2.Count -gt 0) {
      if ($appPids2 -contains $w.Current.ProcessId -and $area -gt $bestArea) { $best = $w; $bestArea = $area }
    } else {
      if ($nm -eq '学习通' -and $area -gt $bestArea) { $best = $w; $bestArea = $area }
    }
  }
  $win = $best
  $script:win = $win
  if ($null -eq $win) { return 'window-not-found' }
  $wr = $win.Current.BoundingRectangle
  $script:WX = SafeInt $wr.X; $script:WY = SafeInt $wr.Y
  $script:WW = SafeInt $wr.Width; $script:WH = SafeInt $wr.Height
  # OCR 区域是按「最大化」布局标定的；窗口不够大时自动最大化一次，保证坐标与分区一致
  try {
    $hwTop = [IntPtr]$win.Current.NativeWindowHandle
    if ($script:WW -lt 2400 -and $hwTop -ne [IntPtr]::Zero) {
      [W6]::ShowWindow($hwTop, 3) | Out-Null
      # 最大化是异步的：等重绘完成再截图/OCR，否则会读到缩放中的中间态（文字乱码、坐标错位）
      Start-Sleep -Milliseconds 900
      $wr2 = New-Object 'W6+RECT'
      if ([W6]::GetWindowRect($hwTop, [ref]$wr2)) {
        $script:WX = SafeInt $wr2.Left; $script:WY = SafeInt $wr2.Top
        $script:WW = SafeInt ($wr2.Right - $wr2.Left); $script:WH = SafeInt ($wr2.Bottom - $wr2.Top)
      }
      if ($script:WW -lt 2400) {
        Start-Sleep -Milliseconds 700
        $wr3 = New-Object 'W6+RECT'
        if ([W6]::GetWindowRect($hwTop, [ref]$wr3)) {
          $script:WX = SafeInt $wr3.Left; $script:WY = SafeInt $wr3.Top
          $script:WW = SafeInt ($wr3.Right - $wr3.Left); $script:WH = SafeInt ($wr3.Bottom - $wr3.Top)
        }
      }
    }
  } catch {}
  if ($script:WW -lt 200 -or $script:WH -lt 200) { return 'window-rect-invalid' }
  $script:hWnd = [IntPtr]$win.Current.NativeWindowHandle
  return 'ok'
}

function Build-ErrPayload([string]$kind) {
  if ($kind -eq 'window-rect-invalid' -and $null -ne $script:win) {
    return @{ pid = $script:win.Current.ProcessId; name = $script:win.Current.Name; err = 'window-rect-invalid'; x = $script:WX; y = $script:WY; w = $script:WW; h = $script:WH }
  }
  $tops = @()
  try { $tops = @($script:tops | ForEach-Object { @{ pid = $_.Current.ProcessId; name = $_.Current.Name; class = $_.Current.ClassName } }) } catch {}
  return @{ pid = 0; name = ''; class = ''; x = 0; y = 0; w = 0; h = 0; err = 'window-not-found'; tops = $tops }
}

function FocusWin() {
  # 只在最小化时恢复；已最大化的窗口绝不能用 SW_RESTORE(9)，否则会被缩回普通尺寸
  try {
    if ([W4]::IsIconic($script:hWnd)) {
      [W4]::ShowWindow($script:hWnd, 9) | Out-Null
      Start-Sleep -Milliseconds 120
    }
  } catch {}
  # 光靠 SetForegroundWindow 会被 Windows 的前台锁挡掉（后台进程调用直接返回 false），
  # 结果是点击/滚轮落到别的窗口上——表现就是「点了没反应」。这里用 AttachThreadInput
  # 临时挂到前台线程上再抢一次前台。
  try {
    if ([W4]::GetForegroundWindow() -ne $script:hWnd) {
      $pidFg = [uint32]0
      $pidMe = [uint32]0
      $tidFg = [W4]::GetWindowThreadProcessId([W4]::GetForegroundWindow(), [ref]$pidFg)
      $tidMe = [W4]::GetWindowThreadProcessId([IntPtr]::Zero, [ref]$pidMe)
      if ($tidFg -ne 0 -and $tidMe -ne 0 -and $tidFg -ne $tidMe) {
        [W4]::AttachThreadInput($tidMe, $tidFg, $true) | Out-Null
        [W4]::BringWindowToTop($script:hWnd) | Out-Null
        [W4]::SetForegroundWindow($script:hWnd) | Out-Null
        [W4]::AttachThreadInput($tidMe, $tidFg, $false) | Out-Null
      } else {
        [W4]::BringWindowToTop($script:hWnd) | Out-Null
        [W4]::SetForegroundWindow($script:hWnd) | Out-Null
      }
    }
  } catch {
    try { [W4]::SetForegroundWindow($script:hWnd) | Out-Null } catch {}
  }
  Start-Sleep -Milliseconds 60
}
function ClickAt([int]$cx, [int]$cy) {
  [W4]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 25
  [W4]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [W4]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
function WheelAt([int]$cx, [int]$cy, [int]$delta) {
  [W4]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 20
  [W4]::mouse_event(0x0800, 0, 0, [uint32]([int64]$delta -band 0xFFFF), [UIntPtr]::Zero)
}
function PostWheelAt([int]$cx, [int]$cy, [int]$delta) {
  $pt = New-Object W4+Point($cx, $cy)
  $hwnd = [W4]::WindowFromPoint($pt)
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $lo = [int64]($cx -band 0xFFFF) -bor ([int64]($cy -band 0xFFFF) -shl 16)
  $wp = [int64](([int64]$delta -band 0xFFFF) -shl 16)
  [W4]::PostMessage($hwnd, 0x020A, [IntPtr]$wp, [IntPtr]$lo) | Out-Null
  return $true
}
function CaptureRegion([int]$x, [int]$y, [int]$w, [int]$h) {
  if ($w -le 0) { $w = $script:WW }
  if ($h -le 0) { $h = $script:WH }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(($script:WX + $x), ($script:WY + $y), 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}
function ShotRegion([string]$file, [int]$x, [int]$y, [int]$w, [int]$h) {
  $bmp = CaptureRegion $x $y $w $h
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
function RegionHash([int]$x, [int]$y, [int]$w, [int]$h) {
  $bmp = CaptureRegion $x $y $w $h
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bytes = $ms.ToArray()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', ''
  $bmp.Dispose(); $ms.Dispose()
  return $hash.Substring(0, 16)
}
function OcrRegion([int]$x, [int]$y, [int]$w, [int]$h, [double]$scale = 1.0) {
  $bmp = CaptureRegion $x $y $w $h
  $tmp = Join-Path $env:TEMP ('cx-ocr-' + [Guid]::NewGuid().ToString('N') + '.png')
  try {
    if ($scale -ne 1.0) {
      $nw = [int]($bmp.Width * $scale); $nh = [int]($bmp.Height * $scale)
      $b2 = New-Object System.Drawing.Bitmap($nw, $nh)
      $g2 = [System.Drawing.Graphics]::FromImage($b2)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $nw, $nh)
      $g2.Dispose(); $bmp.Dispose(); $bmp = $b2
    }
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bw = $bmp.Width; $bh = $bmp.Height
    $bmp.Dispose()
  }
  $k = 1.0 / $scale
  $items = @()
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($script:ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    foreach ($l in $res.Lines) {
      $x1 = 1e9; $y1 = 1e9; $x2 = 0; $y2 = 0
      foreach ($wd in $l.Words) {
        $r = $wd.BoundingRect
        if ($r.X -lt $x1) { $x1 = $r.X }
        if ($r.Y -lt $y1) { $y1 = $r.Y }
        if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
      }
      $t = ($l.Text -replace '\s+', '')
      $items += @{ t = $t; x = [int](($x1 + $x2) / 2 * $k + $x); y = [int](($y1 + $y2) / 2 * $k + $y); w = [int](($x2 - $x1) * $k); h = [int](($y2 - $y1) * $k) }
    }
  } finally {
    try { Remove-Item -LiteralPath $tmp -Force } catch {}
  }
  return $items
}
function UiAll($w) { $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }

function Invoke-Actions($acts) {
  $result = @()
  foreach ($a in @($acts)) {
    $r = @{ cmd = $a.cmd }
    try {
      switch ($a.cmd) {
        'foreground' { FocusWin; $r.ok = $true }
        'click' { FocusWin; ClickAt ((SafeInt ($script:WX + (SafeInt $a.x)))) ((SafeInt ($script:WY + (SafeInt $a.y)))); $r.ok = $true }
        'clicknow' { ClickAt ((SafeInt ($script:WX + (SafeInt $a.x)))) ((SafeInt ($script:WY + (SafeInt $a.y)))); $r.ok = $true }
        'move' { [W4]::SetCursorPos((SafeInt ($script:WX + (SafeInt $a.x))), (SafeInt ($script:WY + (SafeInt $a.y)))) | Out-Null; $r.ok = $true }
        'wheel' { WheelAt ((SafeInt ($script:WX + (SafeInt $a.x)))) ((SafeInt ($script:WY + (SafeInt $a.y)))) (SafeInt $a.dy); $r.ok = $true }
        'postwheel' { FocusWin; $r.ok = PostWheelAt ((SafeInt ($script:WX + (SafeInt $a.x)))) ((SafeInt ($script:WY + (SafeInt $a.y)))) (SafeInt $a.dy) }
        'key' { FocusWin; [System.Windows.Forms.SendKeys]::SendWait([string]$a.seq); $r.ok = $true }
        'paste' { FocusWin; Set-Clipboard -Value ([string]$a.text); Start-Sleep -Milliseconds 120; [System.Windows.Forms.SendKeys]::SendWait('^v'); $r.ok = $true }
        'sleep' { Start-Sleep -Milliseconds (SafeInt $a.ms); $r.ok = $true }
        'shot' { FocusWin; Start-Sleep -Milliseconds 120; ShotRegion ([string]$a.out) 0 0 0 0; $r.ok = $true; $r.out = $a.out }
        'cropshot' { FocusWin; Start-Sleep -Milliseconds 120; ShotRegion ([string]$a.out) (SafeInt $a.x) (SafeInt $a.y) (SafeInt $a.w) (SafeInt $a.h); $r.ok = $true; $r.out = $a.out }
        'hash' { FocusWin; Start-Sleep -Milliseconds 80; $r.hash = RegionHash (SafeInt $a.x) (SafeInt $a.y) (SafeInt $a.w) (SafeInt $a.h); $r.ok = $true }
        'ocr' { FocusWin; Start-Sleep -Milliseconds 100; $r.items = OcrRegion (SafeInt $a.x) (SafeInt $a.y) (SafeInt $a.w) (SafeInt $a.h) ([double]($(if ($a.scale) { $a.scale } else { 1.0 }))); $r.ok = $true }
        'rect' {
          $hw2 = [IntPtr]$script:win.Current.NativeWindowHandle
          $r.ok = $true; $r.x = $script:WX; $r.y = $script:WY; $r.w = $script:WW; $r.h = $script:WH
          $r.pid = $script:win.Current.ProcessId; $r.hwnd = $hw2.ToInt64(); $r.visible = [W6]::IsWindowVisible($hw2)
        }
        'uia' {
          $all = UiAll $script:win
          $items = @(); $n = 0
          $seen = @{}
          $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
          foreach ($e in $all) {
            if ($n -ge 600) { break }
            try { if ($e.Current.IsOffscreen) { continue } } catch { continue }
            $t = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
            if ($t -in @('Text', 'ListItem', 'Hyperlink', 'Button', 'Edit', 'Document', 'Image', 'Group', 'CheckBox', 'RadioButton', 'TabItem')) {
              $nm = $e.Current.Name
              if ($nm -and $nm.Trim().Length -gt 0) {
                $rr = $e.Current.BoundingRectangle
                if (-not (ValidItemRect $rr)) { continue }
                $ax = SafeInt $rr.X; $ay = SafeInt $rr.Y
                $aw = SafeInt $rr.Width; $ah = SafeInt $rr.Height
                # 同一段文字常被 UIA 以父子两层重复暴露，按「文本+位置」去重
                $mem = "$t|$nm|$ax|$ay|$aw|$ah"
                if ($seen.ContainsKey($mem)) { continue }
                $seen[$mem] = 1
                # 找出所属的 Document（每个标签页/网页是独立 Document）→ 前端按 doc 分组，
                # 避免把后台标签页里别的课程的文字当成当前页的内容。
                $dk = ''
                try {
                  $p = $walker.GetParent($e)
                  for ($lv = 0; $lv -lt 10 -and $p -ne $null; $lv++) {
                    $pt = $p.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
                    if ($pt -eq 'Document') { $dk = ($p.GetRuntimeId() -join '.'); break }
                    $p = $walker.GetParent($p)
                  }
                } catch {}
                $items += @{ t = $t; n = $nm; x = $ax; y = $ay; w = $aw; h = $ah; rx = ($ax - $script:WX); ry = ($ay - $script:WY); d = $dk }
                $n++
              }
            }
          }
          $r.ok = $true; $r.items = $items; $r.win = @{ x = $script:WX; y = $script:WY; w = $script:WW; h = $script:WH }
        }
        'scrolluia' {
          $found = $false
          $all = UiAll $script:win
          foreach ($e in $all) {
            if ($found) { break }
            $rr = $e.Current.BoundingRectangle
            if ($rr.IsEmpty) { continue }
            if ((SafeInt $rr.X) -le (SafeInt $a.x) -and ((SafeInt $rr.X) + (SafeInt $rr.Width)) -ge (SafeInt $a.x) -and (SafeInt $rr.Y) -le (SafeInt $a.y) -and ((SafeInt $rr.Y) + (SafeInt $rr.Height)) -ge (SafeInt $a.y)) {
              try {
                $sp = $e.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
                if ($sp.Current.VerticallyScrollable) {
                  for ($i = 0; $i -lt [int]$a.count; $i++) {
                    if ($a.direction -eq 'up') { $sp.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement) } else { $sp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement) }
                    Start-Sleep -Milliseconds 100
                  }
                  $found = $true; $r.ok = $true
                }
              } catch {}
            }
          }
          if (-not $found) { $r.ok = $false; $r.err = 'no-scrollable' }
        }
        default { $r.ok = $false; $r.err = 'unknown' }
      }
    } catch {
      $r.ok = $false; $r.err = $_.Exception.Message
    }
    $result += $r
  }
  return ,$result
}

function Build-Payload($results) {
  $hw2 = [IntPtr]$script:win.Current.NativeWindowHandle
  return @{
    ok = $true
    rect = @{ x = $script:WX; y = $script:WY; w = $script:WW; h = $script:WH; pid = $script:win.Current.ProcessId; hwnd = $hw2.ToInt64(); visible = [W6]::IsWindowVisible($hw2) }
    results = @($results)
  }
}

function Write-Payload($payload, [string]$out) {
  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  if ($out) {
    [System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    $json
  }
}
