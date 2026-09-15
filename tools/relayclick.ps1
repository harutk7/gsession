param([int]$L, [int]$T, [int]$W, [int]$H, [int]$Cx, [int]$Cy, [string]$Snap)
# Atomic FIDO2 relay clicker - finds Bitwarden's primary blue button ("Save
# passkey as new login" or the matching account's "Continue as ...") by
# color, on the relay window's own PrintWindow bitmap (CopyFromScreen is
# broken in a disconnected RDP session; PrintWindow still works), then
# raises the relay HWND, verifies topmost-at-click, and mouse_events the
# button. Fraction click (Cx,Cy) is the fallback when the button color
# isn't found (freshly-opened popout, animation not yet rendered).
#
# Output lines:
#   relay=0x.. rect=L,T,WxH            which window we picked
#   blue found x:..-.. y:..-.. px=.. -> click sx,sy
#   OR  no-blue (candidates=..) -> fraction click cx,cy
#   topmost-at-click=0x.. relay=0x.. match=..
#   clicked=sx,sy
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, IntPtr s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
public struct POINT { public int x; public int y; }
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void Keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint id1, uint id2, bool fAttach);
[DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, IntPtr s, int n);
[DllImport("user32.dll")] public static extern bool GetAncestorResult(IntPtr h, uint ga);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);' -Name W -Namespace U

# --- 1. find the relay window (largest Chrome window closest to L,T,W,H) ---
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(128)
$script:best = $null
$script:bestScore = 99999999
$script:bestL = 0; $script:bestT = 0; $script:bestW = 0; $script:bestH = 0
$tol = 0.20   # reject windows off by >20% on either axis
$cb = [U.W+EnumWindowsProc]{ param($wh,[IntPtr]$l)
  [void][U.W]::GetClassNameW($wh,$buf,64)
  if ([System.Runtime.InteropServices.Marshal]::PtrToStringUni($buf) -ne "Chrome_WidgetWin_1") { return $true }
  $r = New-Object U.W+RECT; [void][U.W]::GetWindowRect($wh,[ref]$r)
  $rw = $r.Right-$r.Left; $rh = $r.Bottom-$r.Top
  if ($rw -lt 300 -or $rh -lt 260) { return $true }
  $dx = [Math]::Abs($r.Left - $L)
  $dt = [Math]::Abs($r.Top - $T)
  $dw = [Math]::Abs($rw - $W)
  $dh = [Math]::Abs($rh - $H)
  # reject windows whose size is very different (not the relay)
  if ($W -gt 0 -and (($rw -gt (1+$tol)*$W) -or ($rw -lt (1-$tol)*$W))) { return $true }
  if ($H -gt 0 -and (($rh -gt (1+$tol)*$H) -or ($rh -lt (1-$tol)*$H))) { return $true }
  $score = $dx + $dt + $dw + $dh
  if ($score -lt $script:bestScore) {
    $script:bestScore = $score
    $script:best = $wh
    $script:bestL = $r.Left; $script:bestT = $r.Top
    $script:bestW = $rw;     $script:bestH = $rh
  }
  return $true
}
[U.W]::EnumWindows($cb,[IntPtr]::Zero)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)

if ($null -eq $script:best) { Write-Output "noraise rect=($L,$T) ${W}x${H}"; exit 0 }
$sw = $script:best
Write-Output ("relay=0x{0} rect={1},{2},{3}x{4}" -f $sw.ToString("X"),$script:bestL,$script:bestT,$script:bestW,$script:bestH)

# --- 2. raise it, then PrintWindow to a bitmap to find the blue button ---
[void][U.W]::ShowWindow($sw, 5)
[void][U.W]::ShowWindowAsync($sw, 9)
[void][U.W]::BringWindowToTop($sw)
[void][U.W]::SetForegroundWindow($sw)
Start-Sleep -Milliseconds 300
# A background powershell.exe (node child) is subject to SetForegroundWindow
# throttling, so a plain raise can flake in a disconnected RDP session and the
# synthetic click lands on the window behind the relay. Force it by attaching
# our thread input to BOTH the current foreground window's thread and the
# relay's thread, which grants us foreground rights, then raise again.
$fg = [U.W]::GetForegroundWindow()
$curTid = [U.W]::GetCurrentThreadId()
$fgPid = 0
$fgTid = [U.W]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$swPid = 0
$swTid = [U.W]::GetWindowThreadProcessId($sw, [ref]$swPid)
[void][U.W]::AttachThreadInput($curTid, $fgTid, $true)
[void][U.W]::AttachThreadInput($curTid, $swTid, $true)
[void][U.W]::Keybd_event(0xC0, 0, 0x0002, 0)   # SHIFT up — clears input lock, helps foreground
[void][U.W]::Keybd_event(0xC0, 0, 0, 0)         # SHIFT down
[void][U.W]::SetForegroundWindow($sw)
[void][U.W]::BringWindowToTop($sw)
Start-Sleep -Milliseconds 250
[void][U.W]::AttachThreadInput($curTid, $fgTid, $false)
[void][U.W]::AttachThreadInput($curTid, $swTid, $false)

# The relay opens MAXIMIZED (~1936x1056 @ -8,-8) and then auto-resizes to a
# small ~480x570 window once its content renders. The rect we matched against
# is therefore stale. Re-read the window's REAL rect NOW (post-render) and use
# it for all coordinate math — a fraction click against 1936px lands far off a
# 480px-wide popup.
$lr = New-Object U.W+RECT; [void][U.W]::GetWindowRect($sw, [ref]$lr)
$script:bestL = $lr.Left
$script:bestT = $lr.Top
$script:bestW = $lr.Right - $lr.Left
$script:bestH = $lr.Bottom - $lr.Top
Write-Output ("live-rect @ $script:bestL,$script:bestT ${script:bestW}x${script:bestH}")

$clickX = $Cx; $clickY = $Cy
$foundBlue = $false
# Thresholds that separate a FILLED primary-blue button from a thin border:
# a real "Save passkey as new login" button is a solid ~200x44 block (thousands
# of pixels); a search-box focus border is a 2-3px PERIMETER (a few hundred at
# most). A solid button MUST clear all three.
$MINBLUE_W = 60
$MINBLUE_H = 18
$MINBLUE_N = 1500
# Try up to 3 passes to catch the button (fresh Angular app renders a beat
# after the window appears).
for ($pass = 1; $pass -le 3 -and -not $foundBlue; $pass++) {
  try {
    $bmp = New-Object System.Drawing.Bitmap($script:bestW, $script:bestH)
    $gc = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $gc.GetHdc()
    $ok = [U.W]::PrintWindow($sw, $hdc, 2)   # PW_RENDERFULLCONTENT
    $gc.ReleaseHdc($hdc); $gc.Dispose()
    if ($ok -and $bmp.Width -gt 100 -and $bmp.Height -gt 100) {
      $rect = New-Object System.Drawing.Rectangle(0,0,$bmp.Width,$bmp.Height)
      $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $stride = $bd.Stride
      $data = New-Object byte[] ($stride * $bmp.Height)
      [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $data, 0, $data.Length)
      $bmp.UnlockBits($bd)
      # Bitwarden primary blue #175DDC: R=23, G=93, B=220. BGRA buffer order: b,g,r,a
      # Scan the middle band, ignoring the top ~20% ("+ New" is at top-right).
      $minY = [int]($bmp.Height * 0.20)
      $maxY = [int]($bmp.Height * 0.92)
      $minX = [int]($bmp.Width * 0.05)
      $maxX = [int]($bmp.Width * 0.95)
      $xmin=999999; $ymin=999999; $xmax=-1; $ymax=-1; $count=0
      for($y=$minY; $y -lt $maxY; $y++){
        $row = $y * $stride
        for($x=$minX; $x -lt $maxX; $x+=1){
          $i = $row + $x*4
          $b=$data[$i]; $g=$data[$i+1]; $r=$data[$i+2]
          if($r -lt 70 -and $g -gt 45 -and $g -lt 150 -and $b -gt 175){
            $count++
            if($x -lt $xmin){$xmin=$x}
            if($y -lt $ymin){$ymin=$y}
            if($x -gt $xmax){$xmax=$x}
            if($y -gt $ymax){$ymax=$y}
          }
        }
      }
      $clusterW = 0; if($xmax -ge $xmin){ $clusterW = $xmax - $xmin }
      $clusterH = 0; if($ymax -ge $ymin){ $clusterH = $ymax - $ymin }
      $isSolid = ($clusterW -ge $MINBLUE_W) -and ($clusterH -ge $MINBLUE_H) -and ($count -ge $MINBLUE_N)
      if ($isSolid) {
        # FILLED primary-blue button present -> click its center. This is the
        # "Save passkey as new login" case (vault has no matching login yet).
        $bx = [int](($xmin + $xmax) / 2)
        $by = [int](($ymin + $ymax) / 2)
        $clickX = $script:bestL + $bx
        $clickY = $script:bestT + $by
        $foundBlue = $true
        Write-Output ("solid-blue w=$clusterW h=$clusterH px=$count -> click $clickX,$clickY (in-win $bx,$by)")
      } else {
        # NO solid blue button. This is the "Choose a login to save this
        # passkey to" case: Bitwarden lists a matching EXISTING login (e.g.
        # accounts.google.com) as a white ROW, not a blue button. The layout is
        # fixed by the extension - title, search box (thin blue border, rejected
        # above), "Choose a login..." heading, then the first row. Click the row
        # at 50% across / 45% down the WINDOW (a fraction of this window's real
        # rect, not of a assumed 1920x1040). If the app simply hasn't rendered
        # yet, a click on the (empty) row is harmless and the retry pass re-checks.
        $rowX = [int]($script:bestW * 0.50)
        $rowY = [int]($script:bestH * 0.45)
        $clickX = $script:bestL + $rowX
        $clickY = $script:bestT + $rowY
        $foundBlue = $true
        Write-Output ("no solid blue (px=$count c${clusterW}x${clusterH}) -> login-row @ 0.50,0.45 -> $clickX,$clickY (in-win $rowX,$rowY)")
      }
    } else {
      Write-Output "printwindow-fail pass=$pass"
    }
    $bmp.Dispose()
  } catch {
    Write-Output "capture-err pass=$pass err=$($_.Exception.Message)"
  }
  if (-not $foundBlue -and $pass -lt 3) { Start-Sleep -Milliseconds 400 }
}

# --- 3. verify topmost-at-click (diagnostic; not gatekeeping) ---
if ($Snap) {
  try {
    $r2 = New-Object U.W+RECT; [void][U.W]::GetWindowRect($sw, [ref]$r2)
    $swW = $r2.Right - $r2.Left; $swH = $r2.Bottom - $r2.Top
    if ($swW -gt 50 -and $swH -gt 50) {
      $sb = New-Object System.Drawing.Bitmap($swW, $swH)
      $sg = [System.Drawing.Graphics]::FromImage($sb)
      $sh = $sg.GetHdc()
      [void][U.W]::PrintWindow($sw, $sh, 2)
      $sg.ReleaseHdc($sh); $sg.Dispose()
      $sb.Save($Snap, [System.Drawing.Imaging.ImageFormat]::Png)
      $sb.Dispose()
      "snapshot-saved=$swW x $swH"
    }
  } catch { "snapshot-err: $($_.Exception.Message)" }
}
$p = New-Object U.W+POINT; $p.x = $clickX; $p.y = $clickY
$top = [U.W]::WindowFromPoint($p)
$topX = $top.ToString("X")
$match = ($topX -eq $sw.ToString("X"))
# log the topmost window's class + title so a miss shows exactly what's in front
$tbuf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(256)
[void][U.W]::GetWindowTextW($top, $tbuf, 128)
$topTitle = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($tbuf)
$cbuf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(128)
[void][U.W]::GetClassNameW($top, $cbuf, 64)
$topCls = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($cbuf)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($tbuf)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($cbuf)
"topmost-at-click=0x$topX cls=$topCls title=$topTitle relay=0x$($sw.ToString('X')) match=$match"

# --- 4. click ---
[void][U.W]::SetCursorPos($clickX, $clickY)
Start-Sleep -Milliseconds 80
[U.W]::mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
Start-Sleep -Milliseconds 60
[U.W]::mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP
"clicked=$clickX,$clickY match=$match"
exit 0
