# sync from the repo (WSL) to the executable copy on Windows - voice-dictation pattern
# Uso (do WSL): powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-host.ps1 [-Run]
param([switch]$Run)

$ErrorActionPreference = "Stop"
$Repo = '\\wsl.localhost\Ubuntu\home\pedro\programing\projetos\voicecast'
$Dest = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path $Repo)) { throw "repo not found: $Repo" }

# mirrors src+scripts+dist+configs (no node_modules) - /MIR handles removals
robocopy "$Repo\src" "$Dest\src" /MIR /NJH /NJS /NDL /NFL | Out-Null
robocopy "$Repo\scripts" "$Dest\scripts" /MIR /NJH /NJS /NDL /NFL | Out-Null
robocopy "$Repo\dist" "$Dest\dist" /MIR /NJH /NJS /NDL /NFL | Out-Null
Copy-Item "$Repo\package.json" "$Dest\" -Force

# deps changed? reinstall — package.json hash in a local marker (the /MIR
# of subdirs doesn't reach the root; the marker survives syncs)
$depsMarker = Join-Path $Dest '.deps-hash'
$pkgHash = (Get-FileHash "$Repo\package.json" -Algorithm SHA256).Hash
$installedHash = if (Test-Path $depsMarker) { (Get-Content $depsMarker -Raw).Trim() } else { '' }
if (-not (Test-Path "$Dest\node_modules") -or $pkgHash -ne $installedHash) {
    Write-Host "node_modules missing or deps changed - installing"
    Push-Location $Dest
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -eq 0) { Set-Content -Path $depsMarker -Value $pkgHash }
    Pop-Location
}

if ($Run) {
    & "$Dest\scripts\run-win.ps1"
} else {
    Write-Host "synced to $Dest (use -Run to run)"
}
