# sync do repo (WSL) para a c-pia execut-vel no Windows - padr-o voice-dictation
# Uso (do WSL): powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-host.ps1 [-Run]
param([switch]$Run)

$ErrorActionPreference = "Stop"
$Repo = '\\wsl.localhost\Ubuntu\home\pedro\programing\projetos\voicecast'
$Dest = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path $Repo)) { throw "repo n-o encontrado: $Repo" }

# espelha src+scripts+dist+configs (sem node_modules) - /MIR cuida de remo--es
robocopy "$Repo\src" "$Dest\src" /MIR /NJH /NJS /NDL /NFL | Out-Null
robocopy "$Repo\scripts" "$Dest\scripts" /MIR /NJH /NJS /NDL /NFL | Out-Null
robocopy "$Repo\dist" "$Dest\dist" /MIR /NJH /NJS /NDL /NFL | Out-Null
Copy-Item "$Repo\package.json" "$Dest\" -Force

# deps mudaram? reinstala — hash do package.json num marcador local (o /MIR
# dos subdirs não alcança a raiz, o marcador sobrevive aos syncs)
$depsMarker = Join-Path $Dest '.deps-hash'
$pkgHash = (Get-FileHash "$Repo\package.json" -Algorithm SHA256).Hash
$installedHash = if (Test-Path $depsMarker) { (Get-Content $depsMarker -Raw).Trim() } else { '' }
if (-not (Test-Path "$Dest\node_modules") -or $pkgHash -ne $installedHash) {
    Write-Host "node_modules ausente ou deps mudaram - instalando-"
    Push-Location $Dest
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -eq 0) { Set-Content -Path $depsMarker -Value $pkgHash }
    Pop-Location
}

if ($Run) {
    & "$Dest\scripts\run-win.ps1"
} else {
    Write-Host "sincronizado em $Dest (use -Run para executar)"
}
