param(
  [int]$AppPid = 0,
  [string]$Actions = '',
  [string]$Out = ''
)
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
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x, int y) { X = x; Y = y; } }
}
"@
Add-Type -TypeDefinition $sig | Out-Null

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

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $netTask = $asTask.Invoke($null, @($op))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

$appPids = @()
try { $appPids = @(Get-Process cxstudy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) } catch {}
if ($AppPid -gt 0) { $appPids = @(@($appPids) + @($AppPid) | Select-Object -Unique) }

# 客户端可能「最小化到托盘 / 上次关窗口」→ 启动后窗口不可见（UIA 也看不到）。先用 EnumWindows 把隐藏窗口恢复出来。
if ($appPids.Count -gt 0) {
  try {
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
    Add-Type -TypeDefinition $sig5 -ErrorAction SilentlyContinue
    $u32 = [uint32[]]($appPids | ForEach-Object { [uint32]$_ })
    foreach ($hw in [W6]::ForPids($u32)) {
      $rc2 = New-Object 'W6+RECT'
      if ([W6]::GetWindowRect($hw, [ref]$rc2)) {
        $w2 = $rc2.Right - $rc2.Left; $h2 = $rc2.Bottom - $rc2.Top
        # 只恢复「可见但最小化」的窗口；隐藏窗口是托盘残留，强行显示会是白屏
        if ($w2 -ge 400 -and $h2 -ge 300 -and [W6]::IsWindowVisible($hw) -and [W6]::IsIconic($hw)) {
          [W6]::ShowWindow($hw, 9) | Out-Null
        }
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 350
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$win = $null
$best = $null; $bestArea = 0;
$appPids = @()
try { $appPids = @(Get-Process cxstudy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) } catch {}
if ($AppPid -gt 0) { $appPids = @(@($appPids) + @($AppPid) | Select-Object -Unique) }
foreach ($w in $tops) {
  $nm = $w.Current.Name; $rc = $w.Current.BoundingRectangle;
  if (-not (ValidRect $rc)) { continue }
  $area = [double](SafeInt $rc.Width) * [double](SafeInt $rc.Height)
  if ($appPids.Count -gt 0) {
    if ($appPids -contains $w.Current.ProcessId -and $area -gt $bestArea) { $best = $w; $bestArea = $area }
  } else {
    if ($nm -eq '学习通' -and $area -gt $bestArea) { $best = $w; $bestArea = $area }
  }
}
$win = $best
if ($null -eq $win) {
  $nf = @{ pid = 0; name = ''; class = ''; x = 0; y = 0; w = 0; h = 0; err = 'window-not-found'; tops = @($tops | ForEach-Object { @{ pid = $_.Current.ProcessId; name = $_.Current.Name; class = $_.Current.ClassName } }) }
  $nfj = $nf | ConvertTo-Json -Depth 6 -Compress
  if ($Out) { [System.IO.File]::WriteAllText($Out, $nfj, (New-Object System.Text.UTF8Encoding($false))) } else { $nfj }
  exit 0
}
$wr = $win.Current.BoundingRectangle
$WX = SafeInt $wr.X; $WY = SafeInt $wr.Y; $WW = SafeInt $wr.Width; $WH = SafeInt $wr.Height
# OCR 区域是按「最大化」布局标定的；窗口不够大时自动最大化一次，保证坐标与分区一致
try {
  $hwTop = [IntPtr]$win.Current.NativeWindowHandle
  if ($WW -lt 1500 -and $hwTop -ne [IntPtr]::Zero) {
    [W6]::ShowWindow($hwTop, 3) | Out-Null
    Start-Sleep -Milliseconds 500
    $wr2 = New-Object 'W6+RECT'
    if ([W6]::GetWindowRect($hwTop, [ref]$wr2)) {
      $WX = SafeInt $wr2.Left; $WY = SafeInt $wr2.Top
      $WW = SafeInt ($wr2.Right - $wr2.Left); $WH = SafeInt ($wr2.Bottom - $wr2.Top)
    }
  }
} catch {}
if ($WW -lt 200 -or $WH -lt 200) {
  $bad = @{ pid = $win.Current.ProcessId; name = $win.Current.Name; err = 'window-rect-invalid'; x = $WX; y = $WY; w = $WW; h = $WH } | ConvertTo-Json -Depth 6 -Compress
  if ($Out) { [System.IO.File]::WriteAllText($Out, $bad, (New-Object System.Text.UTF8Encoding($false))) } else { $bad }
  exit 0
}
$hWnd = [IntPtr]$win.Current.NativeWindowHandle

function FocusWin() {
  try { [W4]::ShowWindow($hWnd, 9) | Out-Null } catch {}
  try { [W4]::SetForegroundWindow($hWnd) | Out-Null } catch {}
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
  if ($w -le 0) { $w = $WW }
  if ($h -le 0) { $h = $WH }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(($WX + $x), ($WY + $y), 0, 0, $bmp.Size)
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
    $res = Await ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
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

$acts = @()
if ($Actions) { $acts = Get-Content -Raw -Encoding UTF8 -Path $Actions | ConvertFrom-Json }
$result = @()
foreach ($a in @($acts)) {
  $r = @{ cmd = $a.cmd }
  try {
    switch ($a.cmd) {
      'foreground' { FocusWin; $r.ok = $true }
      'click' { FocusWin; ClickAt ((SafeInt ($WX + (SafeInt $a.x)))) ((SafeInt ($WY + (SafeInt $a.y)))); $r.ok = $true }
      'clicknow' { ClickAt ((SafeInt ($WX + (SafeInt $a.x)))) ((SafeInt ($WY + (SafeInt $a.y)))); $r.ok = $true }
      'move' { [W4]::SetCursorPos((SafeInt ($WX + (SafeInt $a.x))), (SafeInt ($WY + (SafeInt $a.y)))) | Out-Null; $r.ok = $true }
      'wheel' { WheelAt ((SafeInt ($WX + (SafeInt $a.x)))) ((SafeInt ($WY + (SafeInt $a.y)))) (SafeInt $a.dy); $r.ok = $true }
      'postwheel' { FocusWin; $r.ok = PostWheelAt ((SafeInt ($WX + (SafeInt $a.x)))) ((SafeInt ($WY + (SafeInt $a.y)))) (SafeInt $a.dy) }
      'key' { FocusWin; [System.Windows.Forms.SendKeys]::SendWait([string]$a.seq); $r.ok = $true }
      'paste' { FocusWin; Set-Clipboard -Value ([string]$a.text); Start-Sleep -Milliseconds 120; [System.Windows.Forms.SendKeys]::SendWait('^v'); $r.ok = $true }
      'sleep' { Start-Sleep -Milliseconds (SafeInt $a.ms); $r.ok = $true }
      'shot' { FocusWin; Start-Sleep -Milliseconds 120; ShotRegion ([string]$a.out) 0 0 0 0; $r.ok = $true; $r.out = $a.out }
      'cropshot' { FocusWin; Start-Sleep -Milliseconds 120; ShotRegion ([string]$a.out) (SafeInt $a.x) (SafeInt $a.y) (SafeInt $a.w) (SafeInt $a.h); $r.ok = $true; $r.out = $a.out }
      'hash' { FocusWin; Start-Sleep -Milliseconds 80; $r.hash = RegionHash (SafeInt $a.x) (SafeInt $a.y) (SafeInt $a.w) (SafeInt $a.h); $r.ok = $true }
      'ocr' { FocusWin; Start-Sleep -Milliseconds 100; $r.items = OcrRegion (SafeInt $a.x) (SafeInt $a.y) (SafeInt $a.w) (SafeInt $a.h) ([double]($(if ($a.scale) { $a.scale } else { 1.0 }))); $r.ok = $true }
      'rect' { $hw2 = [IntPtr]$win.Current.NativeWindowHandle; $r.ok = $true; $r.x = $WX; $r.y = $WY; $r.w = $WW; $r.h = $WH; $r.pid = $win.Current.ProcessId; $r.hwnd = $hw2.ToInt64(); $r.visible = [W6]::IsWindowVisible($hw2) }
      'uia' {
        $all = UiAll $win
        $items = @(); $n = 0
        foreach ($e in $all) {
          if ($n -ge 200) { break }
          if ($e.Current.IsOffscreen) { continue }
          $t = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
          if ($t -in @('Text', 'ListItem', 'Hyperlink', 'Button', 'Edit', 'Document')) {
            $nm = $e.Current.Name
            if ($nm -and $nm.Trim().Length -gt 0) {
              $rr = $e.Current.BoundingRectangle
              if (-not (ValidRect $rr)) { continue }
              $items += @{ t = $t; n = $nm; x = (SafeInt $rr.X); y = (SafeInt $rr.Y); w = (SafeInt $rr.Width); h = (SafeInt $rr.Height) }
              $n++
            }
          }
        }
        $r.ok = $true; $r.items = $items
      }
      'scrolluia' {
        $found = $false
        $all = UiAll $win
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
$payload = @{ ok = $true; rect = @{ x = $WX; y = $WY; w = $WW; h = $WH; pid = $win.Current.ProcessId; hwnd = ([IntPtr]$win.Current.NativeWindowHandle).ToInt64(); visible = [W6]::IsWindowVisible([IntPtr]$win.Current.NativeWindowHandle) }; results = $result }
$json = $payload | ConvertTo-Json -Depth 8 -Compress
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false))) } else { $json }
