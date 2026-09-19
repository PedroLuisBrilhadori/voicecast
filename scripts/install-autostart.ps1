# instala o auto-start do voicecast no login do Windows (parity voice-supervisor)
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
$ErrorActionPreference = "Stop"
$Dest = "$env:LOCALAPPDATA\voicecast\src"
$Electron = "$Dest\node_modules\electron\dist\electron.exe"

if (-not (Test-Path $Electron)) { throw "electron.exe ausente em $Dest" }

$Startup = [Environment]::GetFolderPath("Startup")
$Lnk = Join-Path $Startup "voicecast.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($Lnk)
$s.TargetPath = $Electron
$s.Arguments = '"' + $Dest + '"'
$s.WorkingDirectory = $Dest
$s.WindowStyle = 7   # minimizado
$s.Description = "voicecast - sessoes de contexto (voz + tela)"
$s.Save()

Write-Host "auto-start instalado: $Lnk"
