# lan-a o Electron j- compilado na c-pia do Windows
# (o build roda no WSL - pnpm dev:win - e este script s- executa dist/)
$ErrorActionPreference = "Stop"
$Dest = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path "$Dest\dist\main\index.js")) { throw "dist ausente - rode pnpm build no WSL antes" }

$electron = "$Dest\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "electron.exe ausente - npm install na c-pia do Windows" }

# app dir = $Dest (package.json com main=dist/main/index.js); --dev abre o painel na hora
Start-Process -FilePath $electron -ArgumentList $Dest, '--dev' -WorkingDirectory $Dest
