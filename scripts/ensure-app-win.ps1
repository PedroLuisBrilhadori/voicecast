# Keeps the maintainer's voicecast up with the current build (used by the agent
# after syncs that required killing the app). Idempotent.
$Dest = "$env:LOCALAPPDATA\voicecast\src"
$r = Get-Process electron -ErrorAction SilentlyContinue
if (-not $r) {
    Start-Process -FilePath "$Dest\node_modules\electron\dist\electron.exe" -ArgumentList $Dest, '--dev' -WorkingDirectory $Dest
    Write-Host "app relaunched (build with fix)"
} else {
    Write-Host "app already running"
}
