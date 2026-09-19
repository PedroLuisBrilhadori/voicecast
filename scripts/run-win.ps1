# lança o Electron já compilado na cópia do Windows
# (o build roda no WSL — pnpm dev:win — e este script só executa dist/)
$ErrorActionPreference = "Stop"
$Dest = "$env:LOCALAPPDATA\voicecast\src"

if (-not (Test-Path "$Dest\dist\main\index.js")) { throw "dist ausente — rode pnpm build no WSL antes" }

$electron = "$Dest\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "electron.exe ausente — npm install na cópia do Windows" }

Start-Process -FilePath $electron -ArgumentList "$Dest", "--dev"
