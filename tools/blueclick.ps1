# Capture the screen, find Bitwarden's primary blue button in the center band,
# click its center. The popout's Angular app renders a second or two after the
# window appears, so this POLLS up to 8 passes (500ms apart) before giving up.
# Saves the pre-click screenshot to -Out. Exits 1 with "no-blue" if no button.
#
# FAST variant: pixels are read via LockBits into a byte[] (one copy per pass)
# instead of GetPixel() per sample — a 1920x1080 band scan takes ~50ms, so the
# whole script finishes well inside the 25s execFile budget in lib/browser.js.
param([string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);' -Name U32 -Namespace W
$vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
$W = $vb.Width; $H = $vb.Height; $OX = $vb.Left; $OY = $vb.Top
# scan the center band for the Bitwarden primary blue (175DDC = 23,93,220);
# the top-right "New" button sits above y=0.25 so it is outside the band.
$minX=[int]($W*0.30); $maxX=[int]($W*0.70)
$minY=[int]($H*0.25); $maxY=[int]($H*0.92)
$cx=0; $cy=0; $count=0; $pass=0
for($pass=1; $pass -le 8; $pass++){
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($OX, $OY, 0, 0, $bmp.Size)
  $g.Dispose()
  # read the whole frame into a byte[] once (BGRA, 32bpp) — far faster than GetPixel
  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.PixelFormat]::Format32bppArgb)
  $stride = $bd.Stride
  $buf = New-Object byte[] ($stride * $H)
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
  $bmp.UnlockBits($bd)
  $xmin=999999; $ymin=999999; $xmax=-1; $ymax=-1; $count=0
  for($y=$minY; $y -lt $maxY; $y+=3){
    $row = $y * $stride
    for($x=$minX; $x -lt $maxX; $x+=3){
      $i = $row + $x*4
      $b=$buf[$i]; $gg=$buf[$i+1]; $rr=$buf[$i+2]
      if($rr -lt 70 -and $gg -gt 55 -and $gg -lt 145 -and $b -gt 175){
        $count++
        if($x -lt $xmin){$xmin=$x}; if($y -lt $ymin){$ymin=$y}
        if($x -gt $xmax){$xmax=$x}; if($y -gt $ymax){$ymax=$y}
      }
    }
  }
  if($count -ge 100){
    $cx=[int](($xmin+$xmax)/2); $cy=[int](($ymin+$ymax)/2)
    if ($Out) { $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) }
    $bmp.Dispose()
    break
  }
  $bmp.Dispose()
  if($pass -lt 8){ Start-Sleep -Milliseconds 500 }
}
if($count -lt 100){ Write-Output "no-blue (candidates=$count after $pass passes)"; exit 1 }
Write-Output "blue-region pass=$pass x:$xmin-$xmax y:$ymin-$ymax px=$count -> click $cx,$cy"
[W.U32]::SetCursorPos($cx,$cy) | Out-Null
Start-Sleep -Milliseconds 150
[W.U32]::mouse_event(0x0002,0,0,0,0)
Start-Sleep -Milliseconds 60
[W.U32]::mouse_event(0x0004,0,0,0,0)
Write-Output "clicked $cx,$cy"
