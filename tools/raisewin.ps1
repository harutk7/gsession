param([int]$L, [int]$T, [int]$W, [int]$H)
# Raise + focus the Chrome window whose client rect matches the FIDO2 relay
# popout (maximized, ~ L,T,W,H). In a disconnected RDP session a synthetic
# mouse_event hits whatever window is topmost at the target point, which is
# often the overlapping Google page, not the relay. Bringing the relay HWND to
# the top first guarantees the OS click lands on it.
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, IntPtr s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
public struct POINT { public int x; public int y; }
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);' -Name W -Namespace U

$tol = 40
$best = $null
$bestDist = 999999
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(128)
$cb = [U.W+EnumWindowsProc]{ param($wh,[IntPtr]$l)
  [void][U.W]::GetClassNameW($wh,$buf,64)
  if ([System.Runtime.InteropServices.Marshal]::PtrToStringUni($buf) -ne "Chrome_WidgetWin_1") { return $true }
  $r = New-Object U.W+RECT; [void][U.W]::GetWindowRect($wh,[ref]$r)
  $rw = $r.Right-$r.Left; $rh = $r.Bottom-$r.Top
  # only the maximized relay window (~1920x1040 @ -8,-8); ignore small bubbles
  if ($rw -lt 1400 -or $rh -lt 800) { return $true }
  # score by how close the rect is to the requested L,T,W,H
  $dl = [Math]::Abs($r.Left - $L); $dt = [Math]::Abs($r.Top - $T)
  $dw = [Math]::Abs($rw - $W);     $dh = [Math]::Abs($rh - $H)
  $score = $dl + $dt + $dw + $dh
  if ($score -lt 5000) {
    $script:best = $wh; $script:bestHx = $wh.ToString("X")
    $script:bestRect = "$($r.Left),$($r.Top),${rw}x${rh}"
  }
  return $true
}
[U.W]::EnumWindows($cb,[IntPtr]::Zero)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)

if ($null -eq $script:best) { Write-Output "noraise no-match"; exit 0 }
$sw = $script:best
[void][U.W]::ShowWindow($sw, 3)          # SW_SHOW
[void][U.W]::BringWindowToTop($sw)
[void][U.W]::SetWindowPos($sw, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0040)  # HWND_TOP + SWP_NOMOVE|NOSIZE|NOACTIVATE=use default; 0x1=TOP
[void][U.W]::SetForegroundWindow($sw)
Start-Sleep -Milliseconds 250
# force-focus the content so the click registers on the relay, not the page behind
Write-Output "raised 0x$($sw.ToString("X")) rect=$($script:bestRect)"
