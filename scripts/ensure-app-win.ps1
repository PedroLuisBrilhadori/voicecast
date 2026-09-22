# Garante o voicecast do mantenedor de pé com o build atual (usado pelo agente
# após syncs que exigiram encerrar o app). Idempotente.
$Dest = "$env:LOCALAPPDATA\voicecast\src"
$r = Get-Process electron -ErrorAction SilentlyContinue
if (-not $r) {
    Start-Process -FilePath "$Dest\node_modules\electron\dist\electron.exe" -ArgumentList $Dest, '--dev' -WorkingDirectory $Dest
    Write-Host "app relancado (build com fix)"
} else {
    Write-Host "app ja rodando"
}
