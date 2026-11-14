# launches the already-built Electron in the Windows copy
# (the build runs on WSL - pnpm dev:win - and this script only runs dist/)
#
# Usage:
#   run-win.ps1                          # normal app (--dev opens the panel)
#   run-win.ps1 -AgentTest "goal"        # cockpit smoke test (C4): states in
#                                        # the console + goal exit code; requires
#                                        # the app closed (single-instance lock)
param(
    [string]$AgentTest = ""
)
$ErrorActionPreference = "Stop"
$Dest = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path "$Dest\dist\main\index.js")) { throw "dist missing - run pnpm build on WSL first" }

$electron = "$Dest\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "electron.exe missing - npm install in the Windows copy" }

if ($AgentTest -ne "") {
    # deterministic smoke test: no --dev, no ASR host; main's console.log reaches
    # the terminal (and %APPDATA%\voicecast\logs\main.log) and the process exit
    # code = goal outcome (0 ok / 1 failed)
    & $electron $Dest --agenttest $AgentTest 2>&1 | ForEach-Object { "$_" }
    exit $LASTEXITCODE
}

# app dir = $Dest (package.json with main=dist/main/index.js); --dev opens the panel right away
Start-Process -FilePath $electron -ArgumentList $Dest, '--dev' -WorkingDirectory $Dest
