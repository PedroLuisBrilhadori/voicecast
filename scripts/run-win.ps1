# lan-a o Electron j- compilado na c-pia do Windows
# (o build roda no WSL - pnpm dev:win - e este script s- executa dist/)
#
# Uso:
#   run-win.ps1                          # app normal (--dev abre o painel)
#   run-win.ps1 -AgentTest "goal"        # smoke do cockpit (C4): estados no
#                                        # console + exit code do goal; exige
#                                        # app fechado (lock single-instance)
param(
    [string]$AgentTest = ""
)
$ErrorActionPreference = "Stop"
$Dest = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path "$Dest\dist\main\index.js")) { throw "dist ausente - rode pnpm build no WSL antes" }

$electron = "$Dest\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "electron.exe ausente - npm install na c-pia do Windows" }

if ($AgentTest -ne "") {
    # smoke deterministico: sem --dev, sem ASR host; console.log do main chega
    # no terminal (mesmo e no %APPDATA%\voicecast\logs\main.log) e o exit code
    # do processo = desfecho do goal (0 ok / 1 falhou)
    & $electron $Dest --agenttest $AgentTest 2>&1 | ForEach-Object { "$_" }
    exit $LASTEXITCODE
}

# app dir = $Dest (package.json com main=dist/main/index.js); --dev abre o painel na hora
Start-Process -FilePath $electron -ArgumentList $Dest, '--dev' -WorkingDirectory $Dest
