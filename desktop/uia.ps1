param(
  [string]$Cmd = 'ping',
  [int]$AppPid = 0,
  [string]$Name = '',
  [int]$Index = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Out = '',
  [int]$Max = 400,
  [int]$Dy = 0
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
try { Add-Type -AssemblyName System.Windows.Forms | Out-Null } catch {}
$sig = @"
using System;
using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
Add-Type -TypeDefinition $sig | Out-Null

function Emit($obj) { $obj | ConvertTo-Json -Depth 8 -Compress; exit 0 }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)

function Get-AppWindow {
  foreach ($w in $tops) {
    if ($AppPid -gt 0) { if ($w.Current.ProcessId -eq $AppPid) { return $w } }
    else { if ($w.Current.Name -eq '学习通') { return $w } }
  }
  return $null
}

$win = Get-AppWindow
if ($Cmd -ne 'windows' -and $Cmd -ne 'ping' -and $null -eq $win) {
  Emit @{ ok = $false; err = 'window=null'; windows = @($tops | ForEach-Object { $r = $_.Current.BoundingRectangle; @{ pid = $_.Current.ProcessId; name = $_.Current.Name; class = $_.Current.ClassName; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }) }
}

function ElInfo($e) {
  $r = $e.Current.BoundingRectangle
  @{ t = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''); n = $e.Current.Name; i = $e.Current.AutomationId; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}

function All($w) { $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }

function ClickAt([int]$cx, [int]$cy) {
  [W2]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 50
  [W2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [W2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}

function Focus($w) {
  try { [W2]::ShowWindow([IntPtr]$w.Current.NativeWindowHandle, 9) | Out-Null } catch {}
  try { [W2]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null } catch {}
  Start-Sleep -Milliseconds 100
}

switch ($Cmd) {
  'ping' { Emit @{ ok = $true; pong = $true } }
  'windows' {
    Emit @{ ok = $true; windows = @($tops | ForEach-Object { $r = $_.Current.BoundingRectangle; @{ pid = $_.Current.ProcessId; name = $_.Current.Name; class = $_.Current.ClassName; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }) }
  }
  'text' {
    $all = All $win
    $res = @()
    $n = 0
    foreach ($e in $all) {
      if ($n -ge $Max) { break }
      $t = $e.Current.ControlType.ProgrammaticName
      if ($e.Current.IsOffscreen) { continue }
      if ($t -in @('ControlType.Text', 'ControlType.ListItem', 'ControlType.Hyperlink', 'ControlType.Button', 'ControlType.Edit')) {
        $nm = $e.Current.Name
        if ($nm -and $nm.Trim().Length -gt 0) { $res += (ElInfo $e); $n++ }
      }
    }
    Emit @{ ok = $true; count = $all.Count; items = $res }
  }
  'find' {
    $all = All $win
    $res = @()
    foreach ($e in $all) {
      $nm = $e.Current.Name
      if ($nm -and $nm.Contains($Name)) { $res += (ElInfo $e) }
    }
    Emit @{ ok = $true; items = $res }
  }
  'clickName' {
    $all = All $win
    $hits = @()
    foreach ($e in $all) { if ($e.Current.Name -eq $Name) { $hits += $e } }
    if ($hits.Count -eq 0) { foreach ($e in $all) { if ($e.Current.Name -and $e.Current.Name.Contains($Name)) { $hits += $e } } }
    if ($hits.Count -eq 0) { Emit @{ ok = $false; err = 'not-found' } }
    if ($Index -lt 0 -or $Index -ge $hits.Count) { $Index = 0 }
    $e = $hits[$Index]
    $r = $e.Current.BoundingRectangle
    $how = ''
    try { $p = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); $how = 'invoke' } catch {}
    if (-not $how) { try { $p = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); $how = 'select' } catch {} }
    if (-not $how) {
      Focus $win
      ClickAt ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2))
      $how = 'mouse'
    }
    Emit @{ ok = $true; hits = $hits.Count; how = $how; name = $e.Current.Name; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
  }
  'click' {
    Focus $win
    ClickAt $X $Y
    Emit @{ ok = $true; x = $X; y = $Y }
  }
  'foreground' { Focus $win; Emit @{ ok = $true } }
  'rect' { $r = $win.Current.BoundingRectangle; Emit @{ ok = $true; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }
  'shot' {
    $r = $win.Current.BoundingRectangle
    $bmp = New-Object System.Drawing.Bitmap([int]$r.Width, [int]$r.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Emit @{ ok = $true; out = $Out; w = [int]$r.Width; h = [int]$r.Height }
  }
  'type' {
    Focus $win
    $e = $null
    $all = All $win
    foreach ($it in $all) { if ($it.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $it.Current.Name -like "*$Name*") { $e = $it; break } }
    if ($null -eq $e) { Emit @{ ok = $false; err = 'edit-not-found' } }
    $e.SetFocus()
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait($Name)
    Emit @{ ok = $true }
  }
  'wheel' {
    Focus $win
    [W2]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 60
    [W2]::mouse_event(0x0800, 0, 0, [uint32]([int64]$Dy -band 0xFFFF), [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    Emit @{ ok = $true; x = $X; y = $Y; dy = $Dy }
  }
  'key' {
    Focus $win
    [System.Windows.Forms.SendKeys]::SendWait($Name)
    Start-Sleep -Milliseconds 120
    Emit @{ ok = $true; key = $Name }
  }
  default { Emit @{ ok = $false; err = "unknown cmd $Cmd" } }
}
