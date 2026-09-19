# sync do repo (WSL) para a cópia executável no Windows — padrão voice-dictation
# Uso: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/sync-to-host.ps1 [-Run]
param([switch]$Run)

$ErrorActionPreference = "Stop"
$Repo  = "C:\Users\pedro\programing\projetos\voicecast"
$Dest  = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path $Repo)) { throw "repo não encontrado: $Repo" }

# espelha src+configs (sem node_modules/dist) — robocopy /MIR cuida de remoções
robocopy "$Repo\src" "$Dest\src" /MIR /NJH /NJS /NDL /NFL | Out-Null
robocopy "$Repo\scripts" "$Dest\scripts" /MIR /NJH /NJS /NDL /NFL | Out-Null
Copy-Item "$Repo\package.json" "$Dest\" -Force

if (-not (Test-Path "$Dest\node_modules")) {
    Write-Host "node_modules ausente — instalando (primeira vez)…"
    Push-Location $Dest
    npm install --no-audit --no-fund
    Pop-Location
}

if ($Run) {
    & "$Dest\scripts\run-win.ps1"
} else {
    Write-Host "sincronizado em $Dest (use -Run para executar)"
}
