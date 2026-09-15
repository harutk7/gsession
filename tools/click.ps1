param([int]$X, [int]$Y)
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);' -Name U32 -Namespace W
[W.U32]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 120
[W.U32]::mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
Start-Sleep -Milliseconds 60
[W.U32]::mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
Write-Output "clicked $X,$Y"
