# Installs the voicecast ASR backend on the Windows host: syncs the vendored
# code (repo asr-backend/) and creates its own venv (uv). Idempotent.
# Usage (from WSL): powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-asr-backend.ps1
#        -Check : reports state only, does not install.
# NOTE: keep this file 100% ASCII (PowerShell 5.1 reads .ps1 without BOM as ANSI).
param([switch]$Check)

$ErrorActionPreference = "Stop"
$Repo = '\\wsl.localhost\Ubuntu\home\pedro\programing\projetos\voicecast'
$Dest = "$env:LOCALAPPDATA\voicecast\asr-backend"

function Get-State {
    [pscustomobject]@{
        src     = Test-Path "$Dest\src\voice\asr_service.py"
        venv    = Test-Path "$Dest\.venv\Scripts\python.exe"
        python  = if (Test-Path "$Dest\.venv\Scripts\python.exe") {
            & "$Dest\.venv\Scripts\python.exe" --version 2>&1
        } else { $null }
        cudaDll = Test-Path "$Dest\.venv\Lib\site-packages\sitecustomize.py"
    }
}

if ($Check) { Get-State | Format-List; exit 0 }

if (-not (Test-Path "$Repo\asr-backend\voice\asr_service.py")) { throw "repo not found: $Repo" }

# 1. vendored code -> $Dest\src
robocopy "$Repo\asr-backend" "$Dest\src" /MIR /NJH /NJS /NDL /NFL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

# 2. venv (python 3.12, uv)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv missing - winget install --id astral-sh.uv -e (runbook setup-voz-local-windows.md)"
}
if (-not (Test-Path "$Dest\.venv\Scripts\python.exe")) {
    Write-Host "creating venv ($Dest\.venv)..."
    uv venv "$Dest\.venv" --python 3.12
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed" }
}
$py = "$Dest\.venv\Scripts\python.exe"

# 3. deps with hash marker (only reinstalls when the list changes)
$deps = "faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 fastapi uvicorn python-multipart pydantic numpy"
$marker = Join-Path $Dest '.deps-hash'
$depsHash = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($deps))).Replace('-', '')
if (-not (Test-Path $marker) -or (Get-Content $marker -Raw).Trim() -ne $depsHash) {
    Write-Host "installing deps: $deps"
    uv pip install --python $py $deps.Split(' ')
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed" }
    Set-Content -Path $marker -Value $depsHash
}

# 4. CUDA DLLs on PATH (sitecustomize - same fix as the voice-dictation runbook)
$sp = "$Dest\.venv\Lib\site-packages\sitecustomize.py"
@'
import os
import site
for base in site.getsitepackages():
    nvidia = os.path.join(base, 'nvidia')
    for name in ('cublas', 'cudnn'):
        libdir = os.path.join(nvidia, name, 'bin')
        if os.path.isdir(libdir):
            os.environ['PATH'] = libdir + os.pathsep + os.environ.get('PATH', '')
'@ | Set-Content -Path $sp -Encoding UTF8

Write-Host ""
Write-Host "ASR backend installed at $Dest"
Get-State | Format-List
Write-Host "whisper models: user HF cache (~\.cache\huggingface) - no re-download"
