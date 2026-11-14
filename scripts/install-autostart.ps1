# installs voicecast auto-start at Windows login (voice-supervisor parity)
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
$ErrorActionPreference = "Stop"
$Dest = "$env:LOCALAPPDATA\voicecast\src"
$Electron = "$Dest\node_modules\electron\dist\electron.exe"

if (-not (Test-Path $Electron)) { throw "electron.exe missing in $Dest" }

$Startup = [Environment]::GetFolderPath("Startup")
$Lnk = Join-Path $Startup "voicecast.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($Lnk)
$s.TargetPath = $Electron
$s.Arguments = '"' + $Dest + '"'
$s.WorkingDirectory = $Dest
$s.WindowStyle = 7   # minimized
$s.Description = "voicecast - context sessions (voice + screen)"
$s.Save()

Write-Host "auto-start installed: $Lnk"
